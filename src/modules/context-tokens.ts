/**
 * context-tokens.ts — 真实上下文 token 用量捕获（脱离 lcm.db 的主判据，2026-08-09 深挖根因）
 *
 * 根因（决定性）：maybeCompressByRealLength 旧的 usedTokens 主来源是 rt.lcm.getActiveConversation()
 *   （读 lossless 的只读库 lcm.db）。"完整卸载 lossless"后 lcm.db 被删 → rt.lcm=null → usedTokens=0
 *   → 退化为窗口字符估算(≈0.03%) → 22% 永不触发。判据"瞎了"。
 *
 * 修复（本模块）：openclaw 官方不把"当前已用上下文 token 数"直接塞给插件（hook 不暴露精确数），
 *   但它在每个 run 的 hook 上下文里给了：
 *     - ctx.contextTokenBudget（解析后的有效上下文 token 预算 = 分母，web 面板那个百分比的同源）
 *     - 事件.messages（本次 run 实际装配的会话消息数组 = 实实在在的会话内容）
 *   → 分子 = 「实测系统提示基底(workspace context 文件) + 工具 schema 固定开销 + 会话消息」的 token 估算。
 *
 * 诚实标注（重要）：web 面板那个百分比 = 完整装配上下文(系统提示+工具+会话) / 预算。
 *   插件侧拿不到逐 token 精确值，故：
 *     - 分母 = 官方 ctx.contextTokenBudget（与面板同源，精确）。
 *     - 分子 = 三部分之和：
 *       ① 系统提示基底：gateway_start 时实测 workspace 上下文文件（AGENTS/SOUL/USER/MEMORY/TOOLS + memory/dim + skills）的 token —— 真实可测，构成大头的固定值；
 *       ② 工具 schema 固定开销：config.compaction.contextToolOverheadTokens（默认 45k，不可精确测，需按实际工具集调校；0=关闭）；
 *       ③ 会话消息：每次 run 用 openclaw 官方 estimateContextTokens(带 provider usage) 优先、字节启发式兜底。
 *   因此分子能按真实量级增长，lengthThreshold(0.22) 在重会话中可达——不再锁死在 lcm.db 或 ≈0.03% 的窗口字符估算。
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  PluginHookAgentContext,
  PluginAgentTurnPrepareEvent,
  PluginHookBeforePromptBuildEvent,
  PluginHookAgentEndEvent,
} from "openclaw/plugin-sdk/plugin-runtime";

/**
 * 一次 run 使用的基底开销（固化到 runtime；系统提示测得 + 工具 schema 取配置）。
 * 会话消息部分在每次快照时单独加上。
 */
export interface ContextBaseOverhead {
  /** 系统提示固定 token（gateway_start 实测 workspace 上下文文件）。 */
  systemPromptTokens: number;
  /** 工具 schema 固定 token（config.compaction.contextToolOverheadTokens）。 */
  toolOverheadTokens: number;
}

/**
 * 每次 run 时快照的上下文用量。
 * budget    = ctx.contextTokenBudget（分母，官方解析预算；0=未知）
 * usedTokens= 分子（系统提示 + 工具 + 会话消息 的估算 token）
 * baseTokens= 分子的固定基底（系统提示 + 工具），仅诊断用
 * ts        = 快照时刻
 */
export interface ContextUsageSnapshot {
  budget: number;
  usedTokens: number;
  baseTokens: number;
  ts: number;
}

/** 空基底（未测得时视为 0）。 */
export const EMPTY_CONTEXT_BASE: ContextBaseOverhead = {
  systemPromptTokens: 0,
  toolOverheadTokens: 0,
};

/**
 * openclaw 官方上下文 token 估算器（provider usage 就绪时用它，精度最高，与 web 面板同源）。
 * 由 core 的 estimateContextTokens 提供：当消息携带 assistant usage 块时用真实 token 数，
 * 否则回退到逐条估算。运行时懒加载，失败缓存 null。
 */
let officialEstimate: ((messages: unknown[]) => { tokens?: number }) | null | undefined = undefined;

