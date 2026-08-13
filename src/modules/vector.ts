/**
 * vector.ts — 语义向量检索（模块：enable_semantic_vector；需要 enable_recall 联动）
 *
 * 南南拍板 #2：语义向量必上（云 embedding），解决"关键词不匹配导致漏匹配"硬伤。
 *
 * 设计：
 *   - 云端 embedding API（OpenAI 兼容），端点/模型/key 全部可配置。
 *   - 本地 lancedb 存向量（arm64 已验证可用）。
 *   - @lancedb/lancedb 用动态 import + try/catch：未安装即降级为空（默认关）。
 *
 * 本文件默认关且依赖可选，直接导入失败不阻断指令。
 */

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

/** 云端 embedding（OpenAI /embeddings 兼容）。 */
export async function createCloudEmbedding(rt: {
  cfg: { vector: { embeddingBaseUrl: string; embeddingModel: string; embeddingApiKey: string } };
}): Promise<EmbeddingProvider | null> {
  const v = rt.cfg.vector;
  if (!v.embeddingBaseUrl || !v.embeddingModel) return null;
  return {
    async embed(texts: string[]) {
      const res = await fetch(`${v.embeddingBaseUrl.replace(/\/+$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(v.embeddingApiKey ? { Authorization: `Bearer ${v.embeddingApiKey}` } : {}),
        },
        body: JSON.stringify({ model: v.embeddingModel, input: texts }),
      });
      if (!res.ok) throw new Error(`embedding http ${res.status}`);
      const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
      return (data.data ?? []).map((d) => d.embedding);
    },
  };
}

/**
 * 语义检索：把 query 向量化，与本地 lancedb 表做距离排序。
 * 依赖 @lancedb/lancedb（可选）。未安装/未配置 -> 返回 []。
 */
export async function searchVector(
  rt: {
    cfg: {
      vector: { dbPath: string; embeddingBaseUrl: string; embeddingModel: string; embeddingApiKey: string; topK: number };
    };
    log: { debug(msg: string): void };
  },
  query: string,
  limit: number,
): Promise<string[]> {
  try {
    const provider = await createCloudEmbedding(rt);
    if (!provider) return [];
    const [[qvec]] = await provider.embed([query]);

    // 动态加载 lancedb（可选依赖）
    const lancedb = await import("@lancedb/lancedb");
    const db = await lancedb.connect(rt.cfg.vector.dbPath);
    const table = await db.openTable("memories");
    const results = await table.vectorSearch(qvec).limit(limit).toArray();
    void rt;
    return (results as Array<{ text?: string | null }>)
      .map((r) => r.text ?? "")
      .filter((t) => t.trim().length > 0);
  } catch (e) {
    rt.log.debug(`[vector] search disabled or failed: ${String(e)}`);
    return [];
  }
}

/**
 * 落库：把文档/笔记写入向量表。
 * 供后续"语义化蒸馏"用；MVP 预留接口，默认不调用。
 */
export async function upsertToVector(
  rt: {
    cfg: { vector: { dbPath: string; embeddingBaseUrl: string; embeddingModel: string; embeddingApiKey: string } };
    log: { debug(msg: string): void };
  },
  texts: string[],
): Promise<void> {
  try {
    const provider = await createCloudEmbedding(rt);
    if (!provider || texts.length === 0) return;
    const embeddings = await provider.embed(texts);
    const lancedb = await import("@lancedb/lancedb");
    const db = await lancedb.connect(rt.cfg.vector.dbPath);
    const data = texts.map((text, i) => ({
      text,
      vector: embeddings[i] as unknown as number[],
    }));
    try {
      const table = await db.openTable("memories");
      await table.add(data as never);
    } catch {
      await db.createTable("memories", data as never);
    }
    void rt;
  } catch (e) {
    rt.log.debug(`[vector] upsert failed: ${String(e)}`);
  }
}

/**
 * 归档入口（薄封装，不重复 embedding）：把 dim/事件归档文本写入向量索引。
 * 直接复用 upsertToVector（内嵌 embedding），由调用点注入。
 */
export async function addToVectorIndex(
  rt: {
    cfg: { vector: { dbPath: string; embeddingBaseUrl: string; embeddingModel: string; embeddingApiKey: string } };
    log: { debug(msg: string): void };
  },
  entry: { text: string; type: "dim" | "event" },
): Promise<{ ok: boolean; type: string; len: number }> {
  if (!entry.text.trim()) return { ok: false, type: entry.type, len: 0 };
  try {
    await upsertToVector(rt, [entry.text.slice(0, 2000)]);
    return { ok: true, type: entry.type, len: entry.text.length };
  } catch (e) {
    rt.log.debug(`[vector] addToVectorIndex failed: ${String(e)}`);
    return { ok: false, type: entry.type, len: 0 };
  }
}
