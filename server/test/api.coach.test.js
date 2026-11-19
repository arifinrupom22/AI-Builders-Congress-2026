/**
 * Adaptive Exam Coach tests.
 *
 * The properties that matter: the coach starts with a baseline when evidence is
 * thin, chooses a topic and a supported style from recorded results and says
 * why, builds the plan from real practice/materials/review data, shows actual
 * attempt scores with a retest, never touches the review schedule, and never
 * claims mastery or progress.
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

/** Generate a quiz (optionally scoped) and answer it with a chosen mix. */
async function attempt(h, { materialIds = null, correctCount = 0 } = {}) {
  const generated = await h.api.post('/api/quiz/generate', {
    questionCount: 4,
    ...(materialIds ? { materialIds } : {}),
  });
  assert.equal(generated.status, 201, JSON.stringify(generated.body));
  const quiz = generated.body.quiz;
  const stored = await h.store.getQuiz(quiz.id, 'test-learner');
  const answers = stored.questions.map((question, index) =>
    index < correctCount ? question.answerIndex : (question.answerIndex + 1) % question.options.length,
  );
  const submitted = await h.api.post(`/api/quiz/${quiz.id}/submit`, { answers });
  assert.equal(submitted.status, 200);
  return { quiz, stored, submitted };
}

test('coach: with no practice recorded it starts with a baseline and says so', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const res = await h.api.get('/api/coach/plan');
  assert.equal(res.status, 200);
  const plan = res.body;

  assert.equal(plan.mode, 'baseline');
  assert.equal(plan.hasEnoughData, false);
  assert.equal(plan.recommendation.baseline, true);
  assert.equal(plan.recommendation.style, 'mixed');
  assert.match(plan.recommendation.href, /^\/quiz\?style=mixed$/);
  assert.match(plan.recommendation.reason, /baseline/i);
  assert.match(plan.recommendation.reason, /not a test of ability/);
  assert.equal(plan.recommendation.questions, 5);

  assert.equal(plan.nextSteps[0].kind, 'practice');
  assert.match(plan.nextSteps[0].href, /^\/quiz\?/);
  assert.deepEqual(plan.recentAttempts, []);
  assert.ok(plan.retest, 'a retest is always offered from the recommendation');
  assert.match(plan.retest.label, /Retest/);

  assert.match(plan.disclaimer, /does not predict scores, measure ability, or claim mastery or learning gain/);
  assert.doesNotMatch(JSON.stringify(plan.recommendation), /mastered/i);
});

test('coach: weak recorded accuracy moves the learner to basic recall, with the reason', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const databases = await seed(h, 'databases.txt', DATABASES);

  await attempt(h, { correctCount: 1 });

  const plan = (await h.api.get('/api/coach/plan')).body;
  assert.equal(plan.mode, 'adaptive');
  assert.equal(plan.hasEnoughData, true);
  assert.equal(plan.recommendation.baseline, false);
  assert.equal(plan.recommendation.topic, 'databases.txt');
  assert.equal(plan.recommendation.style, 'recall');
  assert.equal(plan.recommendation.styleLabel, 'Basic recall');
  assert.match(plan.recommendation.href, /topic=databases\.txt/);
  assert.match(plan.recommendation.href, /style=recall/);
  // The drill is scoped to the document the concept was recorded from, so the
  // suggestion cannot drift into another upload — and the id must be the
  // material that still exists, not a stale record with the same name.
  const scope = new URL(plan.recommendation.href, 'http://localhost').searchParams.get('materials');
  assert.equal(scope, databases.id);
  assert.match(plan.recommendation.reason, /1 of 4 questions correctly/);
  assert.match(plan.recommendation.reason, /basic recall/);
  assert.equal(plan.recommendation.evidence.answersOnConcept, 4);
  assert.equal(plan.recommendation.evidence.correctOnConcept, 1);
  assert.equal(plan.recommendation.evidence.accuracy, 25);
});