/** 懒加载官方估算器（首次调用才 import，失败则缓存 null）。避免模块级副作用/顶层 await。 */
async function resolveOfficialEstimate(): Promise<void> {
  if (officialEstimate !== undefined) return;
  try {
    const sdk = await import("openclaw/plugin-sdk/agent-sessions");
    officialEstimate =
      typeof (sdk as { estimateContextTokens?: unknown }).estimateContextTokens ===
      "function"
        ? (sdk as {
            estimateContextTokens: (messages: unknown[]) => { tokens?: number };
          }).estimateContextTokens
        : null;
  } catch {
    officialEstimate = null;
  }
}

/**
 * 从 AgentMessage 数组抽文本（兼容 string / {content:string} / content 为 TextContent 数组）。
 */
export function extractMessageText(m: unknown): string {
  if (typeof m === "string") return m;
  const c = (m as { content?: unknown })?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === "string") return p;
        const t = (p as { type?: string; text?: string })?.text;
        return typeof t === "string" ? t : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** 字节级启发式 token 估算（后备；对中文按 1 token≈2.8 CJK 字节，ASCII 1 token≈4 字节）。 */
export function estimateBytesToTokens(text: string): number {
  if (!text) return 0;
  const bytes = Buffer.byteLength(text, "utf8");
  let asciiChars = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) <= 0x7f) asciiChars++;
  }
  return Math.floor(asciiChars / 4 + (bytes - asciiChars) / 2.8);
}

/**
 * token 估算：优先 openclaw 官方 estimateContextTokens（provider usage 就绪时真实 token），
 * 否则退化到字节级启发式。只算会话消息部分；系统提示/工具基底由调用方叠加。
 */
export async function estimateMessagesTokens(messages: unknown[]): Promise<number> {
  if (!Array.isArray(messages) || !messages.length) return 0;
  let base = 0;
  try {
    await resolveOfficialEstimate();
    if (officialEstimate) {
      const est = officialEstimate(messages as never[]);
      const t = est?.tokens;
      if (typeof t === "number" && t > 0) base = t;
    }
  } catch {
    base = 0;
  }
  if (base <= 0) {
    base = estimateBytesToTokens(messages.map((m) => extractMessageText(m)).join("\n"));
  }
  return Math.max(0, base);
}

/**
 * gateway_start 实测 workspace 系统提示基底 token：读常见被注入的上下文文件。
 * 读不到的文件跳过；从不抛（失败返回 0）。这是"真实可测"的固定部分，非臆造。
 */
export function measureContextBaseTokens(workspaceDir: string): number {
  const files = [
    "AGENTS.md",
    "SOUL.md",
    "USER.md",
    "MEMORY.md",
    "TOOLS.md",
  ];
  let total = estimateBytesToTokens(readIfExists(workspaceDir, files));
  // memory/dim 多维记忆（若有则为一层上下文）
  total += estimateBytesToTokens(readDirFilesIfExists(join(workspaceDir, "memory", "dim")));
  // 顶层 skills 的 SKILL.md（较大的一组上下文）
  total += estimateBytesToTokens(
    readDirFilesIfExists(join(workspaceDir, ".agents", "skills"), "SKILL.md"),
  );
  return total;
}

function readIfExists(dir: string, files: string[]): string {
  let out = "";
  for (const f of files) {
    try {
      const p = join(dir, f);
      if (existsSync(p)) out += `\n${readFileSync(p, "utf8")}`;
    } catch {
      /* skip */
    }
  }
  return out;
}

