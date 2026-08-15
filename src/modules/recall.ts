/**
 * recall.ts — 检索引擎·预拉+语义检索（模块：enable_recall）
 *
 * 职责：目标④ "无需提醒的主动记忆"。
 *
 * before_prompt_build 预拉：
 *   - 固定锚点（情感锚点表 kind=fixed）   —— 开机固定注入（稳，双轨之一）
 *   - 场景激活锚点（scenario_hints 命中） —— 聊特定语境时自然注入（双轨之二）
 *   - 高投入事项（engagement 超阈值）     —— 目标①的记忆引擎联动
 *   统一用 <memory-engine-memories> tag 包裹（丢给 lossless stripInjectedContextTags 剥离）。
 *   紧凑，受 injectMaxChars 上限保护，防烧上下文。
 *
 * mem_find 工具：FTS5 + 可选语义向量（enable_semantic_vector）叠加去重。
 */
import type {
  PluginHookBeforePromptBuildEvent,
  PluginHookAgentContext,
  PluginHookBeforePromptBuildResult,
} from "openclaw/plugin-sdk/plugin-runtime";
import type { RuntimeContext } from "../runtime.js";
import { sanitizeMatch } from "../db/lcm-read.js";

export const PRELOAD_TAG = "memory-engine-memories";

/** before_prompt_build：预拉关键记忆，用统一 tag 包裹注入。 */
export async function onBeforePromptBuild(
  rt: RuntimeContext,
  event: PluginHookBeforePromptBuildEvent,
  ctx: PluginHookAgentContext,
): Promise<PluginHookBeforePromptBuildResult | void> {
  if (rt.cfg.enable_recall === false) return;
  const db = rt.engineDb;
  if (!db) return;

  const blocks: string[] = [];
  const nowMs = Date.now();
  const recCfg = rt.cfg.recall;
  const cooldownMs = recCfg.anchorCooldownMs;

  // ① 固定锚点（情感重锚）—— 生命周期：冷却期内非里程碑锚点不重复注入；注入后登记 last_preloaded_at。
  const fixedAnchors = db.listActiveAnchors(6).filter((a) => !db.anchorOnCooldown(a.id, nowMs, cooldownMs));
  if (fixedAnchors.length > 0) {
    blocks.push(fixedAnchors.map((a) => `- ${a.text}`).join("\n"));
    fixedAnchors.forEach((a) => db.markAnchorPreloaded(a.id));
  }

  // ② 场景激活锚点（聊到相关语境时）—— 生命周期同①；并在块内去重（跳过已出现在固定块里的同一句）。
  const fixedTexts = new Set(fixedAnchors.map((a) => a.text));
  // C：高投入主题并入场景匹配文本——聊到某深入话题时，把主题名也喂给场景扫描，
  //    让相关情感锚点通过“当前高频话题”联动唤起（不再只靠 prompt 字面命中的泛用情绪词）。
  const engagTopics = db
    .listHighEngagement({
      minTurns: rt.cfg.engagement.minTurns,
      minTimeWindows: rt.cfg.engagement.minTimeWindows,
      minTokens: rt.cfg.engagement.minTokens,
    })
    .map((h) => h.topic)
    .join(" ");
  const promptText = `${event.prompt ?? ""} ${engagTopics}`.trim();
  const scenario = db
    .listScenarioAnchors(promptText, 3)
    .filter((a) => {
      if (fixedTexts.has(a.text)) return false; // 跨轨去重：固定&场景重复预拉同一句
      return !db.anchorOnCooldown(a.id, nowMs, cooldownMs);
    });
  if (scenario.length > 0) {
    blocks.push(
      scenario.map((a) => `(场景联想) ${a.text}`).join("\n"),
    );
    scenario.forEach((a) => {
      fixedTexts.add(a.text);
      db.markAnchorPreloaded(a.id);
    });
  }

  // ③ 高投入事项（记忆引擎联动）—— 生命周期：达 maxHighEngagementPreloads 的主題已自动从
  //     listHighEngagement 降级清出；每次预拉后登记 preload_count。
  const engagCfg = rt.cfg.engagement;
  const maxPreloads = recCfg.maxHighEngagementPreloads;
  const high = (maxPreloads > 0
      ? db
          .listHighEngagement({
            minTurns: engagCfg.minTurns,
            minTimeWindows: engagCfg.minTimeWindows,
            minTokens: engagCfg.minTokens,
          })
          .filter((h) => (h.preload_count ?? 0) < maxPreloads)
      : db.listHighEngagement({
          minTurns: engagCfg.minTurns,
          minTimeWindows: engagCfg.minTimeWindows,
          minTokens: engagCfg.minTokens,
        })
    )
    .slice(0, 3);
  if (high.length > 0) {
    blocks.push(
      `[近期高投入主题] ` + high.map((h) => `${h.topic}(轮次${h.turn_count})`).join("、"),
    );
    high.forEach((h) => db.markEngagementPreloaded(h.topic));
  }

  if (blocks.length === 0) return;

  const joined = blocks.join("\n\n");
  // 紧凑上限
  let body = joined;
  if (body.length > rt.cfg.injectMaxChars) {
    body = body.slice(0, rt.cfg.injectMaxChars);
  }

  return {
    prependContext: `<${rt.cfg.injectTag}>\n${body}\n</${rt.cfg.injectTag}>`,
  };
}

