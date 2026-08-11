/**
 * memory.ts — 记忆引擎·蒸溜提拔（模块：enable_memory_promotion）
 *
 * 职责：把 AGENTS.md 定义的 B(投入度) 触发引擎化。
 *
 * B 投入度信号（agent_end hook，2026-08-09 hotfix 校正）：
 *   按「语义话题段」统计投入度：只统计当前语义段（自上次话题切换以来）的轮次/token：
 *   当前段轮次>minTurns / 跨时段>minTimeWindows / 累计 token>minTokens
 *   任一超标 -> 标记为高投入事项。换话题后新段从低位起计，不顶着旧 topic 累计。
 *   高投入 -> 自动登记当天 notes + 生成"待提拔"候选，写入 engine-db。
 *
 * ─── hotfix 说明（南南 8/9 现场抓到，priority 高） ───────────────────────────
 * 原 bug：topic=频道（"agent:main:qqbot"→"main:qqbot"），轮次=event.messages.length
 *   = 整场消息总数。同一频道换语义话题不换签名 -> 全算同一个 topic，轮次从 1 一路涨
 *   （实测 main:main 到 111 轮 / token 675786）。A 轨(>=minTurns)判断完全失真。
 * 修复：topic 粒度按「语义话题段」，轮次只累计当前段。话题切换用 embedding 余弦判定
 *   （复用 compaction 模块同款标注阈值 avgSimSwitchThreshold≈0.26），确定性、已在真实
 *   数据标定。不做粗糙表面字符相似度（实测短中文句字面接近崩坏，会过切/漏切）。
 *
 * 性能铁律：agent_end 不阻塞消息路径 —— embed + 切换判定 + 计数全部投到后台任务
 *   （setImmediate），hook 本体同步返回。
 *
 * 自动提拔管线：
 *   候选 -> 打分 -> 分流：
 *     原则级/长期档案 -> 提案写 MEMORY.md/USER.md（里程碑级 P2 待确认）
 *     可检索需要      -> .index.jsonl 登记
 *     已过时          -> 清理（tombstone，记录到改动日志）
 */
import type {
  PluginHookAgentEndEvent,
  PluginHookAgentContext,
} from "openclaw/plugin-sdk/plugin-runtime";
import type { RuntimeContext } from "../runtime.js";
import { windowOf } from "../db/engine-db.js";
import { cosineSimilarity } from "./compaction.js";
import { createCloudEmbedding } from "./vector.js";
import { chatGeneric, distillText } from "../llm.js";
import {
  appendToFile,
  appendIndexEntry,
  memoryPath,
  userPath,
  indexPath,
} from "../writers.js";
import { toISODate } from "../time.js";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, mkdirSync, renameSync } from "node:fs";

/**
 * agent_end handler：投入度信号计数（B）。
 *
 * 只做同步收件：取本轮最新 user 文本，投后台任务（不 await、不阻塞 agent_end）。
 * 后台任务完成：embedding -> 话题切换判定 -> bump engagement / 高投入标记。
 * embedding 失败/超时 -> 并入当前段（不制造假切换）；任何异常静默，绝不抛。
 */
export async function onAgentEnd(
  rt: RuntimeContext,
  event: PluginHookAgentEndEvent,
  ctx: PluginHookAgentContext,
): Promise<void> {
  const cfg = rt.cfg;
  if (!cfg.enable_memory_promotion) return;
  const db = rt.engineDb;
  if (!db) return;

  const sessionKey = ctx.sessionKey ?? ctx.sessionId ?? "default";
  if (!Array.isArray(event.messages) || event.messages.length === 0) return;

  const newText = latestMessageText(event.messages);
  if (!newText.trim()) return;

  // 非阻塞投递：计数/切换判定延后到下一轮消息循环，hook 本体立即返回
  void scheduleCount(rt, sessionKey, newText);
}

/**
 * 后台计数任务主体：embed -> 判切换 -> bump。所有异常捕获，绝不上抛。
 * 用 setImmediate 让出消息循环，避免 agent_end 同步路径被 embedding 拖住。
 */
