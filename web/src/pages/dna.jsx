/**
 * Learning DNA — an evidence profile of what this study profile has practised.
 *
 * Every number here is a count of recorded activity: quiz questions answered,
 * how many of those were correct, and the flashcards the learner rated. Nothing
 * is estimated, and no concept is labelled mastered.
 *
 * Accuracy is shown only for quiz attempts, where correctness is known. Flashcard
 * ratings are self-assessment, so they are shown as grades — never converted to
 * a percentage. Where the record is too thin the card says
 * "not enough practice data yet" rather than drawing a conclusion.
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
import { formatNumber, formatPercent, formatRelative, pluralise } from '../lib/format.js';

const GRADES = [
  ['again', 'Again'],
  ['hard', 'Hard'],
  ['good', 'Good'],
  ['easy', 'Easy'],
];

/** The server's own phrase, so thin evidence reads the same across the app. */
const INSUFFICIENT = 'not enough practice data yet';

/**
 * A row of small evidence marks: one per recorded quiz answer or card rating,
 * capped so a heavily practised concept stays readable. It is a count, not a
 * score — the legend says which colour is which.
 */
function EvidenceMarks({ quizAnswers, ratings, cap = 24 }) {
  const items = [];
  for (let i = 0; i < Math.min(quizAnswers, cap); i += 1) items.push('quiz');
  for (let i = 0; i < Math.min(ratings, cap - items.length); i += 1) items.push('rating');
  if (items.length === 0) return null;
  const hidden = quizAnswers + ratings - items.length;
  return (
    <div className="dna-marks" aria-hidden="true">
      {items.map((kind, index) => (
        <span key={`${kind}-${index}`} className={`dna-mark dna-mark--${kind}`} />
      ))}
      {hidden > 0 ? <span className="dna-marks__more">+{hidden}</span> : null}
    </div>
  );
}

function ConceptCard({ concept }) {
  const { quiz, flashcards, morePractice } = concept;
  const accuracy = quiz.accuracy;
  // Only "suggested" gets a warning tone; a concept with no practice signal is
  // not coloured like a success, because that would read as "mastered".
  const tone = morePractice.state === 'suggested' ? 'warning' : 'neutral';

  const label =
    morePractice.state === 'suggested'
      ? 'More practice suggested'
      : morePractice.state === 'not-enough-data'
        ? INSUFFICIENT
        : 'No practice signal recorded';

  const sources = concept.documents ?? [];

  return (
    <article className="dna-card">
      <header className="dna-card__head">
        <h3 className="dna-card__concept">{concept.concept}</h3>
        <Badge tone={tone} icon={morePractice.state === 'suggested' ? 'flag' : 'info'}>
          {label}
        </Badge>
      </header>

      <div className="dna-card__evidence">
        <div className="dna-stat">
          <span className="dna-stat__label">Quiz evidence</span>
          {quiz.answered > 0 ? (
            <>
              <span className="dna-stat__value">
                {formatPercent(accuracy)}
                <span className="dna-stat__unit">
                  {' '}
                  · {quiz.correct} of {quiz.answered} answered correctly
                </span>
              </span>
              <ProgressBar
                label={`${quiz.correct} of ${quiz.answered} questions correct on ${concept.concept}`}
                value={accuracy}
                max={100}
              />
            </>
          ) : (
            <span className="dna-stat__empty">No quiz answers recorded</span>
          )}
          {quiz.skipped > 0 ? (
            <span className="dna-stat__meta">
              {formatNumber(quiz.skipped)} skipped question{pluralise(quiz.skipped, '', 's')} recorded — skipped is not
              the same as answered.
            </span>
          ) : null}
          {quiz.quizzes > 0 ? (
            <span className="dna-stat__meta">
              {quiz.quizzes} quiz attempt{pluralise(quiz.quizzes, '', 's')}
              {quiz.lastPractisedAt ? ` · last practised ${formatRelative(quiz.lastPractisedAt)}` : ''}
            </span>
          ) : null}
        </div>

        <div className="dna-stat">
          <span className="dna-stat__label">Flashcard evidence (your own ratings)</span>
          {flashcards.ratings > 0 ? (
            <>
              <span className="dna-stat__value">
                {formatNumber(flashcards.ratings)} rating{pluralise(flashcards.ratings, '', 's')}
                <span className="dna-stat__unit">
                  {' '}
                  · {flashcards.reviewedCards} card{pluralise(flashcards.reviewedCards, '', 's')} reviewed
                </span>
              </span>
              <div className="dna-grades">
                {GRADES.map(([key, gradeLabel]) => (
                  <span key={key} className={`dna-grade dna-grade--${key}`} title={`${gradeLabel} ratings`}>
                    {gradeLabel} <strong>{flashcards.grades?.[key] ?? 0}</strong>
                  </span>
                ))}
              </div>
              {flashcards.lastPractisedAt ? (
                <span className="dna-stat__meta">Last rated {formatRelative(flashcards.lastPractisedAt)}</span>
              ) : null}
            </>
          ) : (
            <span className="dna-stat__empty">No flashcard ratings recorded</span>
          )}
        </div>

        <EvidenceMarks quizAnswers={quiz.answered} ratings={flashcards.ratings} />
      </div>

      <p className={`dna-reason dna-reason--${morePractice.state}`}>{morePractice.reason}</p>

      <footer className="dna-card__foot">
        <div className="dna-links">
          {sources.map((source) => (
            <a
              key={source.materialId ?? source.documentName}
              className="dna-link"
              href={`#/materials?id=${encodeURIComponent(source.materialId ?? '')}`}
              title={
                source.pages?.length
                  ? `${source.documentName} — page ${source.pages.join(', ')}`
                  : source.documentName
              }
            >
              <Icon name="file" size={14} />
              <span>
                {source.documentName}
                {source.pages?.length ? ` · p. ${source.pages.join(', ')}` : ''}
              </span>
            </a>
          ))}
          <a className="dna-link" href="#/quiz" title="Generate a grounded quiz from your material">
            <Icon name="quiz" size={14} />
            <span>Practise with a quiz</span>
          </a>
          <a className="dna-link" href="#/flashcards" title="Build active-recall cards from your material">
            <Icon name="cards" size={14} />
            <span>Practise with flashcards</span>
          </a>
        </div>
        {sources.length > 1 ? (
          <span className="dna-card__meta">
            {sources.length} source documents · {concept.evidenceCount} recorded piece
            {pluralise(concept.evidenceCount, '', 's')} of evidence
          </span>
        ) : (
          <span className="dna-card__meta">
            {concept.evidenceCount} recorded piece{pluralise(concept.evidenceCount, '', 's')} of evidence
          </span>
        )}
      </footer>
    </article>
  );
}

