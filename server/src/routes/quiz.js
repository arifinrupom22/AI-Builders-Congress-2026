/**
 * Practice quiz routes.
 *
 * Security note that matters for fairness: the quiz payload sent to the browser
 * NEVER contains `answerIndex` or `explanation`. Those are released only by the
 * submit endpoint, once answers have been recorded. `toPublicQuiz` is the single
 * place that decides what is safe to send.
 */
import express from 'express';
import { z } from 'zod';
import AppError from '../errors.js';
import { parseBody } from './validate.js';
import { assertSafeId } from '../storage/store.js';
import { toPublicQuiz, toQuizSummary, scoreAttempt, topicBreakdown } from '../quiz/scorer.js';

const generateSchema = z.object({
  topic: z.string().trim().max(300).optional().default(''),
  questionCount: z.coerce.number().int().min(1).max(50).default(5),
  materialIds: z.array(z.string().trim()).max(50).nullable().optional(),
  language: z.enum(['en', 'bn']).nullable().optional(),
});

const submitSchema = z.object({
  answers: z.array(z.number().int().min(0).max(3).nullable()).min(1).max(50),
});

export function quizRouter({ store, quizService, config }) {
  const router = express.Router();

  router.post('/generate', async (req, res) => {
    const body = parseBody(generateSchema, req.body);
    const materialIds = body.materialIds && body.materialIds.length > 0
      ? body.materialIds.map((id) => assertSafeId(id, 'material id'))
      : null;

    const result = await quizService.generate({
      learnerId: req.learnerId,
      materialIds,
      topic: body.topic,
      questionCount: Math.min(body.questionCount, config.limits.maxQuizQuestions),
      language: body.language ?? null,
    });

    if (!result.ok) {
      return res.status(422).json({
        error: { code: result.code, message: result.message, requestId: req.id },
      });
    }

    req.log.info('quiz generated', {
      quizId: result.quiz.id,
      mode: result.generationMode,
      questions: result.quiz.questions.length,
    });

    return res.status(201).json({
      quiz: toPublicQuiz(result.quiz),
      generationMode: result.generationMode,
      fallback: result.fallback,
      warnings: result.warnings,
      provenance: result.provenance,
    });
  });

  router.get('/', async (req, res) => {
    const [quizzes, attempts] = await Promise.all([
      store.listQuizzes(req.learnerId, { limit: 50 }),
      store.listAttempts(req.learnerId, { limit: 200 }),
    ]);
    const attemptsByQuiz = new Map();
    for (const attempt of attempts) {
      const list = attemptsByQuiz.get(attempt.quizId) ?? [];
      list.push({ percent: attempt.percent, correctCount: attempt.correctCount, total: attempt.total, createdAt: attempt.createdAt });
      attemptsByQuiz.set(attempt.quizId, list);
    }
    res.json({
      quizzes: quizzes.map((q) => ({
        ...toQuizSummary(q),
        attempts: attemptsByQuiz.get(q.id) ?? [],
        bestPercent: (attemptsByQuiz.get(q.id) ?? []).reduce((max, a) => Math.max(max, a.percent), null),
      })),
    });
  });

  router.get('/:id', async (req, res) => {
    const id = assertSafeId(String(req.params.id), 'quiz id');
    const quiz = await store.getQuiz(id, req.learnerId);
    if (!quiz) throw AppError.notFound('That quiz was not found.');
    res.json({ quiz: toPublicQuiz(quiz) });
  });

  router.post('/:id/submit', async (req, res) => {
    const id = assertSafeId(String(req.params.id), 'quiz id');
    const body = parseBody(submitSchema, req.body);

    const quiz = await store.getQuiz(id, req.learnerId);
    if (!quiz) throw AppError.notFound('That quiz was not found.');

    if (body.answers.length !== quiz.questions.length) {
      throw AppError.badRequest(
        `This quiz has ${quiz.questions.length} question(s) but ${body.answers.length} answer(s) were submitted.`,
        { expected: quiz.questions.length, received: body.answers.length },
      );
    }

    const scored = scoreAttempt(quiz, body.answers);
    const topics = topicBreakdown(scored.results);

    const attempt = {
      id: `${quiz.id}-${Date.now()}`,
      learnerId: req.learnerId,
      quizId: quiz.id,
      title: quiz.title,
      topic: quiz.topic,
      generationMode: quiz.generationMode,
      createdAt: new Date().toISOString(),
      ...scored,
      topics,
    };
    await store.saveAttempt(attempt);

    req.log.info('quiz submitted', {
      quizId: quiz.id,
      correct: scored.correctCount,
      total: scored.total,
      percent: scored.percent,
    });

    res.json({
      attemptId: attempt.id,
      quizId: quiz.id,
      title: quiz.title,
      generationMode: quiz.generationMode,
      score: {
        correctCount: scored.correctCount,
        answeredCount: scored.answeredCount,
        total: scored.total,
        percent: scored.percent,
      },
      results: scored.results,
      topics,
      scoringNote: 'Skipped questions are counted as incorrect, which is the usual exam convention.',
      retryAdvice:
        scored.percent < 100
          ? 'You can generate a fresh quiz on the same topic, or revisit the cited pages for the questions you missed.'
          : 'Full marks. Generate a new quiz on a different topic to keep widening your coverage.',
    });
  });

  return router;
}

export default quizRouter;
