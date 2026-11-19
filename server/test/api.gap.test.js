/**
 * Knowledge Gap Detective tests.
 *
 * The properties that matter: feedback exists only for a wrong answer that was
 * actually given, the explanation and follow-up question are grounded in real
 * passages, one miss is never presented as a diagnosis, confidence is echoed as
 * context and changes nothing, thin evidence is admitted, and no learner can
 * read another learner's quiz.
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

async function seed(h, name, text, learnerId) {
  const res = await h.api.upload(name, Buffer.from(text, 'utf8'), {
    mimeType: 'text/plain',
    ...(learnerId ? { learnerId } : {}),
  });
  assert.equal(res.status, 201, `upload failed: ${JSON.stringify(res.body)}`);
  return res.body.material;
}

async function generateQuiz(h, learnerId) {
  const generated = await h.api.post('/api/quiz/generate', { questionCount: 4 }, learnerId);
  assert.equal(generated.status, 201, JSON.stringify(generated.body));
  return generated.body.quiz;
}

function answersFor(stored, pick) {
  return stored.questions.map((question, index) => {
    const choice = pick(question, index);
    return choice === null ? null : choice;
  });
}

const wrongAnswer = (question) => (question.answerIndex + 1) % question.options.length;

test('gap: a wrong answer gets a cited concept explanation and one grounded follow-up', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const quiz = await generateQuiz(h);
  const stored = await h.store.getQuiz(quiz.id, 'test-learner');
  const target = stored.questions[0];

  const submitted = await h.api.post(`/api/quiz/${quiz.id}/submit`, {
    answers: answersFor(stored, wrongAnswer),
  });
  assert.equal(submitted.status, 200);
  const result = submitted.body.results.find((item) => item.questionId === target.id);
  assert.equal(result.correct, false);

  const res = await h.api.post(`/api/quiz/${quiz.id}/gap`, { questionId: target.id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const gap = res.body.gap;

  assert.equal(gap.status, 'supported');
  assert.equal(gap.reason, null);
  assert.equal(gap.concept, target.topic);
  assert.equal(gap.questionId, target.id);

  // The explanation is a real quote from the material, with a citation.
  assert.ok(gap.explanation.text.length > 30);
  assert.equal(gap.explanation.source.documentName, 'databases.txt');
  assert.ok(gap.explanation.source.pageNumber >= 1);
  assert.ok(gap.explanation.source.materialId);
  const sourcePassage = Object.values(stored.questions)
    .find((q) => q.source.documentName === gap.explanation.source.documentName)?.source;
  assert.ok(sourcePassage);

  // One follow-up question, different from the one that was missed, with real options.
  assert.ok(gap.diagnostic, 'a supported gap needs a follow-up question');
  assert.notEqual(gap.diagnostic.prompt, target.prompt);
  assert.equal(gap.diagnostic.options.length, 4);
  assert.equal(new Set(gap.diagnostic.options).size, 4);
  assert.ok(Number.isInteger(gap.diagnostic.answerIndex));
  assert.ok(gap.diagnostic.answerIndex >= 0 && gap.diagnostic.answerIndex < 4);
  assert.equal(gap.diagnostic.source.documentName, 'databases.txt');

  // Evidence on the concept is reported, and one miss is explicitly not a diagnosis.
  assert.equal(gap.context.answersOnConcept, 4);
  assert.equal(gap.context.firstRecorded, false);
  assert.match(gap.context.note, /not a diagnosis/);
  assert.match(gap.context.note, /4 questions/);

  assert.equal(gap.review.documentName, target.source.documentName);
  assert.ok(gap.review.pageNumber >= 1);
  assert.match(gap.disclaimer, /not a diagnosis, a mastery judgement, or a measure of ability/);
});

test('gap: a lone wrong answer says so instead of diagnosing', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const generated = await h.api.post('/api/quiz/generate', { questionCount: 1 });
  assert.equal(generated.status, 201, JSON.stringify(generated.body));
  const quiz = generated.body.quiz;
  const stored = await h.store.getQuiz(quiz.id, 'test-learner');
  const target = stored.questions[0];

  const submitted = await h.api.post(`/api/quiz/${quiz.id}/submit`, {
    answers: answersFor(stored, wrongAnswer),
  });
  assert.equal(submitted.status, 200);

  const gap = (await h.api.post(`/api/quiz/${quiz.id}/gap`, { questionId: target.id })).body.gap;
  assert.equal(gap.context.answersOnConcept, 1);
  assert.equal(gap.context.firstRecorded, true);
  assert.match(gap.context.note, /first recorded answer on this concept/);
  assert.match(gap.context.note, /single wrong answer is not a diagnosis/);
});

test('gap: confidence is echoed as context and changes nothing', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const quiz = await generateQuiz(h);
  const stored = await h.store.getQuiz(quiz.id, 'test-learner');
  const target = stored.questions[0];
  await h.api.post(`/api/quiz/${quiz.id}/submit`, { answers: answersFor(stored, wrongAnswer) });

  const plain = (await h.api.post(`/api/quiz/${quiz.id}/gap`, { questionId: target.id })).body.gap;
  const guessed = (
    await h.api.post(`/api/quiz/${quiz.id}/gap`, { questionId: target.id, confidence: 'guessed' })
  ).body.gap;

  assert.equal(guessed.confidence.level, 'guessed');
  assert.match(guessed.confidence.note, /supporting context only/);
  assert.match(guessed.confidence.note, /not proof of a misconception/);

  // The confidence report must not alter the feedback itself.
  assert.deepEqual(guessed.explanation, plain.explanation);
  assert.deepEqual(guessed.diagnostic, plain.diagnostic);
  assert.equal(guessed.status, plain.status);
  assert.equal(guessed.context.note, plain.context.note);

  assert.equal(plain.confidence.level, null);
  assert.match(plain.confidence.note, /optional/);
});

test('gap: no feedback without a wrong answer, and no answers leaked early', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const quiz = await generateQuiz(h);
  const stored = await h.store.getQuiz(quiz.id, 'test-learner');

  // Before submitting, the endpoint refuses rather than revealing the key.
  const early = await h.api.post(`/api/quiz/${quiz.id}/gap`, { questionId: stored.questions[0].id });
  assert.equal(early.status, 400);
  assert.equal(early.body.error.details.code, 'not_attempted');
  assert.doesNotMatch(JSON.stringify(early.body), /answerIndex|correctIndex/);

  // Submit with one right, one wrong, one blank.
  const answers = answersFor(stored, (question, index) =>
    index === 0 ? question.answerIndex : index === 1 ? wrongAnswer(question) : null,
  );
  await h.api.post(`/api/quiz/${quiz.id}/submit`, { answers });

  const correct = await h.api.post(`/api/quiz/${quiz.id}/gap`, { questionId: stored.questions[0].id });
  assert.equal(correct.status, 400);
  assert.equal(correct.body.error.details.code, 'answered_correctly');

  const blank = await h.api.post(`/api/quiz/${quiz.id}/gap`, { questionId: stored.questions[2].id });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.error.details.code, 'not_answered');

  const unknown = await h.api.post(`/api/quiz/${quiz.id}/gap`, { questionId: 'q99' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.details.code, 'question_not_found');
});

test('gap: another learner cannot read this quiz or its attempt', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES, 'learner-a');

  const quiz = await generateQuiz(h, 'learner-a');
  const stored = await h.store.getQuiz(quiz.id, 'learner-a');
  const target = stored.questions[0];
  await h.api.post('/api/quiz/' + quiz.id + '/submit', { answers: answersFor(stored, wrongAnswer) }, 'learner-a');

  const mine = await h.api.post(`/api/quiz/${quiz.id}/gap`, { questionId: target.id }, 'learner-a');
  assert.equal(mine.status, 200);

  const theirs = await h.api.post(`/api/quiz/${quiz.id}/gap`, { questionId: target.id }, 'learner-b');
  assert.equal(theirs.status, 404);
  assert.equal(theirs.body.error.code, 'not_found');
});

test('gap: with no material left to ground it, the passage is offered instead of a cause', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'databases.txt', DATABASES);

  const quiz = await generateQuiz(h);
  const stored = await h.store.getQuiz(quiz.id, 'test-learner');
  const target = stored.questions[0];
  await h.api.post(`/api/quiz/${quiz.id}/submit`, { answers: answersFor(stored, wrongAnswer) });

  // The learner deletes the document after the attempt: the recorded attempt
  // still exists, but there is no passage left to ground a follow-up in.
  const removed = await h.api.del(`/api/materials/${material.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  const res = await h.api.post(`/api/quiz/${quiz.id}/gap`, { questionId: target.id });
  assert.equal(res.status, 200);
  const gap = res.body.gap;

  assert.equal(gap.status, 'insufficient');
  assert.equal(gap.diagnostic, null);
  assert.match(gap.reason, /cannot be grounded/);
  // The citation the question already carried is still offered for review.
  assert.equal(gap.review.documentName, 'databases.txt');
  assert.ok(gap.review.pageNumber >= 1);
});
