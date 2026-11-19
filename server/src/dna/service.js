/**
 * Learning DNA — an evidence profile of what this learner has actually done.
 *
 * Everything here is a count of recorded activity: quiz questions answered,
 * how many were correct, and the flashcards the learner rated themselves. No
 * concept is ever labelled "mastered", no ability is estimated, and no learning
 * gain is claimed — the profile reports what was recorded, and says so.
 *
 * Two rules keep it honest:
 *
 *  1. Accuracy comes only from quiz attempts, where correctness is known.
 *     Flashcard ratings are self-assessment: they are reported as ratings,
 *     never converted into an accuracy figure.
 *  2. Where there is too little evidence to point anywhere, the concept says
 *     "not enough practice data yet" rather than guessing from one data point.
 *
 * Every query is scoped to the learner id the request was made with, so two
 * study profiles on the same machine never see each other's evidence.
 */

/** The literal phrase the UI mirrors, so "thin evidence" reads the same everywhere. */
export const INSUFFICIENT_DATA = 'not enough practice data yet';

/**
 * A concept needs at least this much evidence of one kind before the profile
 * will say anything about it. One answered question is an anecdote, not a
 * signal; one self-rated card even less so.
 */
const MIN_QUIZ_ANSWERS_FOR_SIGNAL = 2;
const MIN_RATINGS_FOR_SIGNAL = 2;

/**
 * The same ceiling the revision queue uses: below this accuracy (on at least
 * two answered questions) the evidence is worth acting on. A perfect score is
 * never presented as a weak area.
 */
const PRACTICE_ACCURACY_THRESHOLD = 80;

/** Self-ratings of "Again"/"Hard" at or above this share suggest another pass. */
const WEAK_RATING_SHARE = 0.5;

const GRADES = ['again', 'hard', 'good', 'easy'];

const percent = (correct, total) => (total > 0 ? Math.round((correct / total) * 100) : null);

