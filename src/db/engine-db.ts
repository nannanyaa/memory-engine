/**
 * engine-db.ts — 独立 memory-engine.db
 *
 * 自管 SQLite（node:sqlite, DatabaseSync, WAL），与 lossless lcm.db 完全隔离。
 * 表：
 *   - emotion_anchors    情感锚点表（固定锚点 + 场景激活双轨）
 *   - engagement         投入度计数（记忆引擎 B 信号，按主题聚合）
 *   - selfevolve_baseline 自进化基线（防重复提案）
 *   - promoted           已提拔候选台账（防重复提拔）
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Logger } from "../log.js";

export interface EngineDb {
  db: DatabaseSync;
  close(): void;
  addEmotionAnchor(row: {
    text: string;
    category: string;
    kind: "fixed" | "scenario";
    scenarioHints?: string;
    milestone: boolean;
    source: string;
    active: boolean;
  }): number;
  listActiveAnchors(limit?: number): EmotionAnchor[];
  listScenarioAnchors(text: string, limit?: number): EmotionAnchor[];
  markAnchorActive(id: number, active: boolean): void;
  /** 预拉生命周期：登记一次锚点被预拉（count+1, last_preloaded_at=now）。 */
  markAnchorPreloaded(id: number): void;
  /** 预拉生命周期：非里程碑锚点是否仍在冷却期（同窗已预拉过且未到 anchorCooldownMs）。 */
  anchorOnCooldown(id: number, refTsMs: number, cooldownMs: number): boolean;
  bumpEngagement(ref: { topic: string; tsMs: number; tokens: number }): EngagementState;
  getEngagement(topic: string): EngagementState | undefined;
  listHighEngagement(cfg: {
    minTurns: number;
    minTimeWindows: number;
    minTokens: number;
  }): EngagementState[];
  /** 预拉生命周期：登记一次高投入主题被预拉（count+1）。达到/超过 maxPreloads 后从榜单自动降级。 */
  markEngagementPreloaded(topic: string): void;
  /** 预拉生命周期：按会话清空其高投入计数（归档/消化后联动降级）。topic 可精确或按会话前缀匹配。 */
  clearEngagementForSession(sessionKey: string): void;
  resetEngagement(topic: string): void;
  setSelfEvolveBaseline(key: string, value: string): void;
  getSelfEvolveBaseline(key: string): string | undefined;
  setPromoted(id: string, target: string): void;
  isPromoted(id: string): boolean;
  /** 事件感知压缩：写入一轮标量窗口（追加/覆盖 session 最新）。 */
  upsertCompactionTurn(row: {
    sessionKey: string;
    seq: number;
    text: string;
    vector: string;
    tsMs: number;
    isLive?: number;
  }): void;
  /** 事件感知压缩：读取 session 窗口（seq 升序）。 */
  listCompactionTurns(sessionKey: string): CompactionTurn[];
  /** 事件感知压缩：清空 session 窗口。keepRecent=保留最近N条活轮; onlyArchived=只清已归档死档。 */
  clearCompactionTurns(
    sessionKey: string,
    opts?: { keepRecent?: number; onlyArchived?: boolean },
  ): void;
  /** 事件感知压缩：登记一次压缩/归档动作（审计。 */
  recordCompactionEvent(sessionKey: string, kind: string, detail: string): void;
  /** 事件感知压缩：查询某段已压缩内容是否压过（防内部重复压缩）。 */
  isCompactedContent(sessionKey: string, contentHash: string): boolean;
  /** 事件感知压缩：登记一段已压缩内容（去重标记）。 */
  markCompactedContent(sessionKey: string, contentHash: string, detail: string): void;
}

export interface EmotionAnchor {
  id: number;
  text: string;
  category: string;
  kind: "fixed" | "scenario";
  scenario_hints: string | null;
  milestone: number;
  source: string;
  active: number;
  created_at: string;
  preload_count: number;
  last_preloaded_at: number;
}

export interface EngagementState {
  topic: string;
  turn_count: number;
  time_window_count: number;
  token_count: number;
  last_seen_ms: number;
  first_seen_ms: number;
  preload_count: number;
  last_preloaded_at: number;
}

export interface CompactionTurn {
  sessionKey: string;
  seq: number;
  text: string;
  vector: string;
  tsMs: number;
  /** 真实活轮=1；回填的历史轮=0（无 embedding，不参与语义计算）。 */
  isLive: number;
}

