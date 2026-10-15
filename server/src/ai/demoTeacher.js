/**
 * Offline demo teacher.
 *
 * This is the guarantee that LearnSphere AI is useful with NO external AI at
 * all: a deterministic, fully local teacher built on extractive question
 * answering over the student's own retrieved passages.
 *
 * It is extractive on purpose. It selects and repro-orders real sentences from
 * the student's documents and cites each one. It therefore cannot hallucinate
 * content, invent a page number, or claim something the material does not say -
 * which makes it a genuinely trustworthy fallback rather than a placeholder,
 * and a fixed baseline the AI mode can be compared against.
 *
 * The answer explicitly states that no AI model was used.
 */
import { contentTokens, splitSentences } from './extractive-utils.js';
import { screenPassage } from './grounding.js';

const LABELS = {
  en: {
    direct: 'Direct answer',
    material: 'From your material',
    general: 'General explanation',
    check: 'Check yourself',
    nothingElse: 'Nothing beyond your material is needed here.',
    practiceNote:
      'These are practice prompts generated from your own material. They are **not** official examination questions.',
    howToStudy: 'What to revise',
    provisional: 'Local extractive answer: selected and quoted directly from your own material. No AI model was used.',
    notEnough: 'Your material does not appear to cover this.',
    step: 'Step',
  },
  bn: {
    direct: 'সরাসরি উত্তর',
    material: 'আপনার উপকরণ থেকে',
    general: 'সাধারণ ব্যাখ্যা',
    check: 'নিজে যাচাই করুন',
    nothingElse: 'আপনার উপকরণের বাইরে কিছু যোগ করার প্রয়োজন নেই।',
    practiceNote: 'এগুলো আপনার নিজের উপকরণ থেকে তৈরি অনুশীলন প্রশ্ন। এগুলো **সরকারি পরীক্ষার প্রশ্ন নয়**।',
    howToStudy: 'যা রিভিশন দিতে হবে',
    provisional: 'স্থানীয় extractive উত্তর: আপনার উপকরণ থেকে সরাসরি নির্বাচিত ও উদ্ধৃত। কোনো AI মডেল ব্যবহার করা হয়নি।',
    notEnough: 'আপনার উপকরণে এই বিষয়টি নেই বলে মনে হচ্ছে।',
    step: 'ধাপ',
  },
};

const LENGTH_TARGET = { brief: 2, standard: 4, detailed: 7 };

/**
 * Score sentences by rarity-weighted overlap with the question.
 * Rarity is estimated from the retrieved passages, so no index is required.
 */
