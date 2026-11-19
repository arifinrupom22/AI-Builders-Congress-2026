/**
 * Evaluation harness.
 *
 * Measures four things, all of which are run against the real pipeline:
 *
 *   retrievalRecall   - did the document that genuinely contains the answer
 *                       appear in the retrieved passages?
 *   pageAccuracy      - when the answer is on a known page, did we cite it?
 *   groundingRate     - did the answer cite the expected document, and did
 *                       every citation resolve to a passage that exists?
 *   refusalRate       - did unsupported questions get refused instead of
 *                       answered? A refusal is the CORRECT behaviour here.
 *   falseAnswerRate   - unsupported questions that were answered anyway.
 *
 * Retrieval and refusal are the two numbers that matter: a study assistant that
 * invents an answer is worse than one that says "your notes do not cover this".
 */
import { DOCUMENTS, ALL_ROWS } from './dataset.js';
import { ingestMaterial } from '../server/src/documents/ingest.js';
import { makePdf } from '../scripts/lib/minimal-pdf.mjs';

function buildBuffers() {
  return DOCUMENTS.map((doc) => ({
    name: doc.name,
    mimeType: doc.mimeType,
    buffer: doc.pdfPages ? makePdf(doc.pdfPages) : Buffer.from(doc.text, 'utf8'),
  }));
}

const normalise = (text) => String(text).toLowerCase().replace(/\s+/g, ' ');

export async function ingestCorpus({ store, retrieval, config, logger, learnerId }) {
  const ingested = [];
  for (const { name, mimeType, buffer } of buildBuffers()) {
    const result = await ingestMaterial({
      store,
      retrieval,
      config,
      logger,
      learnerId,
      buffer,
      filename: name,
      mimeType,
    });
    ingested.push({ name, ok: result.ok, status: result.material.status, passages: result.passages.length });
  }
  return ingested;
}

export async function runEvaluation({ store, retrieval, teacher, quizService, config, logger, learnerId = 'eval' }) {
  const startedAt = Date.now();
  const corpus = await ingestCorpus({ store, retrieval, config, logger, learnerId });

  const rows = [];

  for (const item of ALL_ROWS) {
    const answer = await teacher.answer({ learnerId, question: item.question, mode: 'key_points' });

    // Independent retrieval check, separate from whatever the teacher cited.
    const search = await retrieval.search({ learnerId, query: item.question, topK: config.retrieval.topK });
    const retrievedDocuments = [...new Set(search.results.map((r) => r.documentName))];

    // Verify every citation against what is actually stored on disk.
    let citationsResolve = true;
    for (const citation of answer.citations) {
      const stored = await store.readPassages(citation.materialId);
      const match = stored.find((p) => p.id === citation.passageId);
      if (!match || match.pageNumber !== citation.pageNumber || match.documentName !== citation.documentName) {
        citationsResolve = false;
      }
    }

    const expected = item.expect;
    const citedExpectedDocument = expected
      ? answer.citations.some((c) => c.documentName === expected.document)
      : false;
    const citedExpectedPage = expected?.page
      ? answer.citations.some((c) => c.documentName === expected.document && c.pageNumber === expected.page)
      : null;

    rows.push({
      id: item.id,
      question: item.question,
      category: item.category,
      note: item.note ?? null,
      supported: item.category === 'supported',
      expectedDocument: expected?.document ?? null,
      expectedPage: expected?.page ?? null,
      retrievedDocuments,
      retrievalHit: expected ? retrievedDocuments.includes(expected.document) : null,
      kind: answer.kind,
      generationMode: answer.generationMode,
      citationCount: answer.citations.length,
      citationsResolve,
      citedExpectedDocument,
      citedExpectedPage,
      mentionsExpectedContent: expected?.mustMention
        ? normalise(answer.answer).includes(normalise(expected.mustMention))
        : null,
      warnings: answer.warnings.map((w) => w.code),
    });
  }

  // --- quiz grading check, independent of question wording --------------
  const quizCheck = { generated: false, questions: 0, perfectScoreOk: false, zeroScoreOk: false, reason: null };
  const quiz = await quizService.generate({ learnerId, questionCount: 4 });
  if (quiz.ok) {
    quizCheck.generated = true;
    quizCheck.questions = quiz.quiz.questions.length;
    quizCheck.generationMode = quiz.generationMode;

    const perfect = quiz.quiz.questions.map((q) => q.answerIndex);
    const perfectScored = (await import('../server/src/quiz/scorer.js')).scoreAttempt(quiz.quiz, perfect);
    quizCheck.perfectScoreOk = perfectScored.percent === 100 && perfectScored.correctCount === quizCheck.questions;

    const wrong = quiz.quiz.questions.map((q) => (q.answerIndex + 1) % 4);
    const wrongScored = (await import('../server/src/quiz/scorer.js')).scoreAttempt(quiz.quiz, wrong);
    quizCheck.zeroScoreOk = wrongScored.percent === 0 && wrongScored.correctCount === 0;
  } else {
    quizCheck.reason = quiz.message;
  }

  const supportedRows = rows.filter((r) => r.category === 'supported');
  const unsupportedRows = rows.filter((r) => r.category === 'unsupported');
  const borderlineRows = rows.filter((r) => r.category === 'borderline');
  const pageRows = supportedRows.filter((r) => r.expectedPage !== null);

  const rate = (numerator, denominator) => (denominator === 0 ? null : Number((numerator / denominator).toFixed(4)));

  const metrics = {
    questions: rows.length,
    supportedQuestions: supportedRows.length,
    unsupportedQuestions: unsupportedRows.length,
    borderlineQuestions: borderlineRows.length,
    retrievalRecall: rate(supportedRows.filter((r) => r.retrievalHit).length, supportedRows.length),
    pageAccuracy: rate(pageRows.filter((r) => r.citedExpectedPage).length, pageRows.length),
    groundingRate: rate(supportedRows.filter((r) => r.citedExpectedDocument).length, supportedRows.length),
    contentMentionRate: rate(
      supportedRows.filter((r) => r.mentionsExpectedContent).length,
      supportedRows.filter((r) => r.mentionsExpectedContent !== null).length,
    ),
    citationResolutionRate: rate(rows.filter((r) => r.citationsResolve).length, rows.length),
    refusalRate: rate(unsupportedRows.filter((r) => r.kind === 'insufficient_material').length, unsupportedRows.length),
    falseAnswerRate: rate(unsupportedRows.filter((r) => r.kind === 'grounded').length, unsupportedRows.length),
    answeredFromMaterialRate: rate(supportedRows.filter((r) => r.kind === 'grounded').length, supportedRows.length),
    // Borderline questions are reported but never used as a pass/fail gate: the
    // honest position is that a paraphrase may reasonably be answered or
    // refused, so there is no correct target rate to assert.
    borderlineAnswered: borderlineRows.filter((r) => r.kind === 'grounded').length,
    borderlineRefused: borderlineRows.filter((r) => r.kind === 'insufficient_material').length,
    quiz: quizCheck,
    durationMs: Date.now() - startedAt,
    corpus,
    generatedAt: new Date().toISOString(),
  };

  return { metrics, rows };
}

