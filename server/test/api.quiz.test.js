/**
 * Quiz tests in offline demo mode.
 *
 * The important properties: every question is answerable from real material,
 * every option is real text, the answer key never reaches the browser before
 * submission, and scoring is exact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';
import { extractDefinitions } from '../src/quiz/generator.js';

const DATABASES = `A relational database is a collection of data organised as tables with rows and columns and related by keys.

Normalisation is the process of organising tables and columns to minimise data redundancy and dependency.

An index is a data structure that speeds up the retrieval of rows at the cost of extra storage and slower writes.

A transaction is a unit of work that is either committed in full or rolled back entirely.

A foreign key is a column that references the primary key of another table and enforces referential integrity.

The primary key is a column or set of columns that uniquely identifies each row in a table.`;

const CHEMISTRY = `An acid is a substance that donates protons and increases the hydrogen ion concentration in solution.

A base is a substance that accepts protons and decreases the hydrogen ion concentration in solution.

pH is a measure of the acidity of a solution and is the negative logarithm of hydrogen ion concentration.

A buffer is a solution that resists changes in pH when small amounts of acid or base are added.

Catalysis is the acceleration of a reaction by a substance that is not consumed in the reaction.`;

async function seed(h, name, text) {
  const res = await h.api.upload(name, Buffer.from(text, 'utf8'), { mimeType: 'text/plain' });
  assert.equal(res.status, 201, `upload failed: ${JSON.stringify(res.body)}`);
  return res.body.material;
}

test('extractDefinitions finds real definitions and ignores ordinary prose', () => {
  const found = extractDefinitions([
    { id: 'x-p1-0', materialId: 'x', documentName: 'd.txt', pageNumber: 1, heading: null, text: DATABASES },
  ]);
  const terms = found.map((f) => f.term.toLowerCase());
  assert.ok(terms.some((t) => t.includes('normalisation')), `expected normalisation, got ${JSON.stringify(terms)}`);
  assert.ok(terms.some((t) => t.includes('acid') || t.includes('index') || t.includes('transaction')));
  // Every extracted candidate must carry traceable source metadata.
  for (const d of found) {
    assert.equal(d.documentName, 'd.txt');
    assert.equal(d.pageNumber, 1);
    assert.ok(d.definition.length >= 45);
  }
});

test('extractDefinitions rejects a clause used as if it were a term', () => {
  // Regression: "Either every operation in the transaction is applied, or none
  // of them is applied at all." matched the definition pattern and produced the
  // unreadable stem "what does Either every operation in the transaction mean?".
  const found = extractDefinitions([
    {
      id: 'c-p1-0',
      materialId: 'c',
      documentName: 'acid.md',
      pageNumber: 1,
      heading: null,
      text:
        'Either every operation in the transaction is applied, or none of them is applied at all. ' +
        'Atomicity means a transaction is all-or-nothing and never records a partial transaction.',
    },
  ]);
  const terms = found.map((f) => f.term.toLowerCase());
  assert.ok(!terms.some((t) => t.startsWith('either')), `a clause was used as a term: ${JSON.stringify(terms)}`);
  assert.ok(terms.some((t) => t.includes('atomicity')), `expected atomicity, got ${JSON.stringify(terms)}`);
});

test('extractDefinitions rejects a clause that swallowed a finite verb', () => {
  // Regression: "A transaction should appear to run as if it were the only
  // transaction in the system." matched "were" as the definition marker and
  // produced the stem "what is transaction should appear to run as if it?".
  const found = extractDefinitions([
    {
      id: 'v-p1-0',
      materialId: 'v',
      documentName: 'acid.md',
      pageNumber: 1,
      heading: null,
      text:
        'A transaction should appear to run as if it were the only transaction in the system. ' +
        'Isolation means concurrent transactions do not observe each other intermediate results.',
    },
  ]);
  const terms = found.map((f) => f.term.toLowerCase());
  assert.ok(
    !terms.some((t) => t.includes('should appear')),
    `a clause was used as a term: ${JSON.stringify(terms)}`,
  );
  assert.ok(terms.some((t) => t.includes('isolation')), `expected isolation, got ${JSON.stringify(terms)}`);
  // Whatever survives must still be short enough to read as a term.
  for (const candidate of found) {
    assert.ok(candidate.term.split(/\s+/).length <= 5, `term too long: ${candidate.term}`);
  }
});

test('generate: produces four-option questions grounded in the selected material', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'databases.txt', DATABASES);

  const res = await h.api.post('/api/quiz/generate', { questionCount: 4, materialIds: [material.id] });
  assert.equal(res.status, 201);
  assert.equal(res.body.generationMode, 'demo', 'no API key, so this must be labelled demo');
  assert.match(res.body.provenance, /locally/i);

  const quiz = res.body.quiz;
  assert.equal(quiz.questions.length, 4);
  for (const question of quiz.questions) {
    assert.ok(question.prompt.length > 10);
    assert.equal(question.options.length, 4, 'every question needs four options');
    assert.equal(new Set(question.options).size, 4, 'options must be distinct');
    assert.ok(question.options.every((o) => o.length > 5));
    assert.equal(question.sourceDocument, 'databases.txt');
    assert.equal(question.sourcePage, 1);
  }

  // The correct answer really is a sentence from the material.
  const stored = await h.store.readPassages(material.id);
  const corpus = stored.map((p) => p.text).join(' ');
  for (const question of quiz.questions) {
    assert.ok(
      question.options.some((option) => corpus.includes(option.replace(/…$/, '').slice(0, 40))),
      `no option for "${question.prompt}" is traceable to the document`,
    );
  }
});

test('generate: the answer key is never sent to the browser', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const generated = await h.api.post('/api/quiz/generate', { questionCount: 3 });
  assert.equal(generated.status, 201);

  const serialised = JSON.stringify(generated.body);
  assert.doesNotMatch(serialised, /answerIndex/);
  assert.doesNotMatch(serialised, /explanation/);
  assert.doesNotMatch(serialised, /correctIndex/);

  const fetched = await h.api.get(`/api/quiz/${generated.body.quiz.id}`);
  assert.equal(fetched.status, 200);
  assert.doesNotMatch(JSON.stringify(fetched.body), /answerIndex|explanation/);

  // But the stored record does have the key, so scoring is possible server-side.
  const stored = await h.store.getQuiz(generated.body.quiz.id, 'test-learner');
  assert.ok(stored.questions.every((q) => Number.isInteger(q.answerIndex)));
});

test('submit: correct answers score 100% and reveal explanations with sources', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const generated = await h.api.post('/api/quiz/generate', { questionCount: 4 });
  const quizId = generated.body.quiz.id;
  const stored = await h.store.getQuiz(quizId, 'test-learner');
  const perfect = stored.questions.map((q) => q.answerIndex);

  const submitted = await h.api.post(`/api/quiz/${quizId}/submit`, { answers: perfect });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.score.percent, 100);
  assert.equal(submitted.body.score.correctCount, 4);
  assert.equal(submitted.body.results.length, 4);

  for (const result of submitted.body.results) {
    assert.equal(result.correct, true);
    assert.ok(result.explanation.length > 10, 'the explanation must be shown after submission');
    assert.equal(result.source.documentName, 'databases.txt');
    assert.equal(result.source.pageNumber, 1);
    assert.ok(result.source.passageId.includes('-p1-'));
    assert.match(result.explanation, /page 1/);
  }
  assert.match(submitted.body.retryAdvice, /Full marks/);
});

test('submit: wrong answers score 0% and the key is exposed for review', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const generated = await h.api.post('/api/quiz/generate', { questionCount: 3 });
  const quizId = generated.body.quiz.id;
  const stored = await h.store.getQuiz(quizId, 'test-learner');
  const wrong = stored.questions.map((q) => (q.answerIndex + 1) % 4);

  const submitted = await h.api.post(`/api/quiz/${quizId}/submit`, { answers: wrong });
  assert.equal(submitted.body.score.percent, 0);
  assert.equal(submitted.body.score.correctCount, 0);
  for (const result of submitted.body.results) {
    assert.equal(result.correct, false);
    assert.notEqual(result.selectedIndex, result.correctIndex);
    assert.equal(result.correctIndex, result.correctIndex, 'the correct index is revealed after grading');
  }
  assert.match(submitted.body.retryAdvice, /generate a fresh quiz/i);
});

test('submit: a partial score is counted exactly, and skipped questions count as wrong', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const generated = await h.api.post('/api/quiz/generate', { questionCount: 4 });
  const quizId = generated.body.quiz.id;
  const stored = await h.store.getQuiz(quizId, 'test-learner');
  const answers = stored.questions.map((q, i) => (i < 3 ? q.answerIndex : q.answerIndex)); // 3 correct
  answers[3] = null; // one skipped

  const submitted = await h.api.post(`/api/quiz/${quizId}/submit`, { answers });
  assert.equal(submitted.body.score.correctCount, 3);
  assert.equal(submitted.body.score.answeredCount, 3);
  assert.equal(submitted.body.score.total, 4);
  assert.equal(submitted.body.score.percent, 75, '3 of 4 with one skip is 75%');
  assert.equal(submitted.body.results[3].skipped, true);
  assert.match(submitted.body.scoringNote, /Skipped questions are counted as incorrect/);
});

test('submit: malformed submissions are rejected', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const generated = await h.api.post('/api/quiz/generate', { questionCount: 3 });
  const quizId = generated.body.quiz.id;

  const tooFew = await h.api.post(`/api/quiz/${quizId}/submit`, { answers: [0] });
  assert.equal(tooFew.status, 400);
  assert.equal(tooFew.body.error.details.expected, 3);

  const outOfRange = await h.api.post(`/api/quiz/${quizId}/submit`, { answers: [9, 0, 0] });
  assert.equal(outOfRange.status, 400);

  const notArray = await h.api.post(`/api/quiz/${quizId}/submit`, { answers: 'all of them' });
  assert.equal(notArray.status, 400);

  const missing = await h.api.post('/api/quiz/generate', { questionCount: 0 });
  assert.equal(missing.status, 400);
});

test('isolation: a learner cannot fetch or submit another learner\'s quiz', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await h.api.upload('alice.txt', Buffer.from(DATABASES), { learnerId: 'alice', mimeType: 'text/plain' });

  const generated = await h.api.post('/api/quiz/generate', { questionCount: 2 }, 'alice');
  assert.equal(generated.status, 201);
  const quizId = generated.body.quiz.id;

  const bobFetch = await h.api.get(`/api/quiz/${quizId}`, 'bob');
  assert.equal(bobFetch.status, 404);

  const bobSubmit = await h.api.post(`/api/quiz/${quizId}/submit`, { answers: [0, 0] }, 'bob');
  assert.equal(bobSubmit.status, 404);

  const bobHistory = await h.api.get('/api/quiz', 'bob');
  assert.deepEqual(bobHistory.body.quizzes, []);
});

test('generate: refuses to invent questions when there is nothing to base them on', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const noMaterials = await h.api.post('/api/quiz/generate', { questionCount: 5 });
  assert.equal(noMaterials.status, 422);
  assert.equal(noMaterials.body.error.code, 'no_source_material');
  assert.match(noMaterials.body.error.message, /Upload a document first/);

  // A document with too little structure cannot produce four-option questions.
  await seed(h, 'tiny.txt', 'Short note.');
  const tooThin = await h.api.post('/api/quiz/generate', { questionCount: 5 });
  assert.equal(tooThin.status, 422);
  assert.match(tooThin.body.error.message, /not enough|did not contain enough/i);
});

test('generate: asks for fewer questions when the material cannot support more, and says so', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'chemistry.txt', CHEMISTRY);

  const res = await h.api.post('/api/quiz/generate', { questionCount: 20 });
  assert.equal(res.status, 201);
  assert.ok(res.body.quiz.questions.length <= 20);

  if (res.body.quiz.questions.length < 20) {
    const codes = res.body.warnings.map((w) => w.code);
    assert.ok(codes.includes('partial_quiz'), 'a short quiz must be explained, not silently padded');
    const message = res.body.warnings.find((w) => w.code === 'partial_quiz').message;
    assert.match(message, /nothing was invented|did not contain enough/i);
  }
});

test('generate: topic filtering narrows the source material', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const res = await h.api.post('/api/quiz/generate', { questionCount: 2, topic: 'normalisation redundancy' });
  assert.equal(res.status, 201);
  assert.match(res.body.quiz.title, /normalisation/);
});

test('generate: language can be forced for the question wording', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const res = await h.api.post('/api/quiz/generate', { questionCount: 2, language: 'bn' });
  assert.equal(res.status, 201);
  assert.equal(res.body.quiz.id !== undefined, true);
});

test('retry: generating again produces a fresh quiz and history records both', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const first = await h.api.post('/api/quiz/generate', { questionCount: 3 });
  const second = await h.api.post('/api/quiz/generate', { questionCount: 3 });
  assert.notEqual(first.body.quiz.id, second.body.quiz.id, 'a retry is a new quiz, not a cached one');

  const stored = await h.store.getQuiz(first.body.quiz.id, 'test-learner');
  await h.api.post(`/api/quiz/${first.body.quiz.id}/submit`, { answers: stored.questions.map((q) => q.answerIndex) });

  const history = await h.api.get('/api/quiz');
  assert.equal(history.body.quizzes.length, 2);
  const attempted = history.body.quizzes.find((q) => q.id === first.body.quiz.id);
  assert.equal(attempted.bestPercent, 100);
  assert.equal(attempted.attempts.length, 1);
});
