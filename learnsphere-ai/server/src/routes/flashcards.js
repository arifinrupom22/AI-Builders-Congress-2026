/**
 * Flashcard routes.
 *
 * Deck generation mirrors the quiz generate endpoint (422 with an honest
 * reason when the material cannot support a useful card). Review grades are
 * the student's own self-assessment and are stored as counts — never turned
 * into a score or a claim about ability.
 */
import express from 'express';
import { z } from 'zod';
import AppError from '../errors.js';
import { parseBody } from './validate.js';
import { assertSafeId } from '../storage/store.js';
import { toPublicDeck, toDeckSummary, CARD_GRADES } from '../flashcards/service.js';

const generateSchema = z.object({
  topic: z.string().trim().max(300).optional().default(''),
  cardCount: z.coerce.number().int().min(1).max(50).default(10),
  materialIds: z.array(z.string().trim()).max(50).nullable().optional(),
  language: z.enum(['en', 'bn']).nullable().optional(),
});

const reviewSchema = z.object({
  results: z
    .array(
      z.object({
        cardId: z.string().trim().min(1).max(64),
        grade: z.enum(CARD_GRADES),
      }),
    )
    .min(1)
    .max(100),
});

const snoozeSchema = z.object({
  cardId: z.string().trim().min(1).max(64),
  minutes: z.coerce.number().int().min(5).max(10_080).optional().default(1440),
});

export function flashcardsRouter({ store, flashcardService, config }) {
  const router = express.Router();

  router.post('/generate', async (req, res) => {
    const body = parseBody(generateSchema, req.body);
    const materialIds = body.materialIds && body.materialIds.length > 0
      ? body.materialIds.map((id) => assertSafeId(id, 'material id'))
      : null;

    const result = await flashcardService.generate({
      learnerId: req.learnerId,
      materialIds,
      topic: body.topic,
      cardCount: Math.min(body.cardCount, config.limits.maxFlashcards),
      language: body.language ?? null,
    });

    if (!result.ok) {
      return res.status(422).json({
        error: { code: result.code, message: result.message, requestId: req.id },
      });
    }

    req.log.info('flashcard deck generated', {
      deckId: result.deck.id,
      mode: result.generationMode,
      cards: result.deck.cards.length,
    });

    return res.status(201).json({
      deck: toPublicDeck(result.deck),
      generationMode: result.generationMode,
      fallback: result.fallback,
      warnings: result.warnings,
      provenance: result.provenance,
    });
  });

  router.get('/', async (req, res) => {
    const decks = await store.listDecks(req.learnerId, { limit: 50 });
    res.json({ decks: decks.map(toDeckSummary) });
  });

  // Registered before "/:id" so "due" is a fixed segment, never a deck id.
  router.get('/due', async (req, res) => {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.min(Math.trunc(rawLimit), 200)) : 50;
    const summary = req.query.summary === '1' || req.query.summary === 'true';
    res.json(await flashcardService.due({ learnerId: req.learnerId, limit, summary }));
  });

  router.get('/:id', async (req, res) => {
    const id = assertSafeId(String(req.params.id), 'deck id');
    const deck = await store.getDeck(id, req.learnerId);
    if (!deck) throw AppError.notFound('That flashcard deck was not found.');
    res.json({ deck: toPublicDeck(deck) });
  });

  router.post('/:id/review', async (req, res) => {
    const id = assertSafeId(String(req.params.id), 'deck id');
    const body = parseBody(reviewSchema, req.body);

    const result = await flashcardService.review({
      learnerId: req.learnerId,
      deckId: id,
      results: body.results,
    });

    if (!result.ok) {
      if (result.code === 'not_found') throw AppError.notFound(result.message);
      throw AppError.badRequest(result.message, { code: result.code });
    }

    res.json({
      reviewId: result.review.id,
      deck: result.deck,
      counts: result.counts,
      schedules: result.schedules,
      note: 'These grades are your own self-assessment, recorded so you can see what to revisit. LearnSphere AI does not treat them as a measure of ability.',
    });
  });

  // Moves one card's due date later. Deliberately records no rating.
  router.post('/:id/snooze', async (req, res) => {
    const id = assertSafeId(String(req.params.id), 'deck id');
    const body = parseBody(snoozeSchema, req.body);

    const result = await flashcardService.snooze({
      learnerId: req.learnerId,
      deckId: id,
      cardId: body.cardId,
      minutes: body.minutes,
    });

    if (!result.ok) {
      if (result.code === 'not_found') throw AppError.notFound(result.message);
      throw AppError.badRequest(result.message, { code: result.code });
    }

    res.json({
      snoozed: true,
      deckId: result.deckId,
      cardId: result.cardId,
      schedule: result.schedule,
      note: 'Snoozing moves the due date only — it does not record a rating.',
    });
  });

  router.delete('/:id', async (req, res) => {
    const id = assertSafeId(String(req.params.id), 'deck id');
    const removed = await store.deleteDeck(id, req.learnerId);
    if (!removed) throw AppError.notFound('That flashcard deck was not found.');
    res.json({ deleted: true, deckId: id });
  });

  return router;
}

export default flashcardsRouter;