export function toMarkdown(report, { title = 'LearnSphere AI - retrieval and grounding evaluation' } = {}) {
  const m = report.metrics;
  const pct = (v) => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`);

  const lines = [
    `# ${title}`,
    '',
    `Generated: ${m.generatedAt} · ${m.durationMs} ms · ${m.questions} questions (${m.supportedQuestions} supported, ${m.unsupportedQuestions} unsupported)`,
    '',
    '## Summary',
    '',
    '| Metric | Result | What it means |',
    '| --- | --- | --- |',
    `| Retrieval recall@k | **${pct(m.retrievalRecall)}** | The passage needed to answer the question was retrieved from the right document. |`,
    `| Page accuracy | **${pct(m.pageAccuracy)}** | Where the answer sits on a known page, that page was cited. |`,
    `| Grounding rate | **${pct(m.groundingRate)}** | A supported question was answered with a citation to the correct document. |`,
    `| Citation resolution | **${pct(m.citationResolutionRate)}** | Every citation matched a passage that really exists, on the page claimed. |`,
    `| Refusal rate (unsupported) | **${pct(m.refusalRate)}** | Questions the material cannot answer were refused. Higher is better. |`,
    `| False answer rate | **${pct(m.falseAnswerRate)}** | Unsupported questions that were answered anyway. Lower is better. |`,
    `| Content mention rate | ${pct(m.contentMentionRate)} | The expected key phrase appears in the answer. |`,
    `| Answered from material | ${pct(m.answeredFromMaterialRate)} | Supported questions that produced a grounded answer. |`,
    '',
    `Borderline (paraphrased) questions: **${m.borderlineQuestions}** total - ${m.borderlineAnswered} answered, ${m.borderlineRefused} refused. Either behaviour is acceptable for these; they are shown for transparency and are not used as a pass mark.`,
    '',
    '## Quiz grading',
    '',
    m.quiz.generated
      ? `- Generated ${m.quiz.questions} question(s) in \`${m.quiz.generationMode}\` mode.\n- All-correct submission scores 100%: **${m.quiz.perfectScoreOk ? 'yes' : 'NO'}**\n- All-wrong submission scores 0%: **${m.quiz.zeroScoreOk ? 'yes' : 'NO'}**`
      : `- Quiz generation did not run: ${m.quiz.reason}`,
    '',
    '## Per-question detail',
    '',
    '| # | Category | Retrieved right doc | Cited right doc | Right page | Result kind |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  for (const row of report.rows) {
    const yes = (v) => (v === null ? '-' : v ? 'yes' : 'no');
    lines.push(
      `| ${row.id} | ${row.category} | ${yes(row.retrievalHit)} | ${row.citedExpectedDocument ? 'yes' : 'no'} | ${yes(row.citedExpectedPage)} | ${row.kind} |`,
    );
  }

  const borderline = report.rows.filter((r) => r.category === 'borderline');
  if (borderline.length > 0) {
    lines.push('', '### Borderline questions (informational)', '', '| # | Result | Why it is borderline |', '| --- | --- | --- |');
    for (const row of borderline) lines.push(`| ${row.id} | ${row.kind} | ${row.note ?? ''} |`);
  }

  lines.push('', '## Corpus', '', '| Document | Indexed | Passages |', '| --- | --- | --- |');
  for (const doc of m.corpus) lines.push(`| ${doc.name} | ${doc.ok ? 'yes' : doc.status} | ${doc.passages} |`);
  lines.push('');

  return lines.join('\n');
}

export default { runEvaluation, toMarkdown, ingestCorpus };
