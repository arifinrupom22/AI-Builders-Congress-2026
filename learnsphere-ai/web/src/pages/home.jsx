/**
 * Overview — the landing screen.
 *
 * Answers three questions in order: what should I do next, where are the main
 * tools, and what have I done so far. The "next step" is derived only from
 * real state — an empty library, failed uploads, missing sessions, missing
 * attempts, or topics worth revising — and every number comes from the server.
 * When there is no activity yet the page says so instead of showing
 * zero-filled charts.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../store/AppContext.jsx';
import { Icon } from '../components/Icons.jsx';
import { Alert, Badge, Card, EmptyState, ErrorPanel, LoadingPanel, ProgressBar, StatTile } from '../components/ui.jsx';
import { formatDueIn, formatNumber, formatPercent, formatRelative, pluralise, truncate } from '../lib/format.js';

/**
 * Pick the single most useful thing to do next from real library and practice
 * state. Returns null while the activity data is still loading or failed, so
 * the panel never guesses.
 */
function pickNextStep({ materials, totals, weakestTopics, due }) {
  if (!materials || !totals) return null;

  const failed = materials.filter((m) => m.status === 'failed');
  const ready = materials.filter((m) => m.status === 'ready');

  if (materials.length === 0) {
    return {
      icon: 'upload',
      title: 'Add your first study material',
      body: 'Upload a PDF, Word, Markdown or text file — in Bangla or English. Everything else here works from what you upload.',
      action: { to: '/materials', label: 'Upload material' },
    };
  }

  if (failed.length > 0) {
    return {
      icon: 'alert',
      title: `Fix ${failed.length} file${pluralise(failed.length, '', 's')} that could not be indexed`,
      body: `${failed.map((m) => truncate(m.name, 40)).join(', ')} — nothing from these files is searchable yet.`,
      action: { to: '/materials', label: 'Open My Materials' },
    };
  }

  // Cards the learner's own ratings have brought back: time-sensitive, real,
  // and only shown when the server says something is actually actionable.
  const dueCount = due?.counts?.actionable ?? 0;
  if (dueCount > 0) {
    const pastDue = due.counts.due ?? 0;
    return {
      icon: 'clock',
      title: `${dueCount} card${pluralise(dueCount, ' is', 's are')} due for review`,
      body: `${pastDue > 0 ? `${pastDue} ${pluralise(pastDue, 'is', 'are')} already past due. ` : ''}These dates come from your own ratings: “Again” returns in 10 minutes, a successful review grows the interval.`,
      action: { to: '/review', label: 'Open the queue' },
    };
  }

  if (ready.length > 0 && (totals.sessions ?? 0) === 0) {
    return {
      icon: 'teacher',
      title: 'Ask the AI Teacher about your material',
      body: `Your ${ready.length} document${pluralise(ready.length, ' is', 's are')} indexed. Ask a question — the answer cites the file and page it came from.`,
      action: { to: '/chat', label: 'Open AI Teacher' },
    };
  }

  if ((totals.quizzesAttempted ?? 0) === 0) {
    return {
      icon: 'quiz',
      title: 'Take your first practice quiz',
      body: 'Questions are written from your own passages, so you can check your understanding straight away.',
      action: { to: '/quiz', label: 'Start a quiz' },
    };
  }

  if (weakestTopics?.length) {
    return {
      icon: 'target',
      title: `Practise “${truncate(weakestTopics[0].topic, 48)}”`,
      body: `You answered ${weakestTopics[0].correct} of ${weakestTopics[0].total} correctly on this topic. A quick quiz is the fastest way to close the gap.`,
      action: { to: '/quiz', label: 'Practise now' },
    };
  }

  return {
    icon: 'chart',
    title: 'Review your progress',
    body: 'Your recent topics are going well. The progress view shows what to keep warm over the next few days.',
    action: { to: '/progress', label: 'Open Progress' },
  };
}

