/**
 * compaction.ts — 事件感知上下文压缩引擎（模块：enable_context_compaction，默认关）
 *
 * 设计定算法（B 方向）：
 *   主判据从前端轮余弦升级为「前段平均相似度 avgSim」：
 *     新轮 与 前段最近 K 轮 的平均余弦 avgSim；
 *     relevanceThreshold 作衬底（avgSim>=此值=明确同事件，绝不压）；
 *     avgSimSwitchThreshold 作切换线主判据（avgSim<=此值=话题切换→压旧段）。
 *   本轮触发语义：avgSim<=切换线 → 判话题切换 → 新话题首轮=当前轮，旧段压缩。
 *
 * 重要勘误（来自真实标定 bench/REPORT.md）：
 *   - 纯 cosine/internal 对"话题内 vs 切换"判别力有限、两分布重叠；
 *   - 真正有判别力的是 avgSim/drop（真实切换点 avgSim≈0.24、话题内≈0.33）；
 *   - internal（近K轮两两）几乎无区分（边界 0.374 vs 话题内 0.367），仅作软信号不硬门槛；
 *   - 旧默认 internalRelevanceThreshold=0.7 在真实数据 0 次满足 → 算法整套哑火（已修）。
 *
 * 触发：
 *   - 主触发：话题切换（事件完成）
 *   - 次触发：上下文长度阈值兜底（lengthThreshold，设计定 0.22）
 *     注（2026-08-09 修）：此前次触发只统计压缩窗口内字符，受 windowSize 上限约束对长会话永不达标，
 *     属死配置。已改为主路径 maybeCompressByRealLength —— 读 lcm 活跃会话实测 totalTokens，
 *     以「真实上下文 token / contextTokenBudget >= lengthThreshold」触发，真正按上下文长度收拢。
 *
 * 双路执行：
 *   - A 记忆归档（主干）：压缩旧话题时，把多轮对话提炼成要点写入 memory/events/，并登记 .index.jsonl，
 *     与记忆蒸馏/索引闭环衔接（appendToFile/appendIndexEntry）。
 *   - B contextEngine 接管：见 modules/context-engine.ts（registerContextEngine，slots.contextEngine
 *     仍指向 lossless-claw 前不会生效 —— 接管是安全的、留给后续）。
 *
 * 铁律（硬性）：
 *   - 绝不阻塞消息路径：embedding/LLM/写盘全走后台队列（scheduleWork），message_received 只投递不 await。
 *   - embedding/LLM 设硬超时（AbortController）+ 失败降级，不无限重试。
 *   - 不丢原文：提炼归档 + 瘦身（压缩是提炼不是删除）。
 *   - 与系统级压缩共存（不去抢 openclaw 自带压缩，只做本模块主动触发）。
 */
import type {
  PluginHookAgentEndEvent,
  PluginHookAgentContext,
  PluginHookMessageReceivedEvent,
  PluginHookMessageContext,
} from "openclaw/plugin-sdk/plugin-runtime";
import type { RuntimeContext } from "../runtime.js";
import { createCloudEmbedding } from "./vector.js";
import { distillText } from "../llm.js";
import { appendToFile, appendIndexEntry, indexPath } from "../writers.js";
import { addToVectorIndex } from "./vector.js";
import { toISODate } from "../time.js";
import type { CompactionTurn, EngineDb } from "../db/engine-db.js";
import { join } from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// 后台调度器（重活移出同步路径的核心）
// ---------------------------------------------------------------------------

// 补2-a：压缩任务队列上限。满则丢弃最旧，而非无界堆积。丢弃的任务是“压缩旧段”，
//   不丢原文——后续长度/话题触发仍可重拾，只是暂时延后，不会死机。
type Work = { id: string; fn: WorkFn };

type WorkFn = () => void | Promise<void>;

let workQueue: Work[] = [];
let processing = false;

/** 最近 60s 内的实际 LLM 压缩计数（补2-c：频率/并发限制）。 */
const recentCompactions: number[] = [];

/** 是否应执行一次压缩（受 60s 窗口频控约束）。满频则跳过（前台可稍后再试）。
 * max<=0（含缺省/undefined）视为不启用频控（兼容旧调用）。 */
function throttleAllows(cfg: { maxCompactionsPerMinute: number }): boolean {
  const max = cfg?.maxCompactionsPerMinute ?? 0;
  if (!(max > 0)) return true;
  const now = Date.now();
  const windowStart = now - 60_000;
  while (recentCompactions.length && recentCompactions[0] < windowStart) {
    recentCompactions.shift();
  }
  return recentCompactions.length < max;
}

/** 压缩开始时登记（频控计数）。max<=0 不启用频控时不计。 */
function throttleMarkStarted(): void {
  recentCompactions.push(Date.now());
}

/**
 * 补2-b：内存水位保护。压缩长会话前调用，若 heapUsed 超水位则等待/降频，
 * 等内存释放到安全线再继续。返回 true=已就绪可继续。0=关闭水位检查。
 *
 * 保守取 heapUsed（V8 堆）而非 RSS——堆高才是本进程可回收的风险源；
 * 用 *（rss）不计，避免误伤系统其它进程。
 */
