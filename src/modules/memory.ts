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
 * ─── hotfix 说明（8/9 现场抓到，priority 高） ───────────────────────────
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
import { existsSync, readdirSync, readFileSync } from "node:fs";

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
// 投入度晋升闭环（2026-08-10 授命自动合并，写前必过自审防语义漂移）
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

/** 投入度多时段的量化上限（六维 frequency 归一化用，超过即按上限截顶）。 */
const ENGAGE_TURNS_CAP = 25;
const ENGAGE_WINDOWS_CAP = 6;
const ENGAGE_TOKENS_CAP = 120_000;

/** 新鲜度（recency 维度）衰减窗口：距 now 超过此小时数视为旧账，递减归零。 */
const RECENCY_HALF_HOURS = 24;

/**
 * 蒸馏不可用连续计数（C2 可观测性）:
 * 当 LLM 蒸馏失败/未配置导致 promotion 整条跳过时自增。
 * 用于日志告警：若某时段连续多次 distill_unavailable，说明 LLM 疑似静默挂掉，
 * 而非“今天确实无高价值事”。进程内计数，gateway 重启清零。
 */
let distillUnavailableStreak = 0;
function noteDistillUnavailable(rt: RuntimeContext): void {
  distillUnavailableStreak += 1;
  if (distillUnavailableStreak >= 5 && distillUnavailableStreak % 5 === 0) {
    rt.log.warn(
      `[memory] ALERT: ${distillUnavailableStreak} 次连续 distill_unavailable，疑 LLM 蒸馏链路静默失效，请检查 cfg.emotion.llmBaseUrl/llmModel/llmApiKey。`,
    );
  }
}
function resetDistillStreak(): void {
  distillUnavailableStreak = 0;
}

/** 话题延续/query diversity：从 topic/source 键反解语义段号 s<segNo>。 */
const SEG_NO_RE = /s(\d+)(?:$|\b)/;

/**
 * 晋升管线主体（3A，精确：记“事”不记“话”）——【晋升价值改造】迭代版：
 *   蒸馏出【事项/完成度/后续/关键节点】框架 -> 价值判定(四类:决策/结果/文件变更/任务状态)
 *   -> 琐事过滤 -> 跨多时段+事件信号必晋升 -> 写前自审 -> 归档判定 -> 追加合并。
 * 蒸馏失败/无 LLM -> 返回空串（不落盘、不降级塞原文）；原文留在 lossless 无损层可召回。
 * 价值判定：六维加权打分 + 硬门槛，不达标不落盘（不再“宁留勿剔”）。
 */
