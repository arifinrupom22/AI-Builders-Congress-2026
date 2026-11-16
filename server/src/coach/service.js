/**
 * Adaptive Exam Coach.
 *
 * The coach changes what to practise next from evidence that already exists —
 * quiz attempts, their scores, and flashcard ratings — and says why. Two rules
 * keep it honest:
 *
 *  1. It never predicts a score or claims progress. Every sentence it writes is
 *     a count of recorded activity ("you answered 3 of 9 correctly here"), and
 *     the suggested style is a real capability of the quiz generator:
 *     'recall' asks what concepts mean; 'mixed' adds recognising statements
 *     from the same material. There is no application-question generator,
 *     because one would have to invent the scenario.
 *
 *  2. With too little evidence it starts with a baseline quiz instead of
 *     guessing at a weak topic, and it never touches the flashcard schedule.
 *     The review step only links to the existing "Due for review" queue.
 *
 * All queries are scoped to the learner id of the request.
 */
import { INSUFFICIENT_DATA } from '../dna/service.js';

export const COACH_DISCLAIMER =
  'The coach suggests what to practise next from the quiz answers and flashcard ratings recorded under this study profile. It does not predict scores, measure ability, or claim mastery or learning gain.';

export const STYLE_LABELS = {
  recall: 'Basic recall',
  mixed: 'Mixed question types',
};

/** Questions in a coach-suggested quiz. */
export const COACH_QUIZ_QUESTIONS = 5;

/**
 * The style ladder. A learner needs at least this many answered questions on a
 * concept, at this accuracy, before the coach moves from definitions to mixed
 * question types. Below it, recall comes first.
 */
export const ADVANCE_MIN_ANSWERS = 3;
export const ADVANCE_ACCURACY = 80;

const plural = (count, singular) => `${count} ${count === 1 ? singular : `${singular}s`}`;

function quizHref({ topic, style, materialIds = [] }) {
  const params = new URLSearchParams();
  if (topic) params.set('topic', topic);
  params.set('style', style);
  // Scope the quiz to the documents this concept was actually recorded from,
  // so a topic suggestion cannot drift into an unrelated document.
  const ids = [...new Set(materialIds.filter(Boolean))];
  if (ids.length > 0) params.set('materials', ids.join(','));
  return `/quiz?${params.toString()}`;
}

function styleLabel(style) {
  return STYLE_LABELS[style] ?? STYLE_LABELS.mixed;
}

/** One sentence tying the coach to the student's own plan, without inventing progress. */
function planTaskLine(studyPlan) {
  return studyPlan.hasTasksToday
    ? `${studyPlan.tasks.length} task(s) are planned for today in your study plan.`
    : 'Your study plan has no task scheduled for today.';
}

/** Evidence the recommendation is based on, in counts only. */
function evidenceFor(concept, totals) {
  return {
    answersOnConcept: concept?.quiz.answered ?? 0,
    correctOnConcept: concept?.quiz.correct ?? 0,
    accuracy: concept?.quiz.accuracy ?? null,
    ratingsOnConcept: concept?.flashcards.ratings ?? 0,
    weakRatingsOnConcept:
      (concept?.flashcards.grades.again ?? 0) + (concept?.flashcards.grades.hard ?? 0),
    lastPractisedAt:
      [concept?.quiz.lastPractisedAt, concept?.flashcards.lastPractisedAt]
        .filter(Boolean)
        .sort()
        .pop() ?? null,
    questionsAnswered: totals.questionsAnswered,
    ratings: totals.ratings,
    conceptsPractised: totals.conceptsPractised,
  };
}

