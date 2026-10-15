/**
 * Key-term extraction.
 *
 * A study summary is only useful if it names the terms the student has to be
 * able to define, so this module finds them deterministically from the
 * passages alone - no model call, no guessing, and the same answer every time
 * for the same input.
 *
 * Scoring is deliberately simple and explainable: a term that repeats often,
 * in only some of the passages, is what a topic is actually about. A term in
 * nearly every passage is boilerplate ("chapter", "figure"), so it is dropped.
 */
import { contentTokens } from '../retrieval/tokenize.js';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The surface form of a stemmed term, so the UI shows the word the student
 * will actually see in their document rather than the trimmed stem.
 */
function displayForm(stem, passage) {
  const haystack = `${passage.heading ?? ''}\n${passage.text}`;
  const pattern = new RegExp(`[\\p{L}\\p{M}]*${escapeRegExp(stem)}[\\p{L}\\p{M}]*`, 'u');
  const match = pattern.exec(haystack);
  return match ? match[0] : stem;
}

/**
 * @param {{id:string,documentName:string,pageNumber:number,heading?:string,text:string}[]} passages
 * @param {{limit?:number,minCount?:number,maxSpread?:number}} options
 */
export function extractKeyTerms(passages, { limit = 12, minCount = 2, maxSpread = 0.9 } = {}) {
  const list = Array.isArray(passages) ? passages : [];
  const total = Math.max(1, list.length);
  const documentFrequency = new Map();
  const frequency = new Map();
  const firstSeen = new Map();

  for (const passage of list) {
    const tokens = contentTokens(`${passage.heading ?? ''} ${passage.text}`);
    const seen = new Set();
    for (const token of tokens) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
      if (!firstSeen.has(token)) firstSeen.set(token, passage);
      if (!seen.has(token)) seen.add(token);
    }
    for (const token of seen) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }

  const topical = [];
  const everywhere = [];

  for (const [stem, count] of frequency) {
    if (count < minCount) continue;
    const spread = (documentFrequency.get(stem) ?? 1) / total;
    const rarity = Math.log(1 + total / (1 + (documentFrequency.get(stem) ?? 1)));
    const score = Math.log(1 + count) * rarity * (1 + Math.min(spread, 0.6));
    const passage = firstSeen.get(stem);
    const entry = {
      term: displayForm(stem, passage),
      stem,
      count,
      passages: documentFrequency.get(stem) ?? 1,
      score: Number(score.toFixed(4)),
      passageId: passage?.id ?? null,
      documentName: passage?.documentName ?? null,
      pageNumber: passage?.pageNumber ?? null,
    };
    // A term in almost every passage of a multi-passage document is usually
    // structure ("chapter", "figure") rather than subject matter, so it ranks
    // last - but it is never discarded outright, because in a short or uniform
    // document the subject term appears in every passage, and returning no key
    // terms at all would be worse than a slightly generic one.
    (total >= 4 && spread > maxSpread ? everywhere : topical).push(entry);
  }

  const byScore = (a, b) => b.score - a.score || a.term.localeCompare(b.term);
  const ranked = [...topical.sort(byScore), ...everywhere.sort(byScore)];

  // Two stems can render the same surface form; keep the strongest one only.
  const seenSurface = new Set();
  const unique = [];
  for (const term of ranked) {
    const key = term.term.toLowerCase();
    if (seenSurface.has(key)) continue;
    seenSurface.add(key);
    unique.push(term);
    if (unique.length >= limit) break;
  }
  return unique;
}

export default extractKeyTerms;
