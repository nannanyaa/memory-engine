/**
 * daily.ts — 定时落盘兜底（模块：enable_daily_digest）
 *
 * 南南核心落盘兜底（方案稿 A-落盘强制）：
 *   每日 cron -> 若当日 memory/YYYY-MM-DD.md 无落盘，生成一次"强制归档检查"
 *   + 索引完整性校验（扫描 memory/ 与 .index.jsonl 比对缺档）。
 *
 * 只生成候选清单/日志，不替代人工写作；写 index 保留人工所有权（登记候选）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync } from "../log.js";
import type { RuntimeContext } from "../runtime.js";
import { toISODate } from "../time.js";
import { appendToFile, appendIndexEntry, indexPath } from "../writers.js";
import { chatGeneric } from "../llm.js";

export interface DigestResult {
  todayNoteExists: boolean;
  missingIndexCount: number;
  candidates: string[];
}

/** 每日兜底：返回当日落盘检查结果。 */
export async function dailyDigest(rt: RuntimeContext): Promise<DigestResult> {
  if (!rt.cfg.enable_daily_digest) {
    return { todayNoteExists: false, missingIndexCount: -1, candidates: [] };
  }
  const ws = rt.cfg.workspaceDir;
  const today = toISODate(Date.now());
  const notePath = join(ws, "memory", `${today}.md`);
  const todayNoteExists = existsSync(notePath) && readFileSync(notePath, "utf8").trim().length > 0;

  // 索引完整性：扫描 memory/*.md 与 memory/.index.jsonl
  const { missing, candidates } = scanIndex(rt, ws);

  if (!todayNoteExists) {
    rt.log.info(`[daily] ${today} note missing; queued archive check`);
  }

  rt.log.info(
    `[daily] digest done: todayNote=${todayNoteExists} missingIndex=${missing.length} candidates=${candidates.length}`,
  );
  return { todayNoteExists, missingIndexCount: missing.length, candidates };
}

function scanIndex(rt: RuntimeContext, ws: string): { missing: string[]; candidates: string[] } {
  const memoryDir = join(ws, "memory");
  const indexJsonl = join(ws, "memory", ".index.jsonl");
  if (!existsSync(memoryDir)) return { missing: [], candidates: [] };

  let indexedFiles = new Set<string>();
  if (existsSync(indexJsonl)) {
    try {
      for (const line of readFileSync(indexJsonl, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as { file?: string };
          if (obj.file) indexedFiles.add(obj.file);
        } catch {
          /* skip malformed */
        }
      }
    } catch {
      /* ignore */
    }
  }

  const missing: string[] = [];
  const candidates: string[] = [];
  try {
    const notes = readdirSync(memoryDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    for (const f of notes.slice(-30)) {
      const full = join(ws, "memory", f).replace(ws + "/", "");
      if (!indexedFiles.has(full) && !indexedFiles.has(`memory/${f}`)) {
        missing.push(f);
        // 内容非空 -> 候选
        const content = readFileSync(join(memoryDir, f), "utf8").trim();
        if (content.length > 0) candidates.push(f);
      }
    }
  } catch {
    /* ignore */
  }
  void rt;
  return { missing, candidates };
}

// ---------------------------------------------------------------------------
// 真自动落盘（南南 2026-08-10 拍板：全自动生成摘要草稿 + 自动登记 index）
// ---------------------------------------------------------------------------

/**
 * 确保当日 memory/YYYY-MM-DD.md 落盘；无则全自动生成摘要草稿并登记索引。
 * 草稿带 `<!-- draft -->` 标记可手动改；确认后去标记即转正（人保留最终决定权）。
 */
export async function ensureDailyPersist(rt: RuntimeContext): Promise<{
  status: string;
  file?: string;
  note?: string;
}> {
  if (!rt.cfg.enable_daily_digest) {
    return { status: "disabled", note: "enable_daily_digest off" };
  }
  const ws = rt.cfg.workspaceDir;
  const date = toISODate(Date.now());
  const file = `memory/${date}.md`;
  const notePath = join(ws, "memory", `${date}.md`);
  if (existsSync(notePath) && readFileSync(notePath, "utf8").trim().length > 0) {
    return { status: "ok", file, note: "already" };
  }

  // 全自动生成摘要草稿（LLM 摘要，失败降级为占位文本）
  const draft = await buildDailyDraft(rt, date);
  const res = appendToFile(
    notePath,
    `<!-- draft -->\n# ${date} 每日记忆摘要（引擎自动生成草稿，可手动修改）\n\n${draft}`,
    "daily",
    "自动落盘草稿",
    `auto draft for ${date}`,
    rt.cfg,
    rt.log,
  );
  if (!res.ok) return { status: "write_failed", file, note: res.error };

  // 自动登记 index（南南：走全自动）
  await registerDailyIndex(rt, file, draft);
  rt.log.info(`[daily] auto-generated draft -> ${file}`);
  return { status: "auto_generated_draft", file };
}

/** 聚合当日事件/对话要点为摘要草稿（LLM；失败/无 provider 降级为占位说明）。 */
async function buildDailyDraft(rt: RuntimeContext, date: string): Promise<string> {
  // 当日事件归档（compaction archiveDir 下当日文件，若有）
  const eventsDir = rt.cfg.compaction.archiveDir;
  let eventText = "";
  try {
    if (existsSync(eventsDir)) {
      const evFile = join(eventsDir, `${date}.md`);
      if (existsSync(evFile)) eventText = readFileSync(evFile, "utf8").slice(0, 3000);
    }
  } catch {
    /* ignore */
  }
  // 当日 dim 情感节点（若有）
  let dimText = "";
  try {
    const dimFile = join(rt.cfg.workspaceDir, "memory", "dim", "01-emotional.md");
    if (existsSync(dimFile)) dimText = readFileSync(dimFile, "utf8").slice(-2000);
  } catch {
    /* ignore */
  }

  if (rt.cfg.emotion.llmBaseUrl) {
    const summary = await chatGeneric(
      {
        llmBaseUrl: rt.cfg.emotion.llmBaseUrl,
        llmModel: rt.cfg.emotion.llmModel,
        llmApiKey: rt.cfg.emotion.llmApiKey,
        timeoutMs: 20_000,
        log: rt.log,
      },
      `把以下一日事件/情感记忆聚合为简明每日摘要（3-8 条要点，保留事实/决定/承诺/情绪温度；勿空话）。\n\n事件: ${eventText || "（无）"}\n情感: ${dimText || "（无）"}`,
      { model: "deepseek-v4-flash", maxTokens: 600, temperature: 0.2 },
    );
    if (summary.trim()) return `- ${summary.replace(/^[-*]\s*/gm, "").split("\n").filter(Boolean).join("\n- ")}`;
  }

  return "- （当日无事件/情感记录，引擎未生成要点；可由人工补充）";
}

/** 自动登记 daily 到 .index.jsonl。 */
async function registerDailyIndex(rt: RuntimeContext, file: string, summary: string): Promise<void> {
  appendIndexEntry(
    indexPath(rt.cfg.workspaceDir),
    {
      ts: new Date().toISOString(),
      module: "daily",
      kind: "daily_draft",
      target: file,
      summary: summary.slice(0, 120),
    },
    rt.cfg,
    rt.log,
  );
}