/** The three main tools, each with a live stat from the server. */
function buildEntryPoints({ materials, totals, overview, queue, queueFailed }) {
  const ready = materials.filter((m) => m.status === 'ready').length;
  const sessions = totals?.sessions ?? 0;
  const attempts = totals?.quizzesAttempted ?? 0;
  const lastAttempt = overview?.recentAttempts?.[0];
  const dueCounts = queue?.counts ?? null;

  // The queue stat is only ever what the server reported — loading and
  // failure say so plainly instead of showing a hopeful zero.
  const dueStat = queueFailed
    ? 'Schedule unavailable'
    : !queue
      ? 'Checking your schedule…'
      : !dueCounts || dueCounts.totalCards === 0
        ? 'No cards scheduled yet'
        : dueCounts.actionable > 0
          ? `${dueCounts.actionable} card${pluralise(dueCounts.actionable, '', 's')} ready now`
          : queue.nextDueAt
            ? `Nothing due · next ${formatDueIn(queue.nextDueAt)}`
            : 'Nothing due right now';
  const dueActionable = dueCounts?.actionable ?? 0;

  return [
    {
      to: '/materials',
      icon: 'library',
      label: 'My Materials',
      desc: 'Upload and inspect your study files — see exactly what was indexed.',
      stat: materials.length
        ? `${ready} of ${materials.length} file${pluralise(materials.length, '', 's')} ready`
        : 'No files yet',
      cta: materials.length ? 'Browse library' : 'Upload your first file',
    },
    {
      to: '/chat',
      icon: 'teacher',
      label: 'AI Teacher',
      desc: 'Ask questions in your own words and get cited, verifiable answers.',
      stat: sessions
        ? `${sessions} study session${pluralise(sessions, '', 's')}`
        : 'No sessions yet',
      cta: sessions ? 'Continue learning' : 'Ask a question',
    },
    {
      to: '/studio',
      icon: 'sitemap',
      label: 'Visual studio',
      desc: 'See your material as a concept map, flowchart, comparison table or timeline.',
      stat: ready ? 'Maps, flowcharts, timelines & tables' : 'Nothing to visualise yet',
      cta: 'Open the studio',
    },
    {
      to: '/quiz',
      icon: 'quiz',
      label: 'Practice',
      desc: 'Generate multiple-choice questions from your own material.',
      stat: attempts
        ? `${attempts} ${pluralise(attempts, 'quiz', 'quizzes')} · ${
            lastAttempt ? `last score ${lastAttempt.percent}%` : 'no score yet'
          }`
        : 'No quizzes yet',
      cta: attempts ? 'Practise again' : 'Start practising',
    },
    {
      to: '/review',
      icon: 'clock',
      label: 'Due for review',
      desc: 'Cards your ratings scheduled to come back — review, rate again or snooze.',
      stat: dueStat,
      cta: dueActionable > 0 ? 'Review now' : 'Open the queue',
      tone: dueActionable > 0 ? 'warning' : undefined,
    },
  ];
}

