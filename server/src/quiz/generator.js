/**
 * Quiz generation.
 *
 * Both paths are grounded, and the deterministic one is not a degraded
 * placeholder - it is a real, working multiple-choice generator:
 *
 *   1. Candidate definitions are extracted from the student's own passages with
 *      a pattern matcher ("X is/are/refers to/means ...").
 *   2. One candidate becomes the stem; the distractors are definitions of OTHER
 *      real terms from the material, never invented text.
 *   3. Option order is shuffled with a seeded PRNG derived from the quiz id, so
 *      generation is reproducible and testable while still not being fixed.
 *
 * A pattern-B question ("which statement appears in <doc>?") is used when too
 * few definitions are available; its distractors are real sentences from other
 * documents, and its explanation cites them.
 *
 * The AI path asks for strict JSON, then validates it with a schema and maps
 * every `sourceIds` entry back to a passage that was actually retrieved. Any
 * question that cannot be traced to a real passage is dropped, and if too few
 * survive we fall back to the deterministic generator rather than ship
 * unsupported questions.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { splitSentences, detectLanguage } from '../ai/extractive-utils.js';
import { buildQuizMessages } from '../ai/prompts.js';
import { screenPassage } from '../ai/grounding.js';

const MIN_OPTIONS = 4;

const AiQuizSchema = z.object({
  questions: z
    .array(
      z.object({
        prompt: z.string().trim().min(12).max(600),
        options: z.array(z.string().trim().min(1).max(400)).length(MIN_OPTIONS),
        answerIndex: z.number().int().min(0).max(MIN_OPTIONS - 1),
        explanation: z.string().trim().min(5).max(900),
        sourceIds: z.array(z.string().trim()).min(1),
      }),
    )
    .min(1),
});

/** Deterministic PRNG (mulberry32) so shuffles are reproducible per quiz. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(text) {
  const hash = crypto.createHash('sha256').update(text).digest();
  return hash.readUInt32BE(0);
}

function shuffled(items, rng) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const DEFINITION_RE =
  /^(?<term>[A-Z][\w\s\-'()/]{2,68}?|[a-z][a-z\s\-']{3,48}?)\s+(?:is|are|was|were|refers to|refer to|means|is defined as|are defined as|describes|denotes)\s+(?<def>.{25,})$/;

/**
 * The Bangla form of the same pattern: "ক্লোরোফিল হলো সবুজ পাতায় পাওয়া রঞ্জক...".
 * Without it a Bangla document could be uploaded and searched but never quizzed
 * offline, because the deterministic generator only knew English definitions.
 */
const BANGLA_DEFINITION_RE =
  /^(?<term>[\u0980-\u09FF][\u0980-\u09FF\s\-()]{1,60}?)\s+(?:হলো|হচ্ছে|হল|বলা হয়|বলে|মানে|অর্থ)\s+(?<def>.{25,})$/;

/**
 * Match a definition sentence in either script.
 * @returns {{term:string, definition:string}|null}
 */
export function matchDefinition(sentence) {
  const match = sentence.match(DEFINITION_RE) ?? sentence.match(BANGLA_DEFINITION_RE);
  if (!match?.groups?.term) return null;
  let term = match.groups.term.trim();
  term = term.replace(/^(the|a|an)\s+/i, '');
  // "মাইটোকন্ড্রিয়াকে বলে ..." defines মাইটোকন্ড্রিয়া, not "...কে".
  if (term.length > 3 && term.endsWith('কে')) term = term.slice(0, -2).trim();
  return { term, definition: match.groups.def };
}

function clip(text, max = 240) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Words that cannot begin a noun phrase. A "term" starting with one of these is
 * a clause, not a term: matching "Either every operation in the transaction is
 * applied, or none of them is applied at all" used to produce the stem
 * "what does Either every operation in the transaction mean?".
 */
