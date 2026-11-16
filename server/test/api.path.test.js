/**
 * Guided learning path tests in offline demo mode.
 *
 * The properties that matter: every step part either cites a real passage or
 * says out loud that the material does not cover it, completion is stored and
 * never crosses learners, refusals explain what WAS in the text, and a step
 * only offers a Visual Study Studio picture the studio can honestly draw.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';
import { SAMPLE_TEXT } from './helpers/harness.js';
import { normaliseAiSteps } from '../src/learningpath/service.js';

const RECURSION = `Recursion is a technique where a function solves a problem by calling a smaller version of itself.

Recursion requires a base case, otherwise the call stack keeps growing until the program crashes.

A base case is the condition that stops the recursion before it repeats.

An example of recursion is factorial, where 5 factorial equals 5 times 4 times 3 times 2 times 1.

Therefore the base case must be tested before the recursive step is trusted in production code.`;

const COMPOSTING = `Composting breaks kitchen waste into nutrient-rich garden soil.

In step 1 of the composting process, green and brown material is layered in a bin.

In step 2 of composting, microbes multiply and heat builds up inside the pile.

In step 3 of composting, the pile is turned when the centre cools down.

Composting requires a balance of greens and browns, because the microbes need both carbon and nitrogen.

An example of composting in practice is a worm bin kept under the kitchen sink.

Therefore the composting pile must be turned whenever the centre cools below a safe range.`;

const THIN_NOTES = `The committee met in the atrium and reviewed the seating chart.`;

const QUIET_NOTES = `The committee met on Monday and reviewed the seating chart for the auditorium.

Volunteers registered guests at the front desk throughout the morning hours.

Caterers arranged tables in the garden room and set out folded napkins.

Musicians tuned their instruments backstage before the evening performance.

Photographers tested lighting equipment near the entrance hallway.`;

async function seed(h, name, text, learnerId) {
  const res = await h.api.upload(name, Buffer.from(text, 'utf8'), learnerId ? { learnerId } : {});
  assert.equal(res.status, 201, `upload failed: ${JSON.stringify(res.body)}`);
  return res.body.material;
}

async function generate(h, body, learnerId) {
  return h.api.post('/api/learning-path/generate', body, learnerId);
}

/** Every source id used anywhere in a path, as a Set. */
function allPathSourceIds(record) {
  const used = new Set();
  for (const step of record.steps) {
    step.sourceIds.forEach((id) => used.add(id));
    for (const part of [step.prerequisite, step.explanation, step.example, step.question]) {
      (part.sourceIds ?? []).forEach((id) => used.add(id));
    }
  }
  return used;
}

/** The universal grounding contract every successful path honours. */
function assertGrounded(record) {
  assert.ok(record.steps.length >= 2, 'a path needs at least two steps');
  assert.ok(record.steps.length <= 6, 'a path is capped at six steps');
  const ids = new Set(record.citations.map((c) => c.id));
  for (const id of allPathSourceIds(record)) {
    assert.ok(ids.has(id), `path cites ${id} which is not in its citation list`);
  }
  for (const citation of record.citations) {
    assert.ok(citation.documentName, 'citation is missing the document name');
    assert.equal(typeof citation.pageNumber, 'number');
    assert.ok(citation.pageNumber >= 1, 'citation page must be a real page');
    assert.ok(citation.snippet.length > 0, 'citation is missing its snippet');
    assert.ok(citation.passageId, 'citation is missing its passage id');
  }
  assert.equal(record.generationMode, 'demo');
  assert.ok(record.topic, 'a path needs a topic');
  assert.ok(record.textVersion.includes('Learning path:'), 'text version must open with the topic');
  assert.ok(record.textVersion.includes('Sources:'), 'text version must list exact sources');
  assert.ok(record.provenance.length > 20, 'provenance must explain how the path was made');
}

/**
 * The honesty contract: a part is either covered and cited, or it carries the
 * exact "not covered in your material" wording and no invented text.
 */
function assertHonestGaps(record) {
  const labels = [
    ['prerequisite', 'Prerequisite'],
    ['explanation', 'Explanation'],
    ['example', 'Worked example'],
    ['question', 'Recall question'],
  ];
  for (const step of record.steps) {
    assert.ok(step.title.length > 0);
    for (const [key, label] of labels) {
      const part = step[key];
      assert.ok(part, `step ${step.id} is missing its ${label.toLowerCase()}`);
      if (part.covered) {
        assert.ok((part.sourceIds ?? []).length > 0, `step ${step.id} ${key} cites nothing`);
        assert.ok((part.text ?? part.answer).length > 5, `step ${step.id} ${key} has no real content`);
      } else {
        assert.equal(part.text ?? part.answer ?? part.prompt ?? null, null, `step ${step.id} ${key} invented text`);
        assert.ok(
          part.note.includes('not covered in your material'),
          `step ${step.id} ${key} does not state the gap honestly: ${part.note}`,
        );
      }
    }
  }
}

