/**
 * Visual Study Studio tests in offline demo mode.
 *
 * The important properties: each visual kind only appears when the source
 * really carries that structure, every node/step/row/event cites a passage
 * that exists, refusal answers explain what WAS found, and nothing about a
 * saved visual leaks between learners.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';
import { SAMPLE_TEXT } from './helpers/harness.js';

const COMPUTING_HISTORY = `Charles Babbage began work on the Analytical Engine in 1837, designing a general-purpose mechanical computer.

Ada Lovelace published an algorithm intended for a machine in 1843, in her notes on the engine.

ENIAC became operational in 1946 and filled an entire room with vacuum tubes.

Grace Hopper developed a compiler in 1952, which made programming languages practical for everyday use.

Transistors replaced vacuum tubes during the 1950s, shrinking computers from rooms to desks.

Intel released the first single-chip microprocessor in 1971, which set the scale for personal computing.`;

const SOLUTION_PREP = `To prepare a saturated solution, first measure the volume of solvent you will use.

Second, weigh the mass of solute required by the calculation and record it carefully.

Third, add the solute slowly to the solvent while stirring to avoid clumping.

Finally, stop adding solute once no more will dissolve and note the residue left behind.`;

const DATA_STRUCTURES = `A stack stores data in last-in-first-out order, whereas a queue keeps data in first-in-first-out order for processing.

A stack is useful for nested structures like parentheses, while a queue suits task scheduling in operating systems.

Unlike a stack, a queue does not allow access to middle elements without removing the ones in front.

An array offers constant-time access by index, in contrast to a linked list which must traverse nodes sequentially.

An array keeps related data in contiguous memory, whereas a linked list stores each node with a pointer to the next.

A linked list uses extra memory for pointers, while an array wastes space when it grows by resizing.`;

const VENUE_NOTES = `The committee met in the atrium and reviewed the seating chart for the auditorium.

Volunteers registered guests at the front desk throughout the morning hours.

Caterers arranged tables in the garden room and set out folded napkins.

Musicians tuned their instruments backstage before the evening performance.

Photographers tested lighting equipment near the entrance hallway.

Guests arrived through the main doors and collected printed programmes.`;

async function seed(h, name, text) {
  const res = await h.api.upload(name, Buffer.from(text, 'utf8'), { mimeType: 'text/plain' });
  assert.equal(res.status, 201, `upload failed: ${JSON.stringify(res.body)}`);
  return res.body.material;
}

/** Every source id used anywhere in a visual, as a Set. */
function visualSourceIds(visual) {
  const used = new Set();
  const add = (ids) => (ids ?? []).forEach((id) => used.add(id));
  if (visual.kind === 'concept-map') {
    visual.nodes.forEach((n) => add(n.sourceIds));
    visual.edges.forEach((e) => add(e.sourceIds));
  } else if (visual.kind === 'flowchart') {
    visual.steps.forEach((s) => add(s.sourceIds));
  } else if (visual.kind === 'comparison') {
    visual.rows.forEach((r) => r.cells.forEach((c) => add(c.sourceIds)));
  } else if (visual.kind === 'timeline') {
    visual.events.forEach((e) => add(e.sourceIds));
  }
  return used;
}

/** Assert the universal grounding contract every successful visual honours. */
function assertGrounded(record) {
  const citationIds = new Set(record.citations.map((c) => c.id));
  for (const id of visualSourceIds(record.visual)) {
    assert.ok(citationIds.has(id), `visual cites ${id} which is not in its citation list`);
  }
  assert.ok(record.citations.length > 0, 'a visual must carry at least one citation');
  for (const citation of record.citations) {
    assert.ok(citation.documentName, 'citation is missing the document name');
    assert.equal(typeof citation.pageNumber, 'number');
    assert.ok(citation.pageNumber >= 1, 'citation page must be a real page');
    assert.ok(citation.snippet.length > 0, 'citation is missing its snippet');
    assert.ok(citation.passageId, 'citation is missing its passage id');
  }
  assert.equal(record.generationMode, 'demo');
  assert.ok(record.visual.title, 'visual must have a title');
  assert.ok(record.visual.textVersion.length > 50, 'text version must be substantial');
  assert.ok(record.visual.textVersion.includes('Sources:'), 'text version must list exact sources');
  assert.ok(record.provenance.length > 20, 'provenance must explain how the visual was made');
}

