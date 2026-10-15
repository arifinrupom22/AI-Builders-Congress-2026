/**
 * AI Teacher chat routes.
 *
 * A "session" is just an ordered list of the student's own questions and the
 * answers they received, so history is inspectable and the provenance of every
 * answer survives a page reload.
 */
import express from 'express';
import { z } from 'zod';
import AppError from '../errors.js';
import { parseBody } from './validate.js';
import { assertSafeId } from '../storage/store.js';
import { ANSWER_MODES, ANSWER_LENGTHS, DEFAULT_MODE, DEFAULT_LENGTH } from '../ai/prompts.js';

const askSchema = z.object({
  question: z.string().trim().min(2, 'Type a question first.').max(2000),
  mode: z.enum(ANSWER_MODES.map((m) => m.id)).default(DEFAULT_MODE),
  length: z.enum(ANSWER_LENGTHS.map((l) => l.id)).default(DEFAULT_LENGTH),
  materialIds: z.array(z.string().trim()).max(50).nullable().optional(),
  sessionId: z.string().trim().max(64).nullable().optional(),
});

export function chatRouter({ store, teacher, config }) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const body = parseBody(askSchema, req.body);

    if (body.question.length > config.limits.chatQuestionMaxChars) {
      throw AppError.badRequest(`Questions are limited to ${config.limits.chatQuestionMaxChars} characters.`);
    }

    const materialIds = body.materialIds && body.materialIds.length > 0
      ? body.materialIds.map((id) => assertSafeId(id, 'material id'))
      : null;

    // Resolve or create the session BEFORE answering, so a failed generation
    // still leaves the student's question in their history.
    let session = null;
    if (body.sessionId) {
      session = await store.getSession(body.sessionId, req.learnerId);
      if (!session) throw AppError.notFound('That study session no longer exists.');
    }
    if (!session) session = await store.createSession(req.learnerId);

    const startedAt = Date.now();
    const result = await teacher.answer({
      learnerId: req.learnerId,
      question: body.question,
      mode: body.mode,
      length: body.length,
      materialIds,
    });

    const now = new Date().toISOString();
    await store.appendMessages(
      session.id,
      req.learnerId,
      [
        { role: 'user', content: body.question, mode: body.mode, createdAt: now },
        {
          role: 'assistant',
          content: result.answer,
          mode: body.mode,
          length: body.length,
          generationMode: result.generationMode,
          kind: result.kind,
          citations: result.citations,
          warnings: result.warnings,
          provenance: result.provenance,
          createdAt: new Date().toISOString(),
        },
      ],
      { maxMessages: config.limits.maxChatMessagesPerSession },
    );

    req.log.info('answer returned', {
      kind: result.kind,
      generationMode: result.generationMode,
      citations: result.citations.length,
      ms: Date.now() - startedAt,
    });

    res.json({ sessionId: session.id, question: body.question, ...result });
  });

  router.get('/sessions', async (req, res) => {
    const sessions = await store.listSessions(req.learnerId, { limit: 30 });
    res.json({ sessions });
  });

  router.get('/sessions/:id', async (req, res) => {
    const id = assertSafeId(String(req.params.id), 'session id');
    const session = await store.getSession(id, req.learnerId);
    if (!session) throw AppError.notFound('That study session was not found.');
    res.json({
      session: {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messages: session.messages,
      },
    });
  });

  router.delete('/sessions/:id', async (req, res) => {
    const id = assertSafeId(String(req.params.id), 'session id');
    const removed = await store.deleteSession(id, req.learnerId);
    if (!removed) throw AppError.notFound('That study session was not found.');
    res.json({ deleted: true, sessionId: id });
  });

  return router;
}

export default chatRouter;