export default function HomePage() {
  const { ai, materials, health, learnerId, auth } = useApp();
  // In account mode the identity shown is the verified account, never the
  // browser's profile id.
  const identity = auth?.user ? auth.user.displayName || auth.user.email : learnerId;
  const [overview, setOverview] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState(null);
  const [queue, setQueue] = useState(null);
  const [queueFailed, setQueueFailed] = useState(false);

  const load = useCallback(async (signal) => {
    setState('loading');
    setError(null);
    try {
      const data = await api.progress();
      if (signal?.aborted) return;
      setOverview(data);
      setState('ready');
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') return;
      setError(err);
      setState('error');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, learnerId]);

  // Due-queue counts for the entry point. A failure only greys the stat: the
  // rest of the Overview keeps working.
  useEffect(() => {
    let alive = true;
    setQueue(null);
    setQueueFailed(false);
    api
      .dueFlashcards({ summary: true })
      .then((summary) => {
        if (alive) setQueue(summary);
      })
      .catch(() => {
        if (alive) setQueueFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [learnerId]);

  const totals = overview?.totals;
  const readyMaterials = materials.filter((m) => m.status === 'ready').length;
  const failedMaterials = materials.filter((m) => m.status === 'failed');
  const isEmpty = materials.length === 0;
  const activity = overview?.activity ?? [];

  const nextStep =
    state === 'ready'
      ? pickNextStep({ materials, totals, weakestTopics: overview?.weakestTopics, due: queue })
      : null;
  const entryPoints = buildEntryPoints({ materials, totals, overview, queue, queueFailed });

  return (
    <div className="page">
      <section className="hero">
        <div className="hero__main">
          <span className="hero__eyebrow">
            <Icon name="sparkles" size={13} /> Source-grounded AI teacher
          </span>
          <h2 className="hero__title">Teach yourself with your own materials</h2>
          <p className="hero__subtitle">
            LearnSphere AI explains, quizzes and tracks progress using only the documents you upload.
            Every answer cites the file and page it came from, and it will tell you plainly when your
            notes do not cover a question.
          </p>
          <div className="hero__meta">
            <span className="hero__meta-item">
              <Badge tone={ai?.mode === 'live' ? 'success' : 'warning'} icon={ai?.mode === 'live' ? 'sparkles' : 'shield'}>
                {ai?.mode === 'live' ? `${ai.label} · ${ai.model}` : 'Local extractive mode'}
              </Badge>
            </span>
            <span className="hero__meta-item">
              <Icon name="database" size={14} /> {formatNumber(health?.store?.passages ?? 0)} indexed passages
            </span>
            <span className="hero__meta-item">
              <Icon name="user" size={14} /> Studying as {identity}
            </span>
          </div>
          <p className="hero__privacy">
            {ai?.mode === 'live'
              ? 'Only the retrieved passages are sent to the model — never your whole library.'
              : 'No AI key configured, so answers are assembled locally from your own text and nothing leaves this machine.'}
          </p>
        </div>

        {nextStep ? (
          <aside className="next-step" aria-label="Suggested next step">
            <span className="next-step__label">
              <Icon name="chevronRight" size={13} /> Next step
            </span>
            <span className="next-step__icon" aria-hidden="true">
              <Icon name={nextStep.icon} size={20} />
            </span>
            <h3 className="next-step__title">{nextStep.title}</h3>
            <p className="next-step__body">{nextStep.body}</p>
            <a className="ls-btn ls-btn--primary ls-btn--md next-step__cta" href={`#${nextStep.action.to}`}>
              <span>{nextStep.action.label}</span>
              <Icon name="chevronRight" size={16} />
            </a>
          </aside>
        ) : (
          <aside className="next-step next-step--pending" aria-label="Suggested next step">
            <span className="next-step__label">
              <Icon name="chevronRight" size={13} /> Next step
            </span>
            <LoadingPanel label="Working out what to do next" rows={2} />
          </aside>
        )}
      </section>

      {failedMaterials.length > 0 ? (
        <Alert tone="warning" title={`${failedMaterials.length} file${pluralise(failedMaterials.length, '', 's')} could not be indexed`}>
          <p>
            {failedMaterials.map((m) => m.name).join(', ')} — the file was stored so you can see what
            happened, but nothing from it is searchable. Remove it, or upload a text-based version.
          </p>
        </Alert>
      ) : null}

      <section className="entry-grid" aria-label="Main tools">
        {entryPoints.map((item) => (
          <a key={item.to} className={`entry-card${item.tone ? ` entry-card--${item.tone}` : ''}`} href={`#${item.to}`}>
            <span className="entry-card__icon" aria-hidden="true">
              <Icon name={item.icon} size={20} />
            </span>
            <span className="entry-card__label">{item.label}</span>
            <span className="entry-card__desc">{item.desc}</span>
            <span className="entry-card__stat">{item.stat}</span>
            <span className="entry-card__cta">
              {item.cta} <Icon name="chevronRight" size={14} />
            </span>
          </a>
        ))}
      </section>

      <p className="also-links">
        Also: <a className="ls-link" href="#/summary">Study summary</a> — turn a document into cited
        revision notes · <a className="ls-link" href="#/progress">Progress</a> — what you have
        practised and what to revise next.
      </p>

      {state === 'error' ? (
        <ErrorPanel error={error} onRetry={() => load()} title="Could not load your activity" />
      ) : null}

      {!isEmpty && totals ? (
        <section className="stat-row" aria-label="Library summary">
          <StatTile
            label="Materials"
            value={formatNumber(materials.length)}
            hint={readyMaterials === materials.length ? `${readyMaterials} indexed` : `${readyMaterials} of ${materials.length} ready`}
            icon="library"
          />
          <StatTile
            label="Indexed passages"
            value={formatNumber(totals?.passages ?? 0)}
            hint="Searchable chunks of your documents"
            icon="database"
          />
          <StatTile
            label="Questions answered"
            value={formatNumber(totals?.questionsAnswered ?? 0)}
            hint={`${formatNumber(totals?.questionsCorrect ?? 0)} correct`}
            icon="quiz"
          />
          <StatTile
            label="Accuracy"
            value={formatPercent(totals?.overallAccuracy)}
            hint="Over questions you actually answered"
            icon="target"
          />
        </section>
      ) : null}

      {state === 'loading' && materials.length === 0 ? (
        <Card title="Activity">
          <LoadingPanel label="Loading your activity" rows={3} />
        </Card>
      ) : isEmpty ? (
        <EmptyState
          icon="upload"
          title="Your library is empty"
          description="Upload your first study material and every screen here fills in: citations, grounded quizzes and an honest practice record."
          action={
            <a className="ls-btn ls-btn--primary ls-btn--md" href="#/materials">
              <Icon name="upload" size={17} />
              <span>Upload a document</span>
            </a>
          }
        />
      ) : !overview ? null : (
        <>
          <div className="split">
            <Card
              title="Recent practice"
              subtitle={overview?.recentAttempts?.length ? 'Your last quiz attempts.' : 'No quiz attempts yet.'}
              actions={
                <a className="ls-link" href="#/quiz">
                  Practise now <Icon name="chevronRight" size={14} />
                </a>
              }
            >
              {overview?.recentAttempts?.length ? (
                <ul className="row-list">
                  {overview.recentAttempts.map((attempt) => {
                    const tone = attempt.percent >= 80 ? 'success' : attempt.percent >= 50 ? 'warning' : 'danger';
                    return (
                      <li key={`${attempt.quizId}-${attempt.createdAt}`} className="row-list__item">
                        <div className="row-list__main">
                          <span className="row-list__title">{truncate(attempt.title, 70)}</span>
                          <span className="row-list__meta">
                            {formatRelative(attempt.createdAt)} · {attempt.correctCount} of {attempt.total} correct
                          </span>
                        </div>
                        <div className="row-list__side">
                          <Badge tone={tone}>{attempt.percent}%</Badge>
                          <ProgressBar value={attempt.percent} tone={tone === 'success' ? 'success' : tone === 'warning' ? 'warning' : 'danger'} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="muted">
                  Nothing yet. Generate a quiz from your material and your score will appear here.
                </p>
              )}
            </Card>

            <Card
              title="Recent study sessions"
              subtitle={overview?.recentSessions?.length ? 'Conversations with the AI Teacher.' : 'No sessions yet.'}
              actions={
                <a className="ls-link" href="#/chat">
                  Open AI Teacher <Icon name="chevronRight" size={14} />
                </a>
              }
            >
              {overview?.recentSessions?.length ? (
                <ul className="row-list">
                  {overview.recentSessions.map((session) => (
                    <li key={session.id} className="row-list__item">
                      <div className="row-list__main">
                        <a className="row-list__title ls-link" href={`#/chat?session=${session.id}`}>
                          {truncate(session.title, 70)}
                        </a>
                        <span className="row-list__meta">
                          {session.messageCount} message{pluralise(session.messageCount, '', 's')} · updated{' '}
                          {formatRelative(session.updatedAt)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Ask your first question and the session will be listed here.</p>
              )}
            </Card>
          </div>

          {overview?.weakestTopics?.length ? (
            <Card title="Worth revising next" subtitle={`Topics below ${overview.revisionAccuracyThreshold}% after at least two questions.`}>
              <ul className="topic-list">
                {overview.weakestTopics.map((topic) => (
                  <li key={topic.topic} className="topic-list__item">
                    <div className="topic-list__head">
                      <span className="topic-list__name">{truncate(topic.topic, 90)}</span>
                      <Badge tone={topic.accuracy >= 50 ? 'warning' : 'danger'}>
                        {topic.correct}/{topic.total} · {formatPercent(topic.accuracy)}
                      </Badge>
                    </div>
                    <ProgressBar value={topic.accuracy} tone={topic.accuracy >= 50 ? 'warning' : 'danger'} />
                  </li>
                ))}
              </ul>
              <p className="muted-xs">
                This is a prompt to practise, not a diagnosis — one wrong answer does not mean you have
                not learned something.
              </p>
            </Card>
          ) : null}

          {activity.some((day) => day.quizzes + day.sessions + day.uploads > 0) ? (
            <Card title="Last 14 days" subtitle={`${overview.streakDays} day study streak`}>
              <div className="spark">
                {activity.map((day) => {
                  const count = day.quizzes + day.sessions + day.uploads;
                  const height = count === 0 ? 4 : Math.min(100, 22 + count * 18);
                  return (
                    <div className="spark__col" key={day.day}>
                      <span
                        className={`spark__bar${count === 0 ? ' is-empty' : ''}`}
                        style={{ height: `${height}%` }}
                        title={`${day.day}: ${count} action${count === 1 ? '' : 's'}`}
                      />
                      <span className="spark__day">{day.day.slice(8)}</span>
                    </div>
                  );
                })}
              </div>
              <p className="muted-xs">{overview.disclaimer}</p>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
