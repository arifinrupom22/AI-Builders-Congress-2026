/**
 * Timed exam mode.
 *
 * The answer key must stay hidden until submission, and the timer must be
 * recorded as context only: it never changes the score, and a submission after
 * the limit is accepted (this is a study aid, not proctoring).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';

const NOTES = `A transaction is a unit of work that is either committed in full or rolled back entirely.

Atomicity means all statements in a transaction succeed or none take effect.

Isolation means concurrent transactions do not observe each other's intermediate results.

Durability means that once a transaction commits, its effects survive a crash.

A checkpoint is a point at which all dirty pages have been flushed to disk.

A rollback restores the database to the state it was in before the transaction began.

A write-ahead log records changes before they are applied so recovery can replay them.`;

async function seed(h) {
  const res = await h.api.upload('transactions.txt', Buffer.from(NOTES, 'utf8'), { mimeType: 'text/plain' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.material;
}

test('timed quiz stores a limit and never ships the answer key', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h);

  const created = await h.api.post('/api/quiz/generate', { questionCount: 3, timeLimitMinutes: 2 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.timeLimitSeconds, 120);
  assert.equal(created.body.quiz.timeLimitSeconds, 120);

  for (const question of created.body.quiz.questions) {
    assert.ok(!('answerIndex' in question));
    assert.ok(!('explanation' in question));
  }

  const reopened = await h.api.get(`/api/quiz/${created.body.quiz.id}`);
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.quiz.timeLimitSeconds, 120);
  assert.ok(!('answerIndex' in reopened.body.quiz.questions[0]));
});

test('the timer is recorded as context and does not change the score', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h);

  const created = await h.api.post('/api/quiz/generate', { questionCount: 3, timeLimitMinutes: 1 });
  const quiz = created.body.quiz;
  const stored = await h.store.getQuiz(quiz.id, 'test-learner');
  // Answer the first question correctly and skip the rest.
  const answers = stored.questions.map((question, index) => (index === 0 ? question.answerIndex : null));

  const submitted = await h.api.post(`/api/quiz/${quiz.id}/submit`, { answers, elapsedSeconds: 90 });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

  assert.deepEqual(submitted.body.timing, {
    timeLimitSeconds: 60,
    elapsedSeconds: 90,
    overLimit: true,
  });
  // One correct out of three, exactly as an untimed quiz would score it.
  assert.equal(submitted.body.score.correctCount, 1);
  assert.equal(submitted.body.score.percent, 33);
  // The answer key is released only now.
  assert.ok('correctIndex' in submitted.body.results[0]);

  const [attempt] = await h.store.listAttempts('test-learner');
  assert.equal(attempt.timeLimitSeconds, 60);
  assert.equal(attempt.elapsedSeconds, 90);
});

test('an untimed quiz has no limit, and impossible limits are rejected', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h);

  const untimed = await h.api.post('/api/quiz/generate', { questionCount: 3 });
  assert.equal(untimed.status, 201);
  assert.equal(untimed.body.quiz.timeLimitSeconds, null);

  const zero = await h.api.post('/api/quiz/generate', { questionCount: 3, timeLimitMinutes: 0 });
  assert.equal(zero.status, 400);

  const tooLong = await h.api.post('/api/quiz/generate', { questionCount: 3, timeLimitMinutes: 600 });
  assert.equal(tooLong.status, 400);
});