function readDirFilesIfExists(dir: string, onlyName?: string): string {
  let out = "";
  try {
    if (!existsSync(dir)) return out;
    for (const name of readdirSafe(dir)) {
      if (onlyName && name !== onlyName) continue;
      const p = join(dir, name);
      try {
        if (existsSync(p) && statFile(p)) out += `\n${readFileSync(p, "utf8")}`;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
  return out;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function statFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 从单个 hook ctx + messages 构造上下文用量快照。
 * 分子 = 系统提示基底 + 工具 schema 开销 + 会话消息估算。
 * 分母 = 官方预算。
 */
export async function makeContextUsageSnapshot(
  ctx: PluginHookAgentContext,
  messages: unknown[] | undefined,
  base: ContextBaseOverhead,
): Promise<ContextUsageSnapshot> {
  const budget =
    typeof ctx.contextTokenBudget === "number" && ctx.contextTokenBudget > 0
      ? ctx.contextTokenBudget
      : (typeof ctx.contextWindowReferenceTokens === "number" &&
          ctx.contextWindowReferenceTokens > 0
        ? ctx.contextWindowReferenceTokens
        : 0);
  const baseTokens = (base.systemPromptTokens || 0) + (base.toolOverheadTokens || 0);
  const msgsTokens = Array.isArray(messages) && messages.length
    ? await estimateMessagesTokens(messages)
    : 0;
  return {
    budget,
    usedTokens: baseTokens + msgsTokens,
    baseTokens,
    ts: Date.now(),
  };
}

/** agent_turn_prepare 事件适配。 */
export async function snapshotFromTurnPrepare(
  ctx: PluginHookAgentContext,
  event: PluginAgentTurnPrepareEvent,
  base: ContextBaseOverhead,
): Promise<ContextUsageSnapshot> {
  // 【快照稳定性修复·Web横跳根因】event.prompt 为空时，不能落 0/低值否则 assemble fallback 估算偏大触发反复折叠(Web 20↔49横跳)。
  // 用 event.messages 估算；即便 messages 也空，也至少保留 baseTokens(系统+工具) 作为有效快照，绝不写 0。
  const snap = await makeContextUsageSnapshot(ctx, event.messages, base);
  const baseTokens = (base.systemPromptTokens || 0) + (base.toolOverheadTokens || 0);
  if (snap.usedTokens <= 0) snap.usedTokens = baseTokens;
  return snap;
}

/** before_prompt_build 事件适配。 */
export async function snapshotFromBeforePromptBuild(
  ctx: PluginHookAgentContext,
  event: PluginHookBeforePromptBuildEvent,
  base: ContextBaseOverhead,
  correction?: number,
): Promise<ContextUsageSnapshot> {
  // 修复A（2026-08-10）：优先用已装配的完整 prompt 估算分子。
  // 旧实现用 event.messages，在 agent_end 常为空 → usedTokens≈0 → 永远达不到 30% 触发线。
  // event.prompt = 系统提示 + 工具 + 全部会话消息 的完整 prompt（≈ Web 面板 pct_used 的实际内容），
  // 用它估算 token 更接近真实占比，从而让压缩在超阈值时正确触发。
  const prompt = typeof event.prompt === "string" && event.prompt.length > 0 ? event.prompt : undefined;
  if (prompt) {
    const budget =
      typeof ctx.contextTokenBudget === "number" && ctx.contextTokenBudget > 0
        ? ctx.contextTokenBudget
        : (typeof ctx.contextWindowReferenceTokens === "number" &&
            ctx.contextWindowReferenceTokens > 0
          ? ctx.contextWindowReferenceTokens
          : 0);
    const baseTokens = (base.systemPromptTokens || 0) + (base.toolOverheadTokens || 0);
    let promptTokens = await estimateMessagesTokens([{ content: prompt }]);
    // 【过早触发修复】实测 estimateMessagesTokens 对完整 prompt(系统+工具+全部消息拼接)估算比真实上下文偏高约1.48x
    // (真实19.7% → 估算0.292)，导致 summarize/length 在真实占比未达标时就误触发折叠、打断连续性。
    // 用 promptEstimateCorrection(<1) 压低估算，贴近真实占比(Web面板)。1=不校正。
    const f = typeof correction === "number" && correction > 0 && correction < 1 ? correction : 1;
    if (f < 1) promptTokens = Math.round(promptTokens * f);
    return {
      budget,
      usedTokens: promptTokens > baseTokens ? promptTokens : baseTokens,
      baseTokens,
      ts: Date.now(),
    };
  }
  return makeContextUsageSnapshot(ctx, event.messages, base);
}

/** agent_end 事件适配（无 messages 或为空时退化为上一份/0）。 */
export async function snapshotFromAgentEnd(
  ctx: PluginHookAgentContext,
  event: PluginHookAgentEndEvent,
  base: ContextBaseOverhead,
  correction?: number,
): Promise<ContextUsageSnapshot> {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const snap = await makeContextUsageSnapshot(ctx, messages.length ? messages : undefined, base);
  // 【过早触发修复】统一校正：agent_end 快照与 before_prompt_build 同口径，避免未校正大值覆盖校正值导致过早触发。
  const f = typeof correction === "number" && correction > 0 && correction < 1 ? correction : 1;
  if (f < 1 && snap.usedTokens > 0) snap.usedTokens = Math.round(snap.usedTokens * f);
  return snap;
}