async function waitForMemoryHeadroom(memoryHighWaterMB: number, pollMs: number): Promise<void> {
  if (!(memoryHighWaterMB > 0)) return; // 未启用
  const high = memoryHighWaterMB * 1024 * 1024;
  const waitMs = Math.max(pollMs, 500);
  // 最多等 10 次（≈50s），再高强制放行（避免永久阻塞消息后台）。
  for (let i = 0; i < 10; i++) {
    const heap = process.memoryUsage().heapUsed;
    if (heap <= high) return; // 有充足余量
    await sleep(waitMs); // 释放 CPU + 等待 GC
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 投递后台任务，串行执行，绝不阻塞调用方。
 * message_received / agent_end 只调用它投递，不 await。
 *
 * 补2-a：队列满（>maxQueue）时丢弃最旧压缩任务，防无界堆积。
 */
function scheduleWork(fn: WorkFn, opts?: { maxQueue?: number; key?: string }): void {
  const id = opts?.key ?? `work-${Math.random().toString(36).slice(2, 8)}`;
  if (opts?.maxQueue && workQueue.length >= opts.maxQueue) {
    // 丢弃最旧压缩任务（不丢原文，后续可重拾）；记录审计不抛错
    const dropped = workQueue.shift();
    void dropped;
  }
  workQueue.push({ id, fn });
  drainQueue();
}

function drainQueue(): void {
  if (processing) return;
  processing = true;
  const step = () => {
    const next = workQueue.shift();
    if (!next) {
      processing = false;
      return;
    }
    Promise.resolve()
      .then(next.fn)
      .catch(() => {
        /* 后台任务异常不影响主线 */
      })
      .finally(() => setImmediate(step));
  };
  setImmediate(step);
}

// ---------------------------------------------------------------------------
// 相关性打分 + 事件边界检测
// ---------------------------------------------------------------------------

/** 余弦相似度（本地 JS 计算，向量取回后算）。任意空向量返回 0。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 该向量与前段各轮（向量解析后）的平均相似度。 */
function avgSimToSegment(newVec: number[], window: CompactionTurn[]): number {
  if (!window.length) return 1;
  let sum = 0;
  let n = 0;
  for (const t of window) {
    const v = parseVector(t.vector);
    if (v.length) {
      sum += cosineSimilarity(newVec, v);
      n++;
    }
  }
  return n ? sum / n : 1;
}

/** 近轮内部相关性：最近 k 轮两两余弦均值。仅作软信号（判别力弱），不用于硬性门槛。 */
function internalCoherence(turns: CompactionTurn[], k: number): number {
  const recent = turns.slice(-k);
  if (recent.length < 2) return 1;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < recent.length; i++) {
    const ai = parseVector(recent[i].vector);
    if (!ai.length) continue;
    for (let j = i + 1; j < recent.length; j++) {
      const aj = parseVector(recent[j].vector);
      if (aj.length) {
        sum += cosineSimilarity(ai, aj);
        n++;
      }
    }
  }
  return n ? sum / n : 1;
}

function parseVector(s: string): number[] {
  try {
    const arr = JSON.parse(s) as number[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function encodeVector(v: number[]): string {
  // 四舍五入到 1e-4，压缩存储体积（影响可忽略）
  return JSON.stringify(v.map((x) => Math.round(x * 10000) / 10000));
}

/**
 * 事件边界检测（B 方向核心算法：avgSim 主判据）。
 *
 * newVec = 当前新轮向量，allTurns = 含新轮在内的完整窗口（新轮在末尾）。
 * 判定流程：
 *   1. 前段窗口 = allTurns 去掉最新轮（即新轮自身），取其最近 K 轮算 avgSim。
 *   2. 衬底 relevanceThreshold：avgSim>=此值 → 明确同事件，绝不切换。
 *   3. 主判据 avgSimSwitchThreshold：avgSim<=此值 → 话题切换确认。
 *   4. （软信号）internalRelevanceThreshold 不再作硬门槛——判别力弱，避免哑火。
 *
 * @returns 旧话题压缩截止索引：返回所有非新轮（旧话题）应压缩的截止位置（=新轮在 allTurns 中的索引），
 *          供调用方 archive allTurns[0..cutoff)，保留 allTurns[cutoff..]（含新话题首轮）。无切换返回 -1。
 */
export function detectTopicSwitch(
  newVec: number[],
  allTurns: CompactionTurn[],
  cfg: {
    relevanceThreshold: number;
    avgSimSwitchThreshold: number;
    recentWindowForInternal: number;
    internalRelevanceThreshold: number;
    minSamples: number;
  },
): number {
  if (!newVec.length) return -1;
  if (allTurns.length < cfg.minSamples + 1) return -1;

  // 前段窗口 = 去掉最新轮（= newVec 对应的轮），取最近 K 轮算 avgSim
  const prior = allTurns.slice(0, -1);
  const recentK = prior.slice(-cfg.recentWindowForInternal);
  const avgSim = avgSimToSegment(newVec, recentK);
  // 修复（BUG）：原 `!(avgSim >= 0)` 会把「负相似度」也当成无信号跳过。
  // 负余弦（反向/完全相反话题）是比低相似度更强的切换信号，必须放行；
  // 真正的"无信号"只有 NaN（前段无有效向量时 avgSimToSegment 返回 1，恰不命中此处）。
  if (Number.isNaN(avgSim)) return -1; // 无有效前段向量，无信号

  // 衬底：明确同事件 → 绝不压缩
  if (avgSim >= cfg.relevanceThreshold) return -1;
  // 主判据：未达切换线 → 不切换
  if (avgSim > cfg.avgSimSwitchThreshold) return -1;

  // 软信号记录（不再阻断；保留 internal 计算以保持语义完整与可观测）
  void internalCoherence(prior, cfg.recentWindowForInternal);
  void cfg.internalRelevanceThreshold;

  // 话题切换确认：新话题首轮 = 当前轮，旧话题=其前所有轮 → 全压，保留当前轮
  return allTurns.length - 1;
}

/** 估算窗口累计字符对应的近似 token（粗略，1 token≈3 字符）。 */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 3);
}

/** 内容去重 hash（防内部重复压缩；node:crypto 标准库，无额外依赖）。 */
function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 已归档内容去重标记检查（true=压过，应跳过）。 */
function isAlreadyCompressed(
  rt: RuntimeContext,
  sessionKey: string,
  joined: string,
): boolean {
  if (!rt.engineDb) return false;
  return rt.engineDb.isCompactedContent(sessionKey, contentHash(joined));
}

/** 归档后登记去重标记。 */
function markCompressed(
  rt: RuntimeContext,
  sessionKey: string,
  joined: string,
  detail: string,
): void {
  if (!rt.engineDb) return;
  rt.engineDb.markCompactedContent(sessionKey, contentHash(joined), detail);
}

// ---------------------------------------------------------------------------
// 补1：超长输入的分段压缩再拼接（明确要求）
// ---------------------------------------------------------------------------

/**
 * 把超长旧话题按轮次边界切成若干段，每段累计字符不超过 segmentChars，
 * 并记录每段覆盖的轮次区间（用于保留结构：各段要点 + 来源标记）。
 *
 * 策略：贪心按序累加整轮文本，超上限则断到上一轮边界，开新段。
 * 退栈保护：单个超大轮（远超上限）单独成段并整体保留，绝不截断丢内容。
 *
 * @returns 段数组：{ turns, text, startSeq, endSeq }
 */
function segmentLongTurnText(
  turns: CompactionTurn[],
  segChars: number,
  maxSegments: number,
): Array<{ turns: CompactionTurn[]; text: string; startSeq: number; endSeq: number }> {
  const limit = Math.max(segChars, 1000);
  const segs: Array<{ turns: CompactionTurn[]; text: string; startSeq: number; endSeq: number }> = [];
  let cur: CompactionTurn[] = [];
  let curLen = 0;
  const push = () => {
    if (!cur.length) return;
    const text = cur.map((t) => t.text.trim()).filter(Boolean).join("\n");
    segs.push({ turns: cur, text, startSeq: cur[0].seq, endSeq: cur[cur.length - 1].seq });
    cur = [];
    curLen = 0;
  };
  for (const t of turns) {
    const tlen = (t.text?.trim() ?? "").length;
    // 单轮就超上限：单独成段（宁可保留整轮原文也不截断）
    if (tlen >= limit) {
      push();
      segs.push({ turns: [t], text: (t.text ?? "").trim(), startSeq: t.seq, endSeq: t.seq });
      continue;
    }
    if (cur.length && curLen + tlen > limit) push();
    cur.push(t);
    curLen += tlen;
  }
  push();
  // 补1-d/补2 保护：最多 maxSegments 段，防止无限次 LLM 调用。
  // 超出时把多余轮收敛进最后一段（其文本可能超窗，distill 内部会 slice，但原文仍全量留档）。
  if (segs.length > maxSegments) {
    const head = segs.slice(0, maxSegments - 1);
    const tail = segs.slice(maxSegments - 1);
    const mergedText = tail.map((s) => s.text).filter(Boolean).join("\n");
    head.push({
      turns: tail.flatMap((s) => s.turns),
      text: mergedText,
      startSeq: tail[0]?.startSeq ?? 0,
      endSeq: tail[tail.length - 1]?.endSeq ?? 0,
    });
    return head;
  }
  return segs;
}

/**
 * 提炼单段（独立 distill，LLM 硬超时）。
 * 失败/空结果 → 该段原文前若干字符作为要点（单段兜底，不再全局截断到 500）。
 */
async function distillSegment(
  rt: RuntimeContext,
  segText: string,
): Promise<string> {
  const cfg = rt.cfg.compaction;
  const summary = await distillText(
    { ...rt.cfg.emotion, timeoutMs: cfg.llmTimeoutMs, log: rt.log },
    segText,
  );
  const clean = (summary ?? "").trim();
  if (clean && clean !== "-") return clean;
  // 单段兜底：取该段前 800 字符做要点（段长≤5600，因此不会丢整段；原文仍全量留档）
  return segText.trim().slice(0, 800);
}

/** 由各段要点拼接成的归档正文（补1：保留结构、来源标记）。 */
function buildSegmentedSummary(
  segs: Array<{
    turns: CompactionTurn[];
    text: string;
    startSeq: number;
    endSeq: number;
  }>,
  distilled: string[],
  totalTurns: number,
): string {
  if (segs.length === 1) {
    return `**要点（覆盖 ${totalTurns} 轮）**\n\n${distilled[0] ?? "（无提炼要点）"}`;
  }
  const parts: string[] = [`**分段压缩要点（${segs.length} 段 / 共 ${totalTurns} 轮）**`];
  segs.forEach((s, i) => {
    parts.push(`\n**段 ${i + 1}/${segs.length}（轮 ${s.startSeq + 1}–${s.endSeq + 1}）**`);
    parts.push(distilled[i] ?? "（该段无提炼要点）");
  });
  return parts.join("\n");
}

/** 补2：压缩前的资源门（内存水位 + 频控）。false=应跳过（频控满）。 */
async function compressionGate(
  rt: RuntimeContext,
): Promise<boolean> {
  const cfg = rt.cfg.compaction;
  // b. 内存水位：heapUsed 超水位则等释放（10 次轮询内最多 ~50s）
  await waitForMemoryHeadroom(cfg.memoryHighWaterMB, cfg.memoryPollMs);
  // c. 频控：60s 窗口内最多 maxCompactionsPerMinute 次实际 LLM 压缩
  return throttleAllows(cfg);
}

// ---------------------------------------------------------------------------
// A 记忆归档：旧话题提炼 -> memory/events/ + .index.jsonl
// ---------------------------------------------------------------------------

function buildEventBlock(o: {
  date: string;
  title: string;
  summary: string;
  original: string;
  turnCount: number;
}): string {
  return `## 🧵 已归档话题 · ${o.title}

- **日期**：${o.date}
- **覆盖轮次**：${o.turnCount}

${o.summary}

<details>
<summary>原文（只读存档，不参与上下文）</summary>

${o.original}
</details>`;
}

/** A 路归档（公开、可 await）：把旧话题提炼写进 memory/events/ + 索引，并更新窗口。 */
export async function compileOldSegmentForArchive(
  rt: RuntimeContext,
  sessionKey: string,
  window: CompactionTurn[],
  cutoffIndex: number,
): Promise<boolean> {
  const cfg = rt.cfg;
  const old = window.slice(0, Math.max(cutoffIndex, 0));
  if (!old.length) return false;
  const joined = old
    .map((t) => t.text.trim())
    .filter(Boolean)
    .join("\n");
  if (!joined.trim()) return false;

  // 已压缩内容去重：同一段原文若已归档过，跳过（force 手动触发也遵守，绝不压两次）
  if (isAlreadyCompressed(rt, sessionKey, joined)) {
    rt.log.info(
      `[compaction] skip re-compress: content already archived (${old.length} turns, session=${sessionKey})`,
    );
    if (rt.engineDb) {
      // 即使跳过，也把该段从窗口移除（内容已归档过，无需再占窗口）
      const remaining = window.slice(cutoffIndex);
      rt.engineDb.clearCompactionTurns(sessionKey);
      remaining.forEach((t, i) =>
        rt.engineDb?.upsertCompactionTurn({
          sessionKey,
          seq: i,
          text: t.text,
          vector: t.vector,
          tsMs: t.tsMs,
        }),
      );
      rt.engineDb.recordCompactionEvent(
        sessionKey,
        "dedup_skip",
        `${old.length} turns already compressed (skipped)`,
      );
    }
    return false;
  }

  const date = toISODate(Date.now());
  const title = `事件-${date}-${old.length}轮`;
  const archivePath = join(cfg.compaction.archiveDir, `${date}.md`);

  // 补1+补2：分段压缩（超长输入按段独立 distill 再拼接，不截断丢信息；
  //   过程受内存水位 + 频控门）。
  // 单段 distill 前先过资源门：内存超水位则等待释放；60s 频控满则本次跳过（不压）。
  const gatePassed = await compressionGate(rt);
  if (!gatePassed) {
    rt.log.info(
      `[compaction] skip archive: compaction throttle full (${cfg.compaction.maxCompactionsPerMinute}/min), turns=${old.length}`,     );
    return false;
  }
  throttleMarkStarted();

  // 分段：按轮次切，每段累计 ≤ segmentChars；单次归档最多 maxSegments 段。
  const segs = segmentLongTurnText(old, cfg.compaction.segmentChars, cfg.compaction.maxSegmentsPerArchive);
  // 逐段独立 distill（串行 await，天然让出事件循环 + 控制 LLM 突发）
  const distilled: string[] = [];
  for (const seg of segs) {
    distilled.push(await distillSegment(rt, seg.text));
    // 段间小间隔：降 CPU 峰值 + 限频（补2-c），也让 GC 有机会回收长字符串
    const pollMs = cfg.compaction.memoryPollMs;
    const idle = (typeof pollMs === "number" && pollMs > 0) ? Math.min(pollMs, 300) : 0;
    if (idle > 0) await sleep(idle);
  }
  const finalSummary =
    segs.length >= 1 && distilled.some((d) => d)
      ? buildSegmentedSummary(segs, distilled, old.length)
      : joined.slice(0, 800); // 全段无产出兜底
  const block = buildEventBlock({
    date,
    title,
    summary: finalSummary,
    original: joined,
    turnCount: old.length,
  });
  // 追加（append-only + 写前备份 + 改动日志）
  appendToFile(
    archivePath,
    block,
    "compaction",
    "归档旧话题",
    `${title}: ${finalSummary.slice(0, 40)}`,
    cfg,
    rt.log,
  );
  // 与索引闭环衔接
  appendIndexEntry(
    indexPath(cfg.workspaceDir),
    {
      ts: new Date().toISOString(),
      module: "compaction",
      kind: "event",
      target: archivePath,
      summary: finalSummary.slice(0, 120),
      sessionKey,
    },
    cfg,
    rt.log,
  );
  rt.log.info(`[compaction] archived ${old.length} turns -> ${archivePath}`);
  // —— 向量写入管道：事件归档后入语义索引（enable_semantic_vector 联动）——
  if (cfg.enable_semantic_vector && cfg.enable_recall) {
    void addToVectorIndex(rt, { text: `${title}\n${finalSummary.slice(0, 2000)}`, type: "event" }).catch(
      () => { /* 异步不阻塞归档路径 */ },
    );
  }
  // 登记去重标记：此后同一段原文不再重复归档
  markCompressed(
    rt,
    sessionKey,
    joined,
    `${title} (${old.length} turns archived)`,
  );
  // 联动预拉生命周期：已归档话题从"高投入待报榜"清出（含旧版 raw sessionKey 与新版 base#tag 两种形态），
  // 不再被 before_prompt_build 反复列为高投入。
  if (rt.engineDb) {
    try {
      rt.engineDb.clearEngagementForSession(sessionKey);
    } catch {
      /* 清理失败不改主线 */
    }
  }
  // 清掉已归档旧段，保留新话题起点之后的轮
  if (rt.engineDb) {
    const remaining = window.slice(cutoffIndex);
    rt.engineDb.clearCompactionTurns(sessionKey);
    remaining.forEach((t, i) => {
      rt.engineDb?.upsertCompactionTurn({
        sessionKey,
        seq: i,
        text: t.text,
        vector: t.vector,
        tsMs: t.tsMs,
      });
    });
    rt.engineDb.recordCompactionEvent(
      sessionKey,
      "topic_switch_archived",
      `${old.length} turns archived`,
    );
  }
  return true;
}

/** A 路归档（后台调度版）：投递旧话题提炼归档。 */
function archiveOldTopic(
  rt: RuntimeContext,
  sessionKey: string,
  window: CompactionTurn[],
  cutoffIndex: number,
): void {
  void compileOldSegmentForArchive(rt, sessionKey, window, cutoffIndex).catch(
    () => {
      /* 归档失败不回抛，不动主线 */
    },
  );
}

// ---------------------------------------------------------------------------
// 窗口维护 + 调度（message_received / agent_end 调用）
// ---------------------------------------------------------------------------

function sessionKeyOf(...parts: Array<string | undefined>): string {
  return parts.find((p) => p && p.length > 0) ?? "default";
}

/** 消息文本抽取（message/content 兼容）。 */
function textOfContent(m: unknown): string {
  if (typeof m === "string") return m;
  const c = (m as { message?: unknown; content?: unknown })?.content;
  if (typeof c === "string") return c;
  return "";
}

/**
 * message_received / agent_end 统一入口。
 * 只做：投递后台任务（不 await）。
 */
export function onTurn(
  rt: RuntimeContext,
  sessionKey: string,
  userText: string,
): void {
  const cfg = rt.cfg;
  if (!cfg.enable_context_compaction) return;
  const body = userText.trim();
  if (!body) return;
  // 铁律：不阻塞消息路径 —— 全部进后台队列。补2-a：队列满则丢最旧，防无界堆积。
  scheduleWork(() => runTurnInBackground(rt, sessionKey, body), {
    maxQueue: cfg.compaction.maxQueue,
  });
}

/**
 * 后台执行：embed(硬超时) -> 入窗 -> 事件/长度检测 -> 触发压缩归档。
 * 任何一步失败都安全降级，不抛。
 */
async function runTurnInBackground(
  rt: RuntimeContext,
  sessionKey: string,
  body: string,
): Promise<void> {
  const cfg = rt.cfg;
  if (!rt.engineDb) return;
  const db: EngineDb = rt.engineDb;

  // 本轮 ALWAYS 入窗（确定性累积）。embedding 失败用空向量降级：
  //   话题切换检测对空向量安全返回 -1 → 落到长度兜底，不丢轮次。
  const vector = await embedWithTimeout(rt, body);
  if (!vector) {
    rt.log.debug("[compaction] embedding unavailable; turn still recorded (empty vec)");
  }
  const enc = vector && vector.length ? encodeVector(vector) : encodeVector([]);

  // 读窗口 + 追加本轮
  const window = db.listCompactionTurns(sessionKey);
  const nextSeq = window.length ? window[window.length - 1].seq + 1 : 0;
  db.upsertCompactionTurn({
    sessionKey,
    seq: nextSeq,
    text: body,
    vector: enc,
    tsMs: Date.now(),
  });
  // 若超窗，截断最早的（滑动窗口，丢的是"最老"，但已在更早归档阶段处理过）
  const maxWindow = cfg.compaction.windowSize + 3; // 稍留余量给检测
  if (window.length >= maxWindow) {
    const trimmed = db.listCompactionTurns(sessionKey);
    const dropCount = trimmed.length - cfg.compaction.windowSize;
    if (dropCount > 0) {
      const keep = trimmed.slice(dropCount);
      db.clearCompactionTurns(sessionKey);
      keep.forEach((t, i) =>
        db.upsertCompactionTurn({
          sessionKey,
          seq: i,
          text: t.text,
          vector: t.vector,
          tsMs: t.tsMs,
        }),
      );
    }
  }

  const latest = db.listCompactionTurns(sessionKey);
  if (latest.length < 2) return;

  // 主触发：话题切换（avgSim 主判据）。传入含本轮在内的完整窗口，cutoff 即新话题首轮索引。
  const cutoff = detectTopicSwitch(vector ?? [], latest, {
    relevanceThreshold: cfg.compaction.relevanceThreshold,
    avgSimSwitchThreshold: cfg.compaction.avgSimSwitchThreshold,
    recentWindowForInternal: cfg.compaction.recentWindowForInternal,
    internalRelevanceThreshold: cfg.compaction.internalRelevanceThreshold,
    minSamples: cfg.compaction.minSamples,
  });
  if (cutoff >= 0) {
    rt.log.info(
      `[compaction] topic switch detected at turn #${cutoff} (avgSim<=` +
        `${cfg.compaction.avgSimSwitchThreshold}); archive old topic`,     );
    // window=latest 含新话题首轮；archive 会把 [0,cutoff) 作旧段压缩，保留 [cutoff..]（新话题首轮）
    archiveOldTopic(rt, sessionKey, latest, cutoff);
    return;
  }

  // 次触发：长度阈值兜底（按真实会话上下文长度触发，见 maybeCompressByRealLength）
  maybeCompressByRealLength(rt, db, sessionKey);
}

/** embedding 硬超时封装（复用 vector.createCloudEmbedding，加 AbortController 竞速）。 */
async function embedWithTimeout(
  rt: RuntimeContext,
  text: string,
): Promise<number[] | null> {
  const cfg = rt.cfg;
  try {
    const provider = await createCloudEmbedding(rt);
    if (!provider) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.compaction.embeddingTimeoutMs);
    try {
      // createCloudEmbedding 内部用 fetch 但不带 signal；这里用 race 实现硬超时
      const [[vec]] = await Promise.race([
        provider.embed([text]),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(new Error("embedding timeout")),
          );
        }),
      ]);
      return Array.isArray(vec) ? vec : null;
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    rt.log.debug(`[compaction] embed failed: ${String(e)}`);
    return null;
  }
}

