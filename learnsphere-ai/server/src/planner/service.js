/**
 * Study planning.
 *
 * A plan is a schedule built from three real inputs: the topics the student
 * typed or pasted, the passages that actually match those topics in their own
 * uploaded material, and the practice already recorded in their quiz answers
 * and flashcard ratings. It never predicts a grade, and "covered" means only
 * that a document in the library matched the topic — not that the student has
 * learned it.
 *
 * Coverage states:
 *   covered        a document matched the topic, and no recorded evidence says
 *                  it needs another pass
 *   needs_practice a document matched, and recorded answers/ratings suggest
 *                  another pass
 *   not_found      nothing in the library matched. This is reported as a gap
 *                  with an upload suggestion, never scheduled as if it were
 *                  studyable.
 *
 * The schedule is deterministic: the same plan settings and the same date
 * produce the same task ids, which is what lets "mark done" survive a refresh.
 */
import crypto from 'node:crypto';
import { contentTokens } from '../retrieval/tokenize.js';

export const PLAN_DISCLAIMER =
  'This plan is a suggested schedule built from your own syllabus, your uploaded documents and recorded practice. It does not predict exam results, estimate a grade, or claim mastery. You can edit, pause or delete any task.';

export const COVERAGE = {
  covered: 'covered',
  needsPractice: 'needs_practice',
  notFound: 'not_found',
};

const MAX_TOPICS = 60;
const MAX_SYLLABUS_CHARS = 8000;
const MAX_SCHEDULED_DAYS = 28;
const PRACTICE_ACCURACY = 80;

const LABELS = {
  en: {
    covered: 'Covered by your material',
    needsPractice: 'Needs practice',
    notFound: 'Not found in uploaded material',
    study: 'Study',
    practice: 'Practise',
    review: 'Review due cards',
    find: 'Find material',
  },
  bn: {
    covered: 'আপনার উপকরণে আছে',
    needsPractice: 'আরও অনুশীলন দরকার',
    notFound: 'আপলোড করা উপকরণে পাওয়া যায়নি',
    study: 'পড়ুন',
    practice: 'অনুশীলন করুন',
    review: 'রিভিশন কার্ড',
    find: 'উপকরণ খুঁজুন',
  },
};

const LANGUAGE_CODE = { en: 'en', bn: 'bn', auto: 'auto' };

const STOPWORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'into', 'your', 'this', 'that', 'these', 'those',
  'unit', 'units', 'chapter', 'chapters', 'topic', 'topics', 'week', 'weeks', 'lecture',
  'lectures', 'notes', 'note', 'part', 'parts', 'introduction', 'intro', 'overview',
  'basics', 'basic', 'study', 'studies', 'exam', 'final', 'course', 'module', 'modules',
  'section', 'sections', 'class', 'classes', 'syllabus', 'concept', 'concepts', 'revision',
  'review', 'practice', 'practise', 'quiz', 'quizzes', 'test', 'tests', 'assignment',
  'assignments', 'reading', 'readings', 'paper', 'papers', 'subject', 'subjects',
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Days between two ISO dates, independent of the server's timezone. */
export function daysBetween(fromIso, toIso) {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Split pasted syllabus text into topics.
 *
 * Line-based on purpose: most students paste a list, and splitting arbitrary
 * prose into "topics" would invent structure the student did not write. Number
 * prefixes and bullet characters are removed; a topic keeps its own wording.
 */
export function parseSyllabus(raw) {
  const text = String(raw ?? '').slice(0, MAX_SYLLABUS_CHARS);
  const seen = new Set();
  const topics = [];

  for (const line of text.split(/\r?\n/)) {
    const cleaned = line
      .replace(/^\s*(?:[-*•◦▪]|\d{1,2}[.)]|[a-h][.)])\s+/i, '')
      .replace(/^\s*(?:week|unit|chapter|module|topic)\s*\d+\s*[:.\-–]\s*/i, '')
      .replace(/^#+\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length < 2) continue;
    // A line that is only a heading-ish word carries no topic.
    if (/^(week|unit|chapter|module|topics?|syllabus|course outline)\b/i.test(cleaned) && cleaned.length < 12) {
      continue;
    }
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(cleaned.slice(0, 120));
    if (topics.length >= MAX_TOPICS) break;
  }
  return topics;
}

const significantTokens = (text) =>
  contentTokens(text).filter((token) => token.length > 2 && !STOPWORDS.has(token));

function tokenOverlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function conceptFor(topicTokens, concepts) {
  let best = null;
  let bestScore = 0;
  for (const concept of concepts) {
    const score = tokenOverlap(topicTokens, significantTokens(concept.concept).reduce((s, t) => s.add(t), new Set()));
    if (score > bestScore) {
      best = concept;
      bestScore = score;
    }
  }
  // Half the significant tokens of the shorter label must agree; anything less
  // is a coincidence ("data" in "data structures" and "data protection").
  return bestScore >= 0.5 ? best : null;
}

function labelFor(status, language) {
  const labels = LABELS[language] ?? LABELS.en;
  if (status === COVERAGE.covered) return labels.covered;
  if (status === COVERAGE.needsPractice) return labels.needsPractice;
  return labels.notFound;
}

function taskId(date, kind, topicId) {
  return crypto.createHash('sha1').update(`${date}|${kind}|${topicId}`).digest('hex').slice(0, 12);
}

function practiceStyle(topic) {
  const answered = topic.evidence?.answers ?? 0;
  const accuracy = topic.evidence?.accuracy;
  const strong = answered >= 3 && accuracy !== null && accuracy >= PRACTICE_ACCURACY;
  return strong ? 'mixed' : 'recall';
}

function practiceHref(topic) {
  const params = new URLSearchParams();
  params.set('topic', topic.title);
  params.set('style', practiceStyle(topic));
  const ids = [...new Set(topic.citations.map((citation) => citation.materialId).filter(Boolean))];
  if (ids.length > 0) params.set('materials', ids.join(','));
  return `/quiz?${params.toString()}`;
}

function topicWhy(topic, language) {
  if (language === 'bn') {
    if (topic.status === COVERAGE.notFound) {
      return 'আপনার আপলোড করা কোনো নথির সঙ্গে এই টপিক মেলেনি, তাই এটির জন্য পড়ার কাজ নির্ধারণ করা হয়নি।';
    }
    if (topic.status === COVERAGE.needsPractice) {
      const recorded = topic.evidence?.answers
        ? `${topic.evidence.correct}/${topic.evidence.answers} সঠিক (${topic.evidence.accuracy}%)`
        : `${topic.evidence?.weakRatings ?? 0}টি কার্ডে "Again" বা "Hard"`;
      return `রেকর্ড করা ফলাফল (${recorded}) অনুযায়ী আরেকবার অনুশীলন Suggested।`;
    }
    return `${topic.citations[0]?.documentName ?? 'আপনার নথি'} নথিতে এই টপিক পাওয়া গেছে। এটি আয়ত্ত বোঝায় না।`;
  }

  if (topic.status === COVERAGE.notFound) {
    return 'No uploaded document matched this topic, so it is not scheduled as study. Upload material that covers it, then refresh the plan.';
  }
  if (topic.status === COVERAGE.needsPractice) {
    const parts = [];
    if (topic.evidence?.answers) {
      parts.push(`you answered ${topic.evidence.correct} of ${topic.evidence.answers} questions correctly (${topic.evidence.accuracy}%)`);
    }
    if (topic.evidence?.weakRatings) {
      parts.push(`${topic.evidence.weakRatings} of ${topic.evidence.ratings} flashcard ratings were "Again" or "Hard"`);
    }
    const evidenceText = parts.length > 0 ? `${parts.join('; ')}. ` : '';
    return `${evidenceText}This topic appears in ${topic.citations[0]?.documentName ?? 'your material'}, and the recorded evidence suggests another pass.`;
  }
  const first = topic.citations[0];
  return `Matched in ${first?.documentName ?? 'your material'}${first?.pageNumber ? `, page ${first.pageNumber}` : ''}. "Covered" means your material contains it, not that you have mastered it.`;
}

