/**
 * selfevolve.ts — 自进化引擎（模块：enable_self_evolve）
 *
 * 南南拍板 #1：半自动自进化 —— 自主进化 + 日志汇报改动点 + 可手动回退，不走前置审批。
 *
 * 引擎职责（红线：只产出提案/日志/回退，绝不自动改 AGENTS/SOUL/MEMORY 机制文件）：
 *   1. 每日深夜 cron -> 复盘近期记忆体系健康度
 *   2. 读取 memory/ 近 7 日笔记 + dim + changes.jsonl + engine-db 投入度
 *   3. 产出"机制改进提案"到 <proposalDir>/YYYY-MM-DD-<id>.md
 *      （仅提案文件，不自动应用）
 *   4. 日志汇报改动点 + 记录基线到 engine-db，防重复提案
 *   5. mem_rollback 工具可一键手动回退任何写盘改动（用回滚备份）
 * 最高权限 = 改自己引擎参数 + 自管 db；改 AGENTS/MEMORY/SOUL 机制规则 = 仅出提案。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readdirSync, readChanges } from "../log.js";
import type { RuntimeContext } from "../runtime.js";
import { toISODate } from "../time.js";
import { chatGeneric } from "../llm.js";
import { applyPendingPromotions } from "./memory.js";

export const PROPOSALS_DIR = "memory-engine-proposals";

/** 夜间复盘：产提案（不自动应用）。+ 先筛选晋升 memory 的 pending 提案。 */
export async function nightlyReview(rt: RuntimeContext): Promise<{ proposalPath: string; changed: string[] } | null> {
  if (!rt.cfg.enable_self_evolve) return null;
  const cfg = rt.cfg.selfEvolve;

  // 【记忆晋升·提案模式】夜间先筛选晋升 memory 挂起的晋升提案（apply 值得的，归档已处理的）
  try {
    const applyRes = await applyPendingPromotions(rt);
    if (applyRes.applied > 0 || applyRes.skipped > 0) {
      rt.log.info(`[selfevolve] pending promotions applied=${applyRes.applied} skipped=${applyRes.skipped}`);
    }
  } catch (e) {
    rt.log.debug(`[selfevolve] applyPendingPromotions: ${String(e)}`);
  }

  // 收集输入：近 7 日 daily notes + dim 目录 + 改动日志
  const notes = collectRecentFiles(rt.cfg.workspaceDir, 7);
  const changes = readChanges(rt.cfg.rollbackBackupDir);
  const baselines = collectBaselines(rt);

  // 基线比对：若最近已有提案且内容未变，跳过（防重复）
  const fingerprint = `${notes.length}|${changes.length}|${baselines.split("\n").length}`;
  const lastFp = rt.engineDb?.getSelfEvolveBaseline("selfevolve_fingerprint");
  if (lastFp === fingerprint) {
    rt.log.debug("[selfevolve] no change since last review; skip");
    return null;
  }

  // 生成提案文件
  const dir = cfg.proposalDir;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  const date = toISODate(Date.now());
  const id = `${date}-${Math.random().toString(36).slice(2, 6)}`;
  const path = join(dir, `${id}.md`);

  // —— LLM 分析（R1/R4）：用 chatGeneric 生成健康度分析 + 建议改动点清单（deepseek-v4-flash）——
  const llmConclusion = await renderLlmAnalysis(rt, { date, notes, changes, baselines });

  const body = buildProposalBody({
    id,
    date,
    notesCount: notes.length,
    changesCount: changes.length,
    baselines,
    recentNotesSample: notes.slice(-3),
    llmConclusion,
  });

  try {
    writeFileSync(path, body, "utf8");
  } catch (e) {
    rt.log.error(`[selfevolve] write proposal failed: ${String(e)}`);
    return null;
  }

  // 记录基线（防重复）
  rt.engineDb?.setSelfEvolveBaseline("selfevolve_fingerprint", fingerprint);
  rt.engineDb?.setSelfEvolveBaseline("last_proposal", path);

  rt.log.info(`[selfevolve] proposal written: ${path} (notes=${notes.length}, changes=${changes.length})`);
  return { proposalPath: path, changed: [] }; // 引擎只出提案，不 self-modify
}

/** 产物：自进化改动日志清单（供汇报）。 */
export function listRecentProposals(rt: RuntimeContext, depth = 10): string[] {
  const dir = rt.cfg.selfEvolve.proposalDir;
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .slice(-depth);
  } catch {
    return [];
  }
}

