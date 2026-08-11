/**
 * cn-fts.ts — 中文 FTS5 检索（方案甲：node:sqlite 中文 bigram 索引）
 *
 * 背景：lossless lcm.db 的 messages_fts 用 porter unicode61，对中文双字词
 * （失望/在乎/依赖…）完全检索不到。本模块在 memory-engine.db 里建一张
 * 中文 bigram FTS5 索引表，从 lcm.db 只读同步 messages，供 mem_find/预拉
 * 做中文检索增强。零依赖，不需要 ngram 编译扩展。
 *
 * 不污染 lcm.db；只在 memory-engine.db 侧新增 cn_messages_fts 表。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { cnTokenize, textHasCJK } from "./cn-tokenize.js";
import { Logger } from "./log.js";

export interface CnHit {
  source: "cn_messages";
  content: string;
  createdAt: string | null;
  conversationId: string | null;
  /** BM25 相关性分（越高越相关） */
  rank: number;
}

/**
 * 在 memory-engine.db 上建中文 FTS5 索引（幂等）。
 * - 若 cn_messages_fts 已存在且条数与 lcm.db messages 一致 → 跳过（增量友好）
 * - 否则 DROP 重建 + 全量同步
 *
 * @param engineDbPath memory-engine.db 路径（插件自管，可写）
 * @param lcmDbPath    lossless lcm.db 路径（只读数据源）
 * @param log          Logger
 * @returns 本次插入条数；lcm.db 缺失/失败返回 -1
 */
export function buildCnFtsIndex(
  engineDbPath: string,
  lcmDbPath: string,
  log: Logger,
): number {
  try {
    if (!existsSync(lcmDbPath)) {
      log.warn(`[cn-fts] lcm.db not found @ ${lcmDbPath}; cn index skipped`);
      return -1;
    }
    const lcmDb = new DatabaseSync(lcmDbPath, { readOnly: true });
    const cnt = lcmDb
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE role IN ('user','assistant')")
      .get() as { c: number };
    const msgCount = Number(cnt?.c ?? 0);
    lcmDb.close();

    const db = new DatabaseSync(engineDbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS cn_messages_fts (
        msg_rowid INTEGER PRIMARY KEY,
        content TEXT NOT NULL,
        tok TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS cn_messages_fts_idx USING fts5(
        tok, content,
        tokenize='unicode61'
      );
    `);
    const already = db
      .prepare("SELECT COUNT(*) AS c FROM cn_messages_fts")
      .get() as { c: number };
    if (Number(already?.c ?? 0) >= msgCount && msgCount > 0) {
      log.info(`[cn-fts] cn index up-to-date (${already.c}/${msgCount}); skip`);
      db.close();
      return 0;
    }

    // 全量重建：清空旧表，从 lcm.db 只读同步
    db.exec("DELETE FROM cn_messages_fts");
    db.exec("DELETE FROM cn_messages_fts_idx");
    const lcm = new DatabaseSync(lcmDbPath, { readOnly: true });
    const rows = lcm
      .prepare(
        "SELECT rowid AS rid, content, created_at FROM messages WHERE role IN ('user','assistant') ORDER BY rowid",
      )
      .all() as unknown as Array<{ rid: number; content: string; created_at: string | null }>;
    const insFts = db.prepare(
      "INSERT INTO cn_messages_fts_idx(rowid, tok, content) VALUES (?, ?, ?)",
    );
    const insMeta = db.prepare(
      "INSERT OR IGNORE INTO cn_messages_fts(msg_rowid, content, tok) VALUES (?, ?, ?)",
    );
    db.exec("BEGIN");
    let inserted = 0;
    for (const r of rows) {
      const content = r?.content ?? "";
      if (!content.trim()) continue;
      const tok = cnTokenize(content);
      if (!tok) continue;
      insFts.run(Number(r.rid), tok, content);
      insMeta.run(Number(r.rid), content, tok);
      inserted++;
    }
    db.exec("COMMIT");
    lcm.close();
    db.close();
    log.info(`[cn-fts] built cn index: ${inserted} messages (lcm has ${msgCount})`);
    return inserted;
  } catch (e) {
    try {
      const db = new DatabaseSync(engineDbPath);
      db.exec("ROLLBACK");
      db.close();
    } catch {
      /* rollback best-effort */
    }
    log.warn(`[cn-fts] build failed: ${String(e)}`);
    return -1;
  }
}

/**
 * 中文检索：若 query 含中文 → 切 bigram token MATCH。
 * 非中文 query → 返回空（调用方走原 messages_fts/其它逻辑）。
 */
export function grepCnMessages(
  engineDbPath: string,
  q: string,
  limit = 10,
): CnHit[] {
  if (!q || !textHasCJK(q)) return [];
  const tok = cnTokenize(q);
  if (!tok) return [];
  try {
    const db = new DatabaseSync(engineDbPath, { readOnly: true });
    // 用 bigram token 匹配（BM25 排序，内容里也要求有完整短语，降误伤）
    const rows = db
      .prepare(
        `SELECT content, created_at, conversation_id,
                bm25(cn_messages_fts_idx, 0.0, 1.0) AS rank
           FROM cn_messages_fts_idx
          WHERE cn_messages_fts_idx MATCH ?
          ORDER BY rank DESC
          LIMIT ?`,
      )
      .all(tok, limit) as unknown as Array<{
      content: string;
      created_at: string | null;
      conversation_id: string | null;
      rank: number;
    }>;
    db.close();
    return rows.map((r) => ({
      source: "cn_messages",
      content: r?.content ?? "",
      createdAt: r?.created_at ?? null,
      conversationId: r?.conversation_id ?? null,
      rank: Number(r?.rank ?? 0),
    }));
  } catch {
    return [];
  }
}
