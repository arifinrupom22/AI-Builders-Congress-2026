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
    for (const raw of splitSentences(passage.text)) {
      const sentence = raw.replace(/\s+/g, ' ').trim();
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
export function buildDeterministicQuiz({ passages, questionCount, seedText, language = 'en' }) {
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

  // Top up with sentence-recognition questions if definitions ran out.
  if (questions.length < questionCount) {
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

  async function generate({ learnerId, materialIds = null, topic = '', questionCount, language = null }) {
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

    if (provider) {
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
      const local = buildDeterministicQuiz({ passages, questionCount: count, seedText: quizId, language: lang });
      questions = local.questions;
      generationMode = 'demo';
      if (local.reason) warnings.push({ code: 'partial_quiz', message: local.reason });
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

  return { generate, selectPassages, providerInfo };
}

export default createQuizService;
