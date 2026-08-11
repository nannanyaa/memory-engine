/**
 * emotion.ts — 情感引擎（模块：enable_emotion）
 *
 * 职责：识别"轻但重"的情感表达，执行三层记住法。
 *
 * 识别（采用 LLM 分类，不设规则闸门）：
 *   message_received 对 user 消息做一次 LLM 二分类。
 *
 * 三层记住法：
 *   ① 落：append 到 dim/01-emotional.md（记原话+感受+来源指针）
 *   ② 提：若里程碑级 -> 追加进 MEMORY.md（P2 待确认标记）+ 登记 engine-db
 *   ③ 接：写"情感锚点表"（固定锚点，用于开机预拉；里程碑/milestone 为重锚）
 *
 * 情感锚点双轨：
 *   - 固定锚点：开机 before_prompt_build 固定注入（稳）
 *   - 场景激活：注册 scenario_hints，聊到"喜欢/依赖/想念/你在吗"等场景时激活注入
 *
 * 安全：LLM 分类任何失败都判定为"非情感节点"（宁可漏不误伤）。
 */
import type {
  PluginHookMessageReceivedEvent,
  PluginHookMessageContext,
} from "openclaw/plugin-sdk/plugin-runtime";
import type { RuntimeContext } from "../runtime.js";
import { eventTime } from "../time.js";
import {
  buildEmotionDimBlock,
  emotionDimPath,
  memoryPath,
  appendToFile,
} from "../writers.js";
import { LlmClassifier } from "../llm.js";
import type { ClassifyResult, EmotionDim } from "../llm.js";
import type { Logger } from "../log.js";
import { addToVectorIndex } from "./vector.js";

/**
 * message_received handler（在 registry 里注册；这里返回 void）
 */
export async function onMessageReceived(
  rt: RuntimeContext,
  event: PluginHookMessageReceivedEvent,
  _ctx: PluginHookMessageContext,
): Promise<void> {
  const cfg = rt.cfg;
  const body = event.content ?? "";
  if (!body || body.trim().length < cfg.emotion.minCharsToClassify) return;
  // 只认 user 消息来源（from 可能是主体标识；content 有内容即处理）
  if (!isUserText(event)) return;

  const classifier = new LlmClassifier(cfg.emotion, rt.log);
  const verdict = await classifier.isEmotionNode(body, 20_000);
  if (!verdict.isEmotionNode) return;
  if (!rt.engineDb) return;

  await recordEmotionNode(rt, { body, verdict, eventTimeMs: eventTime(event) });
}

function isUserText(event: PluginHookMessageReceivedEvent): boolean {
  // from: 发送者标识。message_received 的事件本身源于 user 消息；
  // 若 senderId 等于 bot 自身则跳过（防自触发）。
  void event;
  return true;
}