const plural = (count, singular, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

function laterOf(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** Concepts are merged on a normalised label, so casing/spacing never splits one. */
/**
 * Display label for a recorded topic. Quiz topics are section headings, which
 * arrive as raw markdown ("# Database transactions"); the hash is punctuation
 * from the source, not part of the concept's name.
 */
function conceptLabel(label) {
  return String(label ?? '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function conceptKey(label) {
  return conceptLabel(label).toLowerCase();
}

function addDocument(concept, source) {
  if (!source) return;
  const name = source.documentName ?? source.name ?? null;
  const materialId = source.materialId ?? null;
  if (!name && !materialId) return;
  const key = materialId || name;
  const existing = concept.documents.get(key) ?? {
    materialId,
    documentName: name ?? 'Your material',
    pages: new Set(),
  };
  if (Number.isFinite(Number(source.pageNumber)) && Number(source.pageNumber) > 0) {
    existing.pages.add(Number(source.pageNumber));
  }
  concept.documents.set(key, existing);
}

function ensureConcept(concepts, label) {
  const key = conceptKey(label);
  const existing = concepts.get(key);
  if (existing) return existing;
  const created = {
    concept: conceptLabel(label) || 'General',
    key,
    documents: new Map(),
    quiz: {
      questions: 0,
      answered: 0,
      correct: 0,
      skipped: 0,
      quizzes: new Set(),
      lastPractisedAt: null,
    },
    flashcards: {
      ratings: 0,
      reviewedCards: 0,
      grades: Object.fromEntries(GRADES.map((grade) => [grade, 0])),
      decks: new Set(),
      lastPractisedAt: null,
    },
  };
  concepts.set(key, created);
  return created;
}

/**
 * One plain-words verdict per concept, driven only by the counts above.
 * `suggested` is null when the evidence is too thin to say either way.
 */
export function morePracticeFor({ quiz, flashcards }) {
  const answered = quiz.answered;
  const ratings = flashcards.ratings;
  const evidence = answered + ratings;

  if (evidence === 0) {
    return {
      state: 'not-enough-data',
      suggested: null,
      reason: `${INSUFFICIENT_DATA}: nothing has been recorded for this concept.`,
    };
  }

  if (answered < MIN_QUIZ_ANSWERS_FOR_SIGNAL && ratings < MIN_RATINGS_FOR_SIGNAL) {
    return {
      state: 'not-enough-data',
      suggested: null,
      reason: `${INSUFFICIENT_DATA}: ${plural(answered, 'quiz question')} answered and ${plural(
        ratings,
        'flashcard rating',
      )} recorded — too little to point anywhere.`,
    };
  }

  const accuracy = percent(quiz.correct, answered);
  if (answered >= MIN_QUIZ_ANSWERS_FOR_SIGNAL && accuracy < PRACTICE_ACCURACY_THRESHOLD) {
    return {
      state: 'suggested',
      suggested: true,
      reason: `You answered ${quiz.correct} of ${answered} questions correctly here (${accuracy}%). That is a real signal to come back to this concept.`,
    };
  }

  const weakRatings = flashcards.grades.again + flashcards.grades.hard;
  if (ratings >= MIN_RATINGS_FOR_SIGNAL && weakRatings / ratings >= WEAK_RATING_SHARE) {
    return {
      state: 'suggested',
      suggested: true,
      reason: `${weakRatings} of your ${ratings} flashcard ratings here were "Again" or "Hard". Your own ratings suggest another pass would help.`,
    };
  }

  if (answered >= MIN_QUIZ_ANSWERS_FOR_SIGNAL && accuracy !== null) {
    return {
      state: 'none-suggested',
      suggested: false,
      reason: `You answered ${quiz.correct} of ${answered} questions correctly (${accuracy}%). The recorded evidence does not currently point to extra practice — this is not a mastery claim.`,
    };
  }

  return {
    state: 'none-suggested',
    suggested: false,
    reason: `Your ${plural(ratings, 'flashcard rating')} here lean "Good" or "Easy". Nothing recorded points to extra practice — this is not a mastery claim.`,
  };
}

export function createDnaService({ store }) {
  async function profile(learnerId) {
    const [attempts, decks, materials] = await Promise.all([
      store.listAttempts(learnerId, { limit: 500 }),
      store.listDecks(learnerId, { limit: 500 }),
      store.listMaterials(learnerId),
    ]);

    const concepts = new Map();
    let questionsAnswered = 0;
    let questionsCorrect = 0;
    let questionsSkipped = 0;
    let lastActivityAt = null;

    // --- quiz evidence: correctness is known, so only this yields accuracy ---
    for (const attempt of attempts) {
      lastActivityAt = laterOf(lastActivityAt, attempt.createdAt);
      for (const result of attempt.results ?? []) {
        const label = result.topic || result.source?.documentName || 'General';
        const concept = ensureConcept(concepts, label);
        concept.quiz.questions += 1;
        concept.quiz.quizzes.add(attempt.quizId ?? attempt.id);
        concept.quiz.lastPractisedAt = laterOf(concept.quiz.lastPractisedAt, attempt.createdAt);
        if (result.skipped) {
          questionsSkipped += 1;
          concept.quiz.skipped += 1;
        } else {
          questionsAnswered += 1;
          concept.quiz.answered += 1;
          if (result.correct) {
            questionsCorrect += 1;
            concept.quiz.correct += 1;
          }
        }
        addDocument(concept, result.source);
      }
    }

    // --- flashcard evidence: self-ratings, never an accuracy figure ---------
    let ratings = 0;
    let cardsReviewed = 0;
    for (const deck of decks) {
      for (const card of deck.cards) {
        const reviews = card.stats?.reviews ?? 0;
        if (reviews === 0) continue;
        const label = deck.topic?.trim() || card.source?.documentName || 'General';
        const concept = ensureConcept(concepts, label);
        concept.flashcards.ratings += reviews;
        concept.flashcards.reviewedCards += 1;
        concept.flashcards.decks.add(deck.id);
        for (const grade of GRADES) {
          concept.flashcards.grades[grade] += card.stats?.[grade] ?? 0;
        }
        concept.flashcards.lastPractisedAt = laterOf(
          concept.flashcards.lastPractisedAt,
          card.stats?.lastReviewedAt ?? deck.lastReviewedAt ?? null,
        );
        lastActivityAt = laterOf(lastActivityAt, card.stats?.lastReviewedAt ?? deck.lastReviewedAt ?? null);
        ratings += reviews;
        cardsReviewed += 1;
        addDocument(concept, card.source);
      }
    }

    const list = [...concepts.values()]
      .map((concept) => {
        const accuracy = percent(concept.quiz.correct, concept.quiz.answered);
        // Skipped questions are recorded activity, but they are not evidence a
        // practice signal can be read from, so they are reported separately and
        // never counted here.
        const evidenceCount = concept.quiz.answered + concept.flashcards.ratings;
        return {
          concept: concept.concept,
          key: concept.key,
          documents: [...concept.documents.values()]
            .map((doc) => ({
              materialId: doc.materialId,
              documentName: doc.documentName,
              pages: [...doc.pages].sort((a, b) => a - b),
            }))
            .sort((a, b) => a.documentName.localeCompare(b.documentName)),
          quiz: {
            quizzes: concept.quiz.quizzes.size,
            questions: concept.quiz.questions,
            answered: concept.quiz.answered,
            correct: concept.quiz.correct,
            skipped: concept.quiz.skipped,
            accuracy,
            lastPractisedAt: concept.quiz.lastPractisedAt,
          },
          flashcards: {
            decks: concept.flashcards.decks.size,
            reviewedCards: concept.flashcards.reviewedCards,
            ratings: concept.flashcards.ratings,
            grades: { ...concept.flashcards.grades },
            lastPractisedAt: concept.flashcards.lastPractisedAt,
          },
          evidenceCount,
          morePractice: morePracticeFor(concept),
        };
      })
      .sort((a, b) => b.evidenceCount - a.evidenceCount || a.concept.localeCompare(b.concept));

    const materialsPractised = new Set();
    for (const concept of concepts.values()) {
      for (const doc of concept.documents.values()) {
        if (doc.materialId) materialsPractised.add(doc.materialId);
      }
    }

    return {
      learnerId,
      generatedAt: new Date().toISOString(),
      hasEnoughData: list.some((concept) => concept.evidenceCount >= 2),
      insufficientDataLabel: INSUFFICIENT_DATA,
      // Published so the UI explains the same rule the server applies.
      practiceAccuracyThreshold: PRACTICE_ACCURACY_THRESHOLD,
      totals: {
        quizzesAttempted: attempts.length,
        questionsAnswered,
        questionsCorrect,
        questionsSkipped,
        overallAccuracy: percent(questionsCorrect, questionsAnswered),
        decks: decks.length,
        cardsReviewed,
        ratings,
        conceptsPractised: list.length,
        materialsPractised: materialsPractised.size,
        materialsInLibrary: materials.length,
        lastActivityAt,
      },
      concepts: list,
      disclaimer:
        'Learning DNA summarises the quiz answers and flashcard ratings saved under this learner profile. It is a record of what you have practised, not a measure of ability, mastery, or learning gain.',
    };
  }

  return { profile };
}

export default createDnaService;
