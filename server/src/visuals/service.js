/**
 * Visual Study Studio service.
 *
 * Builds ONE source-grounded visual - concept map, flowchart, comparison table
 * or timeline - from the learner's own indexed passages. Two rules govern
 * everything here:
 *
 *  1. Structure is earned, not invented. Each visual kind has a deterministic
 *     signal check against the real text (dated sentences, sequence markers,
 *     comparison language, term co-occurrence). If the material does not carry
 *     the signal, the request is refused with an honest account of what WAS
 *     found, instead of fabricating steps, dates or links.
 *  2. Every node, step, row cell and event cites the exact passage it came
 *     from. In live mode a model proposes the structure, but the server
 *     re-verifies every [S#] citation against the passages it supplied and
 *     drops whatever is ungrounded. In demo mode (no API key) the whole visual
 *     is built locally and extractively - sentences quoted unchanged from the
 *     learner's own material, the same way the local study summary works.
 */
import { contentTokens, sentences, detectQuestionLanguage } from '../retrieval/tokenize.js';
import { extractKeyTerms } from '../ai/keyterms.js';
import { preparePassages, screenPassage } from '../ai/grounding.js';
import { buildVisualMessages } from '../ai/prompts.js';
import { selectSpread } from '../summary/service.js';
import {
  normaliseExplanation,
  buildLocalExplanation,
  explanationSourceIds,
  explanationToText,
  clipAtWord,
} from './explanation.js';

export const VISUAL_KINDS = [
  {
    id: 'concept-map',
    label: 'Concept map',
    description: 'Ideas as nodes, with the relationships your material states between them.',
    needs: 'Several recurring terms that your material connects in the same sentences.',
  },
  {
    id: 'flowchart',
    label: 'Flowchart',
    description: 'A process or procedure as ordered steps.',
    needs: 'A passage written as numbered or ordered steps ("first", "then", "finally").',
  },
  {
    id: 'comparison',
    label: 'Comparison table',
    description: 'Related concepts side by side, in your material\u2019s own words.',
    needs: 'Sentences that contrast two concepts ("whereas", "unlike", "in contrast").',
  },
  {
    id: 'timeline',
    label: 'Timeline',
    description: 'Events or developments in the order the source dates them.',
    needs: 'At least three sentences containing real dates or years.',
  },
];

export const DEFAULT_VISUAL_KIND = 'auto';

// Hard ceilings so one long document cannot produce an unreadable picture.
const MAX_NODES = 8;
const MAX_EDGES = 14;
const MAX_STEPS = 10;
const MAX_EVENTS = 12;
const MAX_ROWS = 6;
const MAX_COLUMNS = 3;

// What each kind needs before it is worth drawing. These are the honesty
// thresholds: below them the answer is "your material does not support this",
// never a sparsely invented diagram.
const MIN_PASSAGES = 1;
const MIN_TIMELINE_EVENTS = 3;
const MIN_FLOWCHART_STEPS = 3;
const MIN_COMPARISON_ROWS = 2;
const MIN_MAP_NODES = 3;
const MIN_MAP_EDGES = 2;

// --- signal detection -------------------------------------------------------

/** Years, month+year, and decades - including Bangla numerals. */
const YEAR_RE = /\b(1[0-9]{3}|20[0-2][0-9])\b/;
const MONTH_YEAR_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(1[0-9]{3}|20[0-2][0-9])\b/i;
// Decades: three digits ending in 0 plus "s" - "1950s", "2000s".
const DECADE_RE = /\b(?:19|20)[0-9]0s\b/;

const SEQUENCE_CUES = [
  /\bstep\s*(\d+)/gi,
  /\b(first|second|third|then|next|finally|lastly|after that|afterwards|subsequently|initially)\b/i,
  /(ধাপ|পরবর্তী|তারপর|প্রথমে|শেষে|প্রথম ধাপ)/,
];

const COMPARISON_CUES = [
  /\bwhereas\b/i,
  /\bwhile\b/i,
  /\bunlike\b/i,
  /\bin contrast\b/i,
  /\bcompared to\b/i,
  /\bcompared with\b/i,
  /\bon the other hand\b/i,
  /\bdifference between\b/i,
  /(তুলনা|অন্যদিকে|বরং|পার্থক্য|যেখানে)/,
];

/** Relation verbs that name HOW two concepts are connected. */
const RELATION_CUES = [
  /\b(causes?|leads? to|results? in|produces?|generates?|creates?|builds?)\b/i,
  /\b(requires?|depends? on|uses?|consumes?|stores?|releases?|converts?)\b/i,
  /\b(activates?|inhibits?|regulates?|controls?|governs?)\b/i,
  /\b(is an?|are) (?:part of|component of|type of|form of|kind of)\b/i,
  /\b(consists? of|contains?|includes?|covers?|implies?)\b/i,
  /(ঘটায়|তৈরি করে|নির্ভর করে|পরিচালনা করে|অন্তর্ভুক্ত)/,
];

/** Definition-like phrasing, reused from the summary service's intuition. */
const DEFINITION_HINTS = [
  /\b(is|are|means|refers to|is called|is defined as|consists of|denotes)\b/i,
  /(হল|বলে|বোঝায়|করা হয়)/,
];

const BANGLA_DIGITS = '\u09e6\u09e7\u09e8\u09e9\u09ea\u09eb\u09ec\u09ed\u09ee\u09ef';

function toAsciiDigits(text) {
  return String(text).replace(/[\u09e6-\u09ef]/g, (d) => String(BANGLA_DIGITS.indexOf(d)));
}

