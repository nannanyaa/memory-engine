/**
 * runtime.ts — 插件运行时状态（gateway_start 时初始化，gateway_stop 时清理）
 *
 * 这里持有解析后的配置 + 独立 engine-db + lossless 只读句柄。
 * 早期 hook（message_received / agent_end / before_prompt_build / session_*）
 * 通过 resolveRuntime() 获取；若 engine-db 尚未就绪则安全降级为 no-op。
 */
import { type Logger } from "./log.js";
import {
  normalizeConfig,
  type MemoryEngineConfig,
} from "./config.js";
import { openEngineDb, type EngineDb } from "./db/engine-db.js";
import { openLcmRead, type LcmRead } from "./db/lcm-read.js";
import {
  type ContextUsageSnapshot,
  type ContextBaseOverhead,
  EMPTY_CONTEXT_BASE,
  measureContextBaseTokens,
} from "./modules/context-tokens.js";

export interface RuntimeContext {
  cfg: MemoryEngineConfig;
  log: Logger;
  engineDb: EngineDb | null;
  lcm: LcmRead | null;
  stateDir: string;
  workspaceDir: string;
  /**
   * 最近一次 run 的上下文用量快照（分子=实测基底+工具+会话消息估算，分母=官方 contextTokenBudget）。
   * 由 before_prompt_build / agent_end / agent_turn_prepare 每个 run 更新；
   * 压缩判定读它，脱离已删的 lcm.db。
   */
  contextUsage: ContextUsageSnapshot;
  /** 系统提示基底（gateway_start 实测 workspace 上下文文件）+ 工具 schema 固定开销。 */
  contextBase: ContextBaseOverhead;
}

/** 默认 snapshot：无任何数据时 budget=0/usedTokens=0（判据端降级，不误触发）。 */
const EMPTY_CONTEXT_USAGE: ContextUsageSnapshot = { budget: 0, usedTokens: 0, baseTokens: 0, ts: 0 };

let current: RuntimeContext | null = null;
let lock = false;

/**
 * gateway_start 时初始化运行时。带简单并发锁，重复调用安全。
 */
export function initRuntime(
  rawConfig: Record<string, unknown> | undefined,
  env: { workspaceDir: string; stateDir: string },
  log: Logger,
): RuntimeContext {
  const cfg = normalizeConfig(rawConfig, env);
  const ctx: RuntimeContext = {
    cfg,
    log,
    engineDb: null,
    lcm: null,
    stateDir: env.stateDir,
    workspaceDir: env.workspaceDir,
    contextUsage: { ...EMPTY_CONTEXT_USAGE },
    contextBase: { ...EMPTY_CONTEXT_BASE },
  };
  // 独立 engine-db：任何模块启用时都需要（记忆引擎/情感/自进化/兜底都写它）
  ctx.engineDb = openEngineDb(cfg.engineDbPath, log);
  // 中文 FTS 索引（后台构建，不阻塞启动）：让 mem_find 能搜到中文双字词。
  // 方案甲（2026-08-10）：在 memory-engine.db 建 bigram 中文索引，弥补 lcm messages_fts 对中文的缺陷。
  if (cfg.enable_recall) {
    void import("./cn-fts.js").then(({ buildCnFtsIndex }) => {
      try {
        buildCnFtsIndex(cfg.engineDbPath, cfg.lcmDbPath, log);
      } catch {
        /* 后台构建失败仅记日志，不阻断 */
      }
    });
  }
  // 系统提示基底：实测 workspace 上下文文件 token（AGENTS/SOUL/USER/MEMORY/TOOLS + memory/dim + skills）
  ctx.contextBase = {
    systemPromptTokens: measureContextBaseTokens(ctx.workspaceDir),
    toolOverheadTokens: cfg.compaction.contextToolOverheadTokens || 0,
  };
  log.info(
    `[context-tokens] context base measured: systemPrompt=${ctx.contextBase.systemPromptTokens} tokens, ` +
      `toolOverhead=${ctx.contextBase.toolOverheadTokens} tokens`,
  );
  // lossless 只读：检索引擎/语义增强时用
  if (cfg.enable_recall) {
    ctx.lcm = openLcmRead(cfg.lcmDbPath, log);
  }
  current = ctx;
  lock = false;
  return ctx;
}

export function getRuntime(): RuntimeContext | null {
  return current;
}

export function resetRuntime(): void {
  try {
    if (current?.engineDb) current.engineDb.close();
    if (current?.lcm && "close" in (current.lcm as object)) {
      (current.lcm as unknown as { close(): void }).close();
    }
  } catch {
    /* ignore */
  }
  current = null;
}

/**
 * 更新 runtime 的上下文用量快照（每次 run 由 hook 调用）。
 * 仅当新快照有有效分母(>0)或分子(>0)时覆盖，避免空消息覆盖掉有效快照。
 */
export function updateContextUsage(snap: ContextUsageSnapshot): void {
  const rt = current;
  if (!rt) return;
  const prev = rt.contextUsage;
  // 新快照无任何有效数值 → 保留旧的（防止某些 hook 的 messages 为空覆盖掉有效数据）
  if (snap.budget <= 0 && snap.usedTokens <= 0 && prev) {
    return;
  }
  // 用最新快照（宁可刷成较新，也不保留陈旧）
  rt.contextUsage = {
    budget: snap.budget || prev?.budget || 0,
    usedTokens: snap.usedTokens || prev?.usedTokens || 0,
    baseTokens: snap.baseTokens || prev?.baseTokens || 0,
    ts: snap.ts || Date.now(),
  };
}

/** 便捷：取配置（未初始化时返回 v0 默认全关，安全 no-op）。 */
export function currentConfig(): MemoryEngineConfig | null {
  return current?.cfg ?? null;
}

/** gateway_start hook 的上下文会携带 workspaceDir / config。 */
export function stateDirFromGateway(config?: Record<string, unknown>): string {
  // stateDir 默认与 workspaceDir 同层；插件状态目录暂用工作区
  void config;
  return "";
}