const CLAUSE_INITIAL_WORDS = new Set([
  'either', 'neither', 'both', 'and', 'or', 'but', 'so', 'yet', 'for', 'nor',
  'when', 'whenever', 'if', 'unless', 'until', 'whether', 'while', 'whereas',
  'because', 'although', 'though', 'since', 'after', 'before', 'once',
  'there', 'here', 'this', 'that', 'these', 'those', 'it', 'its', 'they', 'their',
  'he', 'she', 'we', 'you', 'one', 'some', 'all', 'every', 'each', 'many', 'most',
  'few', 'no', 'none', 'not', 'half', 'part', 'such',
  // Bangla equivalents: these begin a clause, not a noun phrase.
  'এবং', 'কিন্তু', 'অথচ', 'যখন', 'যদি', 'যেহেতু', 'কারণ', 'তাই', 'অতএব', 'তবে',
  'যদিও', 'এটি', 'এটা', 'এই', 'সেটি', 'সেটা', 'তারা', 'আমরা', 'আপনি', 'সব',
  'প্রতিটি', 'অনেক', 'কিছু', 'তিনি', 'মধ্যে', 'এখানে', 'সেখানে', 'নিচে',
]);

/** Pull definition-style sentences out of a passage with position metadata. */
export function extractDefinitions(passages) {
  const found = [];
  for (const passage of passages) {
    const heading = passage.heading ? String(passage.heading).replace(/\s+/g, ' ').trim() : '';
    for (const raw of splitSentences(passage.text)) {
      let sentence = raw.replace(/\s+/g, ' ').trim();
      // A title line usually has no full stop, so it arrives fused to the first
      // real sentence: "Photosynthesis - lecture notes Photosynthesis is the
      // process...". Strip the title before matching, or the term becomes the
      // title and the question reads as nonsense.
      if (heading && sentence.toLowerCase().startsWith(heading.toLowerCase())) {
        const rest = sentence.slice(heading.length).replace(/^[\s:\u2013\u2014-]+/, '').trim();
        if (rest.length >= 45) sentence = rest;
      }
      if (sentence.length < 45 || sentence.length > 420) continue;
      const match = matchDefinition(sentence);
      if (!match) continue;
      const term = match.term;
      if (term.length < 3 || term.length > 60) continue;
      if (/^(it|this|that|these|those|there|they|he|she|we|you|i)$/i.test(term)) continue;
      // A term is a short noun phrase. These three tests reject the sentences
      // where the pattern matched a whole clause instead: "A transaction should
      // appear to run as if it were the only transaction..." used to yield the
      // stem "what is transaction should appear to run as if it?".
      const termWords = term.split(/\s+/);
      if (termWords.length > 5) continue;
      if (CLAUSE_INITIAL_WORDS.has(termWords[0].toLowerCase())) continue;
      if (term.includes(',')) continue;
      found.push({
        term,
        definition: sentence,
        passageId: passage.passageId ?? passage.id,
        documentName: passage.documentName,
        pageNumber: passage.pageNumber,
        heading: passage.heading ?? null,
        materialId: passage.materialId,
      });
    }
  }
  return found;
}

const QUESTION_TEMPLATES = {
  en: [
    (term, doc) => `According to "${doc}", what does ${term} mean?`,
    (term, doc) => `In "${doc}", what is ${term}?`,
    (term, doc) => `Which option best defines ${term} as it is used in "${doc}"?`,
  ],
  bn: [
    (term, doc) => `"${doc}" অনুযায়ী ${term} বলতে কীবোঝায়?`,
    (term, doc) => `"${doc}" ফাইলে ${term} কী?`,
    (term, doc) => `"${doc}"-এ ব্যবহৃত অর্থ অনুযায়ী ${term}-এর সবচেয়ে উপযুক্ত সংজ্ঞা কোনটি?`,
  ],
};

