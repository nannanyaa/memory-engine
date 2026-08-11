/**
 * tools.ts — memory-engine 暴露给 Agent 的手动工具
 *
 * 四个只读/半主动工具（与 openclaw.plugin.json contracts.tools 声明一致）：
 *   - mem_find    : 检索（lossless 原文 + 可选语义向量），调 recall.memFind
 *   - mem_status  : 读当前状态：情感锚点 / 高投入事项 / 引擎开关（只读）
 *   - mem_promote : 半主动提拔（里程碑级 P2 确认用）：把指定情感锚点标记为已提拔
 *   - mem_rollback: 回滚：把标记为已提拔(distinct target)的条目取消提拔标记
 *
 * 设计原则（与整插件一致）：
 *   - 纯观察/半主动，不碰 openclaw.json / lossless 源码 / AGENTS/MEMORY/USER/tasks 机制文件。
 *   - mem_promote / mem_rollback 只操作"引擎自己的标记表"（engine-db 的 promoted 记录），
 *     不改写记忆正文——写正文仍走记忆引擎(enable_memory_promotion)的自动草案 + 人工落笔。
 *   - 开关未开时仍可查询（读库本身廉价），但写入类操作需确认配置。
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { getRuntime, currentConfig } from "./runtime.js";
import { memFind } from "./modules/recall.js";
import { forceCompress } from "./modules/compaction.js";
import { compactSessionTranscript } from "./modules/context-engine.js";
import { MODULE_KEYS } from "./config.js";

/** 统一文本返回格式（match registerTool 契约：AgentToolResult 需含 details）。 */
function textReply(text: string): { content: Array<{ type: "text"; text: string }>; details: null } {
  return { content: [{ type: "text", text }], details: null };
}

