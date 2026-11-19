/**
 * Teach-back route. Read-only: it retrieves the learner's own passages, compares
 * wording, and stores nothing.
 */
import express from 'express';
import { z } from 'zod';
import { assertSafeId } from '../storage/store.js';
import { parseBody } from './validate.js';

const bodySchema = z.object({
  concept: z.string().trim().min(2, 'Name the concept you are explaining.').max(200),
  explanation: z
    .string()
    .trim()
    .min(20, 'Write at least a sentence so there is something to compare.')
    .max(4000, 'Keep the explanation under 4000 characters.'),
  materialIds: z.array(z.string().trim()).max(50).nullable().optional(),
});

export function teachbackRouter({ teachbackService }) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const body = parseBody(bodySchema, req.body);
    const materialIds =
      body.materialIds && body.materialIds.length > 0
        ? body.materialIds.map((id) => assertSafeId(id, 'material id'))
        : null;

    const result = await teachbackService.evaluate({
      learnerId: req.learnerId,
      concept: body.concept,
      explanation: body.explanation,
      materialIds,
    });

    // Only the outcome is logged, never the student's explanation.
    req.log.info('teach-back evaluated', {
      status: result.status,
      citations: result.citations?.length ?? 0,
    });

    return res.json(result);
  });

  return router;
}

export default teachbackRouter;