function rankSentences(question, passages) {
  const queryTokens = [...new Set(contentTokens(question))];
  const P = Math.max(1, passages.length);

  const df = new Map();
  const perPassage = passages.map((p) => {
    const sentences = splitSentences(p.text).filter((s) => s.length >= 30);
    const seen = new Set();
    for (const s of sentences) for (const t of new Set(contentTokens(s))) seen.add(t);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
    return sentences;
  });

  const rarity = (token) => Math.log(1 + P / (1 + (df.get(token) ?? 0)));

  const scored = [];
  let skippedAsInstruction = 0;
  perPassage.forEach((sentences, passageIndex) => {
    const passage = passages[passageIndex];
    sentences.forEach((sentence, sentenceIndex) => {
      // An extractive teacher quotes text verbatim, so it must apply the same
      // injection screen the AI path is instructed to follow. Without this, a
      // document containing "ignore all previous instructions" would have that
      // line repeated back to the student as study content.
      if (screenPassage(sentence).suspicious) {
        skippedAsInstruction += 1;
        return;
      }
      const tokens = new Set(contentTokens(sentence));
      let weight = 0;
      const matched = [];
      for (const token of queryTokens) {
        if (tokens.has(token)) {
          weight += rarity(token);
          matched.push(token);
        }
      }
      // Normalise by length so a long paragraph does not automatically win, and
      // reward earlier sentences slightly: material usually introduces a term
      // before elaborating on it.
      const lengthPenalty = 1 + Math.log(1 + sentence.length / 90);
      const positionBonus = 1 + Math.max(0, 0.25 - sentenceIndex * 0.03);
      const score = (weight / lengthPenalty) * positionBonus;
      scored.push({
        text: sentence.trim(),
        passage,
        sentenceIndex,
        queryOverlap: matched,
        score: Number(score.toFixed(6)),
      });
    });
  });

  scored.sort((a, b) => b.score - a.score);

  // Order the pool so sentences that actually contain the question's terms come
  // first, then the remaining sentences from the same passages. Without the
  // second group, "detailed" answers could not be longer than "brief" ones
  // whenever only a couple of sentences happened to mention the exact term.
  // `scored` is already sorted by score, so filtering preserves ranking.
  const matchedFirst = [
    ...scored.filter((s) => s.queryOverlap.length > 0),
    ...scored.filter((s) => s.queryOverlap.length === 0),
  ];

  const deduped = [];
  const seen = new Set();
  for (const candidate of matchedFirst) {
    const key = candidate.text.slice(0, 90).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return { candidates: deduped, queryTokens, skippedAsInstruction };
}

function cite(sentence) {
  return `[${sentence.passage.id}]`;
}

function keyTerm(candidates, queryTokens) {
  const text = candidates[0]?.text ?? '';
  const tokens = contentTokens(text);
  const fromQuery = tokens.find((t) => queryTokens.includes(t));
  return fromQuery ?? tokens.sort((a, b) => b.length - a.length)[0] ?? 'this topic';
}

/**
 * @param {{question:string, passages:object[], mode:string, length:string, language:'en'|'bn'}} input
 * @returns {{markdown:string, mode:'demo', picked:object[]}}
 */
export function buildDemoAnswer({ question, passages, mode, length, language }) {
  const L = LABELS[language] ?? LABELS.en;
  const { candidates, queryTokens, skippedAsInstruction } = rankSentences(question, passages);
  const target = LENGTH_TARGET[length] ?? LENGTH_TARGET.standard;
  const picked = candidates.slice(0, Math.max(2, Math.min(target, candidates.length)));
  const top = picked.length > 0 ? picked : [];

  if (top.length === 0) {
    return {
      mode: 'demo',
      picked: [],
      skippedAsInstruction,
      markdown: `**${L.direct}**\n${L.notEnough}\n\n**${L.material}**\nThe passages retrieved for this question contain no complete sentences to quote.\n\n**${L.general}**\n${L.nothingElse}\n\n_${L.provisional}_`,
    };
  }

  const sources = [...new Set(top.map((s) => `${s.passage.documentName} p.${s.passage.pageNumber}`))];
  const direct = top[0];

  let body;
  if (mode === 'step_by_step') {
    body = top.map((s, i) => `${i + 1}. ${s.text} ${cite(s)}`).join('\n');
  } else if (mode === 'key_points') {
    body = top.map((s) => `- ${s.text} ${cite(s)}`).join('\n');
  } else if (mode === 'exam_prep') {
    body = [
      `**${L.howToStudy}**`,
      top.map((s, i) => `${i + 1}. ${s.text} ${cite(s)}`).join('\n'),
      '',
      L.practiceNote,
    ].join('\n');
  } else if (mode === 'summary') {
    // The lead sentence is already shown as the direct answer, so summarise
    // with the supporting material to avoid repeating ourselves.
    const supporting = top.slice(1, 3);
    body = supporting.length > 0
      ? supporting.map((s) => `${s.text} ${cite(s)}`).join(' ')
      : `The material states this directly on ${direct.passage.documentName} page ${direct.passage.pageNumber}. ${cite(direct)}`;
  } else {
    // simple: lead with the most relevant sentence, then support it.
    body = [direct.text + ' ' + cite(direct)].concat(
      top.slice(1).map((s) => `In other words: ${s.text} ${cite(s)}`),
    ).join('\n\n');
  }

  const term = keyTerm(top, queryTokens);
  const answerSentence = top[1] ?? top[0];
  const check = `**${L.check}**\nIn your own words, what does the material say about **${term}**? Answer from memory, then compare with ${answerSentence.passage.documentName} page ${answerSentence.passage.pageNumber}. ${cite(answerSentence)}`;

  const markdown = [
    `**${L.direct}**`,
    `${direct.text} ${cite(direct)}`,
    '',
    `**${L.material}**`,
    body,
    '',
    `**${L.general}**`,
    `${L.nothingElse} _(Sources: ${sources.join('; ')}.)_`,
    '',
    check,
    '',
    `_${L.provisional}_`,
  ].join('\n');

  return { mode: 'demo', picked: top, skippedAsInstruction, markdown };
}

/** Honest message for a question the uploaded material genuinely does not cover. */
export function buildInsufficientAnswer({ language, queryTerms = [], unknownTerms = [], availableTopics = [], reason = null }) {
  const L = LABELS[language] ?? LABELS.en;
  const termList = queryTerms.slice(0, 8).join(', ');
  // Naming the words the material has never seen is what turns a refusal into
  // something the student can act on.
  const unknownList = unknownTerms.slice(0, 8).join(', ');
  const topics = availableTopics.slice(0, 6);

  const lines = [
    `**${L.direct}**`,
    language === 'bn'
      ? 'আপনার আপলোড করা উপকরণে এই প্রশ্নের উত্তর নেই।'
      : 'Your uploaded material does not cover this question.',
    '',
    `**${L.material}**`,
    queryTerms.length > 0
      ? `I searched your material for: ${termList}. None of the retrieved passages contained enough of these terms to answer reliably, and I will not guess.`
      : 'No passage in your material matched this question closely enough to answer reliably.',
    reason === 'too_many_unknown_terms' && unknownList
      ? `\nYour material never uses these words: ${unknownList}. That is why the question looks like it is about a different subject.`
      : '',
    topics.length > 0
      ? `\nYour material does appear to cover:\n${topics.map((t) => `- ${t}`).join('\n')}`
      : '',
    '',
    `**${L.general}**`,
    'Add the relevant chapter, lecture slides or notes to your library and ask again, or rephrase the question using wording that appears in your documents.',
    '',
    `_${L.provisional}_`,
  ];

  return lines.filter(Boolean).join('\n');
}

/** Honest message for a student with an empty library. */
export function buildNoMaterialsAnswer({ language }) {
  const bn = language === 'bn';
  return [
    `**${bn ? 'সরাসরি উত্তর' : 'Direct answer'}**`,
    bn
      ? 'আপনার লাইব্রেরিতে এখনো কোনো উপকরণ নেই, তাই উত্তর দেওয়ার মতো কিছু নেই।'
      : 'Your library is empty, so there is nothing for me to teach from yet.',
    '',
    `**${bn ? 'আপনার উপকরণ থেকে' : 'From your material'}**`,
    bn
      ? 'PDF বা TXT ফাইল আপলোড করুন (My Materials)। তারপর আমি আপনার নিজের নোট থেকে উদ্ধৃতি দিয়ে উত্তর দেব।'
      : 'Upload a PDF or TXT file from **My Materials**. Every answer after that will quote your own notes and cite the file and page it came from.',
    '',
    `**${bn ? 'সাধারণ ব্যাখ্যা' : 'General explanation'}**`,
    bn
      ? 'আমি কোনো তথ্য বানিয়ে বলি না, তাই উপকরণ ছাড়া বিষয়ভিত্তিক উত্তর দিই না।'
      : 'I do not invent content and I do not answer from a topic you have not given me, which is why there is nothing to explain yet.',
    '',
    `_${LABELS[language]?.provisional ?? LABELS.en.provisional}_`,
  ].join('\n');
}

export default buildDemoAnswer;
