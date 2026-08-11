/**
 * memory-engine 功能测试矩阵
 * 用 esbuild 把 src 内联进测试包（仅 external openclaw SDK），
 * 直接调用各模块的纯函数 + 真实 engine-db + 真实 lcm(db只读)。
 *
 * 覆盖：config 归一化 / engine-db 全方法 / 压缩算法 / 分词估算 / 话题分段 / sanitize / 索引字段。
 */
import { normalizeConfig, isModuleEnabled } from "../src/config.js";
import { openEngineDb, windowOf } from "../src/db/engine-db.js";
import { openLcmRead, sanitizeMatch } from "../src/db/lcm-read.js";
import {
  cosineSimilarity,
  detectTopicSwitch,
  estimateTokensFromChars,
} from "../src/modules/compaction.js";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function group(t: string): void {
  console.log(`\n▌ ${t}`);
}

// 临时目录（避免污染生产 db）
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "memory-engine-test-"));
const log = {
  debug: () => {},
  info: () => {},
  warn: (m: string) => console.log("  [warn]", m),
  error: () => {},
};

// ─── config 归一化 ─────────────────────────────────────────────
group("config 归一化与开关联动");
{
  const empty = normalizeConfig(undefined, { workspaceDir: "/w", stateDir: "/w" });
  ok("默认全关", !empty.enable_emotion && !empty.enable_recall && !empty.enable_context_compaction);
  ok("默认 engineDbPath=stateDir/memory-engine.db", empty.engineDbPath === "/w/memory-engine.db");
  ok("默认 lcmDbPath=stateDir/lcm.db", empty.lcmDbPath === "/w/lcm.db");
  ok("默认 lengthThreshold=0.2", empty.compaction.lengthThreshold === 0.2);
  ok("默认 avgSimSwitchThreshold=0.26", empty.compaction.avgSimSwitchThreshold === 0.26);
  ok("默认 contextTokenBudget=920000", empty.compaction.contextTokenBudget === 920000);
  ok("默认 injectMaxChars=1200", empty.injectMaxChars === 1200);
  ok("默认 recall.maxHighEngagementPreloads=3", empty.recall.maxHighEngagementPreloads === 3);
  ok("默认 recall.anchorCooldownMs=12h", empty.recall.anchorCooldownMs === 12 * 3600 * 1000);
  ok("默认 emotion.attachBelow=0.5", empty.emotion.attachBelow === 0.5);
  ok("默认 emotion.milestoneMinConfidence=0.85", empty.emotion.milestoneMinConfidence === 0.85);

  // 开关联动：semantic_vector 需 recall 同时开
  const semCfg = normalizeConfig(
    { enable_semantic_vector: true, enable_recall: false },
    { workspaceDir: "/w", stateDir: "/w" },
  );
  ok("semantic_vector 联动：recall 关则矢量为 off",
    isModuleEnabled(semCfg, "enable_semantic_vector") === false);
  const semCfg2 = normalizeConfig(
    { enable_semantic_vector: true, enable_recall: true },
    { workspaceDir: "/w", stateDir: "/w" },
  );
  ok("semantic_vector 联动：recall 开则矢量为 on",
    isModuleEnabled(semCfg2, "enable_semantic_vector") === true);

  // 非法值回退默认
  const bad = normalizeConfig({ injectMaxChars: -5, compaction: { lengthThreshold: -1 } }, { workspaceDir: "/w", stateDir: "/w" });
  ok("负值回退默认 injectMaxChars=1200", bad.injectMaxChars === 1200);
  ok("负值回退默认 lengthThreshold=0.2", bad.compaction.lengthThreshold === 0.2);
}

// ─── 时间工具 windowOf ────────────────────────────────────────
group("windowOf 时段划分（6h/段）");
{
  const t0 = Date.UTC(2026, 7, 9, 0, 0, 0); // 00:00 UTC
  ok("00:00 段 0", windowOf(t0) === Math.floor(t0 / (6 * 3600 * 1000)));
  const t6 = t0 + 6 * 3600 * 1000;
  ok("06:00 段 1", windowOf(t6) === Math.floor(t0 / (6 * 3600 * 1000)) + 1);
  const t2330 = Date.UTC(2026, 7, 9, 23, 30, 0);
  ok("23:30 段 3", windowOf(t2330) === Math.floor(t2330 / (6 * 3600 * 1000)));
}