test('generates a grounded path whose steps cite the source', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'photosynthesis.txt', SAMPLE_TEXT);

  const res = await generate(h, { topic: 'photosynthesis', materialIds: [material.id] });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const record = res.body.path;
  assert.equal(record.topic, 'photosynthesis');
  assert.ok(
    record.steps.some((s) => s.title.toLowerCase().includes('photosynthesis')),
    'the learner\u2019s own topic must be taught by the path',
  );
  assert.deepEqual(record.materialIds, [material.id]);
  assert.ok(record.stats.steps === record.steps.length);
  assert.ok(record.citations.length > 0);

  record.steps.forEach((step, index) => {
    assert.equal(step.id, `p${index + 1}`, 'step ids are stable and ordered');
    assert.equal(step.index, index);
    assert.equal(step.completed, false, 'a fresh step starts uncompleted');
    assert.equal(step.completedAt, null);
  });

  assertGrounded(record);
  assertHonestGaps(record);
});

test('every gap is stated as "not covered in your material", never filled', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'recursion.txt', RECURSION);

  const res = await generate(h, { topic: 'recursion', materialIds: [material.id] });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const record = res.body.path;
  assertGrounded(record);
  assertHonestGaps(record);

  // This fixture states a prerequisite and an example, so at least one of
  // each must be found - a feature that always reports gaps would be useless.
  assert.ok(record.steps.some((s) => s.prerequisite.covered), 'no prerequisite was found in the text');
  assert.ok(record.steps.some((s) => s.example.covered), 'no worked example was found in the text');
  assert.ok(record.steps.every((s) => s.explanation.covered), 'every step should carry a quotable explanation');
});

test('refuses with what was found when the material cannot support a path', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'notes.txt', THIN_NOTES);

  const res = await generate(h, { topic: 'committee', materialIds: [material.id] });
  assert.equal(res.status, 422, JSON.stringify(res.body));

  assert.equal(res.body.error.code, 'path_not_supported');
  assert.match(res.body.error.message, /does not contain enough/);
  assert.match(res.body.error.message, /Nothing was invented/);
  assert.ok(res.body.error.details.found.sentencesScanned >= 1, 'the refusal must say what WAS in the text');
  assert.ok('recurringTerms' in res.body.error.details.found);
});

test('refuses a topic the material never mentions, and a learner with nothing uploaded', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'photosynthesis.txt', SAMPLE_TEXT);

  const unknown = await generate(h, { topic: 'photoelectric effect' });
  assert.equal(unknown.status, 422);
  assert.equal(unknown.body.error.code, 'topic_not_found');
  assert.match(unknown.body.error.message, /nothing matching/);

  const empty = await generate(h, { topic: 'photosynthesis' }, 'learner-with-nothing');
  assert.equal(empty.status, 422);
  assert.equal(empty.body.error.code, 'no_materials');
});

test('completion persists, can be revisited, and never crosses learners', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'recursion.txt', RECURSION);

  const created = await generate(h, { topic: 'recursion', materialIds: [material.id] });
  assert.equal(created.status, 201);
  const { id } = created.body.path;

  const done = await h.api.patch(`/api/learning-path/${id}/progress`, { stepId: 'p1', completed: true });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.path.steps[0].completed, true);
  assert.ok(done.body.path.steps[0].completedAt, 'a completed step records when');
  assert.equal(done.body.path.steps[1].completed, false, 'other steps stay uncompleted');

  const reopened = await h.api.patch(`/api/learning-path/${id}/progress`, { stepId: 'p1', completed: false });
  assert.equal(reopened.body.path.steps[0].completed, false);
  assert.equal(reopened.body.path.steps[0].completedAt, null, 'reopening clears the timestamp');

  const listed = await h.api.get('/api/learning-path/');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.paths.length, 1);
  assert.equal(listed.body.paths[0].completed, 0);

  const badStep = await h.api.patch(`/api/learning-path/${id}/progress`, { stepId: 'p9', completed: true });
  assert.equal(badStep.status, 400);

  // Another learner cannot see, resume or advance this path.
  const foreign = 'someone-else';
  assert.equal((await h.api.get(`/api/learning-path/${id}`, foreign)).status, 404);
  assert.equal((await h.api.patch(`/api/learning-path/${id}/progress`, { stepId: 'p1', completed: true }, foreign)).status, 404);
  assert.equal((await h.api.get('/api/learning-path/', foreign)).body.paths.length, 0);
});

