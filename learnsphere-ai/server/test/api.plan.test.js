/**
 * Study-plan tests.
 *
 * The properties that matter: topics are mapped to real passages with page
 * evidence, "needs practice" comes from recorded answers rather than a guess,
 * unmatched topics are reported as gaps instead of being scheduled, tasks can be
 * completed/paused and survive a refresh, edits rebuild the schedule, and one
 * learner's plan is invisible to another.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';

const TRANSACTIONS = `# Transaction handling

A transaction is a unit of work that is either committed in full or rolled back entirely.

Atomicity means all statements in a transaction succeed or none take effect.

Isolation means concurrent transactions do not observe each other's intermediate results.

Durability means that once a transaction commits, its effects survive a crash.

A checkpoint is a point at which all dirty pages have been flushed to disk.

A rollback restores the database to the state it was in before the transaction began.

A write-ahead log records changes before they are applied so recovery can replay them.`;

const RELATIONAL = `# Relational database

A relational database stores data in tables made of rows and columns.

A primary key is a column or set of columns that uniquely identifies each row.

A foreign key is a column that references the primary key of another table.

Normalisation is the process of organising columns to reduce redundancy and dependency.

An index is a data structure that speeds up row retrieval at the cost of extra storage.

A join combines rows from two tables using a related column.`;

const iso = (offsetDays) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
};

async function seed(h, name, text, learnerId) {
  const res = await h.api.upload(name, Buffer.from(text, 'utf8'), { mimeType: 'text/plain', learnerId });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.material;
}

/** Generate a quiz over one document and answer `correctCount` correctly. */
async function attempt(h, materialId, correctCount, learnerId = 'test-learner') {
  const generated = await h.api.post('/api/quiz/generate', { questionCount: 3, materialIds: [materialId] }, learnerId);
  assert.equal(generated.status, 201, JSON.stringify(generated.body));
  const quiz = generated.body.quiz;
  const stored = await h.store.getQuiz(quiz.id, learnerId);
  const answers = stored.questions.map((question, index) =>
    index < correctCount ? question.answerIndex : (question.answerIndex + 1) % question.options.length,
  );
  const submitted = await h.api.post(`/api/quiz/${quiz.id}/submit`, { answers }, learnerId);
  assert.equal(submitted.status, 200);
  return { quiz, submitted };
}

function createPlan(h, body, learnerId = 'test-learner') {
  return h.api.post(
    '/api/plan',
    {
      syllabus: 'Transaction handling\nRelational database\nQuantum entanglement',
      examDate: iso(14),
      minutesPerDay: 40,
      daysPerWeek: 7,
      language: 'en',
      ...body,
    },
    learnerId,
  );
}

test('plan: maps syllabus topics to cited passages and reports gaps', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const transactions = await seed(h, 'transactions.txt', TRANSACTIONS);
  await seed(h, 'relational.txt', RELATIONAL);
  // Recorded weakness on one topic only.
  await attempt(h, transactions.id, 0);

  const res = await createPlan(h);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { plan } = res.body;

  const byTitle = Object.fromEntries(plan.topics.map((topic) => [topic.title, topic]));
  assert.equal(byTitle['Transaction handling'].status, 'needs_practice');
  assert.match(byTitle['Transaction handling'].why, /answered 0 of 3 questions correctly/);
  assert.equal(byTitle['Relational database'].status, 'covered');
  assert.equal(byTitle['Quantum entanglement'].status, 'not_found');
  assert.deepEqual(byTitle['Quantum entanglement'].citations, []);

  // Evidence is a real document and page, never invented.
  const citation = byTitle['Transaction handling'].citations[0];
  assert.equal(citation.documentName, 'transactions.txt');
  assert.equal(citation.pageNumber, 1);
  assert.match(citation.passageId, /[0-9a-z-]+/i);

  // Unmatched topics are listed as gaps and never scheduled as study tasks.
  assert.equal(plan.gaps.length, 1);
  assert.equal(plan.gaps[0].title, 'Quantum entanglement');
  const scheduledTopics = plan.days.flatMap((day) => day.tasks.map((task) => task.topic));
  assert.ok(scheduledTopics.length > 0);
  assert.ok(!scheduledTopics.includes('Quantum entanglement'));

  // A day holds a study task and a practice task with real links.
  const firstDay = plan.days[0];
  assert.ok(firstDay.tasks.some((task) => task.kind === 'study'));
  const practice = firstDay.tasks.find((task) => task.kind === 'practice');
  assert.ok(practice, 'expected a practice task');
  assert.match(practice.href, /^\/quiz\?topic=.*style=recall/);

  assert.match(plan.disclaimer, /does not predict exam results/);
  assert.ok(!('grade' in plan) && !('predictedScore' in plan));
  assert.ok(plan.summary.topicCount === 3);
  // 15 days from today through the exam date, seven days a week.
  assert.equal(plan.days.length, 15);
});

