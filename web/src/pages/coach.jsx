/**
 * Adaptive Exam Coach.
 *
 * The coach picks the next quiz from evidence that already exists — recorded
 * quiz answers and flashcard ratings — and explains the choice in counts. With
 * too little evidence it starts from a baseline. Its plan uses real practice,
 * unpractised documents and the existing review queue; it never reschedules a
 * card, predicts a score, or claims mastery or learning gain.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../store/AppContext.jsx';
import { Icon } from '../components/Icons.jsx';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  ErrorPanel,
  LoadingPanel,
  StatTile,
} from '../components/ui.jsx';
import { formatNumber, formatPercent, formatRelative, pluralise, truncate } from '../lib/format.js';

const MODE_LABELS = {
  baseline: 'Baseline',
  adaptive: 'Adaptive',
  'no-material': 'Waiting for material',
};

const STEP_ICONS = {
  practice: 'quiz',
  material: 'library',
  review: 'clock',
  plan: 'calendar',
};

const STEP_ACTION_LABELS = {
  practice: 'Open quiz',
  material: 'Open document',
  review: 'Open queue',
  plan: 'Open study plan',
};

function EvidenceChips({ evidence }) {
  if (!evidence) return null;
  const chips = [];
  if (evidence.answersOnConcept > 0) {
    chips.push(
      `${evidence.correctOnConcept} of ${evidence.answersOnConcept} quiz answers correct${
        evidence.accuracy !== null ? ` (${formatPercent(evidence.accuracy)})` : ''
      }`,
    );
  } else {
    chips.push('No quiz answers on this concept');
  }
  chips.push(
    evidence.ratingsOnConcept > 0
      ? `${evidence.ratingsOnConcept} flashcard rating${pluralise(evidence.ratingsOnConcept, '', 's')}${
          evidence.weakRatingsOnConcept > 0 ? ` · ${evidence.weakRatingsOnConcept} Again/Hard` : ''
        }`
      : 'No flashcard ratings on this concept',
  );
  if (evidence.lastPractisedAt) {
    chips.push(`Last practised ${formatRelative(evidence.lastPractisedAt)}`);
  }
  return (
    <ul className="coach-chips">
      {chips.map((chip) => (
        <li key={chip} className="coach-chip">
          {chip}
        </li>
      ))}
    </ul>
  );
}

export default function CoachPage() {
  const { learnerId } = useApp();
  const [plan, setPlan] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState(null);

  const load = useCallback(async (signal) => {
    setState('loading');
    setError(null);
    try {
      const data = await api.coachPlan();
      if (signal?.aborted) return;
      setPlan(data);
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
        <Card title="Adaptive Exam Coach">
          <LoadingPanel label="Reading your practice record" rows={4} />
        </Card>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="page">
        <ErrorPanel error={error} onRetry={() => load()} title="Could not load your coaching plan" />
      </div>
    );
  }

  const recommendation = plan.recommendation;
  const totals = plan.totals ?? {};
  const recentAttempts = plan.recentAttempts ?? [];
  const steps = plan.nextSteps ?? [];

  return (
    <div className="page">
      <Card
        title="Adaptive Exam Coach"
        subtitle="Your next practice, chosen from quiz answers and flashcard ratings that are already recorded — with the reason shown."
        actions={<Badge tone={plan.mode === 'adaptive' ? 'accent' : 'neutral'}>{MODE_LABELS[plan.mode] ?? plan.mode}</Badge>}
      >
        <div className="coach-summary">
          <StatTile
            label="Quizzes attempted"
            value={formatNumber(totals.quizzesAttempted ?? 0)}
            hint="Recorded attempts only"
            icon="quiz"
          />
          <StatTile
            label="Questions answered"
            value={formatNumber(totals.questionsAnswered ?? 0)}
            hint={
              totals.overallAccuracy == null
                ? 'No answers recorded'
                : `${formatPercent(totals.overallAccuracy)} correct overall`
            }
            icon="target"
          />
          <StatTile
            label="Flashcard ratings"
            value={formatNumber(totals.ratings ?? 0)}
            hint="Your own self-assessment"
            icon="cards"
          />
          <StatTile
            label="Concepts with evidence"
            value={formatNumber(totals.conceptsPractised ?? 0)}
            hint="Each appears in Learning DNA"
            icon="dna"
          />
        </div>

        <Alert tone="info" title="What the coach is">
          <p>{plan.disclaimer}</p>
        </Alert>
      </Card>

      {plan.mode === 'no-material' ? (
        <EmptyState
          icon="library"
          title="Nothing to coach you from yet"
          description="The coach chooses practice from your own uploaded material. Upload a document and it can start you with a baseline quiz."
          action={
            <a className="ls-btn ls-btn--primary ls-btn--md" href="#/materials">
              <Icon name="upload" size={17} />
              <span>Add study material</span>
            </a>
          }
        />
      ) : recommendation ? (
        <Card
          title="Your next practice"
          subtitle="The coach's choice for this session, with the evidence behind it."
          actions={
            <Badge tone={recommendation.baseline ? 'neutral' : 'accent'} icon={recommendation.baseline ? 'shield' : 'compass'}>
              {recommendation.baseline ? 'Baseline' : 'Adaptive'}
            </Badge>
          }
        >
          <div className="coach-reco">
            <div className="coach-reco__head">
              <span className="coach-reco__eyebrow">
                {recommendation.styleLabel} · {recommendation.questions} questions
              </span>
              <h3 className="coach-reco__title">
                {recommendation.topic ? `“${recommendation.topic}”` : recommendation.topicLabel}
              </h3>
            </div>

            <p className="coach-reco__why">
              <strong>Why this:</strong> {recommendation.reason}
            </p>

            <EvidenceChips evidence={recommendation.evidence} />

            <div className="row-actions">
              <a className="ls-btn ls-btn--primary ls-btn--md" href={`#${recommendation.href}`}>
                <Icon name="quiz" size={17} />
                <span>Start this quiz</span>
              </a>
              <a className="ls-btn ls-btn--secondary ls-btn--md" href="#/dna">
                <Icon name="dna" size={17} />
                <span>See the evidence profile</span>
              </a>
            </div>

            <p className="muted-xs">
              {recommendation.style === 'recall'
                ? 'A recall drill asks only what concepts mean, so you meet the definition again before anything harder.'
                : 'Mixed questions ask what concepts mean and ask you to recognise statements from your material.'}{' '}
              The coach never predicts a score.
            </p>
          </div>
        </Card>
      ) : null}

      {steps.length > 0 ? (
        <Card
          title="Next steps"
          subtitle="A short plan from your recorded practice, your unpractised documents and the existing review queue."
        >
          <ol className="coach-steps">
            {steps.map((step) => (
              <li key={step.id} className={`coach-step coach-step--${step.kind}`}>
                <span className="coach-step__icon">
                  <Icon name={STEP_ICONS[step.kind] ?? 'compass'} size={16} />
                </span>
                <div className="coach-step__main">
                  <span className="coach-step__title">{step.title}</span>
                  <p className="coach-step__detail">{step.detail}</p>
                  {step.meta ? <span className="coach-step__meta">{step.meta}</span> : null}
                </div>
                <a className="coach-step__action" href={`#${step.href}`}>
                  {STEP_ACTION_LABELS[step.kind] ?? 'Open'} <Icon name="chevronRight" size={14} />
                </a>
              </li>
            ))}
          </ol>
          <p className="muted-xs coach-note">
            The review step links to the existing “Due for review” queue. The coach does not create, move, or duplicate
            any review date.
          </p>
        </Card>
      ) : null}

      <Card
        title="Recent practice"
        subtitle="The scores you actually recorded. Nothing here is a predicted score."
        actions={
          plan.retest ? (
            <a className="ls-btn ls-btn--secondary ls-btn--sm" href={`#${plan.retest.href}`}>
              <Icon name="refresh" size={15} />
              <span>Retest</span>
            </a>
          ) : null
        }
      >
        {recentAttempts.length === 0 ? (
          <p className="muted">
            No quiz attempts are recorded yet. Your first quiz becomes the baseline the coach works from.
          </p>
        ) : (
          <ul className="coach-attempts">
            {recentAttempts.map((attempt) => (
              <li key={`${attempt.quizId}-${attempt.createdAt}`} className="coach-attempt">
                <div className="coach-attempt__main">
                  <span className="coach-attempt__title">{truncate(attempt.title ?? 'Practice quiz', 70)}</span>
                  <span className="coach-attempt__meta">
                    {attempt.topic ? `${truncate(attempt.topic, 50)} · ` : ''}
                    {formatRelative(attempt.createdAt)}
                  </span>
                </div>
                <div className="coach-attempt__score">
                  <span className="coach-attempt__percent">{formatPercent(attempt.percent)}</span>
                  <span className="coach-attempt__count">
                    {attempt.correctCount} of {attempt.total} correct
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="muted-xs coach-note">
          Score changes between attempts are just that — different scores on different question sets. The coach makes no
          claim about learning gain or mastery from them.
        </p>
      </Card>
    </div>
  );
}
