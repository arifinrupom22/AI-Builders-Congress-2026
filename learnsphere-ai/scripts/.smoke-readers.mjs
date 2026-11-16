// Temporary smoke check for the new document readers. Deleted after use.
import { makeDocx, makeLegacyDoc } from './lib/minimal-office.mjs';
import { extractText } from '../server/src/documents/extract.js';

const BANGLA = [
  'অধ্যায় ১: ডেটাবেস ট্রানজেকশন',
  'ট্রানজেকশন হল একগুচ্ছ অপারেশন যা একটি একক যৌক্তিক একক হিসেবে কাজ করে।',
  'ACID মানে Atomicity, Consistency, Isolation এবং Durability।',
  'Isolation নিশ্চিত করে যে সমান্তরাল ট্রানজেকশন একটি আরেকটিকে প্রভাবিত না করে।',
].join('\n');

const ENGLISH = [
  { text: 'Database transactions', style: 'Heading1' },
  { text: 'A transaction is a unit of work that either completes entirely or not at all.' },
  { text: 'Isolation levels trade consistency for concurrency.' },
  { text: 'কপাল | লেখা | টেবিল' },
];

function report(label, result) {
  const flat = result.pages.map((p) => p.text).join('\n');
  console.log(`\n=== ${label} ===`);
  console.log('kind:', result.kind, '| pages:', result.pageCount, '| chars:', result.charCount, '| lang:', result.language);
  console.log('warnings:', result.warnings.map((w) => w.code).join(', ') || '(none)');
  console.log('text:', JSON.stringify(flat.slice(0, 260)));
}

const cases = [
  ['docx english', makeDocx(ENGLISH), { filename: 'notes.docx' }],
  ['docx bangla', makeDocx([{ text: 'ডেটাবেস', style: 'Heading1' }, ...BANGLA.split('\n')]), { filename: 'bangla.docx' }],
  ['doc english', makeLegacyDoc('Database transactions\nA transaction is atomic.\nIsolation keeps them apart.'), { filename: 'old.doc' }],
  ['doc bangla', makeLegacyDoc(BANGLA), { filename: 'bangla.doc' }],
  ['rtf', Buffer.from('{\\rtf1\\ansi\\ansicpg1252\\deff0 {\\fonttbl{\\f0 Arial;}}\\pard\\f0 Database transactions\\par A transaction is atomic.\\par}'), { filename: 'a.rtf' }],
  [
    'rtf bangla (\\u escapes)',
    Buffer.from('{\\rtf1\\ansi\\ansicpg1252\\u2476?\\u2494?\\u2434?\\u2482?\\u2494?}'),
    { filename: 'b.rtf' },
  ],
  [
    'rtf bangla (utf8 bytes)',
    Buffer.from(String.raw`{\rtf1\ansi\ansicpg65001\pard \'e0\'a6\'ac\'e0\'a6\'be\par}`),
    { filename: 'c.rtf' },
  ],
  ['text bangla', Buffer.from(BANGLA, 'utf8'), { filename: 'bangla.txt' }],
  ['md', Buffer.from('# Heading\n\nSome paragraph text here.'), { filename: 'a.md' }],
];

for (const [label, buffer, extra] of cases) {
  try {
    report(label, await extractText({ buffer, ...extra, mimeType: '' }));
  } catch (err) {
    console.log(`\n=== ${label} ===`);
    console.log('ERROR', err.code, err.message);
  }
}
