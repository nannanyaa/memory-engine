/**
 * memory-engine — OpenClaw 通用记忆决策引擎插件
 *
 * 纯 hook 插件，不抢 contextEngine / memory slot，与 lossless-claw 正交共存。
 * 每个功能模块有独立 enable_* 开关，默认全部 false，逐个开测极限。
 *
 * 架构（经拍板）：
 *   - 半自动自进化（日志汇报改动点 + 可手动回退，不走前置审批）
 *   - 语义向量必上（云 embedding，本地存向量）
 *   - 情感识别上模型（LLM 分类，不设规则闸门）
 *   - 独立 memory-engine.db（只读打通 lossless 的 lcm.db）
 *   - 情感锚点 = 固定锚点 + 场景激活双轨
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerHooks } from "./src/registry.js";
import { createLogger } from "./src/log.js";

export default definePluginEntry({
  id: "memory-engine",
  name: "Memory Engine",
  description:
    "通用记忆决策引擎插件：情感识别三层记住法 + 投入度晋升 + 主动预拉检索 + 每日落盘兑底 + 夜间自进化提案（纯 hook，独立 enable_* 开关，不惰 contextEngine/memory slot，与 lossless-claw 正交共存）。",
  register(api) {
    // 纯 hook 纯观察/加工，不抢任何 slot。
    void api;
    // 每个 hook 的事件 ctx.pluginConfig 携带该插件的解析后配置，
    // 模块门控（enable_*）在 handler 内部读取，默认全关。
    const log = createLogger("memory-engine");
    registerHooks(api, log);
  },
});