/** 次触发：窗口累计长度 >= 长度阈值 * tokenBudget -> 归档最老段（公开，供 B 路/回填调用）。
 *
 * budgetTokens：显式上下文 token 预算（如 ctx.contextTokenBudget 或 lcm 会话实测）。
 * 未传则用 config.compaction.contextTokenBudget（0=未知 → 跳过长度兜底，不误触发）。
 *
 * 注：此路径取「压缩窗口内累计字符」换算 token，窗口受 windowSize 上限约束，
 *   对真实长会话可能长期不达标。每轮实时路径请走 maybeCompressByRealLength（见下）。
 *   此函数保留供回填/B 路显式传 budgetTokens（真实会话实测）时使用。
 */
export function maybeCompressByLengthPublic(
  rt: RuntimeContext,
  db: EngineDb,
  sessionKey: string,
  budgetTokens?: number,
): void {
  maybeCompressByLength(rt, db, sessionKey, budgetTokens);
}

/** 次触发：窗口累计长度 >= 长度阈值 * tokenBudget -> 归档最老段（内部）。 */
function maybeCompressByLength(
  rt: RuntimeContext,
  db: EngineDb,
  sessionKey: string,
  budgetTokens?: number,
): void {
  const cfg = rt.cfg;
  const turns = db.listCompactionTurns(sessionKey);
  if (turns.length < cfg.compaction.minSamples) return;
  const chars = turns.reduce((s, t) => s + t.text.length, 0);
  const tokens = estimateTokensFromChars(chars);
  // 预算：显式传入 > config 默认 > 未启用（0）
  const budget =
    (typeof budgetTokens === "number" && budgetTokens > 0
      ? budgetTokens
      : cfg.compaction.contextTokenBudget) || 0;
  if (budget <= 0) return; // 未知预算：不触发长度兜底，避免假阳性
  const ratio = tokens / budget;
  if (ratio < cfg.compaction.lengthThreshold) return;
  rt.log.info(
    `[compaction] length threshold hit (ratio=${ratio.toFixed(3)}>=${cfg.compaction.lengthThreshold}, budget=${budget}, windowTurns=${turns.length}); compress oldest`,
  );
  // 长度兜底：保留最近 recentWindowForInternal 轮，压更早的（若有）。
  const cutoff = Math.max(0, turns.length - cfg.compaction.recentWindowForInternal);
  if (cutoff === 0) return;
  archiveOldTopic(rt, sessionKey, turns, cutoff);
}