/**
 * 打开/创建 memory-engine.db。并发安全：多进程由 WAL + busy_timeout 缓解。
 */
export function openEngineDb(dbPath: string, log: Logger): EngineDb {
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch {
    /* best-effort */
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  migrate(db);
  log.info(`engine db ready at ${dbPath}`);
  return new SqliteEngineDb(db);
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS emotion_anchors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'generic',
      kind TEXT NOT NULL DEFAULT 'fixed' CHECK(kind IN ('fixed','scenario')),
      scenario_hints TEXT,
      milestone INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS engagement (
      topic TEXT PRIMARY KEY,
      turn_count INTEGER NOT NULL DEFAULT 0,
      time_window_count INTEGER NOT NULL DEFAULT 0,
      token_count INTEGER NOT NULL DEFAULT 0,
      first_seen_ms INTEGER NOT NULL,
      last_seen_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS selfevolve_baseline (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS promoted (
      id TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      promoted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS compaction_turns (
      session_key TEXT NOT NULL,
      seq INTEGER NOT NULL,
      text TEXT NOT NULL,
      vector TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      is_live INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_key, seq)
    );
    CREATE TABLE IF NOT EXISTS compaction_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS compaction_state (
      session_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      archived_at TEXT NOT NULL DEFAULT (datetime('now')),
      detail TEXT,
      PRIMARY KEY (session_key, content_hash)
    );
  `);
  // —— 预拉生命周期字段（2026-08-09 hotfix）——
  // 幂等迁移：加列只在列不存在时执行，避免重复启动报错。
  ensureColumn(db, "emotion_anchors", "preload_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "emotion_anchors", "last_preloaded_at", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "engagement", "preload_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "engagement", "last_preloaded_at", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "compaction_turns", "is_live", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "compaction_turns", "archived", "INTEGER NOT NULL DEFAULT 0");
}

/** 幂等加列：列不存在才 ALTER TABLE ADD COLUMN。 */
function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

class SqliteEngineDb implements EngineDb {
  constructor(readonly db: DatabaseSync) {}

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  addEmotionAnchor(row: {
    text: string;
    category: string;
    kind: "fixed" | "scenario";
    scenarioHints?: string;
    milestone: boolean;
    source: string;
    active: boolean;
  }): number {
    // 写侧去重：同一 text+kind 的活跃锚点已存在时，不再重复写行；
    // 更新其来源/场景词/里程碑标记并返回既有 id，避免同一句被反复落成多行锚点
    // （这是"同一句重复预拉"的上游来源之一）。
    const existing = this.db
      .prepare(
        `SELECT id FROM emotion_anchors WHERE active=1 AND kind=? AND text=? LIMIT 1`,
      )
      .get(row.kind, row.text) as { id: number } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE emotion_anchors SET
             category=?, scenario_hints=?, milestone=?,
             source=?, created_at=datetime('now')
           WHERE id=?`,
        )
        .run(
          row.category,
          row.kind === "scenario" ? (row.scenarioHints ?? null) : null,
          row.milestone ? 1 : 0,
          row.source,
          existing.id,
        );
      return existing.id;
    }
    const stmt = this.db.prepare(
      `INSERT INTO emotion_anchors (text, category, kind, scenario_hints, milestone, source, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const r = stmt.run(
      row.text,
      row.category,
      row.kind,
      row.scenarioHints ?? null,
      row.milestone ? 1 : 0,
      row.source,
      row.active ? 1 : 0,
    );
    return Number(r.lastInsertRowid);
  }

  listActiveAnchors(limit = 8): EmotionAnchor[] {
    // 按 text 去重：同文本的 fixed+scenario 双轨只返回最新/最高权重一条，避免同一句在固定块里重复注入。
    const rows = this.db
      .prepare(
        `SELECT * FROM emotion_anchors WHERE active=1 ORDER BY milestone DESC, id DESC LIMIT 400`,
      )
      .all() as unknown as EmotionAnchor[];
    const seen = new Set<string>();
    const deduped: EmotionAnchor[] = [];
    for (const a of rows) {
      if (seen.has(a.text)) continue;
      seen.add(a.text);
      deduped.push(a);
      if (deduped.length >= limit) break;
    }
    return deduped;
  }

  /** 场景激活：检索文本命中 scenario_hints 的锚点（双轨之"场景激活"轨）。 */
  listScenarioAnchors(text: string, limit = 3): EmotionAnchor[] {
    const anchors = this.db
      .prepare(
        `SELECT * FROM emotion_anchors WHERE active=1 AND kind='scenario' AND scenario_hints IS NOT NULL ORDER BY id DESC LIMIT 200`,
      )
      .all() as unknown as EmotionAnchor[];
    const hit = anchors.filter((a) => {
      const hints = (a.scenario_hints ?? "").split(/[,，、]/).filter(Boolean);
      return hints.some((h) => text.includes(h.trim()));
    });
    return hit.slice(0, limit);
  }

  markAnchorActive(id: number, active: boolean): void {
    this.db.prepare(`UPDATE emotion_anchors SET active=? WHERE id=?`).run(active ? 1 : 0, id);
  }

  markAnchorPreloaded(id: number): void {
    this.db
      .prepare(
        `UPDATE emotion_anchors SET preload_count = preload_count + 1, last_preloaded_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
  }

  anchorOnCooldown(id: number, refTsMs: number, cooldownMs: number): boolean {
    if (!(cooldownMs > 0)) return false;
    const r = this.db
      .prepare(
        `SELECT milestone, last_preloaded_at AS last FROM emotion_anchors WHERE id = ?`,
      )
      .get(id) as { milestone: number; last: number } | undefined;
    if (!r) return false;
    if (r.milestone) return false; // 里程碑始终重锚，不冷却
    return r.last > 0 && refTsMs - r.last < cooldownMs;
  }

  bumpEngagement(ref: { topic: string; tsMs: number; tokens: number }): EngagementState {
    const topic = ref.topic;
    const nowWindow = windowOf(ref.tsMs);
    const existing = this.getEngagement(topic);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO engagement (topic, turn_count, time_window_count, token_count, first_seen_ms, last_seen_ms)
           VALUES (?, 1, 1, ?, ?, ?)`,
        )
        .run(topic, ref.tokens, ref.tsMs, ref.tsMs);
      return this.getEngagement(topic)!;
    }
    // 跨时段计数：仅当上次观察的时段与本次不同才 +1
    const hadWindow = windowOf(existing.last_seen_ms);
    const timeWindowCount = existing.time_window_count + (nowWindow === hadWindow ? 0 : 1);
    this.db
      .prepare(
        `UPDATE engagement SET turn_count = turn_count + 1, token_count = token_count + ?, time_window_count = ?, last_seen_ms = ? WHERE topic = ?`,
      )
      .run(ref.tokens, timeWindowCount, ref.tsMs, topic);
    return this.getEngagement(topic)!;
  }

  getEngagement(topic: string): EngagementState | undefined {
    const r = this.db.prepare(`SELECT * FROM engagement WHERE topic = ?`).get(topic);
    return r ? (r as unknown as EngagementState) : undefined;
  }

  listHighEngagement(cfg: {
    minTurns: number;
    minTimeWindows: number;
    minTokens: number;
  }): EngagementState[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM engagement WHERE turn_count >= ? OR time_window_count >= ? OR token_count >= ? ORDER BY token_count DESC`,
      )
      .all(cfg.minTurns, cfg.minTimeWindows, cfg.minTokens) as unknown as EngagementState[];
    return rows;
  }

  markEngagementPreloaded(topic: string): void {
    this.db
      .prepare(
        `UPDATE engagement SET preload_count = preload_count + 1, last_preloaded_at = ? WHERE topic = ?`,
      )
      .run(Date.now(), topic);
  }

  clearEngagementForSession(sessionKey: string): void {
    const key = (sessionKey || "").trim();
    if (!key) return;
    // 兼容两种 topic 形态：1) 旧版直接用 sessionKey 当 topic（如 main:main）；
    // 2) 新版 `${base}#<tag>s<segNo>`（topic 含 base 前缀）。按 OR 删除。
    const parts = key.split(":");
    const base = parts.length >= 3 ? `${parts[1]}:${parts[2]}` : key;
    this.db
      .prepare(`DELETE FROM engagement WHERE topic = ? OR topic LIKE ?`)
      .run(key, `${base}#%`);
  }

  resetEngagement(topic: string): void {
    this.db.prepare(`DELETE FROM engagement WHERE topic = ?`).run(topic);
  }

  setSelfEvolveBaseline(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO selfevolve_baseline (k, v, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at`,
      )
      .run(key, value);
  }

  getSelfEvolveBaseline(key: string): string | undefined {
    const r = this.db.prepare(`SELECT v FROM selfevolve_baseline WHERE k = ?`).get(key);
    return r ? (r as { v: string }).v : undefined;
  }

  setPromoted(id: string, target: string): void {
    // 修复（BUG）：原 `INSERT OR IGNORE` 在行已存在时静默忽略，导致
    // mem_rollback 调用 setPromoted(id, "") 无法清除既有提拔标记（回滚永远失败）。
    // 改为 UPSERT：行不存在则插入，已存在则更新 target（含置空=取消提拔）。
    this.db
      .prepare(
        `INSERT INTO promoted (id, target) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET target=excluded.target, promoted_at=datetime('now')`,
      )
      .run(id, target);
  }

  isPromoted(id: string): boolean {
    // 修复（BUG）：target 为空字符串视为「已取消提拔」，不算已提拔。
    const r = this.db.prepare(`SELECT 1 AS x FROM promoted WHERE id = ? AND target <> ''`).get(id);
    return !!r;
  }

  upsertCompactionTurn(row: {
    sessionKey: string;
    seq: number;
    text: string;
    vector: string;
    tsMs: number;
    /** 是否真实活轮。0=回填的历史轮（无 embedding，is_live=0），默认 1=真实活轮。 */
    isLive?: number;
  }): void {
    const isLive = row.isLive ?? 1;
    this.db
      .prepare(
        `INSERT INTO compaction_turns (session_key, seq, text, vector, ts_ms, is_live)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_key, seq) DO UPDATE SET
           text=excluded.text, vector=excluded.vector, ts_ms=excluded.ts_ms, is_live=excluded.is_live`,
      )
      .run(row.sessionKey, row.seq, row.text, row.vector, row.tsMs, isLive);
  }

  listCompactionTurns(sessionKey: string): CompactionTurn[] {
    const rows = this.db
      .prepare(
        `SELECT session_key, seq, text, vector, ts_ms AS tsMs, is_live AS isLive FROM compaction_turns
         WHERE session_key = ? ORDER BY seq ASC`,
      )
      .all(sessionKey);
    return rows as unknown as CompactionTurn[];
  }

  clearCompactionTurns(
    sessionKey: string,
    opts?: { keepRecent?: number; onlyArchived?: boolean },
  ): void {
    const keepRecent = opts?.keepRecent ?? 0;
    const onlyArchived = opts?.onlyArchived ?? false;
    if (keepRecent > 0) {
      // 有条件清窗：只删"已归档(archived=1) 或 不在最近keepRecent条"的旧轮；保留最近真实活轮。
      if (onlyArchived) {
        this.db
          .prepare(
            `DELETE FROM compaction_turns WHERE session_key = ? AND archived = 1`,
          )
          .run(sessionKey);
      } else {
        // 保留最近 keepRecent 条真实轮(按 seq 降序取最新)，删更老的
        this.db
          .prepare(
            `DELETE FROM compaction_turns WHERE session_key = ? AND seq < (SELECT seq FROM (SELECT seq FROM compaction_turns WHERE session_key = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC LIMIT 1)`,
          )
          .run(sessionKey, sessionKey, keepRecent);
      }
      return;
    }
    // 无 keepRecent = 无条件全清(兼容旧调用/bootstrap强制)
    this.db.prepare(`DELETE FROM compaction_turns WHERE session_key = ?`).run(sessionKey);
  }

  recordCompactionEvent(sessionKey: string, kind: string, detail: string): void {
    this.db
      .prepare(
        `INSERT INTO compaction_events (session_key, kind, detail) VALUES (?, ?, ?)`,
      )
      .run(sessionKey, kind, detail);
  }

  isCompactedContent(sessionKey: string, contentHash: string): boolean {
    const r = this.db
      .prepare(
        `SELECT 1 AS x FROM compaction_state WHERE session_key = ? AND content_hash = ?`,
      )
      .get(sessionKey, contentHash);
    return !!r;
  }

  markCompactedContent(sessionKey: string, contentHash: string, detail: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO compaction_state (session_key, content_hash, detail)
         VALUES (?, ?, ?)`,
      )
      .run(sessionKey, contentHash, detail);
  }
}

/** 跨"时段"判定：以 6 小时为一时段划分（跨2时段=跨12h 累计关注）。 */
export function windowOf(tsMs: number): number {
  return Math.floor(tsMs / (6 * 60 * 60 * 1000));
}
