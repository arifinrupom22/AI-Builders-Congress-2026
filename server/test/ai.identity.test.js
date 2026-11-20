/**
 * AI Teacher identity.
 *
 * The upstream models answer "who are you?" from their own identity unless the
 * tutor persona holds. These tests pin both halves of the fix: the wording that
 * is detected and rewritten, and the cases that must be left alone (a study
 * answer that legitimately names a model or a company).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDENTITY_LINE,
  findIdentityClaims,
  hasIdentityLeak,
  sanitizeIdentityAnswer,
} from '../src/ai/identity.js';
import { detectSmallTalk } from '../src/ai/instructions.js';
import { CONVERSATION_SYSTEM_PROMPT, GENERAL_SYSTEM_PROMPT, TUTOR_SYSTEM_PROMPT } from '../src/ai/prompts.js';
import { createTeacher } from '../src/ai/teacher.js';

test('a vendor self-identification is detected', () => {
  const samples = [
    'I am ChatGPT, an AI language model created by OpenAI.',
    "I'm an AI language model, so I cannot browse the web.",
    'As an AI language model, I cannot help with that.',
    'I was trained by OpenAI and my knowledge has a cutoff.',
    'My creators at OpenAI gave me this name.',
    "I'm GPT-4, made by OpenAI.",
  ];
  for (const sample of samples) {
    assert.equal(hasIdentityLeak(sample), true, sample);
  }
});

test('a study answer that names a model as a topic is not a self-claim', () => {
  const samples = [
    'OpenAI released GPT-4 in 2023, and it is a large language model.',
    'ChatGPT is a chatbot made by OpenAI that many students use.',
    'A language model predicts the next token from its training data.',
  ];
  for (const sample of samples) {
    assert.equal(hasIdentityLeak(sample), false, sample);
  }
});

test('the rewritten answer speaks as the LearnSphere AI teacher, in the answer language', () => {
  const english = sanitizeIdentityAnswer('I am ChatGPT, an AI language model created by OpenAI.', 'en');
  assert.equal(english.rewritten, true);
  assert.ok(english.text.includes('LearnSphere AI'));
  assert.ok(!/chatgpt|openai/i.test(english.text), english.text);

  const bangla = sanitizeIdentityAnswer('I am ChatGPT, an AI language model created by OpenAI.', 'bn');
  assert.equal(bangla.text, IDENTITY_LINE.bn);

  // Surrounding content survives.
  const mixed = sanitizeIdentityAnswer(
    'I am ChatGPT, an AI language model created by OpenAI.\n\nAn algorithm is a finite sequence of steps [S1].',
    'en',
  );
  assert.ok(mixed.text.includes('An algorithm is a finite sequence of steps [S1].'));
  assert.ok(mixed.text.startsWith('LearnSphere AI') || mixed.text.startsWith("I'm the LearnSphere"));
});

test('the tutor, general and conversation prompts forbid another identity', () => {
  for (const prompt of [TUTOR_SYSTEM_PROMPT, GENERAL_SYSTEM_PROMPT, CONVERSATION_SYSTEM_PROMPT]) {
    assert.ok(/LearnSphere AI/.test(prompt));
    assert.ok(/not ChatGPT/i.test(prompt), 'the prompt names the products it is not');
  }
  assert.ok(/ANSWER THE WHOLE MESSAGE/i.test(TUTOR_SYSTEM_PROMPT));
  assert.ok(/ANSWER THE WHOLE MESSAGE/i.test(GENERAL_SYSTEM_PROMPT));
});

test('"who r u" and its variants take the identity path, not retrieval', () => {
  const questions = [
    'Who r u',
    'who are u?',
    'Who are you',
    "what's your name",
    'which model are you',
    'are you chatgpt',
    'who made you',
    'what can you help me with',
    'tumi ke',
    'tomar nam ki',
    'tomake ke banaise',
  ];
  for (const question of questions) {
    assert.equal(detectSmallTalk(question), 'about', question);
  }
});

test('a vendor identity never reaches the student, even from a model that insists', async () => {
  const leak = 'I am ChatGPT, an AI language model created by OpenAI. I can help you study.';
  let calls = 0;
  const provider = {
    id: 'stub',
    label: 'Stub',
    model: 'stub-1',
    async chat() {
      calls += 1;
      return { content: leak, providerId: 'stub' };
    },
  };
  const retrieval = {
    async search() {
      return {
        results: [],
        queryTerms: [],
        unknownTerms: [],
        knownTerms: 0,
        vocabularyOk: true,
        reason: null,
        candidates: [],
        documentsSearched: 0,
        hasMaterials: false,
        searchedMaterialIds: [],
        minScore: 0.35,
        topK: 6,
        supported: false,
      };
    },
    async allPassages() {
      return [];
    },
    async listMaterials() {
      return [];
    },
  };
  const teacher = createTeacher({
    retrieval,
    provider,
    config: { retrieval: { contextChars: 6000 }, limits: { maxChatMessagesPerSession: 200 } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });

  const result = await teacher.answer({ learnerId: 'learner-1', question: 'Who r u' });
  assert.equal(result.kind, 'chat');
  assert.ok(!/chatgpt|openai/i.test(result.answer), result.answer);
  assert.ok(/LearnSphere AI/.test(result.answer));
  // One retry with the identity directive, then the deterministic rewrite.
  assert.equal(calls, 2);
});
