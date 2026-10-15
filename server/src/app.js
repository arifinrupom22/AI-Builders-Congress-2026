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

import { materialsRouter } from './routes/materials.js';
import { chatRouter } from './routes/chat.js';
import { quizRouter } from './routes/quiz.js';
import { summaryRouter } from './routes/summary.js';
import { progressRouter } from './routes/progress.js';
import { systemRouter } from './routes/system.js';

const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // React sets the style attribute, which requires 'unsafe-inline' for styles.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
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
  summaryService,
  progressService,
  startedAt = Date.now(),
}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use(securityHeaders);
  app.use(corsGuard(buildAllowedOrigins(config)));
  app.use(requestContext(logger));
  app.use(express.json({ limit: config.limits.jsonBodyLimit }));

  // Coarse ceiling for the whole API, plus a much tighter one for the two
  // endpoints that cost real money or real CPU.
  const generalLimit = rateLimit({ windowMs: 60_000, max: config.limits.rateLimitPerMinute });
  const expensiveLimit = rateLimit({
    windowMs: 60_000,
    max: Math.max(5, Math.floor(config.limits.rateLimitPerMinute / 4)),
  });

  const uploadMiddleware = createUploadMiddleware(config);

  app.use('/api', generalLimit);
  app.use('/api/chat', expensiveLimit, chatRouter({ store, teacher, config }));
  app.use('/api/quiz/generate', expensiveLimit);
  app.use('/api/quiz', quizRouter({ store, quizService, config }));
  app.use('/api/summary', expensiveLimit, summaryRouter({ summaryService }));
  app.use('/api/materials', materialsRouter({ store, retrieval, config, logger, uploadMiddleware }));
  app.use('/api/progress', progressRouter({ progressService }));
  app.use('/api', systemRouter({ store, retrieval, teacher, config, startedAt }));

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
