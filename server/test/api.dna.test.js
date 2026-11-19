/**
 * Learning DNA tests.
 *
 * The properties that matter: the profile is a count of real recorded activity,
 * accuracy comes only from quiz attempts (never from self-rated flashcards),
 * thin evidence says "not enough practice data yet" instead of guessing, two
 * learners never share evidence, and nothing is ever labelled mastered.
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

/** Generate a quiz and submit an exact mix of right and wrong answers. */
async function attemptQuiz(h, { correctCount, wrongCount, learnerId } = {}) {
  const generated = await h.api.post('/api/quiz/generate', { questionCount: 4 }, learnerId);
  assert.equal(generated.status, 201, JSON.stringify(generated.body));
  const quizId = generated.body.quiz.id;
  const owner = learnerId ?? 'test-learner';
  const stored = await h.store.getQuiz(quizId, owner);
  const answers = stored.questions.map((question, index) =>
    index < correctCount ? question.answerIndex : (question.answerIndex + 1) % question.options.length,
  );
  const submitted = await h.api.post(`/api/quiz/${quizId}/submit`, { answers }, learnerId);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  return submitted;
}

test('dna: a learner with no recorded activity gets an empty, honest profile', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const res = await h.api.get('/api/dna');
  assert.equal(res.status, 200);
  const profile = res.body;

  assert.equal(profile.hasEnoughData, false);
  assert.deepEqual(profile.concepts, []);
  assert.equal(profile.totals.questionsAnswered, 0);
  assert.equal(profile.totals.overallAccuracy, null);
  assert.equal(profile.totals.ratings, 0);
  assert.equal(profile.insufficientDataLabel, 'not enough practice data yet');
  assert.match(profile.disclaimer, /not a measure of ability, mastery, or learning gain/);
});

test('dna: quiz attempts yield real accuracy per concept, and a practice signal', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'databases.txt', DATABASES);

  await attemptQuiz(h, { correctCount: 2, wrongCount: 2 });

  const res = await h.api.get('/api/dna');
  const profile = res.body;

  assert.equal(profile.hasEnoughData, true);
  assert.equal(profile.totals.quizzesAttempted, 1);
  assert.equal(profile.totals.questionsAnswered, 4);
  assert.equal(profile.totals.questionsCorrect, 2);
  assert.equal(profile.totals.overallAccuracy, 50);

  const concept = profile.concepts.find((c) => c.concept === 'databases.txt');
  assert.ok(concept, `expected a databases.txt concept, got ${JSON.stringify(profile.concepts.map((c) => c.concept))}`);
  assert.equal(concept.quiz.quizzes, 1);
  assert.equal(concept.quiz.answered, 4);
  assert.equal(concept.quiz.correct, 2);
  assert.equal(concept.quiz.accuracy, 50);
  assert.equal(concept.flashcards.ratings, 0, 'quiz evidence must not be inflated into card ratings');

  assert.equal(concept.morePractice.state, 'suggested');
  assert.equal(concept.morePractice.suggested, true);
  assert.match(concept.morePractice.reason, /2 of 4/);

  // Source links come from the passages the questions were drawn from.
  assert.ok(concept.documents.length > 0);
  assert.equal(concept.documents[0].materialId, material.id);
  assert.equal(concept.documents[0].documentName, 'databases.txt');
  assert.ok(concept.documents[0].pages.includes(1));
});

test('dna: one answered question is "not enough practice data yet", not a verdict', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const generated = await h.api.post('/api/quiz/generate', { questionCount: 2 });
  const quizId = generated.body.quiz.id;
  const stored = await h.store.getQuiz(quizId, 'test-learner');
  // One answered, one skipped: exactly one piece of evidence.
  const answers = [stored.questions[0].answerIndex, null];
  const submitted = await h.api.post(`/api/quiz/${quizId}/submit`, { answers });
  assert.equal(submitted.status, 200);

  const profile = (await h.api.get('/api/dna')).body;
  assert.equal(profile.hasEnoughData, false);
  assert.equal(profile.totals.questionsAnswered, 1);
  assert.equal(profile.totals.questionsSkipped, 1);

  const concept = profile.concepts[0];
  assert.equal(concept.evidenceCount, 1, 'a skipped question is recorded, but is not evidence');
  assert.equal(concept.quiz.skipped, 1);
  assert.equal(concept.morePractice.state, 'not-enough-data');
  assert.equal(concept.morePractice.suggested, null);
  assert.match(concept.morePractice.reason, /not enough practice data yet/);
  assert.match(concept.morePractice.reason, /1 quiz question answered/);
});

test('dna: flashcard ratings are reported as ratings, never as accuracy', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const generated = await h.api.post('/api/flashcards/generate', { cardCount: 4 });
  assert.equal(generated.status, 201, JSON.stringify(generated.body));
  const deckId = generated.body.deck.id;
  const [first, second] = generated.body.deck.cards;

  const reviewed = await h.api.post(`/api/flashcards/${deckId}/review`, {
    results: [
      { cardId: first.id, grade: 'again' },
      { cardId: second.id, grade: 'easy' },
    ],
  });
  assert.equal(reviewed.status, 200);

  const profile = (await h.api.get('/api/dna')).body;
  assert.equal(profile.totals.ratings, 2);
  assert.equal(profile.totals.cardsReviewed, 2);
  assert.equal(profile.totals.questionsAnswered, 0);
  assert.equal(profile.totals.overallAccuracy, null, 'there is no quiz accuracy to report');

  const concept = profile.concepts.find((c) => c.concept === 'databases.txt');
  assert.ok(concept);
  assert.equal(concept.quiz.accuracy, null, 'self-ratings must never become an accuracy figure');
  assert.equal(concept.quiz.answered, 0);
  assert.equal(concept.flashcards.ratings, 2);
  assert.equal(concept.flashcards.reviewedCards, 2);
  assert.deepEqual(concept.flashcards.grades, { again: 1, hard: 0, good: 0, easy: 1 });
  assert.equal(concept.flashcards.decks, 1);

  // Half the ratings were "Again": the learner's own grades suggest a pass.
  assert.equal(concept.morePractice.state, 'suggested');
  assert.match(concept.morePractice.reason, /Again" or "Hard/);

  // The whole profile avoids mastery language.
  assert.doesNotMatch(JSON.stringify(profile.concepts), /mastered/i);
});

test('dna: evidence never crosses learner profiles', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'databases.txt', DATABASES, 'learner-a');
  await attemptQuiz(h, { correctCount: 1, wrongCount: 3, learnerId: 'learner-a' });

  const mine = (await h.api.get('/api/dna', 'learner-a')).body;
  assert.ok(mine.concepts.length > 0);
  assert.equal(mine.totals.questionsAnswered, 4);

  const other = (await h.api.get('/api/dna', 'learner-b')).body;
  assert.equal(other.hasEnoughData, false);
  assert.deepEqual(other.concepts, []);
  assert.equal(other.totals.questionsAnswered, 0);
  assert.equal(other.totals.materialsInLibrary, 0);

  // And the material itself stays scoped to its owner.
  const otherMaterials = (await h.api.get('/api/materials', 'learner-b')).body;
  assert.deepEqual(otherMaterials.materials, []);
  assert.ok(material.id);
});
