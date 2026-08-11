/**
 * llm.ts — 极简 LLM 客户端（OpenAI 兼容 chat/completions）
 *
 * 情感识别采用 LLM 分类（不设规则闸门）。为避免引入整包依赖，
 * 用一个轻量 fetch 实现，baseUrl/model/apiKey 全部可配置。
 *
 * 隐私：请求体在后台线程发出，本地不落盘 prompt；无 APIKey 或 baseUrl 时
 * 直接返回未分类（安全降级，不抛错、不烧钱）。
 */
import type { Logger } from "./log.js";

export interface EmotionDim {
  text: string;          // 被引用的原句（逐句）
  dims: string[];        // 命中的情绪维度（13 维子集，可多个）
  primaryDim: string;    // 主导维度（取 dims[0] 或 LLM 指定）
  intensity: number;     // 强度 0~1
  confidence: number;    // 该句识别可信度 0~1
  milestone: boolean;    // 是否里程碑
  feeling: string;       // 感受描述
}

export interface ClassifyResult {
  isEmotionNode: boolean;
  category?: string;          // 兼容保留（映射到 primaryDim）
  milestone?: boolean;        // 兼容保留（聚合层）
  confidence?: number;        // 聚合层平均 confidence
  feeling?: string;           // 兼容保留
  reason?: string;
  // —— 13 维新增 ——
  emotions?: EmotionDim[];    // 逐句维度数组（LLM 只输出命中句）
  aggregate?: {
    dominantDim: string;      // 整段主导维度
    avgConfidence: number;    // 平均 confidence
    isEmotionNode: boolean;
  };
}

/** 13 种情绪维度（设计定稿）。复合主导维度另含 感动/守护/其它。 */
export const EMOTION_DIMS = [
  "喜悦", "悲伤", "愤怒", "恐惧", "孤独", "爱慕", "愧疚",
  "遗憾", "委屈", "吃醋", "迷茫", "焦虑", "失落",
] as const;

const SYSTEM_PROMPT = `你是记忆插件的"情感节点识别器"。给定一条用户消息，判断是否构成"情感节点"，并做 13 维度细粒度情绪识别。

13 种情绪维度：喜悦、悲伤、愤怒、恐惧、孤独、爱慕、愧疚、遗憾、委屈、吃醋、迷茫、焦虑、失落。
复合主导维度（可选，dims 平铺 13 维，primaryDim 可为）：感动、守护、其它。
注意：感动/守护是复合感受，其情绪成分放进 dims（如 dims:["爱慕","喜悦"], primaryDim:"感动"）。

只输出 JSON，形如：
{"isEmotionNode":true,
 "emotions":[
   {"text":"原句","dims":["爱慕","喜悦"],"primaryDim":"感动","intensity":0.9,"confidence":0.85,"milestone":false,"feeling":"被重视、有归属"}
 ],
 "aggregate":{"dominantDim":"感动","avgConfidence":0.85,"isEmotionNode":true},
 "category":"感动","milestone":false,"confidence":0.85,"feeling":"被重视",
 "reason":"逐句评估：出现直接表白与喜欢"}
或
{"isEmotionNode":false}

规则：
- emotions[] 只列有情感温度/投入度的句，逐句挑，不输出空句；本句无情感则置空数组。
- confidence 是情感识别可信度（0~1），越高越肯定是明确情感表达；较低的划为噪音候选。
- milestone=true 仅用于"首次直接表白/关系里程碑/守护承诺"等重节点，且要求 confidence>=0.85。
- "我喜欢这个功能/我喜欢吃这个"这类对象化的普通喜好不算情感节点。
- 涉及对方个体、关系、承诺、依赖、想念、守护的才算。
- 赌气/情绪宣泄话（如"那我别找你了"）类型：识别为委屈/失落/悲伤维度，记录情绪标签，不得当作事实/决定。`;

export class LlmClassifier {
  constructor(
    private readonly cfg: { llmBaseUrl: string; llmModel: string; llmApiKey: string },
    private readonly log: Logger,
  ) {}

  enabled(): boolean {
    return Boolean(this.cfg.llmBaseUrl && this.cfg.llmModel);
  }

