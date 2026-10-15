import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { extractText, normaliseText } from '../src/documents/extract.js';
import { chunkPages, splitSentences } from '../src/documents/chunk.js';
import { makePdf } from '../../scripts/lib/minimal-pdf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PHOTOSYNTHESIS_PAGE_1 =
  'Photosynthesis is the process by which green plants convert light energy into chemical energy.\n' +
  'The light-dependent reactions occur in the thylakoid membrane and produce ATP and NADPH.';

const PHOTOSYNTHESIS_PAGE_2 =
  'The Calvin cycle is the light-independent stage of photosynthesis.\n' +
  'It fixes carbon dioxide into glucose using the ATP and NADPH made in the light reactions.';

test('PDF: text is extracted with correct page numbers', async () => {
  const buffer = makePdf([PHOTOSYNTHESIS_PAGE_1, PHOTOSYNTHESIS_PAGE_2]);
  const result = await extractText({ buffer, filename: 'bio-notes.pdf', mimeType: 'application/pdf' });

  assert.equal(result.kind, 'pdf');
  assert.equal(result.pageCount, 2);
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[0].pageNumber, 1);
  assert.equal(result.pages[1].pageNumber, 2);
  assert.match(result.pages[0].text, /Photosynthesis is the process/);
  assert.match(result.pages[1].text, /Calvin cycle/);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.charCount > 150);
});

test('PDF: a scanned/image-only PDF warns instead of silently returning nothing', async () => {
  // A structurally valid PDF whose single page has no text-drawing operators.
  const buffer = makePdf(['']);
  const result = await extractText({ buffer, filename: 'scan.pdf', mimeType: 'application/pdf' });
  assert.equal(result.pages.length, 0);
  assert.equal(result.warnings[0]?.code, 'no_extractable_text');
  assert.match(result.warnings[0].message, /scanned or image-only/);
});

test('PDF: corrupt bytes are rejected with a clear code, not a crash', async () => {
  const buffer = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('not a real pdf body at all')]);
  await assert.rejects(
    () => extractText({ buffer, filename: 'broken.pdf', mimeType: 'application/pdf' }),
    (err) => {
      assert.equal(err.code, 'pdf_invalid');
      return true;
    },
  );
});

test('PDF: a file named .txt but starting with %PDF- is treated as a PDF', async () => {
  const buffer = makePdf(['Mislabeled but real PDF content about mitosis and the cell cycle.']);
  const result = await extractText({ buffer, filename: 'notes.txt', mimeType: 'text/plain' });
  assert.equal(result.kind, 'pdf');
  assert.match(result.pages[0].text, /mitosis/);
});

test('TXT: UTF-8 text is ingested, BOM stripped and newlines normalised', async () => {
  const buffer = Buffer.from(`\uFEFFLine one\r\n\r\nLine two\r\n`, 'utf8');
  const result = await extractText({ buffer, filename: 'notes.txt', mimeType: 'text/plain' });
  assert.equal(result.kind, 'text');
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].text, 'Line one\n\nLine two');
  assert.deepEqual(result.warnings, []);
});

test('TXT: Bangla content survives ingestion unchanged', async () => {
  const bangla = 'সালোকসংশ্লেষণ হলো সেই প্রক্রিয়া যাতে সবুজ উদ্ভিদ আলোক শক্তিকে রাসায়নিক শক্তিতে রূপান্তরিত করে।';
  const result = await extractText({ buffer: Buffer.from(bangla, 'utf8'), filename: 'bangla.txt', mimeType: 'text/plain' });
  assert.equal(result.pages[0].text, bangla);
});

test('TXT: markdown is recognised as its own kind', async () => {
  const result = await extractText({
    buffer: Buffer.from('# Heading\n\nSome notes about entropy and heat.', 'utf8'),
    filename: 'notes.md',
    mimeType: 'text/markdown',
  });
  assert.equal(result.kind, 'markdown');
});

test('Edge cases: empty file, binary file and unsupported extension', async () => {
  await assert.rejects(() => extractText({ buffer: Buffer.alloc(0), filename: 'a.txt' }), { code: 'empty_file' });

  const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x00, 0x07]);
  await assert.rejects(() => extractText({ buffer: binary, filename: 'a.txt' }), { code: 'binary_not_text' });

  await assert.rejects(
    () => extractText({ buffer: Buffer.from('x'), filename: 'a.docx', mimeType: 'application/msword' }),
    { code: 'unsupported_type' },
  );
});

test('Edge cases: a whitespace-only text file yields no pages and an empty_document warning', async () => {
  const result = await extractText({ buffer: Buffer.from('   \n\n\t  ', 'utf8'), filename: 'blank.txt' });
  assert.equal(result.pages.length, 0);
  assert.equal(result.warnings[0].code, 'empty_document');
});

test('normaliseText strips zero-width and bidi-override characters used to hide text', () => {
  const input = 'visible\u200B\u202E hidden \uFEFF text\u0000';
  const out = normaliseText(input);
  assert.equal(out, 'visible hidden text');
  assert.ok(!/[\u200B\u202E\uFEFF\u0000]/.test(out));
});

