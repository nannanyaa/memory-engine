/**
 * lancedb-shim.d.ts — @lancedb/lancedb 可选 peer dep 的类型兜底
 *
 * @lancedb/lancedb 在 package.json 里标记为 optional，本质是 lazy 加载：
 *   - 已安装：真实类型由其自带 .d.ts 提供（真实 JS 加载路径不受本文件影响）。
 *   - 未安装：本声明让 TS 类型检查通过（vector 模块运行时已用 try/catch 降级为空），
 *     不阻断插件主流程 build/typecheck。
 *
 * 说明：这是"降级方案"（任务 #6 允许：@lancedb 缺失可降级绕过，但要标注）。
 * 若后续真正接入 lancedb，删除本文件即可恢复真实类型。
 */
declare module "@lancedb/lancedb" {
  const lancedb: any;
  export = lancedb;
}
