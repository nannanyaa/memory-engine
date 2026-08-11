/**
 * context-engine.ts — B 路：contextEngine slot 接管（模块：enable_context_compaction，默认关）
 *
 * OpenClaw plugins.slots.contextEngine 指向的插件需实现 ContextEngine 接口的 7 个生命周期 hook：
 *   bootstrap / ingest / assemble(核心) / compact / afterTurn / prepareSubagentSpawn / onSubagentEnded
 * 另含可选 maintain / dispose。
 *
 * 接管方式：registerContextEngine(id, factory)，然后由配置 plugins.slots.contextEngine = 本引擎 id 生效。
 * —— 硬性约束：不改 slots.contextEngine 实际值（当前仍为 lossless-claw），
 *    因此本模块注册即使开启 enable_context_compaction 也不会接管（safe, deferred）。
 *    真正接管由用户确认后配置 slots.contextEngine + 重启。
 *
 * 设计：与 A 路（compaction.ts）共享向量窗口/事件检测/归档能力。
 *   - ingest: 把消息投入后台窗口（不阻塞）。
 *   - assemble: 在 tokenBudget 内返回有序消息 + 可选 systemPromptAddition；
 *     超预算时用最旧段压缩归档后瘦身（提炼，不丢原文）。
 *   - compact: 显式压缩（force 或超阈值）。
 *   - afterTurn: 触发后台长度阈值检查。
 *   - 所有重活走后台，async hook 内部不对外部同步调用方 await 网路。
 */
import {
  registerContextEngine,
  type ContextEngine,
  type ContextEngineFactory,
  type ContextEngineFactoryContext,
  type AssembleResult,
  type BootstrapResult,
  type CompactResult,
  type ContextEngineMaintenanceResult,
  type IngestResult,
  type SubagentSpawnPreparation,
  type SubagentEndReason,
} from "openclaw/plugin-sdk";
import type { RuntimeContext } from "../runtime.js";
import { getRuntime } from "../runtime.js";
import { distillText } from "../llm.js";
import { appendToFile } from "../writers.js";
import { toISODate } from "../time.js";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, statSync, existsSync } from "node:fs";

/** 本引擎的 id（slots.contextEngine 设为它即启用接管）。 */
export const CONTEXT_ENGINE_ID = "memory-engine-context";

/**
 * 注册 contextEngine。幂等；仅当 enable_context_compaction 开启时才真正注册。
 * 注册后仍不会接管 —— 因为 slots.contextEngine 仍指向 lossless-claw（接管留给后续单独立项）。
 */
export function registerContextEngineIfEnabled(): void {
  const rt = getRuntime();
  if (!rt) return;
  if (!rt.cfg.enable_context_compaction) return;

  const factory: ContextEngineFactory = (_ctx: ContextEngineFactoryContext) => {
    return createContextEngine(getRuntime());
  };
  const res = registerContextEngine(CONTEXT_ENGINE_ID, factory);
  rt.log.info(
    `[context-engine] registerContextEngine(${CONTEXT_ENGINE_ID}) ${
      res.ok ? "ok" : `failed existingOwner=${(res as { existingOwner: string }).existingOwner}`
    } (接管需另设 slots.contextEngine 才生效)`,
  );
}

/**
 * 构造 ContextEngine 实例。rt 可能为 null（引擎懒构造时 runtime 未就绪），
 * 此时各 hook 内部用 getRuntime() 懒取并安全降级。
 */