/**
 * A passage's first line becomes its heading, so a quoted sentence can start
 * with the heading glued on. Drop that prefix before quoting - same trick the
 * summary service uses.
 */
function stripLeadingHeading(text, passage) {
  const heading = String(passage.heading ?? '').trim();
  if (!heading) return text;
  const lowered = text.toLowerCase();
  const start = heading.toLowerCase();
  if (!lowered.startsWith(start)) return text;
  return text.slice(heading.length).replace(/^[\s\-\u2013\u2014:|]+/, '').trim() || text;
}

/**
 * Trim to a length the layout can hold without cutting a word in half.
 * Mid-word ellipses ("thylakoid mem...") were part of why labels read as noise.
 */
function clip(text, max) {
  return clipAtWord(text, max);
}

/**
 * A title a student can recognise.
 *
 * The old fallback was the first recurring keyword, which produced titles like
 * "sunlight" for a photosynthesis map. Name the subject AND the shape of the
 * page instead.
 */
export function buildTitle({ topic = '', kind, signals, documents = [] }) {
  const requested = String(topic ?? '').replace(/\s+/g, ' ').trim();
  if (requested) return clip(requested, 80);
  const term = signals?.nodeTerms?.[0]?.term ?? signals?.columns?.[0]?.term ?? '';
  const document = documents[0] ? documents[0].replace(/\.[^.]+$/, '') : '';
  // The document name is a better subject than the most frequent word: a
  // photosynthesis map used to be titled "light".
  const subject = document || term || 'Your material';
  const shape =
    { 'concept-map': 'how the ideas connect', flowchart: 'the process step by step', comparison: 'compared', timeline: 'timeline' }[
      kind
    ] ?? 'overview';
  return clip(`${subject}: ${shape}`, 80);
}

/** Stable, filesystem-safe-ish id prefix per kind. */
const KIND_PREFIX = {
  'concept-map': 'n',
  flowchart: 's',
  comparison: 'r',
  timeline: 'e',
};

function nodeId(kind, index) {
  return `${KIND_PREFIX[kind] ?? 'i'}${index + 1}`;
}

/**
 * Scan the prepared passages once and collect every signal the four builders
 * need. Runs on the [S#] context passages only, so anything a builder can
 * quote is guaranteed to resolve to a citation the client already has.
 *
 * Instruction-like text is skipped sentence by sentence, the same way the
 * extractive summary refuses to quote it.
 */
export function detectSignals(passages) {
  const timelineEvents = [];
  const sequenceSteps = [];
  const comparisonSentences = [];
  const relations = [];

  /** Flat sentence view with its owning passage, in document order. */
  const all = [];
  for (const passage of passages) {
    for (const sentence of sentences(passage.text)) {
      const text = stripLeadingHeading(sentence.trim(), passage);
      if (text.length < 25) continue;
      if (screenPassage(text).suspicious) continue;
      all.push({ passage, text, stems: new Set(contentTokens(text)) });
    }
  }

  // --- dates ---------------------------------------------------------------
  for (const entry of all) {
    const ascii = toAsciiDigits(entry.text);
    const month = MONTH_YEAR_RE.exec(ascii);
    const year = YEAR_RE.exec(ascii);
    const decade = DECADE_RE.exec(ascii);
    if (month) {
      timelineEvents.push({ ...entry, when: month[0].trim() });
    } else if (year) {
      timelineEvents.push({ ...entry, when: year[0] });
    } else if (decade) {
      timelineEvents.push({ ...entry, when: decade[0] });
    }
  }

  // --- ordered steps -------------------------------------------------------
  for (const entry of all) {
    for (const cue of SEQUENCE_CUES) {
      cue.lastIndex = 0;
      const match = cue.exec(entry.text);
      if (!match) continue;
      sequenceSteps.push({
        ...entry,
        stepNumber: /^\d+$/.test(match[1] ?? '') ? Number(match[1]) : null,
        cue: match[0],
      });
      break; // one cue per sentence is enough to mark it as a step
    }
  }

  // --- recurring terms: the candidate nodes of a concept map ---------------
  const keyTerms = extractKeyTerms(
    passages.map((p) => ({ id: p.passageId, documentName: p.documentName, pageNumber: p.pageNumber, heading: p.heading, text: p.text })),
    { limit: 12, minCount: 2 },
  );
  const nodeTerms = keyTerms.slice(0, MAX_NODES);

  // --- relations between recurring terms -----------------------------------
  const nodeStems = new Set(nodeTerms.map((t) => t.stem));
  for (const entry of all) {
    const present = [...entry.stems].filter((stem) => nodeStems.has(stem));
    if (present.length < 2) continue;
    const cue = RELATION_CUES.map((re) => re.exec(entry.text)?.[0]).find(Boolean) ?? null;
    relations.push({ ...entry, fromStem: present[0], toStem: present[1], cue });
  }

  // --- comparison language -------------------------------------------------
  for (const entry of all) {
    if (COMPARISON_CUES.some((re) => re.test(entry.text))) comparisonSentences.push(entry);
  }

  // Columns must be concepts the material actually contrasts, not just the
  // two most frequent words. Two columns only: detection and the local builder
  // must agree exactly on how many columns every row has to cover, or a table
  // would be drawn with a header the rows never fill.
  const contrastedStems = new Set(comparisonSentences.flatMap((c) => [...c.stems]));
  const columns = nodeTerms.filter((t) => contrastedStems.has(t.stem)).slice(0, 2);
  let fullComparisonRows = 0;
  if (columns.length >= 2) {
    for (const sentence of comparisonSentences.slice(0, MAX_ROWS * 2)) {
      const passage = sentence.passage;
      const inPassage = all.filter((e) => e.passage === passage);
      const covered = columns.every((col) => inPassage.some((e) => e.stems.has(col.stem)));
      if (covered) fullComparisonRows += 1;
    }
  }

  return {
    timelineEvents,
    sequenceSteps,
    relations,
    comparisonSentences,
    columns,
    fullComparisonRows,
    nodeTerms,
    sentenceCount: all.length,
    // The flat, injection-screened sentence view, so builders quote the same
    // entries detection saw instead of re-scanning the text.
    entries: all,
  };
}

