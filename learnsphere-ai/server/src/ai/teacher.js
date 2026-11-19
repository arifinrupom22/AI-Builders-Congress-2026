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
import { detectQuestionLanguage } from '../retrieval/tokenize.js';
import {
  ANSWER_MODES,
  ANSWER_LENGTHS,
  DEFAULT_MODE,
  DEFAULT_LENGTH,
  buildAnswerMessages,
  buildGeneralMessages,
  buildConversationMessages,
  buildChatFallback,
  buildStudyIntentReply,
  normaliseAnswerFormat,
  BANGLA_RETRY_DIRECTIVE,
  ENGLISH_RETRY_DIRECTIVE,
} from './prompts.js';
import { detectAnswerRequest, detectSmallTalk, isFollowUp, isTimeSensitive } from './instructions.js';
import {
  preparePassages,
  validateCitations,
  stripInvalidCitations,
  findUnsupportedQuotes,
  clampAnswer,
} from './grounding.js';
import { buildDemoAnswer, buildInsufficientAnswer, buildNoMaterialsAnswer } from './demoTeacher.js';

/** Bangla characters in a string - the measure of "is this really Bangla". */
export function banglaCharCount(text) {
  return (String(text ?? '').match(/[\u0980-\u09FF]/g) ?? []).length;
}

/**
 * Did a model ignore the requested answer language?
 *
 * A Bangla answer of any useful length carries far more than 40 Bangla
 * characters, so anything below that is an English (or romanised) answer to a
 * Bangla question. It is checked after generation rather than trusted from the
 * prompt: small models drop the style block when they are busy.
 */
export const BANGLA_MIN_CHARS = 40;

export function needsBanglaRetry(language, answer) {
  return language === 'bn' && banglaCharCount(answer) < BANGLA_MIN_CHARS;
}

/** Latin letters, the measure of "is this really English". */
export function latinCharCount(text) {
  return (String(text ?? '').match(/[A-Za-z]/g) ?? []).length;
}

/**
 * An English answer that came back in Bangla.
 *
 * The mirror image of needsBanglaRetry: when the material is Bangla and the
 * student explicitly asks for English, small models often keep writing Bangla.
 * More than 150 Bangla characters is not an English answer with a few Bangla
 * terms, it is a Bangla answer.
 */
export function needsEnglishRetry(language, answer) {
  return language === 'en' && banglaCharCount(answer) > 150;
}

/**
 * Keep one document's passages when it clearly outranks the others.
 *
 * A library is often several unrelated subjects. Blending them produces an
 * answer that quotes two topics at once, which reads as if the tutor confused
 * the material. When the best document scores clearly above the next one, the
 * answer is built from it alone and the warning names what was left out.
 */