function createContextEngine(
  _rt: RuntimeContext | null,
): ContextEngine {
  const info: ContextEngine["info"] = {
    id: CONTEXT_ENGINE_ID,
    name: "Memory Engine Context",
    version: "0.1.0",
    ownsCompaction: true,
    turnMaintenanceMode: "background",
  };

  const engine: ContextEngine = {
    info,

    /**
     * findLinearChain: 沿 parentId 从祖先向后，找到同一线性分支上、在 keptTail 之前的所有
     * message 控制条目（type === "message"）。返回 { id, parentId, message, timestamp } 数组，
     * 保持 transcript 中的先后顺序。
     * 该线性链就是"该折叠的最老一段"：替换它们的 content 即可真降字节/token，不破坏 id/parentId DAG。
     */

    async maintain(params): Promise<ContextEngineMaintenanceResult & { appendedEntries?: unknown[] }> {
      const rt = getRuntime();
      const result: ContextEngineMaintenanceResult = {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "init",
      };
      rt?.log?.info(
        `[context-engine] maintain CALLED session=${params.sessionId} hasRt=${!!rt} sum=${rt?.cfg?.enable_context_summarize} comp=${rt?.cfg?.enable_context_compaction}`,
      );
      if (!rt || !rt.cfg.enable_context_compaction || !rt.cfg.enable_context_summarize) {
        result.reason = "disabled";
        rt?.log?.info(`[context-engine] maintain return: disabled`);
        return result;
      }
      const sessionFile = params.sessionFile;
      const runtimeContext = params.runtimeContext as Record<string, unknown> | undefined;
      if (!sessionFile || !runtimeContext) {
        result.reason = "no-session-file-or-ctx";
        rt?.log?.info(`[context-engine] maintain return: no-session-file-or-ctx`);
        return result;
      }

      // 读 transcript，取活跃分支消息（transcript 即上下文来源，用它估真实占比，
      // 不依赖 runtime 的 currentTokenCount/contextUsage —— 那俩在 maintain 期未必可靠）。
      let entries;
      try {
        entries = readFileSync(sessionFile, "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l) as Record<string, unknown>;
            } catch {
              return null;
            }
          })
          .filter((e): e is Record<string, unknown> => e !== null);
      } catch (e) {
        result.reason = `read-failed:${String(e)}`;
        rt?.log?.info(`[context-engine] maintain return: read-failed`);
        return result;
      }
      // 取 message 控制条目（带 id + message.content 的对话消息）
      const allMsgs = entries.filter((e) => e.type === "message" && typeof e.id === "string" && e.message);
      if (allMsgs.length < 2) {
        result.reason = "too-few-messages";
        rt?.log?.info(`[context-engine] maintain return: too-few-messages`);
        return result;
      }

      // 判据：优先用真实上下文占比（ctxUsed/budget，修复A 对齐 Web 面板），
      // 而非 transcript 消息估算（后者因多数消息已被压缩/归档而严重偏低，永远达不到阈值）。
      const budget =
        (typeof runtimeContext.tokenBudget === "number" && runtimeContext.tokenBudget > 0
          ? runtimeContext.tokenBudget
          : rt.contextUsage?.budget) || rt.cfg.compaction.contextTokenBudget;
      const ctxUsed = rt.contextUsage?.usedTokens ?? 0;
      const tokenCount = ctxUsed > 0 ? ctxUsed : estimateMessages(
        allMsgs.map((e) => {
          const m = e.message as { role?: string; content?: unknown };
          return (typeof m.content === "string" ? m.content : Array.isArray(m.content)
            ? m.content.map((p) => (typeof p === "string" ? p : (p as { text?: string })?.text || "")).join("\n")
            : "");
        }),
      );
      const ratio = budget > 0 ? tokenCount / budget : 0;
      rt?.log?.info(
        `[context-engine] maintain 判据: transcriptMsgs=${allMsgs.length} ctxUsed=${rt.contextUsage?.usedTokens} budget=${budget} ratio=${ratio.toFixed(3)}`,
      );
      if (ratio < rt.cfg.compaction.lengthThreshold) {
        result.reason = `below-threshold`;
        rt?.log?.info(`[context-engine] maintain return: below-threshold (ratio=${ratio.toFixed(3)})`);
        return result;
      }
      rt.log.info(
        `[context-engine] maintain: ratio=${ratio.toFixed(3)}>=${rt.cfg.compaction.lengthThreshold} tokenCount=${tokenCount} budget=${budget} session=${params.sessionId}`,
      );

      const msgs = allMsgs;
      // ---- Session Rotation（学习 lossless rewriteTranscriptForRotate）----
      // 目标是让 transcript 文件真正瘦身（保留 header + prelude + 尾部 freshTail 条消息），
      // 前段原文先归档到 memory/events（不丢原文铁律），再原子重写 transcript 文件。
      // OpenClaw 检测到文件变更后，后续 run 会用瘦身后的 transcript → 上下文占比真降。

      // 计算要用多少条尾部消息才能把 ratio 压回目标以下（方案 A：压落点 0.12，配置化）
      const targetRatio = Math.max(0.05, adjustTargetRatio(rt.cfg.compaction.lengthThreshold, rt.cfg.compaction.summarizeTargetRatio));
      const msgTokenList = msgs.map((e) => {
        const m = e.message as { role?: string; content?: unknown };
        const txt =
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p) => (typeof p === "string" ? p : (p as { text?: string })?.text || "")).join("\n")
              : "";
        return { id: e.id as string, txt, len: txt.length };
      });
      // 待削减 token = 当前 - 目标预算。从尾部向左累计，找到需保留的最小尾部条数 keepTail。
      const budgetNum = budget > 0 ? budget : 900000;
      const targetTokens = Math.floor(budgetNum * targetRatio);
      let keepTail = msgs.length; // 默认全留（不削减）
      let keepTokens = tokenCount;
      for (let i = msgTokenList.length - 1; i >= 0; i--) {
        const t = Math.max(1, tokenEstimateOfText(msgTokenList[i].txt));
        if (keepTokens - t <= targetTokens) break; // 再减一条就低于目标，停
        keepTokens -= t;
        keepTail = i;
      }
      // 至少保留 4 条尾部消息，且不能全删
      keepTail = Math.max(4, Math.min(keepTail, msgs.length - 1));
      if (keepTail >= msgs.length - 1) {
        result.reason = "no-enough-excess";
        rt?.log?.info(`[context-engine] maintain return: no-enough-excess (keepTail=${keepTail}/${msgs.length})`);
        return result;
      }
      const droppedMsgs = msgs.slice(0, keepTail);
      rt.log.info(
        `[context-engine] maintain ROTATE: total=${msgs.length} drop=${droppedMsgs.length} keepTail=${msgs.length - droppedMsgs.length} tokens ${tokenCount}->~${keepTokens} (target=${targetTokens}) session=${params.sessionId}`,
      );

      // 1) 归档被丢弃的原始消息（不丢原文铁律）
      const droppedText = droppedMsgs
        .map((e) => {
          const m = e.message as { role?: string; content?: unknown };
          const txt =
            typeof m.content === "string"
              ? m.content
              : Array.isArray(m.content)
                ? m.content.map((p) => (typeof p === "string" ? p : (p as { text?: string })?.text || "")).join("\n")
                : "";
          return `[${(m.role || "?").toUpperCase()}] ${txt.trim()}`;
        })
        .join("\n\n")
        .slice(0, 60000);
      if (droppedText.trim()) {
        try {
          const date = toISODate(Date.now());
          const archivePath = join(rt.cfg.compaction.archiveDir, `${date}.md`);
          const block =
            `## 📎 maintain 会话轮换归档 · ${(params.sessionKey || params.sessionId || "default")}\n\n` +
            `- **轮换时间**：${new Date().toISOString()}\n` +
            `- **丢弃消息数**：${droppedMsgs.length}（保留尾部 ${msgs.length - droppedMsgs.length} 条）\n\n` +
            `<details>\n<summary>原文（只读存档，不参与上下文）</summary>\n\n${droppedText}\n</details>`;
          void appendToFile(archivePath, block, "context-engine", "maintain 会话轮换归档", `rotate ${params.sessionId}: save ${droppedMsgs.length} msgs`, rt.cfg, rt.log);
        } catch {
          /* 归档失败不阻塞 */
        }
      }

      // 2) 原子重写 transcript 文件：保留 header + prelude(最新各一) + 尾部 keepTail 条 message
      try {
        const originalSize = existsSync(sessionFile) ? statSync(sessionFile).size : 0;
        const header = entries.find((e) => e.type === "session") ?? null;
        // 收集 prelude 最新各一
        const preludeMap = new Map<string, Record<string, unknown>>();
        for (const e of entries) {
          if (e.type !== "message" && (e.type === "model_change" || e.type === "thinking_level_change" || e.type === "session")) {
            preludeMap.set(e.type as string, e);
          }
        }
        // 尾部保留：entries 中从 droppedMsgs 最后那个 message 的 index+1 开始的所有 entry
        const lastDropId = droppedMsgs.length > 0 ? (droppedMsgs[droppedMsgs.length - 1].id as string) : null;
        const lastDropIndex = entries.findIndex((e) => e.id === lastDropId);
        const keepEntries: Array<Record<string, unknown>> = [];
        // prelude（session/model_change/thinking_level_change 各最新一条，若不在尾部保留区则手动放最前）
        for (const type of ["session", "model_change", "thinking_level_change"] as const) {
          const p = preludeMap.get(type);
          if (p) keepEntries.push({ ...p });
        }
        // 从 lastDropIndex+1 到文件尾的全部 entry（含尾部消息 + 后续所有条目）
        for (let i = lastDropIndex + 1; i < entries.length; i++) {
          keepEntries.push({ ...entries[i] });
        }
        // 重新线性化 parentId 链（防 DAG 断裂）：从头串成线性链
        if (keepEntries.length > 0) {
          let prev: string | null = null;
          for (const e of keepEntries) {
            const next = { ...e, parentId: prev };
            prev = typeof e.id === "string" ? (e.id as string) : prev;
            Object.assign(e, next);
          }
        }
        const serialized =
          (header ? JSON.stringify(header) : JSON.stringify({ type: "session", version: 3, id: params.sessionId, timestamp: new Date().toISOString(), cwd: rt.workspaceDir })) +
          "\n" +
          keepEntries.map((e) => JSON.stringify(e)).join("\n") +
          "\n";
        // 原子写：先写临时文件再 rename
        const tmp = `${sessionFile}.rotate-tmp`;
        writeFileSync(tmp, serialized, "utf8");
        renameSync(tmp, sessionFile);
        const newSize = statSync(sessionFile).size;
        result.changed = true;
        result.bytesFreed = Math.max(0, originalSize - newSize);
        result.rewrittenEntries = droppedMsgs.length;
        result.reason = "rotated-transcript";
        rt.log.info(
          `[context-engine] maintain ROTATE done: drop=${droppedMsgs.length} size ${originalSize}->${newSize} freed=${result.bytesFreed} session=${params.sessionId}`,
        );
      } catch (e) {
        result.reason = `rotate-error:${String(e)}`;
        rt.log.warn(`[context-engine] maintain ROTATE error: ${String(e)}`);
      }
      return result;
    },

    async bootstrap(params): Promise<BootstrapResult> {
      const rt = getRuntime();
      void params;
      if (!rt) return { bootstrapped: false, reason: "runtime-unavailable" };
      // 清理该 session 的历史窗口（全新开场）
      try {
        rt.engineDb?.clearCompactionTurns(params.sessionKey ?? params.sessionId);
      } catch {
        /* ignore */
      }
      rt.log.debug(`[context-engine] bootstrap session=${params.sessionId}`);
      return { bootstrapped: true, importedMessages: 0 };
    },

    async ingest(params): Promise<IngestResult> {
      const rt = getRuntime();
      if (!rt || !rt.cfg.enable_context_compaction) {
        return { ingested: false };
      }
      const text = messageText(params.message);
      if (!text.trim()) return { ingested: false };
      const sessionKey = params.sessionKey ?? params.sessionId;
      // 投递后台：不阻塞 ingest 调用方
      import("./compaction.js").then((mod) => {
        mod.onTurn(rt, sessionKey ?? "default", text);
      });
      return { ingested: true };
    },

    async assemble(params): Promise<AssembleResult> {
      const rt = getRuntime();
      const budget = params.tokenBudget ?? 8000;
      const messages = Array.isArray(params.messages) ? params.messages : [];
      if (!rt || !messages.length) {
        return {
          messages,
          estimatedTokens: estimateMessages(messages),
          systemPromptAddition: "",
        };
      }
      // 长度检测：分子/分母优先取真实上下文用量（before_prompt_build 已快照，与 web 面板百分比同源），
      // 避免仅用“本次新消息”估算导致重会话占比被低估、永不达阈值。
      // 兜底：上下文快照不可用时退回“本次消息估算 / 预算”。
      const realUsed = rt.contextUsage?.usedTokens ?? 0;
      const realBudget = rt.contextUsage?.budget ?? 0;
      const tokens = realUsed > 0 ? realUsed : estimateMessages(messages);
      const ratioDenom = realBudget > 0 ? realBudget : budget;
      const ratio = tokens / ratioDenom;

      // 摘要替换（治本：真正把发给模型的那份 messages 瘦身，让占比能降）。
      // 仅当 enable_context_summarize 开启才替换；关=原样透传（行为不变，可回滚）。
      const summarizeEnabled =
        rt.cfg.enable_context_summarize && rt.cfg.enable_context_compaction;
      if (
        summarizeEnabled &&
        ratio >= rt.cfg.compaction.summarizeRatioThreshold
      ) {
        const sessionKey = params.sessionKey ?? "default";
        const res = summarizeOldMessages(rt, params, messages, ratio, sessionKey);
        if (res) {
          // 返回裁剪后的 messages → 占比真降
          return {
            messages: res.messages,
            estimatedTokens: estimateMessages(res.messages),
            systemPromptAddition:
              "（memory-engine：已把最早一段旧对话摘要折叠，原文已存档可回查；不代表其内容已删。）",
          };
        }
      }

      // 未开启摘要替换，或本次未折叠时，保留旧行为：超预算->后台触发压缩（由 compact/afterTurn 落地）
      if (rt.cfg.enable_context_compaction && ratio >= rt.cfg.compaction.lengthThreshold) {
        const sessionKey = params.sessionKey ?? "default";
        import("./compaction.js").then((mod) => {
          // 长度兜底：归档最老段
          const db = rt.engineDb;
          if (db) {
            const turns = db.listCompactionTurns(sessionKey);
            // 依据消息窗口估算的旧段切点：取 recentWindow 之前的全部
            const cutoff = Math.max(
              0,
              turns.length - rt.cfg.compaction.recentWindowForInternal,
            );
            if (cutoff > 0) {
              void mod.compileOldSegmentForArchive(
                rt,
                sessionKey,
                turns,
                cutoff,
              );
            }
          }
        });
      }

      return {
        messages,
        estimatedTokens: tokens,
        systemPromptAddition:
          "（上下文由 memory-engine context 管理，按事件压缩自动瘦身，不丢原文。）",
      };
    },

    async compact(params): Promise<CompactResult> {
      const rt = getRuntime();
      const sessionKey = params.sessionKey ?? "default";
      if (!rt || !rt.cfg.enable_context_compaction || !rt.engineDb) {
        return { ok: false, compacted: false, reason: "not-enabled" };
      }
      try {
        const turns = rt.engineDb.listCompactionTurns(sessionKey);
        const cutoff = Math.max(
          0,
          turns.length - rt.cfg.compaction.recentWindowForInternal,
        );
        if (cutoff > 0) {
          const mod = await import("./compaction.js");
          await mod.compileOldSegmentForArchive(rt, sessionKey, turns, cutoff);
          return { ok: true, compacted: true, reason: "archived-old-topic" };
        }
        return { ok: true, compacted: false, reason: "nothing-to-compact" };
      } catch (e) {
        rt.log.warn(`[context-engine] compact failed: ${String(e)}`);
        return { ok: false, compacted: false, reason: String(e) };
      }
    },

    async afterTurn(params): Promise<void> {
      const rt = getRuntime();
      void params;
      if (!rt || !rt.cfg.enable_context_compaction || !rt.engineDb) return;
      // 长度阈值兜底（后台，不阻塞 turn 流程）
      const sessionKey = params.sessionKey ?? "default";
      const mod = await import("./compaction.js");
      void mod.maybeCompressByLengthPublic?.(rt, rt.engineDb, sessionKey);
    },

    async prepareSubagentSpawn(): Promise<SubagentSpawnPreparation | undefined> {
      return { rollback: () => {} };
    },

    async onSubagentEnded(_params: {
      childSessionKey: string;
      reason: SubagentEndReason;
    }): Promise<void> {
      /* subagent 结束：无额外清理（子代理不共享压缩窗口） */
    },

    async dispose(): Promise<void> {
      /* 无长时句柄需释放 */
    },
  };

  return engine;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 从 AgentMessage 抽文本。 */
