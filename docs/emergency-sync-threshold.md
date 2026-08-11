# Design: `emergencySyncThreshold` — 紧急同步压缩兜底

> 状态：**Planned**（已定稿接口/行为，待实现）
> 提案来源：外部开发者评审反馈（"压缩跟不上时 1M 上下文也会爆"）+ 项目方实测确认必要性
> 关联：`compaction.lengthThreshold` / `runtime.contextUsage` / `runtimeContext.tokenBudget`（模型窗口自动跟随）

## 问题

memory-engine 的压缩是**尽力而为的后台异步任务**。正常情况下它追得上生产速度，但在极端场景——用户刷屏式连续发送、或一次 run 里要压缩的旧话题特别多——后台压缩可能追不上消息增长，导致上下文占比持续爬升，逼近模型窗口上限。此时不能让上下文爆掉。

## 已实测的前提（2026-08-11 真实环境验证）

memory-engine 接管 contextEngine 后声明 `ownsCompaction: true`，OpenClaw 系统会**跳过自己的预占式压缩兕底**（`selection.js` 中 `context-overflow-precheck skipped: context engine owns compaction`）。因此 memory-engine 必须自己扛起超预算兕底责任。

同时已实测确认：**压缩判据分母 `runtimeContext.tokenBudget` 随当前活动模型自动变化**（DeepSeek 1M → 900000；临时调 MIMO 800k → 720000），即大→小模型切换时分母自动变小，压缩阈值自动提前——**不会因模型切换而爆上下文**（无需手动改配置）。emergencySyncThreshold 在此基础上提供**最后的同步保命兜底**。

## 目标

提供一个**可配置的硬兜底**：当上下文占比达到一个危险阈值（`emergencySyncThreshold`）时，**临时切换到同步模式强制压缩一次**——哪怕这会让当前这次调用卡上一会儿，也比直接爆上下文、丢整个会话强。

## 接口

新增配置字段（顶层 `compaction` 子对象）：

| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `emergencySyncThreshold` | float | `0.50`（默认**开**） | 上下文占比 ≥ 此值时，触发一次**同步强制压缩**。**默认 0.50、不可更大**（50% 已足够保护，更大则触发放过晚）。`0` 可显式关闭。 |

预设建议值：预设 A（标准）`0.50`、预设 B（低资源）`0.50`（低资源压缩更慢，也可视情况 `0.40` 更早兕底）、预设 C（最小可用）不启用（`0`，因为不开压缩模块）。

## 触发时机

在 `runtime.contextUsage` 快照就绪的 run 里，`assemble`/hook 阶段判断：

```
if emergencySyncThreshold > 0 AND ctx.currentUsage / ctx.budget >= emergencySyncThreshold:
    执行一次同步压缩（阻塞当前 run 直到完成）
```

## 行为定义

1. **只在占比 ≥ 阈值时触发**，否则完全不影响正常路径（默认 0 = 永不触发）。
2. **同步**：调用方 `await` 压缩完成，而不是丢后台。压缩期间当前 run 会短暂等待（这是刻意的——保命优先）。
3. **复用既有压缩管线**：不走新压缩算法，直接调用现有 `compactOldestSegment()`（同 `mem_compact` 的语义），保证一致的提炼/归档/去重/原文保留行为。
4. **限流仍生效**：即使同步，`maxCompactionsPerMinute` 仍适用，避免连续多轮同步压导致 CPU 打满。
5. **压一次即可**：一次紧急同步压完，占比回落，本轮不再重复触发；留给下一个 run 判断。
6. **日志**：以 `[emergency-sync]` 前缀记录触发时的占比、压了多少段、压后占比。

## 安全性

- 默认 **关**（`0`），不影响既有用户。
- 同步阻塞是**刻意的**：宁可单次调用慢几秒，不冒爆上下文的险。README 的"绝不阻塞消息路径"铁律在**紧急兜底**场景明确豁免（并文档化原因）。
- 只读安全 / 写前备份 / 可回滚等既有护栏全部继承。

## 实现要点（供实现时参考）

- 在 `src/modules/compaction.ts` 的 `assemble` 或对应 hook 里，`runtime.contextUsage` 快照就绪后读取该阈值。
- 新增字段：`src/config.ts` 的 `CompactionConfig` + `openclaw.plugin.json` 的 `configSchema`（保持 CLI/Web 可配）。
- 预设 `presets/*.json` 已预留该字段，实现后无需改动预设。
- 测试：构造高占比快照 → 验证触发同步压缩、占比回落、默认关闭时不影响。

## 验收标准

- [ ] `emergencySyncThreshold = 0` 时不触发任何同步压缩（默认行为不变）。
- [ ] 占比 ≥ 阈值时，执行一次同步压缩且当前 run 等待其完成。
- [ ] 限流：连续高占比时受 `maxCompactionsPerMinute` 约束，不连压打满 CPU。
- [ ] 归档/提炼/去重/原文保留与正常压缩一致。
- [ ] 预设 A/B/C 的字段值与设计一致。