/**
 * mem_find 工具实现：FTS5 + 语义向量增强。
 * 返回命中文本列表；向量层（enable_semantic_vector）叠加并去重。
 */
export async function memFind(
  rt: RuntimeContext,
  params: { query: string; limit?: number },
): Promise<string> {
  const q = params.query ?? "";
  if (!q.trim()) return "mem_find: empty query";
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 20);

  const hits: string[] = [];
  // 中文检索增强：query 含中文时，先用自建 cn_messages_fts 索引（bigram，弥补 messages_fts
  // 对中文双字词检索不到的缺陷）。命中插到最前作为主要信号；非中文走原 FTS。
  try {
    const { grepCnMessages } = await import("../cn-fts.js");
    const { textHasCJK } = await import("../cn-tokenize.js");
    if (textHasCJK(q)) {
      const cnHits = grepCnMessages(rt.cfg.engineDbPath, q, limit);
      for (const h of cnHits) {
        hits.push(`[msg] ${h.content.slice(0, 300)}`);
      }
    }
  } catch {
    /* cn-fts 失败不阻断，回落原查询 */
  }
  if (rt.lcm) {
    const safe = sanitizeMatch(q.trim());
    for (const h of rt.lcm.grepMessages(safe, limit)) {
      hits.push(`[msg] ${h.content.slice(0, 300)}`);
    }
    for (const h of rt.lcm.grepSummaries(safe, limit)) {
      hits.push(`[summary] ${h.content.slice(0, 400)}`);
    }
  }

  // 语义向量增强（L2，需 enable_semantic_vector && enable_recall）
  if (rt.cfg.enable_semantic_vector) {
    const vecHits = await vectorFind(rt, q, limit);
    // 去重（文本交集近似）
    for (const vh of vecHits) {
      if (!hits.some((h) => h.includes(vh.slice(0, 60)))) hits.push(`[vector] ${vh}`);
    }
  }

  if (hits.length === 0) return "mem_find: no match";
  return hits.slice(0, limit + 6).join("\n");
}

/** 向量检索接口。MVP 提供占位实现 + 接口留好，云 embedding 端点可配置。 */
async function vectorFind(rt: RuntimeContext, _q: string, _limit: number): Promise<string[]> {
  // 说明：vector 模块实现见 vector.ts；这里保持接口，若未实现返回空。
  try {
    const { searchVector } = await import("./vector.js");
    return await searchVector(rt, _q, _limit);
  } catch {
    return [];
  }
}