test('chunking preserves page numbers and never lets a citation point at the wrong page', () => {
  const pages = [
    { pageNumber: 1, text: 'Alpha paragraph one. '.repeat(30) },
    { pageNumber: 2, text: 'Beta paragraph two. '.repeat(30) },
  ];
  const passages = chunkPages(pages, { materialId: 'm1', documentName: 'doc.pdf' });

  assert.ok(passages.length >= 2);
  const page1 = passages.filter((p) => p.pageNumber === 1);
  const page2 = passages.filter((p) => p.pageNumber === 2);
  assert.ok(page1.length >= 1 && page2.length >= 1);
  for (const p of page1) assert.match(p.text, /Alpha/);
  for (const p of page2) assert.match(p.text, /Beta/);
  for (const p of passages) assert.match(p.id, /^m1-p[12]-\d+$/);
});

test('chunking splits oversized passages at sentence boundaries and keeps ids unique', () => {
  const longSentence = 'The mitochondria generates most of the chemical energy needed to power the cell biochemistry. ';
  const pages = [{ pageNumber: 3, text: longSentence.repeat(40) }];
  const passages = chunkPages(pages, { materialId: 'abc', documentName: 'cells.pdf' });

  assert.ok(passages.length > 1, 'a 5000-character page should produce multiple passages');
  const ids = passages.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'passage ids must be unique');
  assert.ok(passages.every((p) => p.charCount <= 1600), 'passages stay near the target size');
  assert.ok(passages.every((p) => p.pageNumber === 3));
});

test('chunking detects a heading and records it for citation context', () => {
  const pages = [{ pageNumber: 1, text: 'Thermodynamics\n\nThe second law states that entropy in an isolated system never decreases over time.' }];
  const passages = chunkPages(pages, { materialId: 'm2', documentName: 'phys.pdf' });
  assert.equal(passages[0].heading, 'Thermodynamics');
});

test('chunking strips markdown decoration so a heading is readable', () => {
  const pages = [
    {
      pageNumber: 1,
      text: '# Database transactions — study notes\n\nA database transaction is a sequence of operations performed as a single logical unit of work.',
    },
  ];
  const passages = chunkPages(pages, { materialId: 'md1', documentName: 'db.md' });
  assert.equal(passages[0].heading, 'Database transactions — study notes');
  for (const passage of passages) {
    assert.ok(
      passage.heading === null || !passage.heading.startsWith('#'),
      `a heading kept its markdown marker: ${JSON.stringify(passage.heading)}`,
    );
  }
});

test('chunking does not turn a leaked overlap line into a heading', () => {
  // A chunk can start with the previous chunk's overlap sentence immediately
  // followed by the next markdown heading on the same line. That is prose, and
  // reporting it as a heading put "This works well when conflicts are rare.
  // ## Write-ahead logging" into citations and quiz topics.
  const pages = [
    {
      pageNumber: 1,
      text: 'This works well when conflicts are rare. ## Write-ahead logging and recovery\nA write-ahead log records every change before the changed page reaches disk.',
    },
  ];
  const passages = chunkPages(pages, { materialId: 'md2', documentName: 'db.md' });
  assert.equal(passages[0].heading, null);
});

test('splitSentences handles Latin and Bangla terminators together', () => {
  const parts = splitSentences('প্রথম। দ্বিতীয়। Third. Fourth!');
  assert.equal(parts.length, 4);
});

test('real bundled sample PDF, if generated, extracts cleanly', async (t) => {
  const samplePath = path.resolve(__dirname, '../../samples/information-retrieval-notes.pdf');
  try {
    await fs.access(samplePath);
  } catch {
    t.skip('sample PDF not generated yet - run npm run samples:seed');
    return;
  }
  const buffer = await fs.readFile(samplePath);
  const result = await extractText({ buffer, filename: 'information-retrieval-notes.pdf' });
  assert.ok(result.pageCount >= 1);
  assert.ok(result.charCount > 300);
  assert.match(result.pages[0].text, /retrieval|precision|recall/i);
});

test('extraction writes no temporary files to disk', async (t) => {
  // Guards against accidental writes: extraction must be pure and touch no disk.
  //
  // Snapshotting the machine-wide temp directory would be racy: `node --test`
  // runs test files in parallel, and the API suites create their own temp data
  // directories in the same window, so unrelated entries appear between the two
  // reads. Instead, point TMPDIR/TEMP/TMP at a private empty directory for the
  // duration of the call, so any file extraction wrote would land somewhere we
  // control and can assert against.
  const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learnsphere-extract-check-'));
  const previousEnv = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = privateDir;
  process.env.TEMP = privateDir;
  process.env.TMP = privateDir;

  t.after(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(privateDir, { recursive: true, force: true });
  });

  const result = await extractText({ buffer: Buffer.from('pure function check'), filename: 'x.txt' });
  assert.equal(result.pages[0].text, 'pure function check');

  assert.deepEqual(await fs.readdir(privateDir), [], 'extraction must not write any temporary file');
});
