/**
 * Evaluation CLI.
 *
 *   npm run eval
 *
 * Boots the real services against a throwaway data directory, ingests the
 * evaluation corpus, runs every labelled question through the real AI Teacher
 * pipeline, and reports the measured numbers. Results are written to
 * eval/results/latest.md so the competition submission can cite reproducible
 * evidence instead of an unverified claim.
 *
 * Exits non-zero if any headline metric falls below its threshold.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learnsphere-eval-'));

// Configure the environment BEFORE importing anything that reads config.
process.env.LEARNSPHERE_DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
if (!process.env.LEARNSPHERE_AI_PROVIDER) process.env.LEARNSPHERE_AI_PROVIDER = 'none';

const { config } = await import('../server/src/config.js');
const { createLogger } = await import('../server/src/logger.js');
const { createStore } = await import('../server/src/storage/store.js');
const { createRetrievalService } = await import('../server/src/retrieval/service.js');
const { createProvider } = await import('../server/src/ai/provider.js');
const { createTeacher } = await import('../server/src/ai/teacher.js');
const { createQuizService } = await import('../server/src/quiz/generator.js');
const { runEvaluation, toMarkdown } = await import('./evaluate.js');

export const THRESHOLDS = {
  retrievalRecall: 0.85,
  pageAccuracy: 0.8,
  groundingRate: 0.85,
  citationResolutionRate: 1,
  refusalRate: 1,
  falseAnswerRate: 0,
};

const logger = createLogger({ level: 'silent' });
const store = await createStore({ dataDir, logger });
const retrieval = createRetrievalService({ store, config, logger });
const provider = createProvider(config.ai, logger);
const teacher = createTeacher({ retrieval, provider, config, logger });
const quizService = createQuizService({ retrieval, provider, config, logger, store });

const report = await runEvaluation({ store, retrieval, teacher, quizService, config, logger, learnerId: 'eval' });

const failures = Object.entries(THRESHOLDS).filter(([key, threshold]) => {
  const value = report.metrics[key];
  return typeof value === 'number' && value < threshold;
});

const verdict = [
  '',
  '## Verdict',
  '',
  `Mode: **${config.ai.configured ? `live (${config.ai.providerId}/${config.ai.model})` : 'offline demo (no AI key configured)'}**`,
  '',
  failures.length === 0
    ? 'All headline metrics met their thresholds.'
    : `FAILED thresholds:\n${failures.map(([k, t]) => `- ${k}: ${report.metrics[k]} < ${t}`).join('\n')}`,
  '',
  'These numbers describe retrieval and grounding behaviour on a small synthetic',
  'corpus. They are not a claim about learning outcomes.',
  '',
].join('\n');

const markdown = `${toMarkdown(report)}\n${verdict}`;

const resultsDir = path.join(here, 'results');
await fs.mkdir(resultsDir, { recursive: true });
await fs.writeFile(path.join(resultsDir, 'latest.md'), markdown, 'utf8');
await fs.writeFile(path.join(resultsDir, 'latest.json'), JSON.stringify(report, null, 2), 'utf8');

process.stdout.write(markdown);
process.stdout.write(`\nWritten to: ${path.join(resultsDir, 'latest.md')}\n`);

await fs.rm(dataDir, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
