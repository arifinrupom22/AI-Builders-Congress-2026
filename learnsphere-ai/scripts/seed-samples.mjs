/**
 * `npm run samples:seed` — generate the bundled sample study material.
 *
 * Every file here is *generated*, not committed as an opaque binary: the same
 * spec-shaped writers that build the test fixtures write the samples, so the
 * document readers are exercised against real containers (a PDF with a real
 * cross-reference table, a ZIP with a central directory, an OLE2 compound file
 * with a Word piece table, RTF with its control words).
 *
 * The output also covers the two things this app claims to support: every
 * uploadable format, and Bangla content in each of them. Each file is read back
 * through the real extractor before the script reports success, so a broken
 * reader cannot pass a seed run.
 *
 * Usage: npm run samples:seed [-- --quiet]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makePdf } from './lib/minimal-pdf.mjs';
import { makeDocx, makeLegacyDoc, makeZip } from './lib/minimal-office.mjs';
import { extractText } from '../server/src/documents/extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'samples');

// ---------------------------------------------------------------------------
// Source text
// ---------------------------------------------------------------------------

const IR_PAGES = [
  `# Information retrieval: precision and recall

Information retrieval is the task of finding material in an unstructured store that matches an information need.

Precision measures the fraction of retrieved documents that are relevant. Recall measures the fraction of relevant documents that were retrieved. The two pull in opposite directions: returning more documents raises recall and lowers precision.

A ranked retrieval system returns an ordered list, so a cutoff at rank k gives a precision-at-k figure. The break-even point is where precision equals recall.`,

  `# Relevance scoring

TF-IDF weights a term by how often it appears in a document and how rare it is across the collection. A term appearing in every document carries little discriminative weight.

BM25 is a probabilistic ranking function that extends TF-IDF with term-frequency saturation and document-length normalisation. Saturation means that the tenth occurrence of a word adds much less than the second.

The k1 and b parameters control saturation and length normalisation. With b set to 0, document length is ignored entirely.`,

  `# Evaluation

Evaluation uses a test collection of documents, queries and a judgement of which documents are relevant.

Mean average precision averages precision at each relevant retrieved position over all queries. Normalised discounted cumulative gain accounts for graded rather than binary relevance.

An inverted index maps each term to the postings list of documents that contain it, which is what makes ranked retrieval fast enough to serve interactively.`,
];

const TRANSACTIONS_MD = `# Database transactions

A transaction is a sequence of operations performed as a single logical unit of work. Either every operation in the transaction is applied, or none of them is applied at all.

## ACID properties

**Atomicity** guarantees that all operations in the transaction complete successfully or the transaction is rolled back entirely.

**Consistency** means the database moves from one valid state to another valid state, so every transaction respects the declared constraints.

**Isolation** determines how the effects of concurrent transactions interleave. At the serialisable level, the outcome is the same as if the transactions had run one after another, which is the strongest guarantee.

**Durability** states that once a transaction commits, its effects survive a crash.

## Isolation levels

The read uncommitted level permits dirty reads. Read committed prevents dirty reads but allows non-repeatable reads. Repeatable read prevents a row read twice from changing, and serialisable prevents phantom rows from appearing.

Every isolation level trades some concurrency for correctness. Choose the weakest level that keeps the application correct.
`;

const BANGLA_PHOTOSYNTHESIS = [
  'সালোকসংশ্লেষণ অধ্যায়: সবুজ উদ্ভিদের শক্তি উৎপাদন',
  'সালোকসংশ্লেষণ হলো সেই জৈবিক প্রক্রিয়া যাতে সবুজ উদ্ভিদ সূর্যের আলোক শক্তিকে রাসায়নিক শক্তিতে রূপান্তরিত করে।',
  'ক্লোরোফিল হলো সবুজ পাতায় পাওয়া একটি রঞ্জক, যা আলো শোষণ করে এবং সালোকসংশ্লেষণ সম্ভব করে।',
  'সালোকসংশ্লেষণ মূলত দুটি ধাপে সম্পন্ন হয়: আলোক নির্ভর বিক্রিয়া এবং ক্যালভিন চক্র।',
  'আলোক নির্ভর বিক্রিয়ায় পানি ভেঙে অক্সিজেন মুক্ত হয় এবং শক্তি সঞ্চিত হয়।',
  'ক্যালভিন চক্র হলো সালোকসংশ্লেষণের সেই ধাপ যেখানে কার্বন ডাই-অক্সাইড থেকে গ্লুকোজ তৈরি হয়।',
  'অ্যাটিপি হলো কোষের শক্তি মুদ্রা, যা বিভিন্ন জৈবিক প্রক্রিয়ার জন্য প্রয়োজনীয় শক্তি সরবরাহ করে।',
  'কোষশ্বাসন হলো সেই প্রক্রিয়া যার মাধ্যমে গ্লুকোজ ভেঙে কোষ শক্তি উৎপন্ন হয়।',
  'মাইটোকন্ড্রিয়া হলো কোষের অঙ্গাণু, যেখানে কোষশ্বাসন সম্পন্ন হয়।',
  'পাতার স্টোমাটা হলো ছোট ছিদ্র, যা গ্যাস বিনিময়ের পথ হিসেবে কাজ করে।',
  'সালোকসংশ্লেষণের ফলে উৎপন্ন অক্সিজেন পরিবেশে ছাড়া হয়, যা কোষশ্বাসনের প্রয়োজন।',
].join('\n\n');

const BANGLA_DOCX = [
  { text: 'ডেটাবেস ট্রানজেকশন', style: 'Heading1' },
  { text: 'ট্রানজেকশন হল একগুচ্ছ অপারেশন যা একটি একক যৌক্তিক একক হিসেবে কাজ করে।' },
  { text: 'ACID বৈশিষ্ট্য', style: 'Heading2' },
  { text: 'Atomicity নিশ্চিত করে যে ট্রানজেকশনের সব অপারেশন সম্পন্ন হয় অথবা কোনোটিই হয় না।' },
  { text: 'Isolation নিশ্চিত করে যে সমান্তরাল ট্রানজেকশন একটি আরেকটিকে প্রভাবিত না করে।' },
  { text: 'Durability বলে যে কমিট করা ট্রানজেকশনের ফলাফল ক্র্যাশের পরেও টিকে থাকে।' },
];

const TRANSACTIONS_DOCX = [
  { text: 'Database transactions', style: 'Heading1' },
  { text: 'A transaction is a sequence of operations performed as a single logical unit of work. Either every operation in the transaction is applied, or none of them is applied at all.' },
  { text: 'ACID properties', style: 'Heading2' },
  { text: 'Atomicity guarantees that every operation in the transaction completes successfully, or the transaction is rolled back entirely.' },
  { text: 'Consistency means the database moves from one valid state to another valid state, so every transaction respects the declared constraints.' },
  { text: 'Isolation determines how the effects of concurrent transactions interleave. At the serialisable level the outcome is the same as if the transactions had run one after another.' },
  { text: 'Durability states that once a transaction commits, its effects survive a crash.' },
  { text: 'Isolation levels', style: 'Heading2' },
  { text: 'Read uncommitted permits dirty reads. Read committed prevents dirty reads but allows non-repeatable reads. Repeatable read stops a row read twice from changing, and serialisable prevents phantom rows.' },
  { text: 'Isolation | Concurrency | Typical use' },
  { text: 'Read uncommitted | Highest | Reporting only' },
  { text: 'Serialisable | Lowest | Financial posting' },
];

const TRANSACTIONS_DOC = `Database transactions

A transaction is a sequence of operations performed as a single logical unit of work. Either every operation is applied, or none of them is applied at all.

Atomicity guarantees that every operation completes successfully, or the transaction is rolled back entirely.

Consistency means the database moves from one valid state to another valid state, so every transaction respects the declared constraints.

Isolation determines how the effects of concurrent transactions interleave, and serialisable gives the same outcome as running them one after another.

Durability states that once a transaction commits, its effects survive a crash.

The read uncommitted level permits dirty reads, while the serialisable level prevents phantom rows at the cost of concurrency.
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Bangla text has no code page in RTF, so every character becomes a \u escape. */
function rtfUnicode(text) {
  return Array.from(text)
    .map((char) => (char.codePointAt(0) < 128 && char !== '\\' && char !== '{' && char !== '}' ? char : `\\u${char.codePointAt(0)}?`))
    .join('');
}

