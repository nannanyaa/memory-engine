/**
 * log.ts — memory-engine 日志 + 改动日志（自进化半自动机制核心）
 *
 *  1. Logger：console 命名空间日志，前缀 [memory-engine]。
 *  2. 改动日志（change log）：每次写 MEMORY/USER/dim/索引/engine-db 都记一条 JSONL 到
 *     <rollbackBackupDir>/changes.jsonl，幂等 id + 备份文件 + 撤销指令。
 *  3. 回滚目录：写 MEMORY/USER/dim 前先备份原文，保证可一键手动回退。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  const pre = `[${scope}]`;
  return {
    debug: (m, ...a) => safeLog("debug", pre, m, a),
    info: (m, ...a) => safeLog("info", pre, m, a),
    warn: (m, ...a) => safeLog("warn", pre, m, a),
    error: (m, ...a) => safeLog("error", pre, m, a),
  };
}

function safeLog(level: "debug" | "info" | "warn" | "error", pre: string, m: string, a: unknown[]) {
  try {
    const fn = console[level] ?? console.log;
    fn(pre, m, ...a);
  } catch {
    /* never throw from logger */
  }
}

// ---------------------------------------------------------------------------
// 改动日志（change log） + 回滚备份
// ---------------------------------------------------------------------------

export interface ChangeEntry {
  id: string;
  ts: string;
  module: string;
  action: string; // e.g. "append_to_emotion_dim" | "record_anchor" | "promote_to_memory" | "register_index" | "write_engagement"
  target: string; // 变更文件/表描述
  backup?: string; // 变更前备份文件绝对路径
  summary: string; // 人类可读的改动点说明（供日志汇报）
  revert_hint?: string; // 撤销指令描述
}

/**
 * 写盘前备份原文件内容到回滚目录，返回备份文件路径。
 * 文件不存在则备份文件内容为空字符串（标记为新建）。
 */
export function backupBeforeWrite(
  path: string,
  rollbackBackupDir: string,
): string {
  mkdirSync(rollbackBackupDir, { recursive: true });
  const name = basename(path).replace(/[^A-Za-z0-9._-]/g, "_");
  const backup = join(rollbackBackupDir, `${Date.now()}-${name}.bak`);
  let content = "";
  try {
    if (existsSync(path)) content = readFileSync(path, "utf8");
  } catch {
    /* ignore read fail */
  }
  try {
    writeFileSync(backup, content, "utf8");
  } catch (e) {
    /* backup best-effort */
    safeLog("warn", "[memory-engine]", "backupBeforeWrite failed", [String(e)]);
  }
  return backup;
}

/**
 * 追加一条改动日志到 changes.jsonl。
 * 无论如何不抛异常——写日志失败不能中断主线。
 */
export function recordChange(entry: ChangeEntry, rollbackBackupDir: string) {
  try {
    mkdirSync(rollbackBackupDir, { recursive: true });
    appendFileSync(join(rollbackBackupDir, "changes.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* log-only, non-fatal */
  }
}

/** 读取全部改动日志（按时间正序）。 */
export function readChanges(rollbackBackupDir: string): ChangeEntry[] {
  const p = join(rollbackBackupDir, "changes.jsonl");
  if (!existsSync(p)) return [];
  const out: ChangeEntry[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ChangeEntry);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/** 简单幂等 id。 */
export function newId(module: string): string {
  return `${module}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function dirsOf(p: string): void {
  try {
    mkdirSync(dirname(join(p, "x")), { recursive: true });
  } catch {
    /* ignore */
  }
}

export { join, dirname, readdirSync };
