/**
 * The AI Teacher orchestrator.
 *
 * One place decides how an answer is produced, and it always follows the same
 * order: retrieve -> gate on evidence -> generate -> verify citations.
 *
 * Failure behaviour is explicit and never silent:
 *   - No AI key            -> deterministic demo answer (still grounded, cited).
 *   - AI provider fails    -> demo answer PLUS the reason the provider failed.
 *   - No relevant passage  -> an honest "your material does not cover this".
 *   - Empty library        -> an honest "upload something first".
 * The client always receives `generationMode` and `provenance` so the UI can
 * never present a local extractive answer as if a model wrote it.
 */
import { detectLanguage } from '../retrieval/tokenize.js';
import { ANSWER_MODES, ANSWER_LENGTHS, DEFAULT_MODE, DEFAULT_LENGTH, buildAnswerMessages } from './prompts.js';
import {
  preparePassages,
  validateCitations,
  stripInvalidCitations,
  findUnsupportedQuotes,
  clampAnswer,
} from './grounding.js';
import { buildDemoAnswer, buildInsufficientAnswer, buildNoMaterialsAnswer } from './demoTeacher.js';

function uniqueTopics(passages, limit = 6) {
  const seen = new Set();
  const topics = [];
  for (const p of passages) {
    const raw = p.heading ?? p.text.slice(0, 90);
    const topic = String(raw).replace(/\s+/g, ' ').trim();
    const key = topic.toLowerCase().slice(0, 60);
    if (!topic || seen.has(key)) continue;
    seen.add(key);
    topics.push(topic.length > 80 ? `${topic.slice(0, 77)}...` : topic);
    if (topics.length >= limit) break;
  }
  return topics;
}