export function focusOnDominantDocument(results) {
  if (!Array.isArray(results) || results.length < 3) return { results: results ?? [], dropped: [], keptDocument: null };

  const bestByDocument = new Map();
  for (const hit of results) {
    const current = bestByDocument.get(hit.materialId);
    if (!current || hit.score > current.score) {
      bestByDocument.set(hit.materialId, { score: hit.score, name: hit.documentName });
    }
  }
  if (bestByDocument.size < 2) return { results, dropped: [], keptDocument: null };

  const ranked = [...bestByDocument.entries()].sort((a, b) => b[1].score - a[1].score);
  const [topId, top] = ranked[0];
  const runnerUp = ranked[1][1];
  if (top.score < runnerUp.score * 1.35) return { results, dropped: [], keptDocument: null };

  const kept = results.filter((hit) => hit.materialId === topId);
  if (kept.length < 2) return { results, dropped: [], keptDocument: null };

  return {
    results: kept,
    dropped: ranked.slice(1).map(([, info]) => info.name),
    keptDocument: top.name,
  };
}

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

  /**
   * Ask the model, then enforce the answer language.
   *
   * A Bangla question answered in English, or an explicit English request
   * answered in Bangla, is a wrong answer rather than a style preference. One
   * retry restates the rule in the last message (which small models follow far
   * more reliably than the style block), and whichever attempt actually matches
   * the requested language wins.
   */
  async function chatWithLanguage({ messages, maxTokens, temperature = 0.25, language }) {
    const first = await provider.chat({ messages, temperature, maxTokens });
    const mismatched =
      language === 'bn'
        ? needsBanglaRetry(language, first.content)
        : needsEnglishRetry(language, first.content);
    if (!mismatched) return first;

    const directive = language === 'bn' ? BANGLA_RETRY_DIRECTIVE : ENGLISH_RETRY_DIRECTIVE;
    const retryMessages = messages.map((message, index) =>
      index === messages.length - 1
        ? { ...message, content: `${message.content}\n\n${directive}` }
        : message,
    );
    logger.warn('answer language did not match the request, retrying once', { language });

    try {
      const retry = await provider.chat({ messages: retryMessages, temperature, maxTokens });
      const better =
        language === 'bn'
          ? banglaCharCount(retry.content) > banglaCharCount(first.content)
          : latinCharCount(retry.content) > latinCharCount(first.content);
      return better ? retry : first;
    } catch (err) {
      logger.warn('language retry failed, keeping the first answer', { message: err.message });
      return first;
    }
  }

  /**
   * Answer a greeting, thanks, goodbye or "who are you".
   *
   * No retrieval and no citation: there is nothing in the notes to find, and
   * running "Hi" through the general-knowledge path made the tutor apologise
   * that the uploaded material did not cover it. A student who says hello gets
   * a person-shaped reply, and the UI labels it as a conversation.
   */
  async function answerSmallTalk({ learnerId, category, question }) {
    const detected = detectQuestionLanguage(question);
    const language = detected === 'en' ? 'en' : 'bn';
    const banglish = detected === 'banglish';
    const base = {
      kind: 'chat',
      citations: [],
      warnings: [],
      unsupportedQuotes: [],
      retrieval: null,
      provider: providerInfo,
    };

    if (!provider) {
      return {
        ...base,
        answer: buildChatFallback({ category, language }),
        generationMode: 'demo',
        fallback: null,
        provenance:
          'No AI key is configured, so this is a fixed conversational reply rather than a generated one.',
      };
    }

    try {
      const response = await chatWithLanguage({
        messages: buildConversationMessages({ message: question, category, language, banglish }),
        maxTokens: 320,
        temperature: 0.6,
        language,
      });
      logger.info('conversational reply generated', { learnerId, category });
      return {
        ...base,
        answer: response.content.trim(),
        generationMode: 'live',
        fallback: null,
        provenance:
          'A greeting is not a question about your material, so nothing was retrieved and nothing is cited.',
      };
    } catch (err) {
      logger.warn('conversational reply failed, using the fixed reply', {
        learnerId,
        code: err.code ?? 'ai_provider_error',
        message: err.message,
      });
      return {
        ...base,
        answer: buildChatFallback({ category, language }),
        generationMode: 'demo',
        fallback: { code: err.code ?? 'ai_provider_error', message: err.message },
        provenance: 'The AI provider failed, so this is a fixed conversational reply.',
      };
    }
  }

  /**
   * "Ami poralekha korbo" - the student is telling you they are about to
   * study, not asking what essay writing is.
   *
   * Answered locally and immediately: no retrieval, no model, no citations and
   * no coverage warning. Naming the student's own ready material turns the
   * statement into a concrete first step, which is what a tutor would do.
   */
  async function answerStudyIntent({ learnerId, question }) {
    const detected = detectQuestionLanguage(question);
    // "pora lekha korbo" and "study korbo" are Banglish even though every
    // character is Latin: the study words themselves decide the language, so a
    // Banglish sentence never gets an English reply.
    const banglishStudy = /\b(?:pora|lekha|poralekha|porashona|korbo|korte|chai|bosbo|boshbo|porbo|porte)\b/i.test(
      question,
    );
    const language = banglishStudy ? 'bn' : detected === 'en' ? 'en' : 'bn';
    let materials = [];
    try {
      const all = await retrieval.listMaterials(learnerId);
      materials = (all ?? [])
        .filter((material) => material.status === 'ready')
        .map((material) => material.name ?? material.title)
        .filter(Boolean);
    } catch (err) {
      logger.warn('could not list materials for a study-intent reply', {
        learnerId,
        code: err.code ?? 'materials_unavailable',
      });
    }

    return {
      kind: 'chat',
      citations: [],
      warnings: [],
      unsupportedQuotes: [],
      retrieval: null,
      provider: providerInfo,
      answer: buildStudyIntentReply({ language, materials }),
      generationMode: 'instant',
      fallback: null,
      provenance:
        'A study-plan message needs no retrieval: this is an instant tutor reply that names your own ready material so you can pick a starting point.',
    };
  }

  async function answer({
    learnerId,
    question,
    mode = DEFAULT_MODE,
    length = DEFAULT_LENGTH,
    materialIds = null,
    previousQuestion = null,
    history = [],
  }) {
    const safeMode = ANSWER_MODES.some((m) => m.id === mode) ? mode : DEFAULT_MODE;
    const safeLength = ANSWER_LENGTHS.some((l) => l.id === length) ? length : DEFAULT_LENGTH;

    // An instruction about the answer ("ans ta english e bujhao") is not a
    // question about the material. Searching it finds the word "english" in
    // the notes, scores nothing, and used to produce "your material does not
    // cover this". Instead it re-answers the previous question in the language
    // the student just asked for.
    const request = detectAnswerRequest(question);

    // "Hi" is not a question about the notes. Sending a greeting through
    // retrieval finds nothing, and the general-knowledge path then apologised
    // that the material did not cover it. Answer it as conversation instead.
    const smallTalk = detectSmallTalk(question);
    // A statement of intent about studying gets an instant, material-aware
    // reply rather than being searched for as a topic.
    if (smallTalk === 'study') return answerStudyIntent({ learnerId, question });
    if (smallTalk) return answerSmallTalk({ learnerId, category: smallTalk, question });

    // Follow-ups ("aro bolo", "eta bujhlam na", "example dao") inherit the
    // topic of the previous turn. Searching them on their own matched nothing
    // and produced a fresh, unrelated general answer.
    const lastUserTurn = [...history].reverse().find((turn) => turn?.role === 'user')?.content ?? '';
    const followUp = Boolean(lastUserTurn) && isFollowUp(question);
    const retrievalQuery = followUp ? `${String(lastUserTurn).slice(0, 300)} ${question}`.trim() : question;

    let askedQuestion = question;
    let instructionLanguage = null;
    let search = await retrieval.search({ learnerId, query: retrievalQuery, materialIds });

    if (request.language && request.explicit && previousQuestion && !search.supported) {
      const prior = String(previousQuestion).trim();
      const priorSearch = prior.length > 1 ? await retrieval.search({ learnerId, query: prior, materialIds }) : null;
      if (priorSearch && (priorSearch.supported || priorSearch.queryTerms.length > 0)) {
        search = priorSearch;
        askedQuestion = prior;
        instructionLanguage = request.language;
        logger.info('answer instruction applied to the previous question', {
          learnerId,
          language: request.language,
        });
      }
    }

    // Bangla, Banglish (romanised Bangla) or English. Banglish is answered in
    // Bangla: the student is a Bangla speaker typing in Latin letters.
    // A follow-up keeps the language of the turn it continues, so a Bangla
    // conversation does not flip to English because "aro bolo" is Latin text.
    const languageSource = followUp && lastUserTurn ? `${lastUserTurn} ${question}` : askedQuestion;
    const detectedLanguage = instructionLanguage ?? detectQuestionLanguage(languageSource);
    const language = detectedLanguage === 'en' ? 'en' : 'bn';
    const banglish = detectedLanguage === 'banglish';

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

    /**
     * Answer a question the material does not cover, with the model, and label
     * it as general knowledge. A student asking "what is an algorithm?" before
     * uploading the right chapter deserves an explanation, not a wall of text
     * about their library. Returns null when no model is configured, so the
     * offline demo keeps its honest refusal.
     */
    async function generateGeneral(materialTitles = []) {
      if (!provider) return null;
      const startedAt = Date.now();
      const maxTokens = safeLength === 'detailed' ? 2400 : 1600;
      // "Who is the PM now?" is not a study question, and the model's answer is
      // a snapshot of its training data. Flag it so the prompt forbids present-
      // tense claims and the UI says the information may be out of date.
      const timeSensitive = isTimeSensitive(askedQuestion);
      const messages = buildGeneralMessages({
        question: askedQuestion,
        mode: safeMode,
        length: safeLength,
        language,
        banglish,
        materialTitles,
        history,
        timeSensitive,
        today: new Date().toISOString().slice(0, 10),
      });

      let response;
      try {
        response = await chatWithLanguage({ messages, maxTokens, temperature: 0.3, language });
      } catch (err) {
        logger.warn('general answer failed, falling back to the local notice', {
          learnerId,
          code: err.code ?? 'ai_provider_error',
          message: err.message,
        });
        return null;
      }

      logger.info('general answer generated', {
        learnerId,
        provider: response.providerId ?? provider.id,
        ms: Date.now() - startedAt,
        mode: safeMode,
      });

      const generalWarnings = [
        {
          code: 'answered_outside_material',
          message:
            'Your uploaded material does not cover this question, so this answer is general knowledge. Nothing here is cited from your files.',
        },
      ];
      if (timeSensitive) {
        generalWarnings.push({
          code: 'time_sensitive_unverified',
          message:
            'This question depends on current information, which the model cannot browse for. Treat anything it says about "now", "today" or who currently holds office as possibly out of date, and confirm it with a live news source.',
        });
      }

      return {
        answer: normaliseAnswerFormat(response.content, language),
        kind: 'general',
        generationMode: 'live',
        provider: providerInfo,
        fallback: null,
        citations: [],
        warnings: generalWarnings,
        unsupportedQuotes: [],
        retrieval: { ...baseRetrieval, outsideMaterial: true },
        provenance: timeSensitive
          ? `${providerInfo.label} (${providerInfo.model}) answered this from general knowledge, and it cannot browse live news. The model's knowledge has a cutoff, so any current fact here may be out of date.`
          : `${providerInfo.label} (${providerInfo.model}) answered this from general knowledge. Your uploaded material does not contain it, so no citation could be verified.`,
      };
    }

    // --- nothing uploaded yet -------------------------------------------------
    if (!search.hasMaterials) {
      const general = await generateGeneral([]);
      if (general) return general;
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
      const availableTopics = uniqueTopics(owned);
      const general = await generateGeneral(availableTopics);
      if (general) return general;
      return {
        answer: buildInsufficientAnswer({
          language,
          queryTerms: search.queryTerms,
          unknownTerms: search.unknownTerms,
          availableTopics,
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
    // Two unrelated documents must not be blended into one answer: when one
    // clearly outranks the others, answer from it and say what was left out.
    const focus = focusOnDominantDocument(search.results);
    const { passages, notes, truncated, usedChars } = preparePassages(focus.results, {
      contextChars: config.retrieval.contextChars,
    });

    let rawAnswer = null;
    let fallback = null;
    let generationMode = 'demo';
    const warnings = [...notes];
    if (focus.dropped.length > 0) {
      warnings.push({
        code: 'answered_from_one_document',
        message: `Answered from “${focus.keptDocument}” only: the other matching document (${focus.dropped.join(', ')}) is about a different topic.`,
      });
    }

    if (provider) {
      try {
        const startedAt = Date.now();
        const maxTokens = safeLength === 'detailed' ? 2200 : 1400;
        const messages = buildAnswerMessages({
          question: askedQuestion,
          passages,
          mode: safeMode,
          length: safeLength,
          language,
          banglish,
          history,
        });

        const response = await chatWithLanguage({ messages, maxTokens, language });
        rawAnswer = response.content;
        generationMode = 'live';
        logger.info('answer generated', {
          learnerId,
          // The chain reports which provider actually answered, which is not
          // always the primary one.
          provider: response.providerId ?? provider.id,
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
    const cleaned = normaliseAnswerFormat(clampAnswer(stripInvalidCitations(rawAnswer, invalidIds)), language);
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