/** Cheap support test mirroring each builder's honesty threshold. */
export function kindSupport(kind, signals) {
  switch (kind) {
    case 'timeline':
      return signals.timelineEvents.length >= MIN_TIMELINE_EVENTS;
    case 'flowchart':
      return signals.sequenceSteps.length >= MIN_FLOWCHART_STEPS;
    case 'comparison':
      return signals.columns.length >= 2 && signals.fullComparisonRows >= MIN_COMPARISON_ROWS;
    case 'concept-map':
      return signals.nodeTerms.length >= MIN_MAP_NODES && signals.relations.length >= MIN_MAP_EDGES;
    default:
      return false;
  }
}

/** Human-readable tally used in the "not supported" explanation. */
export function signalSummary(signals) {
  return {
    datedSentences: signals.timelineEvents.length,
    sequenceSentences: signals.sequenceSteps.length,
    comparisonSentences: signals.comparisonSentences.length,
    relationsBetweenTerms: signals.relations.length,
    recurringTerms: signals.nodeTerms.length,
    sentencesScanned: signals.sentenceCount,
  };
}

/** Pick the strongest supported visual; null when nothing qualifies. */
export function chooseKind(signals) {
  const scored = [
    { kind: 'timeline', score: signals.timelineEvents.length },
    { kind: 'flowchart', score: signals.sequenceSteps.length },
    { kind: 'comparison', score: signals.fullComparisonRows * 2 },
    { kind: 'concept-map', score: signals.relations.length },
  ].filter((c) => kindSupport(c.kind, signals));
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0].kind;
}

// --- local (extractive) builders --------------------------------------------

function findTermSentence(stem, entries) {
  // Prefer a definition-shaped sentence, then the earliest clear mention.
  const mentioning = entries.filter((e) => e.stems.has(stem) && e.text.length >= 30);
  return mentioning.find((e) => DEFINITION_HINTS.some((re) => re.test(e.text))) ?? mentioning[0] ?? null;
}

/**
 * Concept map: recurring terms as nodes (each explained by a real sentence
 * from the source), relationships taken from sentences that state them.
 * Returns null when the thresholds are not met.
 */
export function buildLocalConceptMap({ signals }) {
  if (!kindSupport('concept-map', signals)) return null;
  const entries = signals.entries;

  const nodes = [];
  const stemToId = new Map();
  for (const term of signals.nodeTerms) {
    const source = findTermSentence(term.stem, entries);
    if (!source) continue;
    const id = nodeId('concept-map', nodes.length);
    stemToId.set(term.stem, id);
    nodes.push({
      id,
      label: term.term,
      explanation: clip(source.text, 240),
      sourceIds: [source.passage.id],
    });
    if (nodes.length >= MAX_NODES) break;
  }
  if (nodes.length < MIN_MAP_NODES) return null;

  const edges = [];
  const seenPairs = new Set();
  for (const relation of signals.relations) {
    const from = stemToId.get(relation.fromStem);
    const to = stemToId.get(relation.toStem);
    if (!from || !to || from === to) continue;
    const pair = [from, to].sort().join('|');
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    // "is", "are" and "has" carry no relationship a student can use as a
    // label; the arrow plus the relationship list already says the two ideas
    // are connected, so a weak verb is dropped rather than printed.
    const weak = !relation.cue || /^(is|are|was|were|has|have|had|uses|using|with)$/i.test(relation.cue.trim());
    edges.push({
      from,
      to,
      label: weak ? null : clip(relation.cue.toLowerCase(), 40),
      sourceIds: [relation.passage.id],
    });
    if (edges.length >= MAX_EDGES) break;
  }
  if (edges.length < MIN_MAP_EDGES) return null;

  return { kind: 'concept-map', nodes, edges };
}

/** Flowchart: ordered-step sentences, in the order the source gives them. */
export function buildLocalFlowchart({ passages, signals }) {
  if (!kindSupport('flowchart', signals)) return null;
  const numbered = signals.sequenceSteps.every((s) => s.stepNumber !== null);
  const steps = [...signals.sequenceSteps];
  if (numbered) steps.sort((a, b) => a.stepNumber - b.stepNumber);

  const built = steps.slice(0, MAX_STEPS).map((step, index) => ({
    id: nodeId('flowchart', index),
    label: clip(step.text.replace(/^\W*(step\s*\d+|first|second|third|then|next|finally|lastly|initially|after that|afterwards|subsequently)[:\-,\s]*/i, ''), 90),
    detail: clip(step.text, 280),
    sourceIds: [step.passage.id],
  }));
  if (built.length < MIN_FLOWCHART_STEPS) return null;
  return { kind: 'flowchart', steps: built };
}

/**
 * Comparison table: columns are recurring concepts the material contrasts;
 * each row quotes the contrasting sentence (plus its neighbour from the same
 * passage when the sentence only names one side).
 */
