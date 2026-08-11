/**
 * registry.ts — 插件注册中心
 *
 * 统一把所有 hook / tool / cron 按 enable_* 门控注册到 OpenClaw API：
 *   - 未启用的模块：不注册对应 hook/tool（不占资源）——但 hook 注册本身廉价，
 *     handler 首行即判断开关，未开直接 no-op。
 *   - 生命周期：gateway_start 初始化 runtime（建 engine-db + 只读 lcm + 自管 cron），
 *     gateway_stop 清理。
 *
 * 关键约束（硬性）：
 *   - 不碰 openclaw.json / lossless 源码 / AGENTS/MEMORY/USER/tasks 的机制文件。
 *   - 不抢 contextEngine / memory slot。
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginHookGatewayCronService,
  PluginHookMessageContext,
  PluginHookAgentContext,
  PluginHookSessionContext,
  PluginHookGatewayContext,
} from "openclaw/plugin-sdk/plugin-runtime";
import type { Logger } from "./log.js";
import { initRuntime, resetRuntime, getRuntime, updateContextUsage } from "./runtime.js";
import { isModuleEnabled } from "./config.js";
import { onMessageReceived } from "./modules/emotion.js";
import { onAgentEnd } from "./modules/memory.js";
import { onBeforePromptBuild, memFind } from "./modules/recall.js";
import { nightlyReview } from "./modules/selfevolve.js";
import { ensureDailyPersist } from "./modules/daily.js";
import {
  onMessageReceivedCompaction,
  onAgentEndCompaction,
  backfillCompactionWindow,
} from "./modules/compaction.js";
import { registerContextEngineIfEnabled } from "./modules/context-engine.js";
import { registerTools } from "./tools.js";
import {
  snapshotFromBeforePromptBuild,
  snapshotFromAgentEnd,
} from "./modules/context-tokens.js";

export function registerHooks(api: OpenClawPluginApi, log: Logger): void {
  // ---- gateway lifecycle：初始化 + 自管 cron ----
  api.on(
    "gateway_start",
    async (event, ctx) => {
      const workspaceDir = ctx.workspaceDir ?? "";
      // 插件自身的解析后配置在 api.pluginConfig（真实 SDK 的 gateway ctx 只有 config/workspaceDir/getCron）。
      const cfgRaw = api.pluginConfig;
      const rt = initRuntime(cfgRaw, { workspaceDir, stateDir: workspaceDir }, log);

      // 自管 cron：落盘兜底（enable_daily_digest） + 夜间复盘（enable_self_evolve）
      await registerCrons(rt, ctx.getCron?.());

      // 事件感知压缩引擎：B 路 contextEngine（仅当开关开启时注册；接管需另设 slots.contextEngine）
      registerContextEngineIfEnabled();

      // 核心要求：启动即从现有会话历史回填压缩窗口，检测上下文长度并触发压缩。
      // 不回填就永远从"插件加载后第一条消息"才开始计数，导致已超阈值也不压缩。
      if (isModuleEnabled(rt.cfg, "enable_context_compaction")) {
        try {
          const mainKey = rt.cfg.compaction.backfillSessionKey || "agent:main:main";
          const n = backfillCompactionWindow(rt, mainKey);
          rt.log.info(
            `[compaction] startup backfill: ${n} turns loaded for session ${mainKey}`,
          );
        } catch (e) {
          rt.log.warn(`[compaction] startup backfill failed: ${String(e)}`);
        }
      }
    },
    { priority: 100 },
  );

  api.on(
    "gateway_stop",
    async () => {
      // 清理长时资源
      resetRuntime();
    },
    { priority: 100 },
  );

  // 启动即回填：把现有会话历史灌入压缩窗口（一旦加载即按现有上下文检测压缩）。
  // 在 gateway_start 先回填一次主会话；运行时首次 message_received/agent_end 再按真实 key 幂等重建。
  const ensureBackfill = (rt: import("./runtime.js").RuntimeContext, sessionKey: string) => {
    const k = sessionKey && sessionKey.length ? sessionKey : rt.cfg.compaction.backfillSessionKey;
    if (!k) return;
    try {
      const n = backfillCompactionWindow(rt, k);
      rt.log.debug(`[compaction] ensureBackfill(${k}) loaded ${n} turns`);
    } catch (e) {
      rt.log.warn(`[compaction] ensureBackfill(${k}) failed: ${String(e)}`);
    }
  };

  // ---- 事件感知压缩引擎（enable_context_compaction）：message_received 投递 ----------------
  api.on(
    "message_received",
    async (event, ctx) => {
      const rt = getRuntime();
      if (!rt) return;
      if (!isModuleEnabled(rt.cfg, "enable_context_compaction")) return;
      if (!rt.engineDb) return;
      // 首次触达：按事件真实 session key 回填历史（幂等，见 backfill）
      ensureBackfill(rt, event.sessionKey ?? ctx.sessionKey ?? "");
      // 只投递后台，不 await（铁律）
      onMessageReceivedCompaction(rt, event, ctx);
    },
    { priority: 40 },
  );

  // ---- 事件感知压缩引擎（enable_context_compaction）：agent_end 投递 ----------------
  api.on(
    "agent_end",
    async (event, ctx) => {
      const rt = getRuntime();
      if (!rt) return;
      // 真实上下文用量快照（分子=基底+工具+会话消息估算，分母=官方预算）——压缩判据主数据源，不依赖 lcm.db
      updateContextUsage(await snapshotFromAgentEnd(ctx, event, rt.contextBase));
      if (!isModuleEnabled(rt.cfg, "enable_context_compaction")) return;
      if (!rt.engineDb) return;
      // 首次触达：按 ctx 真实 session key 回填历史
      ensureBackfill(rt, ctx.sessionKey ?? ctx.sessionId ?? "");
      onAgentEndCompaction(rt, event, ctx);
    },
    { priority: 40 },
  );

  // ---- 情感引擎（enable_emotion）：message_received ----
  api.on(
    "message_received",
    async (event, ctx) => {
      const rt = getRuntime();
      if (!rt) return;
      if (!isModuleEnabled(rt.cfg, "enable_emotion")) return;
      if (!rt.engineDb) return;
      await onMessageReceived(rt, event, ctx);
    },
    { priority: 40 },
  );

  // ---- 记忆引擎·投入度（enable_memory_promotion）：agent_end ----
  api.on(
    "agent_end",
    async (event, ctx) => {
      const rt = getRuntime();
      if (!rt) return;
      if (!isModuleEnabled(rt.cfg, "enable_memory_promotion")) return;
      if (!rt.engineDb) return;
      await onAgentEnd(rt, event, ctx);
    },
    { priority: 40 },
  );

  // ---- 检索引擎·预拉（enable_recall）：before_prompt_build ----
  api.on(
    "before_prompt_build",
    async (event, ctx) => {
      const rt = getRuntime();
      if (!rt) return;
      // 真实上下文用量快照（优先级最高：基底+本次 run 装配的 messages + 官方预算）
      updateContextUsage(await snapshotFromBeforePromptBuild(ctx, event, rt.contextBase));
      if (!isModuleEnabled(rt.cfg, "enable_recall")) return;
      if (!rt.engineDb) return;
      return await onBeforePromptBuild(rt, event, ctx);
    },
    { priority: 40, timeoutMs: 90000 },
  );

  // ---- 自进化引擎（enable_self_evolve）由 cron 驱动，hook 端不接人话 ----
  api.on(
    "session_end",
    async (_event, _ctx) => {
      // 预留：会话收尾可触发落盘兜底（若 enable_daily_digest 且未定时）
      const rt = getRuntime();
      if (!rt) return;
      if (!isModuleEnabled(rt.cfg, "enable_daily_digest")) return;
      // 当前不做高频动作；兜底以 gateway cron 为准。
    },
    { priority: 20 },
  );

  // ---- 工具注册（mem_find / mem_promote / mem_rollback / mem_status）----
  registerTools(api);
}

function returnTypesAllowed(x: unknown): x is void {
  return x === undefined;
}

/** 注册自管 cron（gateway_start 时）。 */
async function registerCrons(
  rt: import("./runtime.js").RuntimeContext,
  cron: PluginHookGatewayCronService | undefined,
): Promise<void> {
  const svc = cron;
  if (!svc) {
    rt.log.info("[cron] gateway cron service unavailable; using setInterval fallback");
    startIntervalFallback(rt);
    return;
  }

  if (isModuleEnabled(rt.cfg, "enable_daily_digest")) {
    try {
      await svc.add({
        name: "memory-engine-daily-digest",
        description: "每日落盘兜底 + 索引校验",
        enabled: true,
        schedule: { kind: "cron", expr: rt.cfg.dailyDigestCron, tz: rt.cfg.selfEvolve.timezone },
        sessionTarget: "main",
        wakeMode: "background",
        payload: { kind: "text", text: "memory-engine daily digest" },
      });
      rt.log.info(`[cron] daily digest scheduled: ${rt.cfg.dailyDigestCron}`);
    } catch (e) {
      rt.log.warn(`[cron] register daily digest failed: ${String(e)}`);
    }
  }

  if (isModuleEnabled(rt.cfg, "enable_self_evolve")) {
    try {
      await svc.add({
        name: "memory-engine-nightly-review",
        description: "夜间自进化复盘",
        enabled: true,
        schedule: { kind: "cron", expr: rt.cfg.selfEvolve.cronExpr, tz: rt.cfg.selfEvolve.timezone },
        sessionTarget: "main",
        wakeMode: "background",
        payload: { kind: "text", text: "memory-engine nightly review" },
      });
      rt.log.info(`[cron] nightly review scheduled: ${rt.cfg.selfEvolve.cronExpr}`);
    } catch (e) {
      rt.log.warn(`[cron] register nightly review failed: ${String(e)}`);
    }
  }
}

