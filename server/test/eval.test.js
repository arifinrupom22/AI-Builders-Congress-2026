/**
 * Evaluation as a test.
 *
 * Runs the same measurement as `npm run eval` and asserts it against explicit
 * thresholds, so a regression in retrieval or grounding fails the build instead
 * of quietly degrading answer quality.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from './helpers/harness.js';
import { runEvaluation } from '../../eval/evaluate.js';
import { SUPPORTED, UNSUPPORTED, BORDERLINE } from '../../eval/dataset.js';

const THRESHOLDS = {
  retrievalRecall: 0.85,
  pageAccuracy: 0.8,
  groundingRate: 0.85,
  citationResolutionRate: 1,
  refusalRate: 1,
  falseAnswerRate: 0,
};

let report = null;

test('evaluation: run the labelled dataset once for the whole file', async () => {
  const core = await createCore();
  report = await runEvaluation(core);
  await core.close();

  assert.ok(report, 'the evaluation must produce a report');
  assert.equal(report.rows.length, SUPPORTED.length + UNSUPPORTED.length + BORDERLINE.length);
});

test('evaluation: the corpus ingests cleanly', () => {
  assert.ok(report, 'report missing');
  for (const doc of report.metrics.corpus) {
    assert.equal(doc.ok, true, `${doc.name} failed to ingest (status ${doc.status})`);
    assert.ok(doc.passages >= 1, `${doc.name} produced no passages`);
  }
});

test('evaluation: retrieval finds the document that actually answers each question', () => {
  const { retrievalRecall } = report.metrics;
  assert.ok(
    retrievalRecall >= THRESHOLDS.retrievalRecall,
    `retrieval recall ${retrievalRecall} is below ${THRESHOLDS.retrievalRecall}`,
  );
  const misses = report.rows.filter((r) => r.category === 'supported' && !r.retrievalHit).map((r) => r.id);
  assert.deepEqual(misses, [], `these supported questions did not retrieve their source document: ${misses}`);
});

test('evaluation: cited page numbers are correct when the answer has a known page', () => {
  const { pageAccuracy } = report.metrics;
  assert.ok(pageAccuracy >= THRESHOLDS.pageAccuracy, `page accuracy ${pageAccuracy} is below ${THRESHOLDS.pageAccuracy}`);
});

test('evaluation: answers are grounded in the expected document', () => {
  const { groundingRate } = report.metrics;
  assert.ok(groundingRate >= THRESHOLDS.groundingRate, `grounding rate ${groundingRate} is below ${THRESHOLDS.groundingRate}`);
});

test('evaluation: every citation resolves to a real passage on the page it claims', () => {
  assert.equal(
    report.metrics.citationResolutionRate,
    THRESHOLDS.citationResolutionRate,
    'a citation that cannot be resolved would be a fabricated source',
  );
});

test('evaluation: unsupported questions are refused, never guessed at', () => {
  assert.equal(report.metrics.refusalRate, THRESHOLDS.refusalRate, 'every unsupported question must be refused');
  assert.equal(report.metrics.falseAnswerRate, THRESHOLDS.falseAnswerRate, 'no unsupported question may be answered');

  const refused = report.rows.filter((r) => r.category === 'unsupported');
  for (const row of refused) {
    assert.equal(row.kind, 'insufficient_material', `${row.id} ("${row.question}") was not refused`);
    assert.equal(row.citationCount, 0, `${row.id} was refused but still cited sources`);
  }
});

test('evaluation: quiz grading is exact for a perfect and a zero submission', () => {
  assert.equal(report.metrics.quiz.generated, true, `quiz generation failed: ${report.metrics.quiz.reason}`);
  assert.equal(report.metrics.quiz.perfectScoreOk, true);
  assert.equal(report.metrics.quiz.zeroScoreOk, true);
  assert.ok(report.metrics.quiz.questions >= 3);
});

test('evaluation: borderline paraphrases are reported without being gated', () => {
  assert.equal(report.metrics.borderlineQuestions, BORDERLINE.length);
  assert.equal(
    report.metrics.borderlineAnswered + report.metrics.borderlineRefused,
    BORDERLINE.length,
    'every borderline question resolves to either an answer or a refusal',
  );
});

test('evaluation: the report is honest about its own scale', () => {
  // Guard against someone later editing the dataset into a large one and
  // over-claiming: the README cites these numbers, so the size is asserted.
  assert.ok(report.metrics.questions <= 40, 'this is a small labelled set, not a benchmark');
  assert.ok(report.metrics.durationMs >= 0);
  assert.match(JSON.stringify(report.metrics.corpus), /thermodynamics-notes\.pdf/);
});