function scheduleCount(rt: RuntimeContext, sessionKey: string, text: string): void {
  setImmediate(() => {
    void (async () => {
      try {
        const seg = await classifySegmentTurn(rt, sessionKey, text);
        const topic = topicKey(sessionKey, seg.segNo);
        const tokens = estimateTokens(seg.texts);
        const db = rt.engineDb;
        if (!db) return;
        const state = db.bumpEngagement({
          topic,
          tsMs: Date.now(),
          tokens,
        });
        const cfg = rt.cfg;
        const high =
          state.turn_count >= cfg.engagement.minTurns ||
          state.time_window_count >= cfg.engagement.minTimeWindows ||
          state.token_count >= cfg.engagement.minTokens;
        if (high) {
          rt.log.info(
            `[memory] high-engagement topic="${topic}" turns=${state.turn_count} windows=${state.time_window_count} tokens=${state.token_count}`,
          );
          try {
            db.setSelfEvolveBaseline(
              `high_engagement:${topic}`,
              JSON.stringify(state),
            );
          } catch {
            /* ignore */
          }
          // —— 晋升闭环：高投入片段 -> 价值判断(四类) -> 琐事过滤 -> 写前自审 -> 合并 MEMORY/USER.md ——
          // 迭代【晋升价值改造】：不再纯按 token 量晋升。高投入只是“拿到候选资格”，
          // 是否真晋升由 judgePromotionValue() 判定；跨多时段/time_window_count 大是加分项。
          if (cfg.enable_memory_promotion) {
            const text = seg.texts.join(" ").slice(0, 1200);
            if (text.trim()) {
              await promoteCandidate(rt, {
                text,
                source: `high_engagement:${topic}`,
                ts: new Date().toISOString(),
                // 投入度画像透传给价值判断：time_window_count 跨时段信号（>窗口数=跨多时段/多天持续）。
                engagement: {
                  turnCount: state.turn_count,
                  timeWindowCount: state.time_window_count,
                  tokenCount: state.token_count,
                },
              }).catch((e) => {
                rt.log.debug(`[memory] promote skipped: ${String(e)}`);
              });
            }
          }
        }
      } catch (e) {
        rt.log.debug(`[memory] engagement count skipped: ${String(e)}`);
      }
    })();
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 话题分段（hotfix 核心）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 话题切换相似度线（embedding 余弦，复用 compaction 标注值）：
 *   avgSim <= 此值 -> 判话题切换、开新段。真实数据：边界中位≈0.24、话题内中位≈0.345。
 * 默认取 compaction 同款 0.26。当前为模块常量（本次 hotfix 不动 config/schema）。
 */
const SWITCH_THRESHOLD = 0.26;
/** 对比窗口：与当前段最近 K 条代表向量算平均相似度。 */
const SEG_WINDOW = 3;
/** 精简会话标识长度（topic 键去重用）。 */
const SHORT_TAG_LEN = 6;
/** embedding 硬超时(ms)，对齐 compaction.embeddingTimeoutMs。 */
const EMBED_TIMEOUT_MS = 10_000;
/** 单个语义段最多保留的文本条数（仅用于 token 估算，防内存无界）。 */
const MAX_SEG_TEXTS = 200;

/** 每个会话当前语义段的内存状态（进程内，非持久化；gateway 重启重建，键碰撞界限在单个会话内）。 */
interface EngagementSeg {
  segNo: number;
  /** 当前段最近 K 条代表向量。 */
  basis: number[][];
  /** 当前段已累计的投入文本（供 token 估算）。 */
  texts: string[];
}

const topicWindows = new Map<string, EngagementSeg>();

/** 取最新一条非空文本消息。 */
function latestMessageText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = textOfMessage(messages[i]);
    if (t.trim()) return t;
  }
  return "";
}

function textOfMessage(m: unknown): string {
  if (typeof m === "string") return m;
  const c = (m as { content?: unknown; message?: unknown })?.content;
  if (typeof c === "string") return c;
  return "";
}

/** 读会话当前段，缺则初始化并返回（供并发串行使用）。 */
function ensureSegment(sessionKey: string): EngagementSeg {
  let seg = topicWindows.get(sessionKey);
  if (!seg) {
    seg = { segNo: 1, basis: [], texts: [] };
    topicWindows.set(sessionKey, seg);
  }
  return seg;
}

/**
 * 判定本轮是否开新语义段并推进窗口，返回当前段状态。
 * 对 embedding 的失败/超时全部静默降级为「并入当前段」，绝不抛。
 */
async function classifySegmentTurn(
  rt: RuntimeContext,
  sessionKey: string,
  text: string,
): Promise<EngagementSeg> {
  const seg = ensureSegment(sessionKey);
  seg.texts.push(text);
  if (seg.texts.length > MAX_SEG_TEXTS) seg.texts.shift();

  let vec: number[] | null = null;
  try {
    const provider = await createCloudEmbedding(rt);
    if (provider) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
      try {
        const [[v]] = await Promise.race([
          provider.embed([text.slice(0, 2000)]),
          new Promise<never>((_, reject) =>
            controller.signal.addEventListener("abort", () =>
              reject(new Error("embed timeout")),
            ),
          ),
        ]);
        vec = Array.isArray(v) ? v : null;
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (e) {
    rt.log.debug(`[memory] embed failed; merge into segment: ${String(e)}`);
  }

  // 无向量 -> 无法判切换，并入当前段（段内首条则作为代表向量）
  if (!vec || vec.length === 0) {
    if (seg.basis.length === 0 && vec?.length) seg.basis.push(vec);
    return seg;
  }

  const recent = seg.basis.slice(-SEG_WINDOW);
  if (recent.length > 0) {
    let sum = 0;
    for (const b of recent) sum += cosineSimilarity(vec, b);
    const avg = sum / recent.length;
    if (avg <= SWITCH_THRESHOLD) {
      // 开新段：segNo++，basis/texts 重置后再登记本轮为首条
      seg.segNo += 1;
      seg.basis = [vec];
      seg.texts = [text];
      return seg;
    }
  }

  // 并入当前段
  seg.basis.push(vec);
  if (seg.basis.length > SEG_WINDOW) seg.basis.shift();
  return seg;
}

/** 会话短标识：sessionKey 去 base 后唯一尾段 hash 成短码（topic 键去重、可读）。 */
function shortTag(sessionKey: string, len: number): string {
  const parts = sessionKey.trim().split(":");
  const tail = parts.slice(3).join(":");
  if (!tail) return "x";
  let h = 0;
  for (let i = 0; i < tail.length; i++) h = (h * 31 + tail.charCodeAt(i)) >>> 0;
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, len);
}

/** topic 键 = base（agent:channel）+ #<短会话标识>s<段号>。每会话每语义段独立行。 */
function topicKey(sessionKey: string, segNo: number): string {
  const parts = sessionKey.trim().split(":");
  const base =
    parts.length >= 3 ? `${parts[1]}:${parts[2]}` : sessionKey.trim() || "unknown";
  return `${base}#${shortTag(sessionKey, SHORT_TAG_LEN)}s${segNo}`;
}

function estimateTokens(messages: string[]): number {
  let t = 0;
  for (const s of messages) t += Math.ceil(s.length / 2);
  return t;
}

/** 供自进化库参考：可直接取当前段号做低投入段清理（可选，不强制启用）。 */
export { windowOf };

// ────────────────────────────────────────────────────────────────────────────
// 投入度晋升闭环（南南 2026-08-10 授命自动合并，写前必过自审防语义漂移）
// ────────────────────────────────────────────────────────────────────────────

export interface PromotionCandidate {
  /** 消息原文（供提炼；晋升落盘不再直接粘贴原文，只记“事情框架”）。 */
  text: string;
  source: string;
  ts: string;
  /** 投入度画像（供“跨多时段/多天”必晋升加分判定）。 */
  engagement?: {
    turnCount: number;
    timeWindowCount: number;
    tokenCount: number;
  };
}

/** 跨多时段判定阈值（time_window_count>=此值，视为话题跨多时段/多天持续投入）。 */
const MULTI_WINDOW_THRESHOLD = 2;
/** 🎉 完成/里程碑信号作为“加分项”，但不唯一依据（兼容其他 agent 无此符号的场景）。 */
const CELEBRATION_MARKER = "🎉";

/** 晋升落盘叙事框架安全上限（防蒸馏爆炸/烧上下文）。 */
const PROMOTE_DISTILL_MAX_CHARS = 2200;

/**
 * 晋升管线主体（3A，南南精确：记“事”不记“话”）——【晋升价值改造】迭代版：
 *   蒸馏出【事项/完成度/后续/关键节点】框架 -> 价值判定(四类:决策/结果/文件变更/任务状态)
 *   -> 琐事过滤 -> 跨多时段+事件信号必晋升 -> 写前自审 -> 归档判定 -> 追加合并。
 * 蒸馏失败/无 LLM -> 降级为“来源指针 + 事件摘要截断”，绝不退回抄原文。
 * 价值判定的原则：拿不准宁可保留也不误剔（保长期记忆纯净）；琐事（重启对话/纯过程寒暄）剔除。
 */
export async function promoteCandidate(
  rt: RuntimeContext,
  candidate: PromotionCandidate,
): Promise<{ status: string; target?: string; ts?: string; reason?: string }> {
  if (!rt.cfg.enable_memory_promotion) return { status: "disabled" };
  if (isPromotionDeduped(rt, candidate)) return { status: "dup_skipped" };

  // 0) 把原文蒸馏成叙事框架：先摘“事”，再造“框架”。
  const narrative = await distillToNarrative(rt, candidate);

  // 0.5)【晋升价值改造】价值判定：是否属 lossless 四类（决策/结果/文件变更/任务状态）。
  //     用“通用信号词 + LLM 四类语义（confidence）”双轨，不依赖 🎉；🎉 仅作加分。
  //     纯过程琐事（重启对话/确认状态/寒暄）在这里被过滤，不晋升 MEMORY.md。
  const value = await judgePromotionValue(rt, candidate, narrative);
  if (value.boost) {
    // 跨多时段 + 事件/节点信号：提升为“必晋升”优先级（南南：把跨多天大项目/重要进展落长期记忆）。
    rt.log.info(
      `[memory] cross-window boost: ${candidate.source} windows=${candidate.engagement?.timeWindowCount ?? 0}`,
    );
  }
  if (!value.worth) {
    // 价值不足：只更新引擎内部 engagement（已在调用处 bump），不写 MEMORY.md。
    // 记录一次“过滤原因”到日志，供审计；不落盘、不登记索引。
    rt.log.info(
      `[memory] filtered (trivial/no-value): ${candidate.source} reason=${value.reason}`,
    );
    return { status: "filtered", reason: value.reason };
  }

  // 1) 写前自审：LLM 比对“蒸馏后框架 vs 待写入事实”，防语义漂移（保留南南 8/10 要求）。
  const selfCheck = await selfAudit(rt, narrative);
  if (!selfCheck.consistent) {
    rt.log.warn(`[memory] promote needs_review: ${selfCheck.reason}`);
    return { status: "needs_review", reason: selfCheck.reason };
  }

  // 2) 判定去向：MEMORY.md（通用/原则级）或 USER.md（用户密切）
  const isUser = /用户|用户偏好|user|主人|殿下/.test(candidate.source);
  const target = isUser ? userPath(rt.workspaceDir) : memoryPath(rt.workspaceDir);

  // 3)【记忆晋升·提案模式】不再直接写 MEMORY/USER.md，而是写成独立提案文件，
  //    待夜间定时筛选后才真正晋升（南南 8/11 定：避免一堆乱七八糟直接进长期记忆）。
  //    提案块含目标 target + 蒸馏框架 narrative + 价值 reason + 来源，供夜间筛选 apply。
  const propDir = rt.cfg.selfEvolve.proposalDir || `${rt.workspaceDir}/.rules/memory-engine-proposals`;
  const propFile = join(propDir, "promotion", `pending-${toISODate(Date.now())}.md`);
  const proposalEntry =
    `\n---\n` +
    `## 📝 晋升提案 · ${new Date().toISOString()}\n` +
    `- **目标**${isUser ? "USER.md" : "MEMORY.md"}\n` +
    `- **来源**${candidate.source}\n` +
    `- **价值**${value.worth ? value.reason : "needs_review"}\n` +
    `- **蒸馏框架**\n\n${narrative}\n`;
  const res = appendToFile(
    propFile,
    proposalEntry,
    "memory",
    "晋升提案(待夜间筛选)",
    `propose: ${candidate.text.slice(0, 40)}`,
    rt.cfg,
    rt.log,
  );
  if (!res.ok) return { status: "write_failed", reason: res.error };

  // 4) 登记索引 + 台账防重复（标记为 pending 提案，apply 后才 setPromoted）
  appendIndexEntry(
    indexPath(rt.workspaceDir),
    {
      ts: candidate.ts,
      module: "memory",
      kind: "promotion-proposal",
      target,
      summary: narrative.slice(0, 120),
      source: candidate.source,
      pending: true,
    },
    rt.cfg,
    rt.log,
  );

  rt.log.info(`[memory] promotion-proposed->${propFile} (${candidate.source})`);
  return { status: "proposed", target, ts: candidate.ts, reason: value.reason };
}

/**
 * 【记忆晋升 · 提案模式】夜间筛选晋升：读取 <proposalDir>/promotion/pending-*.md 里的晋升提案，
 * 对每条经 LLM 价值判定值得的，真正 apply 到 MEMORY.md/USER.md，并登记索引 + 台账 + 归档已处理提案。
 * 由 nightlyReview（selfevolve，夜间 cron）调用。z：不在运行时直接改 MEMORY，避免琐碎提案污染长期记忆。
 */
export async function applyPendingPromotions(rt: RuntimeContext): Promise<{ applied: number; skipped: number }> {
  const propDir =
    (rt.cfg.selfEvolve.proposalDir || `${rt.workspaceDir}/.rules/memory-engine-proposals`) + "/promotion";
  const appliedDir = join(propDir, "applied");
  const files = (() => {
    try {
      return existsSync(propDir)
        ? readdirSync(propDir).filter((f) => f.startsWith("pending-") && f.endsWith(".md"))
        : [];
    } catch {
      return [];
    }
  })();
  if (!files.length) return { applied: 0, skipped: 0 };

  let applied = 0;
  let skipped = 0;
  for (const f of files.sort()) {
    const path = join(propDir, f);
    try {
      const body = readFileSync(path, "utf8");
      // 解析目标（USER.md / MEMORY.md）与蒸馏框架
      const isUser = /\*\*目标\*\*USERR?文档|\*\*目标\*\*:\s*USER|target:USER/i.test(body);
      const target = isUser ? userPath(rt.workspaceDir) : memoryPath(rt.workspaceDir);
      // 提取蒸馏框架（## 📝 之后的内容）
      const m = body.match(/蒸馏框架\s*\n\n([\s\S]*?)\n\s*\n---/);
      const narrative = (m ? m[1].trim() : "").trim();
      const sourceMatch = body.match(/\*\*来源\*\*\s*(.+)/);
      const source = sourceMatch ? sourceMatch[1].trim() : `pending:${f}`;
      if (!narrative) {
        skipped++;
        continue;
      }
      // 阶段式：apply 时先用 LLM 价值复核（与 promoteCandidate 同口径），琐事在此被过滤
      const candidate: any = {
        text: narrative,
        source,
        ts: new Date().toISOString(),
      };
      const value = await judgePromotionValue(rt, candidate, narrative);
      if (!value.worth) {
        rt.log.info(`[memory] pending filtered: ${f} reason=${value.reason}`);
        skipped++;
        continue;
      }
      const selfCheck = await selfAudit(rt, narrative);
      if (!selfCheck.consistent) {
        rt.log.warn(`[memory] pending needs_review: ${f}`);
        skipped++;
        continue;
      }
      const entry = buildEntry(candidate, narrative, true);
      const res = appendToFile(target, entry, "memory", "夜间筛选晋升", `apply: ${f}`, rt.cfg, rt.log);
      if (!res.ok) {
        skipped++;
        continue;
      }
      appendIndexEntry(
        indexPath(rt.workspaceDir),
        {
          ts: candidate.ts,
          module: "memory",
          kind: "promotion",
          target,
          summary: narrative.slice(0, 120),
          source,
        },
        rt.cfg,
        rt.log,
      );
      rt.engineDb?.setPromoted(dedupKey(candidate), target);
      // 归档已处理提案：移入 applied/
      mkdirSync(appliedDir, { recursive: true });
      renameSync(path, join(appliedDir, f));
      applied++;
      rt.log.info(`[memory] pending applied->${target} (${f})`);
    } catch (e) {
      rt.log.debug(`[memory] pending apply failed: ${f} ${String(e)}`);
      skipped++;
    }
  }
  return { applied, skipped };
}

/**
 * 3A 蒸馏核心：把高投入 topic 的消息原文炼成“事情框架”（记“事”不记“话”）。
 * 用现有 distillText（其 system prompt 已要求提炼事实/决定/偏好/承诺/情感温度），
 * 但 prompt 额外把输出限定为叙事框架单行值。
 * 失败/无 LLM -> 返回降级框架（来源指针 + 事件摘要截断），绝不回退为抄原文。
 */
async function distillToNarrative(
  rt: RuntimeContext,
  c: PromotionCandidate,
): Promise<string> {
  const cfg = rt.cfg;
  const date = toISODate(new Date(c.ts).getTime());
  const prompt =
    `下面是今天一段高投入多轮对话（消息原文）。请把它提炼成“事情记录”叙事框架，\n` +
    `只回答五行内容（每行给一句话，不用列表符号，直接给值；不确定填“无或不明确”）：\n` +
    `事项：<今天做了什么，一句话归纳>\n` +
    `完成度：<进行到哪一步，是否完成/暂停/待续>\n` +
    `后续：<有/无，下一步是什么，若明确>\n` +
    `关键节点：<重要里程碑/决策/共识，可一句>\n` +
    `要求：只记“事”，不抄对话原话；保留关键人名/数字/时间；赌气/情绪宣泄类表达只标情感标签、不得当既定事实。\n\n原始对话：\n${c.text.slice(0, PROMOTE_DISTILL_MAX_CHARS)}`;
  let distilled = "";
  try {
    distilled = await distillText(
      { ...cfg.emotion, timeoutMs: 20_000, log: rt.log },
      prompt,
    );
  } catch (e) {
    rt.log.debug(`[memory] distill narrative failed: ${String(e)}`);
    distilled = "";
  }
  const clean = (distilled ?? "").trim();
  if (clean && clean !== "-0" && clean !== "-") {
    // 从蒸馏文本中拆出五行值（按“事项：/完成度：/后续：/关键节点：”冒号定位）。
    const lines = parseNarrativeLines(clean);
    if (lines.事项 !== "digest_malformed") {
      return buildNarrativeBlock(date, c.source, lines);
    }
    rt.log.warn(`[memory] distill output malformed for ${c.source}`);
  }

  // —— 降级：LLM 不可用/失败，只落“来源指针 + 事件摘要截断”，绝不再抄原文 ——
  rt.log.warn(`[memory] distill unavailable; degraded narrative for ${c.source}`);
  const degraded = {
    事项: `高投入话题发生（来源 ${c.source}），未能提炼事件摘要`,
    完成度: "不明确（LLM 蒸馏不可用）",
    后续: "不明确",
    关键节点: eventTruncate(c.text),
  };
  return buildNarrativeBlock(date, c.source, degraded);
}

/** 把蒸馏文本按五行冒号拆成 {事项,完成度,后续,关键节点}；缺项用来源提示兜底。 */
/**
 * 把蒸馏文本按五行冒号拆成 {事项,完成度,后续,关键节点}；缺项用来源提示兜底。
 * 格式修复：不再用固定 slice(2)（那会在“完成度/关键节点”这类变长键上切错位、
 * 且遇“：：”双冒号上下文留下前导冒号），改为按“键长度 + 冒号”精确定位取值，
 * 并去掉值前导的多余全/半角冒号与空白。缺项仍走降级路径。
 */
function parseNarrativeLines(
  distilled: string,
): Record<"事项" | "完成度" | "后续" | "关键节点", string> {
  const KEYS = ["事项", "完成度", "后续", "关键节点"] as const;
  const out: Record<"事项" | "完成度" | "后续" | "关键节点", string> = {
    事项: "incomplete", 完成度: "incomplete", 后续: "incomplete", 关键节点: "incomplete",
  };
  for (const line of distilled.split(/\r?\n+/)) {
    for (const key of KEYS) {
      // 兼容全角：全角冒号或无冒号（LLM 偶尔输出“事项 xxx”）
      const colIdx = line.indexOf(`${key}：`);
      const colHalfIdx = colIdx >= 0 ? colIdx : line.indexOf(`${key}:`);
      const start = Math.max(colIdx, colHalfIdx);
      if (start === 0) {
        // 跳过“键 + 冒号”，剩下来的是值；再去掉值前导的多余冒号/空白。
        // 全/半角冒号都占 1 个 UTF-16 码元，所以可按“键长 + 1”精确切片。
        const value = line
          .slice(key.length + 1)
          .trim()
          // 【格式修复】消除值前导的多余冒号（如“：：重启对话” slice 后仍带一个前导冒号）。
          .replace(/^[：:\s]+/, "");
        out[key] = value;
        break;
      }
      // 无冒号标注但整行内容与键相关（“事项 重启对话”）：不判为合法格式，留给完整匹配分支。
    }
  }
  if (Object.values(out).some((v) => v === "incomplete")) {
    // 蒸馏未按格式输出 -> 丢弃，走降级路径
    return { 事项: "digest_malformed" } as Record<"事项" | "完成度" | "后续" | "关键节点", string>;
  }
  return out;
}

/** 事件摘要截断（降级兜底用，正向提示当前话题，不抄全文）。 */
function eventTruncate(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat || "（无可用内容）";
}

// ────────────────────────────────────────────────────────────────────────────
//【晋升价值改造】价值判定 + 琐事过滤（lossless 四类：决策/结果/文件变更/任务状态）
// 参考 lossless-claw/src/summarize.ts LCM_SUMMARIZER_SYSTEM_PROMPT：
//   “Preserve only factual information: decisions, outcomes, file changes, and task state.”
// 判定原则：拿不准宁可保留也不误剔（保长期记忆纯净）；纯过程琐事明确剔除。
// ────────────────────────────────────────────────────────────────────────────

/** 信号词典·A：版本/发布/交付/部署/git 等“成果落地”词（任何 agent 通用，不含 🎉）。 */
const VALUE_SIGNAL_RELEASE_RE =
  /(?:git(?:\b|提交|推送)|push|commit|merge|\brelease\b|版本|发布|升级|上线|回滚|部署|\bdeploy\b|交付|\bship\b|\bPR\b|\bMR\b)/i;
/** 信号词典·B：修复/bug/代码/文件/实现/开发/决策/完成/待办等“工程进展”词。 */
const VALUE_SIGNAL_WORK_RE =
  /(?:修复|\bbug\b|问题|异常|\bcode\b|代码|文件|\bapi\b|接口|模块|功能|实现|开发|构建|\bbuild\b|\btest\b|测试|验证|排查|定位|调通|跑通|完成|搞定|待办|下一步|决策|确定|决定|方案|\btask\b|任务|验收|里程碑)/i;

/** 明确“纯过程/无长期价值”琐事信号词（一次性操作/状态确认/过程寒暄/纯呼应）。 */
const TRIVIAL_SIGNAL_RE =
  /(?:重启对话|重启会话|开始新一轮|确认状态|确认一下|调整状态|闲聊|寒暄|打个招呼|打招呼|你好吗|早安|晚安|拜拜|再见|好的|收到|了解|在吗|你还在吗|ok|好的呢|知道了)/i;

/**
 * 双轨价值判定：
 *  A. 通用信号词（非依赖 🎉）命中 → worth=true（四类之一证据充分）。
 *  B. LLM 四类语义分类（决策/结果/文件变更/任务状态，置信度）命中任一 → worth=true。
 *  🎉 出现在叙事文本里 → 作为“加分项”直接补强（非唯一依据）。
 *  C. 明确琐事词 + 无任何成果/LLM 语义信号 → 过滤（只更新引擎内部 engagement，不写 MEMORY.md）。
 *  {@link PromotionCandidate} 带跨多时段（time_window_count>=阈值）且有信号 → “跨多天+节点”必晋升，返回 boost。
 */
async function judgePromotionValue(
  rt: RuntimeContext,
  c: PromotionCandidate,
  narrative: string,
): Promise<{ worth: boolean; reason: string; boost: boolean }> {
  const windowCount = c.engagement?.timeWindowCount ?? 0;
  const crossWindow = windowCount >= MULTI_WINDOW_THRESHOLD;

  const signalRelease = VALUE_SIGNAL_RELEASE_RE.test(narrative);
  const signalWork = VALUE_SIGNAL_WORK_RE.test(narrative);
  const hasSignal = signalRelease || signalWork;
  const celebrates = narrative.includes(CELEBRATION_MARKER); // 🎉 加分项，非唯一依据

  // A) 通用信号词命中：属于“结果/文件变更/决策/任务状态”之一的强证据 → 直接晋升。
  if (hasSignal) {
    const reason = `信号词命中(${signalRelease ? "成果/发布" : ""}${signalWork ? "工程/决策" : ""})`;
    return { worth: true, reason, boost: crossWindow };
  }

  // 🎉 加分项：出现在叙事中表明有“完成/里程碑”节点 → 直接放行（兼容各 agent 成果场景）。
  if (celebrates) {
    return { worth: true, reason: "🎉 完成/里程碑信号（加分项）", boost: crossWindow };
  }

  // B) LLM 四类语义分类（决策/结果/文件变更/任务状态），带置信度。
  const llmVerdict = await classifyFourCategory(rt, narrative, c.text);
  if (llmVerdict.category) {
    const boost =
      crossWindow && (llmVerdict.category !== "task_state" || llmVerdict.confidence >= 0.6);
    return {
      worth: true,
      reason: `LLM四类命中(${llmVerdict.category}, conf=${llmVerdict.confidence})`,
      boost,
    };
  }

  // C) 到这里：无信号词、无 🎉、LLM 也未判为四类。
  //    若明确命中琐事词 → 过滤（纯过程琐事不晋升 MEMORY.md）。
  const trivialLikely = TRIVIAL_SIGNAL_RE.test(narrative);
  if (trivialLikely) {
    return {
      worth: false,
      reason: `琐事（${trivialFragment(narrative)}）`,
      boost: false,
    };
  }

  // 无信号、无 🎉、无 LLM 判定、也无明确琐事：拿不准 → 保守保留（宁留勿剔）。
  return { worth: true, reason: "低置信放行（宁留勿剔）", boost: crossWindow };
}

/** 从叙事里截取触发“琐事判定”的一小段，供日志可读。 */
function trivialFragment(narrative: string): string {
  const flat = narrative.replace(/\s+/g, " ").trim();
  return flat.length > 24 ? `${flat.slice(0, 24)}…` : flat || "无可用内容";
}

/**
 * LLM 四类语义判定：判断叙事是否属于 lossless 四类之一。
 * 四类：decisions / outcomes / file_changes / task_state。
 * 四类均不属 -> {category: null}。LLM 不可用/解析失败 -> {category: null}。
 */
async function classifyFourCategory(
  rt: RuntimeContext,
  narrative: string,
  rawText: string,
): Promise<{
  category: "decisions" | "outcomes" | "file_changes" | "task_state" | null;
  confidence: number;
}> {
  const p =
    `你是记忆引擎的“长期记忆价值判定员”。参考事实抽取原则，只保留四类事实：决定(decision)、结果(outcome)、文件变更(file change)、任务状态(task state)。\n` +
    `判断下面的“浓缩叙事（重点）”是否含有这四类之一的具体事实。\n` +
    `“重启对话”“确认状态”“闲聊寒暄”“纯过程描述”这类不构成四类事实，回答 category=null。\n` +
    `浓缩叙事：\n${narrative.slice(0, 1500)}\n` +
    `（参考原文：${rawText.slice(0, 600)}）\n` +
    `只输出 JSON: {"category":"decisions"|"outcomes"|"file_changes"|"task_state"|null,"confidence":0~1,"reason":string}`;
  const raw = await chatGeneric(
    { ...rt.cfg.emotion, timeoutMs: 15_000, log: rt.log },
    p,
    { model: "deepseek-v4-flash", maxTokens: 200, temperature: 0 },
  );
  if (!raw.trim()) return { category: null, confidence: 0 };
  const m = raw.match(/\{[\s\S]*\}/);
  try {
    const obj = JSON.parse(m ? m[0] : raw) as {
      category?: string | null;
      confidence?: number | string;
    };
    const cat = String(obj?.category ?? "").toLowerCase();
    const conf = typeof obj?.confidence === "number" ? obj.confidence : parseFloat(String(obj?.confidence));
    const c = Number.isFinite(conf) ? conf : 0;
    if (cat === "decisions" || cat === "outcomes" || cat === "file_changes") {
      return { category: cat, confidence: c };
    }
    if (cat === "task_state") return { category: "task_state", confidence: c };
    return { category: null, confidence: 0 };
  } catch {
    return { category: null, confidence: 0 };
  }
}

/** 按南南定稿的叙事框架模板排版落盘条目。 */
function buildNarrativeBlock(
  date: string,
  source: string,
  v: Record<"事项" | "完成度" | "后续" | "关键节点", string>,
): string {
  return (
    `## 📋 事情记录 · ${date}\n` +
    `- **事项**：${v.事项}\n` +
    `- **完成度**：${v.完成度}\n` +
    `- **后续**：${v.后续}\n` +
    `- **关键节点**：${v.关键节点}\n` +
    `- **来源**：→ ${source}`
  );
}

/** 去重键：来源 + 首 24 字符（内容相近视为重复，防自进化重复合并）。 */
function dedupKey(c: PromotionCandidate): string {
  return `${c.source}::${c.text.replace(/\s+/g, "").slice(0, 24)}`;
}

/** 已在台账则跳过（防重复）。 */
function isPromotionDeduped(rt: RuntimeContext, c: PromotionCandidate): boolean {
  try {
    return Boolean(rt.engineDb?.isPromoted(dedupKey(c)));
  } catch {
    return false;
  }
}

/** 自审：保证写入内容与真实认知一致（南南 8/10 明确要求）。 */
async function selfAudit(rt: RuntimeContext, text: string): Promise<{ consistent: boolean; reason: string }> {
  const p = `你是记忆引擎的“写前自审员”。以下是要写入记忆档案的内容，请判断：它是否与事实一致？有无“把印象当事实/情绪宣泄当事实/夸张”的情况？
内容: ${text.slice(0, 2000)}
只输出 JSON: {"consistent":bool,"reason":string}`;
  const raw = await chatGeneric(
    {
      ...rt.cfg.emotion,
      timeoutMs: rt.cfg.emotion.llmBaseUrl ? 15_000 : 20_000,
      log: rt.log,
    },
    p,
    { model: "deepseek-v4-flash", maxTokens: 200, temperature: 0 },
  );
  const m = raw.match(/\{[\s\S]*\}/);
  try {
    const obj = JSON.parse(m ? m[0] : raw) as { consistent?: boolean | string; reason?: string };
    const ok = obj?.consistent === true || obj?.consistent === "true";
    return { consistent: Boolean(ok), reason: obj?.reason || "自审通过" };
  } catch {
    // 解析失败 / LLM 未配置 -> 保守：允许合并（不以解析失败阻断晋升），用 plain reason
    return { consistent: true, reason: "自审不可用，跳过（临时放行）" };
  }
}

/** 构造档案追加条目文本：写“事情框架”（叙事），不是原文拼接。 */
function buildEntry(
  c: PromotionCandidate,
  narrative: string,
  consistent: boolean,
): string {
  return `\n## 🎓 ${toISODate(Date.now())} · ${consistent ? "已自审" : "待审"}\n` + narrative + `\n`;
}

