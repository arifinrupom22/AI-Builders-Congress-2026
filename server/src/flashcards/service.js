/**
 * Flashcards: active-recall decks built from the student's own material.
 *
 * Both paths are grounded, and neither will invent a fact to fill a deck:
 *
 *   1. The AI path asks for strict JSON, validates it with a schema, maps every
 *      `sourceIds` entry back to a passage that was actually retrieved, and
 *      then - stricter than the quiz path - verifies that each card's answer
 *      text really appears in the cited passage. A card that cannot be traced
 *      verbatim to the student's own words is dropped, not softened.
 *   2. The deterministic path (no API key, or an AI failure) extracts
 *      definition sentences from the passages with the same pattern matcher the
 *      quiz generator uses, so every answer is a verbatim sentence from the
 *      material, in the material's own language, including Bangla.
 *
 * If neither path can produce a useful card, the request is refused with an
 * honest explanation. A deck is never padded.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { detectLanguage } from '../ai/extractive-utils.js';
import { buildFlashcardMessages } from '../ai/prompts.js';
import { screenPassage } from '../ai/grounding.js';
import { normaliseForSearch } from '../retrieval/tokenize.js';
import { extractDefinitions } from '../quiz/generator.js';

export const CARD_GRADES = ['again', 'hard', 'good', 'easy'];

/* --- Spaced-review schedule ------------------------------------------------
 * One transparent rule set, driven only by the learner's own ratings:
 *
 *   Again  -> 10 minutes (the interval resets)
 *   Hard   -> your last interval x 1.2, at least 1 day
 *   Good   -> your last interval x 2,   at least 3 days
 *   Easy   -> your last interval x 3,   at least 7 days
 *
 * Intervals are capped at 120 days. A due date is never a prediction: it is
 * only a consequence of when a card was last rated and how it was rated.
 */
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const MAX_INTERVAL_MS = 120 * DAY_MS;

export const GRADE_BASE_MS = {
  again: 10 * MINUTE_MS,
  hard: DAY_MS,
  good: 3 * DAY_MS,
  easy: 7 * DAY_MS,
};

const GRADE_GROWTH = { again: null, hard: 1.2, good: 2, easy: 3 };

/** A card that has never been rated has no schedule at all. */
export function emptySchedule() {
  return { dueAt: null, intervalMs: null, snoozedUntil: null, snoozes: 0 };
}

/** The next interval from the previous one: transparent, monotonic, capped. */
export function nextIntervalMs(grade, previousIntervalMs) {
  if (grade === 'again') return GRADE_BASE_MS.again;
  const base = GRADE_BASE_MS[grade] ?? GRADE_BASE_MS.again;
  const previous = Number(previousIntervalMs) || 0;
  if (previous <= 0) return base;
  const growth = GRADE_GROWTH[grade] ?? 1;
  return Math.min(MAX_INTERVAL_MS, Math.max(base, Math.round(previous * growth)));
}

/** Persist the next due date after a rating. A fresh rating clears any snooze. */
export function scheduleAfterReview({ schedule, grade, now }) {
  const intervalMs = nextIntervalMs(grade, schedule?.intervalMs);
  return {
    dueAt: new Date(now + intervalMs).toISOString(),
    intervalMs,
    snoozedUntil: null,
    snoozes: schedule?.snoozes ?? 0,
  };
}

/** Snoozing only moves the due date. It never records a rating of its own. */
export function snoozeSchedule({ schedule, minutes, now }) {
  const until = new Date(now + minutes * MINUTE_MS).toISOString();
  const base = schedule?.dueAt ? schedule : emptySchedule();
  return { ...base, dueAt: until, snoozedUntil: until, snoozes: (base.snoozes ?? 0) + 1 };
}

/**
 * The stored due date for a card. Cards rated before scheduling existed have
 * no stored schedule, so their due date is derived at read time from the grade
 * they actually received (base interval for that grade, from the last rating)
 * and flagged as derived. Nothing is written back, and nothing is invented.
 */
