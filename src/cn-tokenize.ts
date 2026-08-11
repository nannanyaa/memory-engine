/**
 * cn-tokenize.ts — 中文 FTS5 bigram 分词（方案甲，借鉴 Mnemosyne + 自研）
 *
 * 背景：memory-engine 的 lcm.db messages_fts 用 porter unicode61，对中文
 * 双字词（失望/在乎/依赖…）完全检索不到。本模块负责把中文文本切成
 * FTS5(unicode61) 可索引的 token 串（单字 token + bigram token + 英文原样），
 * 查询时同法切词 → MATCH，从而让中文双字词能通过 FTS 索引精确召回。
 *
 * 零依赖、纯 Node，不需要 ngram 编译扩展（node:sqlite/build 内 unicode61 即够）。
 */
const CJK = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/;

/** 单个汉字 → 单字 token（unicode61 能索引的 ASCII 安全串） */
function charToken(ch: string): string {
  return "c" + ch.codePointAt(0)!.toString(16);
}

/** 相邻两汉字 → bigram token */
function bigramToken(a: string, b: string): string {
  return "b" + a.codePointAt(0)!.toString(16) + "_" + b.codePointAt(0)!.toString(16);
}

/**
 * 把一段输入文本切成 FTS5 可索引的 token 串（空格分隔）。
 * - 连续中文段 → 逐字单字 token + 相邻双字 bigram token
 * - 英文/数字/符号 → 按原样切分（unicode61 自然处理）
 */
export function cnTokenize(text: string): string {
  if (!text) return "";
  const out: string[] = [];
  // 按「是否 CJK」分组切分
  const parts = text.split(/(?=[\u4e00-\u9fff\u3400-\u4dbf])|(?<=[\u4e00-\u9fff\u3400-\u4dbf])/);
  for (const p of parts) {
    if (!p) continue;
    const isCJK = /^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(p);
    if (isCJK) {
      const cs = Array.from(p); // 按码点展开（含代理对）
      for (let i = 0; i < cs.length; i++) {
        out.push(charToken(cs[i]));
        if (i < cs.length - 1) out.push(bigramToken(cs[i], cs[i + 1]));
      }
    } else {
      const trimmed = p.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out.join(" ");
}

/** 判定一段文本是否含中文（需要在 cn FTS 里查） */
export function textHasCJK(text: string): boolean {
  return CJK.test(text);
}