function messageText(m: unknown): string {
  if (typeof m === "string") return m;
  const c = (m as { content?: unknown })?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    // TextContent 数组
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

/**
 * 按内容类型加权的 token 估算（对单条文本）。
 *
 * “chars/3” 低估了混合中英的内容：中文/非 ASCII 每个字符常占 1~1.5 token，
 * 而长 ASCII 散文 3.5~4 字符才折 1 token。实测 main 会话 transcript
 * （约 616k 字符 = 82k CJK + 14.7k 其他非 ASCII + 519k ASCII），
 * chars/3 只估出 ~20.6 万，而真实量 ~24 万+（align Web 面板 ctxUsed 43%）。
 * 加权公式：非 ASCII 字符按 ~1.0~1.1 token/字、ASCII 按 1/3.6 token/字，
 * 对当前 transcript 估出 ~25 万（略高于真实值，宁可高估以免漏触发压缩）。
 */
function tokenEstimateOfText(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let otherNonAscii = 0;
  let ascii = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x7f) {
      ascii += 1;
    } else if (code >= 0x4e00 && code <= 0x9fff) {
      // CJK 统一表意文字
      cjk += 1;
    } else {
      otherNonAscii += 1;
    }
  }
  return Math.ceil(cjk * 1.1 + otherNonAscii * 1.0 + ascii / 3.6);
}

