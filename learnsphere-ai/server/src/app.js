/**
 * Express application factory.
 *
 * `createApp` takes every collaborator as a parameter instead of importing
 * singletons. That is what lets the tests build a fully wired app against a
 * temporary data directory and an ephemeral port, with no module mocking.
 */
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

import { errorHandler, notFoundHandler } from './errors.js';
import { requestContext, rateLimit } from './middleware/context.js';
import { corsGuard, securityHeaders, buildAllowedOrigins } from './middleware/security.js';
import { createUploadMiddleware } from './middleware/uploads.js';
import { attachSession, csrfGuard, requireAuthentication, requirePasswordChange } from './middleware/auth.js';
import { createAuthService } from './auth/service.js';
import { authRouter } from './routes/auth.js';

import { materialsRouter } from './routes/materials.js';
import { chatRouter } from './routes/chat.js';
import { quizRouter } from './routes/quiz.js';
import { flashcardsRouter } from './routes/flashcards.js';
import { summaryRouter } from './routes/summary.js';
import { visualsRouter } from './routes/visuals.js';
import { learningPathRouter } from './routes/learningpath.js';
import { progressRouter } from './routes/progress.js';
import { dnaRouter } from './routes/dna.js';
import { coachRouter } from './routes/coach.js';
import { plannerRouter } from './routes/planner.js';
import { accountRouter } from './routes/account.js';
import { teachbackRouter } from './routes/teachback.js';
import { systemRouter } from './routes/system.js';

const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // React sets the style attribute, which requires 'unsafe-inline' for styles.
  // The two font hosts are the faces named in web/index.html; without them the
  // stylesheet is parsed but every font request is refused.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data:",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function createApp({
  config,
  logger,
  store,
  retrieval,
  teacher,
  quizService,
  flashcardService,
  summaryService,
  visualsService,
  learningPathService,
  progressService,
  dnaService,
  coachService,
  plannerService,
  teachbackService,
  startedAt = Date.now(),
}) {
  const app = express();

  app.disable('x-powered-by');
  // Only an explicitly configured hop count is trusted; the default never
  // believes a client-supplied X-Forwarded-For. See config.js/TRUST_PROXY.
  app.set('trust proxy', config.trustProxy ?? 0);

  app.use(securityHeaders);
  app.use(corsGuard(buildAllowedOrigins(config)));
  app.use(requestContext(logger));
  app.use(express.json({ limit: config.limits.jsonBodyLimit }));

  const authService = createAuthService({ store, config });
  // Resolves an account from its session cookie before anything is limited or
  // read, so both rate limiting and storage use a server-verified identity.
  app.use(attachSession({ config, authService }));

  // Authentication is the one API group that must be reachable while signed out.
  app.use('/api/auth', authRouter({ config, authService }));

  // In account mode this rejects every other /api route without a session.
  app.use('/api', requireAuthentication({ config }));
  // Cookie-authenticated writes must echo the session-bound CSRF token.
  app.use('/api', csrfGuard({ authService }));
  // A first-login bootstrap password may only be used to replace itself.
  app.use('/api', requirePasswordChange());

  // Two dimensions: a per-IP ceiling that a changed header cannot reset, and a
  // fair per-profile/account counter on top of it.
  const generalLimit = rateLimit({ windowMs: 60_000, max: config.limits.rateLimitPerMinute, scope: 'learner' });
  const generalIpLimit = rateLimit({
    windowMs: 60_000,
    max: config.limits.rateLimitPerMinute * 4,
    scope: 'ip',
    name: 'ip',
  });
  const expensiveMax = Math.max(5, Math.floor(config.limits.rateLimitPerMinute / 4));
  const expensiveLimit = rateLimit({ windowMs: 60_000, max: expensiveMax, scope: 'learner' });
  const expensiveIpLimit = rateLimit({ windowMs: 60_000, max: expensiveMax * 4, scope: 'ip', name: 'ip' });
  // Uploads are the most expensive request in the app (multipart + extraction)
  // and were previously covered only by the coarse API ceiling.
  const uploadMax = Math.max(4, Math.floor(config.limits.rateLimitPerMinute / 6));
  const uploadLimit = rateLimit({ windowMs: 60_000, max: uploadMax, scope: 'learner', name: 'upload' });
  const uploadIpLimit = rateLimit({ windowMs: 60_000, max: uploadMax * 4, scope: 'ip', name: 'upload-ip' });

  const uploadMiddleware = createUploadMiddleware(config);

  app.use('/api', generalIpLimit, generalLimit);
  app.post('/api/materials', uploadIpLimit, uploadLimit);
  app.use('/api/chat', expensiveIpLimit, expensiveLimit, chatRouter({ store, teacher, config }));
  app.use('/api/quiz/generate', expensiveIpLimit, expensiveLimit);
  app.use('/api/quiz', quizRouter({ store, quizService, config }));
  app.use('/api/flashcards/generate', expensiveIpLimit, expensiveLimit);
  app.use('/api/flashcards', flashcardsRouter({ store, flashcardService, config }));
  app.use('/api/summary', expensiveIpLimit, expensiveLimit, summaryRouter({ summaryService }));
  app.use('/api/visuals/generate', expensiveIpLimit, expensiveLimit);
  app.use('/api/visuals', visualsRouter({ store, visualsService }));
  app.use('/api/learning-path/generate', expensiveIpLimit, expensiveLimit);
  app.use('/api/learning-path', learningPathRouter({ store, learningPathService }));
  app.use('/api/materials', materialsRouter({ store, retrieval, config, logger, uploadMiddleware }));
  app.use('/api/progress', progressRouter({ progressService }));
  app.use('/api/dna', dnaRouter({ dnaService }));
  app.use('/api/coach', coachRouter({ coachService }));
  app.use('/api/plan', plannerRouter({ plannerService }));
  app.use('/api/account', accountRouter({ store, authService, config }));
  app.use('/api/teachback', expensiveIpLimit, expensiveLimit, teachbackRouter({ teachbackService }));
  app.use('/api', systemRouter({ store, retrieval, teacher, authService, config, startedAt }));

  // --- static SPA (production build) ---------------------------------------
  const webDist = path.join(config.projectRoot, 'web', 'dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(
      express.static(webDist, {
        index: false,
        setHeaders(res, filePath) {
          if (filePath.endsWith('.html')) {
            res.setHeader('Content-Security-Policy', SPA_CSP);
            res.setHeader('Cache-Control', 'no-cache');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    // Express 5 removed the bare '*' route, so the SPA fallback is middleware.
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api/')) return next();
      res.setHeader('Content-Security-Policy', SPA_CSP);
      res.setHeader('Cache-Control', 'no-cache');
      return res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use('/api', notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}

export default createApp;