export function createTeacher({ retrieval, provider, config, logger }) {
  const providerInfo = provider
    ? { id: provider.id, label: provider.label, model: provider.model }
    : null;

  async function answer({ learnerId, question, mode = DEFAULT_MODE, length = DEFAULT_LENGTH, materialIds = null }) {
    const safeMode = ANSWER_MODES.some((m) => m.id === mode) ? mode : DEFAULT_MODE;
    const safeLength = ANSWER_LENGTHS.some((l) => l.id === length) ? length : DEFAULT_LENGTH;
    const language = detectLanguage(question);

    const search = await retrieval.search({ learnerId, query: question, materialIds });

    const baseRetrieval = {
      queryTerms: search.queryTerms,
      unknownTerms: search.unknownTerms,
      knownTerms: search.knownTerms,
      vocabularyOk: search.vocabularyOk,
      reason: search.reason,
      closestPassages: search.candidates,
      documentsSearched: search.documentsSearched,
      hasMaterials: search.hasMaterials,
      searchedMaterialIds: search.searchedMaterialIds,
      minScore: search.minScore,
      topK: search.topK,
      passages: search.results.map((r) => ({
        passageId: r.passageId,
        materialId: r.materialId,
        documentName: r.documentName,
        pageNumber: r.pageNumber,
        score: r.score,
        matchedTerms: r.matchedTerms,
      })),
    };

    // --- nothing uploaded yet -------------------------------------------------
    if (!search.hasMaterials) {
      return {
        answer: buildNoMaterialsAnswer({ language }),
        kind: 'no_materials',
        generationMode: 'demo',
        provider: providerInfo,
        fallback: null,
        citations: [],
        warnings: [],
        unsupportedQuotes: [],
        retrieval: baseRetrieval,
        provenance:
          'No study material is indexed for this learner, so no retrieval or generation was attempted.',
      };
    }

    // --- material exists but does not answer the question --------------------
    if (!search.supported) {
      const owned = await retrieval.allPassages(learnerId, materialIds);
      return {
        answer: buildInsufficientAnswer({
          language,
          queryTerms: search.queryTerms,
          unknownTerms: search.unknownTerms,
          availableTopics: uniqueTopics(owned),
          reason: search.reason,
        }),
        kind: 'insufficient_material',
        generationMode: 'demo',
        provider: providerInfo,
        fallback: null,
        citations: [],
        warnings: [],
        unsupportedQuotes: [],
        retrieval: baseRetrieval,
        provenance:
          search.reason === 'too_many_unknown_terms'
            ? 'The question used words that do not appear anywhere in your material, so it was not judged to be about your notes. The teacher refused to answer rather than guess.'
            : `Retrieval found no passage scoring at or above the ${search.minScore} coverage threshold, so the teacher refused to answer rather than guess.`,
      };
    }

    // --- grounded answer -----------------------------------------------------
    const { passages, notes, truncated, usedChars } = preparePassages(search.results, {
      contextChars: config.retrieval.contextChars,
    });

    let rawAnswer = null;
    let fallback = null;
    let generationMode = 'demo';
    const warnings = [...notes];

    if (provider) {
      try {
        const startedAt = Date.now();
        const response = await provider.chat({
          messages: buildAnswerMessages({ question, passages, mode: safeMode, length: safeLength, language }),
          temperature: 0.25,
          maxTokens: safeLength === 'detailed' ? 2200 : 1400,
        });
        rawAnswer = response.content;
        generationMode = 'live';
        logger.info('answer generated', {
          learnerId,
          provider: provider.id,
          model: provider.model,
          ms: Date.now() - startedAt,
          passages: passages.length,
          mode: safeMode,
        });
      } catch (err) {
        // Never fail the request because a free-tier provider hiccuped; degrade
        // to the deterministic teacher and tell the student exactly what broke.
        fallback = { code: err.code ?? 'ai_provider_error', message: err.message };
        logger.warn('ai provider failed, falling back to local teacher', {
          learnerId,
          provider: provider.id,
          code: fallback.code,
          message: err.message,
        });
        warnings.push({
          code: 'ai_provider_fallback',
          message: `${err.message} This answer was produced locally from your material instead.`,
        });
      }
    }

    if (rawAnswer === null) {
      const demo = buildDemoAnswer({ question, passages, mode: safeMode, length: safeLength, language });
      rawAnswer = demo.markdown;
      if (demo.skippedAsInstruction > 0) {
        warnings.push({
          code: 'unsafe_sentences_skipped',
          message: `${demo.skippedAsInstruction} sentence(s) in your material read like instructions rather than study content, so they were left out of this answer.`,
        });
      }
    }

    // --- verification --------------------------------------------------------
    const { citations, invalidIds, citedIds } = validateCitations(rawAnswer, passages);
    const cleaned = clampAnswer(stripInvalidCitations(rawAnswer, invalidIds));
    const unsupportedQuotes = findUnsupportedQuotes(cleaned, passages);

    if (invalidIds.length > 0) {
      logger.warn('model cited passages that were not retrieved', {
        learnerId,
        provider: provider?.id ?? 'local',
        invalidIds,
      });
      warnings.push({
        code: 'invalid_citations_removed',
        message: `Removed ${invalidIds.length} citation${invalidIds.length > 1 ? 's' : ''} that did not match any retrieved passage (${invalidIds.join(', ')}).`,
      });
    }
    if (unsupportedQuotes.length > 0) {
      logger.warn('model used a quotation not present in the retrieved text', {
        learnerId,
        count: unsupportedQuotes.length,
      });
      warnings.push({
        code: 'unverified_quotation',
        message: `${unsupportedQuotes.length} quotation${unsupportedQuotes.length > 1 ? 's' : ''} in this answer could not be found in the retrieved passages. Treat them with suspicion.`,
      });
    }

    const provenance =
      generationMode === 'live'
        ? `${providerInfo.label} (${providerInfo.model}) generated this from the ${passages.length} passage(s) retrieved from your material. Citations were verified against the retrieval results; ${citedIds.length} were used.`
        : fallback
          ? `Generated locally by extracting text from your own material. The AI provider could not be used: ${fallback.message}`
          : `Generated locally by extracting text from your own material. No AI provider key is configured, so no text left this machine.`;

    return {
      answer: cleaned,
      kind: 'grounded',
      generationMode,
      provider: providerInfo,
      fallback,
      citations,
      warnings,
      unsupportedQuotes,
      retrieval: { ...baseRetrieval, contextCharsUsed: usedChars, truncated },
      provenance,
    };
  }

  return { answer, providerInfo };
}

export default createTeacher;
