/**
 * The teaching layer of a visual.
 *
 * A diagram on its own is not an explanation: a student who sees eight boxes
 * labelled "Thylakoid membrane" and "NADPH" has been handed vocabulary, not
 * understanding. Every visual therefore carries a structured explanation beside
 * the picture, in the order a lesson would use:
 *
 *   overview -> key concepts -> step by step -> example -> remember -> summary
 *
 * Two sources feed it:
 *   - live mode: the model writes the teaching text, and every claim must cite
 *     a supplied passage. Anything citing a passage we did not supply, or the
 *     same passage twice in the same slot, is deleted here;
 *   - demo mode (no API key): the text is assembled from the material's own
 *     sentences, cut at sentence boundaries. It is honest about being quoted
 *     rather than rewritten, and it never invents a definition.
 *
 * Sections that do not apply are omitted rather than filled. A timeline of
 * historical events has no "steps"; a comparison table has no "example" unless
 * the material offers one.
 */

import { sentences } from '../retrieval/tokenize.js';
import { screenPassage } from '../ai/grounding.js';

/** Collapse whitespace and strip any markdown heading the model added. */
function clean(value) {
  return String(value ?? '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*\u2022]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cut to a length the layout can hold, preferring a sentence end and then a
 * word boundary. Never returns a string that stops inside a word with a
 * dangling comma: half a sentence reads as noise.
 */
export function clipAtWord(text, max) {
  const value = clean(text);
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  if (sentenceEnd > max * 0.45) return cut.slice(0, sentenceEnd + 1).trim();
  const space = cut.lastIndexOf(' ');
  const head = (space > max * 0.4 ? cut.slice(0, space) : cut).replace(/[,;:\-\u2013\u2014]+$/, '').trim();
  return `${head}\u2026`;
}

/** Compare two strings ignoring case, punctuation and spacing. */
function sameText(a, b) {
  const normalise = (value) =>
    String(value ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  return normalise(a) === normalise(b);
}

/**
 * Validate a model-written explanation against the passages it was given.
 *
 * @param {any} raw the `explanation` object from the model
 * @param {Array<{id:string}>} passages the [S#] passages supplied to the model
 * @returns {object|null} normalised explanation, or null when nothing survives
 */
export function normaliseExplanation(raw, passages) {
  if (!raw || typeof raw !== 'object') return null;
  const allowed = new Set(passages.map((p) => p.id));
  const keepIds = (ids) =>
    (Array.isArray(ids) ? ids : [])
      .map(String)
      .filter((id) => allowed.has(id))
      .slice(0, 3);

  const overview = clean(raw.overview ?? raw.introduction ?? '');
  const summary = clean(raw.summary ?? '');

  const keyConcepts = [];
  for (const item of Array.isArray(raw.keyConcepts) ? raw.keyConcepts : []) {
    const term = clean(item?.term ?? item?.label ?? '');
    const meaning = clipAtWord(item?.meaning ?? item?.text ?? item?.explanation ?? '', 260);
    const sourceIds = keepIds(item?.sourceIds);
    if (!term || meaning.length < 12 || sourceIds.length === 0) continue;
    if (keyConcepts.some((existing) => sameText(existing.term, term))) continue;
    keyConcepts.push({ term: clipAtWord(term, 48), meaning, sourceIds });
    if (keyConcepts.length >= 6) break;
  }

  const steps = [];
  for (const item of Array.isArray(raw.steps) ? raw.steps : []) {
    const title = clipAtWord(item?.title ?? item?.label ?? '', 80);
    const text = clipAtWord(item?.text ?? item?.detail ?? '', 320);
    const sourceIds = keepIds(item?.sourceIds);
    if (!title || text.length < 12 || sourceIds.length === 0) continue;
    if (steps.some((existing) => sameText(existing.title, title))) continue;
    steps.push({ title, text, sourceIds });
    if (steps.length >= 6) break;
  }

  const exampleText = clipAtWord(raw.example?.text ?? raw.example ?? '', 320);
  const exampleIds = keepIds(raw.example?.sourceIds);
  const example = exampleText.length >= 20 && exampleIds.length > 0 ? { text: exampleText, sourceIds: exampleIds } : null;

  const remember = [];
  for (const item of Array.isArray(raw.remember) ? raw.remember : []) {
    const text = clipAtWord(typeof item === 'string' ? item : item?.text ?? '', 180);
    const sourceIds = keepIds(typeof item === 'string' ? raw.rememberSourceIds : item?.sourceIds);
    if (text.length < 10) continue;
    if (remember.some((existing) => sameText(existing.text, text))) continue;
    remember.push({ text, sourceIds });
    if (remember.length >= 4) break;
  }

  const hasTeaching = overview.length >= 20 || keyConcepts.length > 0 || steps.length > 0;
  if (!hasTeaching) return null;

  return {
    overview: overview.length >= 20 ? overview : null,
    keyConcepts,
    steps,
    example,
    remember,
    summary: summary.length >= 20 ? summary : null,
    // Provenance of the wording, not of the facts: "live" means the model
    // rewrote it, "quoted" means these are the material's own sentences.
    mode: 'live',
  };
}

/* -------------------------------------------------------------------------- */
/* Local (quoted) explanation                                                  */
/* -------------------------------------------------------------------------- */

/** Sentences from the source, without instruction-like text. */
function sourceSentences(passages) {
  const out = [];
  for (const passage of passages) {
    for (const sentence of sentences(passage.text)) {
      const text = stripLeadingHeadingLocal(sentence.trim(), passage);
      if (text.length < 30) continue;
      if (screenPassage(text).suspicious) continue;
      out.push({ id: passage.id, text, passage });
    }
  }
  return out;
}

function stripLeadingHeadingLocal(text, passage) {
  const heading = String(passage.heading ?? '').trim();
  if (!heading) return text;
  const lowered = text.toLowerCase();
  if (!lowered.startsWith(heading.toLowerCase())) return text;
  return text.slice(heading.length).replace(/^[\s\-\u2013\u2014:|]+/, '').trim() || text;
}

const DEFINITION_RE = /\b(is|are|means|refers to|is called|is defined as|consists of|denotes|describes)\b/i;
const EXAMPLE_RE = /\b(for example|for instance|e\.g\.|such as|consider|imagine)\b/i;

/**
 * Build the teaching layer from the material itself.
 *
 * Used in demo mode and whenever the model's explanation fails citation
 * checking. Every string here is either quoted from the source or a neutral
 * structural label, so this path cannot invent a fact.
 */
export function buildLocalExplanation({ visual, passages = [], signals, topic = '', documents = [] }) {
  const all = sourceSentences(passages);
  if (all.length === 0) return null;

  // Words that carry no teaching value on their own. A slide deck yields
  // "case", "time", "input" as frequent terms; a concept card headed "case"
  // teaches nothing.
  const EMPTY_TERMS = new Set([
    'case', 'cases', 'time', 'times', 'input', 'inputs', 'output', 'outputs', 'number', 'numbers',
    'problem', 'value', 'values', 'data', 'example', 'examples', 'process', 'method', 'way', 'thing',
    'part', 'result', 'point', 'note', 'page', 'figure', 'table', 'chapter', 'section', 'unit',
  ]);

  const focusTerms = (signals?.nodeTerms ?? [])
    .map((term) => term.term)
    .filter((term) => term && !EMPTY_TERMS.has(String(term).toLowerCase()))
    // Multi-word terms ("running time", "light reactions") teach more than a
    // bare frequent noun.
    .sort((a, b) => b.trim().split(/\s+/).length - a.trim().split(/\s+/).length);

  const subject = clean(topic) || focusTerms[0] || (documents[0] ? documents[0].replace(/\.[^.]+$/, '') : 'this material');

  /**
   * Pick the sentence that actually introduces the subject.
   *
   * "First dated sentence wins" gave overviews like "In 1779, Jan Ingenhousz
   * demonstrated that sunlight is required..." for a page about photosynthesis:
   * true, but not an introduction. Rank by topic overlap and definition shape,
   * and push historical asides down.
   */
  const topicWords = clean(topic)
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 2 && !['the', 'and', 'for', 'how', 'why', 'what', 'does', 'work', 'vabe', 'hoy'].includes(word));

  const scoreSentence = (entry) => {
    const text = entry.text.toLowerCase();
    let score = 0;
    if (topicWords.some((word) => text.includes(word))) score += 3;
    if (DEFINITION_RE.test(entry.text)) score += 2;
    if (/\b(process|cycle|overall|equation|consists|composed|made up|refers to)\b/i.test(entry.text)) score += 1;
    if (entry.text.length >= 60 && entry.text.length <= 280) score += 1;
    if (/\b(in|since|during)\s+(1[0-9]{3}|20[0-2][0-9])\b/i.test(entry.text)) score -= 2;
    return score;
  };

  const ranked = [...all].sort((a, b) => scoreSentence(b) - scoreSentence(a));
  const definition = ranked[0] ?? all[0];
  const overview = clipAtWord(definition.text, 320);

  // One sentence must not appear under three different headings: that is the
  // "repeated paragraph" the students complained about. Track the meaning, not
  // just the term, and compare on a normalised prefix because the two copies
  // may be clipped at different lengths.
  const meaningKey = (text) =>
    String(text ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .slice(0, 110);
  const usedMeanings = new Set([meaningKey(overview)]);

  /**
   * Does this sentence actually explain the term, or merely mention it?
   * "The Calvin cycle ... produces ATP" is not a definition of ATP, so a card
   * headed "ATP" with that sentence underneath teaches the wrong thing.
   */
  const explainsTerm = (text, term) => {
    const lower = text.toLowerCase();
    const at = lower.indexOf(String(term).toLowerCase());
    if (at === -1) return false;
    const nearStart = at <= Math.max(24, text.length * 0.22);
    return nearStart || (DEFINITION_RE.test(text) && at <= text.length * 0.5);
  };

  /**
   * Concepts the material defines itself.
   *
   * The most reliable quoted concept is a definition sentence: "Photosynthesis
   * is the process by which..." names the term and explains it in the same
   * breath. Mining these beats guessing from word frequencies, which produced
   * cards like "absorbed" and "green".
   */
  const DEFINITION_EXTRACT =
    /^(?:the\s+|a\s+|an\s+)?([\p{Lu}][\p{L}\p{N}][\p{L}\p{N}\s\-]{1,46}?)\s+(?:is|are|was|were|means|refers to|is defined as|consists of|denotes)\b/u;

  // Bangla definitions use a copula rather than "is": "সালোকসংশ্লেষণ হলো ...".
  const DEFINITION_EXTRACT_BN =
    /^([\p{L}\p{N}][\p{L}\p{N}\s\-]{1,46}?)\s+(?:\u09b9\u09b2\u09cb|\u09b9\u09b2|\u09ac\u09b2\u09c7|\u09ac\u09cb\u099d\u09be\u09af\u09bc)\b/u;

  const keyConcepts = [];
  for (const entry of all) {
    if (keyConcepts.length >= 4) break;
    const match = DEFINITION_EXTRACT.exec(entry.text) ?? DEFINITION_EXTRACT_BN.exec(entry.text);
    if (!match) continue;
    const term = match[1]
      .replace(/\s+/g, ' ')
      .replace(/^(?:the|a|an)\s+/i, '')
      .trim();
    if (term.length < 4 || term.split(' ').length > 5) continue;
    // "র ের"-ending single words are genitive fragments ("কোষের"), not concepts.
    if (term.split(' ').length === 1 && /\u09c7\u09b0$|\u09b0$/.test(term)) continue;
    if (sameText(entry.text, definition.text)) continue;
    if (keyConcepts.some((existing) => sameText(existing.term, term))) continue;
    const key = meaningKey(entry.text);
    if (usedMeanings.has(key)) continue;
    usedMeanings.add(key);
    keyConcepts.push({ term, meaning: clipAtWord(entry.text, 240), sourceIds: [entry.id] });
  }

  const conceptsFromDiagram = visual.kind === 'concept-map' ? visual.nodes : [];
  for (const node of conceptsFromDiagram) {
    if (!node.label || !node.explanation) continue;
    if (!explainsTerm(node.explanation, node.label)) continue;
    if (keyConcepts.some((existing) => sameText(existing.term, node.label))) continue;
    const key = meaningKey(node.explanation);
    if (usedMeanings.has(key)) continue;
    usedMeanings.add(key);
    keyConcepts.push({ term: node.label, meaning: clipAtWord(node.explanation, 240), sourceIds: node.sourceIds });
    if (keyConcepts.length >= 5) break;
  }

  // Single common words make a bad concept card: the reference deck produced
  // "absorbed", "molecules" and "green" as concepts. Prefer phrases, then
  // long technical nouns, and stop rather than pad with weak ones.
  const usableTerms = focusTerms.filter((term) => term.trim().split(/\s+/).length >= 2 || term.length >= 6);
  for (const term of usableTerms) {
    if (keyConcepts.length >= 4) break;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Quoted mode can only offer a definition when the material opens a
    // sentence with the term ("Photosynthesis is ..."). A sentence that merely
    // contains the word would put unrelated prose under the concept's heading,
    // so the concept is left out instead.
    const mention = all.find(
      (entry) =>
        new RegExp(`^\\W*${escaped}\\b`, 'i').test(entry.text) &&
        !sameText(entry.text, definition.text) &&
        entry.text.length >= 40 &&
        explainsTerm(entry.text, term),
    );
    if (!mention) continue;
    if (keyConcepts.some((existing) => sameText(existing.term, term))) continue;
    // The meaning must add something: repeating the overview sentence under a
    // concept heading is noise.
    const key = meaningKey(mention.text);
    if (usedMeanings.has(key)) continue;
    usedMeanings.add(key);
    keyConcepts.push({ term, meaning: clipAtWord(mention.text, 240), sourceIds: [mention.id] });
  }

  // Steps only when the material actually has an order to follow. Repeating
  // the key concepts as numbered steps was noise, not teaching: the same words
  // appeared twice on one page.
  const steps = [];
  if (visual.kind === 'flowchart') {
    for (const step of visual.steps) {
      steps.push({ title: clipAtWord(step.label, 80), text: clipAtWord(step.detail, 280), sourceIds: step.sourceIds });
    }
  } else if ((signals?.sequenceSteps?.length ?? 0) >= 3) {
    // Only real procedural sentences: a slide bullet that happens to contain
    // "then" is not a step a student can follow.
    for (const step of signals.sequenceSteps.slice(0, 6)) {
      if (step.text.length < 45) continue;
      const trimmed = clipAtWord(step.text, 280);
      if (steps.some((existing) => sameText(existing.text, trimmed))) continue;
      const body = step.text.replace(/^(step\s*\d+|first|second|third|then|next|finally|lastly)[:\-,\s]*/i, '');
      // A short label plus the sentence underneath; printing the same sentence
      // twice (title and body) was another source of repetition.
      const words = body.split(/\s+/).slice(0, 7).join(' ').replace(/[,.;:]$/, '');
      steps.push({
        title: words.length < body.length ? `${words}\u2026` : clipAtWord(body, 80),
        text: trimmed,
        sourceIds: [step.passage.id],
      });
    }
    if (steps.length < 3) steps.length = 0;
  }

  const exampleEntry = all.find((entry) => EXAMPLE_RE.test(entry.text));
  const example = exampleEntry ? { text: clipAtWord(exampleEntry.text, 300), sourceIds: [exampleEntry.id] } : null;

  const remember = [];
  const short = all
    .filter((entry) => entry.text.length <= 170)
    .slice(0, 8);
  for (const entry of short) {
    if (remember.some((existing) => sameText(existing.text, entry.text))) continue;
    remember.push({ text: clipAtWord(entry.text, 170), sourceIds: [entry.id] });
    if (remember.length >= 3) break;
  }

  return {
    overview,
    keyConcepts,
    steps,
    example,
    remember,
    summary: null,
    mode: 'quoted',
    subject,
  };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

const SECTION_TITLES = {
  overview: 'Topic overview',
  keyConcepts: 'Key concepts',
  steps: 'Step by step',
  example: 'Practical example',
  remember: 'Remember this',
  summary: 'Short summary',
};

/** Every [S#] the explanation cites, so citations stay complete. */
export function explanationSourceIds(explanation) {
  const used = new Set();
  const add = (ids) => (ids ?? []).forEach((id) => used.add(id));
  if (!explanation) return used;
  explanation.keyConcepts?.forEach((item) => add(item.sourceIds));
  explanation.steps?.forEach((item) => add(item.sourceIds));
  explanation.remember?.forEach((item) => add(item.sourceIds));
  if (explanation.example) add(explanation.example.sourceIds);
  return used;
}

/**
 * The explanation as plain text, appended to `visual.textVersion` so the
 * accessible/copyable version is as useful as the picture.
 */
export function explanationToText(explanation) {
  if (!explanation) return '';
  const lines = [];
  const cite = (ids) => (ids?.length ? ` [${ids.join(', ')}]` : '');

  if (explanation.overview) lines.push(SECTION_TITLES.overview, explanation.overview, '');
  if (explanation.keyConcepts?.length) {
    lines.push(SECTION_TITLES.keyConcepts);
    for (const item of explanation.keyConcepts) lines.push(`- ${item.term}: ${item.meaning}${cite(item.sourceIds)}`);
    lines.push('');
  }
  if (explanation.steps?.length) {
    lines.push(SECTION_TITLES.steps);
    explanation.steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step.title}`);
      if (step.text && step.text !== step.title) lines.push(`   ${step.text}${cite(step.sourceIds)}`);
    });
    lines.push('');
  }
  if (explanation.example) {
    lines.push(SECTION_TITLES.example, `${explanation.example.text}${cite(explanation.example.sourceIds)}`, '');
  }
  if (explanation.remember?.length) {
    lines.push(SECTION_TITLES.remember);
    for (const item of explanation.remember) lines.push(`- ${item.text}${cite(item.sourceIds)}`);
    lines.push('');
  }
  if (explanation.summary) lines.push(SECTION_TITLES.summary, explanation.summary, '');

  return lines.join('\n').trim();
}

/** Section titles, exported so the UI and the tests agree on them. */
export { SECTION_TITLES };