/** 轻量 setInterval 兜底（gateway cron 不可用时的降级路径）。 */
function startIntervalFallback(rt: import("./runtime.js").RuntimeContext): void {
  let interval: ReturnType<typeof setInterval> | null = null;

  const maybeDigest = async () => {
    const r = getRuntime();
    if (!r) return;
    // 每 6h 检查一次今日落盘（兜底）；未落盘则全自动生成摘要草稿（全自动）
    if (isModuleEnabled(r.cfg, "enable_daily_digest")) {
      try {
        await ensureDailyPersist(r);
      } catch {
        /* ignore */
      }
    }
  };

  const maybeReview = async () => {
    const r = getRuntime();
    if (!r) return;
    // 每 12h 检查一次（粗粒度复盘兜底）
    if (isModuleEnabled(r.cfg, "enable_self_evolve")) {
      try {
        await nightlyReview(r);
      } catch {
        /* ignore */
      }
    }
  };

  interval = setInterval(maybeDigest, 6 * 60 * 60 * 1000);
  const interval2 = setInterval(maybeReview, 12 * 60 * 60 * 1000);
  // 进程退出清理
  process.once("exit", () => {
    if (interval) clearInterval(interval);
    clearInterval(interval2);
  });
  // gateway_stop 清理交由 resetRuntime + 下面 unref
  interval.unref();
  interval2.unref();
  void returnTypesAllowed;
}