/** Turn a definition candidate into a four-option MCQ using real definitions. */
function buildDefinitionQuestion({ candidate, pool, index, rng, language = 'en' }) {
  const sameTerm = (a) => a.term.toLowerCase() === candidate.term.toLowerCase();
  // Prefer distractors from other documents: they read as plausible while being
  // clearly distinguishable by source.
  const others = pool.filter((c) => !sameTerm(c) && c.definition !== candidate.definition);
  const crossDoc = others.filter((c) => c.documentName !== candidate.documentName);
  const ordered = [...crossDoc, ...others];
  const seenText = new Set([candidate.definition]);
  const distractors = [];
  for (const other of ordered) {
    if (seenText.has(other.definition)) continue;
    seenText.add(other.definition);
    distractors.push(other);
    if (distractors.length === MIN_OPTIONS - 1) break;
  }
  if (distractors.length < MIN_OPTIONS - 1) return null;

  const correctOption = clip(candidate.definition);
  const options = shuffled(
    [
      { text: correctOption, correct: true },
      ...distractors.map((d) => ({ text: clip(d.definition), correct: false })),
    ],
    rng,
  );

  const templates = QUESTION_TEMPLATES[language] ?? QUESTION_TEMPLATES.en;
  const template = templates[index % templates.length];
  const explanation =
    language === 'bn'
      ? [
          `আপনার উপকরণে "${candidate.documentName}"-এর ${candidate.pageNumber} নম্বর পৃষ্ঠায় বলা হয়েছে: "${clip(
            candidate.definition,
            200,
          )}"`,
          `অন্য বিকল্পগুলো ${distractors.map((d) => d.term).join(', ')} সম্পর্কে বলে।`,
        ].join(' ')
      : [
          `Your material states, on page ${candidate.pageNumber} of "${candidate.documentName}": "${clip(
            candidate.definition,
            200,
          )}"`,
          `The other options describe ${distractors.map((d) => d.term).join(', ')}.`,
        ].join(' ');

  return {
    prompt: template(candidate.term, candidate.documentName),
    options: options.map((o) => o.text),
    answerIndex: options.findIndex((o) => o.correct),
    explanation,
    topic: candidate.heading || candidate.documentName,
    source: {
      materialId: candidate.materialId,
      documentName: candidate.documentName,
      pageNumber: candidate.pageNumber,
      passageId: candidate.passageId,
    },
    generationMode: 'demo',
  };
}

/** Pattern B: the correct option is a real sentence, distractors real sentences from elsewhere. */
function buildSentenceQuestion({ passage, pool, index, rng, language = 'en' }) {
  const mySentences = splitSentences(passage.text)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 50 && s.length <= 300);
  if (mySentences.length === 0) return null;

  const target = mySentences[index % mySentences.length];
  const foreign = pool
    .filter((p) => p.documentName !== passage.documentName)
    .flatMap((p) => splitSentences(p.text).map((s) => ({ text: s.replace(/\s+/g, ' ').trim(), passage: p })))
    .filter((s) => s.text.length >= 50 && s.text.length <= 300 && s.text !== target);

  const seen = new Set([target]);
  const distractors = [];
  for (const f of foreign) {
    if (seen.has(f.text)) continue;
    seen.add(f.text);
    distractors.push(f);
    if (distractors.length === MIN_OPTIONS - 1) break;
  }
  if (distractors.length < MIN_OPTIONS - 1) return null;

  const options = shuffled(
    [
      { text: clip(target, 260), correct: true },
      ...distractors.map((d) => ({ text: clip(d.text, 260), correct: false })),
    ],
    rng,
  );

  return {
    prompt:
      language === 'bn'
        ? `"${passage.documentName}" নামক উপকরণে নিচের কোন বাক্যটি সত্যিই আছে?`
        : `Which of these statements actually appears in "${passage.documentName}"?`,
    options: options.map((o) => o.text),
    answerIndex: options.findIndex((o) => o.correct),
    explanation:
      language === 'bn'
        ? `সঠিক বিকল্পটি "${passage.documentName}"-এর ${passage.pageNumber} নম্বর পৃষ্ঠায় পাওয়া যায়। বাকি বাক্যগুলো আপনার লাইব্রেরির অন্য নথি থেকে নেওয়া, তাই সেগুলো অন্য জায়গায় সত্য হলেও এই নথিতে নেই।`
        : `The correct option appears on page ${passage.pageNumber} of "${passage.documentName}". The other statements are real sentences from other documents in your library, so they are true elsewhere but not here.`,
    topic: passage.heading || passage.documentName,
    source: {
      materialId: passage.materialId,
      documentName: passage.documentName,
      pageNumber: passage.pageNumber,
      passageId: passage.passageId ?? passage.id,
    },
    generationMode: 'demo',
  };
}

/**
 * Deterministic grounded quiz builder.
 * @returns {{questions:object[], reason:string|null}}
 */
/**
 * The question styles this generator can actually produce, grounded:
 *
 *   recall - definition questions only ("what does X mean?").
 *   mixed  - definitions plus statement-recognition questions drawn from the
 *            same passages. Nothing is phrased as an application or scenario
 *            question, because the material cannot support one without
 *            inventing the scenario.
 */
