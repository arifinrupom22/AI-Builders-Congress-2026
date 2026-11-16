/**
 * Teach-back feedback.
 *
 * The student explains a concept in their own words and gets a source-grounded
 * check of what their explanation covers. It is deliberately a *word-level*
 * comparison against the cited passage(s), because that is what can be done
 * honestly without a model:
 *
 *   - it never says an explanation is "correct" or "incorrect";
 *   - it never gives a score, mark, grade or mastery claim;
 *   - it names what the passage talks about that the explanation does not
 *     mention, and words the explanation uses that this passage does not;
 *   - when the material does not cover the concept at all, it says it cannot
 *     evaluate the answer instead of inventing a comparison.
 *
 * Sentence labels describe wording overlap only ("matches this passage's
 * vocabulary" / "partly matches" / "not in this passage's wording"), never
 * correctness of the idea.
 */
import { contentTokens, sentences } from '../retrieval/tokenize.js';

export const TEACHBACK_DISCLAIMER =
  'This is a word-level comparison with one cited passage from your own material. It is not a grade, an assessment of correctness, or evidence of mastery; an idea can be right and still use different words.';

export const TEACHBACK_CANNOT_EVALUATE =
  'Your uploaded material does not contain a passage that supports this concept, so LearnSphere AI cannot evaluate this explanation. Upload a document that covers it and try again.';

const MAX_CITATIONS = 3;
const MAX_TERMS = 10;

const clip = (text, max) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/** Most frequent content words in a passage, in first-seen order for ties. */
function keyTerms(text, limit = 8) {
  const counts = new Map();
  for (const token of contentTokens(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

function sentenceStatus(ratio, total) {
  if (total === 0) return 'unclear';
  if (ratio >= 0.5) return 'supported';
  if (ratio > 0) return 'partial';
  return 'unclear';
}

export function createTeachbackService({ retrieval, config }) {
  async function evaluate({ learnerId, concept, explanation, materialIds = null }) {
    const search = await retrieval.search({
      learnerId,
      query: concept,
      materialIds,
      topK: MAX_CITATIONS,
      // A concept is a heading, not a full question: allow a looser match than an
      // answer would, but still refuse when nothing in the material matches.
      minScore: Math.min(config.retrieval.minScore, 0.3),
    });

    if (!search.supported) {
      return {
        status: 'cannot_evaluate',
        concept,
        reason: search.hasMaterials ? 'no_matching_material' : 'no_material',
        message: search.hasMaterials
          ? TEACHBACK_CANNOT_EVALUATE
          : 'You have no indexed material yet, so there is nothing to check this explanation against. Upload a document first.',
        citations: [],
        disclaimer: TEACHBACK_DISCLAIMER,
      };
    }

    const passages = search.results.slice(0, MAX_CITATIONS);
    const vocabulary = new Set(
      passages.flatMap((passage) => contentTokens(`${passage.heading ?? ''} ${passage.text}`)),
    );
    const explanationTokens = [...new Set(contentTokens(explanation))];

    const supportedTerms = explanationTokens.filter((token) => vocabulary.has(token));
    const offMaterialTerms = explanationTokens.filter((token) => !vocabulary.has(token));
    const mentioned = new Set(explanationTokens);
    const missingTerms = keyTerms(passages[0].text, 12)
      .filter((term) => !mentioned.has(term))
      .slice(0, MAX_TERMS);

    const perSentence = sentences(explanation)
      .slice(0, 12)
      .map((sentence, index) => {
        const tokens = contentTokens(sentence);
        const matched = tokens.filter((token) => vocabulary.has(token)).length;
        const ratio = tokens.length > 0 ? matched / tokens.length : 0;
        return {
          index: index + 1,
          text: clip(sentence, 260),
          status: sentenceStatus(ratio, tokens.length),
          matchedTerms: matched,
          contentTerms: tokens.length,
        };
      });

    const coverage =
      explanationTokens.length > 0
        ? Math.round((supportedTerms.length / explanationTokens.length) * 100)
        : 0;

    return {
      status: 'evaluated',
      concept,
      // Percentage of the explanation's distinct content words that appear in the
      // cited passage(s). Named as vocabulary overlap, never as a score.
      vocabularyOverlapPercent: coverage,
      supportedTerms: supportedTerms.slice(0, MAX_TERMS),
      missingTerms,
      offMaterialTerms: offMaterialTerms.slice(0, MAX_TERMS),
      sentences: perSentence,
      citations: passages.map((passage) => ({
        materialId: passage.materialId,
        documentName: passage.documentName,
        pageNumber: passage.pageNumber,
        passageId: passage.passageId,
        snippet: passage.snippet,
        text: clip(passage.text, 700),
        score: passage.score,
      })),
      notes: [
        `"Missing" means the cited passage repeats these words and your explanation did not use them. It is a prompt for what to re-read, not a list of mistakes.`,
        'Words the passage does not use are listed separately: your phrasing may still be right, or the material may use different terminology.',
        'No score, grade or mastery estimate is produced from this comparison.',
      ],
      disclaimer: TEACHBACK_DISCLAIMER,
    };
  }

  return { evaluate };
}

export default createTeachbackService;
