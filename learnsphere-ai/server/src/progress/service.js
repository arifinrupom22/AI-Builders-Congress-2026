/**
 * Learning progress.
 *
 * Everything here is DERIVED from stored attempts and sessions. Nothing is
 * estimated, modelled or invented. Where the data is too thin to say anything,
 * the API returns empty lists and the UI shows an empty state instead of a
 * fabricated percentage.
 *
 * Explicitly NOT claimed: mastery, ability level, predicted grades, or learning
 * gain. We report counts and accuracy on questions the student actually
 * answered, and say so in `disclaimer`.
 */
import { topicBreakdown } from '../quiz/scorer.js';

const HISTORY_DAYS = 14;

/**
 * A topic is only worth flagging for revision when enough questions have been
 * answered to mean something AND accuracy is actually below this. Presenting a
 * 100%-correct topic as a "weak topic" would be misleading, so the ceiling is
 * applied everywhere weak topics are reported.
 */
const REVISION_ACCURACY_THRESHOLD = 80;
const MIN_QUESTIONS_PER_TOPIC = 2;

function utcDay(iso) {
  return String(iso).slice(0, 10);
}

function mergeTopics(allResults) {
  const merged = new Map();
  for (const topic of topicBreakdown(allResults)) {
    const existing = merged.get(topic.topic) ?? {
      topic: topic.topic,
      total: 0,
      correct: 0,
      documents: new Set(),
    };
    existing.total += topic.total;
    existing.correct += topic.correct;
    for (const doc of topic.documents) existing.documents.add(doc);
    merged.set(topic.topic, existing);
  }
  return [...merged.values()]
    .map((t) => ({
      topic: t.topic,
      total: t.total,
      correct: t.correct,
      accuracy: t.total > 0 ? Math.round((t.correct / t.total) * 100) : 0,
      documents: [...t.documents],
    }))
    .sort((a, b) => b.total - a.total || a.topic.localeCompare(b.topic));
}

export function createProgressService({ store }) {
  async function collect(learnerId) {
    const [attempts, quizzes, sessions, materials] = await Promise.all([
      store.listAttempts(learnerId, { limit: 500 }),
      store.listQuizzes(learnerId, { limit: 200 }),
      store.listSessions(learnerId, { limit: 200 }),
      store.listMaterials(learnerId),
    ]);

    const allResults = attempts.flatMap((a) => a.results ?? []);
    const topics = mergeTopics(allResults);
    const answered = allResults.filter((r) => !r.skipped);
    const correct = allResults.filter((r) => r.correct);

    return { attempts, quizzes, sessions, materials, allResults, topics, answered, correct };
  }

  return {
    async overview(learnerId) {
      const { attempts, quizzes, sessions, materials, allResults, topics, answered, correct } = await collect(learnerId);

      // 14-day activity histogram, built only from real timestamps.
      const byDay = new Map();
      const stamp = (iso, field) => {
        const day = utcDay(iso);
        const entry = byDay.get(day) ?? { day, quizzes: 0, questions: 0, sessions: 0, uploads: 0 };
        entry[field] += 1;
        byDay.set(day, entry);
      };
      for (const attempt of attempts) {
        stamp(attempt.createdAt, 'quizzes');
        stamp(attempt.createdAt, 'questions');
        const entry = byDay.get(utcDay(attempt.createdAt));
        entry.questions += Math.max(0, (attempt.total ?? 0) - 1);
      }
      for (const session of sessions) stamp(session.updatedAt ?? session.createdAt, 'sessions');
      for (const material of materials) stamp(material.createdAt, 'uploads');

      const today = new Date();
      const activity = [];
      for (let i = HISTORY_DAYS - 1; i >= 0; i -= 1) {
        const date = new Date(today);
        date.setUTCDate(date.getUTCDate() - i);
        const day = utcDay(date.toISOString());
        activity.push(byDay.get(day) ?? { day, quizzes: 0, questions: 0, sessions: 0, uploads: 0 });
      }

      // Streak = consecutive days ending today with any recorded activity.
      let streakDays = 0;
      for (let i = activity.length - 1; i >= 0; i -= 1) {
        const a = activity[i];
        if (a.quizzes + a.sessions + a.uploads === 0) break;
        streakDays += 1;
      }

      return {
        learnerId,
        totals: {
          materials: materials.length,
          readyMaterials: materials.filter((m) => m.status === 'ready').length,
          passages: materials.reduce((sum, m) => sum + (m.passageCount || 0), 0),
          sessions: sessions.length,
          quizzesAttempted: attempts.length,
          quizzesGenerated: quizzes.length,
          questionsAnswered: answered.length,
          questionsCorrect: correct.length,
          overallAccuracy: answered.length > 0 ? Math.round((correct.length / answered.length) * 100) : null,
        },
        streakDays,
        activity,
        topics,
        weakestTopics: topics
          .filter((t) => t.total >= MIN_QUESTIONS_PER_TOPIC && t.accuracy < REVISION_ACCURACY_THRESHOLD)
          .sort((a, b) => a.accuracy - b.accuracy || b.total - a.total)
          .slice(0, 4),
        strongestTopics: topics
          .filter((t) => t.total >= MIN_QUESTIONS_PER_TOPIC)
          .sort((a, b) => b.accuracy - a.accuracy || b.total - a.total)
          .slice(0, 3),
        revisionAccuracyThreshold: REVISION_ACCURACY_THRESHOLD,
        recentAttempts: attempts.slice(0, 8).map((a) => ({
          quizId: a.quizId,
          title: a.title,
          createdAt: a.createdAt,
          percent: a.percent,
          correctCount: a.correctCount,
          total: a.total,
        })),
        recentSessions: sessions.slice(0, 6),
        hasActivity: attempts.length > 0 || sessions.length > 0,
        disclaimer:
          'These figures are counts of questions you answered and study actions you took. LearnSphere AI does not measure mastery, ability, or learning gain, and makes no claim about academic results.',
      };
    },

    async revision(learnerId) {
      const { topics, attempts, materials, allResults } = await collect(learnerId);

      const practisedDocuments = new Set(allResults.map((r) => r.source?.documentName).filter(Boolean));
      const unpractised = materials
        .filter((m) => m.status === 'ready' && !practisedDocuments.has(m.name))
        .map((m) => ({ materialId: m.id, name: m.name, pageCount: m.pageCount, passageCount: m.passageCount }));

      const weakTopics = topics
        .filter((t) => t.total >= MIN_QUESTIONS_PER_TOPIC && t.accuracy < REVISION_ACCURACY_THRESHOLD)
        .sort((a, b) => a.accuracy - b.accuracy || b.total - a.total)
        .slice(0, 5)
        .map((t) => ({
          ...t,
          reason: `You answered ${t.correct} of ${t.total} questions correctly on this topic.`,
          suggestedAction: `Generate a practice quiz focused on "${t.topic}".`,
        }));

      const neverTried = topics.filter((t) => t.total === 1).map((t) => t.topic);

      return {
        learnerId,
        generatedAt: new Date().toISOString(),
        weakTopics,
        unpractisedMaterials: unpractised.slice(0, 5),
        topicsWithSingleAttempt: neverTried.slice(0, 5),
        attemptsConsidered: attempts.length,
        hasEnoughData: attempts.length >= 1,
        disclaimer:
          'Suggestions are based only on the questions you have answered here. One wrong answer on a topic does not mean you have not learned it, so treat this as a prompt to practise, not a diagnosis.',
      };
    },
  };
}

export default createProgressService;
