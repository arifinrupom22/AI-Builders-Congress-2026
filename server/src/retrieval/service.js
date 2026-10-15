/**
 * Retrieval service.
 *
 * Owns the in-memory BM25 index. One index per learner, built lazily from that
 * learner's own ready materials only - a query can never reach another
 * learner's passages because the documents are never loaded into their index
 * in the first place. The learner filter is applied at build time, not at
 * query time, so it cannot be bypassed by a crafted request.
 */
import { buildIndex, searchIndex, buildSnippet } from './bm25.js';
import { contentTokens } from './tokenize.js';

export function createRetrievalService({ store, config, logger }) {
  /** @type {Map<string, {index:object, byId:Map<string,object>, materialsById:Map<string,object>, builtAt:string}>} */
  const caches = new Map();

  async function build(learnerId) {
    const groups = await store.allPassagesForLearner(learnerId);
    const byId = new Map();
    const materialsById = new Map();
    const documents = [];

    for (const { material, passages } of groups) {
      materialsById.set(material.id, material);
      for (const passage of passages) {
        byId.set(passage.id, { ...passage, material });
        documents.push({ ref: passage.id, text: `${passage.heading ?? ''} ${passage.text}`.trim() });
      }
    }

    const index = buildIndex(documents);
    const cache = { index, byId, materialsById, builtAt: new Date().toISOString() };
    caches.set(learnerId, cache);
    logger?.debug('retrieval index built', {
      learnerId,
      materials: groups.length,
      passages: byId.size,
    });
    return cache;
  }

  async function getCache(learnerId) {
    return caches.get(learnerId) ?? build(learnerId);
  }

  return {
    async invalidate(learnerId) {
      caches.delete(learnerId);
    },

    async invalidateAll() {
      caches.clear();
    },

    /**
     * @param {{learnerId:string, query:string, materialIds?:string[], topK?:number, minScore?:number}} params
     */
    async search({ learnerId, query, materialIds = null, topK, minScore }) {
      const cache = await getCache(learnerId);
      const k = topK ?? config.retrieval.topK;
      const threshold = minScore ?? config.retrieval.minScore;

      // Over-fetch, then apply the optional material filter, so selecting a
      // subset of documents does not silently return fewer passages than asked.
      const pool =
        cache.index.N === 0
          ? {
              results: [],
              candidates: [],
              queryTerms: [],
              unknownTerms: [],
              knownTerms: 0,
              vocabularyOk: true,
              reason: 'empty_index',
              maxBm25: 0,
            }
          : searchIndex(cache.index, query, {
              topK: materialIds?.length ? Math.max(k * 4, k) : k,
              minScore: threshold,
            });

      const allowed = materialIds && materialIds.length > 0 ? new Set(materialIds) : null;
      const results = [];
      for (const hit of pool.results) {
        const passage = cache.byId.get(hit.ref);
        if (!passage) continue;
        if (allowed && !allowed.has(passage.materialId)) continue;
        results.push({
          passageId: passage.id,
          materialId: passage.materialId,
          documentName: passage.documentName,
          pageNumber: passage.pageNumber,
          heading: passage.heading ?? null,
          text: passage.text,
          snippet: buildSnippet(passage.text, hit.matchedTerms),
          charCount: passage.charCount ?? passage.text.length,
          score: Number(hit.coverage.toFixed(4)),
          bm25: Number(hit.bm25.toFixed(4)),
          rank: hit.rank,
          matchedTerms: hit.matchedTerms,
        });
        if (results.length >= k) break;
      }

      return {
        results,
        queryTerms: pool.queryTerms,
        // Terms the corpus has never seen. Reported so the UI can honestly say
        // "your material never uses the word X" when a question is refused.
        unknownTerms: pool.unknownTerms ?? [],
        knownTerms: pool.knownTerms ?? 0,
        vocabularyOk: pool.vocabularyOk ?? true,
        // Why the material was judged insufficient: empty_index,
        // no_content_terms, too_many_unknown_terms or no_passage_above_threshold.
        reason: pool.reason ?? null,
        // Low-confidence hits, offered as "closest passage in your notes" only.
        candidates: (pool.candidates ?? []).map((c) => {
          const passage = cache.byId.get(c.ref);
          if (!passage) return null;
          return {
            passageId: passage.id,
            documentName: passage.documentName,
            pageNumber: passage.pageNumber,
            score: Number(c.coverage.toFixed(4)),
          };
        }).filter(Boolean).filter((c) => !results.some((r) => r.passageId === c.passageId)),
        minScore: threshold,
        topK: k,
        supported: results.length > 0,
        documentsSearched: cache.index.docCount,
        // Distinguishes "your material does not cover this" from "you have not
        // uploaded anything yet" - two very different things to tell a student.
        hasMaterials: cache.index.docCount > 0,
        searchedMaterialIds: allowed ? [...allowed] : [...cache.materialsById.keys()],
      };
    },

    async getPassage(learnerId, passageId) {
      const cache = await getCache(learnerId);
      return cache.byId.get(passageId) ?? null;
    },

    async listMaterials(learnerId) {
      const cache = await getCache(learnerId);
      return [...cache.materialsById.values()];
    },

    /** Every indexed passage for a learner, in stable order. Used by quiz generation. */
    async allPassages(learnerId, materialIds = null) {
      const cache = await getCache(learnerId);
      const allowed = materialIds && materialIds.length > 0 ? new Set(materialIds) : null;
      return [...cache.byId.values()].filter((p) => !allowed || allowed.has(p.materialId));
    },

    async stats(learnerId) {
      const cache = await getCache(learnerId);
      const terms = cache.index.df.size;
      return {
        indexedMaterials: cache.materialsById.size,
        indexedPassages: cache.byId.size,
        uniqueTerms: terms,
        builtAt: cache.builtAt,
      };
    },

    /** Cheap helper used by the health endpoint and the materials search UI. */
    termsFor(query) {
      return contentTokens(query);
    },
  };
}

export default createRetrievalService;
