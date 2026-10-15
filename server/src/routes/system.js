/**
 * Health and configuration routes.
 *
 * `/api/config` is the only endpoint that describes the AI setup to the client,
 * and it goes through `config.publicConfig()`, which whitelists fields. The API
 * key cannot leak through it because it is never copied into that object.
 */
import express from 'express';
import { ANSWER_MODES, ANSWER_LENGTHS, SUMMARY_LENGTHS } from '../ai/prompts.js';

/**
 * `config` is injected (not imported) so the test harness can run the app
 * against a temporary data directory without touching process-wide state.
 */
export function systemRouter({ store, retrieval, teacher, config, startedAt = Date.now() }) {
  const router = express.Router();

  router.get('/health', async (req, res) => {
    const [storeStats, retrievalStats] = await Promise.all([
      store.stats(req.learnerId).catch(() => null),
      retrieval.stats(req.learnerId).catch(() => null),
    ]);

    res.json({
      status: 'ok',
      version: config.version,
      environment: config.env,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
      ai: {
        providerId: config.ai.providerId,
        model: config.ai.model || null,
        configured: config.ai.configured,
        mode: config.ai.configured ? 'live' : 'demo',
        missingEnvVars: config.ai.missing,
      },
      learner: {
        id: req.learnerId,
        scopingNote:
          'The learner id is client-asserted and scopes data ownership. It is not authentication and does not secure a shared deployment.',
      },
      store: storeStats,
      retrieval: retrievalStats,
      notes: [
        'No authentication is enabled in this build.',
        'Storage is local disk, not multi-tenant cloud storage.',
      ],
    });
  });

  router.get('/config', (req, res) => {
    res.json({
      ...config.publicConfig(),
      provider: teacher.providerInfo,
      answerModes: ANSWER_MODES,
      answerLengths: ANSWER_LENGTHS,
      summaryLengths: SUMMARY_LENGTHS,
      topics: {
        competition: 'International AI Builders Congress 2026',
        challenge: 'AI Teacher',
        team: 'NITER_Parallax',
      },
    });
  });

  return router;
}

export default systemRouter;