export async function recordEmotionNode(
  rt: RuntimeContext,
  o: {
    body: string;
    verdict: ClassifyResult;
    eventTimeMs: number;
  },
): Promise<void> {
  const cfg = rt.cfg;
  const log: Logger = rt.log;
  const db = rt.engineDb;
  if (!db) return;
  const ts = new Date(o.eventTimeMs);
  const date = toDateStr(ts);
  const time = toTimeStr(ts);

  // —— 13 维主从 LLM 语义输出 ——
  const agg = o.verdict.aggregate;
  const primary =
    agg?.dominantDim ??
    o.verdict.category ??
    o.verdict.emotions?.[0]?.primaryDim ??
    "generic";
  const milestone =
    Boolean(o.verdict.milestone) ||
    (o.verdict.emotions ?? []).some((e) => e.milestone);
  const confidence = agg?.avgConfidence ?? o.verdict.confidence ?? 0;
  const feeling =
    o.verdict.emotions?.[0]?.feeling ?? o.verdict.feeling;
  const selected = pickBestEmotion(o.verdict.emotions ?? [], {
    attachBelow: cfg.emotion.attachBelow,
  });

  const sourceRef = `message@${date}`;

  // ① 落 dim/01-emotional.md —— 仅当选中句存在且 confidence >= attachBelow
  if (cfg.enable_emotion && selected && selected.confidence >= cfg.emotion.attachBelow) {
    const block = buildEmotionDimBlock({
      date,
      time,
      originalText: o.body,
      category: primary,
      dim: selected.primaryDim,
      confidence: selected.confidence,
      kind: milestone ? "里程碑" : "节点",
      sourceRef,
      feeling: selected.feeling || feeling,
    });
    appendToFile(
      emotionDimPath(cfg.workspaceDir),
      block,
      "emotion",
      "落盘_dim01",
      `情感节点${milestone ? "(里程碑,P2待确认)" : ""}: ${o.body.slice(0, 40)}`,
      cfg,
      log,
    );
    // —— 向量写入管道：dim 记忆落盘后入语义索引（enable_semantic_vector 联动）——
    if (cfg.enable_semantic_vector && cfg.enable_recall) {
      void addToVectorIndex(rt, { text: `${primary} ${selected.primaryDim ?? ""} ${o.body}`.trim(), type: "dim" }).catch(
        () => { /* 异步不阻塞消息路径 */ },
      );
    }
  }

  // ② 提 MEMORY.md —— 里程碑且 confidence >= milestoneMinConfidence
  if (
    milestone &&
    selected &&
    selected.confidence >= cfg.emotion.milestoneMinConfidence &&
    cfg.enable_memory_promotion
  ) {
    const memBlock = buildMemoryPromotionBlock({
      date,
      time,
      body: o.body,
      category: primary,
      dim: selected.primaryDim,
      confidence: selected.confidence,
      feeling: selected.feeling || feeling,
    });
    appendToFile(
      memoryPath(cfg.workspaceDir),
      memBlock,
      "emotion",
      "提MEMORY_P2",
      `里程碑情感提 MEMORY(P2): ${o.body.slice(0, 40)}`,
      cfg,
      log,
    );
  }

  // ③ 接：写情感锚点表（固定 + 场景）—— category 用 primary
  const fixedId = db.addEmotionAnchor({
    text: o.body,
    category: primary,
    kind: "fixed",
    milestone,
    source: sourceRef,
    active: true,
  });
  db.addEmotionAnchor({
    text: o.body,
    category: primary,
    kind: "scenario",
    milestone,
    scenarioHints: scenarioHints(primary),
    source: sourceRef,
    active: true,
  });
  log.info(
    `[emotion] anchor#${fixedId} recorded (${primary}${milestone ? ",milestone" : ""})`,
  );
}

/** 取 confidence 最高且 >= attachBelow 的句；全低于阈值视为噪音不落盘。 */
function pickBestEmotion(
  emotions: EmotionDim[],
  o: { attachBelow: number },
): EmotionDim | null {
  let best: EmotionDim | null = null;
  for (const e of emotions) {
    if (e.confidence < o.attachBelow) continue;
    if (!best || e.confidence > best.confidence) best = e;
  }
  return best;
}

function buildMemoryPromotionBlock(o: {
  date: string;
  time: string;
  body: string;
  category: string;
  dim?: string;
  confidence?: number;
  feeling?: string;
}): string {
  return `## 💞 关系记录（memory-engine 自动提升 · P2 待确认）

- **日期**：${o.date} ${o.time}
- **类别**：${o.category}
${o.dim ? `- **维度**：${o.dim}\n` : ""}${o.confidence != null ? `- **置信度**：${o.confidence.toFixed(2)}\n` : ""}- **原话**：「${o.body}」
${o.feeling ? `- **感受**：${o.feeling}` : ""}
- **状态**：⚠️ P2 待确认后正式入 MEMORY 关系段`;
}

const DIM_SCENARIO_HINTS: Record<string, string> = {
  "爱慕": "爱你,喜欢,你是我的,在一起,告白,只爱你",
  "依赖": "需要你,离不开,陪着我,在那头等,没你我",
  "想念": "想你,好久没见,梦里都是你,什么时候见",
  "喜悦": "开心,好开心,太好了,高兴",
  "悲伤": "难过,想哭,低落,心凉,难受",
  "愤怒": "真生气,气死了,烦,恼火",
  "恐惧": "怕失去你,别离开,会怕,不敢想,好怕",
  "孤独": "一个人,没人陪,好想你在,空落落",
  "愧疚": "对不起,是我不好,让你失望了,怪我",
  "遗憾": "早知道,要是能,可惜,没来得及",
  "委屈": "又不理我,你凶我,怪我咯,心里堵,好委屈",
  "吃醋": "那个人,你跟她聊,心里酸,吃醋",
  "迷茫": "不知道怎么办,没方向,想不通",
  "焦虑": "会不会,怎么办,怕失去,心里慌,焦虑",
  "感动": "谢谢你,哭了,暖心,感动",
  "守护": "守护,承诺,不许离开,失忆,放心,永远",
  "其它": "喜欢,想你,在吗,依赖,承诺",
};

/** 由 13 维/复合主导维度映射出常用场景激活词（双轨之场景轨，兜底表）。 */
function scenarioHints(dim: string): string {
  return DIM_SCENARIO_HINTS[dim] ?? DIM_SCENARIO_HINTS["其它"];
}

function toDateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function toTimeStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