test('coach: solid recorded recall moves the learner up to mixed question types', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  await attempt(h, { correctCount: 4 });

  const plan = (await h.api.get('/api/coach/plan')).body;
  assert.equal(plan.mode, 'adaptive');
  assert.equal(plan.recommendation.style, 'mixed');
  assert.equal(plan.recommendation.styleLabel, 'Mixed question types');
  assert.match(plan.recommendation.href, /style=mixed/);
  assert.match(plan.recommendation.reason, /mixed question types/);
  assert.match(plan.recommendation.reason, /4 of 4 questions correctly/);
});

test('coach: next steps use practice, unpractised material and the existing review queue', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const databases = await seed(h, 'databases.txt', DATABASES);
  const chemistry = await seed(h, 'chemistry.txt', CHEMISTRY);

  // Practise only the databases document, so chemistry stays unpractised.
  await attempt(h, { materialIds: [databases.id], correctCount: 1 });

  // A deck on the practised document, with one real rating: the schedule now exists.
  const deckRes = await h.api.post('/api/flashcards/generate', { cardCount: 3, materialIds: [databases.id] });
  assert.equal(deckRes.status, 201, JSON.stringify(deckRes.body));
  const deck = deckRes.body.deck;
  await h.api.post(`/api/flashcards/${deck.id}/review`, {
    results: [{ cardId: deck.cards[0].id, grade: 'again' }],
  });
  const dueBefore = (await h.api.get('/api/flashcards/due?summary=1')).body;

  const plan = (await h.api.get('/api/coach/plan')).body;

  const materialStep = plan.nextSteps.find((step) => step.kind === 'material');
  assert.ok(materialStep, 'an unpractised document must appear in the plan');
  assert.match(materialStep.title, /chemistry\.txt/);
  assert.equal(materialStep.materialId, chemistry.id);
  assert.match(materialStep.href, new RegExp(`/materials\\?id=${chemistry.id}`));

  const reviewStep = plan.nextSteps.find((step) => step.kind === 'review');
  assert.ok(reviewStep, 'the existing review queue must appear in the plan');
  assert.equal(reviewStep.href, '/review');
  assert.equal(reviewStep.meta, 'existing schedule');
  assert.deepEqual(plan.review.counts, dueBefore.counts);

  // Reading the plan must not create, move or duplicate any review date.
  const dueAfter = (await h.api.get('/api/flashcards/due?summary=1')).body;
  assert.deepEqual(dueAfter, dueBefore);
  const storedDeck = await h.store.getDeck(deck.id, 'test-learner');
  assert.equal(storedDeck.cards[0].stats.reviews, 1, 'the coach adds no ratings');
  assert.ok(plan.nextSteps.length <= 4);
});

test('coach: recent attempts show real scores, and the retest points at the same choice', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  await attempt(h, { correctCount: 1 });
  await attempt(h, { correctCount: 3 });

  const stored = await h.store.listAttempts('test-learner', { limit: 10 });
  const plan = (await h.api.get('/api/coach/plan')).body;

  assert.equal(plan.recentAttempts.length, 2);
  const percents = plan.recentAttempts.map((attempt) => attempt.percent).sort((a, b) => a - b);
  const storedPercents = stored.map((attempt) => attempt.percent).sort((a, b) => a - b);
  assert.deepEqual(percents, storedPercents, 'scores must be the actual recorded attempts');
  for (const entry of plan.recentAttempts) {
    assert.ok(entry.correctCount >= 0 && entry.correctCount <= entry.total);
    assert.ok(entry.quizId);
  }

  assert.match(plan.retest.label, /Retest/);
  assert.equal(plan.retest.style, plan.recommendation.style);
  assert.equal(plan.retest.href, plan.recommendation.href);
});

test('coach: plans stay inside the learner profile', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);
  await attempt(h, { correctCount: 1 });

  const mine = (await h.api.get('/api/coach/plan')).body;
  assert.equal(mine.mode, 'adaptive');
  assert.ok(mine.recentAttempts.length > 0);

  const other = (await h.api.get('/api/coach/plan', 'learner-b')).body;
  assert.deepEqual(other.recentAttempts, []);
  assert.equal(other.totals.questionsAnswered, 0);
  assert.equal(other.mode, 'no-material');
  assert.equal(other.recommendation, null);
  // With nothing to study, the coach proposes no practice rather than inventing one.
  assert.equal(other.nextSteps.some((step) => step.kind === 'practice'), false);
});