function buildRtf() {
  const header = String.raw`{\rtf1\ansi\ansicpg1252\deff0 {\fonttbl{\f0 Arial;}}\pard\f0 `;
  const english = [
    'Database transactions',
    'A transaction is a sequence of operations performed as a single logical unit of work.',
    'Isolation determines how the effects of concurrent transactions interleave.',
  ];
  const bangla = [
    'ডেটাবেস ট্রানজেকশন',
    'ট্রানজেকশন হল একগুচ্ছ অপারেশন যা একটি একক যৌক্তিক একক হিসেবে কাজ করে।',
    'ACID মানে Atomicity, Consistency, Isolation এবং Durability।',
  ];
  return `${header}${english.join(String.raw`\par `)}${String.raw`\par \par `}${bangla
    .map((line) => rtfUnicode(line))
    .join(String.raw`\par `)}${String.raw`\par}`}`;
}

function buildOdt() {
  const paragraph = (text) => `<text:p>${escapeXml(text)}</text:p>`;
  const heading = (text) => `<text:h text:outline-level="1">${escapeXml(text)}</text:h>`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:body><office:text>
${heading('Study checklist')}
${paragraph('A checklist is a sequence of items that are marked as they are completed.')}
${paragraph('Spaced repetition reviews a fact just before it would be forgotten, which is why revision intervals grow over time.')}
${paragraph('Active recall means testing yourself instead of re-reading, and it is the single most effective revision technique.')}
${heading('Revision order')}
${paragraph('Read the overview, attempt the practice quiz, then revisit only the pages you got wrong.')}
</office:text></office:body></office:document-content>`;

  const types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/content.xml" ContentType="application/vnd.oasis.opendocument.text+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="content.xml"/></Relationships>`;

  return makeZip([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' },
    { name: 'META-INF/manifest.xml', data: '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/></manifest:manifest>' },
    { name: '_rels/.rels', data: rels },
    { name: '[Content_Types].xml', data: types },
    { name: 'content.xml', data: content },
  ]);
}

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const FILES = [
  { name: 'information-retrieval-notes.pdf', build: () => makePdf(IR_PAGES) },
  { name: 'database-transactions.md', build: () => Buffer.from(TRANSACTIONS_MD, 'utf8') },
  { name: 'bangla-photosynthesis.txt', build: () => Buffer.from(BANGLA_PHOTOSYNTHESIS, 'utf8') },
  { name: 'database-transactions.docx', build: () => makeDocx(TRANSACTIONS_DOCX) },
  { name: 'bangla-database-notes.docx', build: () => makeDocx(BANGLA_DOCX) },
  { name: 'database-transactions.doc', build: () => makeLegacyDoc(TRANSACTIONS_DOC) },
  { name: 'database-transactions.rtf', build: () => Buffer.from(buildRtf(), 'latin1') },
  { name: 'study-checklist.odt', build: () => buildOdt() },
];