function baselineRecommendation({ dna, readyMaterials }) {
  const totals = dna.totals;
  const nothingRecorded = totals.questionsAnswered === 0 && totals.ratings === 0;
  const reason = nothingRecorded
    ? 'No practice is recorded under this study profile yet, so the coach starts with a short baseline quiz over your ready material. A baseline is a starting point, not a test of ability.'
    : `Only ${plural(totals.questionsAnswered, 'quiz answer')} and ${plural(
        totals.ratings,
        'flashcard rating',
      )} are recorded, which is too little to choose a topic fairly. A baseline quiz gives the coach real evidence to work from.`;

  return {
    baseline: true,
    topic: '',
    topicLabel: readyMaterials.length === 1 ? readyMaterials[0].name : 'Your whole ready library',
    style: 'mixed',
    styleLabel: styleLabel('mixed'),
    reason,
    questions: COACH_QUIZ_QUESTIONS,
    href: quizHref({ topic: '', style: 'mixed' }),
    evidence: evidenceFor(null, totals),
  };
}

/**
 * Choose one concept and one supported style. Priority order:
 *   a concept whose evidence suggests practice (weakest accuracy first),
 *   otherwise the concept with the least evidence, so the record grows.
 */
function adaptiveRecommendation(concepts) {
  const withSignal = concepts
    .filter((concept) => concept.morePractice.state === 'suggested')
    .sort(
      (a, b) =>
        (a.quiz.accuracy ?? 101) - (b.quiz.accuracy ?? 101) || b.evidenceCount - a.evidenceCount,
    );

  const concept =
    withSignal[0] ??
    [...concepts].sort((a, b) => a.evidenceCount - b.evidenceCount || a.concept.localeCompare(b.concept))[0];

  const answered = concept.quiz.answered;
  const accuracy = concept.quiz.accuracy;
  const ratings = concept.flashcards.ratings;
  const weakRatings = concept.flashcards.grades.again + concept.flashcards.grades.hard;

  const solidRecall =
    answered >= ADVANCE_MIN_ANSWERS &&
    accuracy !== null &&
    accuracy >= ADVANCE_ACCURACY &&
    (ratings === 0 || weakRatings / ratings < 0.5);

  const style = solidRecall ? 'mixed' : 'recall';

  let reason;
  if (solidRecall) {
    reason = `You have answered ${concept.quiz.correct} of ${answered} questions correctly on this concept (${accuracy}%) across ${plural(
      concept.quiz.quizzes,
      'attempt',
    )}, so the coach moves you to mixed question types: definitions plus recognising statements from your material.`;
  } else if (answered >= 2 && accuracy !== null) {
    reason = `You answered ${concept.quiz.correct} of ${answered} questions correctly on this concept (${accuracy}%), so the coach starts with basic recall — definitions only — before mixing in harder question types.`;
  } else if (ratings > 0 && weakRatings / ratings >= 0.5) {
    reason = `${weakRatings} of your ${plural(ratings, 'flashcard rating')} on this concept were "Again" or "Hard", so the coach starts with basic recall to rebuild the definition.`;
  } else {
    reason = `Only ${plural(
      concept.evidenceCount,
      'piece',
    )} of evidence is recorded for this concept (${INSUFFICIENT_DATA}), so the coach suggests a short recall set to give the record something real to go on.`;
  }

  return {
    baseline: false,
    topic: concept.concept,
    topicLabel: concept.concept,
    style,
    styleLabel: styleLabel(style),
    reason,
    questions: COACH_QUIZ_QUESTIONS,
    // Refined by plan() once document names can be resolved to material ids.
    href: quizHref({
      topic: concept.concept,
      style,
      materialIds: (concept.documents ?? []).map((doc) => doc.materialId),
    }),
    documents: concept.documents,
  };
}