export default function LearningDnaPage() {
  const { learnerId } = useApp();
  const [profile, setProfile] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState(null);

  const load = useCallback(async (signal) => {
    setState('loading');
    setError(null);
    try {
      const data = await api.learningDna();
      if (signal?.aborted) return;
      setProfile(data);
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
        <Card title="Learning DNA">
          <LoadingPanel label="Reading your recorded practice" rows={4} />
        </Card>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="page">
        <ErrorPanel error={error} onRetry={() => load()} title="Could not load your Learning DNA" />
      </div>
    );
  }

  const totals = profile.totals ?? {};
  const concepts = profile.concepts ?? [];
  const hasConcepts = concepts.length > 0;

  return (
    <div className="page">
      <Card
        title="Learning DNA"
        subtitle="An evidence profile of the concepts you have practised, built only from quiz attempts and flashcard ratings saved under this study profile."
      >
        <div className="dna-summary">
          <StatTile
            label="Concepts practised"
            value={formatNumber(totals.conceptsPractised ?? 0)}
            hint={
              hasConcepts
                ? `${concepts.filter((c) => c.morePractice.state === 'suggested').length} with a practice signal`
                : 'Nothing recorded yet'
            }
            icon="dna"
          />
          <StatTile
            label="Questions answered"
            value={formatNumber(totals.questionsAnswered ?? 0)}
            hint={
              totals.overallAccuracy == null
                ? 'No quiz answers recorded'
                : `${formatPercent(totals.overallAccuracy)} correct overall`
            }
            icon="quiz"
          />
          <StatTile
            label="Flashcard ratings"
            value={formatNumber(totals.ratings ?? 0)}
            hint={`${formatNumber(totals.cardsReviewed ?? 0)} card${pluralise(totals.cardsReviewed ?? 0, '', 's')} reviewed`}
            icon="cards"
          />
          <StatTile
            label="Source documents"
            value={formatNumber(totals.materialsPractised ?? 0)}
            hint={`of ${formatNumber(totals.materialsInLibrary ?? 0)} in your library`}
            icon="library"
          />
        </div>

        <Alert tone="info" title="What this profile is">
          <p>{profile.disclaimer}</p>
        </Alert>

        {!profile.hasEnoughData ? (
          <Alert tone="warning" title={INSUFFICIENT} icon="info">
            <p>
              {hasConcepts
                ? 'There is some activity recorded, but not enough of it to say whether any concept needs more practice. Answer a few more questions or rate a few more cards and this page will have something to compare.'
                : 'No quiz answers or flashcard ratings have been recorded under this study profile yet. Take a quiz or build a deck, and your concepts will appear here with the evidence behind them.'}
            </p>
          </Alert>
        ) : null}
      </Card>

      {!hasConcepts ? (
        <EmptyState
          icon="dna"
          title={INSUFFICIENT}
          description="Learning DNA is a record of what you have practised, so it stays empty until you answer quiz questions or rate flashcards. Nothing is estimated to fill the gap."
          action={
            <div className="row-actions">
              <a className="ls-btn ls-btn--primary ls-btn--md" href="#/quiz">
                <Icon name="quiz" size={17} />
                <span>Take a practice quiz</span>
              </a>
              <a className="ls-btn ls-btn--secondary ls-btn--md" href="#/flashcards">
                <Icon name="cards" size={17} />
                <span>Build a flashcard deck</span>
              </a>
            </div>
          }
        />
      ) : (
        <Card
          title="Concepts in your record"
          subtitle="Each card counts the evidence recorded for one concept. Accuracy comes from quiz answers; flashcard grades are your own ratings and are never turned into a percentage."
          actions={
            <div className="dna-legend">
              <span className="legend__item">
                <i className="legend__dot dna-legend__dot--quiz" /> quiz answers
              </span>
              <span className="legend__item">
                <i className="legend__dot dna-legend__dot--rating" /> flashcard ratings
              </span>
            </div>
          }
        >
          <div className="dna-grid">
            {concepts.map((concept) => (
              <ConceptCard key={concept.key} concept={concept} />
            ))}
          </div>
        </Card>
      )}

      <Alert tone="info" title="How to read this">
        <p>
          A concept appears here only because something was recorded for it. “More practice suggested” means either your
          quiz accuracy is below {profile.practiceAccuracyThreshold ?? 80}% on at least two answered questions, or at
          least half your card ratings on it were “Again” or “Hard”. It is a prompt to revisit, never a judgement about
          you.
        </p>
        <p>
          All figures come from the same local data as the rest of the app and stay under this study profile — another
          profile on this machine sees a different record.
        </p>
      </Alert>
    </div>
  );
}
