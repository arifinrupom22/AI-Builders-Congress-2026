/**
 * Spaced-review queue tests.
 *
 * The properties that matter: a schedule is a pure consequence of the
 * learner's own ratings (Again restarts, success grows the interval), due
 * dates are persisted to disk so the queue survives reloads, the queue can
 * always explain why a card is there, snoozing moves a date without recording
 * a rating, and one learner never sees another's queue.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHarness, createCore } from './helpers/harness.js';
import {
  effectiveSchedule,
  nextIntervalMs,
  scheduleAfterReview,
  GRADE_BASE_MS,
  MAX_INTERVAL_MS,
  DAY_MS,
  MINUTE_MS,
} from '../src/flashcards/service.js';

const DATABASES = `A relational database is a collection of data organised as tables with rows and columns and related by keys.

Normalisation is the process of organising tables and columns to minimise data redundancy and dependency.

An index is a data structure that speeds up the retrieval of rows at the cost of extra storage and slower writes.

A transaction is a unit of work that is either committed in full or rolled back entirely.`;

async function seed(h, name = 'databases.txt', text = DATABASES) {
  const res = await h.api.upload(name, Buffer.from(text, 'utf8'), { mimeType: 'text/plain' });
  assert.equal(res.status, 201, `upload failed: ${JSON.stringify(res.body)}`);
  return res.body.material;
}

async function makeDeck(h, cardCount = 3) {
  await seed(h);
  const res = await h.api.post('/api/flashcards/generate', { cardCount });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.deck;
}

test('schedule: Again restarts at 10 minutes while success grows the last interval', () => {
  // Base intervals for a first rating.
  assert.equal(nextIntervalMs('again', null), 10 * MINUTE_MS);
  assert.equal(nextIntervalMs('hard', null), DAY_MS);
  assert.equal(nextIntervalMs('good', null), 3 * DAY_MS);
  assert.equal(nextIntervalMs('easy', null), 7 * DAY_MS);

  // Growth from the previous interval.
  assert.equal(nextIntervalMs('hard', DAY_MS), Math.round(1.2 * DAY_MS));
  assert.equal(nextIntervalMs('good', 3 * DAY_MS), 6 * DAY_MS);
  assert.equal(nextIntervalMs('easy', 7 * DAY_MS), 21 * DAY_MS);

  // A forgotten card resets: a long history cannot leak into the next interval.
  assert.equal(nextIntervalMs('again', 63 * DAY_MS), 10 * MINUTE_MS);
  // ...and floors still apply after a reset.
  assert.equal(nextIntervalMs('good', 10 * MINUTE_MS), 3 * DAY_MS);
  assert.equal(nextIntervalMs('hard', 10 * MINUTE_MS), DAY_MS);

  // Capped so a schedule never runs away.
  assert.equal(nextIntervalMs('easy', 100 * DAY_MS), MAX_INTERVAL_MS);
  assert.equal(GRADE_BASE_MS.again, 10 * MINUTE_MS);
});

test('schedule: a rating computes its due date and clears any snooze', () => {
  const now = Date.parse('2026-10-22T10:00:00.000Z');
  const first = scheduleAfterReview({ schedule: null, grade: 'again', now });
  assert.equal(first.intervalMs, 10 * MINUTE_MS);
  assert.equal(first.dueAt, new Date(now + 10 * MINUTE_MS).toISOString());
  assert.equal(first.snoozedUntil, null);

  // Snooze history survives, but the snooze itself is replaced by a real rating.
  const snoozed = { ...first, snoozedUntil: new Date(now + 60 * MINUTE_MS).toISOString(), snoozes: 2 };
  const next = scheduleAfterReview({ schedule: snoozed, grade: 'good', now });
  assert.equal(next.intervalMs, 3 * DAY_MS);
  assert.equal(next.snoozedUntil, null);
  assert.equal(next.snoozes, 2);
  assert.equal(next.dueAt, new Date(now + 3 * DAY_MS).toISOString());
});

test('schedule: cards rated before scheduling existed are derived at read time, never written', () => {
  const now = Date.now();
  const legacy = {
    stats: { reviews: 1, lastGrade: 'good', lastReviewedAt: new Date(now - 3 * DAY_MS).toISOString() },
  };
  const derived = effectiveSchedule(legacy, now);
  assert.equal(derived.derived, true, 'a missing schedule is derived, not invented');
  assert.equal(derived.intervalMs, 3 * DAY_MS, 'the base interval for the grade actually given');
  assert.ok(Date.parse(derived.dueAt) <= now);

  const neverRated = { stats: { reviews: 0 } };
  assert.equal(effectiveSchedule(neverRated, now).dueAt, null, 'no rating means no due date');
  assert.equal(effectiveSchedule(neverRated, now).derived, false);

  const stored = { schedule: { dueAt: new Date(now + DAY_MS).toISOString(), intervalMs: DAY_MS, snoozes: 0 } };
  const fromStore = effectiveSchedule(stored, now);
  assert.equal(fromStore.derived, false);
  assert.equal(fromStore.intervalMs, DAY_MS);
});

test('review: a rating stores the next due date and it is written to disk', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const deck = await makeDeck(h, 3);
  const card = deck.cards[0];

  const before = Date.now();
  const reviewed = await h.api.post(`/api/flashcards/${deck.id}/review`, {
    results: [{ cardId: card.id, grade: 'again' }],
  });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.schedules.length, 1);
  assert.equal(reviewed.body.schedules[0].intervalMs, 10 * MINUTE_MS);
  assert.equal(reviewed.body.schedules[0].grade, 'again');

  const fetched = await h.api.get(`/api/flashcards/${deck.id}`);
  const stored = fetched.body.deck.cards.find((c) => c.id === card.id);
  assert.ok(stored.schedule, 'the card carries its schedule in the deck payload');
  const dueMs = Date.parse(stored.schedule.dueAt);
  assert.ok(dueMs >= before + 10 * MINUTE_MS - 2000, 'due 10 minutes after the rating');
  assert.ok(dueMs <= Date.now() + 10 * MINUTE_MS + 5000);

  // Reload proof: the due date lives in the decks file, not only in memory.
  const raw = await fs.readFile(path.join(h.dir, 'flashcard-decks.json'), 'utf8');
  assert.ok(raw.includes(stored.schedule.dueAt), 'the due date must be persisted to disk');

  // A later rating grows the interval from 10 minutes of Again to 3 days.
  const again = await h.api.post(`/api/flashcards/${deck.id}/review`, {
    results: [{ cardId: card.id, grade: 'good' }],
  });
  assert.equal(again.body.schedules[0].intervalMs, 3 * DAY_MS);
});

test('due queue: never-rated cards show up as new and explain they are unscheduled', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const deck = await makeDeck(h, 3);

  const queue = await h.api.get('/api/flashcards/due');
  assert.equal(queue.status, 200, 'the queue route must not be swallowed by /:id');
  assert.equal(queue.body.counts.newCards, 3);
  assert.equal(queue.body.counts.due, 0);
  assert.equal(queue.body.counts.actionable, 3);
  assert.equal(queue.body.counts.totalCards, 3);
  assert.equal(queue.body.items.length, 3);
  for (const item of queue.body.items) {
    assert.equal(item.status, 'new');
    assert.equal(item.dueAt, null, 'no rating, no due date');
    assert.match(item.reason, /not rated it yet/);
    assert.equal(item.deckId, deck.id);
    assert.ok(item.question && item.answer, 'the queue can show the card itself');
  }
  // The schedule itself is published with the queue, not hidden in the UI.
  assert.match(queue.body.note, /Again/);
  assert.match(queue.body.note, /10 minutes/);

  // Summary mode: counts without card bodies, for the Overview entry point.
  const summary = await h.api.get('/api/flashcards/due?summary=1');
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.body.items, []);
  assert.equal(summary.body.counts.newCards, 3);
  assert.equal(summary.body.counts.actionable, 3);
  assert.equal(JSON.stringify(summary.body).includes('"answer"'), false, 'a summary must not ship card answers');
});

test('due queue: a card is queued once its interval passes, with its own reason', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const deck = await makeDeck(h, 3);

  // Rate every card "Again": each is due in 10 minutes, so nothing is due yet.
  const rated = await h.api.post(`/api/flashcards/${deck.id}/review`, {
    results: deck.cards.map((c) => ({ cardId: c.id, grade: 'again' })),
  });
  assert.equal(rated.status, 200);

  const before = await h.api.get('/api/flashcards/due');
  assert.equal(before.body.counts.due, 0);
  assert.equal(before.body.counts.upcoming, 3);
  assert.equal(before.body.counts.actionable, 0);
  assert.deepEqual(before.body.items, [], 'scheduled-later cards are counted, not queued');
  assert.ok(before.body.nextDueAt, 'the queue still says when the next card is due');
  assert.ok(Date.parse(before.body.nextDueAt) > Date.now());

  // Test clock control: move one stored due date into the past.
  const target = deck.cards[0];
  await h.store.updateDeck(deck.id, 'test-learner', (d) => {
    const card = d.cards.find((c) => c.id === target.id);
    card.schedule.dueAt = new Date(Date.now() - 5 * MINUTE_MS).toISOString();
  });

  const after = await h.api.get('/api/flashcards/due');
  assert.equal(after.body.counts.due, 1);
  assert.equal(after.body.counts.upcoming, 2);
  assert.equal(after.body.counts.actionable, 1);
  assert.equal(after.body.items.length, 1);
  const item = after.body.items[0];
  assert.equal(item.status, 'due');
  assert.equal(item.cardId, target.id);
  assert.ok(item.overdueByMs >= 4 * MINUTE_MS, 'overdue by roughly how long it missed');
  assert.match(item.reason, /10-minute interval/);
  assert.match(item.reason, /"again"/);
  assert.ok(Date.parse(item.dueAt) <= Date.now());

  // Most overdue first: with a single due card this is its position.
  assert.equal(after.body.items[0].cardId, target.id);
});

test('snooze: moves the due date without recording a rating', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const deck = await makeDeck(h, 2);
  const target = deck.cards[0];

  await h.api.post(`/api/flashcards/${deck.id}/review`, {
    results: [{ cardId: target.id, grade: 'good' }],
  });
  const reviewsBefore = (await h.store.listReviews('test-learner', { deckId: deck.id })).length;
  assert.equal(reviewsBefore, 1);

  const snoozed = await h.api.post(`/api/flashcards/${deck.id}/snooze`, { cardId: target.id, minutes: 60 });
  assert.equal(snoozed.status, 200, JSON.stringify(snoozed.body));
  assert.equal(snoozed.body.snoozed, true);
  assert.match(snoozed.body.note, /does not record a rating/);
  assert.ok(Date.parse(snoozed.body.schedule.dueAt) > Date.now() + 55 * MINUTE_MS);
  assert.equal(snoozed.body.schedule.snoozes, 1);

  const fetched = await h.api.get(`/api/flashcards/${deck.id}`);
  const stored = fetched.body.deck.cards.find((c) => c.id === target.id);
  assert.equal(stored.stats.reviews, 1, 'a snooze must never look like a review');
  assert.equal(stored.stats.lastGrade, 'good', 'the learner’s own grade is untouched');
  assert.ok(stored.schedule.snoozedUntil);

  const reviewsAfter = await h.store.listReviews('test-learner', { deckId: deck.id });
  assert.equal(reviewsAfter.length, 1, 'no review row may be fabricated by a snooze');

  // The snoozed card drops out of the actionable queue while the snooze runs.
  const queue = await h.api.get('/api/flashcards/due');
  assert.equal(queue.body.counts.due, 0);
  assert.equal(queue.body.counts.snoozed, 1);
  assert.equal(queue.body.counts.upcoming, 1);
  assert.equal(queue.body.counts.newCards, 1, 'the other card has never been rated');
  assert.equal(queue.body.items.length, 1);
  assert.equal(queue.body.items[0].status, 'new');
});

test('snooze: unknown cards, unknown decks and other learners are rejected', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const deck = await makeDeck(h, 1);

  const badCard = await h.api.post(`/api/flashcards/${deck.id}/snooze`, { cardId: 'c99' });
  assert.equal(badCard.status, 400);
  assert.match(badCard.body.error.message, /no card/);

  const badMinutes = await h.api.post(`/api/flashcards/${deck.id}/snooze`, { cardId: 'c1', minutes: 99_999 });
  assert.equal(badMinutes.status, 400);

  const missingDeck = '00000000-0000-4000-8000-000000000000';
  assert.equal((await h.api.post(`/api/flashcards/${missingDeck}/snooze`, { cardId: 'c1' })).status, 404);
  assert.equal((await h.api.post(`/api/flashcards/${deck.id}/snooze`, { cardId: 'c1' }, 'bob')).status, 404);
});

test('isolation: the queue only contains the caller’s own decks', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  await h.api.upload('alice.txt', Buffer.from(DATABASES), { learnerId: 'alice', mimeType: 'text/plain' });
  const generated = await h.api.post('/api/flashcards/generate', { cardCount: 2 }, 'alice');
  assert.equal(generated.status, 201);
  const deck = generated.body.deck;
  await h.api.post(
    `/api/flashcards/${deck.id}/review`,
    { results: [{ cardId: deck.cards[0].id, grade: 'again' }] },
    'alice',
  );

  const bob = await h.api.get('/api/flashcards/due', 'bob');
  assert.equal(bob.status, 200);
  assert.equal(bob.body.counts.totalCards, 0);
  assert.equal(bob.body.counts.decks, 0);
  assert.deepEqual(bob.body.items, []);

  const alice = await h.api.get('/api/flashcards/due', 'alice');
  assert.equal(alice.body.counts.totalCards, 2);
  assert.equal(alice.body.counts.decks, 1);
});

test('due queue: cards scheduled later disappear from the queue as ratings are due again', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const deck = await makeDeck(h, 2);

  // One rating each: both cards are scheduled, none are due.
  await h.api.post(`/api/flashcards/${deck.id}/review`, {
    results: [
      { cardId: deck.cards[0].id, grade: 'easy' },
      { cardId: deck.cards[1].id, grade: 'good' },
    ],
  });

  const queue = await h.api.get('/api/flashcards/due');
  assert.equal(queue.body.counts.due, 0);
  assert.equal(queue.body.counts.newCards, 0);
  assert.equal(queue.body.counts.upcoming, 2);
  assert.deepEqual(queue.body.items, [], 'nothing is due right now');

  // Backdate one card to simulate its 7-day interval elapsing.
  await h.store.updateDeck(deck.id, 'test-learner', (d) => {
    const card = d.cards.find((c) => c.id === deck.cards[0].id);
    card.schedule.dueAt = new Date(Date.now() - 60_000).toISOString();
  });
  const later = await h.api.get('/api/flashcards/due');
  assert.equal(later.body.counts.due, 1);
  assert.equal(later.body.counts.upcoming, 1);
  assert.equal(later.body.items.length, 1);
  assert.match(later.body.items[0].reason, /"easy"/);
  assert.match(later.body.items[0].reason, /7-day interval/);
});

test('the queue service runs offline without an HTTP server', async (t) => {
  const core = await createCore();
  t.after(() => core.close());

  const deck = {
    id: 'deck1',
    learnerId: 'solo',
    title: 'Deck',
    topic: null,
    materialIds: ['m1'],
    language: 'en',
    generationMode: 'demo',
    cards: [
      { id: 'c1', question: 'What is normalisation?', answer: 'Normalisation is the process.', source: {}, stats: { reviews: 0, again: 0, hard: 0, good: 0, easy: 0, lastGrade: null, lastReviewedAt: null } },
      { id: 'c2', question: 'Q2', answer: 'A2', source: {}, stats: { reviews: 1, again: 1, hard: 0, good: 0, easy: 0, lastGrade: 'again', lastReviewedAt: new Date(Date.now() - 60 * MINUTE_MS).toISOString() }, schedule: { dueAt: new Date(Date.now() - 50 * MINUTE_MS).toISOString(), intervalMs: 10 * MINUTE_MS, snoozedUntil: null, snoozes: 0 } },
    ],
    reviewCount: 1,
    lastReviewedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  await core.store.saveDeck(deck);

  const queue = await core.flashcardService.due({ learnerId: 'solo' });
  assert.equal(queue.counts.totalCards, 2);
  assert.equal(queue.counts.due, 1, 'the overdue Again card');
  assert.equal(queue.counts.newCards, 1);
  const dueItem = queue.items.find((i) => i.status === 'due');
  assert.ok(dueItem.reason.includes('10-minute'));
  // Due cards sort before never-rated cards.
  assert.equal(queue.items[0].status, 'due');

  const others = await core.flashcardService.due({ learnerId: 'nobody' });
  assert.equal(others.counts.totalCards, 0);
  assert.deepEqual(others.items, []);
});
