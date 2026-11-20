/**
 * Test harness.
 *
 * Boots the REAL application against a temporary data directory on an ephemeral
 * port. Nothing is mocked: the same Express app, store, BM25 index, teacher and
 * quiz generator that production uses are exercised through HTTP, which is the
 * interface the browser actually talks to.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

process.env.NODE_ENV ??= 'test';
// Hard-code offline demo mode: tests must never burn a real free-tier quota or
// depend on network access.
process.env.LEARNSPHERE_AI_PROVIDER = 'none';
process.env.LEARNSPHERE_AI_API_KEY = '';
process.env.LEARNSPHERE_AI_MODEL = '';
process.env.LOG_LEVEL ??= 'silent';
process.env.LEARNSPHERE_DATA_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'learnsphere-boot-'));
// The real .env may set AUTH_MODE=required for the deployment. The suites pick
// their own identity mode per harness (`env.auth.mode`), so the process default
// is pinned here instead of leaking the developer's deployment settings in.
process.env.AUTH_MODE = 'local';
// The team password is configuration, never source. Tests supply their own.


const { config } = await import('../../src/config.js');
const { createLogger } = await import('../../src/logger.js');
const { createStore } = await import('../../src/storage/store.js');
const { createRetrievalService } = await import('../../src/retrieval/service.js');
const { createProvider } = await import('../../src/ai/provider.js');
const { createTeacher } = await import('../../src/ai/teacher.js');
const { createQuizService } = await import('../../src/quiz/generator.js');
const { createFlashcardService } = await import('../../src/flashcards/service.js');
const { createSummaryService } = await import('../../src/summary/service.js');
const { createVisualsService } = await import('../../src/visuals/service.js');
const { createLearningPathService } = await import('../../src/learningpath/service.js');
const { createProgressService } = await import('../../src/progress/service.js');
const { createDnaService } = await import('../../src/dna/service.js');
const { createCoachService } = await import('../../src/coach/service.js');
const { createPlannerService } = await import('../../src/planner/service.js');
const { createTeachbackService } = await import('../../src/teachback/service.js');
const { createApp } = await import('../../src/app.js');

export const DEFAULT_LEARNER = 'test-learner';

/** Small helper so tests read like the HTTP conversation they represent. */
function makeClient(baseUrl) {
  function headers(learnerId, extra = {}) {
    return { 'x-learner-id': learnerId, ...extra };
  }

  async function json(res) {
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text };
    }
  }

  return {
    async get(pathname, learnerId = DEFAULT_LEARNER) {
      return json(await fetch(`${baseUrl}${pathname}`, { headers: headers(learnerId) }));
    },
    async post(pathname, body, learnerId = DEFAULT_LEARNER) {
      return json(
        await fetch(`${baseUrl}${pathname}`, {
          method: 'POST',
          headers: headers(learnerId, { 'content-type': 'application/json' }),
          body: JSON.stringify(body ?? {}),
        }),
      );
    },
    async patch(pathname, body, learnerId = DEFAULT_LEARNER) {
      return json(
        await fetch(`${baseUrl}${pathname}`, {
          method: 'PATCH',
          headers: headers(learnerId, { 'content-type': 'application/json' }),
          body: JSON.stringify(body ?? {}),
        }),
      );
    },
    async del(pathname, learnerId = DEFAULT_LEARNER) {
      return json(await fetch(`${baseUrl}${pathname}`, { method: 'DELETE', headers: headers(learnerId) }));
    },
    async upload(filename, buffer, { learnerId = DEFAULT_LEARNER, mimeType = 'application/octet-stream', field = 'file' } = {}) {
      const form = new FormData();
      form.append(field, new Blob([buffer], { type: mimeType }), filename);
      return json(await fetch(`${baseUrl}/api/materials`, { method: 'POST', headers: headers(learnerId), body: form }));
    },
    /** Raw fetch for header/CORS assertions. */
    fetch,
    baseUrl,
  };
}

/**
 * Build the service graph without an HTTP server. Used by unit tests that need
 * the real store and the real BM25 index but not the network.
 */
export async function createCore({ env = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'learnsphere-core-'));
  const testConfig = {
    ...config,
    ...env,
    env: 'test',
    // Every test gets its own isolated storage.
    dataDir: dir,
    limits: { ...config.limits, ...(env.limits ?? {}) },
    upload: { ...config.upload, ...(env.upload ?? {}) },
    retrieval: { ...config.retrieval, ...(env.retrieval ?? {}) },
    // Registration is open by default, exactly as a fresh deployment is, so the
    // isolation suites can register throwaway addresses (alice@example.com).
    auth: { ...config.auth, registrationPolicy: 'open', ...(env.auth ?? {}) },
    trustProxy: env.trustProxy ?? 0,
    ai: env.ai ?? config.ai,
  };

  const logger = createLogger({ level: 'silent' });
  const store = await createStore({ dataDir: dir, logger });
  const retrieval = createRetrievalService({ store, config: testConfig, logger });
  const provider = createProvider(testConfig.ai, logger);
  const teacher = createTeacher({ retrieval, provider, config: testConfig, logger });
  const quizService = createQuizService({ retrieval, provider, config: testConfig, logger, store });
  const flashcardService = createFlashcardService({ retrieval, provider, config: testConfig, logger, store });
  const summaryService = createSummaryService({ store, retrieval, provider, config: testConfig, logger });
  const visualsService = createVisualsService({ retrieval, provider, config: testConfig, logger, store });
  const learningPathService = createLearningPathService({
    retrieval,
    provider,
    config: testConfig,
    logger,
    store,
    visualsService,
  });
  const progressService = createProgressService({ store });
  const dnaService = createDnaService({ store });
  const plannerService = createPlannerService({ store, retrieval, dnaService, flashcardService, config: testConfig });
  const teachbackService = createTeachbackService({ retrieval, config: testConfig });
  const coachService = createCoachService({ store, dnaService, flashcardService, plannerService });

  return {
    dir,
    config: testConfig,
    logger,
    store,
    retrieval,
    provider,
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
    async close() {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

export async function createHarness({ env = {} } = {}) {
  const core = await createCore({ env });
  const {
    config: testConfig,
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
  } = core;

  const app = createApp({
    config: testConfig,
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
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  return {
    ...core,
    server,
    api: makeClient(`http://127.0.0.1:${port}`),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await core.close();
    },
  };
}

export const SAMPLE_TEXT = `Photosynthesis is the process by which green plants convert light energy into chemical energy stored in glucose.

The light-dependent reactions take place in the thylakoid membrane of the chloroplast and produce ATP and NADPH.

The Calvin cycle is the light-independent stage of photosynthesis and fixes carbon dioxide into glucose using ATP and NADPH.

Chlorophyll is the green pigment that absorbs light most strongly in the blue and red parts of the spectrum.

Cellular respiration is the process that releases energy from glucose and produces ATP, carbon dioxide and water.

Mitochondria is the organelle where aerobic respiration takes place.`;

export function tmpFilePath(dir, name) {
  return path.join(dir, name);
}
