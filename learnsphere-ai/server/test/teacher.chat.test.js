/**
 * Conversation behaviour of the AI Teacher.
 *
 * A student who types "Hi" is talking, not asking about the notes. Before this
 * path existed, "Hi" fell through retrieval (nothing matched) into the
 * general-knowledge prompt, which was instructed to open with "this isn't
 * covered by the files you uploaded" - a correct but robotic answer to a
 * greeting. These tests pin the split:
 *   - greetings and small talk get a real conversational reply, no warnings,
 *     no citations and no retrieval,
 *   - study questions never take the conversation path,
 *   - the general-knowledge prompt no longer asks for a disclaimer opening,
 *     because the interface already labels such answers.
 *
 * The provider is stubbed: no network, no quota.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeacher } from '../src/ai/teacher.js';
import { detectSmallTalk, isFollowUp, isTimeSensitive } from '../src/ai/instructions.js';
import {
  GENERAL_SYSTEM_PROMPT,
  buildChatFallback,
  buildAnswerMessages,
  buildGeneralMessages,
  normaliseAnswerFormat,
} from '../src/ai/prompts.js';

const passage = {
  passageId: 'p1',
  materialId: 'm1',
  documentName: 'algorithm.pdf',
  pageNumber: 3,
  heading: 'Algorithm basics',
  text: 'An algorithm is a finite sequence of instructions that solves a specific problem.',
  score: 0.9,
  matchedTerms: ['algorithm'],
};

function stubRetrieval() {
  return {
    async search({ query }) {
      const supported = /algorithm/i.test(query);
      return {
        results: supported ? [passage] : [],
        queryTerms: query.split(/\s+/).filter(Boolean),
        unknownTerms: supported ? [] : ['hash', 'table'],
        knownTerms: supported ? 1 : 0,
        vocabularyOk: supported,
        reason: supported ? null : 'too_many_unknown_terms',
        candidates: [],
        documentsSearched: 1,
        hasMaterials: true,
        searchedMaterialIds: ['m1'],
        minScore: 0.35,
        topK: 6,
        supported,
      };
    },
    async allPassages() {
      return [passage];
    },
    async listMaterials() {
      return [
        { id: 'm1', name: 'algorithm.pdf', status: 'ready' },
        { id: 'm2', name: 'photosynthesis-notes.txt', status: 'ready' },
        { id: 'm3', name: 'processing.pdf', status: 'processing' },
      ];
    },
  };
}

function makeTeacher({ withProvider = true } = {}) {
  const calls = [];
  const provider = {
    id: 'stub',
    label: 'Stub',
    model: 'stub-1',
    async chat({ messages }) {
      calls.push(messages);
      return {
        content: "Hello! I'm your AI teacher. Ask me about your notes or any topic you are studying.",
        providerId: 'stub',
      };
    },
  };
  const teacher = createTeacher({
    retrieval: stubRetrieval(),
    provider: withProvider ? provider : null,
    config: { retrieval: { contextChars: 6000 } },
    logger: { info() {}, warn() {}, debug() {} },
  });
  return { teacher, calls };
}

test('greetings and small talk are recognised as conversation, not questions', () => {
  assert.equal(detectSmallTalk('Hi'), 'greeting');
  assert.equal(detectSmallTalk('hello there'), 'greeting');
  assert.equal(detectSmallTalk('Assalamu alaikum'), 'greeting');
  assert.equal(detectSmallTalk('kemon acho?'), 'greeting');
  assert.equal(detectSmallTalk('thanks'), 'thanks');
  assert.equal(detectSmallTalk('bye'), 'farewell');
  assert.equal(detectSmallTalk('thik ache'), 'ack');
  assert.equal(detectSmallTalk('who are you'), 'about');
  assert.equal(detectSmallTalk('What can you do?'), 'about');
});

test('a statement of intent to study is understood as study, in English, Banglish and Bangla', () => {
  assert.equal(detectSmallTalk('AMi poralekha korbo'), 'study');
  assert.equal(detectSmallTalk('ami pora lekha korbo'), 'study');
  assert.equal(detectSmallTalk('study korbo'), 'study');
  assert.equal(detectSmallTalk('I will study'), 'study');
  assert.equal(detectSmallTalk('lets study'), 'study');
  assert.equal(detectSmallTalk('\u0986\u09ae\u09bf \u09aa\u09a1\u09bc\u09be\u09b2\u09c7\u0996\u09be \u0995\u09b0\u09ac'), 'study');
  // A question about the phrase itself is still a question.
  assert.equal(detectSmallTalk('what is poralekha'), null);
  assert.equal(detectSmallTalk('poralekha ki'), null);
});

test('"ami poralekha korbo" gets an instant next step, not an essay-writing lesson', async () => {
  const { teacher, calls } = makeTeacher();
  const started = Date.now();
  const result = await teacher.answer({ learnerId: 'local', question: 'AMi poralekha korbo' });

  assert.equal(result.kind, 'chat');
  assert.equal(result.generationMode, 'instant');
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.retrieval, null);
  // The bug: this sentence used to reach the model as a topic request and come
  // back as a guide to writing an essay. No model call may happen at all.
  assert.equal(calls.length, 0, 'a study-intent statement must not call the model');
  assert.ok(Date.now() - started < 250, 'the reply must be immediate');
  assert.doesNotMatch(result.answer, /\u09b0\u09c2\u09aa\u09b0\u09c7\u0996\u09be|outline|essay/i);
  // It names the ready material and leaves out the document still processing.
  assert.match(result.answer, /algorithm\.pdf/);
  assert.doesNotMatch(result.answer, /processing\.pdf/);
});

test('a Bangla or Banglish study statement is answered in Bangla script', async () => {
  const { teacher } = makeTeacher();
  for (const question of ['ami poralekha korbo', 'pora lekha korbo', 'study korbo', '\u0986\u09ae\u09bf \u09aa\u09a1\u09bc\u09be\u09b2\u09c7\u0996\u09be \u0995\u09b0\u09ac']) {
    const result = await teacher.answer({ learnerId: 'local', question });
    assert.equal(result.generationMode, 'instant');
    assert.ok((result.answer.match(/[\u0980-\u09FF]/g) ?? []).length > 20, `${question} must be answered in Bangla script`);
  }
});

test('a study question is never mistaken for small talk', () => {
  assert.equal(detectSmallTalk('Algorithm ki?'), null);
  assert.equal(detectSmallTalk('What is a hash table and how does it work?'), null);
  assert.equal(detectSmallTalk('hi, explain photosynthesis'), null);
  assert.equal(detectSmallTalk('ok so what is a linked list'), null);
  assert.equal(detectSmallTalk('explain algorithm analysis'), null);
  assert.equal(detectSmallTalk(''), null);
});

test('a greeting gets a live conversational reply with no citations and no warning', async () => {
  const { teacher, calls } = makeTeacher();
  const result = await teacher.answer({ learnerId: 'local', question: 'Hi' });

  assert.equal(result.kind, 'chat');
  assert.equal(result.generationMode, 'live');
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.retrieval, null);
  assert.match(result.answer, /hello/i);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0].content, /social message/i);
});

test('a greeting in Banglish is answered in Bangla, not in English', async () => {
  const { teacher } = makeTeacher();
  const result = await teacher.answer({ learnerId: 'local', question: 'kemon acho' });
  assert.equal(result.kind, 'chat');
  assert.match(result.provenance, /nothing was retrieved/i);
});

test('without an AI key the greeting still gets a conversational reply', async () => {
  const { teacher } = makeTeacher({ withProvider: false });
  const result = await teacher.answer({ learnerId: 'local', question: 'Hi' });
  assert.equal(result.kind, 'chat');
  assert.equal(result.generationMode, 'demo');
  assert.deepEqual(result.warnings, []);
  assert.match(result.answer, /AI teacher/);
});

test('the offline Bangla greeting is Bangla script', () => {
  const reply = buildChatFallback({ category: 'greeting', language: 'bn' });
  assert.ok((reply.match(/[\u0980-\u09FF]/g) ?? []).length > 20);
});

test('a greeting never searches the library', async () => {
  let searched = 0;
  const provider = { id: 's', label: 'S', model: 'm', async chat() { return { content: 'Hello!' }; } };
  const teacher = createTeacher({
    retrieval: {
      async search() {
        searched += 1;
        throw new Error('retrieval must not run for a greeting');
      },
      async allPassages() {
        return [];
      },
    },
    provider,
    config: { retrieval: { contextChars: 6000 } },
    logger: { info() {}, warn() {}, debug() {} },
  });

  const result = await teacher.answer({ learnerId: 'local', question: 'hello' });
  assert.equal(result.kind, 'chat');
  assert.equal(searched, 0);
});

test('follow-ups are recognised so they continue the previous topic', () => {
  for (const text of ['aro bolo', 'eta bujhlam na', 'example dao', 'why?', 'explain more', 'aro']) {
    assert.equal(isFollowUp(text), true, `${text} should be a follow-up`);
  }
  for (const text of ['what is photosynthesis', 'algorithm ki', 'explain time complexity with an example']) {
    assert.equal(isFollowUp(text), false, `${text} names its own topic`);
  }
});

test('a follow-up searches with the previous question and keeps its language', async () => {
  const queries = [];
  const provider = {
    id: 'stub',
    label: 'Stub',
    model: 'stub-1',
    async chat({ messages }) {
      queries.push(messages);
      return { content: '**Short answer** An algorithm is a finite sequence of steps.\n\n**How it works** It runs step by step [S1].' };
    },
  };
  const retrieval = stubRetrieval();
  const originalSearch = retrieval.search.bind(retrieval);
  retrieval.search = async (args) => {
    queries.push(args.query);
    return originalSearch(args);
  };
  const teacher = createTeacher({
    retrieval,
    provider,
    config: { retrieval: { contextChars: 6000 } },
    logger: { info() {}, warn() {}, debug() {} },
  });

  const result = await teacher.answer({
    learnerId: 'local',
    question: 'aro bolo',
    history: [
      { role: 'user', content: 'what is an algorithm' },
      { role: 'assistant', content: 'An algorithm is a finite sequence of steps.' },
    ],
  });

  assert.equal(result.kind, 'grounded');
  assert.ok(
    String(queries[0]).toLowerCase().includes('algorithm'),
    'the previous question must be part of the retrieval query',
  );
  const prompt = queries.find((entry) => Array.isArray(entry))[1].content;
  assert.match(prompt, /CONVERSATION SO FAR/);
  assert.match(prompt, /do not restart with a different topic/);
});

test('a Bangla answer gets Bangla headings and no stray LaTeX escapes', () => {
  const raw = '**Short answer** hash table ekta structure.\n\n**How it works** \(N\) input holey \(O(1)\).';
  const formatted = normaliseAnswerFormat(raw, 'bn');
  assert.match(formatted, /\u09b8\u0982\u0995\u09cd\u09b7\u09bf\u09aa\u09cd\u09a4 \u0989\u09a4\u09cd\u09a4\u09b0/);
  assert.doesNotMatch(formatted, /\*\*Short answer\*\*/);
  assert.doesNotMatch(formatted, /\\\(|\)\\/);
  assert.match(formatted, /\(N\)/);
  // English answers keep their English headings.
  assert.match(normaliseAnswerFormat(raw, 'en'), /\*\*Short answer\*\*/);
});

