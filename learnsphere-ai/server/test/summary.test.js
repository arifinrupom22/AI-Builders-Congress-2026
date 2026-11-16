/**
 * Summary generation: coverage sampling, key-term extraction and the API
 * contract the Study summary page depends on.
 *
 * Everything here runs in offline demo mode, so the assertions are about the
 * guarantees that hold with or without an API key: whole-document coverage,
 * citations that point at passages that really were supplied, and honest
 * provenance about how the text was produced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHarness, SAMPLE_TEXT } from './helpers/harness.js';
import { selectSpread, buildLocalSummary } from '../src/summary/service.js';
import { extractKeyTerms } from '../src/ai/keyterms.js';

function fakePassages(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `m1-p1-${index}`,
    materialId: 'm1',
    documentName: 'long.pdf',
    pageNumber: 1,
    index,
    text: `Passage ${index} about transactions and isolation in databases. `.repeat(12),
  }));
}

test('selectSpread samples across the whole document instead of taking the head', () => {
  const passages = fakePassages(40);
  const { selected, truncated } = selectSpread(passages, 4000);

  assert.ok(truncated, 'a long document over budget is reported as sampled');
  assert.ok(selected.length > 1 && selected.length < passages.length);
  assert.equal(selected[0].index, 0, 'the opening is always covered');
  assert.ok(selected.at(-1).index >= 30, 'the closing is always covered too');
  const indexes = selected.map((p) => p.index);
  assert.deepEqual([...indexes].sort((a, b) => a - b), indexes, 'sampling preserves document order');
  // Coverage, not stride: every third of the document must be represented and
  // no run of the document may be left entirely unrepresented.
  const thirds = [0, 1, 2].map((third) => {
    const from = Math.floor((third * passages.length) / 3);
    const to = Math.floor(((third + 1) * passages.length) / 3);
    return indexes.some((index) => index >= from && index < to);
  });
  assert.deepEqual(thirds, [true, true, true], `every third of the document must be sampled, got ${indexes}`);
  for (let i = 1; i < indexes.length; i += 1) {
    assert.ok(indexes[i] - indexes[i - 1] <= passages.length / 2, 'no half of the document is skipped');
  }
});

test('selectSpread keeps every passage when the document already fits the budget', () => {
  const passages = fakePassages(3);
  const { selected, truncated } = selectSpread(passages, 100_000);
  assert.equal(truncated, false);
  assert.equal(selected.length, 3);
});

test('extractKeyTerms finds the repeated subject and ranks boilerplate last', () => {
  const passages = Array.from({ length: 6 }, (_, index) => ({
    id: `m-p1-${index}`,
    materialId: 'm',
    documentName: 'db-notes.md',
    pageNumber: 1,
    index,
    heading: index === 0 ? 'Database transactions' : null,    // "section" occurs in every passage, so it is structure; "transaction"
    // occurs in most of them, so it is subject matter.
    text: [
      `Section ${index + 1} of the database notes.`,
      index < 4
        ? 'A transaction groups operations into one unit of work, and the transaction log records every change.'
        : 'A unit of work groups several operations together, and every change is recorded.',
      index < 4
        ? 'The isolation level decides how concurrent transactions may overlap.'
        : 'The isolation level decides how concurrent work may overlap.',
      'Nothing else is recorded in this section.',
    ].join(' '),
  }));

  const terms = extractKeyTerms(passages, { limit: 6 });
  const labels = terms.map((t) => t.term.toLowerCase());

  assert.ok(labels.some((t) => t.includes('transaction')), `expected a transaction term in ${labels.join(', ')}`);
  const transactionRank = labels.findIndex((t) => t.includes('transaction'));
  const sectionRank = labels.findIndex((t) => t.includes('section'));
  if (sectionRank !== -1) {
    assert.ok(transactionRank < sectionRank, 'a term in every passage must rank below the subject term');
  }
  for (const term of terms) {
    assert.ok(term.count >= 2, `${term.term} should repeat`);
    assert.ok(term.documentName === null || term.pageNumber >= 1, 'a term must point at a real source');
  }
});

test('extractKeyTerms returns nothing for an empty library rather than inventing terms', () => {
  assert.deepEqual(extractKeyTerms([]), []);
});

test('buildLocalSummary cites only supplied passages and covers the requested detail', () => {
  const passages = fakePassages(6).map((p, index) => ({ ...p, idHint: `S${index + 1}` }));
  const brief = buildLocalSummary({ passages, length: 'brief', language: 'en', keyTerms: [], documents: ['long.pdf'] });
  const detailed = buildLocalSummary({
    passages,
    length: 'detailed',
    language: 'en',
    keyTerms: [],
    documents: ['long.pdf'],
  });

  assert.match(brief.markdown, /\*\*Overview\*\*/);
  assert.match(brief.markdown, /\*\*Key points\*\*/);
  assert.ok(brief.picked.length >= 1 && brief.picked.length <= 4, 'brief stays short');
  assert.ok(detailed.picked.length > brief.picked.length, 'detailed covers more of the document');
  assert.match(brief.markdown, /\[S\d+\]/, 'the local summary cites the short ids the API exposes');
  const lines = brief.markdown.split('\n');
  const overview = lines[1] ?? '';
  const bullets = lines.filter((line) => line.startsWith('- '));
  assert.ok(bullets.length >= 1, 'at least one key point is listed');
  assert.ok(
    !bullets.includes(`- ${overview}`),
    'the overview sentence must not be repeated as a key point under itself',
  );
  assert.ok(overview.length > 10, 'an overview is actually produced');
  assert.match(brief.markdown, /No AI model was used/);
});

