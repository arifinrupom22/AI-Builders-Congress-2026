/**
 * Learning progress routes. Read-only: everything is derived from stored
 * attempts and sessions, so there is nothing here that can be written.
 */
import express from 'express';

export function progressRouter({ progressService }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    res.json(await progressService.overview(req.learnerId));
  });

  router.get('/revision', async (req, res) => {
    res.json(await progressService.revision(req.learnerId));
  });

  return router;
}

export default progressRouter;
