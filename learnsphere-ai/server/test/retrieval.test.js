/**
 * Retrieval tests against the real store and the real BM25 index.
 *
 * These assert the property the whole product depends on: a relevant passage is
 * found, its source metadata is exact, and an unrelated question is REFUSED
 * rather than answered.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from './helpers/harness.js';
import { ingestMaterial } from '../src/documents/ingest.js';
import { buildIndex, searchIndex, buildSnippet } from '../src/retrieval/bm25.js';

const PHOTOSYNTHESIS = `Photosynthesis is the process by which green plants convert light energy into chemical energy stored in glucose.

The light-dependent reactions take place in the thylakoid membrane of the chloroplast and produce ATP and NADPH.

The Calvin cycle is the light-independent stage of photosynthesis and fixes carbon dioxide into glucose.

Chlorophyll is the green pigment that absorbs light most strongly in the blue and red regions of the spectrum.`;

const DATABASES = `A relational database stores data in tables with rows and columns, and enforces relationships with foreign keys.

Normalisation is the process of organising columns and tables to minimise data redundancy and dependency.

An index is a data structure that speeds up retrieval of rows at the cost of extra storage and slower writes.

A transaction is a unit of work that is either committed in full or rolled back entirely.`;

async function seed(core, learnerId, name, text) {
  const buffer = Buffer.from(text, 'utf8');
  const result = await ingestMaterial({
    store: core.store,
    retrieval: core.retrieval,
    config: core.config,
    logger: core.logger,
    learnerId,
    buffer,
    filename: name,
    mimeType: 'text/plain',
  });
  assert.equal(result.ok, true, `ingest failed for ${name}: ${JSON.stringify(result.error)}`);
  return result;
}

test('BM25 unit: ranks the passage that contains the queried terms first', () => {
  const index = buildIndex([
    { ref: 'a', text: 'Photosynthesis converts light energy into glucose inside chloroplasts.' },
    { ref: 'b', text: 'A relational database stores rows in tables with foreign keys.' },
    { ref: 'c', text: 'The Calvin cycle fixes carbon dioxide during the light-independent stage.' },
  ]);
  const { results } = searchIndex(index, 'what does the calvin cycle fix', { topK: 3, minScore: 0 });
  assert.equal(results[0].ref, 'c');
  assert.ok(results[0].coverage > 0);
});

test('BM25 unit: a question sharing no terms with the corpus yields no results', () => {
  const index = buildIndex([{ ref: 'a', text: 'Photosynthesis converts light energy into glucose.' }]);
  const { results } = searchIndex(index, 'explain quantum chromodynamics lattice gauge theory', {
    topK: 3,
    minScore: 0.35,
  });
  assert.equal(results.length, 0);
});

test('BM25 unit: coverage is IDF-weighted, so a rare term outranks a common one', () => {
  const index = buildIndex([
    { ref: 'common', text: 'The cell is a cell and the cell contains a cell membrane.' },
    { ref: 'rare', text: 'The mitochondrion performs oxidative phosphorylation to synthesise ATP.' },
  ]);
  const { results } = searchIndex(index, 'oxidative phosphorylation', { topK: 2, minScore: 0 });
  assert.equal(results[0].ref, 'rare');
  assert.ok(results[0].coverage > 0.5);
});

test('retrieval: finds the passage that answers the question, with exact source metadata', async (t) => {
  const core = await createCore();
  t.after(() => core.close());

  await seed(core, 'student-a', 'biology-notes.txt', PHOTOSYNTHESIS);
  await seed(core, 'student-a', 'database-notes.txt', DATABASES);

  const search = await core.retrieval.search({
    learnerId: 'student-a',
    query: 'What does the Calvin cycle do?',
  });

  assert.equal(search.supported, true);
  const top = search.results[0];
  assert.match(top.text, /Calvin cycle/);
  assert.equal(top.documentName, 'biology-notes.txt');
  assert.equal(top.pageNumber, 1, 'a TXT document is page 1');
  // Passage ids encode the page, which is what makes a citation auditable.
  assert.equal(top.passageId, `${top.materialId}-p1-0`);
  assert.ok(top.score >= core.config.retrieval.minScore, `coverage ${top.score} should clear the gate`);
  assert.ok(top.matchedTerms.includes('calvin'));
});

test('retrieval: passages are attributed to the document they really came from', async (t) => {
  const core = await createCore();
  t.after(() => core.close());

  await seed(core, 'student-a', 'biology-notes.txt', PHOTOSYNTHESIS);
  await seed(core, 'student-a', 'database-notes.txt', DATABASES);

  const search = await core.retrieval.search({ learnerId: 'student-a', query: 'What is normalisation in a relational database?' });
  const top = search.results[0];
  assert.equal(top.documentName, 'database-notes.txt');
  assert.match(top.text, /Normalisation|relational database/);
});

test('retrieval: an unrelated question is refused, not answered from the nearest passage', async (t) => {
  const core = await createCore();
  t.after(() => core.close());

  await seed(core, 'student-a', 'biology-notes.txt', PHOTOSYNTHESIS);

  const search = await core.retrieval.search({
    learnerId: 'student-a',
    query: 'How do I configure a Kubernetes ingress controller with TLS?',
  });

  assert.equal(search.supported, false);
  assert.equal(search.results.length, 0);
  assert.equal(search.hasMaterials, true, 'the library is not empty - the material simply does not cover it');
});

test('retrieval: data isolation - one learner can never retrieve another learner\'s passages', async (t) => {
  const core = await createCore();
  t.after(() => core.close());

  await seed(core, 'student-a', 'secret-a.txt', 'The alpha secret protocol uses a rotating salt of seven bytes.');
  await seed(core, 'student-b', 'secret-b.txt', 'The beta confidential routine depends on a twelve byte nonce.');

  const searchA = await core.retrieval.search({ learnerId: 'student-a', query: 'alpha secret protocol rotating salt' });
  assert.equal(searchA.results.length, 1);
  assert.equal(searchA.results[0].documentName, 'secret-a.txt');

  // Even naming student B's exact terms must never return student B's document.
  // (A may still get a low-confidence hit on its OWN document - "bytes" in
  // student A's notes shares a stem with "byte" - so the invariant to assert is
  // ownership, not an empty result set.)
  const cross = await core.retrieval.search({ learnerId: 'student-a', query: 'beta confidential routine twelve byte nonce' });
  for (const result of cross.results) {
    assert.equal(result.documentName, 'secret-a.txt', 'every result must belong to the searching learner');
    assert.doesNotMatch(result.text, /beta confidential/i);
  }
  assert.ok(!JSON.stringify(cross).includes('secret-b'), 'student B\'s document name must never appear');
});

test('retrieval: selecting a subset of materials restricts the search to those materials', async (t) => {
  const core = await createCore();
  t.after(() => core.close());

  const bio = await seed(core, 'student-a', 'biology-notes.txt', PHOTOSYNTHESIS);
  await seed(core, 'student-a', 'database-notes.txt', DATABASES);

  const restricted = await core.retrieval.search({
    learnerId: 'student-a',
    query: 'What is normalisation of tables?',
    materialIds: [bio.material.id],
  });
  assert.equal(restricted.results.length, 0, 'the database document was excluded, so nothing should match');

  const unrestricted = await core.retrieval.search({ learnerId: 'student-a', query: 'What is normalisation of tables?' });
  assert.equal(unrestricted.results.length > 0, true);
});

test('retrieval: one unknown word does not refuse a question the material does answer', async (t) => {
  const core = await createCore();
  t.after(() => core.close());

  await seed(core, 'student-a', 'biology-notes.txt', PHOTOSYNTHESIS);

  // "absorption" never appears in the notes (they say "absorbs"), so it is an
  // out-of-vocabulary term and must not dominate the coverage denominator.
  const search = await core.retrieval.search({
    learnerId: 'student-a',
    query: 'Explain chlorophyll light absorption',
  });

  assert.equal(search.supported, true, 'a synonym must not block a covered question');
  assert.equal(search.unknownTerms.includes('absorption'), true);
  assert.match(search.results[0].text, /Chlorophyll/);
});

test('retrieval: a question with no known vocabulary at all is still refused', async (t) => {
  const core = await createCore();
  t.after(() => core.close());

  await seed(core, 'student-a', 'biology-notes.txt', PHOTOSYNTHESIS);

  const search = await core.retrieval.search({
    learnerId: 'student-a',
    query: 'kubernetes ingress controller mutual tls handshake',
  });

  assert.equal(search.supported, false);
  assert.equal(search.knownTerms, 0);
  assert.equal(search.results.length, 0);
});

test('retrieval: deleting a material removes it from the index immediately', async (t) => {
  const core = await createCore();
  t.after(() => core.close());

  const bio = await seed(core, 'student-a', 'biology-notes.txt', PHOTOSYNTHESIS);
  assert.equal((await core.retrieval.search({ learnerId: 'student-a', query: 'calvin cycle glucose' })).results.length, 1);

  await core.store.deleteMaterial(bio.material.id, 'student-a');
  await core.retrieval.invalidate('student-a');

  const after = await core.retrieval.search({ learnerId: 'student-a', query: 'calvin cycle glucose' });
  assert.equal(after.results.length, 0);
  assert.equal(after.hasMaterials, false);
});

test('buildSnippet centres the excerpt on the matched terms', () => {
  const text = `${'padding '.repeat(60)} the calvin cycle fixes carbon dioxide ${'padding '.repeat(60)}`;
  const snippet = buildSnippet(text, ['calvin', 'carbon']);
  assert.match(snippet, /calvin cycle/);
  assert.ok(snippet.length <= 280);
});
