/**
 * Adaptive Exam Coach routes. Read-only: the plan is derived from stored quiz
 * attempts, Learning DNA evidence and the existing review queue. Nothing here
 * writes, reschedules a card, or records a score.
 */
import express from 'express';

export function coachRouter({ coachService }) {
  const router = express.Router();

  router.get('/plan', async (req, res) => {
    res.json(await coachService.plan(req.learnerId));
  });

  return router;
}

export default coachRouter;