/** 估算消息数组 token（逐条按内容类型加权）。 */
function estimateMessages(messages: unknown[]): number {
  if (!Array.isArray(messages)) return 0;
  let tokens = 0;
  for (const m of messages) {
    tokens += tokenEstimateOfText(messageText(m));
  }
  return Math.max(1, tokens);
}

// ---------------------------------------------------------------------------
// assemble 摘要替换（治本：把发给模型的那份 messages 真正瘦身）
// ---------------------------------------------------------------------------

/**
 * 合成摘要用户消息（覆盖旧段）。构造最简合法 UserMessage：
 *   role="user" + content 字符串 + timestamp。
 */
function makeSummaryMessage(
  text: string,
  ts: number,
): { role: "user"; content: string; timestamp: number } {
  return {
    role: "user",
    content: text,
    timestamp: ts,
  };
}

/**
 * 同步地给一段老文本做一个紧凑摘要（不出 LLM，保证 assemble 快速返回）。
 * 策略：截取前 summarizeMaxChars 字符的"总起 + 逐条头"，保留关键句，防把摘要又写爆。
 * 返回格式：一个带头部说明的摘要块。
 */
function summarizeSectionSync(text: string, maxChars: number): string {
  const t = text.trim();
  if (!t) return "（无可摘要内容）";
  const cap = Math.max(maxChars, 200);
  // 按行保留，取前若干行拼一块；超出则截断并标注省略
  const lines = t.split(/\n+/).filter((l) => l.trim());
  let out = "【已折叠旧对话摘要】";
  let used = out.length;
  for (const line of lines) {
    const ln = line.trim();
    if (!ln) continue;
    const add = used > 0 ? "\n" + ln : ln;
    if (used + add.length > cap) {
      out += "\n…（其余已存档，可回查原文）";
      break;
    }
    out += add;
    used += add.length;
  }
  return out;
}