export function createPlannerService({ store, retrieval, dnaService, flashcardService, config }) {
  async function mapTopics({ learnerId, titles, language }) {
    const dna = dnaService ? await dnaService.profile(learnerId) : { concepts: [] };
    const concepts = dna.concepts ?? [];

    const topics = [];
    for (const title of titles) {
      const tokens = new Set(significantTokens(title));
      const concept = conceptFor(tokens, concepts);
      // Planning needs a looser threshold than answering: a syllabus line is a
      // heading, not a question, so an exact phrase match is not expected.
      const search = await retrieval.search({
        learnerId,
        query: title,
        topK: 3,
        minScore: Math.min(0.25, config.retrieval.minScore),
      });

      const citations = search.results.map((result) => ({
        materialId: result.materialId,
        documentName: result.documentName,
        pageNumber: result.pageNumber,
        passageId: result.passageId,
        score: result.score,
        snippet: result.snippet,
      }));

      const evidence = {
        answers: concept?.quiz?.answered ?? 0,
        correct: concept?.quiz?.correct ?? 0,
        accuracy: concept?.quiz?.accuracy ?? null,
        ratings: concept?.flashcards?.ratings ?? 0,
        weakRatings: (concept?.flashcards?.grades?.again ?? 0) + (concept?.flashcards?.grades?.hard ?? 0),
        lastPractisedAt:
          [concept?.quiz?.lastPractisedAt, concept?.flashcards?.lastPractisedAt]
            .filter(Boolean)
            .sort()
            .pop() ?? null,
        concept: concept?.concept ?? null,
      };

      const weakAnswers = evidence.answers >= 2 && evidence.accuracy !== null && evidence.accuracy < PRACTICE_ACCURACY;
      const weakRatings = evidence.ratings >= 2 && evidence.weakRatings / evidence.ratings >= 0.5;

      const status =
        citations.length === 0
          ? COVERAGE.notFound
          : weakAnswers || weakRatings
            ? COVERAGE.needsPractice
            : COVERAGE.covered;

      const topic = {
        id: crypto.createHash('sha1').update(title.toLowerCase()).digest('hex').slice(0, 12),
        title,
        status,
        statusLabel: labelFor(status, language),
        evidence,
        citations,
      };
      topic.why = topicWhy(topic, language);
      // A one-click practice link for topics the material covers. Unmatched
      // topics deliberately get no quiz link: there is nothing to ground it in.
      if (status !== COVERAGE.notFound) topic.practiseHref = practiceHref(topic);
      topics.push(topic);
    }
    return topics;
  }

  function buildDays({ plan, topics, previousDays = [] }) {
    const language = plan.language === 'bn' ? 'bn' : 'en';
    const labels = LABELS[language];
    const done = new Map();
    const paused = new Set();
    for (const day of previousDays) {
      for (const task of day.tasks ?? []) {
        if (task.status === 'done') done.set(task.id, task);
        if (task.status === 'paused') paused.add(task.id);
      }
    }

    const today = todayIso();
    const horizon = Math.min(daysBetween(today, plan.examDate), MAX_SCHEDULED_DAYS);
    const schedulable = topics.filter((topic) => topic.status !== COVERAGE.notFound);
    // Weak topics first, so the earliest study slots carry the evidence-backed
    // work rather than the topics already answered well.
    const queue = [...schedulable].sort((a, b) => {
      const rank = (topic) => (topic.status === COVERAGE.needsPractice ? 0 : 1);
      return rank(a) - rank(b);
    });

    // Consecutive study days are grouped per topic (a short block), rather than
    // rotating topics daily: a student needs more than one sitting on a topic
    // for the practice task to land after some study. The block length follows
    // the available days, so a 3-week plan does not revisit every topic daily.
    const studyDayCount = Math.max(
      1,
      Math.min(plan.daysPerWeek, 7) * (Math.floor(Math.max(0, horizon) / 7) + 1),
    );
    const blockLength = Math.max(1, Math.ceil(studyDayCount / Math.max(1, queue.length)));

    const days = [];
    let cursor = 0;
    for (let offset = 0; offset <= Math.max(0, horizon); offset += 1) {
      const date = addDays(today, offset);
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      // Days per week are taken from the start of each calendar week (Mon=0),
      // which is predictable and easy for a student to check.
      const positionInWeek = (weekday + 6) % 7;
      if (positionInWeek >= plan.daysPerWeek) continue;
      if (queue.length === 0) break;

      const topic = queue[Math.floor(cursor / blockLength) % queue.length];
      cursor += 1;
      const studyMinutes = Math.max(10, Math.round(plan.minutesPerDay * 0.6));
      const practiceMinutes = Math.max(0, plan.minutesPerDay - studyMinutes);
      const materialId = topic.citations[0]?.materialId;
      const tasks = [];

      const studyTask = {
        id: taskId(date, 'study', topic.id),
        kind: 'study',
        topicId: topic.id,
        topic: topic.title,
        title: language === 'bn' ? `${labels.study}: ${topic.title}` : `${labels.study}: ${topic.title}`,
        detail: topic.why,
        minutes: studyMinutes,
        href: materialId ? `/materials?id=${encodeURIComponent(materialId)}` : '/materials',
        citations: topic.citations.slice(0, 2),
        status: 'planned',
      };
      tasks.push(studyTask);

      if (practiceMinutes >= 5 && topic.citations.length > 0) {
        tasks.push({
          id: taskId(date, 'practice', topic.id),
          kind: 'practice',
          topicId: topic.id,
          topic: topic.title,
          title: `${labels.practice}: ${topic.title}`,
          detail:
            language === 'bn'
              ? 'রেকর্ড করা ফলাফল থেকে তৈরি কুইজ — প্রশ্ন আপনার নিজের উপকরণ থেকেই আসে।'
              : 'A quiz generated from your own material, chosen from what the practice record shows.',
          minutes: practiceMinutes,
          href: practiceHref(topic),
          citations: topic.citations.slice(0, 1),
          status: 'planned',
        });
      }

      days.push({ date, tasks });
    }

    for (const day of days) {
      for (const task of day.tasks) {
        if (done.has(task.id)) task.status = 'done';
        else if (paused.has(task.id)) task.status = 'paused';
      }
    }

    return days;
  }

  function summarise(plan) {
    const tasks = plan.days.flatMap((day) => day.tasks);
    return {
      topicCount: plan.topics.length,
      covered: plan.topics.filter((t) => t.status === COVERAGE.covered).length,
      needsPractice: plan.topics.filter((t) => t.status === COVERAGE.needsPractice).length,
      notFound: plan.topics.filter((t) => t.status === COVERAGE.notFound).length,
      scheduledDays: plan.days.length,
      totalTasks: tasks.length,
      doneTasks: tasks.filter((t) => t.status === 'done').length,
      pausedTasks: tasks.filter((t) => t.status === 'paused').length,
      totalMinutes: tasks.reduce((sum, task) => sum + (task.minutes || 0), 0),
    };
  }

  async function dueSummary(learnerId) {
    if (!flashcardService) return null;
    try {
      return await flashcardService.due({ learnerId, summary: true });
    } catch {
      return null;
    }
  }

  async function generate({ learnerId, input }) {
    const language = LANGUAGE_CODE[input.language] ?? 'auto';
    const titles = parseSyllabus(input.syllabus);
    const topics = await mapTopics({ learnerId, titles, language });
    const plan = {
      id: crypto.randomUUID(),
      learnerId,
      title: input.title?.trim() || `Plan to ${input.examDate}`,
      examDate: input.examDate,
      subjects: input.subjects ?? [],
      minutesPerDay: input.minutesPerDay,
      daysPerWeek: input.daysPerWeek,
      language,
      // Kept so a later refresh regenerates from the same list even when the
      // request does not resend it.
      syllabusText: String(input.syllabus ?? '').slice(0, MAX_SYLLABUS_CHARS),
      syllabusCount: titles.length,
      topics,
      days: [],
      gaps: topics.filter((topic) => topic.status === COVERAGE.notFound).map((topic) => ({
        title: topic.title,
        why: topic.why,
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      disclaimer: PLAN_DISCLAIMER,
    };

    const due = await dueSummary(learnerId);
    plan.days = buildDays({ plan, topics });
    if (plan.days.length > 0 && due?.counts?.actionable > 0) {
      plan.days[0].tasks.push({
        id: taskId(plan.days[0].date, 'review', 'due'),
        kind: 'review',
        title: `${LABELS[language === 'bn' ? 'bn' : 'en'].review}`,
        detail:
          language === 'bn'
            ? `${due.counts.actionable}টি কার্ড এখন রিভিশনের জন্য প্রস্তুত। এই তারিখগুলো আপনার নিজের রেটিং থেকে এসেছে; প্ল্যান সেগুলো বদলায় না।`
            : `${due.counts.actionable} card(s) are due now. These dates come from your own ratings; this plan only links to the existing queue.`,
        minutes: 10,
        href: '/review',
        status: 'planned',
      });
    }
    plan.summary = summarise(plan);
    plan.assumptions = [
      `Study time is planned for ${plan.minutesPerDay} minutes on ${plan.daysPerWeek} day(s) per week.`,
      plan.language === 'auto'
        ? 'Practice is generated in the language of the material.'
        : plan.language === 'bn'
          ? 'Plan wording and practice use Bangla where supported; topic titles stay as you wrote them.'
          : 'Plan wording and practice use English.',
      `Days beyond the next ${MAX_SCHEDULED_DAYS} are not scheduled yet; refresh closer to the exam to extend the plan.`,
    ];
    await store.savePlan(plan);
    return plan;
  }

  async function refresh({ learnerId, plan, overrides = {} }) {
    const next = { ...plan, ...overrides };
    next.language = LANGUAGE_CODE[next.language] ?? next.language;
    const titles = parseSyllabus(overrides.syllabus ?? plan.syllabusText ?? '');
    // The original titles live in topics; when no new syllabus text is supplied
    // they are reused exactly as the student typed them.
    const sourceTitles = titles.length > 0 ? titles : plan.topics.map((topic) => topic.title);
    const topics = await mapTopics({ learnerId, titles: sourceTitles, language: next.language });
    const previousDays = plan.days;
    next.topics = topics;
    next.syllabusText = overrides.syllabus ?? plan.syllabusText;
    next.gaps = topics
      .filter((topic) => topic.status === COVERAGE.notFound)
      .map((topic) => ({ title: topic.title, why: topic.why }));
    next.days = buildDays({ plan: next, topics, previousDays });
    const due = await dueSummary(learnerId);
    if (next.days.length > 0 && due?.counts?.actionable > 0) {
      const existing = next.days[0].tasks.find((task) => task.kind === 'review');
      if (!existing) {
        next.days[0].tasks.push({
          id: taskId(next.days[0].date, 'review', 'due'),
          kind: 'review',
          title: 'Review due cards',
          detail: `${due.counts.actionable} card(s) are due now. These dates come from your own ratings; this plan only links to the existing queue.`,
          minutes: 10,
          href: '/review',
          status: 'planned',
        });
      }
    }
    next.summary = summarise(next);
    await store.updatePlan(plan.id, learnerId, (draft) => {
      Object.assign(draft, next);
    });
    return next;
  }

  return {
    parseSyllabus,
    async create({ learnerId, input }) {
      return generate({ learnerId, input });
    },
    async list(learnerId) {
      const plans = await store.listPlans(learnerId);
      return plans.map((plan) => ({
        id: plan.id,
        title: plan.title,
        examDate: plan.examDate,
        daysUntilExam: daysBetween(todayIso(), plan.examDate),
        language: plan.language,
        summary: plan.summary ?? summarise(plan),
        updatedAt: plan.updatedAt,
      }));
    },
    async get(learnerId, id) {
      return store.getPlan(id, learnerId);
    },
    async update({ learnerId, id, patch }) {
      const plan = await store.getPlan(id, learnerId);
      if (!plan) return null;
      const overrides = { ...patch };
      // These are derived, never accepted from the client.
      delete overrides.topics;
      delete overrides.days;
      delete overrides.summary;
      const updated = await refresh({ learnerId, plan, overrides });
      return updated;
    },
    async setTask({ learnerId, id, taskId: wanted, status }) {
      const plan = await store.getPlan(id, learnerId);
      if (!plan) return null;
      let found = null;
      const updated = await store.updatePlan(id, learnerId, (draft) => {
        for (const day of draft.days) {
          const task = day.tasks.find((entry) => entry.id === wanted);
          if (task) {
            task.status = status;
            found = task;
            break;
          }
        }
        draft.summary = summarise(draft);
      });
      return updated ? { plan: updated, task: found } : null;
    },
    async refreshPlan({ learnerId, id }) {
      const plan = await store.getPlan(id, learnerId);
      if (!plan) return null;
      return refresh({ learnerId, plan });
    },
    async remove({ learnerId, id }) {
      return store.deletePlan(id, learnerId);
    },
    async todayFor(learnerId) {
      const plans = await store.listPlans(learnerId);
      if (plans.length === 0) return null;
      const today = todayIso();
      const withToday = plans
        .map((plan) => ({
          plan,
          day: plan.days.find((entry) => entry.date === today) ?? null,
        }))
        .filter((entry) => entry.day);
      const chosen = (withToday.length > 0 ? withToday : plans.map((plan) => ({ plan, day: null })))[0];
      const tasks = (chosen.day?.tasks ?? []).filter((task) => task.status === 'planned');
      return {
        planId: chosen.plan.id,
        title: chosen.plan.title,
        examDate: chosen.plan.examDate,
        daysUntilExam: daysBetween(today, chosen.plan.examDate),
        today: today,
        tasks,
        hasTasksToday: tasks.length > 0,
      };
    },
  };
}

export default createPlannerService;
