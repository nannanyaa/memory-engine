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
 * ─── hotfix 说明（现场抓到，priority 高） ───────────────────────────────
 * 原 bug：topic=频道（"agent:main:<channel>"→"main:<channel>"），轮次=event.messages.length
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
          // —— 晋升闭环：高投入片段 -> 写前自审 -> 追加合并 MEMORY/USER.md（授权自动合并）——
          if (cfg.enable_memory_promotion) {
            const text = seg.texts.join(" ").slice(0, 1200);
            if (text.trim()) {
              await promoteCandidate(rt, {
                text,
                source: `high_engagement:${topic}`,
                ts: new Date().toISOString(),
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
// 投入度晋升闭环（授命自动合并，写前必过自审防语义漂移）
// ────────────────────────────────────────────────────────────────────────────

export interface PromotionCandidate {
  /** 消息原文（供提炼；晋升落盘不再直接粘贴原文，只记“事情框架”）。 */
  text: string;
  source: string;
  ts: string;
}

/** 晋升落盘叙事框架安全上限（防蒸馏爆炸/烧上下文）。 */
const PROMOTE_DISTILL_MAX_CHARS = 2200;

/**
 * 晋升管线主体（3A，记"事"不记"话"）：
 *   蒸馏出【事项/完成度/后续/关键节点】叙事框架 -> 写前自审 -> 归档判定 -> 追加合并。
 * 蒸馏失败/无 LLM -> 降级为“来源指针 + 事件摘要截断”，绝不再退回抄原文。
 */
export async function promoteCandidate(
  rt: RuntimeContext,
  candidate: PromotionCandidate,
): Promise<{ status: string; target?: string; ts?: string; reason?: string }> {
  if (!rt.cfg.enable_memory_promotion) return { status: "disabled" };
  if (isPromotionDeduped(rt, candidate)) return { status: "dup_skipped" };

  // 0) 把原文蒸馏成叙事框架：先摘“事”，再造“框架”。
  const narrative = await distillToNarrative(rt, candidate);

  // 1) 写前自审：LLM 比对“蒸馏后框架 vs 待写入事实”，防语义漂移（保留要求）。
  const selfCheck = await selfAudit(rt, narrative);
  if (!selfCheck.consistent) {
    rt.log.warn(`[memory] promote needs_review: ${selfCheck.reason}`);
    return { status: "needs_review", reason: selfCheck.reason };
  }

  // 2) 判定去向：MEMORY.md（通用/原则级）或 USER.md（用户密切）
  const isUser = /用户|用户偏好|user|主人|殿下/.test(candidate.source);
  const target = isUser ? userPath(rt.workspaceDir) : memoryPath(rt.workspaceDir);

  // 3) 追加合并（走 writers 网关：写前备份 + 改动日志，append 不覆写）
  const entry = buildEntry(candidate, narrative, true);
  const res = appendToFile(
    target,
    entry,
    "memory",
    "晋升自动合并",
    `promote: ${candidate.text.slice(0, 40)}`,
    rt.cfg,
    rt.log,
  );
  if (!res.ok) return { status: "write_failed", reason: res.error };

  // 4) 登记索引 + 台账防重复
  appendIndexEntry(
    indexPath(rt.workspaceDir),
    {
      ts: candidate.ts,
      module: "memory",
      kind: "promotion",
      target,
      summary: narrative.slice(0, 120),
      source: candidate.source,
    },
    rt.cfg,
    rt.log,
  );
  rt.engineDb?.setPromoted(dedupKey(candidate), target);

  rt.log.info(`[memory] promoted->${target} ${candidate.source}`);
  return { status: "merged", target, ts: candidate.ts };
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
function parseNarrativeLines(
  distilled: string,
): Record<"事项" | "完成度" | "后续" | "关键节点", string> {
  const out: Record<"事项" | "完成度" | "后续" | "关键节点", string> = {
    事项: "incomplete", 完成度: "incomplete", 后续: "incomplete", 关键节点: "incomplete",
  };
  for (const line of distilled.split(/\n+/)) {
    for (const key of ["事项", "完成度", "后续", "关键节点"] as const) {
      const idx = line.indexOf(`${key}：`);
      if (idx === 0) {
        out[key] = line.slice(2).trim();
        break;
      }
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

/** 自审：保证写入内容与真实认知一致（明确要求）。 */
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