test('the grounded prompt carries the earlier turns', () => {
  const messages = buildAnswerMessages({
    question: 'aro bolo',
    passages: [{ id: 'S1', documentName: 'a.pdf', pageNumber: 1, text: passage.text }],
    mode: 'simple',
    length: 'standard',
    language: 'en',
    history: [
      { role: 'user', content: 'what is an algorithm' },
      { role: 'assistant', content: 'An algorithm is a finite sequence of steps.' },
    ],
  });
  assert.match(messages[1].content, /CONVERSATION SO FAR/);
  assert.match(messages[1].content, /Student: what is an algorithm/);
});

test('current-affairs questions are recognised as time-sensitive', () => {
  for (const text of [
    'Bangladesh e ekhn ki chole?',
    'Ajk nki lockdown chilo?',
    "Bangladesh er PM er name ki bolo toh",
    'who is the prime minister now',
    'latest news about the election',
  ]) {
    assert.equal(isTimeSensitive(text), true, `${text} depends on current information`);
  }
  for (const text of ['what is a hash table', 'photosynthesis ki vabe hoy', 'explain time complexity', 'algorithm ki']) {
    assert.equal(isTimeSensitive(text), false, `${text} is a stable study question`);
  }
});

test('a time-sensitive answer is labelled as possibly out of date, not stated as current fact', async () => {
  const { teacher } = makeTeacher();
  const result = await teacher.answer({ learnerId: 'local', question: 'Bangladesh er PM er name ki bolo toh' });
  assert.equal(result.kind, 'general');
  assert.ok(
    result.warnings.some((warning) => warning.code === 'time_sensitive_unverified'),
    'the caller must be told the information may be stale',
  );
  assert.match(result.provenance, /cannot browse|out of date/i);
});

