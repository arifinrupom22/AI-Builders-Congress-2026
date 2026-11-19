/**
 * Guided learning path service.
 *
 * Breaks one topic into short, ordered steps - prerequisite, explanation,
 * studio visual, worked example, recall question - and never fills a gap with
 * a fact the learner's own material does not contain:
 *
 *  1. Steps are earned from the text. In demo mode they are assembled from
 *     sentences the material actually contains (definitions, dependency
 *     statements, examples); in live mode a model drafts them but the server
 *     re-verifies every [S#] citation and drops whatever is ungrounded. A part
 *     the material does not carry is reported as "not covered in your
 *     material", never silently invented.
 *  2. Visual support per step is a deterministic signal check over that step's
 *     own passages - the same detectors the Visual Study Studio uses - so a
 *     step only offers a visual the studio can honestly draw. The visual
 *     itself is built lazily by `visualForStep`, which delegates to the real
 *     studio service and stores the result on the step.
 */
import { contentTokens } from '../retrieval/tokenize.js';
import { extractKeyTerms } from '../ai/keyterms.js';
import { preparePassages, screenPassage } from '../ai/grounding.js';
import { buildPathMessages } from '../ai/prompts.js';
import {
  detectSignals,
  chooseKind,
  signalSummary,
  buildCitations,
  VISUAL_KINDS,
} from '../visuals/service.js';
import { selectSpread } from '../summary/service.js';

export const MAX_PATH_STEPS = 6;
export const MIN_PATH_STEPS = 2;

/** Exact wording the UI mirrors, so a gap reads as a fact, not an error. */
export const NOT_COVERED = 'not covered in your material';

const STEP_PREFIX = 'p';

const KIND_LABEL = Object.fromEntries(VISUAL_KINDS.map((k) => [k.id, k.label]));

