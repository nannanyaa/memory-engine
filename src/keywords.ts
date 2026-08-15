/**
 * keywords.ts — 敏感/场景关键词外部配置加载器
 *
 * 设计（08-15 定）：敏感关键词和项目专属场景词**不写死在源码**，
 * 而是集中在一个独立的外部 JSON（`memory-engine.keywords.json`，不进公开 git），
 * 代码通过本加载器在启动时读取。
 *
 * 收益：
 *   - 公开仓库源码干净通用（只含"加载外部关键词"的逻辑），不泄露任何项目敏感信息
 *   - 生产版 / 公开版共用同一套加载机制，只是外部文件内容不同
 *   - 用户拿到公开版后，可自行在外部文件配置自己的关键词，无需改代码
 *
 * 加载顺序（可被插件配置覆盖，回退到默认）：
 *   1. 插件配置 `keywordsPath`（若用户显式指定）
 *   2. workspaceDir 下的 `memory-engine.keywords.json`
 *   3. 源码包内的 `keywords.json`（兜底）
 *   4. 以上皆无 → 空配置（不崩溃，功能降级为无场景词）
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";

export interface KeywordsConfig {
  project?: {
    owner?: string;
    agent?: string;
    altNames?: string[];
    projects?: string[];
  };
  emotionScenarioHints?: Record<string, string>;
  globalScenarioHints?: Record<string, string>;
}

const THIS_DIR = __dirname;
/** 插件包根 = dist/ 的上一级（打包后 __dirname=dist/，关键词文件在包根）。 */
const PKG_ROOT = join(__dirname, "..");

/** 生成一份空壳模板（示例结构，不含任何项目敏感信息）。 */
function blankTemplate(): string {
  return JSON.stringify(
    {
      _comment: "memory-engine 敏感/场景关键词外部配置。\n\n请在项目根目录（工作区）放一个 memory-engine.keywords.json，\n按下方结构填写你自己的关键词；插件启动时会自动读取本文件。\n若工作区没有本文件，插件会自动创建一份空白模板供你填写。\n关注点：本文件不进源码仓库，只在你本地工作区存在。",
      project: {
        owner: "你的称呼",
        agent: "助手名",
        altNames: [],
        projects: [],
      },
      emotionScenarioHints: {
        爱慕: "",
        依赖: "",
        想念: "",
        喜悦: "",
        悲伤: "",
        愤怒: "",
        恐惧: "",
        孤独: "",
        愧疚: "",
        遗憾: "",
        委屈: "",
        吃醋: "",
        迷茫: "",
        焦虑: "",
        感动: "",
        守护: "",
        其它: "",
      },
      globalScenarioHints: {
        dev_hardware: "",
        relationship: "",
        memory_engine: "",
        ops: "",
        feminine: "",
        body: "",
        daily: "",
      },
    },
    null,
    2,
  );
}

/** 若目标路径不存在则自动写入空白模板。返回 true=新建，false=已存在。 */
export function ensureKeywordsFile(path: string): boolean {
  if (existsSync(path)) return false;
  try {
    const dir = dirname(path);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
    writeFileSync(path, blankTemplate(), "utf8");
    return true;
  } catch {
    return false;
  }
}
function tryLoad(path: string): KeywordsConfig | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    const parsed: KeywordsConfig = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 解析最终要用的关键词配置。
 *
 * 加载顺序：
 *   1. 插件配置 `keywordsPath`（若用户显式指定）
 *   2. workspaceDir 下的 `memory-engine.keywords.json`（不存在则自动创建空白模板）
 *   3. 源码包内 `keywords.json`（兜底）
 *   4. 皆无 → 空配置
 */
export function loadKeywords(
  workspaceDir?: string,
  explicitPath?: string,
): KeywordsConfig {
  // 1. 显式路径（不存在则自动创建模板）
  if (explicitPath) {
    if (tryLoad(explicitPath)) return tryLoad(explicitPath)!;
    ensureKeywordsFile(explicitPath);
    const created = tryLoad(explicitPath);
    if (created) return created;
  }
  // 2. workspaceDir 下（不存在则自动创建模板）
  if (workspaceDir) {
    const wsPath = join(workspaceDir, "memory-engine.keywords.json");
    if (tryLoad(wsPath)) return tryLoad(wsPath)!;
    ensureKeywordsFile(wsPath);
    const created = tryLoad(wsPath);
    if (created) return created;
  }
  // 3. 源码包内兜底（keywords.json 随插件分发，公开版为空白模板）
  const pkgRoot = tryLoad(join(PKG_ROOT, "keywords.json"));
  if (pkgRoot) return pkgRoot;
  const pkgDist = tryLoad(join(THIS_DIR, "keywords.json"));
  if (pkgDist) return pkgDist;
  // 4. 空配置
  return {};
}

/** 取某情绪维度的场景触发词（无则返回 ""）。 */
export function scenarioHintFor(
  keywords: KeywordsConfig,
  dim: string,
): string {
  const map = keywords.emotionScenarioHints ?? {};
  return map[dim] ?? map["其它"] ?? "";
}

/** 取跨维度的全局场景词（多个分组合并成逗号串）。 */
export function globalScenarioHints(keywords: KeywordsConfig): string {
  const map = keywords.globalScenarioHints ?? {};
  return Object.values(map)
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(",");
}