export async function promoteCandidate(
  rt: RuntimeContext,
  candidate: PromotionCandidate,
): Promise<{ status: string; target?: string; ts?: string; reason?: string }> {
  if (!rt.cfg.enable_memory_promotion) return { status: "disabled" };
  if (isPromotionDeduped(rt, candidate)) return { status: "dup_skipped" };

  // 0) 把原文蒸馏成叙事框架：先摘“事”，再造“框架”。
  const narrative = await distillToNarrative(rt, candidate);
  if (!narrative.trim()) {
    // 脏数据防护：蒸馏不可用 → 不落盘、不登记索引，仅日志留桽。
    return { status: "distill_unavailable" };
  }

  // 0.5)【晋升价值改造】价值判定：六维加权打分 + 硬门槛(2026-08-13 拍板)。
  //     高投入只给“候选资格”，valueScore>=0.50 才给“过门资格”，两者都过才落提案缓冲。
  const value = await judgePromotionValue(rt, candidate, narrative);
  if (value.boost) {
    // 跨多时段 + 事件/节点信号：提升为“必晋升”优先级（把跨多天大项目/重要进展落长期记忆）。
    rt.log.info(
      `[memory] cross-window boost: ${candidate.source} windows=${candidate.engagement?.timeWindowCount ?? 0}`,
    );
  }
  if (!value.worth) {
    // 价值不足：只更新引擎内部 engagement（已在调用处 bump），不写 MEMORY.md。
    // 记录一次“过滤原因 + 价值分”到日志，供审计；不落盘、不登记索引。
    rt.log.info(
      `[memory] filtered (score=${value.score?.toFixed(2)}): ${candidate.source} reason=${value.reason}`,
    );
    return { status: "filtered", reason: value.reason };
  }

  // 1) 写前自审：LLM 比对“蒸馏后框架 vs 待写入事实”，防语义漂移（保留 8/10 要求）。
  const selfCheck = await selfAudit(rt, narrative);
  if (!selfCheck.consistent) {
    rt.log.warn(`[memory] promote needs_review: ${selfCheck.reason}`);
    return { status: "needs_review", reason: selfCheck.reason };
  }

  // 2) 判定去向：MEMORY.md（通用/原则级）或 USER.md（用户密切）
  const isUser = /用户|用户偏好|user|主人|殿下/.test(candidate.source);
  const target = isUser ? userPath(rt.workspaceDir) : memoryPath(rt.workspaceDir);

  // 3)【记忆晋升·提案模式】不再直接写 MEMORY/USER.md，而是写成独立提案文件，
  //    待夜间人工终审后才真正晋升（8/11 + 8/13 定：避免垃圾直接进长期记忆）。
  //    提案块含目标 target + 蒸馏框架 narrative + 价值分 score + 来源，供夜间待审。
  const propDir = rt.cfg.selfEvolve.proposalDir || `${rt.workspaceDir}/.rules/memory-engine-proposals`;
  const propFile = join(propDir, "promotion", `pending-${toISODate(Date.now())}.md`);

  // 3.5)【提案节流】同 topic 未 apply 前最多 1 条 pending（converge 而非 append）。
  const converged = await proposalConverge(rt, candidate, propFile, narrative, value);
  if (converged) return { status: "converged", reason: "同 topic 已存在待审提案（合并更新）" };

  const proposalEntry =
    `\n---\n` +
    `## 📝 晋升提案 · ${new Date().toISOString()}\n` +
    `- **目标**${isUser ? "USER.md" : "MEMORY.md"}\n` +
    `- **来源**${candidate.source}\n` +
    `- **价值分**${(value.score ?? 0).toFixed(3)} (${value.worth ? value.reason : "needs_review"})\n` +
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
 * 【记忆晋升 · 提案模式 · 终审闸门】夜间处理：
 * 读取 <proposalDir>/promotion/pending-*.md 里的晋升提案，不再自动 apply，改为：
 *   1. 生成 pending-<date>.review.md 待审清单（提案# / 目标 / 蒸馏框架一句话 / 价值分 / LLM conf / 来源）供终审。
 *   2. 仅 high-conf（LLM 四类分类 confidence >= nightlyAutoApplyConfidence(0.85)）自动 apply；
 *      其余滞留待审（不自动全审，防垃圾进长期记忆）。
 *   3. 24h 超时兜底：滞留超 staleHours 的硬 pass 高置信项仍只 apply conf>=0.85，其余继续等终审。
 *
 * 由 nightlyReview（selfevolve，夜间 cron）调用。
 * 【知安 C3】量纲：auto-apply 线用的是 LLM 四类 confidence(0.85)，不得与 valueScore(0.50) 混用。
 */
export async function applyPendingPromotions(rt: RuntimeContext): Promise<{ applied: number; skipped: number; reviewed: number }> {
  const propDir =
    (rt.cfg.selfEvolve.proposalDir || `${rt.workspaceDir}/.rules/memory-engine-proposals`) + "/promotion";
  const prom = rt.cfg.promotion;
  const files = (() => {
    try {
      return existsSync(propDir)
        ? readdirSync(propDir)
            .filter((f) => f.startsWith("pending-") && f.endsWith(".md") && !f.includes(".review."))
        : [];
    } catch {
      return [];
    }
  })();
  if (!files.length) return { applied: 0, skipped: 0, reviewed: 0 };

  let applied = 0;
  let skipped = 0;
  let reviewed = 0; // 进入待审清单的条数
  const reviewLines: string[] = [];

  for (const f of files.sort()) {
    const path = join(propDir, f);
    try {
      const body = readFileSync(path, "utf8");
      const entries = parsePendingEntries(body);
      for (const e of entries) {
        if (!e.narrative) {
          skipped++;
          continue;
        }
        const isUser = /USER/.test(e.target);
        const target = isUser ? userPath(rt.workspaceDir) : memoryPath(rt.workspaceDir);

        // 重算 LLM 四类 confidence（夜间 auto-apply 门控坐标；valueScore 已存于 e.score）
        let llmConf = 0;
        let llmCat: string | null = null;
        try {
          const v = await classifyFourCategory(rt, e.narrative, e.narrative.slice(0, 600));
          llmConf = v.confidence;
          llmCat = v.category;
        } catch {
          /* ignore */
        }

        const oneLine = e.narrative.replace(/\s+/g, " ").trim().slice(0, 80);
        reviewLines.push(
          `\n### 提案 ${reviewed + 1} · ${e.target} · score=${e.score?.toFixed(3) ?? "?"} · llm_conf=${llmConf.toFixed(2)}${llmCat ? `(${llmCat})` : ""}\n` +
          `- **目标**：${e.target}\n` +
          `- **来源**：${e.source}\n` +
          `- **价值分**：${e.score?.toFixed(3) ?? "?"}\n` +
          `- **框架一句话**：${oneLine}${e.narrative.length > 80 ? "…" : ""}\n`,
        );
        reviewed++;

        // 夜间 high-conf 自动 apply（LLM 分类 confidence 坐标，>=0.85）；否则滞留等终审。
        if (llmConf >= prom.nightlyAutoApplyConfidence) {
          const selfCheck = await selfAudit(rt, e.narrative);
          if (!selfCheck.consistent) {
            rt.log.warn(`[memory] pending needs_review: ${f}`);
            skipped++;
            continue;
          }
          const candidate: PromotionCandidate = { text: e.narrative, source: e.source, ts: new Date().toISOString() };
          const entry = buildEntry(candidate, e.narrative, true);
          const res = appendToFile(target, entry, "memory", "夜间高置信自动晋升", `apply: ${f}`, rt.cfg, rt.log);
          if (!res.ok) {
            skipped++;
            continue;
          }
          appendIndexEntry(
            indexPath(rt.workspaceDir),
            { ts: candidate.ts, module: "memory", kind: "promotion", target, summary: e.narrative.slice(0, 120), source: e.source },
            rt.cfg,
            rt.log,
          );
          rt.engineDb?.setPromoted(dedupKey(candidate), target);
          applied++;
          rt.log.info(`[memory] pending auto-applied (conf=${llmConf.toFixed(2)}): ${f}`);
        }
      }
    } catch (e) {
      rt.log.debug(`[memory] pending apply failed: ${f} ${String(e)}`);
      skipped++;
    }
  }

  // 生成待审清单（终审闸门）：无论是否有 high-conf，都产出 review.md 供人复审。
  if (reviewLines.length) {
    const reviewFile = join(propDir, `pending-${toISODate(Date.now())}.review.md`);
    const header =
      `# 记忆晋升·待审清单 · ${toISODate(Date.now())}\n\n` +
      `> 本清单由记忆引擎夜间汇总，供终审。\n` +
      `> high-conf(LLM 四类 confidence>=${prom.nightlyAutoApplyConfidence}) 已自动 apply；其余滞留待审。\n` +
      `> 驳回项请标注 rejected 或移入 applied/ 归档。\n` +
      `> 【量纲】score=六维 valueScore(门槛 ${prom.scoreThreshold})；llm_conf=LLM 四类分类置信度(自动 apply 线 ${prom.nightlyAutoApplyConfidence})。\n`;
    try {
      appendToFile(reviewFile, header + reviewLines.join(""), "memory", "生成待审清单", `review: ${reviewed} 条`, rt.cfg, rt.log);
    } catch (e) {
      rt.log.warn(`[memory] write review.md failed: ${String(e)}`);
    }
  }

  return { applied, skipped, reviewed };
}

/** 解析 pending 文件里的多个提案块（按 “---” 分隔 + “## 📝 晋升提案” 头）。 */
function parsePendingEntries(
  body: string,
): Array<{ target: string; source: string; score: number | null; narrative: string }> {
  const out: Array<{ target: string; source: string; score: number | null; narrative: string }> = [];
  const blocks = body.split(/\n---\n/);
  for (const block of blocks) {
    if (!block.includes("## 📝 晋升提案")) continue;
    const targetMatch = block.match(/\*\*目标\*\*(?:\s*[:：]\s*)?(USER\.MD|MEMORY\.MD|USER|MEMORY)/i);
    const sourceMatch = block.match(/\*\*来源\*\*\s*(.+)/);
    const scoreMatch = block.match(/\*\*价值分\*\*([\d.]+)/);
    const narrMatch = block.match(/\*\*蒸馏框架\*\*\n\n([\s\S]*?)$/);
    const narrative = narrMatch ? narrMatch[1].trim() : "";
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;
    out.push({
      target: targetMatch ? targetMatch[1].toUpperCase().includes("USER") ? "USER.md" : "MEMORY.md" : "MEMORY.md",
      source: sourceMatch ? sourceMatch[1].trim() : "",
      score: Number.isFinite(score) ? score : null,
      narrative,
    });
  }
  return out;
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
      resetDistillStreak();
      return buildNarrativeBlock(date, c.source, lines);
    }
    rt.log.warn(`[memory] distill output malformed for ${c.source}`);
  }

  // ——【脏数据防护】LLM 不可用/失败/malformed → 返回空串，不落盘、不降级塞原文 ——
  // 旧降级分支把裸对话原文截断塞进“关键节点”，污染长期记忆（脏数据）。
  // 改为：宁可漏（原文留在 lossless 无损层随时可召回），不制造语义垃圾。
  noteDistillUnavailable(rt);
  rt.log.warn(`[memory] distill unavailable; SKIP proposal (${c.source})`);
  return "";
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