export function buildLocalComparison({ passages, signals }) {
  if (!kindSupport('comparison', signals)) return null;
  // Column headers carry no citations of their own - every cell does, so the
  // student always sees the source of the words in the cell they clicked.
  // The stem is kept only for matching; it never leaves the server.
  const stems = signals.columns.slice(0, 2).map((term) => term.stem);
  const columns = stems.map((stem, index) => ({
    id: `c${index + 1}`,
    label: signals.columns[index].term,
  }));
  const all = signals.entries;

  const rows = [];
  for (const sentence of signals.comparisonSentences) {
    if (rows.length >= MAX_ROWS) break;
    const inPassage = all.filter((e) => e.passage === sentence.passage);
    const cells = [];
    let full = true;
    for (const [index, stem] of stems.entries()) {
      const source =
        inPassage.find((e) => e.stems.has(stem) && e.text === sentence.text) ??
        inPassage.find((e) => e.stems.has(stem));
      if (!source) {
        full = false;
        break;
      }
      cells.push({ columnId: columns[index].id, text: clip(source.text, 220), sourceIds: [source.passage.id] });
    }
    if (!full) continue;
    // One sentence quoted into both columns is not a contrast.
    if (new Set(cells.map((cell) => cell.text.toLowerCase().trim())).size < 2) continue;
    rows.push({
      id: nodeId('comparison', rows.length),
      label: clip(sentence.passage.heading || `Point ${rows.length + 1}`, 60),
      cells,
    });
  }
  if (rows.length < MIN_COMPARISON_ROWS) return null;
  return { kind: 'comparison', columns, rows };
}

/** Timeline: dated sentences in chronological order, source order as fallback. */
export function buildLocalTimeline({ passages, signals }) {
  if (!kindSupport('timeline', signals)) return null;
  const yearOf = (when) => {
    const ascii = toAsciiDigits(when);
    const year = YEAR_RE.exec(ascii);
    if (year) return Number(year[1]);
    // "1950s" sorts by its first year, the way a historian would place it.
    const decade = DECADE_RE.exec(ascii);
    const decadeYear = decade && /\d{4}/.exec(decade[0]);
    return decadeYear ? Number(decadeYear[0]) : Number.MAX_SAFE_INTEGER;
  };
  const events = [...signals.timelineEvents]
    .sort((a, b) => yearOf(a.when) - yearOf(b.when))
    .slice(0, MAX_EVENTS)
    .map((event, index) => {
      // One-line summary for the list: prefer the clause before the date
      // ("Telegraph messages crossed the Atlantic"), unless that ends on a
      // dangling preposition ("...crossed the Atlantic in"), in which case the
      // clause after the date reads better.
      const at = event.text.indexOf(event.when);
      const before = event.text.slice(0, at).trim().replace(/[\s,:\u2013-]+$/, '');
      const after = event.text
        .slice(at + event.when.length)
        .replace(/^[\s,:\u2013-]+/, '')
        .trim();
      const dangling = /\b(in|of|at|on|by|to|with|after|before|during|around|until|since|from|over|under)\s*$/i;
      const label = (before.length >= 24 && !dangling.test(before) ? before : after || before) || event.text;
      return {
        id: nodeId('timeline', index),
        when: clip(event.when, 24),
        label: clip(label, 90),
        detail: clip(event.text, 280),
        sourceIds: [event.passage.id],
      };
    });
  if (events.length < MIN_TIMELINE_EVENTS) return null;
  return { kind: 'timeline', events };
}

const LOCAL_BUILDERS = {
  'concept-map': buildLocalConceptMap,
  flowchart: buildLocalFlowchart,
  comparison: buildLocalComparison,
  timeline: buildLocalTimeline,
};

// --- AI path validation ------------------------------------------------------