test('the general prompt forbids present-tense claims when the question is time-sensitive', () => {
  const messages = buildGeneralMessages({
    question: 'who is the pm now',
    mode: 'simple',
    length: 'standard',
    language: 'en',
    timeSensitive: true,
    today: '2026-11-19',
  });
  const content = messages[1].content;
  assert.match(content, /CURRENT INFORMATION/);
  assert.match(content, /2026-11-19/);
  assert.match(content, /Never name any person, party or coalition as the current holder/i);
  assert.match(content, /Never invent a recent event/i);
  assert.match(content, /cannot check live information/i);

  const plain = buildGeneralMessages({ question: 'what is a hash table', mode: 'simple', length: 'standard', language: 'en' });
  assert.doesNotMatch(plain[1].content, /CURRENT INFORMATION/);
});

test('zero-width characters from copied Bangla text are removed', () => {
  const formatted = normaliseAnswerFormat('\u09b6\u200c\u09c7\u0996 \u09b9\u09be\u09b8\u09bf\u09a8\u09be', 'bn');
  assert.doesNotMatch(formatted, /[\u200B-\u200D\uFEFF]/);
});

test('the general-knowledge prompt no longer asks for a disclaimer opening', () => {
  assert.doesNotMatch(GENERAL_SYSTEM_PROMPT, /Open with one short, calm line/);
  assert.match(GENERAL_SYSTEM_PROMPT, /Do not open with a disclaimer/);
  assert.match(GENERAL_SYSTEM_PROMPT, /Never invent a citation/);
});