test('summary: an empty library is refused with a reason the UI can show', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const res = await h.api.post('/api/summary', { length: 'brief' });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'no_materials');
  assert.match(res.body.error.message, /Upload a document first/);
});

test('summary: a plain-text document summarises with verified citations and honest provenance', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const upload = await h.api.upload('photosynthesis.txt', Buffer.from(SAMPLE_TEXT, 'utf8'), { mimeType: 'text/plain' });
  assert.equal(upload.status, 201);

  const res = await h.api.post('/api/summary', { length: 'standard' });
  assert.equal(res.status, 200);

  const { summary, citations, keyTerms, generationMode, provenance, stats, language } = res.body;
  assert.equal(generationMode, 'demo');
  assert.equal(language, 'en');
  assert.match(summary, /\*\*Overview\*\*/);
  assert.match(summary, /\*\*Key points\*\*/);
  assert.match(summary, /\*\*Key terms\*\*/);
  assert.match(summary, /\*\*Study order\*\*/);

  assert.ok(citations.length >= 1, 'a summary must cite where it came from');
  for (const citation of citations) {
    assert.equal(citation.documentName, 'photosynthesis.txt');
    assert.ok(citation.pageNumber >= 1);
    assert.ok(citation.snippet.length > 0);
  }

  assert.ok(keyTerms.length >= 1, 'key terms come from the material, deterministically');
  assert.equal(stats.documents[0], 'photosynthesis.txt');
  assert.ok(stats.passagesUsed >= 1);
  assert.match(provenance, /No AI provider key|No AI model|locally/i);
  assert.match(provenance, /checked against the passages/i, 'the client is told how citations were validated');
});

test('summary: material written in Bangla produces a Bangla summary', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const bangla = [
    'সালোকসংশ্লেষণ হলো সেই প্রক্রিয়া যাতে সবুজ উদ্ভিদ আলোক শক্তিকে রাসায়নিক শক্তিতে রূপান্তরিত করে।',
    'এই প্রক্রিয়ায় ক্লোরোফিল নামক রঞ্জক সূর্যের আলো শোষণ করে।',
    'ক্যালভিন চক্রে কার্বন ডাই-অক্সাইড থেকে গ্লুকোজ তৈরি হয়।',
    'কোষশ্বাসনের ফলে গ্লুকোজ থেকে শক্তি মুক্ত হয় এবং ATP তৈরি হয়।',
  ].join('\n\n');

  const upload = await h.api.upload('bangla-notes.txt', Buffer.from(bangla, 'utf8'), { mimeType: 'text/plain' });
  assert.equal(upload.status, 201);
  assert.equal(upload.body.material.language, 'bn', 'the material records the language it is written in');

  const res = await h.api.post('/api/summary', { length: 'brief' });
  assert.equal(res.status, 200);
  assert.equal(res.body.language, 'bn');
  assert.match(res.body.summary, /সারসংক্ষেপ|মূল বিষয়/, 'the section headings follow the material');
  assert.ok(res.body.keyTerms.length >= 1, 'Bangla terms are extracted too');
});

test('summary: the caller can override the language and narrow it to selected material', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const first = await h.api.upload(
    'biology.txt',
    Buffer.from('Photosynthesis converts light into chemical energy stored in glucose.', 'utf8'),
    { mimeType: 'text/plain' },
  );
  await h.api.upload(
    'chemistry.txt',
    Buffer.from('A catalyst lowers the activation energy of a reaction without being consumed.', 'utf8'),
    { mimeType: 'text/plain' },
  );
  assert.equal(first.status, 201);

  const res = await h.api.post('/api/summary', {
    materialIds: [first.body.material.id],
    language: 'en',
    length: 'brief',
    focus: 'focus on the exam topics',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.language, 'en');
  assert.ok(
    res.body.citations.every((c) => c.documentName === 'biology.txt'),
    'a filtered summary must only cite the selected document',
  );
  assert.equal(res.body.stats.documents.length, 1);

  const badId = await h.api.post('/api/summary', { materialIds: ['not-a-uuid'] });
  assert.equal(badId.status, 400, 'an unusable material id is a bad request, not a silent full-library summary');
});

test('summary: selected material with nothing indexed says so instead of failing generically', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  // A whitespace-only file is stored but produces no passages.
  const upload = await h.api.upload('blank.txt', Buffer.from('   \n\n  '), { mimeType: 'text/plain' });
  assert.ok(upload.status === 422, 'an empty document is reported at upload time');

  const res = await h.api.post('/api/summary', {});
  assert.equal(res.status, 422);
  assert.ok(['no_passages', 'no_materials'].includes(res.body.error.code));
});

test('summary: option lengths are advertised for the UI', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const res = await h.api.get('/api/summary/meta/options');
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.lengths.map((l) => l.id),
    ['brief', 'standard', 'detailed'],
  );
  assert.equal(res.body.defaultLength, 'standard');
});
