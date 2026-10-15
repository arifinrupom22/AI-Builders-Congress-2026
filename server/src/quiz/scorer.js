/**
 * Quiz scoring.
 *
 * Scoring is exact-answer multiple choice, which means the only honest claim we
 * can make is "you answered N of M correctly". There is no mastery model, no
 * ability estimate and no weighting by question difficulty, and the progress
 * screen says so. Correct answers, explanations and sources are revealed only
 * here - never in the quiz payload sent to the client.
 */

/** Strip everything that would let a student see the answer before submitting. */
export function toPublicQuiz(quiz) {
  return {
    id: quiz.id,
    title: quiz.title,
    topic: quiz.topic,
    materialIds: quiz.materialIds,
    generationMode: quiz.generationMode,
    provider: quiz.provider,
    // The language the questions were written in, so the UI can label a Bangla
    // quiz instead of leaving the student guessing.
    language: quiz.language ?? null,
    createdAt: quiz.createdAt,
    questionCount: quiz.questions.length,
    questions: quiz.questions.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      options: q.options,
      sourceDocument: q.source?.documentName ?? null,
      sourcePage: q.source?.pageNumber ?? null,
    })),
  };
}

export function toQuizSummary(quiz) {
  return {
    id: quiz.id,
    title: quiz.title,
    topic: quiz.topic,
    generationMode: quiz.generationMode,
    createdAt: quiz.createdAt,
    questionCount: quiz.questions.length,
  };
}

/**
 * @param {object} quiz stored quiz record
 * @param {(number|null)[]} answers selected option index per question, null = skipped
 */
export function scoreAttempt(quiz, answers) {
  const results = quiz.questions.map((question, index) => {
    const selectedIndex = Number.isInteger(answers?.[index]) ? answers[index] : null;
    const correctIndex = question.answerIndex;
    const correct = selectedIndex !== null && selectedIndex === correctIndex;
    return {
      questionId: question.id,
      prompt: question.prompt,
      options: question.options,
      selectedIndex,
      correctIndex,
      correct,
      skipped: selectedIndex === null,
      explanation: question.explanation,
      topic: question.topic,
      source: question.source,
    };
  });

  const correctCount = results.filter((r) => r.correct).length;
  const total = results.length;
  const answeredCount = results.filter((r) => !r.skipped).length;

  return {
    correctCount,
    answeredCount,
    total,
    // Integer percentage of the whole quiz; skipped questions count as wrong,
    // which is the standard exam convention and is stated in the UI.
    percent: total > 0 ? Math.round((correctCount / total) * 100) : 0,
    results,
  };
}

/**
 * Group results by topic so the progress screen can point at weak areas.
 * Topics come from the source document/heading, so a "weak topic" is always
 * traceable to something the student actually studied.
 */
export function topicBreakdown(results) {
  const byTopic = new Map();
  for (const r of results) {
    const topic = r.topic || r.source?.documentName || 'General';
    const entry = byTopic.get(topic) ?? { topic, total: 0, correct: 0, documents: new Set() };
    entry.total += 1;
    if (r.correct) entry.correct += 1;
    if (r.source?.documentName) entry.documents.add(r.source.documentName);
    byTopic.set(topic, entry);
  }
  return [...byTopic.values()].map((e) => ({
    topic: e.topic,
    total: e.total,
    correct: e.correct,
    accuracy: e.total > 0 ? Math.round((e.correct / e.total) * 100) : 0,
    documents: [...e.documents],
  }));
}

export default { toPublicQuiz, toQuizSummary, scoreAttempt, topicBreakdown };