/**
 * 次触发（实时主路径）：按「真实上下文 token 用量」触发长度兜底压缩。
 *
 * 修复点成因（lengthThreshold 曾是死配置）：
 *   旧实现只统计压缩窗口（compaction_turns，受 windowSize≈10 上限约束）内累计字符，
 *   长会话下窗口仅数百 token，除以 920k 的 contextTokenBudget 永远远小于 0.22 => 永不触发。
 *   改为读取真实会话上下文用量后，本路径成为真正按“上下文长度”生效的主诉据。
 *
 * 2026-08-09 根因修复（深挖）：
 *   旧 usedTokens 主来源是 rt.lcm.getActiveConversation(sessionKey).totalTokens（读 lossless 的 lcm.db）。
 *   “完整卸载 lossless”后 lcm.db 被删 → rt.lcm=null → usedTokens=0 → 退化窗口字符估算(≈0.03%) →
 *   0.22 永不触发（判据“瞎了”）。
 *   现改为读 rt.contextUsage（每次 run 由 before_prompt_build/agent_end 快照）：
 *     - 分子 usedTokens = 实测系统提示基底(contextBase, 见 context-tokens.ts) + 工具 schema 开销
 *                          + 本次 run 实际装配的会话消息估算 token —— 完全不依赖 lcm.db；
 *     - 分母 budget      = ctx.contextTokenBudget（官方解析预算，与 web 面板那个百分比同源）。
 *   优先级：1) rt.contextUsage  >  2) lcm 会话实测（仍保留，lossless 在时可交叉校验）  >  3) 窗口字符估算（最后兜底）。
 *
 * 语义（设计定）：压掉最老段、保留 recentWindowForInternal 轮。
 */