export function registerTools(api: OpenClawPluginApi): void {
  // ---- mem_find：检索（原文 + 可选语义向量）----
  api.registerTool(
    {
      name: "mem_find",
      label: "记忆检索（mem_find）",
      description:
        "记忆检索：在 lossless 原文 + 引擎索引里按查询词召回匹配片段。" +
        "开启 enable_semantic_vector 时增加语义向量召回。适用于'我/阁下说过什么、某事细节'的追溯。",
      parameters: Type.Object({
        query: Type.String({ description: "检索词（关键词/短语）" }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "返回条数上限(1-20)，默认8" })),
      }),
      async execute(_id, params) {
        const rt = getRuntime();
        if (!rt) return textReply("mem_find: engine not initialized (gateway not started)");
        const query = String((params as { query?: string })?.query ?? "");
        const limit = Number((params as { limit?: number })?.limit ?? 8);
        if (!query.trim()) return textReply("mem_find: empty query");
        const out = await memFind(rt, { query, limit });
        return textReply(out);
      },
    },
    { optional: true },
  );

  // ---- mem_status：只读状态面板 ----
  api.registerTool(
    {
      name: "mem_status",
      label: "记忆引擎状态面板（mem_status）",
      description:
        "读取 memory-engine 当前状态：六个引擎开关是否启用、情感锚点数、高投入事项清单。" +
        "只读，不改任何数据。用于'插件开没开、记了什么'的体检。",
      parameters: Type.Object({
        detail: Type.Optional(
          Type.Enum(
            { summary: "summary", anchors: "anchors", engagement: "engagement", all: "all" },
            { description: "明细粒度：summary=开关概览(默认)；anchors=情感锚点；engagement=高投入事项；all=全部" },
          ),
        ),
      }),
      async execute(_id, params) {
        const rt = getRuntime();
        const cfg = currentConfig();
        if (!rt || !cfg) return textReply("mem_status: engine not initialized");

        const detail = String((params as { detail?: string })?.detail ?? "summary");
        const lines: string[] = [];

        // 开关概览
        lines.push("【memory-engine 开关】");
        for (const key of MODULE_KEYS) {
          const raw = cfg as unknown as Record<string, boolean>;
          const v = raw[key];
          lines.push(`  - ${key}: ${v ? "ON" : "off"}`);
        }

        if (detail === "summary") return textReply(lines.join("\n"));

        // 情感锚点
        if (detail === "anchors" || detail === "all") {
          lines.push("", "【情感锚点 active】");
          const db = rt.engineDb;
          if (!db) {
            lines.push("  (engine-db 未就绪)");
          } else {
            const anchors = db.listActiveAnchors(20);
            if (anchors.length === 0) lines.push("  (空)");
            for (const a of anchors) {
              lines.push(
                `  #${a.id} [${a.category}/${a.kind}]${a.milestone ? " ⭐" : ""} ${a.text.slice(0, 40)}`,
              );
            }
          }
        }

        // 高投入事项
        if (detail === "engagement" || detail === "all") {
          lines.push("", "【高投入事项（超阈值）】");
          const db = rt.engineDb;
          if (!db) {
            lines.push("  (engine-db 未就绪)");
          } else {
            const highs = db.listHighEngagement({
              minTurns: cfg.engagement.minTurns,
              minTimeWindows: cfg.engagement.minTimeWindows,
              minTokens: cfg.engagement.minTokens,
            });
            if (highs.length === 0) lines.push("  (当前无超标项)");
            for (const h of highs) {
              lines.push(
                `  ${h.topic}: turns=${h.turn_count} windows=${h.time_window_count} tokens=${h.token_count}`,
              );
            }
          }
        }

        return textReply(lines.join("\n"));
      },
    },
    { optional: true },
  );

  // ---- mem_promote：半主动提拔标记（里程碑 P2 确认，只动引擎标记表）----
  api.registerTool(
    {
      name: "mem_promote",
      label: "标记情感锚点为已提拔（mem_promote）",
      description:
        "把指定情感锚点(anchorId)标记为'已提拔到权威层'。" +
        "只写引擎自身的 promoted 标记，不直接改写 MEMORY/USER 正文——正文落笔由记忆引擎草案+人工确认。" +
        "用于'这条情感已确认进权威档案'的台账。",
      parameters: Type.Object({
        anchorId: Type.Integer({ description: "情感锚点 id（mem_status detail=anchors 可查）" }),
        target: Type.Optional(Type.String({ description: "提拔去向，如 MEMORY.md / USER.md / AGENTS.md（仅台账记录用）" })),
      }),
      async execute(_id, params) {
        const rt = getRuntime();
        if (!rt?.engineDb) return textReply("mem_promote: engine-db not ready");
        const p = params as { anchorId?: number; target?: string };
        const id = Number(p.anchorId ?? NaN);
        if (!Number.isFinite(id) || id <= 0) return textReply("mem_promote: invalid anchorId");
        const target = (p.target ?? "MEMORY.md").trim();
        rt.engineDb.setPromoted(`anchor:${id}`, target);
        return textReply(`mem_promote: anchor #${id} -> promoted@${target}（已记录，正文落笔需在权威文件确认）`);
      },
    },
    { optional: true },
  );

  // ---- mem_rollback：取消提拔标记（引擎台账回滚）----
  api.registerTool(
    {
      name: "mem_rollback",
      label: "取消情感锚点提拔标记（mem_rollback）",
      description:
        "把指定情感锚点(anchorId)的'已提拔'标记取消，台账回滚到未提拔态。" +
        "只动引擎标记表，不回滚权威文件正文——正文如需撤销请到对应文件手动处理。",
      parameters: Type.Object({
        anchorId: Type.Integer({ description: "情感锚点 id" }),
        rerunAll: Type.Optional(Type.Boolean({ description: "(预留) true 时清理全部已提拔标记；默认只取消单个" })),
      }),
      async execute(_id, params) {
        const rt = getRuntime();
        if (!rt?.engineDb) return textReply("mem_rollback: engine-db not ready");
        const id = Number((params as { anchorId?: number })?.anchorId ?? NaN);
        if (!Number.isFinite(id) || id <= 0) return textReply("mem_rollback: invalid anchorId");
        // engine-db 面向清单方法：这里用 setPromoted 写回空目标 = 取消标记
        // （isPromoted 判定 target 非空；置空即视为未提拔）
        rt.engineDb.setPromoted(`anchor:${id}`, "");
        return textReply(`mem_rollback: anchor #${id} 已取消提拔标记（引擎台账）`);
      },
    },
    { optional: true },
  );

  // ---- mem_compact：手动触发上下文压缩（force）----
  api.registerTool(
    {
      name: "mem_compact",
      label: "手动压缩上下文（mem_compact）",
      description:
        "主动触发上下文压缩。同步走 context-engine 的 ROTATE 核心（保留 header+prelude+尾部最近若干条 message，" +
        "前段原文先归档到 memory/events，再原子重写 transcript）——同步完成、返回真实释放的字节(文件 size 差)，" +
        "可确认是否真降窗口占用。无法定位 transcript 时回退到事件管道归档。" +
        "适合 agent 主动收拢长会话、归备案结话题。未开启 enable_context_compaction 亦可作为手动归档能力。",
      parameters: Type.Object({
        sessionKey: Type.Optional(
          Type.String({ description: "目标会话 key（如 agent:main:main）。默认取 main 会话" }),
        ),
        keepRecent: Type.Optional(
          Type.Integer({
            minimum: 2,
            maximum: 50,
            description: "保留尾部最近几条 message 不压缩（默认 8）",
          }),
        ),
        sessionFile: Type.Optional(
          Type.String({ description: "(可选) 指定 transcript 文件绝对路径，跳过自动解析" }),
        ),
      }),
      async execute(_id, params) {
        const rt = getRuntime();
        if (!rt) return textReply("mem_compact: engine not initialized");
        const p = params as { sessionKey?: string; keepRecent?: number; sessionFile?: string };
        const sessionKey = (p.sessionKey ?? "agent:main:main").trim() || "default";

        // 同步走 context-engine ROTATE 核心（返回真实字节 freed）
        const sync = compactSessionTranscript(rt, {
          sessionKey,
          keepRecent: p.keepRecent,
          sessionFile: p.sessionFile,
        });
        const lines = [
          `mem_compact: ${sync.ok ? "✅ 已压缩（同步完成）" : "ℹ️ 未压缩"}`,
          `  - session: ${sessionKey}`,
          `  - transcript: ${sync.sessionFile ?? "(未解析)"}`,
          `  - 结果: ${sync.reason}`,
          `  - 释放字节: ${sync.bytesFreed}B${sync.bytesFreed > 0 ? ` (${(sync.bytesFreed / 1024).toFixed(1)}KB)` : ""}\t真实文件 size 差，可确认窗口占用降幅`,
          `  - 丢弃消息: ${sync.droppedCount} | 保留尾部: ${sync.keptCount}`,
        ];

        // 无 transcript 可旋转时：回退到 legacy 事件管道归档（仍尽力归案）
        if (!sync.ok && sync.reason === "no-session-transcript-resolved") {
          if (!rt.engineDb) return textReply(lines.join("\n") + "\n（engine-db 未就绪，无法回退归档）");
          const origKeep = rt.cfg.compaction.recentWindowForInternal;
          if (typeof p.keepRecent === "number" && Number.isFinite(p.keepRecent)) {
            rt.cfg.compaction.recentWindowForInternal = Math.max(2, Math.min(50, Math.floor(p.keepRecent)));
          }
          let res;
          try {
            res = await forceCompress(rt, sessionKey);
          } finally {
            rt.cfg.compaction.recentWindowForInternal = origKeep;
          }
          lines.push(`  - 回退事件管道: ${res.reason}（归档轮数 ${res.archivedTurns} / 保留 ${res.keptTurns}）`);
          if (res.skippedDedup) lines.push("  - ⚠️ 命中去重：该段原文已归档过，跳过重复压缩");
        }

        return textReply(lines.join("\n"));
      },
    },
    { optional: true },
  );
}
