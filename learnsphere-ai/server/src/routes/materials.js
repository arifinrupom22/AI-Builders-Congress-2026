/**
 * Study material routes: upload, list, inspect, search, delete.
 *
 * Every handler is scoped to `req.learnerId`, so a request can never read,
 * search or delete a document belonging to anyone else - a foreign id returns
 * 404, exactly as if it did not exist.
 */
import express from 'express';
import { z } from 'zod';
import AppError from '../errors.js';
import { ingestMaterial } from '../documents/ingest.js';
import { assertSafeId } from '../storage/store.js';
import { parseBody, parseQuery } from './validate.js';
import { ANSWER_MODES, ANSWER_LENGTHS } from '../ai/prompts.js';

const idParam = z.string().trim();

const passagesQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(5),
});

const searchQuery = z.object({
  q: z.string().trim().min(1, 'Provide a search term.').max(500),
  limit: z.coerce.number().int().min(1).max(20).default(8),
  materialIds: z.string().trim().max(2000).optional(),
});

// Learner-set organisation. Every bound is enforced server-side: the browser
// is a convenience, never the guarantee. An empty subject becomes null so the
// UI can show a real "Unsorted" bucket instead of a placeholder name.
const MAX_TAGS = 12;
const organiseBody = z
  .object({
    subject: z
      .string()
      .trim()
      .max(60, 'A subject can be at most 60 characters.')
      .nullable()
      .optional(),
    tags: z.preprocess(
      // Blank entries are dropped rather than rejected: a stray comma in the
      // tag box should not cost the learner a whole save.
      (tags) => (Array.isArray(tags) ? tags.filter((t) => typeof t === 'string' && t.trim() !== '') : tags),
      z
        .array(z.string().trim().max(32, 'A tag can be at most 32 characters.'))
        .max(MAX_TAGS, `At most ${MAX_TAGS} tags per document.`)
        .optional(),
    ),
    pinned: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Supply at least one of: subject, tags, pinned.',
  });

/** Normalise tags: trim, drop empties, de-duplicate case-insensitively. */
function normaliseTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of tags) {
    const tag = String(raw).trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

function parseMaterialIds(raw) {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return null;
  if (ids.length > 50) throw AppError.badRequest('Too many material ids supplied.');
  return ids.map((id) => assertSafeId(id, 'material id'));
}

export function materialsRouter({ store, retrieval, config, logger, uploadMiddleware }) {
  const router = express.Router();

  router.post('/', uploadMiddleware, async (req, res) => {
    const result = await ingestMaterial({
      store,
      retrieval,
      config,
      logger,
      learnerId: req.learnerId,
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
    });

    if (!result.ok) {
      // The record is kept so the student can see and remove the failed file.
      return res.status(422).json({
        material: result.material,
        error: {
          code: result.error?.code ?? 'extraction_failed',
          message: result.error?.message ?? 'The text could not be extracted from this file.',
          requestId: req.id,
        },
        provenance: 'The file was stored so you can see what went wrong, but nothing was indexed from it.',
      });
    }

    return res.status(201).json({
      material: result.material,
      provenance: `${result.passages.length} passage(s) indexed across ${result.material.pageCount} page(s). They are now searchable by the AI Teacher and the quiz generator.`,
    });
  });

  router.get('/', async (req, res) => {
    const [materials, stats] = await Promise.all([store.listMaterials(req.learnerId), retrieval.stats(req.learnerId)]);
    res.json({ materials, index: stats });
  });

  router.get('/search', async (req, res) => {
    const { q, limit, materialIds } = parseQuery(searchQuery, req.query);
    const search = await retrieval.search({
      learnerId: req.learnerId,
      query: q,
      materialIds: parseMaterialIds(materialIds),
      topK: limit,
    });
    res.json({
      query: q,
      queryTerms: search.queryTerms,
      resultCount: search.results.length,
      supported: search.supported,
      documentsSearched: search.documentsSearched,
      results: search.results.map((r) => ({
        passageId: r.passageId,
        materialId: r.materialId,
        documentName: r.documentName,
        pageNumber: r.pageNumber,
        heading: r.heading,
        snippet: r.snippet,
        score: r.score,
        matchedTerms: r.matchedTerms,
      })),
    });
  });

  // Declared before '/:id' so it cannot be shadowed by the id route.
  router.get('/meta/options', (req, res) => {
    res.json({
      allowedExtensions: config.upload.allowedExtensions,
      maxUploadBytes: config.upload.maxBytes,
      maxDocuments: config.upload.maxDocuments,
      answerModes: ANSWER_MODES,
      answerLengths: ANSWER_LENGTHS,
    });
  });

  router.get('/:id', async (req, res) => {
    const id = assertSafeId(idParam.parse(req.params.id), 'material id');
    const material = await store.getMaterial(id, req.learnerId);
    if (!material) throw AppError.notFound('That material is not in your library.');

    const passages = await store.readPassages(id);
    res.json({
      material,
      passageCount: passages.length,
      outline: passages.slice(0, 40).map((p) => ({
        passageId: p.id,
        pageNumber: p.pageNumber,
        heading: p.heading,
        charCount: p.charCount,
      })),
    });
  });

  router.get('/:id/passages', async (req, res) => {
    const id = assertSafeId(idParam.parse(req.params.id), 'material id');
    const { page, limit } = parseQuery(passagesQuery, req.query);
    const material = await store.getMaterial(id, req.learnerId);
    if (!material) throw AppError.notFound('That material is not in your library.');

    const passages = await store.readPassages(id);
    const start = (page - 1) * limit;
    res.json({
      material: { id: material.id, name: material.name, pageCount: material.pageCount },
      page,
      limit,
      totalPassages: passages.length,
      hasMore: start + limit < passages.length,
      passages: passages.slice(start, start + limit).map((p) => ({
        passageId: p.id,
        pageNumber: p.pageNumber,
        heading: p.heading,
        text: p.text,
        charCount: p.charCount,
      })),
    });
  });

  // Organisation: subject, tags, pinning. Content, passages and citations are
  // untouched — this only labels the record the learner already has.
  router.patch('/:id', async (req, res) => {
    const id = assertSafeId(idParam.parse(req.params.id), 'material id');
    const patch = parseBody(organiseBody, req.body);

    const existing = await store.getMaterial(id, req.learnerId);
    if (!existing) throw AppError.notFound('That material is not in your library.');

    const update = {};
    if ('subject' in patch) update.subject = patch.subject?.trim() || null;
    if ('tags' in patch) update.tags = normaliseTags(patch.tags);
    if ('pinned' in patch) update.pinned = patch.pinned === true;

    const material = await store.organiseMaterial(id, req.learnerId, update);
    if (!material) throw AppError.notFound('That material is not in your library.');

    req.log.info('material organised', {
      materialId: id,
      fields: Object.keys(update),
      pinned: material.pinned,
    });
    res.json({
      material,
      provenance: 'Your organisation labels are stored with the document; its text, passages and citations are unchanged.',
    });
  });

  router.delete('/:id', async (req, res) => {
    const id = assertSafeId(idParam.parse(req.params.id), 'material id');
    const removed = await store.deleteMaterial(id, req.learnerId);
    if (!removed) throw AppError.notFound('That material is not in your library.');
    await retrieval.invalidate(req.learnerId);
    req.log.info('material deleted', { materialId: id });
    res.json({ deleted: true, materialId: id, provenance: 'The stored file, its passages and its index entry were all removed.' });
  });

  return router;
}

export default materialsRouter;