/** Language that says WHAT an idea builds on. */
const PREREQ_CUES = [
  /\b(requires?|required|depends? on|needs?|presupposes?|assumes?|builds? on|rests? on|based on|follows? from)\b/i,
  /\b(must (know|understand|have|be|come)|cannot|can't|without (the|this|it)|before (the|this|it|using|running|starting))\b/i,
  /(প্রয়োজন|নির্ভর করে|ভিত্তি|আগে|ধরে নেয়|উপর গড়)/,
];

/** Language that introduces a concrete case: the only thing we may call an example. */
const EXAMPLE_CUES = [
  /\b(for example|for instance|e\.g\.?|such as|an? example|as an? example|consider|to illustrate|সম্ভব|উদাহরণ|যেমন|মানে)\b/i,
];

/** Secondary signal that a sentence is applied rather than merely stated. */
const WORKED_CUES = [
  /\b(causes?|caused|leads? to|led to|results? in|produced?|produces?|converts?|converted|therefore|thus|hence|so that|in order to)\b/i,
  /\b\d+(?:\.\d+)?\s?(?:%|percent|per cent|times|x|km|m|ms|seconds?|minutes?|hours?|years?)\b/i,
];

const DEFINITION_HINTS = [
  /\b(is|are|means|refers to|is called|is defined as|consists of|denotes|can be defined as)\b/i,
  /(হল|বলে|বোঝায়|করা হয়|নামে)/,
];

/**
 * Words that describe a document's structure rather than its subject. A path
 * step is a concept, so "step", "example" or "figure" is never a step title -
 * unless the learner's own topic uses the word.
 */
const STRUCTURE_WORD_RE =
  /^(?:steps?|first|second|third|then|next|finally|lastly|initially|example|examples|case|cases|process|part|parts|section|chapter|figure|table|page|using|used|uses|new)$/i;

/** A path spread over fewer sentences than this cannot honestly be sequenced. */
const MIN_SENTENCES_FOR_PATH = 4;

const BANGLA_DIGITS = '\u09e6\u09e7\u09e8\u09e9\u09ea\u09eb\u09ec\u09ed\u09ee\u09ef';

function toAsciiDigits(text) {
  return String(text).replace(/[\u09e6-\u09ef]/g, (d) => String(BANGLA_DIGITS.indexOf(d)));
}

function clip(text, max) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}\u2026`;
}

function uniqueIds(list) {
  return [...new Set(list.filter(Boolean))];
}

/**
 * Tolerant JSON extraction, the same shape the quiz generator and the studio
 * service use: models wrap output in prose or fences more often than not.
 */
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

const notCoveredNote = (kind, detail) => `${kind} ${NOT_COVERED}: ${detail}`;

/**
 * Merge key terms the source literally writes adjacent ("carbon", "dioxide"
 * -> "carbon dioxide") so one concept is never taught as two word fragments.
 */
export function mergePhrases(terms, text, firstIndex) {
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const groups = terms.map((t) => ({
    term: t.term,
    stems: [t.stem],
    first: firstIndex.get(t.stem) ?? Number.MAX_SAFE_INTEGER,
  }));
  const consumed = new Set();
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = 0; j < groups.length; j += 1) {
      if (i === j || consumed.has(i) || consumed.has(j)) continue;
      const a = groups[i].term;
      const b = groups[j].term;
      const forward = new RegExp(`\\b${escapeRe(a)}\\s+${escapeRe(b)}\\b`, 'i').test(text);
      const backward = !forward && new RegExp(`\\b${escapeRe(b)}\\s+${escapeRe(a)}\\b`, 'i').test(text);
      if (!forward && !backward) continue;
      groups[i] = {
        term: forward ? `${a} ${b}` : `${b} ${a}`,
        stems: [...groups[i].stems, ...groups[j].stems],
        first: Math.min(groups[i].first, groups[j].first),
      };
      consumed.add(j);
    }
  }
  return groups.filter((_, index) => !consumed.has(index));
}

// --- local step builder -----------------------------------------------------

/**
 * Assemble ordered steps from the passages themselves. Concepts come from the
 * key-term extractor, ordered by where the material first introduces them, so
 * the path follows the source's own teaching order rather than an outside
 * syllabus.
 *
 * @returns {object[]|null} null when the material cannot support MIN_PATH_STEPS.
 */
export function buildLocalSteps(passages, signals, { language = 'en', topic = '' } = {}) {
  const entries = signals.entries ?? [];
  const termSource = passages.map((p) => ({
    id: p.id,
    documentName: p.documentName,
    pageNumber: p.pageNumber,
    heading: p.heading,
    text: p.text,
  }));

  // Repeated terms first; a short document may only mention a concept once, so
  // relax the threshold rather than returning an empty path for a real text.
  let terms = extractKeyTerms(termSource, { limit: MAX_PATH_STEPS * 2, minCount: 2 });
  if (terms.length < MIN_PATH_STEPS) {
    terms = extractKeyTerms(termSource, { limit: MAX_PATH_STEPS * 2, minCount: 1 });
  }

  const topicStems = new Set(contentTokens(topic));
  const usable = terms.filter((t) => topicStems.has(t.stem) || !STRUCTURE_WORD_RE.test(t.stem));

  const firstIndex = new Map();
  entries.forEach((entry, index) => {
    for (const stem of entry.stems) if (!firstIndex.has(stem)) firstIndex.set(stem, index);
  });

  const fullText = passages.map((p) => p.text).join('\n');
  const concepts = mergePhrases(usable, fullText, firstIndex);
  const isTopic = (c) => c.stems.some((s) => topicStems.has(s));

  // The learner's own topic always makes the path - key-term ranking can push
  // it out of a crowded list, but it is what they asked to learn - and every
  // other step follows the order the source introduces its concepts in.
  const topicConcepts = concepts.filter(isTopic).slice(0, MAX_PATH_STEPS);
  const rest = concepts.filter((c) => !isTopic(c)).slice(0, MAX_PATH_STEPS);
  const orderedConcepts = [
    ...new Map([...topicConcepts, ...rest].map((c) => [c.stems.join('|'), c])).values(),
  ].sort((a, b) => a.first - b.first);
  if (orderedConcepts.length < MIN_PATH_STEPS) return null;

  const isBangla = language === 'bn';
  const steps = [];

  for (const concept of orderedConcepts) {
    if (steps.length >= MAX_PATH_STEPS) break;
    const mentions = entries.filter((e) => concept.stems.some((s) => e.stems.has(s)));
    if (mentions.length === 0) continue;
    const quotable = mentions.filter((e) => e.text.length >= 25 && !screenPassage(e.text).suspicious);

    // --- explanation --------------------------------------------------------
    const explanationSrc =
      quotable.find((e) => DEFINITION_HINTS.some((re) => re.test(e.text))) ?? quotable[0] ?? null;
    const explanation = explanationSrc
      ? { covered: true, text: clip(explanationSrc.text, 320), sourceIds: [explanationSrc.passage.id], note: null }
      : {
          covered: false,
          text: null,
          sourceIds: [],
          note: notCoveredNote(
            'Explanation',
            `"${concept.term}" appears in your material but is never explained in a sentence long enough to quote.`,
          ),
        };

    // --- prerequisite -------------------------------------------------------
    const otherConcepts = orderedConcepts.filter((c) => c.term !== concept.term);
    let prerequisite = {
      covered: false,
      concept: null,
      text: null,
      sourceIds: [],
      note: notCoveredNote(
        'Prerequisite',
        `nothing in your material states what "${concept.term}" builds on, so none is claimed.`,
      ),
    };
    for (const entry of quotable) {
      if (!PREREQ_CUES.some((re) => re.test(entry.text))) continue;
      const dep =
        otherConcepts.find((c) => c.stems.some((s) => entry.stems.has(s)) && c.first < concept.first) ??
        otherConcepts.find((c) => c.stems.some((s) => entry.stems.has(s)));
      if (!dep) continue;
      prerequisite = {
        covered: true,
        concept: clip(dep.term, 60),
        text: clip(entry.text, 260),
        sourceIds: [entry.passage.id],
        note: null,
      };
      break;
    }

    // --- worked example -----------------------------------------------------
    // Only sentences the material frames as a case may be called an example.
    // No such sentence means an honest gap, not a second description.
    const exampleSrc =
      quotable.find((e) => e !== explanationSrc && EXAMPLE_CUES.some((re) => re.test(e.text))) ??
      quotable.find((e) => e !== explanationSrc && WORKED_CUES.some((re) => re.test(e.text))) ??
      null;
    const example = exampleSrc
      ? { covered: true, text: clip(exampleSrc.text, 320), sourceIds: [exampleSrc.passage.id], note: null }
      : {
          covered: false,
          text: null,
          sourceIds: [],
          note: notCoveredNote(
            'Worked example',
            `your material contains no example or worked case for "${concept.term}".`,
          ),
        };

    // --- recall question ----------------------------------------------------
    const question = explanation.covered
      ? {
          covered: true,
          prompt: isBangla
            ? `আপনার উপকরণে অনুসারে ${concept.term} কী?`
            : DEFINITION_HINTS.some((re) => re.test(explanation.text))
              ? `How does your material define ${concept.term}?`
              : `What does your material say about ${concept.term}?`,
          answer: explanation.text,
          sourceIds: [...explanation.sourceIds],
          note: null,
        }
      : {
          covered: false,
          prompt: null,
          answer: null,
          sourceIds: [],
          note: notCoveredNote(
            'Recall question',
            'there is no explanation in your material to check your recall against.',
          ),
        };

    const sourceIds = uniqueIds([
      ...prerequisite.sourceIds,
      ...explanation.sourceIds,
      ...example.sourceIds,
      ...question.sourceIds,
    ]);
    // A step nothing can cite is a step we cannot stand behind.
    if (sourceIds.length === 0) continue;

    steps.push({
      title: clip(concept.term, 90),
      prerequisite,
      explanation,
      example,
      question,
      sourceIds,
    });
  }

  return steps.length >= MIN_PATH_STEPS ? steps : null;
}

// --- AI path validation ------------------------------------------------------

/**
 * Accept a model-drafted path only where every surviving part is grounded in a
 * passage we actually supplied. Missing parts become explicit gaps.
 *
 * @returns {{steps:object[]|null, dropped:number}}
 */
export function normaliseAiSteps(raw, passages, { language = 'en' } = {}) {
  const allowed = new Map(passages.map((p) => [p.id, p]));
  const keepIds = (ids) =>
    (Array.isArray(ids) ? ids : [])
      .map(String)
      .filter((id) => allowed.has(id))
      .slice(0, 3);

  const isBangla = language === 'bn';
  let dropped = 0;
  const steps = [];

  for (const rawStep of Array.isArray(raw?.steps) ? raw.steps : []) {
    if (steps.length >= MAX_PATH_STEPS) break;
    const title = clip(rawStep?.title ?? '', 90);
    if (!title) {
      dropped += 1;
      continue;
    }

    const prereqIds = keepIds(rawStep?.prerequisite?.sourceIds);
    const explanationIds = keepIds(rawStep?.explanation?.sourceIds);
    const exampleIds = keepIds(rawStep?.example?.sourceIds);
    const questionIds = keepIds(rawStep?.question?.sourceIds);

    const prerequisite =
      rawStep?.prerequisite?.text && prereqIds.length > 0
        ? {
            covered: true,
            concept: rawStep.prerequisite.concept ? clip(rawStep.prerequisite.concept, 60) : null,
            text: clip(rawStep.prerequisite.text, 260),
            sourceIds: prereqIds,
            note: null,
          }
        : {
            covered: false,
            concept: null,
            text: null,
            sourceIds: [],
            note: notCoveredNote('Prerequisite', `nothing in your material states what "${title}" builds on, so none is claimed.`),
          };

    const explanation =
      rawStep?.explanation?.text && explanationIds.length > 0
        ? { covered: true, text: clip(rawStep.explanation.text, 320), sourceIds: explanationIds, note: null }
        : {
            covered: false,
            text: null,
            sourceIds: [],
            note: notCoveredNote('Explanation', `"${title}" is never explained in a passage we can quote.`),
          };

    const example =
      rawStep?.example?.text && exampleIds.length > 0
        ? { covered: true, text: clip(rawStep.example.text, 320), sourceIds: exampleIds, note: null }
        : {
            covered: false,
            text: null,
            sourceIds: [],
            note: notCoveredNote('Worked example', `your material contains no example or worked case for "${title}".`),
          };

    const question =
      rawStep?.question?.prompt && rawStep?.question?.answer && questionIds.length > 0
        ? {
            covered: true,
            prompt: clip(rawStep.question.prompt, 180),
            answer: clip(rawStep.question.answer, 320),
            sourceIds: questionIds,
            note: null,
          }
        : {
            covered: false,
            prompt: null,
            answer: null,
            sourceIds: [],
            note: notCoveredNote(
              'Recall question',
              explanation.covered
                ? 'the material gives no answer the question could be checked against.'
                : 'there is no explanation in your material to check your recall against.',
            ),
          };

    const sourceIds = uniqueIds([...prereqIds, ...explanationIds, ...exampleIds, ...questionIds]);
    if (sourceIds.length === 0) {
      dropped += 1;
      continue;
    }

    steps.push({ title, prerequisite, explanation, example, question, sourceIds });
  }

  if (steps.length < MIN_PATH_STEPS) return { steps: null, dropped };
  return { steps, dropped };
}

// --- per-step visual support -------------------------------------------------

/**
 * Can the Visual Study Studio honestly draw this step? A purely local signal
 * check over the step's own cited passages - the same detectors the studio
 * runs - so a learner is never offered a visual that would have to invent
 * steps, dates or links.
 */
export function visualSupportForStep(step, passages, entries = []) {
  const byId = new Map(passages.map((p) => [p.id, p]));
  const titleStems = new Set(contentTokens(step.title));
  // Every passage the material discusses this concept in - the scope the
  // reason text below claims, and the same passages the studio would retrieve.
  const discussed = entries
    .filter((e) => [...e.stems].some((stem) => titleStems.has(stem)))
    .map((e) => e.passage.id);
  const stepPassages = uniqueIds(discussed.length > 0 ? discussed : step.sourceIds)
    .map((id) => byId.get(id))
    .filter(Boolean);
  const topic = step.title;

  if (stepPassages.length === 0) {
    return {
      supported: false,
      topic,
      kind: null,
      label: null,
      reason: `No passage could be attached to "${topic}", so no visual was built.`,
      visual: null,
      citations: null,
      generationMode: null,
    };
  }

  const stepSignals = detectSignals(stepPassages);
  const kind = chooseKind(stepSignals);
  if (!kind) {
    return {
      supported: false,
      topic,
      kind: null,
      label: null,
      reason: `The passages about "${topic}" carry no structure the Visual Study Studio can draw - no ordered steps, no dated events, no stated contrasts and too few stated connections - so nothing was built rather than inventing links or steps.`,
      visual: null,
      citations: null,
      generationMode: null,
    };
  }
  return {
    supported: true,
    topic,
    kind,
    label: KIND_LABEL[kind],
    reason: null,
    visual: null,
    citations: null,
    generationMode: null,
  };
}

// --- accessible text version -------------------------------------------------

/**
 * The linear, screen-reader friendly rendering of a whole path: every step in
 * order, each part with its gaps stated in words and its sources appended.
 */
export function buildPathTextVersion({ topic, steps, documents = [] }) {
  const lines = [`Learning path: ${topic}`];
  if (documents.length) lines.push(`Sources: ${documents.join(', ')}`);
  lines.push('');

  steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step.title}`);
    if (step.prerequisite.covered) {
      lines.push(`   Prerequisite: ${step.prerequisite.concept ? `${step.prerequisite.concept} - ` : ''}${step.prerequisite.text}`);
    } else {
      lines.push(`   Prerequisite: ${NOT_COVERED}. ${step.prerequisite.note ?? ''}`.trim());
    }
    lines.push(
      step.explanation.covered
        ? `   Explanation: ${step.explanation.text}`
        : `   Explanation: ${NOT_COVERED}. ${step.explanation.note ?? ''}`.trim(),
    );
    lines.push(
      step.visual?.supported
        ? `   Visual: ${step.visual.label} available in the Visual Study Studio.`
        : `   Visual: none built. ${step.visual?.reason ?? ''}`.trim(),
    );
    lines.push(
      step.example.covered
        ? `   Worked example: ${step.example.text}`
        : `   Worked example: ${NOT_COVERED}. ${step.example.note ?? ''}`.trim(),
    );
    lines.push(
      step.question.covered
        ? `   Recall: ${step.question.prompt} Answer: ${step.question.answer}`
        : `   Recall question: ${NOT_COVERED}. ${step.question.note ?? ''}`.trim(),
    );
    const seen = uniqueIds(step.sourceIds);
    if (seen.length) lines.push(`   Sources: ${seen.join(', ')}`);
    lines.push('');
  });

  return lines.join('\n').trimEnd();
}

