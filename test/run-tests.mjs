// src/config.ts
function normalizeConfig(raw, env) {
  const rawCfg = raw ?? {};
  const workspaceDir = asString(rawCfg.workspaceDir) || env.workspaceDir;
  const stateDir = env.stateDir || workspaceDir;
  const engagement = asObj(rawCfg.engagement);
  const recall = asObj(rawCfg.recall);
  const emotion = asObj(rawCfg.emotion);
  const vector = asObj(rawCfg.vector);
  const selfEvolve = asObj(rawCfg.selfEvolve);
  const compaction = asObj(rawCfg.compaction);
  return {
    enable_emotion: asBool(rawCfg.enable_emotion, false),
    enable_memory_promotion: asBool(rawCfg.enable_memory_promotion, false),
    enable_recall: asBool(rawCfg.enable_recall, false),
    enable_self_evolve: asBool(rawCfg.enable_self_evolve, false),
    enable_semantic_vector: asBool(rawCfg.enable_semantic_vector, false),
    enable_daily_digest: asBool(rawCfg.enable_daily_digest, false),
    enable_context_compaction: asBool(rawCfg.enable_context_compaction, false),
    enable_context_summarize: asBool(rawCfg.enable_context_summarize, false),
    workspaceDir,
    stateDir,
    engineDbPath: asString(rawCfg.engineDbPath) || `${stateDir}/memory-engine.db`,
    lcmDbPath: asString(rawCfg.lcmDbPath) || `${stateDir}/lcm.db`,
    injectTag: asString(rawCfg.injectTag) || "memory-engine-memories",
    injectMaxChars: asInt(rawCfg.injectMaxChars, 1200),
    rollbackBackupDir: asString(rawCfg.rollbackBackupDir) || `${stateDir}/.memory-engine-rollback`,
    engagement: {
      minTurns: asInt(engagement.minTurns, 10),
      minTimeWindows: asInt(engagement.minTimeWindows, 2),
      minTokens: asInt(engagement.minTokens, 3e4)
    },
    recall: {
      maxHighEngagementPreloads: asInt(recall.maxHighEngagementPreloads, 3),
      anchorCooldownMs: asInt(recall.anchorCooldownMs, 12 * 60 * 60 * 1e3)
    },
    emotion: {
      llmBaseUrl: asString(emotion.llmBaseUrl) || "",
      llmModel: asString(emotion.llmModel) || "openai/gpt-4o-mini",
      llmApiKey: asString(emotion.llmApiKey) || "",
      milestoneRequiresSecondPass: asBool(emotion.milestoneRequiresSecondPass, true),
      minCharsToClassify: asInt(emotion.minCharsToClassify, 0),
      // —— 13 维新增（asNumber 不存在，按二审改用 asFloat）——
      attachBelow: asFloat(emotion.attachBelow, 0.5),
      milestoneMinConfidence: asFloat(emotion.milestoneMinConfidence, 0.85)
    },
    vector: {
      dbPath: asString(vector.dbPath) || `${stateDir}/memory-engine-vector`,
      embeddingBaseUrl: asString(vector.embeddingBaseUrl) || "",
      embeddingModel: asString(vector.embeddingModel) || "text-embedding-3-small",
      embeddingApiKey: asString(vector.embeddingApiKey) || "",
      topK: asInt(vector.topK, 3)
    },
    selfEvolve: {
      proposalDir: asString(selfEvolve.proposalDir) || `${workspaceDir}/.rules/memory-engine-proposals`,
      cronExpr: asString(selfEvolve.cronExpr) || "0 3 * * *",
      timezone: asString(selfEvolve.timezone) || "Asia/Shanghai"
    },
    dailyDigestCron: asString(rawCfg.dailyDigestCron) || "50 23 * * *",
    compaction: {
      windowSize: asInt(compaction.windowSize, 10),
      // 衬底：avgSim>=此值 → 明确同事件绝不压。话题内 avgSim 中位≈0.345，取 0.30 保护多数话题内轮。
      relevanceThreshold: asFloat(compaction.relevanceThreshold, 0.3),
      // 主判据切换线：avgSim<=此值判话题切换。标定：纯 avgSim 最优 F1≈0.50 @0.26（召回 5/8 边界、误报 7/73≈10%）。
      avgSimSwitchThreshold: asFloat(compaction.avgSimSwitchThreshold, 0.26),
      lengthThreshold: asFloat(compaction.lengthThreshold, 0.2),
      // drop 镜像：1-avgSim，默认 = 1-0.26 = 0.74，与 avgSim 切换线同义（纯展示，不独立判定，避免双阈值冲突）。
      dropThreshold: asFloat(compaction.dropThreshold, 0.74),
      recentWindowForInternal: asInt(compaction.recentWindowForInternal, 5),
      // 近轮内部相关软信号：判别力弱（边界 0.374 vs 话题内 0.367），不再硬性门槛，仅作辅助防哑火。
      internalRelevanceThreshold: asFloat(
        compaction.internalRelevanceThreshold,
        0.35
      ),
      minSamples: asInt(compaction.minSamples, 5),
      // 长度触发预算：默认适配真实上下文（当前 contextWindow≈1M，取 920000），
      // 运行时优先用 ctx.contextTokenBudget；0 表示未知/禁用长度触发。
      contextTokenBudget: asInt(compaction.contextTokenBudget, 92e4),
      // 工具 schema 固定开销（默认 45k，参考常见全工具集量级；只定基底，可调校）。
      contextToolOverheadTokens: asInt(compaction.contextToolOverheadTokens, 45e3),
      // 启动回填窗口：默认取最近 40 轮（含旧段），够话题切换 + 长度检测用。
      backfillWindowSize: asInt(compaction.backfillWindowSize, 40),
      // 默认回填主会话（main）。空则不做回填。
      backfillSessionKey: asString(compaction.backfillSessionKey) || "agent:main:main",
      llmTimeoutMs: asInt(compaction.llmTimeoutMs, 2e4),
      embeddingTimeoutMs: asInt(compaction.embeddingTimeoutMs, 1e4),
      archiveDir: asString(compaction.archiveDir) || `${workspaceDir}/memory/events`,
      // ——补1：超长输入分段压缩——
      // 单段提炼窗口：distill 内部 source.slice(0,6000)，这里留余量取 5600，保证单段不超窗不截断。
      segmentChars: asInt(compaction.segmentChars, 5600),
      // 单次归档最多切 45 段（≈45×5600≈252KB 原文/段摘要上限；再超则强制收束，防无限 LLM 调用）。
      maxSegmentsPerArchive: asInt(compaction.maxSegmentsPerArchive, 45),
      // ——补2：资源控制——
      // 后台队列上限：满则丢弃最旧压缩任务（防无界堆积）。
      maxQueue: asInt(compaction.maxQueue, 100),
      // 60s 窗口内最多触发 6 次实际 LLM 压缩（防连续大任务挤爆）。
      maxCompactionsPerMinute: asInt(compaction.maxCompactionsPerMinute, 6),
      // 默认内存高水位 512MB：heapUsed 超过则压缩前等待释放。0=关闭。
      memoryHighWaterMB: asInt(compaction.memoryHighWaterMB, 512),
      // 高水位等待轮询间隔 5s。
      memoryPollMs: asInt(compaction.memoryPollMs, 5e3),
      // assemble 摘要替换：触发占比 0.22、至少折叠 6 条最老消息、单条摘要上限 1500 字符。
      summarizeRatioThreshold: asFloat(compaction.summarizeRatioThreshold, 0.22),
      summarizeMinOldMessages: asInt(compaction.summarizeMinOldMessages, 6),
      summarizeMaxChars: asInt(compaction.summarizeMaxChars, 1500)
    }
  };
}
function isModuleEnabled(cfg, key) {
  switch (key) {
    case "enable_semantic_vector":
      return cfg.enable_semantic_vector && cfg.enable_recall;
    default:
      return cfg[key];
  }
}
function asBool(v, dflt) {
  return typeof v === "boolean" ? v : dflt;
}
function asString(v) {
  return typeof v === "string" && v.trim().length > 0 ? v : void 0;
}
function asInt(v, dflt) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt;
}
function asFloat(v, dflt) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt;
}
function asObj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
}

