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
import { contentTokens, expandQuery } from '../src/retrieval/tokenize.js';
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