test('auto: picks a concept map when the material connects recurring terms', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'photosynthesis.txt', SAMPLE_TEXT);

  const res = await h.api.post('/api/visuals/generate', { materialIds: [material.id] });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const record = res.body;
  assert.equal(record.visual.kind, 'concept-map');
  assert.ok(record.visual.nodes.length >= 3, `expected nodes, got ${record.visual.nodes.length}`);
  assert.ok(record.visual.edges.length >= 2, `expected edges, got ${record.visual.edges.length}`);

  const nodeIds = new Set(record.visual.nodes.map((n) => n.id));
  assert.equal(nodeIds.size, record.visual.nodes.length, 'node ids must be unique');
  for (const node of record.visual.nodes) {
    assert.ok(node.label.length > 0);
    assert.ok(node.explanation.length > 10, `node ${node.id} has no real explanation`);
    assert.ok(node.sourceIds.length > 0, `node ${node.id} cites nothing`);
  }
  for (const edge of record.visual.edges) {
    assert.ok(nodeIds.has(edge.from) && nodeIds.has(edge.to), 'edge points at a node that does not exist');
    assert.notEqual(edge.from, edge.to, 'an edge must connect two different concepts');
    assert.ok(edge.sourceIds.length > 0, 'edge cites nothing');
  }
  assertGrounded(record);
});

test('auto: picks a timeline when the material dates its events', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'computing-history.txt', COMPUTING_HISTORY);

  const res = await h.api.post('/api/visuals/generate', { materialIds: [material.id] });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  assert.equal(res.body.visual.kind, 'timeline');
  const events = res.body.visual.events;
  assert.ok(events.length >= 3, `expected at least 3 dated events, got ${events.length}`);
  for (const event of events) {
    assert.ok(event.when.length > 0, 'event is missing its date');
    assert.ok(/\d/.test(event.when), 'event date must contain a number');
    assert.ok(event.label.length > 0);
    assert.ok(event.sourceIds.length > 0);
  }
  // Chronological: the first event must predate the last one.
  const years = events.map((e) => Number(/\d{4}/.exec(e.when)?.[0] ?? /\d{3}/.exec(e.when)?.[0] ?? 0));
  const realYears = years.filter((y) => y > 0);
  assert.ok(realYears.length >= 3, 'most events should carry a sortable year');
  assert.deepEqual(realYears, [...realYears].sort((a, b) => a - b), 'events must be in chronological order');
  assertGrounded(res.body);
});

test('auto: picks a flowchart when the material writes ordered steps', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'solution-prep.txt', SOLUTION_PREP);

  const res = await h.api.post('/api/visuals/generate', { materialIds: [material.id] });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  assert.equal(res.body.visual.kind, 'flowchart');
  assert.ok(res.body.visual.steps.length >= 3, `expected at least 3 steps, got ${res.body.visual.steps.length}`);
  for (const step of res.body.visual.steps) {
    assert.ok(step.label.length > 0);
    assert.ok(step.detail.length >= step.label.length - 20, 'detail should carry the source wording');
    assert.ok(step.sourceIds.length > 0);
  }
  assertGrounded(res.body);
});

test('auto: picks a comparison table when the material contrasts concepts', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'data-structures.txt', DATA_STRUCTURES);

  const res = await h.api.post('/api/visuals/generate', { materialIds: [material.id] });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  assert.equal(res.body.visual.kind, 'comparison');
  const { columns, rows } = res.body.visual;
  assert.equal(columns.length, 2, 'a local comparison table has exactly two columns');
  assert.ok(rows.length >= 2, `expected at least 2 rows, got ${rows.length}`);
  for (const row of rows) {
    assert.equal(row.cells.length, columns.length, 'every row must fill every column');
    for (const cell of row.cells) {
      assert.ok(columns.some((c) => c.id === cell.columnId), 'cell points at a column that does not exist');
      assert.ok(cell.text.length > 10, 'cell must quote the material');
      assert.ok(cell.sourceIds.length > 0, 'cell cites nothing');
    }
  }
  assertGrounded(res.body);
});