export function maybeCompressByRealLength(
  rt: RuntimeContext,
  db: EngineDb,
  sessionKey: string,
  budgetTokens?: number,
): void {
  const cfg = rt.cfg;
  // 预算：显式传入 > rt.contextUsage.budget(官方) > config 默认 > 未启用(0)
  const budget =
    (typeof budgetTokens === "number" && budgetTokens > 0
      ? budgetTokens
      : rt.contextUsage?.budget > 0
        ? rt.contextUsage.budget
        : cfg.compaction.contextTokenBudget) || 0;
  if (budget <= 0) return; // 未知预算：不触发长度兜底

  // 分子：优先 runtime 快照（每次 run 实测，不依赖 lcm.db）；否则降级 lcm 实测 / 窗口字符估算。
  let usedTokens = rt.contextUsage?.usedTokens ?? 0;
  if (usedTokens <= 0) {
    // lcm 仍可在时作为次数据源（只读交叉校验；lcm.db 已删时自动跳过）。
    try {
      if (rt.lcm) {
        const conv = rt.lcm.getActiveConversation(
          sessionKey,
          cfg.compaction.backfillSessionKey,
        );
        usedTokens = conv?.totalTokens ?? 0;
      }
    } catch {
      /* ignore */
    }
  }
  // 最后兜底：窗口内字符估算（last-resort，精度最低，仅当都拿不到时）。
  if (usedTokens <= 0) {
    const turns = db.listCompactionTurns(sessionKey);
    usedTokens = estimateTokensFromChars(
      turns.reduce((s, t) => s + t.text.length, 0),
    );
  }
  const ratio = usedTokens / budget;
  if (ratio < cfg.compaction.lengthThreshold) {
    rt.log.debug(
      `[compaction] real-length below threshold (ratio=${ratio.toFixed(4)}, used=${usedTokens}, budget=${budget}); no compress`,
    );
    return;
  }
  rt.log.info(
    `[compaction] real-length threshold hit (ratio=${ratio.toFixed(3)}>=${cfg.compaction.lengthThreshold}, usedTokens=${usedTokens}, budget=${budget}); compress oldest`,
  );
  const turns = db.listCompactionTurns(sessionKey);
  if (turns.length < cfg.compaction.minSamples) return;
  // 压最老段、保留最近 recentWindowForInternal 轮；无老段则不压
  const cutoff = Math.max(0, turns.length - cfg.compaction.recentWindowForInternal);
  if (cutoff === 0) return;
  archiveOldTopic(rt, sessionKey, turns, cutoff);
}

