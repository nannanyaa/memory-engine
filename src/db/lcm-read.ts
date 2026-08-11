/**
 * lcm-read.ts — lossless lcm.db 只读直连
 *
 * 只读（WAL 只读模式）打开 lcm.db，复制 lcm_grep 的 FTS5 语义化召回能力，
 * 供检索增强（mem_find）与预拉补充细节使用。绝不写 lcm.db。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { Logger } from "../log.js";

export interface LcmHit {
  /** 命中来源：messages_fts | summaries_fts | summaries_fts_cjk */
  source: string;
  content: string;
  createdAt: string | null;
  conversationId: string | null;
}

export interface BackfillConv {
  conversationId: number;
  sessionKey: string;
  sessionId: string;
  /** 该会话 user+assistant 消息 token 总和（用于长度触发） */
  totalTokens: number;
  active: boolean;
}

export interface BackfillTurn {
  text: string;
  tokens: number;
  tsMs: number;
}

export interface LcmRead {
  /** FTS5 全文本检索 messages 表。 */
  grepMessages(q: string, limit?: number): LcmHit[];
  /** FTS5 全文本检索 summaries（含 CJK 变体 union）。 */
  grepSummaries(q: string, limit?: number): LcmHit[];
  /** 取某个 session_key 最新活动会话（优先 active=1）。 */
  getActiveConversation(
    sessionKey: string,
    fallbackKey?: string,
  ): BackfillConv | undefined;
  /** 取会话最近 limit 条 user/assistant 消息（seq 升序，最老在前）。 */
  recentConversationTurns(conversationId: number, limit: number): BackfillTurn[];
}

/** 只读打开 lcm.db。打开失败返回 null（不阻断主线）。 */
export function openLcmRead(dbPath: string, log: Logger): LcmRead | null {
  if (!existsSync(dbPath)) {
    log.warn(`lcm.db not found at ${dbPath}; lossless read disabled`);
    return null;
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    return new SqliteLcmRead(db);
  } catch (e) {
    log.warn(`open lcm.db read-only failed: ${String(e)}`);
    return null;
  }
}

class SqliteLcmRead implements LcmRead {
  constructor(private readonly db: DatabaseSync) {}

  grepMessages(q: string, limit = 10): LcmHit[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT m.content, m.created_at, m.conversation_id
             FROM messages_fts f
             JOIN messages m ON m.rowid = f.rowid
            WHERE messages_fts MATCH ?
            ORDER BY bm25(messages_fts)
            LIMIT ?`,
        )
        .all(q, limit) as unknown as Array<{ content: string; created_at: string | null; conversation_id: string | null }>;
      return rows.map((r) => ({
        source: "messages",
        content: r.content ?? "",
        createdAt: r.created_at,
        conversationId: r.conversation_id,
      }));
    } catch {
      return [];
    }
  }

  getActiveConversation(
    sessionKey: string,
    fallbackKey?: string,
  ): BackfillConv | undefined {
    // 1) 精确匹配 + active：取 active 会话中 updated 最新者
    let rows = this.db
      .prepare(
        `SELECT conversation_id, session_key, session_id, active FROM conversations
          WHERE session_key = ? ORDER BY active DESC, updated_at DESC LIMIT 1`,
      )
      .all(sessionKey) as unknown as Array<{
      conversation_id: number;
      session_key: string;
      session_id: string;
      active: number;
    }>;
    // 2) 回退：按前缀匹配（compaction 内部把 main:main 的 key 转成 agent:main:main）
    if (!rows.length && fallbackKey && fallbackKey !== sessionKey) {
      rows = this.db
        .prepare(
          `SELECT conversation_id, session_key, session_id, active FROM conversations
            WHERE session_key = ? ORDER BY active DESC, updated_at DESC LIMIT 1`,
        )
        .all(fallbackKey) as unknown as Array<{
        conversation_id: number;
        session_key: string;
        session_id: string;
        active: number;
      }>;
    }
    if (!rows.length) return undefined;
    const row = rows[0];
    const convId = Number(row.conversation_id);
    const tok = this.db
      .prepare(
        `SELECT COALESCE(SUM(token_count),0) t FROM messages
          WHERE conversation_id=? AND role IN ('user','assistant')`,
      )
      .get(convId) as { t: number };
    return {
      conversationId: convId,
      sessionKey: row.session_key,
      sessionId: row.session_id,
      totalTokens: Number(tok?.t ?? 0),
      active: Number(row.active) === 1,
    };
  }

  recentConversationTurns(conversationId: number, limit: number): BackfillTurn[] {
    const rows = this.db
      .prepare(
        `SELECT content, token_count, created_at FROM messages
          WHERE conversation_id=? AND role IN ('user','assistant')
          ORDER BY seq DESC LIMIT ?`,
      )
      .all(conversationId, limit) as unknown as Array<{
      content: string;
      token_count: number;
      created_at: string | null;
    }>;
    // 倒序取回后正序回填（旧在前新在后）
    const out = rows
      .slice()
      .reverse()
      .map((r) => {
        let tsMs = Date.now();
        try {
          const d = r.created_at ? new Date(r.created_at.replace(" ", "T")) : null;
          if (d && !Number.isNaN(d.getTime())) tsMs = d.getTime();
        } catch {
          /* fallback now */
        }
        return { text: r.content ?? "", tokens: Number(r.token_count ?? 0), tsMs };
      });
    return out;
  }

  grepSummaries(q: string, limit = 10): LcmHit[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT s.content, s.created_at, s.conversation_id
             FROM summaries_fts_cjk f
             JOIN summaries s ON s.rowid = f.rowid
            WHERE summaries_fts_cjk MATCH ?
            ORDER BY bm25(summaries_fts_cjk)
            LIMIT ?`,
        )
        .all(q, limit) as unknown as Array<{ content: string; created_at: string | null; conversation_id: string | null }>;
      return rows.map((r) => ({
        source: "summaries_cjk",
        content: r.content ?? "",
        createdAt: r.created_at,
        conversationId: r.conversation_id,
      }));
    } catch {
      try {
        const rows = this.db
          .prepare(
            `SELECT s.content, s.created_at, s.conversation_id
               FROM summaries_fts f
               JOIN summaries s ON s.rowid = f.rowid
              WHERE summaries_fts MATCH ?
              ORDER BY bm25(summaries_fts)
              LIMIT ?`,
          )
          .all(q, limit) as unknown as Array<{ content: string; created_at: string | null; conversation_id: string | null }>;
        return rows.map((r) => ({
          source: "summaries",
          content: r.content ?? "",
          createdAt: r.created_at,
          conversationId: r.conversation_id,
        }));
      } catch {
        return [];
      }
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

/** 对 FTS MATCH 查询体做基本清洗，避免空串/非法字面量抛错。 */
export function sanitizeMatch(q: string): string {
  const t = q.trim();
  if (!t) return "\"\"";
  // 换成双引号短语，避免特殊字符破坏 FTS 语法
  if (/[\s"*:^)(-]/.test(t)) return `"${t.replace(/"/g, "")}"`;
  return t;
}
