/**
 * Whole-document summary routes.
 *
 * A summary is generated on demand and returned in full: nothing is stored, so
 * there is no stale copy of a student's notes sitting on disk and no cache to
 * invalidate when a document is deleted.
 */
import express from 'express';
import { z } from 'zod';
import { parseBody } from './validate.js';
import { assertSafeId } from '../storage/store.js';
import { SUMMARY_LENGTHS, DEFAULT_SUMMARY_LENGTH } from '../ai/prompts.js';

const summarySchema = z.object({
  materialIds: z.array(z.string().trim()).max(50).nullable().optional(),
  length: z.enum(SUMMARY_LENGTHS.map((l) => l.id)).default(DEFAULT_SUMMARY_LENGTH),
  // null means "use the language the material is written in".
  language: z.enum(['en', 'bn']).nullable().optional(),
  focus: z.string().trim().max(300).optional().default(''),
});

export function summaryRouter({ summaryService }) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const body = parseBody(summarySchema, req.body);
    const materialIds =
      body.materialIds && body.materialIds.length > 0
        ? body.materialIds.map((id) => assertSafeId(id, 'material id'))
        : null;

    const result = await summaryService.summarise({
      learnerId: req.learnerId,
      materialIds,
      length: body.length,
      language: body.language ?? null,
      focus: body.focus,
    });

    if (!result.ok) {
      return res.status(422).json({
        error: { code: result.code, message: result.message, requestId: req.id },
      });
    }

    req.log.info('summary returned', {
      mode: result.generationMode,
      language: result.language,
      documents: result.stats.documents.length,
      passages: result.stats.passagesUsed,
      citations: result.citations.length,
    });

    return res.json({
      summary: result.summary,
      generationMode: result.generationMode,
      provider: result.provider,
      fallback: result.fallback,
      citations: result.citations,
      keyTerms: result.keyTerms,
      warnings: result.warnings,
      unsupportedQuotes: result.unsupportedQuotes,
      language: result.language,
      length: result.length,
      provenance: result.provenance,
      stats: result.stats,
    });
  });

  router.get('/meta/options', (req, res) => {
    res.json({ lengths: SUMMARY_LENGTHS, defaultLength: DEFAULT_SUMMARY_LENGTH });
  });

  return router;
}

export default summaryRouter;