/** Tolerant JSON extraction, mirroring the quiz generator's parser. */
function parseJsonFromModel(text) {
  const fenced = String(text ?? '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Accept a model-drawn visual only where every part is grounded: citations
 * must resolve to passages we actually supplied, ids must be unique and
 * self-consistent, and the result must still meet the kind's thresholds.
 * Returns { visual, dropped } with visual=null when nothing usable survives.
 */
export function normaliseAiVisual(raw, kind, passages) {
  const allowed = new Map(passages.map((p) => [p.id, p]));
  const keepIds = (ids) =>
    (Array.isArray(ids) ? ids : [])
      .map(String)
      .filter((id) => allowed.has(id))
      .slice(0, 3);
  const used = new Set();
  let dropped = 0;
  const nodeIds = new Set();

  if (kind === 'concept-map') {
    const nodes = [];
    const labelsSeen = new Set();
    for (const node of Array.isArray(raw?.nodes) ? raw.nodes : []) {
      if (nodes.length >= MAX_NODES) break;
      const sourceIds = keepIds(node?.sourceIds);
      const label = clip(node?.label ?? '', 60);
      // Two boxes with the same words are not two concepts: they are a
      // repetition that makes the map unreadable.
      if (!label || sourceIds.length === 0 || labelsSeen.has(label.toLowerCase())) {
        dropped += 1;
        continue;
      }
      labelsSeen.add(label.toLowerCase());
      const id = nodeId('concept-map', nodes.length);
      nodeIds.add(id);
      sourceIds.forEach((s) => used.add(s));
      nodes.push({ id, label, explanation: clip(node.explanation ?? '', 240), sourceIds });
    }
    const edges = [];
    const seen = new Set();
    for (const edge of Array.isArray(raw?.edges) ? raw.edges : []) {
      if (edges.length >= MAX_EDGES) break;
      const from = nodes.find((n) => n.id === edge?.from || n.label === edge?.from)?.id;
      const to = nodes.find((n) => n.id === edge?.to || n.label === edge?.to)?.id;
      const sourceIds = keepIds(edge?.sourceIds);
      if (!from || !to || from === to || sourceIds.length === 0) {
        dropped += 1;
        continue;
      }
      const pair = [from, to].sort().join('|');
      if (seen.has(pair)) continue;
      seen.add(pair);
      sourceIds.forEach((s) => used.add(s));
      edges.push({ from, to, label: edge?.label ? clip(edge.label, 40) : null, sourceIds });
    }
    if (nodes.length < MIN_MAP_NODES || edges.length < MIN_MAP_EDGES) return { visual: null, dropped };
    return { visual: { kind, nodes, edges }, dropped };
  }

  if (kind === 'flowchart') {
    const steps = [];
    const labelsSeen = new Set();
    for (const step of Array.isArray(raw?.steps) ? raw.steps : []) {
      if (steps.length >= MAX_STEPS) break;
      const sourceIds = keepIds(step?.sourceIds);
      const label = clip(step?.label ?? '', 90);
      if (!label || sourceIds.length === 0 || labelsSeen.has(label.toLowerCase())) {
        dropped += 1;
        continue;
      }
      labelsSeen.add(label.toLowerCase());
      sourceIds.forEach((s) => used.add(s));
      steps.push({
        id: nodeId('flowchart', steps.length),
        label,
        detail: clip(step.detail ?? step.label, 280),
        sourceIds,
      });
    }
    if (steps.length < MIN_FLOWCHART_STEPS) return { visual: null, dropped };
    return { visual: { kind, steps }, dropped };
  }

  if (kind === 'comparison') {
    const columns = (Array.isArray(raw?.columns) ? raw.columns : []).slice(0, MAX_COLUMNS).map((column, i) => ({
      id: `c${i + 1}`,
      label: clip(column?.label ?? column ?? '', 60),
      sourceIds: keepIds(column?.sourceIds),
    })).filter((c) => c.label);
    if (columns.length < 2) return { visual: null, dropped };
    const rows = [];
    for (const row of Array.isArray(raw?.rows) ? raw.rows : []) {
      if (rows.length >= MAX_ROWS) break;
      const cells = [];
      let full = true;
      for (const column of columns) {
        const cell = (Array.isArray(row?.cells) ? row.cells : []).find(
          (c) => c?.columnId === column.id || c?.column === column.label,
        );
        const sourceIds = keepIds(cell?.sourceIds);
        if (!cell?.text || sourceIds.length === 0) {
          full = false;
          break;
        }
        sourceIds.forEach((s) => used.add(s));
        cells.push({ columnId: column.id, text: clip(cell.text, 220), sourceIds });
      }
      if (!full) continue;
      // Identical wording in both columns is not a comparison: it is one
      // sentence printed twice and reads as a mistake.
      const texts = cells.map((cell) => cell.text.toLowerCase().replace(/\s+/g, ' ').trim());
      if (new Set(texts).size < 2) {
        dropped += 1;
        continue;
      }
      rows.push({ id: nodeId('comparison', rows.length), label: clip(row?.label ?? `Point ${rows.length + 1}`, 60), cells });
    }
    if (rows.length < MIN_COMPARISON_ROWS) return { visual: null, dropped };
    return { visual: { kind, columns: columns.map(({ sourceIds, ...rest }) => rest), rows }, dropped };
  }

  if (kind === 'timeline') {
    const events = [];
    for (const event of Array.isArray(raw?.events) ? raw.events : []) {
      if (events.length >= MAX_EVENTS) break;
      const sourceIds = keepIds(event?.sourceIds);
      if (!event?.when || !event?.label || sourceIds.length === 0) {
        dropped += 1;
        continue;
      }
      // A date the cited passage never states is an invented date, whatever
      // the model believes. Check the digits against the actual text.
      const citedText = sourceIds
        .map((id) => allowed.get(id)?.text ?? '')
        .join(' ')
        .toLowerCase();
      const dateToken = toAsciiDigits(String(event.when)).toLowerCase().trim();
      const digits = dateToken.match(/\d{4}/)?.[0] ?? dateToken;
      if (digits && !toAsciiDigits(citedText).includes(digits)) {
        dropped += 1;
        continue;
      }
      sourceIds.forEach((s) => used.add(s));
      events.push({
        id: nodeId('timeline', events.length),
        when: clip(event.when, 24),
        label: clip(event.label, 90),
        detail: clip(event.detail ?? event.label, 280),
        sourceIds,
      });
    }
    if (events.length < MIN_TIMELINE_EVENTS) return { visual: null, dropped };
    return { visual: { kind, events }, dropped };
  }

  return { visual: null, dropped: 0 };
}

// --- accessible text version --------------------------------------------------

/**
 * A linear text rendering of the visual. This is the accessible alternative
 * screen-reader users get, and it is also what a student can copy into notes.
 */
export function buildTextVersion(visual, { title, documents }) {
  const lines = [`${visual.kind === 'concept-map' ? 'Concept map' : visual.kind === 'flowchart' ? 'Flowchart' : visual.kind === 'comparison' ? 'Comparison table' : 'Timeline'}: ${title}`];
  if (documents?.length) lines.push(`Sources: ${documents.join(', ')}`);
  lines.push('');

  if (visual.kind === 'concept-map') {
    const byId = new Map(visual.nodes.map((n) => [n.id, n]));
    for (const node of visual.nodes) {
      lines.push(`- ${node.label}: ${node.explanation}`);
    }
    lines.push('', 'Relationships:');
    for (const edge of visual.edges) {
      const from = byId.get(edge.from)?.label ?? edge.from;
      const to = byId.get(edge.to)?.label ?? edge.to;
      lines.push(`- ${from} ${edge.label ? `${edge.label} ` : '\u2192 '}${to}`);
    }
  } else if (visual.kind === 'flowchart') {
    visual.steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step.label}`);
      if (step.detail && step.detail !== step.label) lines.push(`   ${step.detail}`);
    });
  } else if (visual.kind === 'comparison') {
    const labels = visual.columns.map((c) => c.label);
    lines.push(labels.join('  |  '));
    lines.push(labels.map(() => '---').join('  |  '));
    for (const row of visual.rows) {
      lines.push(`${row.label}:`);
      row.cells.forEach((cell, index) => {
        lines.push(`  ${labels[index] ?? `Column ${index + 1}`}: ${cell.text}`);
      });
    }
  } else if (visual.kind === 'timeline') {
    for (const event of visual.events) {
      lines.push(`- ${event.when}: ${event.label}`);
    }
  }

  return lines.join('\n');
}

// --- citations -----------------------------------------------------------------

/** Build the citation list for exactly the [S#] ids the visual uses. */
export function buildCitations(usedIds, passages) {
  const byId = new Map(passages.map((p) => [p.id, p]));
  const citations = [];
  for (const id of [...usedIds].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
    const p = byId.get(id);
    if (!p) continue;
    citations.push({
      id,
      passageId: p.passageId,
      materialId: p.materialId,
      documentName: p.documentName,
      pageNumber: p.pageNumber,
      heading: p.heading ?? null,
      snippet: p.text.length > 320 ? `${p.text.slice(0, 320).trimEnd()}...` : p.text,
    });
  }
  return citations;
}

/** Collect every [S#] referenced anywhere in a finished visual. */
export function collectSourceIds(visual) {
  const used = new Set();
  const add = (ids) => (ids ?? []).forEach((id) => used.add(id));
  // The explanation cites passages too, so its ids must reach the citation list.
  for (const id of explanationSourceIds(visual.explanation)) used.add(id);
  if (visual.kind === 'concept-map') {
    visual.nodes.forEach((n) => add(n.sourceIds));
    visual.edges.forEach((e) => add(e.sourceIds));
  } else if (visual.kind === 'flowchart') {
    visual.steps.forEach((s) => add(s.sourceIds));
  } else if (visual.kind === 'comparison') {
    visual.rows.forEach((r) => r.cells.forEach((c) => add(c.sourceIds)));
  } else if (visual.kind === 'timeline') {
    visual.events.forEach((e) => add(e.sourceIds));
  }
  return used;
}

// --- service -------------------------------------------------------------------

const KIND_LABEL = Object.fromEntries(VISUAL_KINDS.map((k) => [k.id, k.label]));

export function createVisualsService({ retrieval, provider, config, logger, store }) {
  const providerInfo = provider ? { id: provider.id, label: provider.label, model: provider.model } : null;

  /**
   * @param {{learnerId:string, materialIds?:string[]|null, topic?:string, kind?:string}} params
   */
  async function build({ learnerId, materialIds = null, topic = '', kind = DEFAULT_VISUAL_KIND, language: requestedLanguage = '' }) {
    const requestedKind = kind && kind !== 'auto' ? kind : null;

    // --- gather passages, exactly like the summary service does ------------
    let ordered;
    if (topic && topic.trim().length > 0) {
      const search = await retrieval.search({
        learnerId,
        query: topic.trim(),
        materialIds,
        topK: 24,
        minScore: config.retrieval.minScore,
      });
      if (!search.supported) {
        return {
          ok: false,
          code: search.hasMaterials ? 'topic_not_found' : 'no_materials',
          message: search.hasMaterials
            ? `Your indexed material has nothing matching "${clip(topic, 80)}", so there is no grounded content for a visual.`
            : 'Upload a document first: a visual can only be built from your own indexed material.',
          candidates: search.candidates ?? [],
        };
      }
      ordered = search.results;
    } else {
      const all = await retrieval.allPassages(learnerId, materialIds);
      if (all.length === 0) {
        const materials = await store.listMaterials(learnerId);
        return {
          ok: false,
          code: materials.length === 0 ? 'no_materials' : 'no_passages',
          message:
            materials.length === 0
              ? 'Upload a document first: a visual can only be built from your own indexed material.'
              : 'The selected material has no indexed text yet. Check My Materials for what happened during upload.',
        };
      }
      const selection = materialIds?.length ? new Map(materialIds.map((id, i) => [id, i])) : null;
      ordered = [...all].sort(
        (a, b) =>
          (selection?.get(a.materialId) ?? 0) - (selection?.get(b.materialId) ?? 0) ||
          String(a.material?.createdAt ?? '').localeCompare(String(b.material?.createdAt ?? '')) ||
          String(a.documentName).localeCompare(String(b.documentName)) ||
          (a.pageNumber ?? 0) - (b.pageNumber ?? 0) ||
          (a.index ?? 0) - (b.index ?? 0),
      );
    }

    const documents = [...new Set(ordered.map((p) => p.documentName))];
    const materials = await retrieval.listMaterials(learnerId);
    const materialLanguage =
      materials.find((m) => !materialIds?.length || materialIds.includes(m.id))?.language ?? 'en';

    // The page language follows what the student asked for, then what their
    // question is written in, and only then the material's own language. Before
    // this, a Bangla student got an English page unless the PDF's metadata said
    // otherwise.
    const topicLanguage = detectQuestionLanguage(topic || '');
    const language =
      requestedLanguage === 'en' || requestedLanguage === 'bn'
        ? requestedLanguage
        : topicLanguage === 'banglish' || topicLanguage === 'bn'
          ? 'bn'
          : topic.trim()
            ? 'en'
            : materialLanguage;

    if (ordered.length < MIN_PASSAGES) {
      return {
        ok: false,
        code: 'not_enough_material',
        message: `A useful visual needs at least ${MIN_PASSAGES} indexed passages so every part can cite a real source; this selection has ${ordered.length}. Select more documents or upload a longer file.`,
      };
    }

    // --- context budget ------------------------------------------------------
    // A visual needs the structure of the text, not the whole chapter: 24
    // passages plus a teaching prompt made the model time out, and the student
    // silently got the quoted fallback. Keep the context small enough to answer
    // quickly, and spread it across the document so the picture is not a
    // single page.
    const budget = Math.min(config.retrieval.summaryChars, 5200);
    const { selected: spread } = selectSpread(ordered, budget);
    const selected = spread.slice(0, 10);
    const prepared = preparePassages(
      selected.map((p) => ({ ...p, passageId: p.passageId ?? p.id, score: undefined })),
      { contextChars: budget },
    );
    const passages = prepared.passages;
    const warnings = [...prepared.notes];
    if (documents.length > 1 && !topic.trim()) {
      warnings.push({
        code: 'multiple_documents',
        message: `This page draws on ${documents.length} documents at once. Add a topic focus to build it from one of them, so an unrelated document cannot wander into the picture.`,
      });
    }
    if (prepared.truncated) {
      warnings.push({
        code: 'context_truncated',
        message: `Only the first ${passages.length} of ${ordered.length} passages fit the visual context. Select fewer documents for a fuller picture.`,
      });
    }

    // --- detect and choose ---------------------------------------------------
    const signals = detectSignals(passages);
    const found = signalSummary(signals);
    const supported = VISUAL_KINDS.filter((k) => kindSupport(k.id, signals)).map((k) => k.id);

    let resolvedKind = requestedKind;
    if (requestedKind) {
      if (!VISUAL_KINDS.some((k) => k.id === requestedKind)) {
        return { ok: false, code: 'unknown_kind', message: `"${clip(requestedKind, 40)}" is not a visual type this studio can build.` };
      }
      if (!kindSupport(requestedKind, signals)) {
        return {
          ok: false,
          code: 'visual_not_supported',
          message: `Your material does not contain the structure a ${KIND_LABEL[requestedKind].toLowerCase()} needs, so building one would mean inventing ${requestedKind === 'timeline' ? 'dates' : requestedKind === 'flowchart' ? 'steps' : requestedKind === 'comparison' ? 'contrasts' : 'relationships'} that the source never states.`,
          details: { found, supported, requested: requestedKind },
        };
      }
    } else {
      resolvedKind = chooseKind(signals);
      if (!resolvedKind) {
        return {
          ok: false,
          code: 'visual_not_supported',
          message:
            'Your material does not contain enough structure for any useful visual right now: no run of dated events for a timeline, no ordered steps for a flowchart, no stated contrasts for a comparison table, and too few connections between recurring terms for a concept map. The AI Teacher or a study summary may still be useful - or upload the chapter that covers the process or history you want to see.',
          details: { found, supported, requested: null },
        };
      }
    }

    // --- build: local first, AI when configured -----------------------------
    const buildLocal = () => LOCAL_BUILDERS[resolvedKind]({ passages, signals });

    let visual = null;
    let generationMode = 'demo';
    let fallback = null;
    let aiExplanation = null;
    let aiTitle = '';
    const usedKindLabel = KIND_LABEL[resolvedKind];

    if (provider) {
      try {
        const startedAt = Date.now();
        // A page that takes two minutes to build is a broken page, even when
        // the model eventually answers. Cap the first attempt and let the
        // smaller retry below finish the job.
        const response = await provider.chat({
          messages: buildVisualMessages({ passages, kind: resolvedKind, topic: topic.trim(), language, documents }),
          temperature: 0.2,
          maxTokens: 2000,
          signal: AbortSignal.timeout(26000),
        });
        const raw = parseJsonFromModel(response.content);
        const normalised = raw ? normaliseAiVisual(raw, resolvedKind, passages) : { visual: null, dropped: 0 };
        if (raw) {
          // The teaching text is validated exactly like the diagram: every
          // section must cite a passage that was actually supplied.
          aiExplanation = normaliseExplanation(raw.explanation, passages);
          aiTitle = clip(raw.title ?? '', 80);
          if (raw.explanation && !aiExplanation) {
            warnings.push({
              code: 'explanation_unverified',
              message:
                'The model\u2019s written explanation could not be tied to your passages, so this page explains the visual with quoted sentences from your material instead.',
            });
          }
        }
        if (normalised.visual) {
          visual = normalised.visual;
          generationMode = 'live';
          if (normalised.dropped > 0) {
            warnings.push({
              code: 'ungrounded_parts_dropped',
              message: `${normalised.dropped} part${normalised.dropped > 1 ? 's' : ''} of the generated ${usedKindLabel.toLowerCase()} had no verifiable source passage and ${normalised.dropped > 1 ? 'were' : 'was'} removed.`,
            });
          }
          logger.info('visual generated', {
            provider: provider.id,
            model: provider.model,
            kind: resolvedKind,
            ms: Date.now() - startedAt,
            passages: passages.length,
          });
        } else {
          fallback = { code: 'ai_visual_unusable', message: 'The model returned a picture that did not survive citation checking.' };
          warnings.push({
            code: 'ai_visual_unusable',
            message: 'The model\u2019s version could not be verified against your passages, so this visual was rebuilt from quoted sentences instead.',
          });
        }
      } catch (err) {
        fallback = { code: err.code ?? 'ai_provider_error', message: err.message };
        logger.warn('ai provider failed, retrying with a smaller context', {
          kind: resolvedKind,
          code: fallback.code,
        });

        // One retry with half the passages and half the output budget: most
        // failures here are timeouts, and the quoted fallback is a real quality
        // drop, so it is worth a second, cheaper attempt.
        const smaller = passages.slice(0, Math.max(4, Math.floor(passages.length / 2)));
        try {
          const retry = await provider.chat({
            messages: buildVisualMessages({ passages: smaller, kind: resolvedKind, topic: topic.trim(), language, documents }),
            temperature: 0.2,
            maxTokens: 1600,
            signal: AbortSignal.timeout(20000),
          });
          const raw = parseJsonFromModel(retry.content);
          const normalised = raw ? normaliseAiVisual(raw, resolvedKind, smaller) : { visual: null, dropped: 0 };
          if (normalised.visual) {
            visual = normalised.visual;
            generationMode = 'live';
            fallback = null;
            if (raw?.explanation) {
              aiExplanation = normaliseExplanation(raw.explanation, smaller);
              aiTitle = clip(raw.title ?? '', 80);
            }
            warnings.push({
              code: 'ai_retry_smaller_context',
              message: 'The first attempt timed out, so this page was built from the best-matching passages in a second attempt.',
            });
          }
        } catch (retryErr) {
          fallback = { code: retryErr.code ?? 'ai_provider_error', message: retryErr.message };
          logger.warn('ai retry failed, falling back to local visual', { kind: resolvedKind, code: fallback.code });
        }

        if (visual === null) {
          warnings.push({
            code: 'ai_provider_fallback',
            message: `${fallback.message} The page was built locally by quoting your material instead.`,
          });
        }
      }
    }

    if (visual === null) {
      visual = buildLocal();
      if (visual === null) {
        // The AI picture was unusable AND the local thresholds are not met
        // either.
        return {
          ok: false,
          code: 'visual_not_supported',
          message: `Neither the model nor the local builder could produce a ${usedKindLabel.toLowerCase()} where every part cites your material. Nothing was invented.`,
          details: { found, supported, requested: requestedKind },
        };
      }
    }

    // --- the teaching layer --------------------------------------------------
    // A diagram without an explanation was the central defect: students saw
    // labelled boxes and had to guess what they meant. Attach the model's
    // explanation when it survived citation checking, and otherwise build the
    // same sections from sentences quoted out of the material.
    const explanation =
      aiExplanation ??
      buildLocalExplanation({ visual, passages, signals, topic: topic.trim(), documents });
    if (explanation) visual.explanation = explanation;
    else {
      warnings.push({
        code: 'explanation_missing',
        message:
          'The selected passages contain no sentence that could serve as an explanation, so this page shows the diagram and its sources only.',
      });
    }

    // --- citations, text version, provenance ---------------------------------
    const used = collectSourceIds(visual);
    const citations = buildCitations(used, passages);
    const title = aiTitle || buildTitle({ topic: topic.trim(), kind: resolvedKind, signals, documents });
    visual.title = title;
    visual.kind = resolvedKind;
    visual.language = language;

    const lookup = new Map(passages.map((p) => [p.id, p]));
    visual.textVersion = [explanationToText(explanation), buildTextVersion(visual, { title, documents })]
      .filter(Boolean)
      .join('\n\n');
    // Append exact source locations to the text version so it stands alone.
    const locations = [...used].sort().map((id) => {
      const p = lookup.get(id);
      return p ? `${id}: ${p.documentName}, page ${p.pageNumber}` : null;
    }).filter(Boolean);
    if (locations.length > 0) visual.textVersion += `\n\nSources:\n${locations.map((l) => `- ${l}`).join('\n')}`;

    const provenance =
      generationMode === 'live'
        ? `${providerInfo.label} (${providerInfo.model}) laid out this ${usedKindLabel.toLowerCase()} from ${passages.length} passage(s) across ${documents.length} document(s). Every citation was then re-checked against those passages, and ${citations.length} were kept.`
        : fallback
          ? `Built locally by quoting your own material. The AI provider could not be used: ${fallback.message} Every citation was checked against the passages that were supplied.`
          : `Built locally by detecting the structure in your own material and quoting the sentences that carry it. Every citation was checked against the passages that were supplied, and no AI provider key is configured, so no text left this machine.`;

    return {
      ok: true,
      visual,
      citations,
      generationMode,
      provider: providerInfo,
      fallback,
      warnings,
      provenance,
      signals: { ...found, kind: resolvedKind, requested: requestedKind, supported },
      stats: {
        documents,
        passagesAvailable: ordered.length,
        passagesUsed: passages.length,
        citationCount: citations.length,
      },
    };
  }

  return { build, providerInfo };
}

export default createVisualsService;
