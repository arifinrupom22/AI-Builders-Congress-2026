/**
 * Overview — the landing screen.
 *
 * Answers three questions in order: what can I do here, what is in my library,
 * and what should I do next. Every number comes from the server; when there is
 * no activity yet it says so instead of showing a zero-filled chart.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../store/AppContext.jsx';
import { Icon } from '../components/Icons.jsx';
import { Alert, Badge, Card, EmptyState, ErrorPanel, LoadingPanel, ProgressBar, StatTile } from '../components/ui.jsx';
import { formatNumber, formatPercent, formatRelative, pluralise, truncate } from '../lib/format.js';

const QUICK_ACTIONS = [
  {
    to: '/materials',
    icon: 'upload',
    label: 'Upload study material',
    desc: 'Add a PDF, Word, Markdown or text file — in Bangla or English.',
  },
  {
    to: '/summary',
    icon: 'lightbulb',
    label: 'Generate a study summary',
    desc: 'Turn a whole document into cited revision notes.',
  },
  {
    to: '/chat',
    icon: 'teacher',
    label: 'Ask the AI Teacher',
    desc: 'Get an explanation grounded in your own notes, with citations.',
  },
  {
    to: '/quiz',
    icon: 'quiz',
    label: 'Practise a quiz',
    desc: 'Turn a topic or a document into multiple-choice questions.',
  },
  {
    to: '/progress',
    icon: 'chart',
    label: 'Review progress',
    desc: 'See what you have practised and what to revise next.',
  },
];

function QuickCard({ item }) {
  return (
    <a className="quick-card" href={`#${item.to}`}>
      <span className="quick-card__icon">
        <Icon name={item.icon} size={20} />
      </span>
      <span className="quick-card__label">{item.label}</span>
      <span className="quick-card__desc">{item.desc}</span>
      <span className="quick-card__go">
        Open <Icon name="chevronRight" size={14} />
      </span>
    </a>
  );
}

export default function HomePage() {
  const { ai, materials, health, learnerId } = useApp();
  const [overview, setOverview] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState(null);

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

  const totals = overview?.totals;
  const readyMaterials = materials.filter((m) => m.status === 'ready').length;
  const failedMaterials = materials.filter((m) => m.status === 'failed');
  const isEmpty = materials.length === 0;
  const activity = overview?.activity ?? [];

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
          <div className="hero__actions">
            <a className="ls-btn ls-btn--primary ls-btn--md" href="#/materials">
              <Icon name="upload" size={17} />
              <span>Add study material</span>
            </a>
            <a className="ls-btn ls-btn--secondary ls-btn--md" href="#/chat">
              <Icon name="teacher" size={17} />
              <span>Ask the AI Teacher</span>
            </a>
          </div>
        </div>
        <div className="hero__aside">
          <div className="hero__aside-row">
            <span className="hero__aside-label">Answer engine</span>
            <Badge tone={ai?.mode === 'live' ? 'success' : 'warning'} icon={ai?.mode === 'live' ? 'sparkles' : 'shield'}>
              {ai?.mode === 'live' ? `${ai.label} · ${ai.model}` : 'Local extractive mode'}
            </Badge>
          </div>
          <div className="hero__aside-row">
            <span className="hero__aside-label">Study profile</span>
            <span className="hero__aside-value">{learnerId}</span>
          </div>
          <div className="hero__aside-row">
            <span className="hero__aside-label">Indexed passages</span>
            <span className="hero__aside-value">{formatNumber(health?.store?.passages ?? 0)}</span>
          </div>
          <p className="hero__aside-note">
            {ai?.mode === 'live'
              ? 'Only the retrieved passages are sent to the model — never your whole library.'
              : 'No AI key configured, so answers are assembled locally from your own text and nothing leaves this machine.'}
          </p>
        </div>
      </section>

      {failedMaterials.length > 0 ? (
        <Alert tone="warning" title={`${failedMaterials.length} file${pluralise(failedMaterials.length, '', 's')} could not be indexed`}>
          <p>
            {failedMaterials.map((m) => m.name).join(', ')} — the file was stored so you can see what
            happened, but nothing from it is searchable. Remove it, or upload a text-based version.
          </p>
        </Alert>
      ) : null}

      <section className="quick-grid" aria-label="Quick actions">
        {QUICK_ACTIONS.map((item) => (
          <QuickCard key={item.to} item={item} />
        ))}
      </section>

      <section className="stat-row" aria-label="Library summary">
        <StatTile
          label="Materials"
          value={formatNumber(materials.length)}
          hint={isEmpty ? 'Nothing uploaded yet' : `${readyMaterials} ready · ${materials.length - readyMaterials} not indexed`}
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

      {state === 'loading' ? (
        <Card title="Activity">
          <LoadingPanel label="Loading your activity" rows={3} />
        </Card>
      ) : state === 'error' ? (
        <ErrorPanel error={error} onRetry={() => load()} title="Could not load your activity" />
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
      ) : (
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