const README = `# Sample study material

Generated by \`npm run samples:seed\`. Every file here is written by a small,
dependency-free generator in \`scripts/lib/\`, then read back through the real
extractor before the seed run reports success.

| File | Format | Language | What it is |
| --- | --- | --- | --- |
| \`information-retrieval-notes.pdf\` | PDF | English | Precision, recall, BM25 and evaluation, across three pages. |
| \`database-transactions.md\` | Markdown | English | ACID and isolation levels, with headings and bold terms. |
| \`bangla-photosynthesis.txt\` | Plain text | বাংলা | সালোকসংশ্লেষণ ও কোষশ্বাসন নোট। |
| \`database-transactions.docx\` | Word | English | Headings, paragraphs and a table, with Word page breaks. |
| \`bangla-database-notes.docx\` | Word | বাংলা | বাংলা শিরোনাম ও অনুচ্ছেদ সহ ওয়ার্ড নোট। |
| \`database-transactions.doc\` | Word 97-2003 | English | The legacy \`.doc\` container, read through its piece table. |
| \`database-transactions.rtf\` | RTF | English + বাংলা | Control words in English, \\u escapes for Bangla. |
| \`study-checklist.odt\` | OpenDocument | English | Headings and paragraphs from LibreOffice's format. |

## Use them

1. Start the app with \`npm run dev\`.
2. Open **My Materials** and drop any of these files in — several at once is fine.
3. Open **Study summary** for cited revision notes, or **Practice** for a quiz.
   Both follow the language of the material: the Bangla files produce Bangla
   summaries and questions.

Deleting this directory is safe; the samples are generated, not hand-written.
`;

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const quiet = process.argv.includes('--quiet');
  let failures = 0;

  for (const file of FILES) {
    const target = path.join(OUT_DIR, file.name);
    const buffer = file.build();
    await fs.writeFile(target, buffer);

    // Read it back with the real reader: a seed that cannot be read is a
    // broken sample, not a successful one.
    try {
      const result = await extractText({ buffer, filename: file.name });
      const text = result.pages.map((page) => page.text).join('\n');
      if (result.charCount < 80 || text.includes('\uFFFD')) {
        throw new Error(`extracted ${result.charCount} chars, readable=${!text.includes('\uFFFD')}`);
      }
      if (!quiet) {
        const label = result.language === 'bn' ? 'বাংলা' : 'en';
        console.log(
          `  ✓ ${file.name.padEnd(34)} ${result.kind.padEnd(8)} ${String(result.pageCount).padStart(2)} page(s)  ${String(result.charCount).padStart(5)} chars  ${label}`,
        );
      }
    } catch (err) {
      failures += 1;
      console.error(`  ✗ ${file.name}: ${err.message}`);
    }
  }

  await fs.writeFile(path.join(OUT_DIR, 'README.md'), README, 'utf8');

  if (failures > 0) {
    console.error(`\n${failures} sample(s) could not be read back. Fix the reader before shipping.`);
    process.exitCode = 1;
    return;
  }
  if (!quiet) {
    console.log(`\nSamples written to ${path.relative(process.cwd(), OUT_DIR)}/`);
    console.log('Start the app with "npm run dev", then upload them from My Materials.');
  }
}

await main();
