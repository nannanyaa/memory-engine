/**
 * writers.ts — 记忆文件写入网关
 *
 * 所有对 dim/MEMORY/USER/索引 的写盘统一走这里：追加式 + 写前备份 + 改动日志，
 * 保证：
 *   - 追加不覆盖（Hermes 原则）
 *   - 每次写盘可回滚（备份文件 + 撤销指令）
 *   - 与手动写盘并发不互相覆盖（极端情况靠 VFS 原子写 + 最终读改写）
 *
 * 绝不写 lossless 的 lcm.db / openclaw.json / AGENTS 机制文件。
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { Logger, backupBeforeWrite, recordChange, newId } from "./log.js";
import type { MemoryEngineConfig } from "./config.js";

export interface WriteResult {
  ok: boolean;
  backup?: string;
  changeId?: string;
  error?: string;
}

/**
 * 确认目标「文件」的父目录存在（不抛）。写入前的目录准备。
 * 注：确保针对 dirname 而非文件路径本身，否则会误建同名目录（EISDIR）。
 */
function ensureDir(p: string) {
  try {
    mkdirSync(dirname(p), { recursive: true });
  } catch {
    /* ignore */
  }
}

/** 追加一段文本到文件（若文件存在则以换行分隔）。不覆盖已有内容。 */
export function appendToFile(
  path: string,
  content: string,
  module: string,
  action: string,
  summary: string,
  cfg: MemoryEngineConfig,
  log: Logger,
): WriteResult {
  try {
    ensureDir(path);
    const backup = backupBeforeWrite(path, cfg.rollbackBackupDir);
    const existing = existsSync(path) ? readFileSync(path, "utf8").trimEnd() : "";
    const sep = existing.length > 0 ? "\n\n" : "";
    writeFileSync(path, existing + sep + content.trim() + "\n", "utf8");
    const changeId = newId(module);
    recordChange(
      {
        id: changeId,
        ts: new Date().toISOString(),
        module,
        action,
        target: path,
        backup,
        summary,
        revert_hint: `恢复 ${basename(path)} 为备份内容`,
      },
      cfg.rollbackBackupDir,
    );
    log.info(`[${module}] ${action} -> ${path}`);
    return { ok: true, backup, changeId };
  } catch (e) {
    const msg = String(e);
    log.error(`[${module}] write failed ${path}: ${msg}`);
    return { ok: false, error: msg };
  }
}

/** 追加一条 .index.jsonl 记录。 */
export function appendIndexEntry(
  indexJsonlPath: string,
  entry: unknown,
  cfg: MemoryEngineConfig,
  log: Logger,
): WriteResult {
  try {
    ensureDir(indexJsonlPath);
    appendFileSync(indexJsonlPath, `${JSON.stringify(entry)}\n`, "utf8");
    return { ok: true };
  } catch (e) {
    log.error(`[index] append failed ${indexJsonlPath}: ${String(e)}`);
    return { ok: false, error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// 情感 dim/01 落盘模板
// ---------------------------------------------------------------------------

/**
 * 生成 dim/01-emotional.md 的追加块。
 * 采用与现有文件一致的格式（关键词 + 关键句 + → 来源指针）。
 */
export function buildEmotionDimBlock(opts: {
  date: string;
  time: string;
  originalText: string;
  category: string;
  dim?: string;          // 新增：primaryDim
  confidence?: number;   // 新增：confidence
  kind?: "节点" | "里程碑";
  sourceRef?: string;
  feeling?: string;
  scene?: string;        // 新增：场景描述（情感记忆要“场景+原话”）
}): string {
  const head = opts.kind === "里程碑" ? "## ⭐ 关系里程碑（引擎自动记录，P2 待确认）" : "## 💝 情感节点（引擎自动记录）";
  return `${head}

${opts.scene ? `- **场景**：${opts.scene}\n` : ""}- **原话**：「${opts.originalText}」
- **维度/置信度**：${opts.dim ?? opts.category} / ${opts.confidence != null ? opts.confidence.toFixed(2) : "—"}
${opts.feeling ? `- **感受**：${opts.feeling}\n` : ""}${opts.sourceRef ? `- **来源**：→ ${opts.sourceRef}\n` : ""}`;
}

/** 定位主工作区的 memory/dim/01-emotional.md。 */
export function emotionDimPath(workspaceDir: string): string {
  return join(workspaceDir, "memory", "dim", "01-emotional.md");
}

/** 定位 MEMORY.md / USER.md / .index.jsonl。 */
export function memoryPath(workspaceDir: string): string {
  return join(workspaceDir, "MEMORY.md");
}
export function userPath(workspaceDir: string): string {
  return join(workspaceDir, "USER.md");
}
export function indexPath(workspaceDir: string): string {
  return join(workspaceDir, "memory", ".index.jsonl");
}