test('plan: a later weak attempt changes coverage after refresh, and done tasks are kept', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const relational = await seed(h, 'relational.txt', RELATIONAL);
  const res = await createPlan(h, {
    syllabus: 'Relational database',
    examDate: iso(6),
    daysPerWeek: 7,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const plan = res.body.plan;
  assert.equal(plan.topics[0].status, 'covered');

  const firstTask = plan.days[0].tasks[0];
  const done = await h.api.patch(`/api/plan/${plan.id}/tasks/${firstTask.id}`, { status: 'done' });
  assert.equal(done.status, 200);
  assert.equal(done.body.task.status, 'done');

  // New evidence arrives through the existing quiz flow.
  await attempt(h, relational.id, 0);

  const refreshed = await h.api.post(`/api/plan/${plan.id}/refresh`, {});
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.plan.topics[0].status, 'needs_practice');
  assert.match(refreshed.body.plan.topics[0].why, /answered/i);

  // The completed task survived, with the same stable id.
  const tasks = refreshed.body.plan.days.flatMap((day) => day.tasks);
  assert.equal(tasks.find((task) => task.id === firstTask.id)?.status, 'done');
  assert.equal(refreshed.body.plan.summary.doneTasks, 1);
});

test('plan: tasks can be paused and the schedule can be edited', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'transactions.txt', TRANSACTIONS);

  const created = await createPlan(h, { syllabus: 'Transaction handling', examDate: iso(4), daysPerWeek: 7 });
  const plan = created.body.plan;
  const practice = plan.days[0].tasks.find((task) => task.kind === 'practice');

  const paused = await h.api.patch(`/api/plan/${plan.id}/tasks/${practice.id}`, { status: 'paused' });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.task.status, 'paused');

  const edited = await h.api.patch(`/api/plan/${plan.id}`, {
    minutesPerDay: 120,
    daysPerWeek: 3,
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.plan.minutesPerDay, 120);
  assert.equal(edited.body.plan.daysPerWeek, 3);
  const study = edited.body.plan.days[0].tasks.find((task) => task.kind === 'study');
  assert.equal(study.minutes, 72);
  // Pausing is the student's decision and is not silently undone by an edit.
  const stillPaused = edited.body.plan.days
    .flatMap((day) => day.tasks)
    .find((task) => task.id === practice.id);
  assert.equal(stillPaused?.status, 'paused');
});

test('plan: validation rejects impossible schedules', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'transactions.txt', TRANSACTIONS);

  const past = await createPlan(h, { examDate: iso(-1) });
  assert.equal(past.status, 400);
  assert.match(past.body.error.message, /past/);

  const badDate = await createPlan(h, { examDate: '2026-02-31' });
  assert.equal(badDate.status, 400);

  const tooFar = await createPlan(h, { examDate: iso(500) });
  assert.equal(tooFar.status, 400);

  const empty = await createPlan(h, { syllabus: '' });
  assert.equal(empty.status, 400);

  const many = await createPlan(h, {
    syllabus: Array.from({ length: 61 }, (_, i) => `Topic ${i + 1} about something specific`).join('\n'),
  });
  assert.equal(many.status, 201);
  assert.equal(many.body.plan.topics.length, 60);
});

test('plan: plans stay inside the learner profile', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'transactions.txt', TRANSACTIONS);

  const mine = await createPlan(h);
  assert.equal(mine.status, 201);
  const planId = mine.body.plan.id;

  const foreignGet = await h.api.get(`/api/plan/${planId}`, 'someone-else');
  assert.equal(foreignGet.status, 404);
  const foreignPatch = await h.api.patch(`/api/plan/${planId}`, { minutesPerDay: 30 }, 'someone-else');
  assert.equal(foreignPatch.status, 404);
  const foreignList = await h.api.get('/api/plan', 'someone-else');
  assert.deepEqual(foreignList.body.plans, []);

  const list = await h.api.get('/api/plan');
  assert.equal(list.body.plans.length, 1);
  assert.equal(list.body.plans[0].id, planId);

  const today = await h.api.get('/api/plan/today');
  assert.equal(today.status, 200);
  assert.equal(today.body.today.planId, planId);

  const removed = await h.api.del(`/api/plan/${planId}`);
  assert.equal(removed.status, 200);
  assert.equal((await h.api.get(`/api/plan/${planId}`)).status, 404);
});
