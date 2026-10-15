/**
 * Materials API tests, driven over real HTTP against the real app.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, SAMPLE_TEXT } from './helpers/harness.js';
import { makePdf } from '../../scripts/lib/minimal-pdf.mjs';
import { makeDocx, makeLegacyDoc } from '../../scripts/lib/minimal-office.mjs';
import { SUPPORTED_EXTENSIONS } from '../src/documents/extract.js';

const NOTES = `Thermodynamics is the branch of physics that deals with heat, work and temperature.

The first law of thermodynamics states that energy cannot be created or destroyed in an isolated system.

The second law states that the entropy of an isolated system always increases over time.

Entropy is a measure of the number of microscopic configurations that correspond to a thermodynamic system.`;

test('upload -> list -> inspect -> delete: the full material lifecycle', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const upload = await h.api.upload('thermo.txt', Buffer.from(NOTES, 'utf8'), { mimeType: 'text/plain' });
  assert.equal(upload.status, 201);
  const id = upload.body.material.id;
  assert.equal(upload.body.material.status, 'ready');
  assert.equal(upload.body.material.name, 'thermo.txt');
  assert.ok(upload.body.material.passageCount >= 1);
  assert.match(upload.body.provenance, /indexed/);

  const list = await h.api.get('/api/materials');
  assert.equal(list.status, 200);
  assert.equal(list.body.materials.length, 1);
  assert.equal(list.body.index.indexedPassages, upload.body.material.passageCount);

  const detail = await h.api.get(`/api/materials/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.material.name, 'thermo.txt');
  assert.ok(Array.isArray(detail.body.outline));

  const passages = await h.api.get(`/api/materials/${id}/passages?page=1&limit=2`);
  assert.equal(passages.status, 200);
  assert.ok(passages.body.passages.length >= 1);
  assert.equal(passages.body.passages[0].pageNumber, 1);

  const removed = await h.api.del(`/api/materials/${id}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted, true);

  const after = await h.api.get('/api/materials');
  assert.equal(after.body.materials.length, 0);
});

test('a PDF upload is indexed with real page numbers', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const pdf = makePdf([
    'Mitosis is the process of cell division that produces two genetically identical daughter cells.',
    'Meiosis produces four genetically distinct gametes and halves the chromosome number.',
  ]);
  const upload = await h.api.upload('cell-biology.pdf', pdf, { mimeType: 'application/pdf' });
  assert.equal(upload.status, 201);
  assert.equal(upload.body.material.kind, 'pdf');
  assert.equal(upload.body.material.pageCount, 2);

  const passages = await h.api.get(`/api/materials/${upload.body.material.id}/passages?limit=10`);
  const pages = passages.body.passages.map((p) => p.pageNumber);
  assert.deepEqual([...new Set(pages)].sort(), [1, 2]);
  const page2 = passages.body.passages.find((p) => p.pageNumber === 2);
  assert.match(page2.text, /Meiosis/);
});

test('validation: unsupported type, empty file and oversize file are refused with clear codes', async (t) => {
  const h = await createHarness({ env: { upload: { maxBytes: 2048 } } });
  t.after(() => h.close());

  const wrongType = await h.api.upload('notes.docx', Buffer.from('hello world'));
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.body.error.code, 'unsupported_type');

  const empty = await h.api.upload('empty.txt', Buffer.alloc(0), { mimeType: 'text/plain' });
  assert.equal(empty.status, 415);
  assert.equal(empty.body.error.code, 'empty_file');

  const big = await h.api.upload('big.txt', Buffer.from('a'.repeat(5000)), { mimeType: 'text/plain' });
  assert.equal(big.status, 413);
  assert.equal(big.body.error.code, 'payload_too_large');
});

test('validation: a scanned PDF is stored, listed and explained rather than silently ignored', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const upload = await h.api.upload('scan.pdf', makePdf(['']), { mimeType: 'application/pdf' });
  assert.equal(upload.status, 422);
  assert.equal(upload.body.material.status, 'empty');
  assert.match(upload.body.error.message, /scanned|image-only|no selectable text/i);

  const list = await h.api.get('/api/materials');
  assert.equal(list.body.materials.length, 1, 'the failed upload is visible so the student can act on it');
  assert.equal(list.body.materials[0].status, 'empty');
});

test('validation: a corrupt PDF is stored as failed with a readable reason', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const upload = await h.api.upload('corrupt.pdf', Buffer.from('%PDF-1.4\ngarbage that is not a pdf'), {
    mimeType: 'application/pdf',
  });
  assert.equal(upload.status, 422);
  assert.equal(upload.body.material.status, 'failed');
  assert.match(upload.body.error.message, /corrupt/i);
});

test('duplicate detection: uploading identical bytes twice is refused with the existing id', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const first = await h.api.upload('thermo.txt', Buffer.from(NOTES, 'utf8'), { mimeType: 'text/plain' });
  assert.equal(first.status, 201);

  const second = await h.api.upload('thermo-copy.txt', Buffer.from(NOTES, 'utf8'), { mimeType: 'text/plain' });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'duplicate_material');
  assert.equal(second.body.error.details.existingMaterialId, first.body.material.id);
});

test('a file with a path-traversal name is stored under a generated id, not the supplied name', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const upload = await h.api.upload('../../../../etc/passwd.txt', Buffer.from('root:x:0:0:root:/root:/bin/bash'), {
    mimeType: 'text/plain',
  });
  assert.equal(upload.status, 201);
  assert.equal(upload.body.material.name, 'passwd.txt', 'directory components are stripped from the display name');

  // The stored file must live under the data dir, keyed by UUID.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const stored = fs.readdirSync(path.join(h.dir, 'raw'));
  assert.equal(stored.length, 1);
  assert.match(stored[0], /^[0-9a-f-]{36}\.txt$/);
});

test('isolation: one learner cannot see, fetch or delete another learner\'s material', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const mine = await h.api.upload('mine.txt', Buffer.from('Photosynthesis converts light into glucose.'), {
    learnerId: 'alice',
    mimeType: 'text/plain',
  });
  assert.equal(mine.status, 201);
  const id = mine.body.material.id;

  const bobsList = await h.api.get('/api/materials', 'bob');
  assert.deepEqual(bobsList.body.materials, [], 'bob sees an empty library');

  const bobsFetch = await h.api.get(`/api/materials/${id}`, 'bob');
  assert.equal(bobsFetch.status, 404, 'bob must not learn that alice\'s material exists');

  const bobsDelete = await h.api.del(`/api/materials/${id}`, 'bob');
  assert.equal(bobsDelete.status, 404);

  const stillThere = await h.api.get(`/api/materials/${id}`, 'alice');
  assert.equal(stillThere.status, 200, 'alice\'s material survived bob\'s delete attempt');

  const bobsSearch = await h.api.get('/api/materials/search?q=photosynthesis%20glucose', 'bob');
  assert.equal(bobsSearch.body.results.length, 0, 'bob\'s search must not reach alice\'s text');
});

test('a malformed material id is rejected as a bad request rather than touching the filesystem', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const bad = await h.api.get('/api/materials/..%2F..%2Fetc%2Fpasswd');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'bad_request');
});

test('material search returns snippets with source metadata', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  await h.api.upload('thermo.txt', Buffer.from(NOTES, 'utf8'), { mimeType: 'text/plain' });
  const search = await h.api.get('/api/materials/search?q=second%20law%20entropy');

  assert.equal(search.status, 200);
  assert.ok(search.body.resultCount >= 1);
  const top = search.body.results[0];
  assert.equal(top.documentName, 'thermo.txt');
  assert.equal(top.pageNumber, 1);
  assert.match(top.snippet, /entropy|second law/i);
  assert.ok(top.matchedTerms.includes('entropy'));
});

test('material search rejects an empty query', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const bad = await h.api.get('/api/materials/search?q=');
  assert.equal(bad.status, 400);
});

test('the document limit is enforced', async (t) => {
  const h = await createHarness({ env: { upload: { maxDocuments: 2 } } });
  t.after(() => h.close());

  await h.api.upload('one.txt', Buffer.from('First document about entropy and heat engines in detail.'), { mimeType: 'text/plain' });
  await h.api.upload('two.txt', Buffer.from('Second document about enzymes and catalytic activity.'), { mimeType: 'text/plain' });
  const third = await h.api.upload('three.txt', Buffer.from('Third document about orbital mechanics basics.'), { mimeType: 'text/plain' });

  assert.equal(third.status, 409);
  assert.equal(third.body.error.code, 'material_limit_reached');
});

test('options endpoint is self-describing and cannot be shadowed by the id route', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const options = await h.api.get('/api/materials/meta/options');
  assert.equal(options.status, 200);
  // The advertised list is the extractor's list: the UI must never offer a
  // format the server cannot read, and the server must never refuse one the UI
  // advertises.
  assert.deepEqual(options.body.allowedExtensions, SUPPORTED_EXTENSIONS);
  for (const expected of ['.pdf', '.txt', '.md', '.docx', '.doc', '.rtf', '.odt']) {
    assert.ok(options.body.allowedExtensions.includes(expected), `${expected} must be uploadable`);
  }
  assert.ok(options.body.answerModes.length >= 4);
});

test('upload accepts Word, legacy Word, RTF and Markdown and indexes them all', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const paragraphs = [
    'A transaction is a unit of work that either completes entirely or not at all.',
    'Isolation levels trade consistency for concurrency, which is the usual compromise.',
  ];
  const cases = [
    ['lesson.docx', makeDocx([{ text: 'Database transactions', style: 'Heading1' }, ...paragraphs]), 'docx'],
    ['legacy.doc', makeLegacyDoc(paragraphs.join('\n')), 'doc'],
    [
      'notes.rtf',
      Buffer.from(String.raw`{\rtf1\ansi\pard Database transactions\par A transaction is atomic and isolated.\par}`, 'latin1'),
      'rtf',
    ],
    [
      'notes.md',
      Buffer.from('# Database transactions\n\nA transaction is atomic and isolated under serialisable locking.', 'utf8'),
      'markdown',
    ],
  ];

  const ids = [];
  for (const [name, buffer, kind] of cases) {
    const upload = await h.api.upload(name, buffer, { mimeType: 'application/octet-stream' });
    assert.equal(upload.status, 201, `${name} must be accepted: ${JSON.stringify(upload.body)}`);
    assert.equal(upload.body.material.kind, kind, `${name} kind`);
    assert.equal(upload.body.material.language, 'en', `${name} language`);
    assert.ok(upload.body.material.passageCount >= 1, `${name} must produce searchable passages`);
    ids.push(upload.body.material.id);
  }

  const list = await h.api.get('/api/materials');
  assert.equal(list.body.materials.length, cases.length);
  assert.ok(list.body.index.indexedPassages >= cases.length);

  // Newly supported formats must work everywhere, not only at upload time.
  const search = await h.api.get('/api/materials/search?q=isolation%20concurrency');
  assert.ok(search.body.results.length >= 1, 'office documents must be searchable');

  const quiz = await h.api.post('/api/quiz/generate', { materialIds: ids, questionCount: 3 });
  assert.equal(quiz.status, 201, `quiz generation must work from office files: ${JSON.stringify(quiz.body)}`);
  assert.ok(quiz.body.quiz.questions.length >= 1);
});

test('upload records Bangla material as Bangla so summaries and quizzes follow it', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  // Deliberately rich: the deterministic quiz builder needs definition-style
  // sentences, and this is exactly the kind of Bangla notes a student uploads.
  const bangla = [
    'সালোকসংশ্লেষণ হলো সেই জৈবিক প্রক্রিয়া যাতে সবুজ উদ্ভিদ সূর্যের আলোক শক্তিকে রাসায়নিক শক্তিতে রূপান্তরিত করে।',
    'ক্লোরোফিল হলো সবুজ পাতায় পাওয়া একটি রঞ্জক, যা আলো শোষণ করে এবং সালোকসংশ্লেষণ সম্ভব করে।',
    'ক্যালভিন চক্র হলো সালোকসংশ্লেষণের সেই ধাপ যেখানে কার্বন ডাই-অক্সাইড থেকে গ্লুকোজ তৈরি হয়।',
    'অ্যাটিপি হলো কোষের শক্তি মুদ্রা, যা বিভিন্ন জৈবিক প্রক্রিয়ার জন্য প্রয়োজনীয় শক্তি সরবরাহ করে।',
    'আলোক নির্ভর বিক্রিয়ায় পানি ভেঙে অক্সিজেন মুক্ত হয় এবং শক্তি সঞ্চিত হয়।',
    'কোষশ্বাসন হলো সেই প্রক্রিয়া যার মাধ্যমে গ্লুকোজ ভেঙে কোষ শক্তি উৎপন্ন করে।',
    'মাইটোকন্ড্রিয়া হলো কোষের অঙ্গাণু, যেখানে কোষশ্বাসন সম্পন্ন হয়।',
    'পাতার স্টোমাটা হলো ছোট ছিদ্র, যা গ্যাস বিনিময়ের পথ হিসেবে কাজ করে।',
  ].join('\n\n');

  const txt = await h.api.upload('bangla.txt', Buffer.from(bangla, 'utf8'), { mimeType: 'text/plain' });
  assert.equal(txt.status, 201);
  assert.equal(txt.body.material.language, 'bn');

  const docx = await h.api.upload('bangla.docx', makeDocx(bangla.split('\n\n')), {
    mimeType: 'application/octet-stream',
  });
  assert.equal(docx.status, 201);
  assert.equal(docx.body.material.language, 'bn', 'a Bangla Word file is detected as Bangla too');
  assert.ok(docx.body.material.passageCount >= 1);

  // An English upload in the same library is still detected as English.
  const english = await h.api.upload('english.txt', Buffer.from(SAMPLE_TEXT, 'utf8'), { mimeType: 'text/plain' });
  assert.equal(english.body.material.language, 'en');

  const quiz = await h.api.post('/api/quiz/generate', {
    materialIds: [txt.body.material.id],
    questionCount: 3,
  });
  assert.equal(quiz.status, 201);
  assert.equal(quiz.body.quiz.language, 'bn', 'with no topic given, the material decides the quiz language');
});

test('request bodies over the JSON limit are rejected, not buffered', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const res = await fetch(`${h.api.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-learner-id': 'test-learner' },
    body: JSON.stringify({ question: 'x'.repeat(400_000) }),
  });
  assert.equal(res.status, 413);
  await res.text();
});