export const QUIZ_STYLES = ['recall', 'mixed'];

export function buildDeterministicQuiz({ passages, questionCount, seedText, language = 'en', style = 'mixed' }) {
  const rng = mulberry32(seedFrom(seedText));
  const definitions = extractDefinitions(passages);
  const questions = [];

  // Only definitions whose sentence is not itself injection-like.
  const safeDefinitions = definitions.filter((d) => !screenPassage(d.definition).suspicious);

  if (safeDefinitions.length >= MIN_OPTIONS) {
    // Spread the stems across documents so one document cannot dominate.
    const byDocument = new Map();
    for (const candidate of safeDefinitions) {
      const list = byDocument.get(candidate.documentName) ?? [];
      list.push(candidate);
      byDocument.set(candidate.documentName, list);
    }
    const interleaved = [];
    let more = true;
    for (let round = 0; more; round += 1) {
      more = false;
      for (const list of byDocument.values()) {
        if (round < list.length) {
          interleaved.push(list[round]);
          more = true;
        }
      }
    }

    for (const candidate of interleaved) {
      if (questions.length >= questionCount) break;
      const question = buildDefinitionQuestion({
        candidate,
        pool: safeDefinitions,
        index: questions.length,
        rng,
        language,
      });
      if (question) questions.push(question);
    }
  }

  // Top up with sentence-recognition questions if definitions ran out. A
  // recall drill deliberately stops at definitions so the learner meets the
  // concept again before anything that asks them to recognise source text.
  if (style !== 'recall' && questions.length < questionCount) {
    const usable = passages.filter((p) => !screenPassage(p.text).suspicious);
    for (let i = 0; i < usable.length && questions.length < questionCount; i += 1) {
      const question = buildSentenceQuestion({
        passage: usable[i],
        pool: passages,
        index: i,
        rng,
        language,
      });
      if (!question) continue;
      if (questions.some((q) => q.prompt === question.prompt)) continue;
      questions.push(question);
    }
  }

  questions.forEach((q, i) => {
    q.id = `q${i + 1}`;
  });

  if (questions.length === 0) {
    return {
      questions: [],
      reason:
        'There is not enough structured text in the selected material to build a four-option question. Try selecting a document with more full sentences, or a different topic.',
    };
  }
  if (questions.length < questionCount) {
    return {
      questions,
      reason: `Generated ${questions.length} of ${questionCount} questions. Your material did not contain enough distinct definitions for more; nothing was invented to fill the gap.`,
    };
  }
  return { questions, reason: null };
}

