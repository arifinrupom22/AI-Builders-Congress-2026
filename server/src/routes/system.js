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
        // Provider ids and model names only: never the keys. This is the
        // quickest way to confirm the backup chain a deployment actually runs.
        fallbacks: (config.ai.fallbacks ?? []).map((fallback) => ({
          slot: fallback.slot,
          providerId: fallback.providerId,
          model: fallback.model || null,
        })),
      },
      auth: {
        mode: config.auth.mode,
        // Never the email or any token: this endpoint is public.
        authenticated: Boolean(req.auth?.authenticated),
      },
      learner: {
        id: req.learnerId,
        scopingNote:
          config.auth.mode === 'local'
            ? 'The study profile is asserted by the browser and only scopes data ownership. It is not authentication; use AUTH_MODE=required with an account before exposing this deployment.'
            : 'The study profile is the signed-in account id, verified on the server from an HttpOnly session cookie.',
      },
      store: storeStats,
      retrieval: retrievalStats,
      notes:
        config.auth.mode === 'local'
          ? [
              'Authentication is off (AUTH_MODE=local): data is scoped by a browser-asserted study profile, which is a demo mode, not access control.',
              'Storage is local disk, not multi-tenant cloud storage.',
            ]
          : [
              'Accounts are required (AUTH_MODE=required): every /api route except health, config and auth needs a verified identity.',
              config.supabase?.configured
                ? 'Storage is Supabase PostgreSQL, with uploaded originals in a private object bucket.'
                : 'Storage is local disk. A single instance with a persistent disk is supported; multiple instances need shared storage and a shared rate-limit store.',
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
