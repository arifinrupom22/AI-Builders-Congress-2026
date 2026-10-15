/**
 * LearnSphere AI server entry point.
 *
 * Startup is explicit and reports the truth about the AI configuration rather
 * than implying a model is connected when it is not.
 */
import config from './config.js';
import { createLogger } from './logger.js';
import { createStore } from './storage/store.js';
import { createRetrievalService } from './retrieval/service.js';
import { createProvider } from './ai/provider.js';
import { createTeacher } from './ai/teacher.js';
import { createQuizService } from './quiz/generator.js';
import { createSummaryService } from './summary/service.js';
import { createProgressService } from './progress/service.js';
import { createApp } from './app.js';

const logger = createLogger({ level: process.env.LOG_LEVEL ?? (config.env === 'production' ? 'info' : 'debug') });

const store = await createStore({ dataDir: config.dataDir, logger });
const retrieval = createRetrievalService({ store, config, logger });
const provider = createProvider(config.ai, logger);
const teacher = createTeacher({ retrieval, provider, config, logger });
const quizService = createQuizService({ retrieval, provider, config, logger, store });
const summaryService = createSummaryService({ store, retrieval, provider, config, logger });
const progressService = createProgressService({ store });

const app = createApp({
  config,
  logger,
  store,
  retrieval,
  teacher,
  quizService,
  summaryService,
  progressService,
  startedAt: Date.now(),
});

const server = app.listen(config.port, () => {
  logger.info('LearnSphere AI server listening', {
    url: `http://localhost:${config.port}`,
    env: config.env,
    dataDir: config.dataDir,
  });

  // Say out loud which environment values were ignored, so "why is it on a
  // different port than I set?" has an answer in the log.
  for (const warning of config.warnings ?? []) {
    logger.warn('environment value ignored', { detail: warning });
  }

  if (config.ai.configured) {
    logger.info('AI answers enabled', {
      provider: config.ai.providerId,
      model: config.ai.model,
      privacy: config.ai.privacy,
    });
  } else {
    logger.info('Running in offline demo mode - no AI API key configured', {
      missing: config.ai.missing,
      effect: 'Answers use local extractive grounding over your own material. Quizzes are generated locally.',
      fix: 'Set LEARNSPHERE_AI_PROVIDER and LEARNSPHERE_AI_API_KEY in .env to enable a free-tier model.',
    });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error('port already in use', {
      port: config.port,
      fix: `Stop the other process or run with a different port, e.g. PORT=8788 npm start`,
    });
    process.exit(1);
  }
  logger.error('server error', { message: err.message });
  process.exit(1);
});

function shutdown(signal) {
  logger.info('shutting down', { signal });
  server.close(() => process.exit(0));
  // Do not hang forever on a stuck keep-alive connection.
  setTimeout(() => process.exit(0), 5000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));

export { app, server };