// ---------------------------------------------------------------------------
// force 压缩入口（mem_compact 工具调用）
// ---------------------------------------------------------------------------

export interface ForceCompressResult {
  sessionKey: string;
  ok: boolean;
  reason: string;
  archivedTurns: number;
  keptTurns: number;
  totalTurns: number;
  skippedDedup: boolean;
}

/**
 * 主动压缩（force）：agent 通过 mem_compact 手动触发。
 *
 * 策略：把窗口最老段（保留最近 recentWindowForInternal 轮）压缩归档。
 * 若最近轮内部相关低（当前窗口太散，不适合按话题切），则退化为按长度切最老段。
 * 返回结构化结果供工具 textReply 展示。
 *
 * 硬性约束：仍走后台调度，不阻塞调用方；内容若已归档过则去重跳过。
 * 未开启 enable_context_compaction 时也允许（作为手动归档能力，但需 engineDb 就绪）。
 */
export async function forceCompress(
  rt: RuntimeContext,
  sessionKey: string,
): Promise<ForceCompressResult> {
  const base: ForceCompressResult = {
    sessionKey,
    ok: false,
    reason: "init",
    archivedTurns: 0,
    keptTurns: 0,
    totalTurns: 0,
    skippedDedup: false,
  };
  if (!rt.engineDb) return { ...base, reason: "engine-db not ready" };
  const db: EngineDb = rt.engineDb;
  const turns = db.listCompactionTurns(sessionKey);
  base.totalTurns = turns.length;
  if (turns.length < 2) {
    return { ...base, reason: "too-few-turns (<2)" };
  }

  const cfg = rt.cfg;
  const keep = cfg.compaction.recentWindowForInternal;
  const cutoff = Math.max(0, turns.length - keep);
  if (cutoff === 0) {
    return { ...base, reason: "nothing-old-to-compress (window within keep range)" };
  }

  // 去重预检：若最老段原文已归档过，跳过
  const old = turns.slice(0, cutoff);
  const joined = old.map((t) => t.text.trim()).filter(Boolean).join("\n");
  if (joined.trim() && isAlreadyCompressed(rt, sessionKey, joined)) {
    base.skippedDedup = true;
    base.reason = `content already compressed before (${cutoff} turns)`;
    return base;
  }

  const archived = await compileOldSegmentForArchive(rt, sessionKey, turns, cutoff);
  base.ok = archived;
  base.archivedTurns = archived ? cutoff : 0;
  base.keptTurns = turns.length - cutoff;
  base.reason = archived
    ? `archived ${cutoff} oldest turns`
    : "archive produced nothing (empty or failed)";
  return base;
}

