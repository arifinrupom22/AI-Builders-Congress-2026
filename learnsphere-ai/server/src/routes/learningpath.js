/**
 * Guided learning path routes.
 *
 * Generation follows the quiz/flashcards/studio convention: 422 with an
 * honest, structured reason when the material cannot support a path, so
 * "no path" reads as an explanation rather than a failure. A saved path keeps
 * its citations and its completion state, so a learner can stop, come back
 * weeks later and resume where they left off.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import AppError from '../errors.js';
import { parseBody } from './validate.js';
import { assertSafeId } from '../storage/store.js';

const generateSchema = z.object({
  topic: z.string().trim().max(300).optional().default(''),
  materialIds: z.array(z.string().trim()).max(50).nullable().optional(),
  language: z.enum(['en', 'bn']).nullable().optional(),
});

const progressSchema = z.object({
  stepId: z.string().trim().min(1).max(16),
  completed: z.boolean(),
});

/** Public shape of a step - everything except nothing; steps carry no learner id. */
const toPathSummary = (record) => ({
  id: record.id,
  topic: record.topic,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  documents: record.stats?.documents ?? [],
  steps: record.steps.length,
  completed: record.steps.filter((s) => s.completed).length,
  citations: record.citations?.length ?? 0,
  generationMode: record.generationMode,
  language: record.language ?? 'en',
});

const toPublicPath = (record) => {
  const { learnerId, ...rest } = record;
  void learnerId;
  return rest;
};

export function learningPathRouter({ store, learningPathService }) {
  const router = express.Router();

  router.post('/generate', async (req, res) => {
    const body = parseBody(generateSchema, req.body);
    const materialIds =
      body.materialIds && body.materialIds.length > 0
        ? body.materialIds.map((id) => assertSafeId(id, 'material id'))
        : null;

    const result = await learningPathService.build({
      learnerId: req.learnerId,
      topic: body.topic,
      materialIds,
      language: body.language ?? null,
    });

    if (!result.ok) {
      // The refusal carries what WAS found, so the UI can show an explanation
      // (with the signal tally) instead of a bare error.
      const details =
        result.details ?? (result.candidates?.length ? { candidates: result.candidates } : undefined);
      return res.status(422).json({
        error: {
          code: result.code,
          message: result.message,
          requestId: req.id,
          ...(details ? { details } : {}),
        },
      });
    }

    const record = {
      id: randomUUID(),
      learnerId: req.learnerId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...result.path,
    };
    await store.savePath(record);

    req.log.info('learning path generated', {
      pathId: record.id,
      steps: record.steps.length,
      mode: record.generationMode,
      completed: 0,
    });

    return res.status(201).json({ path: toPublicPath(record) });
  });

  router.get('/', async (req, res) => {
    const paths = await store.listPaths(req.learnerId, { limit: 50 });
    res.json({ paths: paths.map(toPathSummary) });
  });

  router.get('/:id', async (req, res) => {
    const id = assertSafeId(String(req.params.id), 'learning path id');
    const record = await store.getPath(id, req.learnerId);
    if (!record) throw AppError.notFound('That learning path was not found.');
    res.json({ path: toPublicPath(record) });
  });

  /**
   * Mark one step done or not done. Completion is the learner's own record of
   * where they are - it is never sent to a model and never scored.
   */
  router.patch('/:id/progress', async (req, res) => {
    const id = assertSafeId(String(req.params.id), 'learning path id');
    const body = parseBody(progressSchema, req.body);

    const record = await store.getPath(id, req.learnerId);
    if (!record) throw AppError.notFound('That learning path was not found.');
    if (!record.steps.some((s) => s.id === body.stepId)) {
      throw AppError.badRequest('That step is not part of this learning path.');
    }

    const updated = await store.updatePath(id, req.learnerId, (draft) => {
      const step = draft.steps.find((s) => s.id === body.stepId);
      if (!step) return;
      step.completed = body.completed;
      step.completedAt = body.completed ? new Date().toISOString() : null;
    });
    if (!updated) throw AppError.notFound('That learning path was not found.');

    req.log.info('learning path progress updated', {
      pathId: id,
      stepId: body.stepId,
      completed: body.completed,
      completedSteps: updated.steps.filter((s) => s.completed).length,
    });

    res.json({ path: toPublicPath(updated) });
  });

  /** Build (once) the Visual Study Studio picture for one step. */
  router.post('/:id/steps/:stepId/visual', async (req, res) => {
    const id = assertSafeId(String(req.params.id), 'learning path id');
    const stepId = String(req.params.stepId);

    const result = await learningPathService.visualForStep({
      learnerId: req.learnerId,
      pathId: id,
      stepId,
    });

    if (!result.ok) {
      if (result.code === 'not_found') throw AppError.notFound(result.message);
      if (result.code === 'step_not_found') throw AppError.badRequest(result.message);
      return res.status(422).json({
        error: { code: result.code, message: result.message, requestId: req.id },
      });
    }

    return res.status(201).json({ cached: result.cached, visual: result.visual });
  });

  router.delete('/:id', async (req, res) => {
    const id = assertSafeId(String(req.params.id), 'learning path id');
    const removed = await store.deletePath(id, req.learnerId);
    if (!removed) throw AppError.notFound('That learning path was not found.');
    res.json({ deleted: true, pathId: id });
  });

  return router;
}

export default learningPathRouter;
