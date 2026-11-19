/**
 * The behaviour students actually judge the tutor on:
 *   - "answer it in English" re-answers the previous question instead of
 *     searching the notes for the word "english",
 *   - a question the material does not cover still gets a real answer, clearly
 *     labelled as general knowledge and with no invented citation,
 *   - two unrelated documents are not blended into one answer.
 *
 * The provider is stubbed: no network, no quota.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeacher, focusOnDominantDocument } from '../src/ai/teacher.js';
import { detectAnswerRequest } from '../src/ai/instructions.js';

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
        unknownTerms: supported ? [] : ['english', 'ans', 'ta'],
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
  };
}

function makeTeacher() {
  const calls = [];
  const provider = {
    id: 'stub',
    label: 'Stub',
    model: 'stub-1',
    async chat({ messages }) {
      calls.push(messages);
      return { content: 'An algorithm is a precise recipe for solving a problem. [S1]', providerId: 'stub' };
    },
  };
  const teacher = createTeacher({
    retrieval: stubRetrieval(),
    provider,
    config: { retrieval: { contextChars: 6000 } },
    logger: { info() {}, warn() {}, debug() {} },
  });
  return { teacher, calls };
}

test('answer instructions are detected without swallowing real questions', () => {
  const english = detectAnswerRequest('Ans ta english e bujhao');
  assert.equal(english.language, 'en');
  assert.equal(english.explicit, true);
  assert.equal(english.stripped, '');

  assert.equal(detectAnswerRequest('Banglay bujhao').language, 'bn');
  assert.equal(detectAnswerRequest('explain in English').language, 'en');

  // A content question that merely contains a language word is not an instruction.
  const content = detectAnswerRequest('What is photosynthesis in plants?');
  assert.equal(content.language, null);
});

test('"answer in English" re-answers the previous question instead of refusing', async () => {
  const { teacher, calls } = makeTeacher();

  const first = await teacher.answer({ learnerId: 'l1', question: 'What is an algorithm?' });
  assert.equal(first.kind, 'grounded');

  const followUp = await teacher.answer({
    learnerId: 'l1',
    question: 'Ans ta english e bujhao',
    previousQuestion: 'What is an algorithm?',
  });

  assert.equal(followUp.kind, 'grounded');
  const prompt = calls.at(-1).find((message) => message.role === 'user').content;
  assert.match(prompt, /What is an algorithm\?/, 'the previous question is the one being answered');
  assert.match(prompt, /Answer language: English/, 'the requested language is honoured');
});

test('a question outside the material gets a real answer labelled as general knowledge', async () => {
  const { teacher, calls } = makeTeacher();

  const result = await teacher.answer({ learnerId: 'l1', question: 'What is a hash table?' });

  assert.equal(result.kind, 'general');
  assert.equal(result.generationMode, 'live');
  assert.deepEqual(result.citations, []);
  assert.equal(result.warnings[0].code, 'answered_outside_material');
  assert.match(result.provenance, /general knowledge/i);

  const prompt = calls.at(-1).find((message) => message.role === 'user').content;
  assert.doesNotMatch(prompt, /\[S\d\]/);
});

test('without a provider the offline teacher still refuses honestly', async () => {
  const teacher = createTeacher({
    retrieval: stubRetrieval(),
    provider: null,
    config: { retrieval: { contextChars: 6000 } },
    logger: { info() {}, warn() {}, debug() {} },
  });

  const result = await teacher.answer({ learnerId: 'l1', question: 'What is a hash table?' });
  assert.equal(result.kind, 'insufficient_material');
  assert.equal(result.generationMode, 'demo');
});

test('one dominant document is not blended with an unrelated one', () => {
  const hits = [
    { materialId: 'a', documentName: 'Algorithm Lecture 1.pdf', score: 0.9 },
    { materialId: 'a', documentName: 'Algorithm Lecture 1.pdf', score: 0.8 },
    { materialId: 'b', documentName: 'photosynthesis-notes.txt', score: 0.3 },
  ];
  const focused = focusOnDominantDocument(hits);
  assert.equal(focused.results.length, 2);
  assert.equal(focused.keptDocument, 'Algorithm Lecture 1.pdf');
  assert.deepEqual(focused.dropped, ['photosynthesis-notes.txt']);

  // Comparable scores mean the two documents really are about the same question.
  const mixed = [
    { materialId: 'a', documentName: 'A.pdf', score: 0.9 },
    { materialId: 'a', documentName: 'A.pdf', score: 0.8 },
    { materialId: 'b', documentName: 'B.pdf', score: 0.85 },
  ];
  assert.equal(focusOnDominantDocument(mixed).dropped.length, 0);
});

test('an explicit English request is not answered in Bangla', async () => {
  const calls = [];
  const bangla = '\u0985\u09cd\u09af\u09be\u09b2\u0997\u09b0\u09bf\u09a6\u09ae \u09b9\u09b2\u09cb \u09a7\u09be\u09aa\u09c7 \u09a7\u09be\u09aa\u09c7 \u09a8\u09bf\u09b0\u09cd\u09a6\u09c7\u09b6\u09a8\u09be\u09b0 \u098f\u0995\u099f\u09bf \u09b8\u09c7\u099f \u09af\u09be \u09b8\u09ae\u09b8\u09cd\u09af\u09be \u09b8\u09ae\u09be\u09a7\u09be\u09a8 \u0995\u09b0\u09c7। '.repeat(6);
  const provider = {
    id: 'stub',
    label: 'Stub',
    model: 'stub-1',
    async chat({ messages }) {
      calls.push(messages);
      return { content: calls.length === 1 ? bangla : 'An algorithm is a step-by-step set of instructions. [S1]', providerId: 'stub' };
    },
  };
  const teacher = createTeacher({
    retrieval: stubRetrieval(),
    provider,
    config: { retrieval: { contextChars: 6000 } },
    logger: { info() {}, warn() {}, debug() {} },
  });

  const result = await teacher.answer({
    learnerId: 'l1',
    question: 'Explain it in English',
    previousQuestion: 'What is an algorithm?',
  });

  assert.equal(result.kind, 'grounded');
  assert.equal(calls.length, 2, 'the Bangla answer is retried once');
  assert.doesNotMatch(result.answer, /[\u0980-\u09FF]/, 'the final answer is English');
});