test('refuses a visual the material cannot support, and says what it did find', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'venue-notes.txt', VENUE_NOTES);

  const res = await h.api.post('/api/visuals/generate', { materialIds: [material.id] });

  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'visual_not_supported');
  assert.ok(res.body.error.requestId, 'error must carry a request id for support');
  // The refusal must be an explanation, not a shrug: what was scanned and what
  // was missing.
  assert.match(res.body.error.message, /structure/i);
  const found = res.body.error.details?.found;
  assert.ok(found, 'refusal must tally the signals it looked for');
  assert.equal(typeof found.datedSentences, 'number');
  assert.equal(typeof found.sequenceSentences, 'number');
  assert.equal(typeof found.comparisonSentences, 'number');
  assert.equal(typeof found.relationsBetweenTerms, 'number');
  assert.deepEqual(res.body.error.details.supported, [], 'nothing in this material supports a visual');
});

test('refuses an explicitly requested kind the material cannot support, without inventing', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'photosynthesis.txt', SAMPLE_TEXT);

  const res = await h.api.post('/api/visuals/generate', { materialIds: [material.id], kind: 'timeline' });

  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'visual_not_supported');
  assert.equal(res.body.error.details.requested, 'timeline');
  // The honest refusal names what would have had to be invented.
  assert.match(res.body.error.message, /inventing dates/i);
  assert.deepEqual(res.body.error.details.supported, ['concept-map']);
});

test('refuses before any material exists, and for topics the material never mentions', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const empty = await h.api.post('/api/visuals/generate', {});
  assert.equal(empty.status, 422);
  assert.equal(empty.body.error.code, 'no_materials');
  assert.match(empty.body.error.message, /Upload/i);

  await seed(h, 'databases.txt', SAMPLE_TEXT);
  const missing = await h.api.post('/api/visuals/generate', { topic: 'quantum chromodynamics' });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error.code, 'topic_not_found');
});

test('rejects an unknown visual kind with a 400', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const res = await h.api.post('/api/visuals/generate', { kind: 'pie-chart' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.details.fields.length > 0);
});

test('saves visuals: list, reload, and never leak across learners', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'photosynthesis.txt', SAMPLE_TEXT);

  const created = await h.api.post('/api/visuals/generate', { materialIds: [material.id] });
  assert.equal(created.status, 201);
  assert.ok(created.body.id, 'a generated visual is persisted with an id');

  const list = await h.api.get('/api/visuals');
  assert.equal(list.status, 200);
  assert.equal(list.body.visuals.length, 1);
  assert.equal(list.body.visuals[0].id, created.body.id);
  assert.ok(list.body.visuals[0].title.length > 0);
  assert.ok(list.body.visuals[0].parts > 0, 'history list should show how big the visual is');

  const reloaded = await h.api.get(`/api/visuals/${created.body.id}`);
  assert.equal(reloaded.status, 200);
  assert.deepEqual(reloaded.body.visual.visual, created.body.visual);

  // Another learner sees nothing and cannot fetch the saved picture.
  const otherList = await h.api.get('/api/visuals', 'other-learner');
  assert.deepEqual(otherList.body.visuals, []);
  const otherGet = await h.api.get(`/api/visuals/${created.body.id}`, 'other-learner');
  assert.equal(otherGet.status, 404);

  const deleted = await h.api.del(`/api/visuals/${created.body.id}`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, true);
  const gone = await h.api.get(`/api/visuals/${created.body.id}`);
  assert.equal(gone.status, 404);
});

test('scoped generation: a topic visual cites only the passages that mention it', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'photosynthesis.txt', SAMPLE_TEXT);

  const res = await h.api.post('/api/visuals/generate', { topic: 'chlorophyll light pigment' });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  // Citations must all quote the topic, not the whole document.
  const joined = res.body.citations.map((c) => c.snippet.toLowerCase()).join(' ');
  assert.ok(joined.includes('chlorophyll') || joined.includes('light'), `citations drift from the topic: ${joined}`);
  assertGrounded(res.body);
});

test('meta/options lists the four kinds the studio can build', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const res = await h.api.get('/api/visuals/meta/options');
  assert.equal(res.status, 200);
  assert.equal(res.body.kinds.length, 4);
  assert.equal(res.body.defaultKind, 'auto');
  for (const kind of res.body.kinds) {
    assert.ok(kind.id && kind.label && kind.description && kind.needs);
  }
});