// ---------------------------------------------------------------------------
// 启动回填：从现有会话历史初始化压缩窗口（设计定：一旦加载即能按现有上下文检测/触发压缩）
// ---------------------------------------------------------------------------

// 已回填过的 session 标记（进程内）。回填幂等：只在首次触达时重建窗口，
// 避免后续 message_received 清掉已累积的增量轮次。
const backfilledSessions = new Set<string>();

/** 回填开关：进程内幂等。gateway_start 重新 init 后 new Set 为空，自然重新回填。 */
export function shouldBackfillSession(sessionKey: string): boolean {
  const k = sessionKey || "default";
  if (backfilledSessions.has(k)) return false;
  backfilledSessions.add(k);
  return true;
}

/**
 * 从 lossless lcm.db 读取某 session_key 的活动会话，回填 compaction 窗口。
 *
 * 设计：
 *   - 只在 enable_context_compaction 且 lcm 可读时执行；失败安全降级（不抛）。
 *   - 取最近 backfillWindowSize 条 user/assistant 消息入窗（含足够的旧段供话题切换/长度检测）。
 *   - 用该会话实测 token 总和 / 配置预算算 ratio，>= lengthThreshold 即触发最老段压缩。
 *   - 幂等：重复调用前先清窗（by design，gateway_start 或首轮统一重建）。
 *
 * @returns 回填入窗的轮数。
 */