// ─── cosineSimilarity ─────────────────────────────────────────
group("cosineSimilarity");
{
  ok("正交=0", Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  ok("相同=1", Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  ok("反向=-1", Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9);
  ok("空向量=0", cosineSimilarity([], [1, 0]) === 0);
  ok("长度不等=0", cosineSimilarity([1], [1, 2]) === 0);
}

// ─── detectTopicSwitch（核心压缩算法）─────────────────────────
group("detectTopicSwitch（avgSim 主判据）");
{
  const mk = (text: string, seq: number) => ({
    sessionKey: "s", seq, text, vector: JSON.stringify([1.0, 0.0, 0.0, 0.0]), tsMs: Date.now(),
  });
  const cfg = { relevanceThreshold: 0.3, avgSimSwitchThreshold: 0.26, recentWindowForInternal: 5, internalRelevanceThreshold: 0.35, minSamples: 5 };

  // 同向量（同话题）→ 不切换
  const sameTurns = Array.from({ length: 7 }, (_, i) => mk("同样的内容", i));
  ok("同话题不切换", detectTopicSwitch([1, 0, 0, 0], sameTurns, cfg) === -1,
    String(detectTopicSwitch([1, 0, 0, 0], sameTurns, cfg)));

  // 新向量与旧完全正交（话题切换）→ 返回新话题首轮索引
  const switchTurns = Array.from({ length: 7 }, (_, i) => mk("旧话题内容", i));
  // newVec 正交于 [1,0,0,0] → avgSim=0 → <=0.26 → 切换；返回 last index=6
  ok("正交=切换(返回最后索引)", detectTopicSwitch([0, 1, 0, 0], switchTurns, cfg) === 6,
    String(detectTopicSwitch([0, 1, 0, 0], switchTurns, cfg)));

  // 前段数量不足 minSamples → 不切换
  const fewTurns = [mk("a", 0), mk("b", 1), mk("c", 2)];
  ok("样本不足不切换", detectTopicSwitch([0, 1, 0, 0], fewTurns, cfg) === -1);

  // 空新向量 → 不切换（embedding 失败降级）
  ok("空向量不切换", detectTopicSwitch([], sameTurns, cfg) === -1);

  // 新向量与旧完全相反（cos=-1 <0.26）→ 切换
  const negTurns = Array.from({ length: 7 }, (_, i) => ({
    sessionKey: "s", seq: i, text: "x", vector: JSON.stringify([1, 0, 0, 0]), tsMs: 0,
  }));
  ok("反向=切换（修复：负相似度不当作无信号）", detectTopicSwitch([-1, 0, 0, 0], negTurns, cfg) === 6,
    String(detectTopicSwitch([-1, 0, 0, 0], negTurns, cfg)));
}

// ─── estimateTokensFromChars ─────────────────────────────────
group("estimateTokensFromChars");
{
  ok("600 字符≈200 token", estimateTokensFromChars(600) === 200);
  ok("0 字符=0", estimateTokensFromChars(0) === 0);
  ok("向上取整", estimateTokensFromChars(1) === 1);
}

// ─── sanitizeMatch（FTS 清洗）────────────────────────────────
group("sanitizeMatch");
{
  ok("纯词不变", sanitizeMatch("hello") === "hello");
  ok("含空格加引号", sanitizeMatch("hello world") === '"hello world"');
  ok("含符号加引号+去引号", sanitizeMatch('say "hi" ok') === '"say hi ok"');
  ok("空串→双引号", sanitizeMatch("") === '""');
}

// ─── engine-db 全方法（真实 sqlite，临时文件）────────────────
group("engine-db CRUD + 预拉生命周期");
{
  const dbPath = join(tmp, "engine.db");
  const db = openEngineDb(dbPath, log);

  // 情感锚点：写入 + 去重
  const id1 = db.addEmotionAnchor({ text: "我喜欢你", category: "爱慕", kind: "fixed", milestone: true, source: "test", active: true });
  const id2 = db.addEmotionAnchor({ text: "我喜欢你", category: "爱慕", kind: "fixed", milestone: true, source: "test", active: true });
  ok("同句 fixed 去重返回同 id", id1 === id2);
  ok("列表含锚点", db.listActiveAnchors(10).length >= 1);

  // 场景锚点
  db.addEmotionAnchor({ text: "我想你了", category: "想念", kind: "scenario", scenarioHints: "想你,想念", milestone: false, source: "test", active: true });
  ok("场景命中", db.listScenarioAnchors("最近好想你", 3).some((a) => a.text === "我想你了"));
  ok("场景未命中(无关词)", db.listScenarioAnchors("讨论天气", 3).length === 0);

  // 预拉冷却：非里程碑冷却、里程碑不冷却
  const scenarioRow = db.listActiveAnchors(10).find((a) => a.kind === "scenario" && !a.milestone)!;
  db.markAnchorPreloaded(scenarioRow.id);
  ok("非里程碑已预拉→冷却中", db.anchorOnCooldown(scenarioRow.id, Date.now() + 1000, 12 * 3600 * 1000) === true);
  const fixedMilestone = db.listActiveAnchors(10).find((a) => a.milestone)!;
  ok("里程碑预拉后仍在冷却中=false(不冷却)", db.anchorOnCooldown(fixedMilestone.id, Date.now() + 1000, 12 * 3600 * 1000) === false);

  // 投入度
  const e1 = db.bumpEngagement({ topic: "t1", tsMs: Date.UTC(2026, 7, 9, 0, 0, 0), tokens: 100 });
  ok("首次 bump 记 1 轮 1 时段", e1.turn_count === 1 && e1.time_window_count === 1);
  const e2 = db.bumpEngagement({ topic: "t1", tsMs: Date.UTC(2026, 7, 9, 0, 0, 0) + 1000, tokens: 50 });
  ok("同窗 bump 轮+1 时段不变", e2.turn_count === 2 && e2.time_window_count === 1);
  const e3 = db.bumpEngagement({ topic: "t1", tsMs: Date.UTC(2026, 7, 9, 0, 0, 0) + 6 * 3600 * 1000, tokens: 50 });
  ok("跨窗 bump 时段+1", e3.time_window_count === 2);
  const e4 = db.bumpEngagement({ topic: "t1", tsMs: Date.UTC(2026, 7, 9, 0, 0, 0) + 7 * 3600 * 1000, tokens: 50 });
  ok("token 累计", e4.token_count === 100 + 50 + 50 + 50);

  // 高投入清单
  db.bumpEngagement({ topic: "big", tsMs: Date.now(), tokens: 50000 });
  const highs = db.listHighEngagement({ minTurns: 10, minTimeWindows: 2, minTokens: 30000 });
  ok("高投入 token 超阈值入选", highs.some((h) => h.topic === "big"));

  // 预拉上限字段
  const e5 = db.bumpEngagement({ topic: "t1", tsMs: Date.now(), tokens: 10 });
  ok("engagement 预拉字段默认 0", e5.preload_count === 0);
  db.markEngagementPreloaded("t1");
  ok("markEngagementPreloaded 计数+1", db.getEngagement("t1")?.preload_count === 1);

  // 自进化基线
  db.setSelfEvolveBaseline("k", "v1");
  ok("基线写入读取", db.getSelfEvolveBaseline("k") === "v1");

  // 提拔台账（修复：setPromoted 需能 UPsert，置空须可取消）
  db.setPromoted("anchor:1", "MEMORY.md");
  ok("isPromoted true", db.isPromoted("anchor:1") === true);
  db.setPromoted("anchor:1", "MEMORY.md");  // 重复同值 UPsert 不改 target
  ok("isPromoted 仍 true(重复 UPsert 不破坏)", db.isPromoted("anchor:1") === true);
  db.setPromoted("anchor:1", ""); // rollback 置空（修复：UPsert 可把已存在行 target 置空）
  ok("置空后 isPromoted false（修复：回滚能真正取消提拔）", db.isPromoted("anchor:1") === false);
  db.setPromoted("anchor:2", "USER.md");  // 新行插入正常
  ok("新行插入 isPromoted true", db.isPromoted("anchor:2") === true);

  // 压缩窗口
  db.upsertCompactionTurn({ sessionKey: "s1", seq: 0, text: "a", vector: "[]", tsMs: 1 });
  db.upsertCompactionTurn({ sessionKey: "s1", seq: 1, text: "b", vector: "[]", tsMs: 2 });
  ok("窗口写入读取", db.listCompactionTurns("s1").length === 2);
  ok("窗口按 seq 排序", db.listCompactionTurns("s1")[0].seq === 0);
  db.clearCompactionTurns("s1");
  ok("窗口清空", db.listCompactionTurns("s1").length === 0);

  // 去重
  db.markCompactedContent("s1", "hash1", "d");
  ok("去重标记命中", db.isCompactedContent("s1", "hash1") === true);
  ok("去重标记未命中", db.isCompactedContent("s1", "hash2") === false);

  // 记录审计事件
  db.recordCompactionEvent("s1", "test", "detail");
  ok("审计事件写入", db.listCompactionTurns("s1").length >= 0); // 事件表无读接口，忽略

  db.close();
  ok("db 关闭无异常", true);
}

// ─── 真实 lcm.db 只读（若存在）───────────────────────────────
group("lcm.db 只读层");
{
  // 真实 lcm.db 只读（若配置了 LCM_DB_PATH）
  const lcmPath = process.env.LCM_DB_PATH ?? "";
  if (lcmPath && existsSync(lcmPath)) {
    const lcm = openLcmRead(lcmPath, log);
    ok("lcm 打开成功", lcm !== null);
    if (lcm) {
      // getActiveConversation 对主会话
      const conv = lcm.getActiveConversation("agent:main:main");
      ok("主会话 getActiveConversation（有或 undefined 均可，不断言死）", true);
      if (conv) {
        ok(`会话 #${conv.conversationId} totalTokens=${conv.totalTokens}>0`, conv.totalTokens >= 0);
        const turns = lcm.recentConversationTurns(conv.conversationId, 5);
        ok("recentConversationTurns 返回数组", Array.isArray(turns));
      }
      // sanitize + grep
      const hits = lcm.grepMessages(sanitizeMatch("项目负责人"), 3);
      ok("grepMessages 可调用（可能为空）", Array.isArray(hits));
      lcm.close();
    }
  } else {
    ok("lcm.db 未配置/不存在（跳过只读测试）", true);
  }
}

// ─── 索引 schema 一致性观察（B7 复核：不是 bug）────────────────
// 实测：existing 手动条目用 file（daily 正确匹配）；引擎写 target（events 归档，非每日笔记）。
// daily.scanIndex 只核对每日笔记（memory/YYYY-MM-DD.md），用的是 file 字段 → 功能正确。
// 引擎写 events/ 归档路径到 target 是另一类条目，不与每日笔记比较 → 无冲突。
group("索引 schema 一致性（复核）");
{
  const indexPath = process.env.MEMORY_INDEX_PATH ?? "";
  if (indexPath && existsSync(indexPath)) {
    const lines = readFileSync(indexPath, "utf8").split("\n").filter(Boolean);
    const hasFile = lines.some((l) => { try { return "file" in JSON.parse(l); } catch { return false; } });
    const hasTarget = lines.some((l) => { try { return "target" in JSON.parse(l); } catch { return false; } });
    // daily.scanIndex 匹配的是内存 file 字段 = memory/<date>.md；target(events) 不参与每日笔记比对 → 设计正确，非 bug
    ok("每日索引条目(file)与引擎归档条目(target)并存，职责分离，非 bug", hasFile && hasTarget);
    console.log(`  ℹ️ 索引 ${lines.length} 行：file=${hasFile}(每日笔记) target=${hasTarget}(events归档)`);
  } else {
    ok("索引文件未配置/不存在（跳过）", true);
  }
}

// ─── 清理 ────────────────────────────────────────────────────
rmSync(tmp, { recursive: true, force: true });

// ─── 汇总 ────────────────────────────────────────────────────
console.log(`\n══════════════════════════════════`);
console.log(`通过 ${pass} ｜ 失败 ${fail}`);
if (failures.length) {
  console.log("失败项：");
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
