/**
 * Progress tests. The point of these is honesty: with no data the API must say
 * so, and with data it must report only what was actually recorded.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';

const DATABASES = `A relational database is a collection of data organised as tables with rows and columns and related by keys.

Normalisation is the process of organising tables and columns to minimise data redundancy and dependency.

An index is a data structure that speeds up the retrieval of rows at the cost of extra storage and slower writes.

A transaction is a unit of work that is either committed in full or rolled back entirely.

A foreign key is a column that references the primary key of another table and enforces referential integrity.`;

async function seed(h, learnerId, name, text) {
  const res = await h.api.upload(name, Buffer.from(text, 'utf8'), { learnerId, mimeType: 'text/plain' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.material;
}

async function takeQuiz(h, learnerId, { questionCount = 4, correctAnswers = null } = {}) {
  const generated = await h.api.post('/api/quiz/generate', { questionCount }, learnerId);
  assert.equal(generated.status, 201, JSON.stringify(generated.body));
  const quizId = generated.body.quiz.id;
  const stored = await h.store.getQuiz(quizId, learnerId);

  const answers =
    correctAnswers === null
      ? stored.questions.map((q) => q.answerIndex)
      : stored.questions.map((q, i) => (i < correctAnswers ? q.answerIndex : (q.answerIndex + 1) % 4));

  const submitted = await h.api.post(`/api/quiz/${quizId}/submit`, { answers }, learnerId);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  return submitted.body;
}

test('progress: a brand new learner gets empty data, not invented statistics', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const res = await h.api.get('/api/progress');
  assert.equal(res.status, 200);
  assert.equal(res.body.totals.materials, 0);
  assert.equal(res.body.totals.quizzesAttempted, 0);
  assert.equal(res.body.totals.questionsAnswered, 0);
  assert.equal(res.body.totals.overallAccuracy, null, 'no attempts means no accuracy, not 0%');
  assert.equal(res.body.hasActivity, false);
  assert.deepEqual(res.body.topics, []);
  assert.deepEqual(res.body.weakestTopics, []);
  assert.equal(res.body.streakDays, 0);
  assert.equal(res.body.activity.length, 14, 'a 14-day window is always returned');

  // The disclaimer must explicitly refuse to claim mastery.
  assert.match(res.body.disclaimer, /does not measure mastery/i);
});

test('progress: activity reflects real uploads, sessions and attempts', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  await seed(h, 'test-learner', 'databases.txt', DATABASES);
  await h.api.post('/api/chat', { question: 'What is normalisation?' });
  await takeQuiz(h, 'test-learner', { questionCount: 4 });

  const res = await h.api.get('/api/progress');
  assert.equal(res.body.totals.materials, 1);
  assert.equal(res.body.totals.readyMaterials, 1);
  assert.equal(res.body.totals.sessions, 1);
  assert.equal(res.body.totals.quizzesAttempted, 1);
  assert.equal(res.body.totals.questionsAnswered, 4);
  assert.equal(res.body.totals.questionsCorrect, 4);
  assert.equal(res.body.totals.overallAccuracy, 100);
  assert.equal(res.body.hasActivity, true);
  assert.equal(res.body.streakDays, 1);

  const today = res.body.activity.at(-1);
  assert.equal(today.quizzes, 1);
  assert.equal(today.sessions, 1);
  assert.equal(today.uploads, 1);
  assert.ok(res.body.recentAttempts.length === 1);
  assert.equal(res.body.recentAttempts[0].percent, 100);
});

test('progress: accuracy is computed only from questions actually answered', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'test-learner', 'databases.txt', DATABASES);

  await takeQuiz(h, 'test-learner', { questionCount: 4, correctAnswers: 2 });

  const res = await h.api.get('/api/progress');
  assert.equal(res.body.totals.questionsAnswered, 4);
  assert.equal(res.body.totals.questionsCorrect, 2);
  assert.equal(res.body.totals.overallAccuracy, 50);
});

test('courses: topics are derived from the documents actually practised', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'test-learner', 'databases.txt', DATABASES);

  await takeQuiz(h, 'test-learner', { questionCount: 4 });
  const res = await h.api.get('/api/progress');

  assert.ok(res.body.topics.length >= 1);
  for (const topic of res.body.topics) {
    assert.equal(topic.total > 0, true);
    assert.ok(topic.accuracy >= 0 && topic.accuracy <= 100);
    assert.ok(Array.isArray(topic.documents));
    assert.ok(topic.documents.includes('databases.txt'));
  }
});

test('revision: suggests weak topics only once there is evidence, with an honest caveat', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'test-learner', 'databases.txt', DATABASES);

  const empty = await h.api.get('/api/progress/revision');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.hasEnoughData, false);
  assert.deepEqual(empty.body.weakTopics, []);
  assert.equal(empty.body.unpractisedMaterials.length, 1, 'the untouched document is surfaced as a suggestion');
  assert.match(empty.body.disclaimer, /not a diagnosis|does not mean/i);

  await takeQuiz(h, 'test-learner', { questionCount: 4, correctAnswers: 0 });

  const afterFailure = await h.api.get('/api/progress/revision');
  assert.equal(afterFailure.body.hasEnoughData, true);
  assert.ok(afterFailure.body.weakTopics.length >= 1, 'a 0% attempt must produce a revision suggestion');
  for (const topic of afterFailure.body.weakTopics) {
    assert.ok(topic.total >= 2, 'a single question is not enough to call a topic weak');
    assert.match(topic.reason, /You answered \d+ of \d+ questions correctly/);
    assert.match(topic.suggestedAction, /Generate a practice quiz/);
  }
  assert.equal(afterFailure.body.unpractisedMaterials.length, 0, 'the document has now been practised');
});

test('progress: a strong attempt does not appear in weakestTopics', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'test-learner', 'databases.txt', DATABASES);

  await takeQuiz(h, 'test-learner', { questionCount: 4, correctAnswers: 4 });
  const res = await h.api.get('/api/progress');

  assert.ok(res.body.strongestTopics.length >= 1);
  assert.equal(res.body.strongestTopics[0].accuracy, 100);
  assert.deepEqual(res.body.weakestTopics, [], 'nothing under 100% was recorded, so nothing is weak');
});

test('progress: learners are isolated from each other', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  await seed(h, 'alice', 'alice-db.txt', DATABASES);
  await takeQuiz(h, 'alice', { questionCount: 3 });

  const bob = await h.api.get('/api/progress', 'bob');
  assert.equal(bob.body.totals.materials, 0);
  assert.equal(bob.body.totals.quizzesAttempted, 0);
  assert.equal(bob.body.hasActivity, false);

  const alice = await h.api.get('/api/progress', 'alice');
  assert.equal(alice.body.totals.quizzesAttempted, 1);
  assert.equal(alice.body.totals.materials, 1);
});

test('progress: the disclaimer is always present and refuses to overclaim', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const res = await h.api.get('/api/progress');
  assert.match(res.body.disclaimer, /makes no claim about academic results/i);
});
