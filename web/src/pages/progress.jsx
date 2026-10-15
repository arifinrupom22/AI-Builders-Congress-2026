/**
 * Progress — what you have actually done, and what to revise next.
 *
 * Every figure is a count of real recorded events. Where there is not enough
 * data to say something useful the page says so, and the server's own
 * disclaimer is always shown alongside the numbers.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../store/AppContext.jsx';
import { Icon } from '../components/Icons.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorPanel,
  LoadingPanel,
  ProgressBar,
  StatTile,
} from '../components/ui.jsx';
import { dayLabel, formatNumber, formatPercent, formatRelative, pluralise, truncate } from '../lib/format.js';

function ActivityChart({ activity, streakDays }) {
  const max = Math.max(1, ...activity.map((d) => d.quizzes + d.sessions + d.uploads));
  return (
    <div className="activity">
      <div className="activity__bars">
        {activity.map((day) => {
          const total = day.quizzes + day.sessions + day.uploads;
          const height = total === 0 ? 3 : Math.max(8, Math.round((total / max) * 100));
          return (
            <div className="activity__col" key={day.day}>
              <div className="activity__stack" style={{ height: `${height}%` }}>
                {day.quizzes > 0 ? <span className="activity__seg activity__seg--quiz" style={{ flex: day.quizzes }} /> : null}
                {day.sessions > 0 ? <span className="activity__seg activity__seg--session" style={{ flex: day.sessions }} /> : null}
                {day.uploads > 0 ? <span className="activity__seg activity__seg--upload" style={{ flex: day.uploads }} /> : null}
              </div>
              <span className="activity__label">{dayLabel(day.day)}</span>
            </div>
          );
        })}
      </div>
      <div className="activity__legend">
        <span className="legend__item">
          <i className="legend__dot legend__dot--quiz" /> quiz attempts
        </span>
        <span className="legend__item">
          <i className="legend__dot legend__dot--session" /> study sessions
        </span>
        <span className="legend__item">
          <i className="legend__dot legend__dot--upload" /> uploads
        </span>
        <span className="legend__item legend__item--right">
          <Icon name="flag" size={14} /> {streakDays} day streak
        </span>
      </div>
    </div>
  );
}

export default function ProgressPage() {
  const { learnerId } = useApp();
  const [overview, setOverview] = useState(null);
  const [revision, setRevision] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState(null);

  const load = useCallback(async (signal) => {
    setState('loading');
    setError(null);
    try {
      const [nextOverview, nextRevision] = await Promise.all([api.progress(), api.revision()]);
      if (signal?.aborted) return;
      setOverview(nextOverview);
      setRevision(nextRevision);
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

  if (state === 'loading') {
    return (
      <div className="page">
        <Card title="Progress">
          <LoadingPanel label="Reading your practice record" rows={4} />
        </Card>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="page">
        <ErrorPanel error={error} onRetry={() => load()} title="Could not load your progress" />
      </div>
    );
  }

  const totals = overview.totals;

  if (!overview.hasActivity) {
    return (
      <div className="page">
        <EmptyState
          icon="chart"
          title="No practice recorded yet"
          description="Progress here is built from the quizzes you submit and the sessions you start. Nothing is estimated, so there is nothing to show until you practise."
          action={
            <a className="ls-btn ls-btn--primary ls-btn--md" href="#/quiz">
              <Icon name="quiz" size={17} />
              <span>Take a practice quiz</span>
            </a>
          }
        />
        <Alert tone="info" title="What this page will show">
          <p>{overview.disclaimer}</p>
        </Alert>
      </div>
    );
  }

  return (
    <div className="page">
      <section className="stat-row" aria-label="Totals">
        <StatTile label="Materials" value={formatNumber(totals.materials)} hint={`${totals.readyMaterials} indexed`} icon="library" />
        <StatTile label="Study sessions" value={formatNumber(totals.sessions)} hint="Conversations with the teacher" icon="teacher" />
        <StatTile label="Quizzes attempted" value={formatNumber(totals.quizzesAttempted)} hint={`${totals.quizzesGenerated} generated`} icon="quiz" />
        <StatTile
          label="Accuracy"
          value={formatPercent(totals.overallAccuracy)}
          hint={`${formatNumber(totals.questionsCorrect)} of ${formatNumber(totals.questionsAnswered)} answered`}
          icon="target"
        />
      </section>

      <Card title="Study activity" subtitle="The last 14 days, built only from recorded events.">
        <ActivityChart activity={overview.activity} streakDays={overview.streakDays} />
      </Card>

      <div className="split">
        <Card title="Revision plan" subtitle="Generated from your own attempts.">
          {revision.weakTopics?.length ? (
            <ul className="revision-list">
              {revision.weakTopics.map((topic) => (
                <li key={topic.topic} className="revision-list__item">
                  <div className="revision-list__head">
                    <span className="revision-list__topic">{truncate(topic.topic, 80)}</span>
                    <Badge tone={topic.accuracy >= 50 ? 'warning' : 'danger'}>{formatPercent(topic.accuracy)}</Badge>
                  </div>
                  <p className="revision-list__reason">{topic.reason}</p>
                  <p className="revision-list__action">
                    <Icon name="chevronRight" size={13} /> {topic.suggestedAction}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              {revision.hasEnoughData
                ? `No topic is below the ${overview.revisionAccuracyThreshold}% revision threshold yet.`
                : 'Answer a few questions and a revision plan will appear here.'}
            </p>
          )}

          {revision.unpractisedMaterials?.length ? (
            <>
              <h3 className="subhead">Documents you have not practised</h3>
              <ul className="chip-list">
                {revision.unpractisedMaterials.map((material) => (
                  <li key={material.materialId} className="chip">
                    <Icon name="file" size={13} /> {truncate(material.name, 44)}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {revision.topicsWithSingleAttempt?.length ? (
            <>
              <h3 className="subhead">Seen once only</h3>
              <ul className="chip-list">
                {revision.topicsWithSingleAttempt.map((topic) => (
                  <li key={topic} className="chip">
                    {truncate(topic, 44)}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <p className="muted-xs">{revision.disclaimer}</p>
        </Card>

        <Card title="Recent attempts" subtitle="Most recent first.">
          {overview.recentAttempts?.length ? (
            <ul className="row-list">
              {overview.recentAttempts.map((attempt) => {
                const tone = attempt.percent >= 80 ? 'success' : attempt.percent >= 50 ? 'warning' : 'danger';
                return (
                  <li key={`${attempt.quizId}-${attempt.createdAt}`} className="row-list__item">
                    <div className="row-list__main">
                      <span className="row-list__title">{truncate(attempt.title, 60)}</span>
                      <span className="row-list__meta">
                        {attempt.correctCount}/{attempt.total} correct · {formatRelative(attempt.createdAt)}
                      </span>
                    </div>
                    <div className="row-list__side">
                      <Badge tone={tone}>{attempt.percent}%</Badge>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">No quiz attempts recorded yet.</p>
          )}
        </Card>
      </div>

      <Card
        title="Topic breakdown"
        subtitle={`${overview.topics.length} topic${pluralise(overview.topics.length, '', 's')} derived from the documents you practised.`}
      >
        {overview.topics.length ? (
          <div className="table-wrap">
            <table className="ls-table">
              <thead>
                <tr>
                  <th scope="col">Topic</th>
                  <th scope="col">Answered</th>
                  <th scope="col">Correct</th>
                  <th scope="col">Accuracy</th>
                  <th scope="col">Source documents</th>
                </tr>
              </thead>
              <tbody>
                {overview.topics.map((topic) => (
                  <tr key={topic.topic}>
                    <td className="ls-table__topic">{truncate(topic.topic, 70)}</td>
                    <td>{topic.total}</td>
                    <td>{topic.correct}</td>
                    <td className="ls-table__meter">
                      <Badge tone={topic.accuracy >= 80 ? 'success' : topic.accuracy >= 50 ? 'warning' : 'danger'}>
                        {formatPercent(topic.accuracy)}
                      </Badge>
                      <ProgressBar value={topic.accuracy} />
                    </td>
                    <td className="ls-table__docs">
                      {topic.documents.map((doc) => (
                        <span key={doc} className="term-chip">
                          {truncate(doc, 30)}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No topic data yet.</p>
        )}

        <p className="muted-xs">{overview.disclaimer}</p>

        <div className="row-actions">
          <Button variant="secondary" icon="refresh" onClick={() => load()}>
            Refresh
          </Button>
        </div>
      </Card>

      {overview.strongestTopics?.length ? (
        <Card title="Going well" subtitle="Topics where you are answering most questions correctly.">
          <ul className="chip-list">
            {overview.strongestTopics.map((topic) => (
              <li key={topic.topic} className="chip">
                <Icon name="check" size={13} /> {truncate(topic.topic, 50)} · {formatPercent(topic.accuracy)}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
