/**
 * BM25 retrieval with IDF-weighted coverage gating.
 *
 * The scoring model is deliberately split into two numbers because they answer
 * two different questions:
 *
 *   coverage - "how much of what the student asked is actually present in this
 *               passage?" Weighted by IDF, so matching a rare technical term
 *               counts far more than matching a common one. This is the gate:
 *               if coverage is low, the material genuinely does not answer the
 *               question and we must say so instead of inventing an answer.
 *
 *   bm25     - "how well does this passage stand out among the candidates?"
 *               Used only to order passages that already passed the gate.
 *
 * Keeping them separate is what makes the "insufficient material" fallback
 * honest and testable rather than a vibe.
 */
import { contentTokens } from './tokenize.js';

const K1 = 1.2;
const B = 0.75;

export function buildIndex(documents) {
  const docs = [];
  const df = new Map();
  let totalLength = 0;

  for (const doc of documents) {
    const tokens = contentTokens(doc.text);
    if (tokens.length === 0) continue;
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
    docs.push({ ref: doc.ref, length: tokens.length, tf });
    totalLength += tokens.length;
  }

  const N = docs.length;
  const idf = new Map();
  for (const [token, freq] of df) {
    // Standard BM25 idf, floored at 0 so a term in every document cannot push
    // scores negative.
    idf.set(token, Math.max(0, Math.log(1 + (N - freq + 0.5) / (freq + 0.5))));
  }

  return {
    docs,
    df,
    idf,
    N,
    avgdl: N > 0 ? totalLength / N : 0,
    docCount: N,
  };
}

export function lexemeIdf(index, token) {
  return index.idf.get(token) ?? Math.log(1 + (index.N + 1) / 1);
}

export function searchIndex(index, query, { topK = 4, minScore = 0 } = {}) {
  const queryTokens = contentTokens(query);
  const unique = [...new Set(queryTokens)];
  if (index.N === 0 || unique.length === 0) {
    return {
      results: [],
      candidates: [],
      queryTerms: unique,
      unknownTerms: unique,
      knownTerms: 0,
      maxUnknownTerms: 0,
      vocabularyOk: unique.length === 0,
      reason: index.N === 0 ? 'empty_index' : 'no_content_terms',
      maxBm25: 0,
    };
  }

  // Coverage is measured against the vocabulary the corpus actually knows.
  // Words the index has never seen ("absorption" when the notes say "absorbs",
  // or a rare paraphrase) are treated as noise rather than as evidence that the
  // material is irrelevant - otherwise one synonym would refuse a question the
  // notes plainly answer. A question whose terms are ALL unknown still scores 0
  // and is correctly refused.
  let totalIdf = 0;
  const queryIdf = new Map();
  const unknownTerms = [];
  for (const token of unique) {
    const idf = lexemeIdf(index, token);
    queryIdf.set(token, idf);
    if (index.df.has(token)) totalIdf += idf;
    else unknownTerms.push(token);
  }

  const scored = [];
  for (const doc of index.docs) {
    let bm25 = 0;
    let matchedIdf = 0;
    const matchedTerms = [];

    for (const token of unique) {
      const tf = doc.tf.get(token);
      if (!tf) continue;
      const idf = queryIdf.get(token);
      const denominator = tf + K1 * (1 - B + (B * doc.length) / (index.avgdl || 1));
      bm25 += idf * ((tf * (K1 + 1)) / denominator);
      matchedIdf += idf;
      matchedTerms.push(token);
    }

    if (matchedTerms.length === 0) continue;
    scored.push({
      ref: doc.ref,
      bm25,
      coverage: totalIdf > 0 ? matchedIdf / totalIdf : 0,
      matchedTerms,
    });
  }

  // Second half of the gate: how much of the question did the corpus even
  // understand? Coverage alone is not enough, because a long question about an
  // unrelated topic that happens to contain one common word ("...pgbouncer
  // transaction mode" against notes that define *transaction*) would show 100%
  // coverage of the one word it understood and be answered confidently. In a
  // study assistant a confident wrong answer is far worse than a refusal, so a
  // majority-unknown question is refused and the student is told which words
  // their material does not contain.
  const maxUnknownTerms = Math.max(1, Math.floor(unique.length * 0.5));
  const vocabularyOk = unknownTerms.length <= maxUnknownTerms;

  const maxBm25 = scored.reduce((max, s) => Math.max(max, s.bm25), 0);

  const results = scored
    .map((s) => {
      const bm25Share = maxBm25 > 0 ? s.bm25 / maxBm25 : 0;
      return {
        ...s,
        bm25Share,
        // Coverage is the gate; BM25 only breaks ties between comparable hits.
        rank: Number((s.coverage * 0.7 + bm25Share * 0.3).toFixed(6)),
      };
    })
    .filter((s) => s.coverage >= minScore)
    .sort((a, b) => b.rank - a.rank || b.coverage - a.coverage || b.bm25 - a.bm25)
    .slice(0, topK);

  const accepted = vocabularyOk ? results : [];

  return {
    results: accepted,
    // `candidates` keeps the low-confidence hits so the UI can show "the closest
    // thing in your notes" without ever presenting it as an answer.
    candidates: vocabularyOk ? results : results.slice(0, 3),
    queryTerms: unique,
    unknownTerms,
    knownTerms: unique.length - unknownTerms.length,
    maxUnknownTerms,
    vocabularyOk,
    reason: !vocabularyOk
      ? 'too_many_unknown_terms'
      : results.length === 0
        ? 'no_passage_above_threshold'
        : null,
    maxBm25,
  };
}

/**
 * Best snippet for a passage: the densest window of matched query terms.
 * Used for keyword highlighting in the materials browser.
 */
export function buildSnippet(text, matchedTerms, { maxChars = 260 } = {}) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  if (matchedTerms.length === 0) return `${flat.slice(0, maxChars)}...`;

  const lower = flat.toLowerCase();
  let bestIndex = -1;
  let bestHits = -1;
  for (const term of matchedTerms) {
    let from = 0;
    while (from < lower.length) {
      const at = lower.indexOf(term, from);
      if (at === -1) break;
      const window = lower.slice(at, at + maxChars);
      const hits = matchedTerms.filter((t) => window.includes(t)).length;
      if (hits > bestHits) {
        bestHits = hits;
        bestIndex = at;
      }
      from = at + term.length;
    }
  }
  if (bestIndex === -1) return `${flat.slice(0, maxChars)}...`;

  const start = Math.max(0, bestIndex - Math.floor(maxChars / 4));
  const end = Math.min(flat.length, start + maxChars);
  return `${start > 0 ? '...' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '...' : ''}`;
}

export default { buildIndex, searchIndex, buildSnippet, lexemeIdf };