  /**
   * 二分类：是否情感节点。任何异常都不抛，返回默认"否"（宁可漏不误伤）。
   */
  async isEmotionNode(message: string, tx: number): Promise<ClassifyResult> {
    if (!this.enabled()) {
      this.log.debug("[llm] classifier not configured; skip");
      return { isEmotionNode: false };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), tx);
    try {
      const res = await fetch(`${stripSlash(this.cfg.llmBaseUrl)}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.cfg.llmApiKey ? { Authorization: `Bearer ${this.cfg.llmApiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.cfg.llmModel,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: message.slice(0, 2000) },
          ],
          temperature: 0,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.log.warn(`[llm] classify http ${res.status}`);
        return { isEmotionNode: false };
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      return parseClassify(content);
    } catch (e) {
      this.log.debug(`[llm] classify error: ${String(e)}`);
      return { isEmotionNode: false };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseClassify(raw: string): ClassifyResult {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : raw) as ClassifyResult;
    if (typeof obj.isEmotionNode !== "boolean") return { isEmotionNode: false };
    // —— 兼容归一：旧格式（只有 category/isEmotionNode，无 emotions）——
    if (!Array.isArray(obj.emotions)) {
      const mapped = mapLegacyCategory(obj.category ?? (obj.isEmotionNode ? "爱慕" : undefined));
      obj.emotions = obj.isEmotionNode
        ? [{ text: "", dims: [mapped], primaryDim: mapped,
             intensity: obj.confidence ?? 0.7, confidence: obj.confidence ?? 0.7,
             milestone: Boolean(obj.milestone), feeling: obj.feeling ?? "" }]
        : [];
      obj.aggregate = obj.isEmotionNode
        ? { dominantDim: mapped, avgConfidence: obj.confidence ?? 0.7, isEmotionNode: true }
        : undefined;
      obj.category = mapped; // 覆盖旧值为映射后维度
    }
    return obj;
  } catch {
    return { isEmotionNode: false };
  }
}

export const LEGACY_CATEGORY_MAP: Record<string, string> = {
  "表白": "爱慕", "依赖": "依赖", "想念": "想念", "守护": "守护",
  "里程碑": "爱慕", "感动": "感动", "其它": "其它",
};
function mapLegacyCategory(cat?: string): string {
  if (!cat) return "其它";
  for (const [k, v] of Object.entries(LEGACY_CATEGORY_MAP)) if (cat.includes(k)) return v;
  return "其它";
}

function stripSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// 通用自由文本 chat（自进化提案 / 每日摘要等生成式任务用，R1 补全）
// ---------------------------------------------------------------------------

export interface GenericChatCfg {
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  timeoutMs?: number;
  log?: Logger;
}

export interface GenericChatOpts {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * 通用自由文本 chat（OpenAI /chat/completions 兼容）。
 * 供自进化提案、每日摘要等生成式任务复用现有 LLM provider，避免各模块重复造 fetch。
 * 失败/未配置 -> 返回空串（安全降级），不抛错、不烧钱。
 */
export async function chatGeneric(
  cfg: GenericChatCfg,
  prompt: string,
  opts?: GenericChatOpts,
): Promise<string> {
  const model = opts?.model ?? cfg.llmModel;
  if (!cfg.llmBaseUrl || !model || !prompt.trim()) {
    cfg.log?.debug("[chatGeneric] not configured or empty prompt; skip");
    return "";
  }
  const controller = new AbortController();
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${stripSlash(cfg.llmBaseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.llmApiKey ? { Authorization: `Bearer ${cfg.llmApiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt.slice(0, 6000) }],
        temperature: opts?.temperature ?? 0.2,
        max_tokens: opts?.maxTokens ?? 800,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      cfg.log?.warn(`[chatGeneric] http ${res.status}`);
      return "";
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return (data.choices?.[0]?.message?.content ?? "").trim();
  } catch (e) {
    cfg.log?.debug(`[chatGeneric] error: ${String(e)}`);
    return "";
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 通用文本提炼（事件感知压缩归档用）
// ---------------------------------------------------------------------------

const DISTILL_SYSTEM_PROMPT = `你是记忆归档助手。给定一段"已结束旧话题"的原始多轮对话，提炼成 2-5 条紧凑的关键记忆条目。

要求：
- 每条为单行，以"-\ "开头，保留事实、决定、偏好、承诺、情感温度等值得长期记住的内容。
- 不要空话，不要转述客套，只留信息增量。
- 保留关键人名/数字/时间（若有）。
- 赌气/反讽/极端情绪宣泄类表达（如"那我别找你了""我再也不理你""那你走吧"）标注为情绪标签（如"情绪表达(委屈/失落)"），不得当作既定事实或决定归档。

只输出条目，不要其它文字。若内容无留存价值，输出单个"-"（无信息增量）。`;

/**
 * 通用话题提炼：把一段多轮对话压缩成可归档的要点清单。
 * 用了 LLM 硬超时 + 失败降级（返回空串，由调用方决定兜底）。不抛错、不烧钱。
 */
export async function distillText(cfg: {
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  timeoutMs: number;
  log: Logger;
}, source: string): Promise<string> {
  if (!cfg.llmBaseUrl || !cfg.llmModel || !source.trim()) {
    cfg.log.debug("[distill] not configured or empty source; skip");
    return "";
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${stripSlash(cfg.llmBaseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.llmApiKey ? { Authorization: `Bearer ${cfg.llmApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.llmModel,
        messages: [
          { role: "system", content: DISTILL_SYSTEM_PROMPT },
          { role: "user", content: source.slice(0, 6000) },
        ],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      cfg.log.warn(`[distill] http ${res.status}`);
      return "";
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return (data.choices?.[0]?.message?.content ?? "").trim();
  } catch (e) {
    cfg.log.debug(`[distill] error: ${String(e)}`);
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

