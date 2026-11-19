/**
 * Learning DNA routes. Read-only: the profile is derived from stored quiz
 * attempts and flashcard ratings, so there is nothing here that can be written.
 */
import express from 'express';

export function dnaRouter({ dnaService }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    res.json(await dnaService.profile(req.learnerId));
  });

  return router;
}

export default dnaRouter;