// ────────────────────────────────────────────────────────────────────────────
//【晋升价值改造】价值判定 + 琐事过滤（lossless 四类：决策/结果/文件变更/任务状态）
// 参考 lossless-claw/src/summarize.ts LCM_SUMMARIZER_SYSTEM_PROMPT：
//   “Preserve only factual information: decisions, outcomes, file changes, and task state.”
// 判定原则：六维加权 + 硬门槛，不达标不落盘（不再“宁留勿剔”）；纯过程琐事明确剔除。
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
 * 【晋升价值改造】六维加权打分 + 硬门槛(2026-08-13 拍板)。
 *
 * 高投入（engagement）只给“候选资格”，valueScore 决定“过门资格”。
 * 流程：
 *   1. 强剔除例外（琐事词直接毙，不调 LLM，省 token、优先过滤）
 *   2. 六维加权算 valueScore（computeValueScore，含 LLM 四类判定）
 *   3. 硬门槛：valueScore >= scoreThreshold(0.50)，或命中"强放行例外"（明确里程碑）
 *   4. 达标 → worth=true；否则 worth=false（已废除旧"宁留勿剔低置信放行"分支）
 *
 * 返回值新增 score（六维 valueScore，0~1）供落盘/日志展示。
 * 【知安 C3 量纲约定】score = 六维 valueScore（此函数返回值/门槛坐标）；
 *   llmConfidence = LLM 四类分类置信度（强放行 0.80 / 夜间自动 apply 0.85 用另一坐标）。
 *   三者量纲不同，严禁混用同一变量。
 */
