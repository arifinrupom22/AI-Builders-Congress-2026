/**
 * Flashcard tests in offline demo mode.
 *
 * The important properties: every card's answer is a verbatim sentence from
 * real material, every card names its source document and page, an unhelpful
 * material produces an honest refusal instead of a padded deck, review grades
 * accumulate per card, and one learner cannot touch another's decks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';
import { answerIsSupported, buildLocalCards } from '../src/flashcards/service.js';

const DATABASES = `A relational database is a collection of data organised as tables with rows and columns and related by keys.

Normalisation is the process of organising tables and columns to minimise data redundancy and dependency.

An index is a data structure that speeds up the retrieval of rows at the cost of extra storage and slower writes.

A transaction is a unit of work that is either committed in full or rolled back entirely.

A foreign key is a column that references the primary key of another table and enforces referential integrity.

The primary key is a column or set of columns that uniquely identifies each row in a table.`;

const BANGLA = `ক্লোরোফিল হলো সবুজ পাতায় পাওয়া রঞ্জক যা আলো শোষণ করে দেয় আলোকসংশ্লেষণে।

মাইটোকন্ড্রিয়া হলো কোষের সেই অঙ্গাণু যেখানে কোষীয় শ্বসন ঘটে এবং শক্তি উৎপন্ন হয়।

প্রকাশন হলো জিন বিশ্লেষণের মাধ্যমে বংশগত বৈশিষ্ট্যের প্রকাশ পাওয়ার ফল।`;

async function seed(h, name, text) {
  const res = await h.api.upload(name, Buffer.from(text, 'utf8'), { mimeType: 'text/plain' });
  assert.equal(res.status, 201, `upload failed: ${JSON.stringify(res.body)}`);
  return res.body.material;
}

test('answerIsSupported accepts a verbatim answer and rejects a paraphrase', () => {
  const passage = 'Normalisation is the process of organising tables to minimise data redundancy.';
  assert.equal(answerIsSupported('Normalisation is the process of organising tables to minimise data redundancy.', [passage]), true);
  // Smart quotes and case must not defeat a real match.
  assert.equal(answerIsSupported('“normalisation is the process” of organising tables to minimise data redundancy.', [passage]), true);
  // A paraphrase, however close, is not the material's own words.
  assert.equal(answerIsSupported('Normalisation means getting rid of duplicate data in database tables.', [passage]), false);
  // A fact from nowhere is not supported by any passage.
  assert.equal(answerIsSupported('Normalisation was invented in 1970 by Edgar Codd at IBM.', [passage]), false);
});

test('generate: builds a deck of grounded cards, each with document and page', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'databases.txt', DATABASES);

  const res = await h.api.post('/api/flashcards/generate', { cardCount: 5, materialIds: [material.id] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.generationMode, 'demo', 'no API key, so this must be labelled demo');
  assert.match(res.body.provenance, /No AI model was used/);

  const deck = res.body.deck;
  assert.ok(deck.cards.length > 0 && deck.cards.length <= 5);
  for (const card of deck.cards) {
    assert.ok(card.question.length > 8);
    assert.ok(card.answer.length > 20);
    assert.equal(card.source.documentName, 'databases.txt');
    assert.equal(card.source.pageNumber, 1);
    assert.ok(card.stats, 'every card carries review stats');
  }

  // Every answer is a sentence that really is in the material.
  const corpus = (await h.store.readPassages(material.id)).map((p) => p.text).join(' ');
  for (const card of deck.cards) {
    const answer = card.answer.replace(/…$/, '');
    assert.ok(
      corpus.includes(answer.slice(0, Math.min(60, answer.length))),
      `card answer is not traceable to the document: "${answer.slice(0, 80)}"`,
    );
  }
});

test('generate: refuses honestly when the material cannot support a card', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const noMaterials = await h.api.post('/api/flashcards/generate', { cardCount: 5 });
  assert.equal(noMaterials.status, 422);
  assert.equal(noMaterials.body.error.code, 'no_source_material');
  assert.match(noMaterials.body.error.message, /Upload a document first/);

  // Prose without a single definitional sentence: nothing solid to memorise.
  await seed(h, 'waffle.txt', 'It rained on Tuesday. The bus was late again. Nobody enjoyed the sandwich.');
  const tooThin = await h.api.post('/api/flashcards/generate', { cardCount: 5 });
  assert.equal(tooThin.status, 422);
  assert.equal(tooThin.body.error.code, 'insufficient_source_material');

  // The refusal must also leave no half-empty deck behind.
  const decks = await h.api.get('/api/flashcards');
  assert.deepEqual(decks.body.decks, []);
});

test('generate: asks for fewer cards when the material cannot support more, and says so', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const res = await h.api.post('/api/flashcards/generate', { cardCount: 50 });
  assert.equal(res.status, 201);
  const count = res.body.deck.cards.length;
  assert.ok(count < 50, 'the material holds only a handful of definitions');
  const partial = res.body.warnings.find((w) => w.code === 'partial_deck');
  assert.ok(partial, 'a short deck must be explained, not silently padded');
  assert.match(partial.message, /nothing was invented/i);
});

test('generate: Bangla material produces Bangla cards in demo mode', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'bangla.txt', BANGLA);

  const res = await h.api.post('/api/flashcards/generate', { cardCount: 5 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.deck.language, 'bn');

  const deck = res.body.deck;
  assert.ok(deck.cards.length >= 2, `expected Bangla definition cards, got ${deck.cards.length}`);
  for (const card of deck.cards) {
    assert.match(card.question, /[\u0980-\u09FF]/, 'the question must be in Bangla for a Bangla document');
    assert.match(card.answer, /[\u0980-\u09FF]/);
    assert.equal(card.source.documentName, 'bangla.txt');
  }
  // The Bangla definition sentences are the answers, verbatim.
  const corpus = (await h.store.readPassages(deck.cards[0].source.materialId)).map((p) => p.text).join(' ');
  assert.ok(corpus.includes(deck.cards[0].answer.slice(0, 40)));
});

test('review: grades accumulate per card and the deck summary reflects them', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const generated = await h.api.post('/api/flashcards/generate', { cardCount: 4 });
  assert.equal(generated.status, 201);
  const deckId = generated.body.deck.id;
  const [first, second] = generated.body.deck.cards;

  const reviewed = await h.api.post(`/api/flashcards/${deckId}/review`, {
    results: [
      { cardId: first.id, grade: 'again' },
      { cardId: second.id, grade: 'easy' },
    ],
  });
  assert.equal(reviewed.status, 200);
  assert.deepEqual(reviewed.body.counts, { again: 1, hard: 0, good: 0, easy: 1 });
  assert.equal(reviewed.body.deck.reviewCount, 1);
  assert.equal(reviewed.body.deck.reviewedCards, 2);
  assert.match(reviewed.body.note, /self-assessment/);

  // Second session on the same deck accumulates rather than resets.
  const again = await h.api.post(`/api/flashcards/${deckId}/review`, {
    results: [{ cardId: first.id, grade: 'good' }],
  });
  assert.equal(again.body.deck.reviewCount, 2);

  const fetched = await h.api.get(`/api/flashcards/${deckId}`);
  const storedFirst = fetched.body.deck.cards.find((c) => c.id === first.id);
  assert.equal(storedFirst.stats.reviews, 2, 'the same card reviewed twice has two reviews');
  assert.equal(storedFirst.stats.again, 1);
  assert.equal(storedFirst.stats.good, 1);
  assert.equal(storedFirst.stats.lastGrade, 'good');
  assert.ok(storedFirst.stats.lastReviewedAt);

  // Review history is persisted for the learner.
  const storedReviews = await h.store.listReviews('test-learner', { deckId });
  assert.equal(storedReviews.length, 2);
});

test('review: malformed input and unknown cards are rejected', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const generated = await h.api.post('/api/flashcards/generate', { cardCount: 2 });
  const deckId = generated.body.deck.id;

  const badGrade = await h.api.post(`/api/flashcards/${deckId}/review`, {
    results: [{ cardId: 'c1', grade: 'super-easy' }],
  });
  assert.equal(badGrade.status, 400);

  const unknownCard = await h.api.post(`/api/flashcards/${deckId}/review`, {
    results: [{ cardId: 'c99', grade: 'good' }],
  });
  assert.equal(unknownCard.status, 400);
  assert.match(unknownCard.body.error.message, /no card/);

  const empty = await h.api.post(`/api/flashcards/${deckId}/review`, { results: [] });
  assert.equal(empty.status, 400);
});

test('isolation: a learner cannot see, review or delete another learner\'s deck', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await h.api.upload('alice.txt', Buffer.from(DATABASES), { learnerId: 'alice', mimeType: 'text/plain' });

  const generated = await h.api.post('/api/flashcards/generate', { cardCount: 2 }, 'alice');
  assert.equal(generated.status, 201);
  const deckId = generated.body.deck.id;

  assert.equal((await h.api.get(`/api/flashcards/${deckId}`, 'bob')).status, 404);
  assert.equal(
    (await h.api.post(`/api/flashcards/${deckId}/review`, { results: [{ cardId: 'c1', grade: 'good' }] }, 'bob')).status,
    404,
  );
  assert.equal((await h.api.del(`/api/flashcards/${deckId}`, 'bob')).status, 404);

  const bobList = await h.api.get('/api/flashcards', 'bob');
  assert.deepEqual(bobList.body.decks, []);
});

test('delete: removing a deck clears its review history and the deck disappears', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const generated = await h.api.post('/api/flashcards/generate', { cardCount: 2 });
  const deckId = generated.body.deck.id;
  await h.api.post(`/api/flashcards/${deckId}/review`, { results: [{ cardId: 'c1', grade: 'hard' }] });

  const deleted = await h.api.del(`/api/flashcards/${deckId}`);
  assert.equal(deleted.status, 200);

  assert.equal((await h.api.get(`/api/flashcards/${deckId}`)).status, 404);
  const list = await h.api.get('/api/flashcards');
  assert.deepEqual(list.body.decks, []);
  assert.deepEqual(await h.store.listReviews('test-learner'), [], 'review rows must not outlive their deck');
});

test('generate: topic filtering narrows the source material', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  const res = await h.api.post('/api/flashcards/generate', { cardCount: 3, topic: 'normalisation redundancy' });
  assert.equal(res.status, 201);
  assert.match(res.body.deck.title, /normalisation/);
});

test('deck list: summaries carry counts but not card contents', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'databases.txt', DATABASES);

  await h.api.post('/api/flashcards/generate', { cardCount: 3 });
  const list = await h.api.get('/api/flashcards');
  assert.equal(list.body.decks.length, 1);
  const summary = list.body.decks[0];
  assert.ok(summary.cardCount >= 1);
  assert.equal(summary.reviewCount, 0);
  assert.deepEqual(summary.gradeTotals, { again: 0, hard: 0, good: 0, easy: 0 });
  assert.equal(summary.cards, undefined, 'a list summary must not ship every card body');
});

test('buildLocalCards: one card per term, and the same term twice is one card', () => {
  const passages = [
    {
      id: 'p1',
      materialId: 'm1',
      documentName: 'notes.txt',
      pageNumber: 1,
      heading: null,
      text:
        'Normalisation is the process of organising tables to minimise data redundancy.\n\n' +
        'Normalisation is the process of organising tables to minimise data redundancy.\n\n' +
        'A transaction is a unit of work that is either committed in full or rolled back entirely.',
    },
  ];
  const { cards, reason } = buildLocalCards({ passages, cardCount: 2, language: 'en' });
  assert.equal(reason, null);
  assert.equal(cards.length, 2, 'the duplicated definition yields a single card');
  for (const card of cards) {
    assert.equal(card.source.documentName, 'notes.txt');
    assert.equal(card.source.pageNumber, 1);
  }
});

test('config: the public config advertises the flashcard limit', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const res = await h.api.get('/api/config');
  assert.equal(typeof res.body.limits.maxFlashcards, 'number');
  assert.ok(res.body.limits.maxFlashcards >= 1);
});
