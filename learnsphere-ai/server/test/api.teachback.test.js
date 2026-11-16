/**
 * Teach-back feedback.
 *
 * It must cite the learner's own passage, describe wording overlap only, refuse
 * to evaluate when the material does not cover the concept, and never produce a
 * score, grade or mastery claim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';

const PHOTOSYNTHESIS = `Photosynthesis is the process by which green plants convert light energy into chemical energy stored in glucose.

The light-dependent reactions take place in the thylakoid membrane of the chloroplast and produce ATP and NADPH.

The Calvin cycle is the light-independent stage of photosynthesis and fixes carbon dioxide into glucose using ATP and NADPH.

Chlorophyll is the green pigment that absorbs light most strongly in the blue and red parts of the spectrum.`;

const MITOSIS = `Mitosis is a type of cell division that produces two genetically identical daughter cells.

The cell cycle consists of interphase, mitosis and cytokinesis.

Chromosomes condense during prophase and separate during anaphase.`;

async function seed(h, name, text, learnerId) {
  const res = await h.api.upload(name, Buffer.from(text, 'utf8'), { mimeType: 'text/plain', learnerId });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.material;
}

test('teach-back: gives cited, wording-level feedback from the student’s material', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'photosynthesis.txt', PHOTOSYNTHESIS);

  const res = await h.api.post('/api/teachback', {
    concept: 'Photosynthesis',
    explanation:
      'Photosynthesis lets plants turn light energy into chemical energy. Chlorophyll absorbs the light, and the Calvin cycle fixes carbon dioxide into glucose using ATP and NADPH.',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body;

  assert.equal(body.status, 'evaluated');
  assert.equal(body.citations[0].documentName, 'photosynthesis.txt');
  assert.equal(body.citations[0].pageNumber, 1);
  assert.match(body.citations[0].passageId, /[0-9a-z-]+/i);

  assert.ok(body.supportedTerms.includes('photosynthesis'));
  assert.ok(body.supportedTerms.includes('chlorophyll'));
  assert.ok(body.vocabularyOverlapPercent > 40);
  assert.ok(Array.isArray(body.missingTerms));
  assert.ok(body.sentences.length >= 2);
  assert.ok(body.sentences.every((sentence) => ['supported', 'partial', 'unclear'].includes(sentence.status)));

  // It is explicitly not a grade, and carries no grade-like field.
  assert.match(body.disclaimer, /not a grade/i);
  for (const key of ['score', 'grade', 'mastery', 'predictedScore', 'ability']) {
    assert.equal(key in body, false, `unexpected grade-like field: ${key}`);
  }
  assert.match(body.notes.join(' '), /No score, grade or mastery/i);
  // The only number is a vocabulary overlap, not a mark.
  assert.equal(typeof body.vocabularyOverlapPercent, 'number');
});

test('teach-back: phrases the passage does not use are listed separately, not as mistakes', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'photosynthesis.txt', PHOTOSYNTHESIS);

  const res = await h.api.post('/api/teachback', {
    concept: 'Photosynthesis',
    explanation: 'Photosynthesis is when plants eat sunlight and make sugar. Chlorophyll is a green pigment.',
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.offMaterialTerms.length > 0);
  assert.ok(res.body.notes.some((note) => /may still be right|not a list of mistakes/i.test(note)));
});

test('teach-back: refuses to evaluate when the material does not cover the concept', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'photosynthesis.txt', PHOTOSYNTHESIS);

  const res = await h.api.post('/api/teachback', {
    concept: 'Qubit decoherence in quantum computing',
    explanation: 'Decoherence is when a qubit loses its superposition because of noise from the environment.',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'cannot_evaluate');
  assert.equal(res.body.reason, 'no_matching_material');
  assert.match(res.body.message, /cannot evaluate/i);
  assert.deepEqual(res.body.citations, []);
});

test('teach-back: an empty library says there is nothing to check against', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const res = await h.api.post('/api/teachback', {
    concept: 'Mitosis',
    explanation: 'Mitosis is a type of cell division that produces identical daughter cells.',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'cannot_evaluate');
  assert.equal(res.body.reason, 'no_material');
});

test('teach-back: validations and learner isolation', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seed(h, 'photosynthesis.txt', PHOTOSYNTHESIS, 'alice');
  await seed(h, 'mitosis.txt', MITOSIS, 'bob');

  const tooShort = await h.api.post('/api/teachback', { concept: 'Mitosis', explanation: 'short' }, 'bob');
  assert.equal(tooShort.status, 400);

  const noConcept = await h.api.post('/api/teachback', {
    concept: '',
    explanation: 'Mitosis produces two genetically identical daughter cells from one parent cell.',
  }, 'bob');
  assert.equal(noConcept.status, 400);

  // Bob's explanation of mitosis is checked only against Bob's documents.
  const bob = await h.api.post('/api/teachback', {
    concept: 'Mitosis',
    explanation: 'Mitosis produces two genetically identical daughter cells during the cell cycle.',
  }, 'bob');
  assert.equal(bob.body.status, 'evaluated');
  assert.equal(bob.body.citations[0].documentName, 'mitosis.txt');

  const alice = await h.api.post('/api/teachback', {
    concept: 'Mitosis',
    explanation: 'Mitosis produces two genetically identical daughter cells during the cell cycle.',
  }, 'alice');
  // Alice has no mitosis material, so she gets an honest refusal, not Bob's source.
  assert.equal(alice.body.status, 'cannot_evaluate');
  assert.ok(!JSON.stringify(alice.body).includes('mitosis.txt'));
});