async function judgePromotionValue(
  rt: RuntimeContext,
  c: PromotionCandidate,
  narrative: string,
): Promise<{ worth: boolean; score: number; reason: string; boost: boolean }> {
  const windowCount = c.engagement?.timeWindowCount ?? 0;
  const crossWindow = windowCount >= MULTI_WINDOW_THRESHOLD;
  const prom = rt.cfg.promotion;

  // 1) 强剔除例外：明确琐事词 → 直接 worth=false，不调 LLM 打分（省 token、优先过滤）。
  if (prom.trivialFilter && TRIVIAL_SIGNAL_RE.test(narrative)) {
    return {
      worth: false,
      score: 0,
      reason: `琐事（${trivialFragment(narrative)}）`,
      boost: false,
    };
  }

  // 2) 六维加权打分（复用 LLM 四类判定 + 本地信号，全降级不阻塞）。
  const { score, llmConfidence, llmCategory } = await computeValueScore(rt, c, narrative);

  // 3) 强放行例外（明确里程碑，不凑分）：
  //    - strongRelease：LLM 四类命中且 confidence >= strongReleaseConfidence(0.80)；
  //    - crossWindowRelease：跨多时段(>=3) 且命中任一四类信号（跨多天重点项目）。
  const strongRelease = llmCategory !== null && llmConfidence >= prom.strongReleaseConfidence;
  const crossWindowRelease = windowCount >= 3 && llmCategory !== null;
  const isMilestone = strongRelease || crossWindowRelease;

  // 4) 硬门槛：score >= scoreThreshold 或 强放行例外 → worth=true。
  const pass = score >= prom.scoreThreshold || isMilestone;

  if (!pass) {
    return {
      worth: false,
      score,
      reason: `低于门槛(${score.toFixed(3)}<${prom.scoreThreshold})` +
        (llmCategory ? `，LLM=${llmCategory}(conf=${llmConfidence.toFixed(2)}，判琐事/无长期价值)` : "，无四类信号"),
      boost: crossWindow,
    };
  }

  if (isMilestone && score < prom.scoreThreshold) {
    return {
      worth: true,
      score,
      reason: strongRelease
        ? `强放行例外(四类=${llmCategory}, conf=${llmConfidence.toFixed(2)}>=${prom.strongReleaseConfidence})`
        : `强放行例外(跨${windowCount}时段+四类=${llmCategory})`,
      boost: crossWindow,
    };
  }

  return {
    worth: true,
    score,
    reason: `六维达标(${score.toFixed(3)}>=${prom.scoreThreshold})` +
      (llmCategory ? `+四类(${llmCategory},conf=${llmConfidence.toFixed(2)})` : "") +
      (crossWindow ? "+跨多时段" : ""),
    boost: crossWindow,
  };
}