export function effectiveSchedule(card, now) {
  if (card.schedule?.dueAt) return { ...card.schedule, snoozes: card.schedule.snoozes ?? 0, derived: false };
  if ((card.stats?.reviews ?? 0) === 0) return { ...emptySchedule(), derived: false };
  const intervalMs = GRADE_BASE_MS[card.stats?.lastGrade] ?? GRADE_BASE_MS.good;
  const reviewedAt = Date.parse(card.stats?.lastReviewedAt ?? '');
  const dueAt = Number.isNaN(reviewedAt) ? now : reviewedAt + intervalMs;
  return { dueAt: new Date(dueAt).toISOString(), intervalMs, snoozedUntil: null, snoozes: 0, derived: true };
}

function intervalLabel(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return 'unscheduled';
  if (value < HOUR_MS) return `${Math.max(1, Math.round(value / MINUTE_MS))}-minute`;
  if (value < DAY_MS) return `${Math.max(1, Math.round(value / HOUR_MS))}-hour`;
  return `${Math.round(value / DAY_MS)}-day`;
}

function pastLabel(iso, now) {
  const time = Date.parse(iso ?? '');
  if (Number.isNaN(time)) return 'at an unknown time';
  const diff = Math.max(0, now - time);
  if (diff < MINUTE_MS) return 'moments ago';
  if (diff < HOUR_MS) {
    const n = Math.max(1, Math.round(diff / MINUTE_MS));
    return `${n} minute${n === 1 ? '' : 's'} ago`;
  }
  if (diff < DAY_MS) {
    const n = Math.max(1, Math.round(diff / HOUR_MS));
    return `${n} hour${n === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(diff / DAY_MS);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.max(1, Math.round(days / 30));
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Locale-independent stamp, so due dates read the same everywhere. */
export function stampLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'an unknown time';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${hh}:${mm}`;
}

/**
 * Why this card is in the queue, in plain words. Every clause comes from
 * stored facts - the rating, when it happened, the interval it set, any
 * snooze - so the queue can always explain itself without guessing.
 */
export function queueReason({ status, reviews, lastGrade, lastReviewedAt, intervalMs, derived, snoozedUntil, snoozes, now }) {
  if (!reviews) {
    return 'New card: you have not rated it yet, so no interval is scheduled. Rating it once starts its schedule.';
  }
  const rated = pastLabel(lastReviewedAt, now);
  const snoozeOver = snoozes > 0 && snoozedUntil && Date.parse(snoozedUntil) <= now;
  if (snoozeOver) {
    return `You snoozed it until ${stampLabel(snoozedUntil)} and that time has passed. The interval still comes from rating "${lastGrade}" ${rated} (${intervalLabel(intervalMs)}).`;
  }
  if (derived || !intervalMs) {
    return `Rated "${lastGrade}" ${rated} - shown as due at the ${intervalLabel(intervalMs)} starting interval for that rating. Rating it again saves its own schedule.`;
  }
  if (status === 'due') {
    return `Rated "${lastGrade}" ${rated} - the ${intervalLabel(intervalMs)} interval from that rating has elapsed.`;
  }
  return `Rated "${lastGrade}" ${rated} - next due by the ${intervalLabel(intervalMs)} interval from that rating.`;
}

const AiDeckSchema = z.object({
  cards: z
    .array(
      z.object({
        question: z.string().trim().min(8).max(400),
        answer: z.string().trim().min(4).max(700),
        sourceIds: z.array(z.string().trim()).min(1),
      }),
    )
    .min(1),
});

/**
 * Collapse text the way both sides of the grounding check compare it.
 * Quotation marks are dropped entirely: a model that wraps an otherwise
 * verbatim answer in smart quotes has not invented anything, and a document
 * that quotes its own definition should not fail the check over punctuation.
 */
function flat(text) {
  return normaliseForSearch(text).replace(/["']/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Does the answer really appear in the cited passages? An answer counts as
 * supported only when its full normalised text is found, or when every one of
 * its sentences (each long enough to be a claim) is found. Anything else is a
 * paraphrase or an invention, and a paraphrase is not good enough for a card a
 * student will memorise as "what my notes say".
 */
export function answerIsSupported(answer, passageTexts) {
  const needle = flat(answer);
  if (needle.length < 8) return false;
  const haystack = passageTexts.map(flat).join('\n');
  if (haystack.includes(needle)) return true;
  const sentences = String(answer)
    .split(/(?<=[.!?।])\s+/)
    .map(flat)
    .filter((s) => s.length >= 20);
  return sentences.length > 1 && sentences.every((s) => haystack.includes(s));
}

function parseJsonFromModel(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const CARD_QUESTION_TEMPLATES = {
  en: [
    (term, doc) => `What does ${term} mean?`,
    (term, doc) => `Define ${term}.`,
    (term, doc) => `In "${doc}", what is ${term}?`,
  ],
  bn: [
    (term, doc) => `"${term}" বলতে কী বোঝায়?`,
    (term, doc) => `${term} কী?`,
    (term, doc) => `"${doc}" ফাইলে ${term} কী?`,
  ],
};

function clip(text, max = 500) {
  const value = String(text).replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Deterministic deck builder: one card per distinct definition sentence found
 * in the student's own passages. No model, no invention.
 * @returns {{cards:object[], reason:string|null}}
 */
export function buildLocalCards({ passages, cardCount, language }) {
  const definitions = extractDefinitions(passages).filter(
    (d) => !screenPassage(d.definition).suspicious,
  );

  // One card per term: the same word defined on two pages is one fact.
  const seenTerms = new Set();
  const unique = [];
  for (const candidate of definitions) {
    const key = candidate.term.toLowerCase();
    if (seenTerms.has(key)) continue;
    seenTerms.add(key);
    unique.push(candidate);
  }

  const templates = CARD_QUESTION_TEMPLATES[language] ?? CARD_QUESTION_TEMPLATES.en;
  const cards = unique.slice(0, cardCount).map((candidate, index) => ({
    question: templates[index % templates.length](candidate.term, candidate.documentName),
    answer: clip(candidate.definition),
    source: {
      materialId: candidate.materialId ?? null,
      documentName: candidate.documentName,
      pageNumber: candidate.pageNumber,
      passageId: candidate.passageId ?? null,
    },
  }));

  if (cards.length === 0) {
    return {
      cards: [],
      reason:
        'No definitional sentences ("X is ..." / "X হলো ...") were found in the selected material, so there is nothing solid to turn into a recall card locally. Add a chapter with clear definitions, or configure an AI provider for question-style cards.',
    };
  }
  if (cards.length < cardCount) {
    return {
      cards,
      reason: `Built ${cards.length} of ${cardCount} cards. Your material contains ${cards.length} distinct definition${cards.length === 1 ? '' : 's'}; nothing was invented to fill the rest.`,
    };
  }
  return { cards, reason: null };
}

/** Public deck summary for lists — no card contents. */
export function toDeckSummary(deck) {
  const gradeTotals = { again: 0, hard: 0, good: 0, easy: 0 };
  let reviewedCards = 0;
  for (const card of deck.cards) {
    if (card.stats?.reviews > 0) reviewedCards += 1;
    for (const grade of CARD_GRADES) gradeTotals[grade] += card.stats?.[grade] ?? 0;
  }
  return {
    id: deck.id,
    title: deck.title,
    topic: deck.topic,
    language: deck.language ?? null,
    generationMode: deck.generationMode,
    materialIds: deck.materialIds,
    cardCount: deck.cards.length,
    reviewedCards,
    reviewCount: deck.reviewCount ?? 0,
    lastReviewedAt: deck.lastReviewedAt ?? null,
    gradeTotals,
    createdAt: deck.createdAt,
  };
}

/**
 * Full deck for study. Unlike the quiz payload, the answers ARE sent: a
 * flashcard's reveal happens in the browser by design, and there is no score
 * to protect - the student grades themselves.
 */
export function toPublicDeck(deck) {
  return {
    ...toDeckSummary(deck),
    cards: deck.cards.map((card) => ({
      id: card.id,
      question: card.question,
      answer: card.answer,
      source: card.source,
      stats: card.stats,
      schedule: card.schedule ?? null,
    })),
  };
}

export function createFlashcardService({ store, retrieval, provider, config, logger }) {
  const providerInfo = provider ? { id: provider.id, label: provider.label, model: provider.model } : null;

  /** Choose the passages a deck will draw from — same strategy as the quiz. */
  async function selectPassages({ learnerId, materialIds, topic }) {
    if (topic && topic.trim().length > 0) {
      const search = await retrieval.search({
        learnerId,
        query: topic,
        materialIds,
        topK: 12,
        minScore: Math.min(config.retrieval.minScore, 0.2),
      });
      if (search.results.length > 0) {
        const ids = new Set(search.results.map((r) => r.passageId));
        const all = await retrieval.allPassages(learnerId, materialIds);
        return all.filter((p) => ids.has(p.passageId ?? p.id));
      }
    }
    return retrieval.allPassages(learnerId, materialIds);
  }

  async function generate({ learnerId, materialIds = null, topic = '', cardCount, language = null }) {
    const count = Math.max(1, Math.min(cardCount ?? 10, config.limits.maxFlashcards));
    const passages = await selectPassages({ learnerId, materialIds, topic });

    if (passages.length === 0) {
      return {
        ok: false,
        code: 'no_source_material',
        message:
          'There is no indexed material to build flashcards from. Upload a document first, or select at least one document that finished processing.',
      };
    }

    const deckId = crypto.randomUUID();
    const materialLanguage = passages.find((p) => p.material?.language)?.material?.language ?? null;
    const lang =
      language ?? (topic ? detectLanguage(topic) : materialLanguage ?? detectLanguage(passages[0].text.slice(0, 200)));

    let generationMode = 'demo';
    let cards = [];
    let fallback = null;
    const warnings = [];

    if (provider) {
      try {
        // Keep the prompt bounded: breadth across the material, not depth in one passage.
        const contextPassages = passages.slice(0, 14).map((p, i) => ({
          id: `S${i + 1}`,
          passageId: p.passageId ?? p.id,
          materialId: p.materialId,
          documentName: p.documentName,
          pageNumber: p.pageNumber,
          text: p.text.length > 1400 ? `${p.text.slice(0, 1400)}...` : p.text,
        }));
        const idToPassage = new Map(contextPassages.map((p) => [p.id, p]));

        const response = await provider.chat({
          messages: buildFlashcardMessages({ passages: contextPassages, cardCount: count, language: lang, topic }),
          temperature: 0.4,
          maxTokens: 3000,
        });

        const parsed = parseJsonFromModel(response.content);
        const validated = parsed ? AiDeckSchema.safeParse(parsed) : null;

        if (validated?.success) {
          const kept = [];
          let untraceable = 0;
          for (const raw of validated.data.cards) {
            const cited = raw.sourceIds.map((id) => idToPassage.get(id)).filter(Boolean);
            if (cited.length === 0) {
              untraceable += 1;
              continue;
            }
            // The anti-invention check: the answer must appear in the passages
            // the card itself cites, not merely sit near them.
            if (!answerIsSupported(raw.answer, cited.map((p) => p.text))) {
              untraceable += 1;
              continue;
            }
            const source = cited[0];
            kept.push({
              id: `c${kept.length + 1}`,
              question: raw.question,
              answer: clip(raw.answer),
              source: {
                materialId: source.materialId ?? null,
                documentName: source.documentName,
                pageNumber: source.pageNumber,
                passageId: source.passageId ?? null,
              },
              stats: emptyStats(),
            });
          }
          if (kept.length > 0) {
            cards = kept;
            generationMode = 'live';
            if (untraceable > 0) {
              warnings.push({
                code: 'untraceable_cards_dropped',
                message: `${untraceable} generated card(s) were dropped because their answer could not be found in the cited passage. Nothing unverified was kept.`,
              });
            }
          } else {
            fallback = {
              code: 'no_supported_cards',
              message: 'The model produced no card whose answer could be verified in your material.',
            };
          }
        } else {
          fallback = { code: 'invalid_model_output', message: 'The model did not return cards in the required format.' };
        }
      } catch (err) {
        fallback = { code: err.code ?? 'ai_provider_error', message: err.message };
        logger.warn('flashcard generation via AI failed, using local builder', {
          learnerId,
          provider: provider.id,
          code: fallback.code,
          message: err.message,
        });
      }
    }

    if (cards.length === 0) {
      const local = buildLocalCards({ passages, cardCount: count, language: lang });
      cards = local.cards;
      generationMode = 'demo';
      if (local.reason) warnings.push({ code: 'partial_deck', message: local.reason });
    }

    if (cards.length === 0) {
      return {
        ok: false,
        code: 'insufficient_source_material',
        message:
          warnings.find((w) => w.code === 'partial_deck')?.message ??
          'The selected material does not contain enough complete statements to build a flashcard. Try another document.',
      };
    }

    const documents = [...new Set(cards.map((c) => c.source?.documentName).filter(Boolean))];
    const deck = {
      id: deckId,
      learnerId,
      title: topic ? `Flashcards: ${topic}` : `Flashcards (${cards.length} cards)`,
      topic: topic || null,
      materialIds: materialIds ?? [...new Set(passages.map((p) => p.materialId))],
      language: lang,
      generationMode,
      provider: providerInfo,
      cards: cards.map((c, index) => ({ ...c, id: c.id ?? `c${index + 1}`, stats: c.stats ?? emptyStats() })),
      reviewCount: 0,
      lastReviewedAt: null,
      createdAt: new Date().toISOString(),
    };

    await store.saveDeck(deck);

    return {
      ok: true,
      deck,
      generationMode,
      fallback,
      warnings,
      provenance:
        generationMode === 'live'
          ? `${providerInfo.label} (${providerInfo.model}) wrote these cards from ${cards.length} verified card${cards.length === 1 ? '' : 's'}. Every answer was checked verbatim against the passage it cites.`
          : 'These cards were built locally from definition sentences in your own material. Every answer is a sentence from your documents. No AI model was used.',
      documents,
    };
  }

  /**
   * Record how the student rated each card. Grades are the student's own
   * honest self-assessment; they are stored as counts, never turned into a
   * claim about ability or mastery.
   */
  async function review({ learnerId, deckId, results }) {
    const deck = await store.getDeck(deckId, learnerId);
    if (!deck) return { ok: false, code: 'not_found', message: 'That flashcard deck was not found.' };

    const cardIds = new Set(deck.cards.map((c) => c.id));
    const unknown = results.filter((r) => !cardIds.has(r.cardId)).map((r) => r.cardId);
    if (unknown.length > 0) {
      return {
        ok: false,
        code: 'unknown_card',
        message: `This deck has no card(s) named: ${unknown.join(', ')}.`,
      };
    }

    const now = new Date().toISOString();
    const nowMs = Date.parse(now);
    const counts = { again: 0, hard: 0, good: 0, easy: 0 };
    for (const result of results) counts[result.grade] += 1;

    // Each rating also sets that card's next due date. This is the only place
    // a schedule is created from a rating - no due date is ever written for a
    // card the learner has not actually rated.
    const schedules = [];
    const updated = await store.updateDeck(deckId, learnerId, (d) => {
      for (const result of results) {
        const card = d.cards.find((c) => c.id === result.cardId);
        card.stats.reviews += 1;
        card.stats[result.grade] += 1;
        card.stats.lastGrade = result.grade;
        card.stats.lastReviewedAt = now;
        card.schedule = scheduleAfterReview({ schedule: card.schedule, grade: result.grade, now: nowMs });
        schedules.push({
          cardId: card.id,
          grade: result.grade,
          dueAt: card.schedule.dueAt,
          intervalMs: card.schedule.intervalMs,
        });
      }
      d.reviewCount = (d.reviewCount ?? 0) + 1;
      d.lastReviewedAt = now;
    });

    const review = {
      id: `${deckId}-${Date.now()}`,
      learnerId,
      deckId,
      title: deck.title,
      results,
      counts,
      createdAt: now,
    };
    await store.saveReview(review);

    logger?.info('flashcards reviewed', {
      deckId,
      cards: results.length,
      again: counts.again,
      hard: counts.hard,
      good: counts.good,
      easy: counts.easy,
    });

    return { ok: true, review, deck: toDeckSummary(updated ?? deck), counts, schedules };
  }

  /**
   * The "Due for review" queue: which cards are due now (or never rated), why
   * each one is there, and counts for everything scheduled later. Due dates
   * live on the cards themselves, so the queue survives reloads.
   */
  async function due({ learnerId, limit = 50, summary = false, now = Date.now() }) {
    const decks = await store.listDecks(learnerId, { limit: 500 });
    const counts = { due: 0, newCards: 0, upcoming: 0, snoozed: 0, actionable: 0, totalCards: 0, decks: decks.length };
    const items = [];
    let nextDueAt = null;

    for (const deck of decks) {
      for (const card of deck.cards) {
        counts.totalCards += 1;
        const reviews = card.stats?.reviews ?? 0;
        const schedule = effectiveSchedule(card, now);
        const dueMs = schedule.dueAt ? Date.parse(schedule.dueAt) : null;

        const describe = (status) => ({
          deckId: deck.id,
          deckTitle: deck.title,
          language: deck.language ?? null,
          cardId: card.id,
          question: card.question,
          answer: card.answer,
          source: card.source ?? null,
          status,
          dueAt: status === 'new' ? null : schedule.dueAt,
          overdueByMs: status === 'due' && dueMs !== null ? Math.max(0, now - dueMs) : null,
          intervalMs: schedule.intervalMs ?? null,
          derived: schedule.derived === true,
          snoozedUntil: schedule.snoozedUntil ?? null,
          snoozes: schedule.snoozes ?? 0,
          reviews,
          lastGrade: card.stats?.lastGrade ?? null,
          lastReviewedAt: card.stats?.lastReviewedAt ?? null,
          reason: queueReason({
            status,
            reviews,
            lastGrade: card.stats?.lastGrade ?? null,
            lastReviewedAt: card.stats?.lastReviewedAt ?? null,
            intervalMs: schedule.intervalMs ?? null,
            derived: schedule.derived === true,
            snoozedUntil: schedule.snoozedUntil ?? null,
            snoozes: schedule.snoozes ?? 0,
            now,
          }),
        });

        if (reviews === 0) {
          counts.newCards += 1;
          counts.actionable += 1;
          if (!summary) items.push(describe('new'));
          continue;
        }

        if (dueMs === null || dueMs <= now) {
          counts.due += 1;
          counts.actionable += 1;
          if (!summary) items.push(describe('due'));
        } else {
          counts.upcoming += 1;
          if (schedule.snoozedUntil && Date.parse(schedule.snoozedUntil) > now) counts.snoozed += 1;
          if (nextDueAt === null || dueMs < Date.parse(nextDueAt)) nextDueAt = schedule.dueAt;
        }
      }
    }

    // Most overdue first; cards with no due date (never rated) come last.
    items.sort((a, b) => {
      const av = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
      const bv = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
      return av - bv;
    });

    return {
      counts,
      nextDueAt,
      items: items.slice(0, Math.max(0, limit)),
      totalItems: items.length,
      note:
        'Due dates come only from your own ratings: "Again" restarts at 10 minutes, while Hard, Good and Easy grow your last interval (x1.2, x2, x3) with floors of 1, 3 and 7 days, capped at 120 days. Snoozing moves a due date but never records a rating.',
    };
  }

  /** Push one card's due date later. Deliberately separate from rating. */
  async function snooze({ learnerId, deckId, cardId, minutes, now = Date.now() }) {
    const deck = await store.getDeck(deckId, learnerId);
    if (!deck) return { ok: false, code: 'not_found', message: 'That flashcard deck was not found.' };
    if (!deck.cards.some((c) => c.id === cardId)) {
      return { ok: false, code: 'unknown_card', message: `This deck has no card named: ${cardId}.` };
    }

    const updated = await store.updateDeck(deckId, learnerId, (d) => {
      const card = d.cards.find((c) => c.id === cardId);
      card.schedule = snoozeSchedule({ schedule: card.schedule, minutes, now });
    });
    const card = updated?.cards.find((c) => c.id === cardId);

    logger?.info('flashcard snoozed', { deckId, cardId, minutes, snoozes: card?.schedule?.snoozes ?? 1 });
    return { ok: true, deckId, cardId, schedule: card?.schedule ?? null };
  }

  return { generate, review, due, snooze, selectPassages, providerInfo };
}

function emptyStats() {
  return { reviews: 0, again: 0, hard: 0, good: 0, easy: 0, lastGrade: null, lastReviewedAt: null };
}

export default createFlashcardService;
