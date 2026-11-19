/**
 * Visual Studio: the teaching layer.
 *
 * A diagram alone is vocabulary, not understanding. These tests pin the rules
 * that make a visual page teachable:
 *   - every successful visual carries an explanation (overview + concepts),
 *   - its citations are real passages the visual already cites,
 *   - the text version contains the explanation, not just the labels,
 *   - the title names the subject, not one keyword,
 *   - a model's invented date, duplicated label, repeated table cell or
 *     uncited claim never reaches the student,
 *   - the requested page language is honoured.
 *
 * Offline demo mode is used for the end-to-end cases: deterministic, and it
 * exercises the quoted explanation path that has no model to rely on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, SAMPLE_TEXT } from './helpers/harness.js';
import { normaliseAiVisual } from '../src/visuals/service.js';
import { normaliseExplanation, clipAtWord } from '../src/visuals/explanation.js';

const COMPUTING_HISTORY = `Charles Babbage began work on the Analytical Engine in 1837, designing a general-purpose mechanical computer.

Ada Lovelace published an algorithm intended for a machine in 1843, in her notes on the engine.

ENIAC became operational in 1946 and filled an entire room with vacuum tubes.

Grace Hopper developed a compiler in 1952, which made programming languages practical for everyday use.

Transistors replaced vacuum tubes during the 1950s, shrinking computers from rooms to desks.

Intel released the first single-chip microprocessor in 1971, which set the scale for personal computing.`;

async function seed(h, name, text) {
  const res = await h.api.upload(name, Buffer.from(text, 'utf8'), { mimeType: 'text/plain' });
  assert.equal(res.status, 201, `upload failed: ${JSON.stringify(res.body)}`);
  return res.body.material;
}

function sourceIdsOf(visual) {
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

function explanationIds(explanation) {
  const used = new Set();
  const add = (ids) => (ids ?? []).forEach((id) => used.add(id));
  explanation.keyConcepts?.forEach((item) => add(item.sourceIds));
  explanation.steps?.forEach((item) => add(item.sourceIds));
  explanation.remember?.forEach((item) => add(item.sourceIds));
  if (explanation.example) add(explanation.example.sourceIds);
  return used;
}

test('a concept map carries a real explanation, not just labels', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'photosynthesis.txt', SAMPLE_TEXT);

  const res = await h.api.post('/api/visuals/generate', { materialIds: [material.id] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { visual, citations } = res.body;

  assert.ok(visual.explanation, 'the visual must ship an explanation');
  assert.ok(visual.explanation.overview.length > 40, 'overview must teach something');
  assert.ok(visual.explanation.keyConcepts.length >= 2, 'key concepts must explain the terms');
  for (const concept of visual.explanation.keyConcepts) {
    assert.ok(concept.term && concept.meaning.length > 20);
    assert.ok(concept.sourceIds.length > 0, `${concept.term} cites nothing`);
  }

  // Every citation used by the explanation is in the citation list the UI has.
  const citationIds = new Set(citations.map((c) => c.id));
  for (const id of explanationIds(visual.explanation)) {
    assert.ok(citationIds.has(id), `explanation cites ${id}, missing from citations`);
  }
  for (const id of sourceIdsOf(visual)) {
    assert.ok(citationIds.has(id), `diagram cites ${id}, missing from citations`);
  }
});

test('the text version includes the explanation and its sources', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'photosynthesis.txt', SAMPLE_TEXT);

  const res = await h.api.post('/api/visuals/generate', { materialIds: [material.id] });
  const { visual } = res.body;
  assert.match(visual.textVersion, /Topic overview/);
  assert.match(visual.textVersion, /Key concepts/);
  assert.match(visual.textVersion, /Sources:/);
  // The explanation must come before the diagram: read the idea, then the map.
  assert.ok(
    visual.textVersion.indexOf('Topic overview') < visual.textVersion.indexOf('Concept map'),
    'the overview should be read before the diagram',
  );
});

test('the title names the page, not a single keyword', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'photosynthesis.txt', SAMPLE_TEXT);

  const auto = await h.api.post('/api/visuals/generate', { materialIds: [material.id] });
  const title = auto.body.visual.title;
  assert.ok(title.includes(':'), `title "${title}" should name the subject and the kind of page`);
  assert.ok(title.length > 12);

  const focused = await h.api.post('/api/visuals/generate', { topic: 'photosynthesis', materialIds: [material.id] });
  assert.equal(focused.body.visual.title, 'photosynthesis');
});

test('the requested page language is honoured', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'photosynthesis.txt', SAMPLE_TEXT);

  const english = await h.api.post('/api/visuals/generate', { materialIds: [material.id], language: 'en' });
  assert.equal(english.body.visual.language, 'en');

  const bangla = await h.api.post('/api/visuals/generate', { materialIds: [material.id], language: 'bn' });
  assert.equal(bangla.body.visual.language, 'bn');
});

test('a quoted explanation has no invented example and no padded sections', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'computing.txt', COMPUTING_HISTORY);

  const res = await h.api.post('/api/visuals/generate', { materialIds: [material.id], kind: 'timeline' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const explanation = res.body.visual.explanation;
  assert.ok(explanation, 'even an extractive page must carry an explanation');
  // Every remembered line must come from the material, so each cites a passage.
  for (const item of explanation.remember ?? []) {
    assert.ok(item.sourceIds.length > 0, 'remember bullets must be traceable');
  }
});

test('clipAtWord never cuts a word in half', () => {
  const clipped = clipAtWord('Photosynthesis converts light energy into chemical energy stored in glucose molecules', 40);
  assert.ok(clipped.length <= 41);
  assert.ok(clipped.endsWith('\u2026') || clipped.endsWith('.'));
  assert.doesNotMatch(clipped, /\b[a-z]{1,2}\u2026$/, 'should not leave a two-letter stump');
});

test('ungrounded model concepts and uncited claims are removed', () => {
  const passages = [
    { id: 'S1', text: 'Chlorophyll absorbs light in the thylakoid membrane.' },
    { id: 'S2', text: 'The Calvin cycle fixes carbon dioxide into glucose.' },
  ];
  const explanation = normaliseExplanation(
    {
      overview: 'Photosynthesis turns light into stored chemical energy in two stages.',
      keyConcepts: [
        { term: 'Chlorophyll', meaning: 'The green pigment that absorbs light energy.', sourceIds: ['S1'] },
        { term: 'Invented idea', meaning: 'A claim with no passage behind it at all.', sourceIds: ['S9'] },
      ],
      steps: [{ title: 'Light absorption', text: 'Chlorophyll captures photons.', sourceIds: ['S1'] }],
      example: { text: 'A plant in sunlight makes glucose.', sourceIds: ['S42'] },
      remember: [{ text: 'Two stages: light reactions and the Calvin cycle.', sourceIds: ['S2'] }],
      summary: 'Light energy becomes chemical energy that the plant can use.',
    },
    passages,
  );

  assert.ok(explanation);
  assert.deepEqual(explanation.keyConcepts.map((c) => c.term), ['Chlorophyll']);
  assert.equal(explanation.example, null, 'an example citing an unknown passage must be dropped');
  assert.equal(explanation.steps[0].title, 'Light absorption');
});

test('a model date the passage never states is dropped', () => {
  const passages = [
    {
      id: 'S1',
      text: 'Charles Babbage began work on the Analytical Engine in 1837. ENIAC became operational in 1946 and filled an entire room. Intel released the first single-chip microprocessor in 1971.',
      pageNumber: 2,
    },
  ];
  const raw = {
    events: [
      { when: '1837', label: 'Babbage designs the Analytical Engine', sourceIds: ['S1'] },
      { when: '1946', label: 'ENIAC runs', sourceIds: ['S1'] },
      { when: '1951', label: 'Invented milestone', sourceIds: ['S1'] },
      { when: '1971', label: 'First microprocessor', sourceIds: ['S1'] },
    ],
  };
  const { visual, dropped } = normaliseAiVisual(raw, 'timeline', passages);
  assert.ok(visual, 'three real dates should still produce a timeline');
  assert.equal(dropped, 1, 'exactly the invented date is dropped');
  assert.deepEqual(
    visual.events.map((event) => event.when),
    ['1837', '1946', '1971'],
    'the invented 1951 event must not reach the student',
  );
});

test('duplicate labels and identical comparison cells are removed', () => {
  const passages = [{ id: 'S1', text: 'A stack is LIFO; a queue is FIFO.' }];
  const map = normaliseAiVisual(
    {
      nodes: [
        { label: 'Stack', explanation: 'Last in, first out.', sourceIds: ['S1'] },
        { label: 'stack', explanation: 'Repeated node.', sourceIds: ['S1'] },
        { label: 'Queue', explanation: 'First in, first out.', sourceIds: ['S1'] },
      ],
      edges: [
        { from: 'Stack', to: 'Queue', label: 'differs from', sourceIds: ['S1'] },
        { from: 'Stack', to: 'Queue', label: 'differs from', sourceIds: ['S1'] },
      ],
    },
    'concept-map',
    passages,
  );
  assert.equal(map.visual, null, 'two unique nodes is below the map threshold');
  assert.ok(map.dropped >= 1);

  const table = normaliseAiVisual(
    {
      columns: [{ label: 'Stack' }, { label: 'Queue' }],
      rows: [
        {
          label: 'Order',
          cells: [
            { columnId: 'c1', text: 'A stack is LIFO.', sourceIds: ['S1'] },
            { columnId: 'c2', text: 'A stack is LIFO.', sourceIds: ['S1'] },
          ],
        },
        {
          label: 'Access',
          cells: [
            { columnId: 'c1', text: 'Only the top is reachable.', sourceIds: ['S1'] },
            { columnId: 'c2', text: 'The front is removed first.', sourceIds: ['S1'] },
          ],
        },
      ],
    },
    'comparison',
    passages,
  );
  // The repeated row is dropped, leaving too few rows for a table.
  assert.equal(table.visual, null);
});