// --- service -----------------------------------------------------------------

export function createLearningPathService({ retrieval, provider, config, logger, store, visualsService }) {
  const providerInfo = provider ? { id: provider.id, label: provider.label, model: provider.model } : null;

  /**
   * @param {{learnerId:string, topic?:string, materialIds?:string[]|null, language?:string|null}} params
   */
  async function build({ learnerId, topic = '', materialIds = null, language = null }) {
    const trimmedTopic = String(topic ?? '').trim();

    // --- gather passages, exactly like the studio service -------------------
    let ordered;
    if (trimmedTopic) {
      const search = await retrieval.search({
        learnerId,
        query: trimmedTopic,
        materialIds,
        topK: 24,
        minScore: config.retrieval.minScore,
      });
      if (!search.supported) {
        return {
          ok: false,
          code: search.hasMaterials ? 'topic_not_found' : 'no_materials',
          message: search.hasMaterials
            ? `Your indexed material has nothing matching "${clip(trimmedTopic, 80)}", so there is no grounded content for a learning path.`
            : 'Upload a document first: a learning path can only be built from your own indexed material.',
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
              ? 'Upload a document first: a learning path can only be built from your own indexed material.'
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
    const resolvedLanguage =
      language ?? materials.find((m) => !materialIds?.length || materialIds.includes(m.id))?.language ?? 'en';

    // --- context budget -----------------------------------------------------
    const budget = config.retrieval.summaryChars;
    const { selected } = selectSpread(ordered, budget);
    const prepared = preparePassages(
      selected.map((p) => ({ ...p, passageId: p.passageId ?? p.id, score: undefined })),
      { contextChars: budget },
    );
    const passages = prepared.passages;
    const warnings = [...prepared.notes];
    if (prepared.truncated) {
      warnings.push({
        code: 'context_truncated',
        message: `Only the first ${passages.length} of ${ordered.length} passages fit the path context. Select fewer documents for fuller steps.`,
      });
    }

    if (passages.length === 0) {
      return {
        ok: false,
        code: 'not_enough_material',
        message: 'This selection has no readable indexed passages, so no step could cite a real source.',
      };
    }

    const signals = detectSignals(passages);
    const found = signalSummary(signals);

    // --- steps: local first, AI when configured -----------------------------
    let steps = null;
    let generationMode = 'demo';
    let fallback = null;
    let dropped = 0;

    if (provider) {
      try {
        const startedAt = Date.now();
        const response = await provider.chat({
          messages: buildPathMessages({
            passages,
            topic: trimmedTopic,
            language: resolvedLanguage,
            documents,
          }),
          temperature: 0.2,
          maxTokens: 2400,
        });
        const raw = parseJsonFromModel(response.content);
        const normalised = raw
          ? normaliseAiSteps(raw, passages, { language: resolvedLanguage })
          : { steps: null, dropped: 0 };
        if (normalised.steps) {
          steps = normalised.steps;
          dropped = normalised.dropped;
          generationMode = 'live';
          if (dropped > 0) {
            warnings.push({
              code: 'ungrounded_parts_dropped',
              message: `${dropped} part${dropped > 1 ? 's' : ''} of the generated path had no verifiable source passage and ${dropped > 1 ? 'were' : 'was'} removed.`,
            });
          }
          logger.info('learning path generated', {
            provider: provider.id,
            model: provider.model,
            steps: steps.length,
            ms: Date.now() - startedAt,
            passages: passages.length,
          });
        } else {
          fallback = { code: 'ai_path_unusable', message: 'The model returned steps that did not survive citation checking.' };
          warnings.push({
            code: 'ai_path_unusable',
            message: 'The model\u2019s version could not be verified against your passages, so the path was rebuilt from quoted sentences instead.',
          });
        }
      } catch (err) {
        fallback = { code: err.code ?? 'ai_provider_error', message: err.message };
        logger.warn('ai provider failed, falling back to local learning path', { code: fallback.code });
        warnings.push({
          code: 'ai_provider_fallback',
          message: `${err.message} The path was built locally from your material instead.`,
        });
      }
    }

    if (steps === null) {
      steps = buildLocalSteps(passages, signals, { language: resolvedLanguage, topic: trimmedTopic });
    }

    if (!steps || steps.length < MIN_PATH_STEPS || signals.sentenceCount < MIN_SENTENCES_FOR_PATH) {
      // The honest refusal: say what WAS in the text, so the learner knows
      // what to upload rather than assuming the feature is broken.
      return {
        ok: false,
        code: 'path_not_supported',
        message: `Your material does not contain enough to break "${clip(trimmedTopic || 'this topic', 60)}" into ${MIN_PATH_STEPS} or more grounded steps: ${found.recurringTerms} recurring term${found.recurringTerms === 1 ? '' : 's'} and ${found.sentencesScanned} usable sentence${found.sentencesScanned === 1 ? '' : 's'} were found, and a path needs at least ${MIN_SENTENCES_FOR_PATH} sentences it can cite across its steps. Nothing was invented - try a broader topic or upload the chapter that covers it.`,
        details: { found, requested: trimmedTopic || null },
      };
    }

    steps = steps.slice(0, MAX_PATH_STEPS).map((step, index) => ({
      id: `${STEP_PREFIX}${index + 1}`,
      index,
      ...step,
      visual: visualSupportForStep(step, passages, signals.entries),
      completed: false,
      completedAt: null,
    }));

    // --- citations, text version, provenance --------------------------------
    const used = uniqueIds(steps.flatMap((s) => s.sourceIds));
    const citations = buildCitations(used, passages);
    const lookup = new Map(passages.map((p) => [p.id, p]));
    const base =
      trimmedTopic ||
      steps[0]?.title ||
      (documents[0] ? documents[0].replace(/\.[^.]+$/, '') : 'Your material');
    const title = clip(base, 100);

    const textVersion = buildPathTextVersion({ topic: title, steps, documents });
    const locations = used
      .map((id) => {
        const p = lookup.get(id);
        return p ? `${id}: ${p.documentName}, page ${p.pageNumber}` : null;
      })
      .filter(Boolean);
    const withSources = locations.length
      ? `${textVersion}\n\nSources:\n${locations.map((l) => `- ${l}`).join('\n')}`
      : textVersion;

    const provenance =
      generationMode === 'live'
        ? `${providerInfo.label} (${providerInfo.model}) drafted ${steps.length} step(s) from ${passages.length} passage(s) across ${documents.length} document(s). Every citation was then re-checked against those passages, and ${citations.length} were kept.`
        : fallback
          ? `Built locally by quoting your own material. The AI provider could not be used: ${fallback.message} Every citation was checked against the passages that were supplied.`
          : `Built locally by quoting your own material. No AI provider key is configured, so no text left this machine, and every citation was checked against the passages that were supplied.`;

    const countCovered = (key) => steps.filter((s) => s[key]?.covered).length;

    return {
      ok: true,
      path: {
        topic: title,
        requestedTopic: trimmedTopic,
        materialIds,
        language: resolvedLanguage,
        steps,
        citations,
        textVersion: withSources,
        generationMode,
        provider: providerInfo,
        fallback,
        warnings,
        provenance,
        signals: { ...found, requested: trimmedTopic || null },
        stats: {
          documents,
          passagesAvailable: ordered.length,
          passagesUsed: passages.length,
          steps: steps.length,
          citations: citations.length,
          completed: 0,
          covered: {
            prerequisites: countCovered('prerequisite'),
            explanations: countCovered('explanation'),
            examples: countCovered('example'),
            questions: countCovered('question'),
            visuals: steps.filter((s) => s.visual?.supported).length,
          },
        },
      },
    };
  }

  /**
   * Build (or return the already built) studio visual for one step. The step's
   * support flag came from the deterministic signal check at generation time;
   * the picture itself comes from the real Visual Study Studio service, so a
   * step's visual carries exactly the same citations and honesty rules.
   */
  async function visualForStep({ learnerId, pathId, stepId }) {
    const record = await store.getPath(pathId, learnerId);
    if (!record) return { ok: false, code: 'not_found', message: 'That learning path was not found.' };
    const step = record.steps.find((s) => s.id === stepId);
    if (!step) return { ok: false, code: 'step_not_found', message: 'That step is not part of this learning path.' };

    if (step.visual?.visual) {
      return { ok: true, cached: true, visual: step.visual };
    }
    if (step.visual && step.visual.supported === false) {
      return { ok: false, code: 'visual_not_supported', message: step.visual.reason };
    }

    const result = await visualsService.build({
      learnerId,
      materialIds: record.materialIds ?? null,
      topic: step.visual?.topic ?? step.title,
      kind: 'auto',
    });

    if (!result.ok) {
      // Persist the refusal so the client stops asking and the UI can explain.
      const refusal = {
        supported: false,
        topic: step.title,
        kind: null,
        label: null,
        reason: result.message,
        visual: null,
        citations: null,
        generationMode: null,
      };
      await store.updatePath(pathId, learnerId, (draft) => {
        const target = draft.steps.find((s) => s.id === stepId);
        if (target) target.visual = refusal;
      });
      return { ok: false, code: result.code, message: result.message };
    }

    const attached = {
      supported: true,
      topic: step.title,
      kind: result.visual.kind,
      label: KIND_LABEL[result.visual.kind] ?? result.visual.kind,
      reason: null,
      visual: result.visual,
      citations: result.citations,
      generationMode: result.generationMode,
    };
    await store.updatePath(pathId, learnerId, (draft) => {
      const target = draft.steps.find((s) => s.id === stepId);
      if (target) target.visual = attached;
    });
    logger?.debug('step visual attached', { pathId, stepId, kind: attached.kind });

    return { ok: true, cached: false, visual: attached };
  }

  return { build, visualForStep, providerInfo };
}

export default createLearningPathService;
