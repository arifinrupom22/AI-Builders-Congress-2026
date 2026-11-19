/**
 * Banglish / query-normalisation handling.
 *
 * Romanised Bangla function words are stripped, and known spelling variants are
 * added to the query ONLY when the corpus actually uses them. The original
 * wording is never rewritten, citation text is untouched, and no AI provider is
 * involved (this is the no-key path).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentTokens, expandQuery, detectQuestionLanguage, answerLanguage } from '../src/retrieval/tokenize.js';
import { buildAnswerMessages } from '../src/ai/prompts.js';
import { createHarness } from './helpers/harness.js';

const MECHATRONICS = `Mechatronics combines mechanical engineering, electronics and control engineering in one system.

An analogue sensor provides a continuously varying signal proportional to the measured quantity.

A closed-loop control system is a system in which the control action depends on the output.`;

test('Banglish question words are not content terms', () => {
  const terms = contentTokens('mechatronix ki');
  assert.ok(!terms.includes('ki'));
  assert.ok(terms.includes('mechatronix'));
});

test('expandQuery adds known spellings without removing the original', () => {
  const expanded = expandQuery('mechatronix ki');
  assert.ok(expanded.includes('mechatronics'));
  assert.ok(!expanded.includes('ki'));
  assert.deepEqual(expandQuery('normalization'), ['normalisation']);
});

test('retrieval finds a passage for a Banglish query and reports the expansion', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const uploaded = await h.api.upload(
    'mechatronics.txt',
    Buffer.from(MECHATRONICS, 'utf8'),
    { mimeType: 'text/plain' },
  );
  assert.equal(uploaded.status, 201);

  const search = await h.retrieval.search({ learnerId: 'test-learner', query: 'mechatronix ki' });
  assert.equal(search.supported, true);
  assert.equal(search.results[0].documentName, 'mechatronics.txt');
  assert.ok(search.queryExpansion.includes('mechatronics'));
  // Citations still quote the document as uploaded.
  assert.ok(search.results[0].text.includes('Mechatronics combines'));
});

test('an expansion is only used when the corpus contains the term', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const uploaded = await h.api.upload(
    'photosynthesis.txt',
    Buffer.from(
      'Photosynthesis is the process by which green plants convert light energy into chemical energy stored in glucose.',
      'utf8',
    ),
    { mimeType: 'text/plain' },
  );
  assert.equal(uploaded.status, 201);

  const search = await h.retrieval.search({ learnerId: 'test-learner', query: 'mechatronix' });
  assert.deepEqual(search.queryExpansion, []);
  assert.equal(search.supported, false);
});

test('a Bangla question with Banglish particles still matches Bangla notes', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const uploaded = await h.api.upload(
    'bangla-notes.txt',
    Buffer.from('সালোকসংশ্লেষণ হলো সবুজ উদ্ভিদের আলোক শক্তিকে রাসায়নিক শক্তিতে রূপান্তরের প্রক্রিয়া।', 'utf8'),
    { mimeType: 'text/plain' },
  );
  assert.equal(uploaded.status, 201);

  const search = await h.retrieval.search({ learnerId: 'test-learner', query: 'সালোকসংশ্লেষণ ki' });
  assert.equal(search.supported, true);
  assert.equal(search.results[0].documentName, 'bangla-notes.txt');
});

// ---------------------------------------------------------------------------
// Answer language for Banglish questions
// ---------------------------------------------------------------------------
//
// A Banglish question is Latin script, so it used to be detected as English and
// answered in English even when the student wrote "Bangla e bujhao".

test('a Banglish question is detected as Banglish, not English', () => {
  assert.equal(detectQuestionLanguage('photosynthesis ki vabe hoy? Bangla e bujhao'), 'banglish');
  assert.equal(detectQuestionLanguage('mechatronix ki'), 'banglish');
  // Time words alone are enough evidence: this used to be classified English.
  assert.equal(detectQuestionLanguage('Ajk nki lockdown chilo?'), 'banglish');
  assert.equal(detectQuestionLanguage('Bangladesh e ekhn ki chole?'), 'banglish');
  assert.equal(detectQuestionLanguage('sensor kemon kore kaj kore'), 'banglish');
});

test('plain English and Bangla script are unchanged', () => {
  assert.equal(detectQuestionLanguage('Explain gradient descent in simple terms'), 'en');
  assert.equal(detectQuestionLanguage('What does the sensor do?'), 'en');
  assert.equal(detectQuestionLanguage('ফটোসিন্থেসিস কীভাবে হয়?'), 'bn');
});

test('an English sentence with one loanword is not called Banglish', () => {
  assert.equal(detectQuestionLanguage('Mane is the plural of man in that sentence'), 'en');
});

test('Bangla and Banglish both get a Bangla answer', () => {
  assert.equal(answerLanguage('ফটোসিন্থেসিস কীভাবে হয়?'), 'bn');
  assert.equal(answerLanguage('photosynthesis ki vabe hoy'), 'bn');
  assert.equal(answerLanguage('how does photosynthesis work'), 'en');
});

test('the answer prompt tells the model the student wrote Banglish', () => {
  const messages = buildAnswerMessages({
    question: 'photosynthesis ki vabe hoy',
    passages: [{ id: 'S1', documentName: 'bio.pdf', pageNumber: 2, text: 'Chlorophyll absorbs light.' }],
    mode: 'simple',
    length: 'brief',
    language: 'bn',
    banglish: true,
  });
  const user = messages.find((m) => m.role === 'user').content;
  assert.match(user, /Bangla \(বাংলা\)/);
  assert.match(user, /Banglish/);
});

test('a Bangla question answered in English is detected and retried', async () => {
  const { needsBanglaRetry, banglaCharCount } = await import('../src/ai/teacher.js');

  const english = 'Photosynthesis is the process by which plants convert light into chemical energy. [S1]';
  const bangla = 'সালোকসংশ্লেষণ হলো সেই প্রক্রিয়া যাতে সবুজ উদ্ভিদ আলোক শক্তিকে রাসায়নিক শক্তিতে রূপান্তরিত করে। [S1]';
  const banglish = 'Photosynthesis holo prokriya ja te poddo light, pani theke glucose toiri kore. [S1]';

  assert.equal(banglaCharCount(english), 0);
  assert.ok(banglaCharCount(bangla) > 40);

  // Both English and romanised Bangla fail the Bangla question.
  assert.equal(needsBanglaRetry('bn', english), true);
  assert.equal(needsBanglaRetry('bn', banglish), true);
  // A real Bangla answer passes, and an English question is never retried.
  assert.equal(needsBanglaRetry('bn', bangla), false);
  assert.equal(needsBanglaRetry('en', english), false);
});
