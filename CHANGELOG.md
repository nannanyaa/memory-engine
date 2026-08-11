# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0-beta.1] - 2026-08-11

### ✨ 新增

- **会话活跃守卫（guardWindowMs）**：压缩重写 transcript 前先判断会话是否活跃（距最后一次 run 不足 `guardWindowMs` 毫秒则跳过本轮重写）。避免压缩撞上进行中的工具调用、吞掉 `tool result` 导致"说着做着却 lost result"。
- **新增记忆架构·基础自建指南（README §5.9）**：系统讲清三层记忆体系（原文录像 / 蒸馏智慧 / 多维抽屉）+ agent 需先自建的目录与文件模板 + 如何对接插件并直接走版本升级。记忆架构是"地基"，插件是"工具"，**先自建、再装插件、再谈升级**。

### 🐛 修复

- **keepTail 压缩 bug（"压不下来"）**：keepTail 计算曾用"含系统提示+工具的 tokenCount"作起点、目标却不含 overhead，导致看似大幅降 token、实际 transcript 文件只 freed 几 KB。已统一为**纯消息 token 口径**，压得下来、文件真瘦。
- **手动压缩不同步**：`mem_compact` 原走异步事件感知归档、不重写 transcript、调用方立即返回。已抽出 `reduceAndRewrite` 并让 `mem_compact` **同步重写 transcript**、返回**真实 freed bytes**，可确认真降窗口占用。
- **主触发线错用 emergency 阈值（"压缩没接入"）**：maintain 判据误用 `emergencySyncThreshold(0.5)` 作主触发线，导致 25%~50% 区间（如 49%）返回 below-threshold 不压。已改回用 `lengthThreshold(0.25)` 常规触发，`emergency(0.5)` 降级为**强制同步兜底**（ratio≥0.5 强制压）。
- **快照不稳定性（Web 面板百分比横跳）**：`before_prompt_build` 的 `event.prompt` 为空时会把快照写成 0/低值，触发 assemble 反复折叠 → Web 显示 20%↔49% 乱跳。已保证快照空 prompt 时至少保留 baseTokens，不再落 0。
- **`agent_end` 覆盖权威快照**：`agent_end` 的快照基准与 `before_prompt_build`(完整 prompt) 不同，会互相覆盖导致 usedTokens 跳变。改为 `before_prompt_build` 为唯一权威写入源，`agent_end` 仅刷新会话活跃时间戳（`touchActive`）。
- **记忆提炼记"话"不记"事"**：
  - `memory_promotion` 现把高投入内容蒸馏成**事情框架**（事项/完成度/后续/关键节点）落盘，不再拼接原始对话碎片；蒸馏失败降级为来源指针+摘要，绝不回退成抄原文。
  - `emotion` 仅对**高价值情感**入选（爱慕/依赖/失落/难受等，`HIGH_VALUE_DIMS`），落盘保留**场景+原话**，非确定情感句不入。
- **校正系数（promptEstimateCorrection）**：新增可配置的 `promptEstimateCorrection`（默认 0.7，可设 1 关闭），用于压低"完整 prompt 估算"的偏高、贴近真实占比。注意：该值若压过头可能让压缩永不触发（矫枉过正），生产上应校准；**本次主触发线修复已保证长度阈值正常触发**。

### ⚠️ 已知 / 注意

- `promptEstimateCorrection` 需要在实例上按真实上下文校准：默认 0.7 可能对部分环境偏低（把占比压到 baseTokens 附近导致压缩不触发），按需调回 0.9~1.0。
- `slots.contextEngine` 需设为 `memory-engine-context` 才能接管上下文；`enable_context_compaction` + `enable_context_summarize` 同时开启才走接管压缩。

### 📚 文档

- README 新增 **§5.9 记忆架构·基础自建指南**（三层体系 + 自建清单 + 对接升级）。
- `docs/emergency-sync-threshold.md`：补全紧急同步压缩兜底的设计说明（含 0.50 上限、与长度/摘要阈值关系、活跃守卫联动）。