export function createCoachService({ store, dnaService, flashcardService, plannerService = null }) {
  async function plan(learnerId) {
    const [dna, attempts, materials, due, studyPlan] = await Promise.all([
      dnaService.profile(learnerId),
      store.listAttempts(learnerId, { limit: 50 }),
      store.listMaterials(learnerId),
      flashcardService ? flashcardService.due({ learnerId, summary: true }) : Promise.resolve(null),
      plannerService ? plannerService.todayFor(learnerId).catch(() => null) : Promise.resolve(null),
    ]);

    const readyMaterials = materials.filter((material) => material.status === 'ready');
    // Older attempts did not record a material id with their sources, so a
    // concept's document may have only a name. Resolve it when we can; that
    // keeps the suggested quiz inside the document it was recorded from.
    const materialIdByName = new Map(readyMaterials.map((material) => [material.name, material.id]));
    const readyIds = new Set(readyMaterials.map((material) => material.id));
    // A recorded material id can belong to a document that was since replaced,
    // so keep it only while it is still one of the ready materials; otherwise
    // fall back to the current document with the same name.
    const scopeFor = (concept) => [
      ...new Set(
        (concept?.documents ?? [])
          .map((doc) => (readyIds.has(doc.materialId) ? doc.materialId : materialIdByName.get(doc.documentName)))
          .filter(Boolean),
      ),
    ];
    const concepts = dna.concepts ?? [];
    const totals = {
      ...dna.totals,
      conceptsPractised: concepts.length,
    };

    let mode;
    let recommendation = null;
    if (readyMaterials.length === 0) {
      mode = 'no-material';
    } else if (!dna.hasEnoughData || concepts.length === 0) {
      mode = 'baseline';
      recommendation = baselineRecommendation({ dna, readyMaterials });
    } else {
      mode = 'adaptive';
      recommendation = adaptiveRecommendation(concepts);
      const chosen = concepts.find((concept) => concept.concept === recommendation.topic) ?? null;
      recommendation.evidence = evidenceFor(chosen, totals);
      recommendation.href = quizHref({
        topic: recommendation.topic,
        style: recommendation.style,
        materialIds: scopeFor(chosen),
      });
      if (Array.isArray(recommendation.documents)) {
        recommendation.documents = recommendation.documents.map((doc) => ({
          ...doc,
          materialId: readyIds.has(doc.materialId)
            ? doc.materialId
            : materialIdByName.get(doc.documentName) ?? null,
        }));
      }
    }

    // Documents that no quiz answer or card rating has touched yet.
    const practisedNames = new Set(
      concepts.flatMap((concept) => concept.documents.map((doc) => doc.documentName)),
    );
    const unpractised = readyMaterials.filter((material) => !practisedNames.has(material.name));

    const steps = [];
    if (recommendation) {
      steps.push({
        id: 'practice',
        kind: 'practice',
        title: `${recommendation.styleLabel} on ${
          recommendation.topic ? `“${recommendation.topic}”` : recommendation.topicLabel
        }`,
        detail: recommendation.reason,
        href: recommendation.href,
        meta: `${recommendation.questions} questions`,
      });
    }

    if (mode === 'adaptive') {
      const secondary = (concepts ?? [])
        .filter(
          (concept) =>
            concept.concept !== recommendation?.topic &&
            concept.morePractice.state === 'suggested',
        )
        .sort((a, b) => (a.quiz.accuracy ?? 101) - (b.quiz.accuracy ?? 101))[0];
      if (secondary) {
        steps.push({
          id: 'practice-second',
          kind: 'practice',
          title: `${styleLabel(secondary.quiz.answered >= ADVANCE_MIN_ANSWERS && (secondary.quiz.accuracy ?? 0) >= ADVANCE_ACCURACY ? 'mixed' : 'recall')} on “${secondary.concept}”`,
          detail: `Another concept with a practice signal: ${
            secondary.quiz.accuracy !== null
              ? `you answered ${secondary.quiz.correct} of ${secondary.quiz.answered} correctly (${secondary.quiz.accuracy}%).`
              : `${plural(secondary.flashcards.ratings, 'flashcard rating')} recorded, ${secondary.flashcards.grades.again + secondary.flashcards.grades.hard} of them "Again" or "Hard".`
          }`,
          href: quizHref({
            topic: secondary.concept,
            materialIds: scopeFor(secondary),
            style:
              secondary.quiz.answered >= ADVANCE_MIN_ANSWERS &&
              (secondary.quiz.accuracy ?? 0) >= ADVANCE_ACCURACY
                ? 'mixed'
                : 'recall',
          }),
          meta: `${COACH_QUIZ_QUESTIONS} questions`,
        });
      }
    }

    if (studyPlan) {
      const firstTask = studyPlan.tasks[0] ?? null;
      steps.push({
        id: 'plan',
        kind: 'plan',
        title: firstTask ? `Today's study plan: ${firstTask.title}` : `Study plan to ${studyPlan.examDate}`,
        detail: firstTask
          ? `${firstTask.detail} ${planTaskLine(studyPlan)}`
          : `Nothing is scheduled for today; the plan's next tasks and the topics your material does not cover are on its page. ${planTaskLine(studyPlan)}`,
        href: `/plan?id=${encodeURIComponent(studyPlan.planId)}`,
        meta: `${plural(Math.max(0, studyPlan.daysUntilExam), 'day')} to exam`,
      });
    }

    if (unpractised.length > 0) {
      const material = unpractised[0];
      steps.push({
        id: 'material',
        kind: 'material',
        title: `Read “${material.name}”`,
        detail: `No quiz answers or card ratings are recorded for this document yet. Reading it first gives the coach something real to work from.`,
        href: `/materials?id=${encodeURIComponent(material.id)}`,
        materialId: material.id,
      });
    }

    if (due) {
      const actionable = due.counts?.actionable ?? 0;
      if (actionable > 0) {
        steps.push({
          id: 'review',
          kind: 'review',
          title: `Review ${plural(actionable, 'card')} due now`,
          detail: `${due.counts.due ?? 0} past due · ${due.counts.newCards ?? 0} never rated. These dates come from your own ratings; the coach only links to the existing queue.`,
          href: '/review',
          meta: 'existing schedule',
        });
      } else if (due.counts?.totalCards > 0) {
        steps.push({
          id: 'review',
          kind: 'review',
          title: 'Nothing due for review right now',
          detail: due.nextDueAt
            ? 'The existing review schedule has its next card later. The coach does not create, move, or duplicate review dates.'
            : 'No card has a due date yet. The coach does not create review dates.',
          href: '/review',
          meta: 'existing schedule',
        });
      }
    }

    const recentAttempts = attempts.slice(0, 5).map((attempt) => ({
      quizId: attempt.quizId,
      title: attempt.title,
      topic: attempt.topic ?? null,
      percent: attempt.percent,
      correctCount: attempt.correctCount,
      answeredCount: attempt.answeredCount,
      total: attempt.total,
      createdAt: attempt.createdAt,
    }));

    return {
      learnerId,
      generatedAt: new Date().toISOString(),
      mode,
      hasEnoughData: Boolean(dna.hasEnoughData),
      recommendation,
      nextSteps: steps.slice(0, 5),
      studyPlan: studyPlan
        ? {
            id: studyPlan.planId,
            examDate: studyPlan.examDate,
            daysUntilExam: studyPlan.daysUntilExam,
            tasksToday: studyPlan.tasks.length,
          }
        : null,
      recentAttempts,
      retest: recommendation
        ? {
            topic: recommendation.topic,
            style: recommendation.style,
            href: recommendation.href,
            label: `Retest with ${recommendation.styleLabel.toLowerCase()} on ${
              recommendation.topic ? `“${recommendation.topic}”` : 'the same material'
            }`,
          }
        : null,
      review: due
        ? {
            counts: due.counts,
            nextDueAt: due.nextDueAt,
          }
        : null,
      totals: {
        quizzesAttempted: totals.quizzesAttempted ?? attempts.length,
        questionsAnswered: totals.questionsAnswered ?? 0,
        overallAccuracy: totals.overallAccuracy ?? null,
        ratings: totals.ratings ?? 0,
        conceptsPractised: concepts.length,
      },
      disclaimer: COACH_DISCLAIMER,
    };
  }

  return { plan };
}

export default createCoachService;