/** 收集近期记忆文件（近 N 天 daily note 的路径列表）。 */
function collectRecentFiles(workspaceDir: string, days: number): string[] {
  const memoryDir = join(workspaceDir, "memory");
  const out: string[] = [];
  if (!existsSync(memoryDir)) return out;
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  try {
    for (const f of readdirSync(memoryDir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue;
      const [y, m, d] = f.slice(0, 10).split("-").map(Number);
      const dt = Date.UTC(y, m - 1, d);
      if (now - dt < days * dayMs) out.push(f);
    }
  } catch {
    /* ignore */
  }
  return out.sort();
}

/** 收集 engine-db 基线（自进化输入）。 */
function collectBaselines(rt: RuntimeContext): string {
  try {
    const stats = readMemoryStatsSync(rt);
    return [
      `total=${stats.total}`,
      `bySource=${compact(stats.bySource)}`,
      `lastActive=${stats.lastActiveAt}`,
      `promoteCand=${stats.promotionCandidates}`,
    ].join("; ");
  } catch (e) {
    return `stats-error: ${String(e)}`;
  }
}

/** 自进化选用的 LLM 模型 id（R4：GLM-4.7-Flash 限流弃用，deepseek-v4-flash 实测稳定）。 */
function pickSelfevolveModel(): string {
  return "deepseek-v4-flash";
}

/** 同步读取记忆健康度指标（条数/来源分布/最近活跃度/晋升候选数）。 */
function readMemoryStatsSync(rt: RuntimeContext): {
  total: number;
  bySource: Record<string, number>;
  lastActiveAt: string;
  promotionCandidates: number;
} {
  const memoryDir = join(rt.cfg.workspaceDir, "memory");
  let total = 0;
  const bySource: Record<string, number> = {};
  let lastActiveAt = "";
  if (existsSync(memoryDir)) {
    try {
      for (const f of readdirSync(memoryDir)) {
        if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) {
          total += 1;
          if (f > lastActiveAt) lastActiveAt = f;
          const src = f.startsWith("dim.") ? "dim" : "daily";
          bySource[src] = (bySource[src] ?? 0) + 1;
        }
      }
    } catch {
      /* ignore */
    }
  }
  // 晋升候选数：engine-db 高投入主题条数（投入度代表“值得提拔”的候选）
  let promotionCandidates = 0;
  try {
    promotionCandidates = rt.engineDb?.listHighEngagement({
      minTurns: rt.cfg.engagement.minTurns,
      minTimeWindows: rt.cfg.engagement.minTimeWindows,
      minTokens: rt.cfg.engagement.minTokens,
    }).length ?? 0;
  } catch {
    /* ignore */
  }
  return { total, bySource, lastActiveAt, promotionCandidates };
}

function compact(o: Record<string, number>): string {
  const k = Object.keys(o);
  return k.length ? k.map((x) => `${x}=${o[x]}`).join(",") : "(空)";
}

/** 生成提案正文。 */
function buildProposalBody(o: {
  id: string;
  date: string;
  notesCount: number;
  changesCount: number;
  baselines: string;
  recentNotesSample: string[];
  llmConclusion?: string;
}): string {
  return `# memory-engine 自进化提案 ${o.id}

> 本提案仅记录改动建议，**不自动应用**。由知安审安全、落苏审可执行性、绫潇/南南确认后用 mem_rollback 或手工落地。

## 输入快照
- 复盘日期：${o.date}
- 近 7 日笔记数：${o.notesCount}
- 累计写盘改动（changes.jsonl）：${o.changesCount}
- 基线摘要：
${o.baselines || "（空）"}

## 近期笔记摘要
${o.recentNotesSample.map((f) => `- ${f}`).join("\n")}

## LLM 健康度分析（模型：${pickSelfevolveModel()}）
${o.llmConclusion?.trim() || "（LLM 未产出分析 / 即席生成失败）"}

## 建议（由引擎根据健康度产出，供评审）
- 结合上方 LLM 分析中的建议改动点清单评审，确认后手动落地。

## 回滚说明
任何一个写盘改动都记录在引擎回滚目录 changes.jsonl，可用 mem_rollback 一键回退。
`;
}

/** 调 LLM 生成健康度分析 + 建议改动点清单（R4：deepseek-v4-flash，失败降级返回空串）。 */
async function renderLlmAnalysis(
  rt: RuntimeContext,
  o: { date: string; notes: string[]; changes: unknown[]; baselines: string },
): Promise<string> {
  const prompt = `你是 memory-engine 的记忆体系自进化分析师。基于以下记忆健康度输入，输出：\n1. 健康度评估（条数是否失控/来源是否单一/最近活跃度）；\n2. 建议改动点清单（每行一条，用 "- " 开头，具体到可执行）。\n\n日期: ${o.date}\n基线: ${o.baselines}\n近 7 日笔记清单: ${o.notes.slice(0, 20).join(",")}\n累计写盘改动数: ${o.changes.length}\n\n只输出分析与建议清单，勿空话。`;
  return chatGeneric(
    {
      llmBaseUrl: rt.cfg.emotion.llmBaseUrl,
      llmModel: rt.cfg.emotion.llmModel,
      llmApiKey: rt.cfg.emotion.llmApiKey,
      timeoutMs: 20_000,
      log: rt.log,
    },
    prompt,
    { model: pickSelfevolveModel(), maxTokens: 800, temperature: 0.2 },
  );
}

export function readDailyNote(workspaceDir: string, file: string): string {
  const p = join(workspaceDir, "memory", file);
  try {
    if (existsSync(p)) return readFileSync(p, "utf8");
  } catch {
    /* ignore */
  }
  return "";
}