test('a step offers a studio visual only when the studio can draw it', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'composting.txt', COMPOSTING);

  const res = await generate(h, { topic: 'composting', materialIds: [material.id] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const record = res.body.path;

  const supported = record.steps.filter((s) => s.visual.supported);
  assert.ok(supported.length > 0, 'the sequenced composting steps should support a visual');
  for (const step of supported) {
    assert.ok(['concept-map', 'flowchart', 'comparison', 'timeline'].includes(step.visual.kind));
    assert.equal(step.visual.topic, step.title);
    assert.equal(step.visual.visual, null, 'the picture itself is built lazily');
  }

  const step = supported[0];
  const built = await h.api.post(`/api/learning-path/${record.id}/steps/${step.id}/visual`, {});
  assert.equal(built.status, 201, JSON.stringify(built.body));
  assert.equal(built.body.cached, false);
  assert.ok(built.body.visual.visual.title, 'the studio visual must carry its title');
  assert.ok(built.body.visual.citations.length > 0, 'the studio visual must carry citations');
  assertGrounded(record);

  // Reopening the step reuses the stored picture instead of paying for another.
  const again = await h.api.post(`/api/learning-path/${record.id}/steps/${step.id}/visual`, {});
  assert.equal(again.status, 201);
  assert.equal(again.body.cached, true);

  const missing = await h.api.post(`/api/learning-path/${record.id}/steps/p9/visual`, {});
  assert.equal(missing.status, 400);
});

test('a step the studio cannot draw explains why instead of pretending', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const material = await seed(h, 'venue-notes.txt', QUIET_NOTES);

  const res = await generate(h, { topic: 'auditorium', materialIds: [material.id] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const record = res.body.path;

  const unsupported = record.steps.filter((s) => !s.visual.supported);
  assert.ok(unsupported.length > 0, 'some steps should honestly report no visual');
  for (const step of unsupported) {
    assert.equal(step.visual.kind, null);
    assert.ok(step.visual.reason.length > 20, 'the reason must be an explanation, not a shrug');
  }

  const refused = await h.api.post(`/api/learning-path/${record.id}/steps/${unsupported[0].id}/visual`, {});
  assert.equal(refused.status, 422);
  assert.ok(refused.body.error.message.length > 20);

  const stored = await h.api.get(`/api/learning-path/${record.id}`);
  assert.equal(stored.body.path.steps.find((s) => s.id === unsupported[0].id).visual.supported, false);
});

test('model-drafted steps lose every ungrounded part and keep the gap wording', () => {
  const passages = [
    { id: 'S1', text: 'Alpha is the first stage of the process.' },
    { id: 'S2', text: 'Beta follows alpha and completes the cycle.' },
  ];
  const raw = {
    steps: [
      {
        title: 'Alpha',
        prerequisite: { text: 'Gamma comes first.', sourceIds: ['S7'] },
        explanation: { text: 'Alpha is the first stage.', sourceIds: ['S1'] },
        example: { text: 'Beta follows alpha.', sourceIds: ['S2'] },
        question: { prompt: 'What comes first?', answer: 'Alpha.', sourceIds: ['S1'] },
      },
      {
        title: 'Beta',
        prerequisite: null,
        explanation: { text: 'Beta completes the cycle.', sourceIds: ['S2'] },
        example: null,
        question: null,
      },
    ],
  };

  const { steps, dropped } = normaliseAiSteps(raw, passages);
  assert.equal(steps.length, 2);
  assert.equal(dropped, 0);

  // The invented prerequisite (S7) is gone, and the gap is stated.
  assert.equal(steps[0].prerequisite.covered, false);
  assert.match(steps[0].prerequisite.note, /not covered in your material/);
  assert.deepEqual(steps[0].example.sourceIds, ['S2']);
  assert.deepEqual(steps[0].sourceIds, ['S1', 'S2']);

  assert.equal(steps[1].example.covered, false);
  assert.match(steps[1].example.note, /not covered in your material/);
  assert.equal(steps[1].question.covered, false);

  const allowed = new Set(passages.map((p) => p.id));
  for (const step of steps) {
    for (const id of step.sourceIds) assert.ok(allowed.has(id), `${id} survived without a real passage`);
  }

  // A draft too thin to teach is refused outright.
  assert.equal(normaliseAiSteps({ steps: [raw.steps[0]] }, passages).steps, null);
});
