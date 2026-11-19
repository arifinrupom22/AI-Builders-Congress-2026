/**
 * Visual Study Studio routes.
 *
 * Generation mirrors the quiz and flashcards endpoints: 422 with an honest,
 * structured reason when the material cannot support a useful visual - the
 * response says what WAS found in the text, so "no visual" reads as an
 * explanation, not a failure. Saved visuals keep their citations, so a
 * picture can be re-read with its sources months later.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import AppError from '../errors.js';
import { parseBody } from './validate.js';
import { assertSafeId } from '../storage/store.js';
import { VISUAL_KINDS, DEFAULT_VISUAL_KIND } from '../visuals/service.js';

const generateSchema = z.object({
  topic: z.string().trim().max(300).optional().default(''),
  materialIds: z.array(z.string().trim()).max(50).nullable().optional(),
  kind: z
    .string()
    .refine((id) => id === DEFAULT_VISUAL_KIND || VISUAL_KINDS.some((k) => k.id === id), {
      message: 'Unknown visual kind.',
    })
    .optional()
    .default(DEFAULT_VISUAL_KIND),
  // "auto" follows the material; "en"/"bn" follow the student's choice.
  language: z.enum(['auto', 'en', 'bn']).optional().default('auto'),
});

/** How many drawable parts a finished visual has, for the history list. */
function partCount(visual) {
  if (visual.kind === 'concept-map') return visual.nodes.length + visual.edges.length;
  if (visual.kind === 'flowchart') return visual.steps.length;
  if (visual.kind === 'comparison') return visual.rows.length;
  if (visual.kind === 'timeline') return visual.events.length;
  return 0;
}

const toVisualSummary = (v) => ({
  id: v.id,
  kind: v.visual.kind,
  title: v.visual.title,
  createdAt: v.createdAt,
  documents: v.stats?.documents ?? [],
  parts: partCount(v.visual),
  citations: v.citations?.length ?? 0,
  generationMode: v.generationMode,
  language: v.visual.language ?? 'en',
});

export function visualsRouter({ store, visualsService }) {
  const router = express.Router();

  // Registered before "/:id" so "meta" is a fixed segment, never a visual id.
  router.get('/meta/options', (req, res) => {
    res.json({ kinds: VISUAL_KINDS, defaultKind: DEFAULT_VISUAL_KIND });
  });

  router.post('/generate', async (req, res) => {
    const body = parseBody(generateSchema, req.body);
    const materialIds =
      body.materialIds && body.materialIds.length > 0
        ? body.materialIds.map((id) => assertSafeId(id, 'material id'))
        : null;

    const result = await visualsService.build({
      learnerId: req.learnerId,
      materialIds,
      topic: body.topic,
      kind: body.kind,
      language: body.language === 'auto' ? '' : body.language,
    });

    if (!result.ok) {
      // The "not supported" answers carry the signal tally so the UI can say
      // exactly what the material does contain, rather than a bare refusal.
      const details =
        result.details ?? (result.candidates?.length ? { candidates: result.candidates } : undefined);
      return res.status(422).json({
        error: { code: result.code, message: result.message, requestId: req.id, ...(details ? { details } : {}) },
      });
    }

    const record = {
      id: randomUUID(),
      learnerId: req.learnerId,
      createdAt: new Date().toISOString(),
      visual: result.visual,
      citations: result.citations,
      generationMode: result.generationMode,
      provider: result.provider?.id ?? null,
      fallback: result.fallback ?? null,
      warnings: result.warnings,
      provenance: result.provenance,
      signals: result.signals,
      stats: result.stats,
    };
    await store.saveVisual(record);

    req.log.info('studio visual generated', {
      visualId: record.id,
      kind: record.visual.kind,
      mode: record.generationMode,
      parts: partCount(record.visual),
    });

    const { learnerId, ...publicRecord } = record;
    void learnerId;
    return res.status(201).json(publicRecord);
  });

  router.get('/', async (req, res) => {
    const visuals = await store.listVisuals(req.learnerId, { limit: 50 });
    res.json({ visuals: visuals.map(toVisualSummary) });
  });

  router.get('/:id', async (req, res) => {
    const id = assertSafeId(String(req.params.id), 'visual id');
    const record = await store.getVisual(id, req.learnerId);
    if (!record) throw AppError.notFound('That visual was not found.');
    const { learnerId, ...publicRecord } = record;
    void learnerId;
    res.json({ visual: publicRecord });
  });

  router.delete('/:id', async (req, res) => {
    const id = assertSafeId(String(req.params.id), 'visual id');
    const removed = await store.deleteVisual(id, req.learnerId);
    if (!removed) throw AppError.notFound('That visual was not found.');
    res.json({ deleted: true, visualId: id });
  });

  return router;
}

export default visualsRouter;
