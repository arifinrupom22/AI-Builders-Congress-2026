/**
 * Question-style tests.
 *
 * A "recall" quiz asks only what concepts from the material mean. It never
 * tops up with statement-recognition questions, because the coach uses it as
 * an easier rung on the ladder. When the material holds too few definitions
 * for the requested count, the quiz is short and says so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';

const DATABASES = `A relational database is a collection of data organised as tables with rows and columns and related by keys.

Normalisation is the process of organising tables and columns to minimise data redundancy and dependency.

An index is a data structure that speeds up the retrieval of rows at the cost of extra storage and slower writes.

A transaction is a unit of work that is either committed in full or rolled back entirely.

A foreign key is a column that references the primary key of another table and enforces referential integrity.

The primary key is a column or set of columns that uniquely identifies each row in a table.`;

async function seed(h, name, text) {
  const res = await h.api.upload(name, Buffer.from(text, 'utf8'), { mimeType: 'text/plain' });
  assert.equal(res.status, 201, `upload failed: ${JSON.stringify(res.body)}`);
  return res.body.material;
}

const DEFINITION_PROMPT = /what does .+ mean\?|what is .+\?|best defines .+/i;
const RECOGNITION_PROMPT = /actually appears in/i;

test('style: a recall quiz asks only definition questions', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const res = await h.api.post('/api/quiz/generate', { questionCount: 6, style: 'recall' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.style, 'recall');
  assert.equal(res.body.quiz.style, 'recall');
  assert.ok(res.body.quiz.questions.length >= 4);

  for (const question of res.body.quiz.questions) {
    assert.match(question.prompt, DEFINITION_PROMPT);
    assert.doesNotMatch(question.prompt, RECOGNITION_PROMPT);
    assert.equal(question.options.length, 4);
  }

  // A recall drill is built locally from definitions, and is labelled by style.
  assert.equal(res.body.generationMode, 'demo');
  assert.equal(res.body.quiz.style, 'recall');
});

test('style: a title line without a full stop is not swallowed into the first definition', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  // The heading has no terminal punctuation, so a naive sentence split fuses it
  // to the first definition and the question asks what "lecture notes
  // Photosynthesis" means.
  await seed(
    h,
    'photosynthesis.txt',
    `Photosynthesis - lecture notes

Photosynthesis is the process by which green plants convert light energy into chemical energy stored in glucose.

Chlorophyll is the green pigment inside chloroplasts that absorbs light energy for photosynthesis.

The Calvin cycle is the light-independent stage that fixes carbon dioxide into a three-carbon sugar.

Photolysis is the splitting of water by light, which releases oxygen as a by-product.`,
  );

  const res = await h.api.post('/api/quiz/generate', { questionCount: 4, style: 'recall' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.quiz.questions.length >= 4);
  for (const question of res.body.quiz.questions) {
    assert.doesNotMatch(question.prompt, /lecture notes/i);
    assert.doesNotMatch(question.prompt, /Photosynthesis\s+Photosynthesis/i);
  }
});

test('style: mixed stays the default and may include recognition questions', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const res = await h.api.post('/api/quiz/generate', { questionCount: 8 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.quiz.style, 'mixed');
  assert.equal(res.body.style, 'mixed');
});

test('style: recall never pads with recognition questions, and explains the short set', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  // Six definitions exist; asking for eight recall questions must return six,
  // not top up with statement-recognition questions.
  const res = await h.api.post('/api/quiz/generate', { questionCount: 8, style: 'recall' });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  assert.equal(res.body.quiz.questions.length, 6);
  assert.ok(res.body.quiz.questions.length < 8);
  for (const question of res.body.quiz.questions) {
    assert.match(question.prompt, DEFINITION_PROMPT);
    assert.doesNotMatch(question.prompt, RECOGNITION_PROMPT);
  }
  const partial = res.body.warnings.find((warning) => warning.code === 'partial_recall_set');
  assert.ok(partial, 'a short recall set must be explained');
  assert.match(partial.message, /nothing was invented/i);
});