function parseJsonFromModel(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
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

function gapSourceOf(passage) {
  return {
    materialId: passage.materialId ?? null,
    documentName: passage.documentName ?? null,
    pageNumber: passage.pageNumber ?? null,
    passageId: passage.passageId ?? passage.id ?? null,
  };
}

/**
 * A short, quoted explanation for a concept, taken from the learner's own
 * passages. Prefers a definition sentence naming the concept, then any sentence
 * that names it, then the first substantive sentence of the concept's passage.
 * Returns null rather than paraphrasing when the passages have no usable text.
 */
export function buildGapExplanation({ passages, concept }) {
  if (!passages || passages.length === 0) return null;
  const key = String(concept ?? '').toLowerCase();

  const definitions = extractDefinitions(passages);
  const match =
    definitions.find((d) => key && (key.includes(d.term.toLowerCase()) || d.term.toLowerCase().includes(key))) ??
    definitions[0] ??
    null;
  if (match) {
    return { text: clip(match.definition, 320), source: gapSourceOf(match) };
  }

  for (const passage of passages) {
    const sentence = splitSentences(passage.text ?? '')
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .find((part) => part.length >= 40 && key && part.toLowerCase().includes(key));
    if (sentence) return { text: clip(sentence, 320), source: gapSourceOf(passage) };
  }

  const first = splitSentences(passages[0].text ?? '')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .find((part) => part.length >= 40);
  return first ? { text: clip(first, 320), source: gapSourceOf(passages[0]) } : null;
}

const CONFIDENCE_NOTES = {
  guessed:
    'You reported guessing. That is supporting context only — a guess is not proof of a misconception, and it does not change the explanation above.',
  unsure:
    'You reported being unsure. That is supporting context only; the explanation above comes from your material, not from how confident you felt.',
  confident:
    'You reported being confident. Confidence is recorded as context only and is not treated as proof that you understood or misunderstood the concept.',
};

/**
 * Echo the learner's optional confidence report as context. It never changes
 * the explanation, the follow-up question, or the verdict, because confidence
 * is not evidence of what someone does or does not understand.
 */
export function confidenceContext(level) {
  const value = level ?? null;
  return {
    level: value,
    note:
      value && CONFIDENCE_NOTES[value]
        ? CONFIDENCE_NOTES[value]
        : 'Confidence was not reported. It is optional, and would only ever be supporting context — not evidence of a misconception.',
  };
}

export function createQuizService({ retrieval, provider, config, logger, store }) {
  const providerInfo = provider ? { id: provider.id, label: provider.label, model: provider.model } : null;

  /** Choose the passages a quiz will draw from. */
  async function selectPassages({ learnerId, materialIds, topic }) {
    if (topic && topic.trim().length > 0) {
      const search = await retrieval.search({
        learnerId,
        query: topic,
        materialIds,
        topK: 12,
        // A topic can legitimately be broad; do not reject a whole quiz because
        // one term is absent, but still only ever use real passages.
        minScore: Math.min(config.retrieval.minScore, 0.2),
      });
      if (search.results.length > 0) {
        const ids = new Set(search.results.map((r) => r.passageId));
        const all = await retrieval.allPassages(learnerId, materialIds);
        return all.filter((p) => ids.has(p.passageId ?? p.id));
      }
    }
    return retrieval.allPassages(learnerId, materialIds);
  }

  async function generate({
    learnerId,
    materialIds = null,
    topic = '',
    questionCount,
    language = null,
    style = 'mixed',
    timeLimitSeconds = null,
  }) {
    const resolvedStyle = QUIZ_STYLES.includes(style) ? style : 'mixed';
    const count = Math.max(1, Math.min(questionCount ?? 5, config.limits.maxQuizQuestions));
    const passages = await selectPassages({ learnerId, materialIds, topic });

    if (passages.length === 0) {
      return {
        ok: false,
        code: 'no_source_material',
        message:
          'There is no indexed material to build a quiz from. Upload a document first, or select at least one document that finished processing.',
      };
    }

    const quizId = crypto.randomUUID();
    // Language, in order of trust: what the caller asked for, then the language
    // the topic was written in, then the language the material itself was
    // detected as (measured across the whole document), then the text at hand.
    const materialLanguage = passages.find((p) => p.material?.language)?.material?.language ?? null;
    const lang =
      language ?? (topic ? detectLanguage(topic) : materialLanguage ?? detectLanguage(passages[0].text.slice(0, 200)));
    let generationMode = 'demo';
    let questions = [];
    let fallback = null;
    const warnings = [];

    if (provider && resolvedStyle === 'mixed') {
      try {
        // Keep the prompt bounded: multi-question quizzes need breadth, not depth.
        const contextPassages = passages.slice(0, 14).map((p, i) => ({
          id: `S${i + 1}`,
          documentName: p.documentName,
          pageNumber: p.pageNumber,
          heading: p.heading ?? null,
          text: p.text.length > 1400 ? `${p.text.slice(0, 1400)}...` : p.text,
        }));
        const idToPassage = new Map(contextPassages.map((p) => [p.id, p]));

        const response = await provider.chat({
          messages: buildQuizMessages({
            passages: contextPassages,
            questionCount: count,
            language: lang,
            topic,
          }),
          temperature: 0.4,
          maxTokens: 3000,
        });

        const parsed = parseJsonFromModel(response.content);
        const validated = parsed ? AiQuizSchema.safeParse(parsed) : null;

        if (validated?.success) {
          const kept = [];
          let dropped = 0;
          for (const raw of validated.data.questions) {
            const sourceId = raw.sourceIds.find((id) => idToPassage.has(id));
            if (!sourceId) {
              dropped += 1;
              continue;
            }
            const source = idToPassage.get(sourceId);
            kept.push({
              id: `q${kept.length + 1}`,
              prompt: raw.prompt,
              options: raw.options,
              answerIndex: raw.answerIndex,
              explanation: raw.explanation,
              topic: source.heading || source.documentName,
              source: {
                materialId: source.materialId ?? null,
                documentName: source.documentName,
                pageNumber: source.pageNumber,
                passageId: source.passageId ?? null,
              },
              generationMode: 'live',
            });
          }
          if (kept.length > 0) {
            questions = kept;
            generationMode = 'live';
            if (dropped > 0) {
              warnings.push({
                code: 'unsupported_questions_dropped',
                message: `${dropped} generated question(s) were dropped because they did not cite a passage that was actually retrieved.`,
              });
            }
          } else {
            fallback = { code: 'no_supported_questions', message: 'The model produced no question with a valid citation.' };
          }
        } else {
          fallback = {
            code: 'invalid_model_output',
            message: 'The model did not return questions in the required format.',
          };
        }
      } catch (err) {
        fallback = { code: err.code ?? 'ai_provider_error', message: err.message };
        logger.warn('quiz generation via AI failed, using local generator', {
          learnerId,
          provider: provider.id,
          code: fallback.code,
          message: err.message,
        });
      }
    }

    if (questions.length === 0) {
      const local = buildDeterministicQuiz({
        passages,
        questionCount: count,
        seedText: quizId,
        language: lang,
        style: resolvedStyle,
      });
      questions = local.questions;
      generationMode = 'demo';
      if (local.reason) {
        warnings.push({
          code: resolvedStyle === 'recall' ? 'partial_recall_set' : 'partial_quiz',
          message: local.reason,
        });
      }
    }

    if (questions.length === 0) {
      return {
        ok: false,
        code: 'insufficient_source_material',
        message:
          warnings[0]?.message ??
          'The selected material does not contain enough complete statements to build a quiz. Try another document.',
      };
    }

    const quiz = {
      id: quizId,
      learnerId,
      title: topic ? `Practice: ${topic}` : `Practice quiz (${questions.length} questions)`,
      topic: topic || null,
      materialIds: materialIds ?? [...new Set(passages.map((p) => p.materialId))],
      questions,
      generationMode,
      provider: providerInfo,
      language: lang,
      style: resolvedStyle,
      // Optional study timer (seconds). Stored so a reopened quiz keeps the same
      // limit. It is a self-study aid, not proctoring: the server never refuses
      // a late submission, and the UI states how much of the limit was used.
      timeLimitSeconds: Number.isFinite(timeLimitSeconds) && timeLimitSeconds > 0 ? Math.round(timeLimitSeconds) : null,
      createdAt: new Date().toISOString(),
    };

    await store.saveQuiz(quiz);

    return {
      ok: true,
      quiz,
      generationMode,
      fallback,
      warnings,
      provenance:
        generationMode === 'live'
          ? `${providerInfo.label} (${providerInfo.model}) wrote these questions from ${questions.length} verified passages. Every question cites a passage that was actually retrieved.`
          : 'These questions were generated locally by matching definitions in your own material. Every option is real text from your documents. No AI model was used.',
    };
  }

  /**
   * Concept-level feedback for ONE wrong answer.
   *
   * This is deliberately not a diagnosis. It reports the concept the question
   * belonged to, quotes a cited explanation from the learner's own material,
   * and offers a single follow-up question on the same concept. Where that
   * follow-up cannot be grounded, it says so and points at the passage instead
   * of inventing a cause.
   *
   * `confidence` is accepted from the learner and echoed as context only: it
   * never changes the explanation and is never treated as proof of a
   * misconception.
   */
  async function diagnose({ learnerId, quizId, questionId, confidence = null }) {
    const quiz = await store.getQuiz(quizId, learnerId);
    if (!quiz) return { ok: false, code: 'not_found', message: 'That quiz was not found.' };

    const question = quiz.questions.find((q) => q.id === questionId);
    if (!question) {
      return { ok: false, code: 'question_not_found', message: 'That question is not part of this quiz.' };
    }

    // Feedback exists only after the quiz was submitted, and only for a wrong
    // answer that was actually given. Answers and explanations are never
    // released for a question the learner has not answered.
    const attempts = await store.listAttempts(learnerId, { limit: 500 });
    const attempt = attempts.find((a) => a.quizId === quizId);
    if (!attempt) {
      return { ok: false, code: 'not_attempted', message: 'Submit this quiz before asking for gap feedback.' };
    }
    const result = (attempt.results ?? []).find((r) => r.questionId === questionId) ?? null;
    if (!result) {
      return { ok: false, code: 'question_not_found', message: 'That question was not part of the submitted attempt.' };
    }
    if (result.skipped) {
      return {
        ok: false,
        code: 'not_answered',
        message: 'This question was left blank, so there is no wrong answer to explain. Review the passage below.',
        review: question.source ?? null,
      };
    }
    if (result.correct) {
      return {
        ok: false,
        code: 'answered_correctly',
        message: 'This question was answered correctly — there is no gap to investigate.',
      };
    }

    const concept = question.topic || question.source?.documentName || 'General';

    // --- evidence on this concept, across the learner's real attempts -------
    let answersOnConcept = 0;
    let correctOnConcept = 0;
    for (const past of attempts) {
      for (const item of past.results ?? []) {
        const topic = item.topic || item.source?.documentName || 'General';
        if (topic !== concept || item.skipped) continue;
        answersOnConcept += 1;
        if (item.correct) correctOnConcept += 1;
      }
    }
    const firstRecorded = answersOnConcept <= 1;
    const basisNote = firstRecorded
      ? 'This is the first recorded answer on this concept, and a single wrong answer is not a diagnosis — it can be a misread, a guess, or a gap. The follow-up question is how to tell the difference.'
      : `You have answered ${answersOnConcept} questions on this concept and ${correctOnConcept} of them correctly. This panel explains this one miss; it is not a diagnosis of what you do or do not understand.`;

    // --- passages for the concept, from the same material as the quiz ------
    const materialIds = quiz.materialIds ?? null;
    const search = await retrieval.search({
      learnerId,
      query: concept,
      materialIds,
      topK: 8,
      // The concept is a heading or document name, so be permissive about the
      // score: any real passage is better than declaring a gap unknowable
      // because a heading matched loosely.
      minScore: Math.min(config.retrieval.minScore, 0.2),
    });
    let passages = search.supported ? search.results : [];
    if (passages.length === 0) {
      const all = await retrieval.allPassages(learnerId, materialIds);
      passages = all.filter((p) => (p.passageId ?? p.id) === question.source?.passageId);
      if (passages.length === 0) passages = all.slice(0, 3);
    }

    const review = question.source
      ? {
          materialId: question.source.materialId ?? null,
          documentName: question.source.documentName ?? null,
          pageNumber: question.source.pageNumber ?? null,
          passageId: question.source.passageId ?? null,
        }
      : null;

    // --- short cited explanation ------------------------------------------ 
    const explanation = buildGapExplanation({ passages, concept });

    // --- one follow-up diagnostic question ---------------------------------
    let diagnostic = null;
    let unsupportedReason = null;
    if (passages.length === 0) {
      unsupportedReason = 'No passage for this concept could be found in the material of this quiz, so a follow-up question cannot be grounded.';
    } else {
      const language = quiz.language ?? detectLanguage(passages[0].text.slice(0, 200));
      const built = buildDeterministicQuiz({
        passages,
        questionCount: 10,
        // Deterministic: asking again (for example after reporting confidence)
        // returns the same follow-up question.
        seedText: `gap:${quiz.id}:${question.id}`,
        language,
      });
      const candidates = (built.questions ?? []).filter(
        (candidate) => candidate.prompt !== question.prompt && candidate.options?.length >= 2,
      );
      diagnostic = candidates[0] ?? null;
      if (!diagnostic) {
        unsupportedReason =
          built.reason ??
          'Your material does not contain a second grounded question about this concept, so no follow-up can be asked without inventing one.';
      }
    }

    const supported = Boolean(explanation && diagnostic);

    return {
      ok: true,
      gap: {
        questionId,
        concept,
        status: supported ? 'supported' : 'insufficient',
        reason: supported
          ? null
          : unsupportedReason ??
            'There is not enough in your material to attach a grounded explanation to this miss, so the cause cannot be identified.',
        explanation,
        diagnostic,
        review,
        context: {
          answersOnConcept,
          correctOnConcept,
          firstRecorded,
          note: basisNote,
        },
        confidence: confidenceContext(confidence),
        disclaimer:
          'This feedback is built from your uploaded material. It explains one wrong answer and is not a diagnosis, a mastery judgement, or a measure of ability.',
      },
    };
  }

  return { generate, selectPassages, diagnose, providerInfo };
}

export default createQuizService;