/**
 * 六维加权打分核心（纯本地 + 复用 LLM 四类判定）。
 * 权重（书微方案，合计 1.00，拍板）：
 *   relevance 0.30 / consolidation 0.24 / recency 0.15 / frequency 0.14 /
 *   queryDiversity 0.10 / richness 0.07
 * LLM 不可用时不阻塞：relevance/consolidation 降级用信号词与去重；其余维度纯本地。
 */
async function computeValueScore(
  rt: RuntimeContext,
  c: PromotionCandidate,
  narrative: string,
): Promise<{ score: number; llmConfidence: number; llmCategory: string | null }> {
  const w = rt.cfg.promotion.weights;
  const windowCount = c.engagement?.timeWindowCount ?? 0;

  // —— LLM 四类判定（relevance 信号的核心来源；降级为 null 不阻塞打分）——
  let llmCategory: string | null = null;
  let llmConfidence = 0;
  try {
    const verdict = await classifyFourCategory(rt, narrative, c.text);
    llmCategory = verdict.category;
    llmConfidence = verdict.confidence;
  } catch {
    // LLM 不可用 → 降级，relevance 只靠信号词
  }

  // 1) relevance 0.30：是否命中四类事实（LLM 四类 或 信号词 或 🎉）
  const signalRelease = VALUE_SIGNAL_RELEASE_RE.test(narrative);
  const signalWork = VALUE_SIGNAL_WORK_RE.test(narrative);
  const celebrates = narrative.includes(CELEBRATION_MARKER);
  let relevance = 0;
  if (llmCategory && llmCategory !== "task_state") relevance = 1;
  else if (llmCategory === "task_state") relevance = 0.7; // 任务状态弱于"决策/结果/文件变更"
  else if (signalRelease) relevance = 0.75;
  else if (signalWork) relevance = 0.55;
  else if (celebrates) relevance = 0.5;

  // 2) consolidation 0.24：唯一/去重价值（dedup 已存在 → 低；否则按触达次数反比）
  //    同 topic 未 apply 前已提案过多 → 去重价值低（防逐轮洪水）。
  const deduped = isPromotionDeduped(rt, c);
  const pendingCount = countPendingForTopic(rt, c.source);
  let consolidation = 1;
  if (deduped) consolidation = 0;
  else if (pendingCount >= 1) consolidation = 0.15;
  else if (windowCount >= MULTI_WINDOW_THRESHOLD) consolidation = 0.9; // 跨多时段唯一话题反而更值得记

  // 3) recency 0.15：距 now 越近越新；超 24h 旧账递减。
  const ageHours = Math.max(0, (Date.now() - new Date(c.ts).getTime()) / (60 * 60 * 1000));
  const recency = Math.max(0, 1 - ageHours / RECENCY_HALF_HOURS);

  // 4) frequency（投入度热点）0.14：turn/window/token 归一化取 max（任一达标即高投入）。
  const turnRatio = Math.min(1, (c.engagement?.turnCount ?? 0) / ENGAGE_TURNS_CAP);
  const windowRatio = Math.min(1, windowCount / ENGAGE_WINDOWS_CAP);
  const tokenRatio = Math.min(1, (c.engagement?.tokenCount ?? 0) / ENGAGE_TOKENS_CAP);
  const frequency = Math.max(turnRatio, windowRatio, tokenRatio);

  // 5) queryDiversity（话题延续）0.10：来源/原文反解语义段号 s<segNo>，段号越高越跨话题持续。
  const segNo = parseSegNo(c.source) ?? parseSegNo(c.text) ?? 1;
  const queryDiversity = Math.min(1, segNo / 10);

  // 6) richness（概念富度）0.07：叙事长度 + 含数字/人名/时间。
  const hasNumber = /\d/.test(narrative);
  const hasName = /[A-Za-z\u4e00-\u9fa5]{2,}(?:项目|模块|平台|功能|方案|系统)/.test(narrative) || /(?:用户|主人|殿下|老板|人类用户)/.test(narrative);
  const lengthScore = Math.min(1, narrative.length / 400);
  const richness = (hasNumber ? 0.4 : 0) + (hasName ? 0.3 : 0) + lengthScore * 0.3;

  const score =
    relevance * w.relevance +
    consolidation * w.consolidation +
    recency * w.recency +
    frequency * w.frequency +
    queryDiversity * w.queryDiversity +
    richness * w.richness;

  return {
    score: Math.min(1, Math.max(0, score)),
    llmConfidence,
    llmCategory,
  };
}