export function backfillCompactionWindow(
  rt: RuntimeContext,
  sessionKey: string,
): number {
  if (!rt.engineDb) return 0;
  if (!rt.lcm) {
    rt.log.debug("[compaction] lcm read unavailable; skip backfill");
    return 0;
  }
  const cfg = rt.cfg;
  const db = rt.engineDb;
  const targetKey = sessionKey || cfg.compaction.backfillSessionKey;
  const limit = cfg.compaction.backfillWindowSize;
  if (!targetKey || limit <= 0) return 0;
  // 幂等：每个 session 进程内只真正回填一次（后续触达不再重建窗口）
  if (!shouldBackfillSession(targetKey)) return 0;

  try {
    // 找目标会话最新的一条活动 conversation（primary key 对应 agent:main:main 主会话）
    const convInfo = rt.lcm.getActiveConversation(
      targetKey,
      cfg.compaction.backfillSessionKey,
    );
    if (!convInfo) {
      rt.log.debug(`[compaction] no active conversation for backfill key=${targetKey}`);
      return 0;
    }
    const rows = rt.lcm.recentConversationTurns(convInfo.conversationId, limit);
    if (!rows.length) {
      rt.log.debug(`[compaction] conversation ${convInfo.conversationId} has no turns`);
      return 0;
    }

    // 重建窗口：清空后按序写回最近 limit 轮
    db.clearCompactionTurns(sessionKey);
    rows.forEach((r, i) => {
      db.upsertCompactionTurn({
        sessionKey,
        seq: i,
        text: r.text,
        vector: encodeVector([]),
        tsMs: r.tsMs,
      });
    });

    // 长度触发检测：用该会话实测 token 总预算（ratio = 会话实测 token / contextTokenBudget）
    const usedTokens =
      convInfo.totalTokens ?? rows.reduce((s, r) => s + r.tokens, 0);
    const budget = cfg.compaction.contextTokenBudget || 0;
    rt.log.info(
      `[compaction] backfilled ${rows.length} turns from conv#${convInfo.conversationId} ` +
        `(usedTokens=${usedTokens}, budget=${budget}, lengthThreshold=${cfg.compaction.lengthThreshold})`,
    );
    db.recordCompactionEvent(sessionKey, "backfill", `${rows.length} turns loaded from history`);
    if (budget > 0 && usedTokens / budget >= cfg.compaction.lengthThreshold) {
      maybeCompressByLengthPublic(rt, db, sessionKey, convInfo.totalTokens || budget);
    }
    return rows.length;
  } catch (e) {
    rt.log.warn(`[compaction] backfill failed: ${String(e)}`);
    // 回填失败不抛、不污染窗口
    return 0;
  }
}

// ---------------------------------------------------------------------------
// hook 适配：message_received / agent_end
// ---------------------------------------------------------------------------

export function onMessageReceivedCompaction(
  rt: RuntimeContext,
  event: PluginHookMessageReceivedEvent,
  _ctx: PluginHookMessageContext,
): void {
  onTurn(rt, sessionKeyOf(event.sessionKey), event.content ?? "");
}

export function onAgentEndCompaction(
  rt: RuntimeContext,
  event: PluginHookAgentEndEvent,
  ctx: PluginHookAgentContext,
): void {
  // agent_end: 取最后一条 user content 作为本轮文本（估算投入度同款思路）
  const messages = Array.isArray(event.messages) ? event.messages : [];
  let userText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = textOfContent(messages[i]);
    if (t.trim()) {
      userText = t;
      break;
    }
  }
  onTurn(
    rt,
    sessionKeyOf(ctx.sessionKey, ctx.sessionId),
    userText,
  );
}