// 摘要缓存：sessionKey -> contentHash(旧段原文) -> { text, ts }。
// 供后台 LLM distill 完成后，下次 assemble 用上更好的摘要。
// 借鉴 Mnemosyne LRU：外层 session 数也有硬上限 + 按旧淘汰，防无界增长（治内存）
const SUMMARIZE_CACHE = new Map<
  string,
  Map<string, { text: string; ts: number }>
>();
// 外层(不同 session)缓存上限：超过则淘汰最旧的 session 整体。
const SUMMARIZE_CACHE_MAX_SESSIONS = 32;

function summarizeCacheGetSession(sessionKey: string) {
  const byHash = SUMMARIZE_CACHE.get(sessionKey);
  return byHash;
}
function summarizeCacheSetSession(sessionKey: string, byHash: Map<string, { text: string; ts: number }>) {
  // 超上限：淘汰最旧的 session（按外层 Map 插入序，先入先淘汰）
  if (SUMMARIZE_CACHE.size >= SUMMARIZE_CACHE_MAX_SESSIONS) {
    const oldest = SUMMARIZE_CACHE.keys().next().value;
    if (oldest !== undefined) SUMMARIZE_CACHE.delete(oldest);
  }
  SUMMARIZE_CACHE.set(sessionKey, byHash);
}