/** 从 source 或 text 反解语义段号 s<segNo>（话题延续维度数据来源，二审补充正则）。 */
function parseSegNo(input: string): number | null {
  const m = input.match(SEG_NO_RE);
  if (m) {
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 统计同 topic（语义段）在当日 pending 缓冲里已有的提案条数（提案节流用）。 */
function countPendingForTopic(rt: RuntimeContext, source: string): number {
  const propDir =
    (rt.cfg.selfEvolve.proposalDir || `${rt.workspaceDir}/.rules/memory-engine-proposals`) + "/promotion";
  const file = join(propDir, `pending-${toISODate(Date.now())}.md`);
  try {
    if (!existsSync(file)) return 0;
    const body = readFileSync(file, "utf8");
    const src = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\*\\*来源\\*\\*${src}`, "g");
    return (body.match(re) || []).length;
  } catch {
    return 0;
  }
}

/**
 * 提案节流：同 topic 未 apply 前最多 funnelMaxPerTopic(默认1) 条 pending。
 * 已存在则合并更新（converge）而非追加（append），从源头压掉 58 条里的逐轮重复。
 * 返回 true = 已合并（调用方跳过后续落盘）；false = 无冲突，可正常新增。
 */
async function proposalConverge(
  rt: RuntimeContext,
  c: PromotionCandidate,
  propFile: string,
  narrative: string,
  value: { score: number; reason: string },
): Promise<boolean> {
  const max = rt.cfg.promotion.funnelMaxPerTopic;
  const count = countPendingForTopic(rt, c.source);
  if (count < max) return false;
  // 已达上限：同 topic 不再新增，仅日志合并提示（不重复写盘，保留最早一条）。
  rt.log.info(
    `[memory] proposal converged (topic already pending ${count}/${max}): ${c.source}, skip dup (score=${value.score.toFixed(3)})`,
  );
  return true;
}

/** 从叙事里截取触发“琐事判定”的一小段，供日志可读。 */
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

/** 按定稿的叙事框架模板排版落盘条目。 */
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

/** 自审：保证写入内容与真实认知一致（8/10 明确要求）。 */
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

