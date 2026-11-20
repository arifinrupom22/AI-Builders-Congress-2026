/**
 * LearnSphere AI server entry point.
 *
 * Startup is explicit and reports the truth about the AI configuration rather
 * than implying a model is connected when it is not.
 */
import config from './config.js';
import { createLogger } from './logger.js';
import { createDataStore } from './storage/index.js';
import { createRetrievalService } from './retrieval/service.js';
import { createProvider } from './ai/provider.js';
import { createTeacher } from './ai/teacher.js';
import { createQuizService } from './quiz/generator.js';
import { createFlashcardService } from './flashcards/service.js';
import { createSummaryService } from './summary/service.js';
import { createVisualsService } from './visuals/service.js';
import { createLearningPathService } from './learningpath/service.js';
import { createProgressService } from './progress/service.js';
import { createDnaService } from './dna/service.js';
import { createCoachService } from './coach/service.js';
import { createPlannerService } from './planner/service.js';
import { createTeachbackService } from './teachback/service.js';
import { createApp } from './app.js';
import { provisionTeamAccounts } from './auth/team.js';

const logger = createLogger({ level: process.env.LOG_LEVEL ?? (config.env === 'production' ? 'info' : 'debug') });

const store = await createDataStore({ config, logger });
// The five authorised teammates get an account once, with a temporary password
// they must replace at first sign-in. Existing accounts are never touched.
if (config.auth.mode === 'required') {
  await provisionTeamAccounts({ store, logger });
}
const retrieval = createRetrievalService({ store, config, logger });
const provider = createProvider(config.ai, logger);
const teacher = createTeacher({ retrieval, provider, config, logger });
const quizService = createQuizService({ retrieval, provider, config, logger, store });
const flashcardService = createFlashcardService({ retrieval, provider, config, logger, store });
const summaryService = createSummaryService({ store, retrieval, provider, config, logger });
const visualsService = createVisualsService({ retrieval, provider, config, logger, store });
const learningPathService = createLearningPathService({
  retrieval,
  provider,
  config,
  logger,
  store,
  visualsService,
});
const progressService = createProgressService({ store });
const dnaService = createDnaService({ store });
const plannerService = createPlannerService({ store, retrieval, dnaService, flashcardService, config });
const teachbackService = createTeachbackService({ retrieval, config });
const coachService = createCoachService({ store, dnaService, flashcardService, plannerService });

const app = createApp({
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
  startedAt: Date.now(),
});

const server = app.listen(config.port, () => {
  logger.info('LearnSphere AI server listening', {
    url: `http://localhost:${config.port}`,
    env: config.env,
    dataDir: config.dataDir,
    store: store.driver ?? 'json',
    identity: config.firebase.configured ? 'firebase' : 'password',
  });

  // Say out loud which environment values were ignored, so "why is it on a
  // different port than I set?" has an answer in the log.
  for (const warning of config.warnings ?? []) {
    logger.warn('environment value ignored', { detail: warning });
  }

  if (config.auth.mode === 'local') {
    logger.warn('authentication is off (AUTH_MODE=local)', {
      effect:
        'Requests are scoped by a browser-asserted study profile; anyone who can reach this API can use any profile id. Set AUTH_MODE=required before exposing this server.',
    });
  } else {
    logger.info('accounts required', {
      effect: 'Every API route except health, config and auth needs a signed-in account.',
    });
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