function summaryFromCache(
  sessionKey: string,
  hash: string,
  maxAgeMs: number,
): string | null {
  const byHash = summarizeCacheGetSession(sessionKey);
  if (!byHash) return null;
  const e = byHash.get(hash);
  if (!e) return null;
  if (maxAgeMs > 0 && Date.now() - e.ts > maxAgeMs) {
    byHash.delete(hash);
    if (byHash.size === 0) SUMMARIZE_CACHE.delete(sessionKey);
    return null;
  }
  return e.text;
}

function summaryStore(sessionKey: string, hash: string, text: string): void {
  let byHash = summarizeCacheGetSession(sessionKey);
  if (!byHash) {
    byHash = new Map();
    summarizeCacheSetSession(sessionKey, byHash);
  }
  byHash.set(hash, { text, ts: Date.now() });
  // 每 session 最多留 8 个历史摘要，超则丢最旧（防单会话无界增长）
  if (byHash.size > 8) {
    const oldest = byHash.keys().next().value;
    if (oldest) byHash.delete(oldest);
  }
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * 在 tokenBudget 约束内，把最老一段超长消息折叠成合成摘要消息替换，返回裁剪后的消息集。
 * 不折叠（预算内/老段不足/无有效文本）则返回 null，调用方保持原样。
 *
 * 非阻塞保证：
 *   - 同步返回裁剪结果（摘要用同步摘要，毫秒级），绝不让 assemble 等 LLM。
 *   - 更高质量的 LLM 提炼 + 原文折叠归档放后台投递，不阻塞返回路径、不丢原文。
 *
 * @param messages 原始消息（assemble 收到的 AgentMessage[]，此处作 unknown 处理）。
 */
function summarizeOldMessages<M>(
  rt: RuntimeContext,
  params: { tokenBudget?: number },
  messages: M[],
  ratio: number,
  sessionKey: string,
): { messages: M[] } | null {
  const cfg = rt.cfg.compaction;
  const minOld = Math.max(cfg.summarizeMinOldMessages, 2);
  if (messages.length < minOld) return null;

  // ---- 按比例压缩：把上下文占比压到 summarizeTargetRatio(15%) 以下 ----
  // budget 取系统上下文预算（rt.contextUsage），Web 端"已用/预算"的预算那一端。
  const realBudget = rt.contextUsage?.budget ?? 0;
  const budget =
    (typeof params.tokenBudget === "number" && params.tokenBudget > 0
      ? params.tokenBudget
      : realBudget) || rt.cfg.compaction.contextTokenBudget;
  const targetRatio = Math.max(
    0.05,
    adjustTargetRatio(cfg.summarizeRatioThreshold, cfg.summarizeTargetRatio),
  );
  const targetTokens = budget > 0 ? Math.floor(budget * targetRatio) : 0;

  // 当前总 token（估算）：assemble 折叠的是 messages 数组本身，故用 messages 估算作基准。
  // （ctxUsed 是完整上下文占比，用于 maintain/后台轮换；assemble 只处理本次 messages 瘦身）
  const curTokens = estimateMessages(messages);
  // 已达标（≤15%）：无需压缩
  if (budget > 0 && curTokens <= targetTokens) return null;

  // 从最老消息依次折叠成摘要，每折一批重估总 token，直到压到 targetTokens 以下。
  // 摘要乐观估 1 条（≤summarizeMaxChars 字符），折叠后总 token = 保留原文 + 摘要。
  const foldList: M[] = [];
  let foldedText = "";
  let keepTokens = curTokens;
  for (let i = 0; i < messages.length - 4; i++) {
    const m = messages[i];
    const txt = messageText(m);
    if (!txt.trim()) continue;
    // 落入折叠段：其 token 从总额中扣除（后面统一按摘要计数）
    keepTokens -= Math.max(1, tokenEstimateOfText(txt));
    foldList.push(m);
    foldedText = foldedText ? foldedText + "\n" + txt : txt;
    // 折叠段至少 minOld 条才动手（尊重原约束，避免只折 1-2 条碎片）
    if (foldList.length >= minOld && keepTokens <= targetTokens) break;
  }

  // 折叠段过小（不足 minOld）或不产生净减：放弃本次，保持原样（让后台 maintain 处理）
  if (foldList.length < minOld || foldedText.trim() === "") return null;

  const oldText = foldedText;
  const hash = hashOf(oldText);
  // 优先用缓存里的 LLM 摘要；否则同步速出（真实占比已超阈值，务必立刻降下来）
  const cached = summaryFromCache(sessionKey, hash, 12 * 60 * 60 * 1000);
  const summary = cached ?? summarizeSectionSync(oldText, cfg.summarizeMaxChars);

  const summaryMsg = makeSummaryMessage(
    summary,
    typeof foldList[0] === "object" && foldList[0] != null
      ? ((foldList[0] as { timestamp?: number }).timestamp ?? Date.now())
      : Date.now(),
  ) as unknown as M;
  // 折叠掉最老 foldList.length 条，替换为 1 条摘要（保序）
  const replaced = messages.slice(foldList.length);
  const newMessages = [summaryMsg, ...replaced];
  const newTokens = estimateMessages(newMessages);

  rt.log.info(
    `[context-engine] summarize: ratio=${ratio.toFixed(3)}>=${cfg.summarizeRatioThreshold}, ` +
      `collapsed ${foldList.length} oldest msgs -> 1 summary, target<=${targetTokens}(${targetRatio * 100}%), ` +
      `msgs ${messages.length}->${newMessages.length}, ` +
      `tokens ~${curTokens}->~${newTokens}${newTokens <= targetTokens ? " ✅≤target" : " ⚠may-exceed"}`,
  );

  // 后台：LLM 高质量提炼 + 原文折叠归档（不丢原文铁律）。不阻塞返回。
  if (!cached) {
    void distillInBackground(rt, sessionKey, oldText, hash);
  }
  return { messages: newMessages };
}

/**
 * 后台提炼 + 归档：
 *   1) LLM distillText 把老段提炼成紧凑要点（带硬超时，失败安全降级）；
 *   2) 提炼成功则缓存命中，供下次 assemble 用上更好摘要；
 *   3) 原文 appendToFile 折叠存档到 memory/events/。
 * 全程不抛、不阻塞消息路径。
 */
async function distillInBackground(
  rt: RuntimeContext,
  sessionKey: string,
  oldText: string,
  hash: string,
): Promise<void> {
  try {
    const cfg = rt.cfg;
    const distilled = await distillText(
      { ...cfg.emotion, timeoutMs: cfg.compaction.llmTimeoutMs, log: rt.log },
      oldText,
    );
    const clean = (distilled ?? "").trim();
    if (clean && clean !== "-") {
      summaryStore(sessionKey, hash, `【已折叠旧对话摘要】\n${clean}`);
    }

    // 原文折叠存档（append-only，不丢原文；用 appendToFile 走写前备份+改动日志）
    const date = toISODate(Date.now());
    const archivePath = join(cfg.compaction.archiveDir, `${date}.md`);
    const block =
      `## 📎 assemble 折叠原文 · ${sessionKey}\n\n` +
      `- **折叠时间**：${new Date().toISOString()}\n` +
      (clean ? `- **提炼要点**：\n${clean}\n\n` : "- **提炼要点**：（LLM 未产出，仅存档原文）\n\n") +
      `<details>\n<summary>原文（只读存档，不参与上下文）</summary>\n\n${oldText}\n</details>`;
    appendToFile(
      archivePath,
      block,
      "context-engine",
      "assemble 折叠原文归档",
      `assemble summarize ${sessionKey}: ${(clean || oldText).slice(0, 60)}`,
      cfg,
      rt.log,
    );
  } catch (e) {
    rt.log.debug(`[context-engine] distill/archive bg failed: ${String(e)}`);
  }
}

/**
 * 方案 A：压缩落点目标占比（锯齿形：超 lengthThreshold 触发 → 压回到 target）。
 * 触发线 0.25、落点 0.12（整体在 15%~20% 波动）。
 * target 取配置 summarizeTargetRatio（默认 0.12），缺失回退×0.85 可回滚。
 * 落点必须严格 < 触发线，`threshold - 0.01` 保险防止配置误设≥触发线导致死循环压缩。
 * 返回 [0.05, min(target, threshold-0.01)]。
 */
function adjustTargetRatio(threshold: number, target?: number): number {
  const t = typeof threshold === "number" && threshold > 0 ? threshold : 0.25;
  const r =
    typeof target === "number" && target > 0 ? target : t * 0.85;
  return Math.max(0.05, Math.min(r, t - 0.01));
}