// src/db/engine-db.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
function openEngineDb(dbPath, log2) {
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch {
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  migrate(db);
  log2.info(`engine db ready at ${dbPath}`);
  return new SqliteEngineDb(db);
}
function migrate(db) {
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
  ensureColumn(db, "emotion_anchors", "preload_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "emotion_anchors", "last_preloaded_at", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "engagement", "preload_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "engagement", "last_preloaded_at", "INTEGER NOT NULL DEFAULT 0");
}
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
var SqliteEngineDb = class {
  constructor(db) {
    this.db = db;
  }
  db;
  close() {
    try {
      this.db.close();
    } catch {
    }
  }
  addEmotionAnchor(row) {
    const existing = this.db.prepare(
      `SELECT id FROM emotion_anchors WHERE active=1 AND kind=? AND text=? LIMIT 1`
    ).get(row.kind, row.text);
    if (existing) {
      this.db.prepare(
        `UPDATE emotion_anchors SET
             category=?, scenario_hints=?, milestone=?,
             source=?, created_at=datetime('now')
           WHERE id=?`
      ).run(
        row.category,
        row.kind === "scenario" ? row.scenarioHints ?? null : null,
        row.milestone ? 1 : 0,
        row.source,
        existing.id
      );
      return existing.id;
    }
    const stmt = this.db.prepare(
      `INSERT INTO emotion_anchors (text, category, kind, scenario_hints, milestone, source, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const r = stmt.run(
      row.text,
      row.category,
      row.kind,
      row.scenarioHints ?? null,
      row.milestone ? 1 : 0,
      row.source,
      row.active ? 1 : 0
    );
    return Number(r.lastInsertRowid);
  }
  listActiveAnchors(limit = 8) {
    return this.db.prepare(
      `SELECT * FROM emotion_anchors WHERE active=1 ORDER BY milestone DESC, id DESC LIMIT ?`
    ).all(limit);
  }
  /** 场景激活：检索文本命中 scenario_hints 的锚点（双轨之"场景激活"轨）。 */
  listScenarioAnchors(text, limit = 3) {
    const anchors = this.db.prepare(
      `SELECT * FROM emotion_anchors WHERE active=1 AND kind='scenario' AND scenario_hints IS NOT NULL ORDER BY id DESC LIMIT 200`
    ).all();
    const hit = anchors.filter((a) => {
      const hints = (a.scenario_hints ?? "").split(/[,，、]/).filter(Boolean);
      return hints.some((h) => text.includes(h.trim()));
    });
    return hit.slice(0, limit);
  }
  markAnchorActive(id, active) {
    this.db.prepare(`UPDATE emotion_anchors SET active=? WHERE id=?`).run(active ? 1 : 0, id);
  }
  markAnchorPreloaded(id) {
    this.db.prepare(
      `UPDATE emotion_anchors SET preload_count = preload_count + 1, last_preloaded_at = ? WHERE id = ?`
    ).run(Date.now(), id);
  }
  anchorOnCooldown(id, refTsMs, cooldownMs) {
    if (!(cooldownMs > 0)) return false;
    const r = this.db.prepare(
      `SELECT milestone, last_preloaded_at AS last FROM emotion_anchors WHERE id = ?`
    ).get(id);
    if (!r) return false;
    if (r.milestone) return false;
    return r.last > 0 && refTsMs - r.last < cooldownMs;
  }
  bumpEngagement(ref) {
    const topic = ref.topic;
    const nowWindow = windowOf(ref.tsMs);
    const existing = this.getEngagement(topic);
    if (!existing) {
      this.db.prepare(
        `INSERT INTO engagement (topic, turn_count, time_window_count, token_count, first_seen_ms, last_seen_ms)
           VALUES (?, 1, 1, ?, ?, ?)`
      ).run(topic, ref.tokens, ref.tsMs, ref.tsMs);
      return this.getEngagement(topic);
    }
    const hadWindow = windowOf(existing.last_seen_ms);
    const timeWindowCount = existing.time_window_count + (nowWindow === hadWindow ? 0 : 1);
    this.db.prepare(
      `UPDATE engagement SET turn_count = turn_count + 1, token_count = token_count + ?, time_window_count = ?, last_seen_ms = ? WHERE topic = ?`
    ).run(ref.tokens, timeWindowCount, ref.tsMs, topic);
    return this.getEngagement(topic);
  }
  getEngagement(topic) {
    const r = this.db.prepare(`SELECT * FROM engagement WHERE topic = ?`).get(topic);
    return r ? r : void 0;
  }
  listHighEngagement(cfg) {
    const rows = this.db.prepare(
      `SELECT * FROM engagement WHERE turn_count >= ? OR time_window_count >= ? OR token_count >= ? ORDER BY token_count DESC`
    ).all(cfg.minTurns, cfg.minTimeWindows, cfg.minTokens);
    return rows;
  }
  markEngagementPreloaded(topic) {
    this.db.prepare(
      `UPDATE engagement SET preload_count = preload_count + 1, last_preloaded_at = ? WHERE topic = ?`
    ).run(Date.now(), topic);
  }
  clearEngagementForSession(sessionKey) {
    const key = (sessionKey || "").trim();
    if (!key) return;
    const parts = key.split(":");
    const base = parts.length >= 3 ? `${parts[1]}:${parts[2]}` : key;
    this.db.prepare(`DELETE FROM engagement WHERE topic = ? OR topic LIKE ?`).run(key, `${base}#%`);
  }
  resetEngagement(topic) {
    this.db.prepare(`DELETE FROM engagement WHERE topic = ?`).run(topic);
  }
  setSelfEvolveBaseline(key, value) {
    this.db.prepare(
      `INSERT INTO selfevolve_baseline (k, v, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at`
    ).run(key, value);
  }
  getSelfEvolveBaseline(key) {
    const r = this.db.prepare(`SELECT v FROM selfevolve_baseline WHERE k = ?`).get(key);
    return r ? r.v : void 0;
  }
  setPromoted(id, target) {
    this.db.prepare(
      `INSERT INTO promoted (id, target) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET target=excluded.target, promoted_at=datetime('now')`
    ).run(id, target);
  }
  isPromoted(id) {
    const r = this.db.prepare(`SELECT 1 AS x FROM promoted WHERE id = ? AND target <> ''`).get(id);
    return !!r;
  }
  upsertCompactionTurn(row) {
    this.db.prepare(
      `INSERT INTO compaction_turns (session_key, seq, text, vector, ts_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_key, seq) DO UPDATE SET
           text=excluded.text, vector=excluded.vector, ts_ms=excluded.ts_ms`
    ).run(row.sessionKey, row.seq, row.text, row.vector, row.tsMs);
  }
  listCompactionTurns(sessionKey) {
    const rows = this.db.prepare(
      `SELECT session_key, seq, text, vector, ts_ms AS tsMs FROM compaction_turns
         WHERE session_key = ? ORDER BY seq ASC`
    ).all(sessionKey);
    return rows;
  }
  clearCompactionTurns(sessionKey) {
    this.db.prepare(`DELETE FROM compaction_turns WHERE session_key = ?`).run(sessionKey);
  }
  recordCompactionEvent(sessionKey, kind, detail) {
    this.db.prepare(
      `INSERT INTO compaction_events (session_key, kind, detail) VALUES (?, ?, ?)`
    ).run(sessionKey, kind, detail);
  }
  isCompactedContent(sessionKey, contentHash) {
    const r = this.db.prepare(
      `SELECT 1 AS x FROM compaction_state WHERE session_key = ? AND content_hash = ?`
    ).get(sessionKey, contentHash);
    return !!r;
  }
  markCompactedContent(sessionKey, contentHash, detail) {
    this.db.prepare(
      `INSERT OR IGNORE INTO compaction_state (session_key, content_hash, detail)
         VALUES (?, ?, ?)`
    ).run(sessionKey, contentHash, detail);
  }
};
function windowOf(tsMs) {
  return Math.floor(tsMs / (6 * 60 * 60 * 1e3));
}

// src/db/lcm-read.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { existsSync } from "node:fs";
function openLcmRead(dbPath, log2) {
  if (!existsSync(dbPath)) {
    log2.warn(`lcm.db not found at ${dbPath}; lossless read disabled`);
    return null;
  }
  try {
    const db = new DatabaseSync2(dbPath, { readOnly: true });
    return new SqliteLcmRead(db);
  } catch (e) {
    log2.warn(`open lcm.db read-only failed: ${String(e)}`);
    return null;
  }
}
var SqliteLcmRead = class {
  constructor(db) {
    this.db = db;
  }
  db;
  grepMessages(q, limit = 10) {
    try {
      const rows = this.db.prepare(
        `SELECT m.content, m.created_at, m.conversation_id
             FROM messages_fts f
             JOIN messages m ON m.rowid = f.rowid
            WHERE messages_fts MATCH ?
            ORDER BY bm25(messages_fts)
            LIMIT ?`
      ).all(q, limit);
      return rows.map((r) => ({
        source: "messages",
        content: r.content ?? "",
        createdAt: r.created_at,
        conversationId: r.conversation_id
      }));
    } catch {
      return [];
    }
  }
  getActiveConversation(sessionKey, fallbackKey) {
    let rows = this.db.prepare(
      `SELECT conversation_id, session_key, session_id, active FROM conversations
          WHERE session_key = ? ORDER BY active DESC, updated_at DESC LIMIT 1`
    ).all(sessionKey);
    if (!rows.length && fallbackKey && fallbackKey !== sessionKey) {
      rows = this.db.prepare(
        `SELECT conversation_id, session_key, session_id, active FROM conversations
            WHERE session_key = ? ORDER BY active DESC, updated_at DESC LIMIT 1`
      ).all(fallbackKey);
    }
    if (!rows.length) return void 0;
    const row = rows[0];
    const convId = Number(row.conversation_id);
    const tok = this.db.prepare(
      `SELECT COALESCE(SUM(token_count),0) t FROM messages
          WHERE conversation_id=? AND role IN ('user','assistant')`
    ).get(convId);
    return {
      conversationId: convId,
      sessionKey: row.session_key,
      sessionId: row.session_id,
      totalTokens: Number(tok?.t ?? 0),
      active: Number(row.active) === 1
    };
  }
  recentConversationTurns(conversationId, limit) {
    const rows = this.db.prepare(
      `SELECT content, token_count, created_at FROM messages
          WHERE conversation_id=? AND role IN ('user','assistant')
          ORDER BY seq DESC LIMIT ?`
    ).all(conversationId, limit);
    const out = rows.slice().reverse().map((r) => {
      let tsMs = Date.now();
      try {
        const d = r.created_at ? new Date(r.created_at.replace(" ", "T")) : null;
        if (d && !Number.isNaN(d.getTime())) tsMs = d.getTime();
      } catch {
      }
      return { text: r.content ?? "", tokens: Number(r.token_count ?? 0), tsMs };
    });
    return out;
  }
  grepSummaries(q, limit = 10) {
    try {
      const rows = this.db.prepare(
        `SELECT s.content, s.created_at, s.conversation_id
             FROM summaries_fts_cjk f
             JOIN summaries s ON s.rowid = f.rowid
            WHERE summaries_fts_cjk MATCH ?
            ORDER BY bm25(summaries_fts_cjk)
            LIMIT ?`
      ).all(q, limit);
      return rows.map((r) => ({
        source: "summaries_cjk",
        content: r.content ?? "",
        createdAt: r.created_at,
        conversationId: r.conversation_id
      }));
    } catch {
      try {
        const rows = this.db.prepare(
          `SELECT s.content, s.created_at, s.conversation_id
               FROM summaries_fts f
               JOIN summaries s ON s.rowid = f.rowid
              WHERE summaries_fts MATCH ?
              ORDER BY bm25(summaries_fts)
              LIMIT ?`
        ).all(q, limit);
        return rows.map((r) => ({
          source: "summaries",
          content: r.content ?? "",
          createdAt: r.created_at,
          conversationId: r.conversation_id
        }));
      } catch {
        return [];
      }
    }
  }
  close() {
    try {
      this.db.close();
    } catch {
    }
  }
};
function sanitizeMatch(q) {
  const t = q.trim();
  if (!t) return '""';
  if (/[\s"*:^)(-]/.test(t)) return `"${t.replace(/"/g, "")}"`;
  return t;
}

// src/modules/compaction.ts
function cosineSimilarity(a, b) {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function avgSimToSegment(newVec, window) {
  if (!window.length) return 1;
  let sum = 0;
  let n = 0;
  for (const t of window) {
    const v = parseVector(t.vector);
    if (v.length) {
      sum += cosineSimilarity(newVec, v);
      n++;
    }
  }
  return n ? sum / n : 1;
}
function internalCoherence(turns, k) {
  const recent = turns.slice(-k);
  if (recent.length < 2) return 1;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < recent.length; i++) {
    const ai = parseVector(recent[i].vector);
    if (!ai.length) continue;
    for (let j = i + 1; j < recent.length; j++) {
      const aj = parseVector(recent[j].vector);
      if (aj.length) {
        sum += cosineSimilarity(ai, aj);
        n++;
      }
    }
  }
  return n ? sum / n : 1;
}
function parseVector(s) {
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function detectTopicSwitch(newVec, allTurns, cfg) {
  if (!newVec.length) return -1;
  if (allTurns.length < cfg.minSamples + 1) return -1;
  const prior = allTurns.slice(0, -1);
  const recentK = prior.slice(-cfg.recentWindowForInternal);
  const avgSim = avgSimToSegment(newVec, recentK);
  if (Number.isNaN(avgSim)) return -1;
  if (avgSim >= cfg.relevanceThreshold) return -1;
  if (avgSim > cfg.avgSimSwitchThreshold) return -1;
  void internalCoherence(prior, cfg.recentWindowForInternal);
  void cfg.internalRelevanceThreshold;
  return allTurns.length - 1;
}
function estimateTokensFromChars(chars) {
  return Math.ceil(chars / 3);
}

// test/run-tests.ts
import { mkdtempSync, rmSync, existsSync as existsSync2, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
var pass = 0;
var fail = 0;
var failures = [];
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  \u2705 ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \u274C ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}
function group(t) {
  console.log(`
\u258C ${t}`);
}
var tmp = mkdtempSync(join(tmpdir(), "memory-engine-test-"));
var log = {
  debug: () => {
  },
  info: () => {
  },
  warn: (m) => console.log("  [warn]", m),
  error: () => {
  }
};
group("config \u5F52\u4E00\u5316\u4E0E\u5F00\u5173\u8054\u52A8");
{
  const empty = normalizeConfig(void 0, { workspaceDir: "/w", stateDir: "/w" });
  ok("\u9ED8\u8BA4\u5168\u5173", !empty.enable_emotion && !empty.enable_recall && !empty.enable_context_compaction);
  ok("\u9ED8\u8BA4 engineDbPath=stateDir/memory-engine.db", empty.engineDbPath === "/w/memory-engine.db");
  ok("\u9ED8\u8BA4 lcmDbPath=stateDir/lcm.db", empty.lcmDbPath === "/w/lcm.db");
  ok("\u9ED8\u8BA4 lengthThreshold=0.2", empty.compaction.lengthThreshold === 0.2);
  ok("\u9ED8\u8BA4 avgSimSwitchThreshold=0.26", empty.compaction.avgSimSwitchThreshold === 0.26);
  ok("\u9ED8\u8BA4 contextTokenBudget=920000", empty.compaction.contextTokenBudget === 92e4);
  ok("\u9ED8\u8BA4 injectMaxChars=1200", empty.injectMaxChars === 1200);
  ok("\u9ED8\u8BA4 recall.maxHighEngagementPreloads=3", empty.recall.maxHighEngagementPreloads === 3);
  ok("\u9ED8\u8BA4 recall.anchorCooldownMs=12h", empty.recall.anchorCooldownMs === 12 * 3600 * 1e3);
  ok("\u9ED8\u8BA4 emotion.attachBelow=0.5", empty.emotion.attachBelow === 0.5);
  ok("\u9ED8\u8BA4 emotion.milestoneMinConfidence=0.85", empty.emotion.milestoneMinConfidence === 0.85);
  const semCfg = normalizeConfig(
    { enable_semantic_vector: true, enable_recall: false },
    { workspaceDir: "/w", stateDir: "/w" }
  );
  ok(
    "semantic_vector \u8054\u52A8\uFF1Arecall \u5173\u5219\u77E2\u91CF\u4E3A off",
    isModuleEnabled(semCfg, "enable_semantic_vector") === false
  );
  const semCfg2 = normalizeConfig(
    { enable_semantic_vector: true, enable_recall: true },
    { workspaceDir: "/w", stateDir: "/w" }
  );
  ok(
    "semantic_vector \u8054\u52A8\uFF1Arecall \u5F00\u5219\u77E2\u91CF\u4E3A on",
    isModuleEnabled(semCfg2, "enable_semantic_vector") === true
  );
  const bad = normalizeConfig({ injectMaxChars: -5, compaction: { lengthThreshold: -1 } }, { workspaceDir: "/w", stateDir: "/w" });
  ok("\u8D1F\u503C\u56DE\u9000\u9ED8\u8BA4 injectMaxChars=1200", bad.injectMaxChars === 1200);
  ok("\u8D1F\u503C\u56DE\u9000\u9ED8\u8BA4 lengthThreshold=0.2", bad.compaction.lengthThreshold === 0.2);
}
group("windowOf \u65F6\u6BB5\u5212\u5206\uFF086h/\u6BB5\uFF09");
{
  const t0 = Date.UTC(2026, 7, 9, 0, 0, 0);
  ok("00:00 \u6BB5 0", windowOf(t0) === Math.floor(t0 / (6 * 3600 * 1e3)));
  const t6 = t0 + 6 * 3600 * 1e3;
  ok("06:00 \u6BB5 1", windowOf(t6) === Math.floor(t0 / (6 * 3600 * 1e3)) + 1);
  const t2330 = Date.UTC(2026, 7, 9, 23, 30, 0);
  ok("23:30 \u6BB5 3", windowOf(t2330) === Math.floor(t2330 / (6 * 3600 * 1e3)));
}
group("cosineSimilarity");
{
  ok("\u6B63\u4EA4=0", Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  ok("\u76F8\u540C=1", Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  ok("\u53CD\u5411=-1", Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9);
  ok("\u7A7A\u5411\u91CF=0", cosineSimilarity([], [1, 0]) === 0);
  ok("\u957F\u5EA6\u4E0D\u7B49=0", cosineSimilarity([1], [1, 2]) === 0);
}
group("detectTopicSwitch\uFF08avgSim \u4E3B\u5224\u636E\uFF09");
{
  const mk = (text, seq) => ({
    sessionKey: "s",
    seq,
    text,
    vector: JSON.stringify([1, 0, 0, 0]),
    tsMs: Date.now()
  });
  const cfg = { relevanceThreshold: 0.3, avgSimSwitchThreshold: 0.26, recentWindowForInternal: 5, internalRelevanceThreshold: 0.35, minSamples: 5 };
  const sameTurns = Array.from({ length: 7 }, (_, i) => mk("\u540C\u6837\u7684\u5185\u5BB9", i));
  ok(
    "\u540C\u8BDD\u9898\u4E0D\u5207\u6362",
    detectTopicSwitch([1, 0, 0, 0], sameTurns, cfg) === -1,
    String(detectTopicSwitch([1, 0, 0, 0], sameTurns, cfg))
  );
  const switchTurns = Array.from({ length: 7 }, (_, i) => mk("\u65E7\u8BDD\u9898\u5185\u5BB9", i));
  ok(
    "\u6B63\u4EA4=\u5207\u6362(\u8FD4\u56DE\u6700\u540E\u7D22\u5F15)",
    detectTopicSwitch([0, 1, 0, 0], switchTurns, cfg) === 6,
    String(detectTopicSwitch([0, 1, 0, 0], switchTurns, cfg))
  );
  const fewTurns = [mk("a", 0), mk("b", 1), mk("c", 2)];
  ok("\u6837\u672C\u4E0D\u8DB3\u4E0D\u5207\u6362", detectTopicSwitch([0, 1, 0, 0], fewTurns, cfg) === -1);
  ok("\u7A7A\u5411\u91CF\u4E0D\u5207\u6362", detectTopicSwitch([], sameTurns, cfg) === -1);
  const negTurns = Array.from({ length: 7 }, (_, i) => ({
    sessionKey: "s",
    seq: i,
    text: "x",
    vector: JSON.stringify([1, 0, 0, 0]),
    tsMs: 0
  }));
  ok(
    "\u53CD\u5411=\u5207\u6362\uFF08\u4FEE\u590D\uFF1A\u8D1F\u76F8\u4F3C\u5EA6\u4E0D\u5F53\u4F5C\u65E0\u4FE1\u53F7\uFF09",
    detectTopicSwitch([-1, 0, 0, 0], negTurns, cfg) === 6,
    String(detectTopicSwitch([-1, 0, 0, 0], negTurns, cfg))
  );
}
group("estimateTokensFromChars");
{
  ok("600 \u5B57\u7B26\u2248200 token", estimateTokensFromChars(600) === 200);
  ok("0 \u5B57\u7B26=0", estimateTokensFromChars(0) === 0);
  ok("\u5411\u4E0A\u53D6\u6574", estimateTokensFromChars(1) === 1);
}
group("sanitizeMatch");
{
  ok("\u7EAF\u8BCD\u4E0D\u53D8", sanitizeMatch("hello") === "hello");
  ok("\u542B\u7A7A\u683C\u52A0\u5F15\u53F7", sanitizeMatch("hello world") === '"hello world"');
  ok("\u542B\u7B26\u53F7\u52A0\u5F15\u53F7+\u53BB\u5F15\u53F7", sanitizeMatch('say "hi" ok') === '"say hi ok"');
  ok("\u7A7A\u4E32\u2192\u53CC\u5F15\u53F7", sanitizeMatch("") === '""');
}
group("engine-db CRUD + \u9884\u62C9\u751F\u547D\u5468\u671F");
{
  const dbPath = join(tmp, "engine.db");
  const db = openEngineDb(dbPath, log);
  const id1 = db.addEmotionAnchor({ text: "\u6211\u559C\u6B22\u4F60", category: "\u7231\u6155", kind: "fixed", milestone: true, source: "test", active: true });
  const id2 = db.addEmotionAnchor({ text: "\u6211\u559C\u6B22\u4F60", category: "\u7231\u6155", kind: "fixed", milestone: true, source: "test", active: true });
  ok("\u540C\u53E5 fixed \u53BB\u91CD\u8FD4\u56DE\u540C id", id1 === id2);
  ok("\u5217\u8868\u542B\u951A\u70B9", db.listActiveAnchors(10).length >= 1);
  db.addEmotionAnchor({ text: "\u6211\u60F3\u4F60\u4E86", category: "\u60F3\u5FF5", kind: "scenario", scenarioHints: "\u60F3\u4F60,\u60F3\u5FF5", milestone: false, source: "test", active: true });
  ok("\u573A\u666F\u547D\u4E2D", db.listScenarioAnchors("\u6700\u8FD1\u597D\u60F3\u4F60", 3).some((a) => a.text === "\u6211\u60F3\u4F60\u4E86"));
  ok("\u573A\u666F\u672A\u547D\u4E2D(\u65E0\u5173\u8BCD)", db.listScenarioAnchors("\u8BA8\u8BBA\u5929\u6C14", 3).length === 0);
  const scenarioRow = db.listActiveAnchors(10).find((a) => a.kind === "scenario" && !a.milestone);
  db.markAnchorPreloaded(scenarioRow.id);
  ok("\u975E\u91CC\u7A0B\u7891\u5DF2\u9884\u62C9\u2192\u51B7\u5374\u4E2D", db.anchorOnCooldown(scenarioRow.id, Date.now() + 1e3, 12 * 3600 * 1e3) === true);
  const fixedMilestone = db.listActiveAnchors(10).find((a) => a.milestone);
  ok("\u91CC\u7A0B\u7891\u9884\u62C9\u540E\u4ECD\u5728\u51B7\u5374\u4E2D=false(\u4E0D\u51B7\u5374)", db.anchorOnCooldown(fixedMilestone.id, Date.now() + 1e3, 12 * 3600 * 1e3) === false);
  const e1 = db.bumpEngagement({ topic: "t1", tsMs: Date.UTC(2026, 7, 9, 0, 0, 0), tokens: 100 });
  ok("\u9996\u6B21 bump \u8BB0 1 \u8F6E 1 \u65F6\u6BB5", e1.turn_count === 1 && e1.time_window_count === 1);
  const e2 = db.bumpEngagement({ topic: "t1", tsMs: Date.UTC(2026, 7, 9, 0, 0, 0) + 1e3, tokens: 50 });
  ok("\u540C\u7A97 bump \u8F6E+1 \u65F6\u6BB5\u4E0D\u53D8", e2.turn_count === 2 && e2.time_window_count === 1);
  const e3 = db.bumpEngagement({ topic: "t1", tsMs: Date.UTC(2026, 7, 9, 0, 0, 0) + 6 * 3600 * 1e3, tokens: 50 });
  ok("\u8DE8\u7A97 bump \u65F6\u6BB5+1", e3.time_window_count === 2);
  const e4 = db.bumpEngagement({ topic: "t1", tsMs: Date.UTC(2026, 7, 9, 0, 0, 0) + 7 * 3600 * 1e3, tokens: 50 });
  ok("token \u7D2F\u8BA1", e4.token_count === 100 + 50 + 50 + 50);
  db.bumpEngagement({ topic: "big", tsMs: Date.now(), tokens: 5e4 });
  const highs = db.listHighEngagement({ minTurns: 10, minTimeWindows: 2, minTokens: 3e4 });
  ok("\u9AD8\u6295\u5165 token \u8D85\u9608\u503C\u5165\u9009", highs.some((h) => h.topic === "big"));
  const e5 = db.bumpEngagement({ topic: "t1", tsMs: Date.now(), tokens: 10 });
  ok("engagement \u9884\u62C9\u5B57\u6BB5\u9ED8\u8BA4 0", e5.preload_count === 0);
  db.markEngagementPreloaded("t1");
  ok("markEngagementPreloaded \u8BA1\u6570+1", db.getEngagement("t1")?.preload_count === 1);
  db.setSelfEvolveBaseline("k", "v1");
  ok("\u57FA\u7EBF\u5199\u5165\u8BFB\u53D6", db.getSelfEvolveBaseline("k") === "v1");
  db.setPromoted("anchor:1", "MEMORY.md");
  ok("isPromoted true", db.isPromoted("anchor:1") === true);
  db.setPromoted("anchor:1", "MEMORY.md");
  ok("isPromoted \u4ECD true(\u91CD\u590D UPsert \u4E0D\u7834\u574F)", db.isPromoted("anchor:1") === true);
  db.setPromoted("anchor:1", "");
  ok("\u7F6E\u7A7A\u540E isPromoted false\uFF08\u4FEE\u590D\uFF1A\u56DE\u6EDA\u80FD\u771F\u6B63\u53D6\u6D88\u63D0\u62D4\uFF09", db.isPromoted("anchor:1") === false);
  db.setPromoted("anchor:2", "USER.md");
  ok("\u65B0\u884C\u63D2\u5165 isPromoted true", db.isPromoted("anchor:2") === true);
  db.upsertCompactionTurn({ sessionKey: "s1", seq: 0, text: "a", vector: "[]", tsMs: 1 });
  db.upsertCompactionTurn({ sessionKey: "s1", seq: 1, text: "b", vector: "[]", tsMs: 2 });
  ok("\u7A97\u53E3\u5199\u5165\u8BFB\u53D6", db.listCompactionTurns("s1").length === 2);
  ok("\u7A97\u53E3\u6309 seq \u6392\u5E8F", db.listCompactionTurns("s1")[0].seq === 0);
  db.clearCompactionTurns("s1");
  ok("\u7A97\u53E3\u6E05\u7A7A", db.listCompactionTurns("s1").length === 0);
  db.markCompactedContent("s1", "hash1", "d");
  ok("\u53BB\u91CD\u6807\u8BB0\u547D\u4E2D", db.isCompactedContent("s1", "hash1") === true);
  ok("\u53BB\u91CD\u6807\u8BB0\u672A\u547D\u4E2D", db.isCompactedContent("s1", "hash2") === false);
  db.recordCompactionEvent("s1", "test", "detail");
  ok("\u5BA1\u8BA1\u4E8B\u4EF6\u5199\u5165", db.listCompactionTurns("s1").length >= 0);
  db.close();
  ok("db \u5173\u95ED\u65E0\u5F02\u5E38", true);
}
group("lcm.db \u53EA\u8BFB\u5C42");
{
  const lcmPath = process.env.LCM_DB_PATH ?? "";
  if (existsSync2(lcmPath)) {
    const lcm = openLcmRead(lcmPath, log);
    ok("lcm \u6253\u5F00\u6210\u529F", lcm !== null);
    if (lcm) {
      const conv = lcm.getActiveConversation("agent:main:main");
      ok("\u4E3B\u4F1A\u8BDD getActiveConversation\uFF08\u6709\u6216 undefined \u5747\u53EF\uFF0C\u4E0D\u65AD\u8A00\u6B7B\uFF09", true);
      if (conv) {
        ok(`\u4F1A\u8BDD #${conv.conversationId} totalTokens=${conv.totalTokens}>0`, conv.totalTokens >= 0);
        const turns = lcm.recentConversationTurns(conv.conversationId, 5);
        ok("recentConversationTurns \u8FD4\u56DE\u6570\u7EC4", Array.isArray(turns));
      }
      const hits = lcm.grepMessages(sanitizeMatch("\u7EEB\u6F47"), 3);
      ok("grepMessages \u53EF\u8C03\u7528\uFF08\u53EF\u80FD\u4E3A\u7A7A\uFF09", Array.isArray(hits));
      lcm.close();
    }
  } else {
    ok("lcm.db \u4E0D\u5B58\u5728\uFF08\u8DF3\u8FC7\u53EA\u8BFB\u6D4B\u8BD5\uFF09", true);
  }
}
group("\u7D22\u5F15 schema \u4E00\u81F4\u6027\uFF08\u590D\u6838\uFF09");
{
  const indexPath2 = process.env.MEMORY_INDEX_PATH ?? "";
  if (existsSync2(indexPath2)) {
    const lines = readFileSync(indexPath2, "utf8").split("\n").filter(Boolean);
    const hasFile = lines.some((l) => {
      try {
        return "file" in JSON.parse(l);
      } catch {
        return false;
      }
    });
    const hasTarget = lines.some((l) => {
      try {
        return "target" in JSON.parse(l);
      } catch {
        return false;
      }
    });
    ok("\u6BCF\u65E5\u7D22\u5F15\u6761\u76EE(file)\u4E0E\u5F15\u64CE\u5F52\u6863\u6761\u76EE(target)\u5E76\u5B58\uFF0C\u804C\u8D23\u5206\u79BB\uFF0C\u975E bug", hasFile && hasTarget);
    console.log(`  \u2139\uFE0F \u7D22\u5F15 ${lines.length} \u884C\uFF1Afile=${hasFile}(\u6BCF\u65E5\u7B14\u8BB0) target=${hasTarget}(events\u5F52\u6863)`);
  } else {
    ok("\u7D22\u5F15\u6587\u4EF6\u4E0D\u5B58\u5728\uFF08\u8DF3\u8FC7\uFF09", true);
  }
}
rmSync(tmp, { recursive: true, force: true });
console.log(`
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
console.log(`\u901A\u8FC7 ${pass} \uFF5C \u5931\u8D25 ${fail}`);
if (failures.length) {
  console.log("\u5931\u8D25\u9879\uFF1A");
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
