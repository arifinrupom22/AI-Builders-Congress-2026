/**
 * Due for review — the spaced-review queue.
 *
 * The server schedules every card from the learner's own ratings: "Again"
 * comes back in 10 minutes, while Hard / Good / Easy grow the last interval
 * (x1.2, x2, x3) with floors of 1, 3 and 7 days, capped at 120 days. This
 * screen shows which cards are due, exactly why each one came back, and lets
 * the learner reveal the answer and rate it again — or move a due card aside
 * with a snooze, which never records a rating.
 *
 * Nothing here predicts ability: a due date is only a consequence of when a
 * card was last rated and how it was rated. Due dates are stored on the server,
 * so the queue is the same after a reload.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../store/AppContext.jsx';
import { Icon } from '../components/Icons.jsx';
import { Alert, Badge, Button, Card, EmptyState, ErrorPanel, LoadingPanel, StatTile } from '../components/ui.jsx';
import { formatDate, formatDue, formatDueIn, formatInterval, pluralise, truncate } from '../lib/format.js';

const GRADES = [
  { id: 'again', label: 'Again', hint: 'I forgot this — back in 10 minutes', tone: 'danger' },
  { id: 'hard', label: 'Hard', hint: 'Barely remembered — last interval x 1.2, at least 1 day', tone: 'warning' },
  { id: 'good', label: 'Good', hint: 'Remembered with effort — last interval x 2, at least 3 days', tone: 'accent' },
  { id: 'easy', label: 'Easy', hint: 'Knew it instantly — last interval x 3, at least 7 days', tone: 'success' },
];

const GRADE_TONES = Object.fromEntries(GRADES.map((g) => [g.id, g.tone]));

/** The due chip: what the learner sees first for every queued card. */
function dueChip(item) {
  if (item.status === 'new') return { tone: 'neutral', label: 'not rated yet' };
  if ((item.overdueByMs ?? 0) > 3_600_000) return { tone: 'danger', label: formatDue(item.dueAt) };
  return { tone: 'warning', label: formatDue(item.dueAt) };
}

function QueueItem({ item, open, busy, onToggle, onRate, onSnooze }) {
  const lang = item.language === 'bn' ? 'bn' : undefined;
  const chip = dueChip(item);
  const snoozeLabel = item.snoozes > 0 ? `${item.snoozes} snooze${item.snoozes === 1 ? '' : 'zes'}` : null;

  return (
    <li className={`queue-item queue-item--${item.status}${open ? ' is-open' : ''}`}>
      <div className="queue-item__head">
        <span className={`queue-chip queue-chip--${chip.tone}`}>{chip.label}</span>
        <span className="queue-item__deck" title={item.deckTitle}>
          <Icon name="cards" size={14} /> {truncate(item.deckTitle, 46)}
        </span>
        <span className="queue-item__spacer" />
        {item.lastGrade ? (
          <Badge tone={GRADE_TONES[item.lastGrade] ?? 'neutral'} title={`Your last rating for this card: ${item.lastGrade}`}>
            {item.lastGrade}
          </Badge>
        ) : null}
        {snoozeLabel ? (
          <Badge tone="neutral" icon="clock" title="Times you have moved this card aside without rating it">
            {snoozeLabel}
          </Badge>
        ) : null}
        {item.derived ? (
          <Badge
            tone="neutral"
            title="Rated before due dates were stored, so this date is derived from the grade you gave — it is not extra history."
          >
            derived
          </Badge>
        ) : null}
      </div>

      <p className="queue-item__question" lang={lang}>
        {item.question}
      </p>

      <p className="queue-item__reason">
        <Icon name="info" size={14} />
        <span>{item.reason}</span>
      </p>

      <p className="queue-item__meta">
        {item.status === 'new'
          ? 'No due date — rating it once starts its schedule'
          : <>Due {formatDate(item.dueAt)} · interval {formatInterval(item.intervalMs)}</>}
        {' · rated '}
        {item.reviews} time{pluralise(item.reviews, '', 's')}
        {item.lastReviewedAt ? ` · last ${formatDate(item.lastReviewedAt, { withTime: false })}` : ''}
      </p>

      {open ? (
        <div className="queue-item__review">
          <hr className="flashcard__divider" />
          <p className="flashcard__label flashcard__label--answer">Answer</p>
          <p className="flashcard__answer" lang={lang}>
            {item.answer}
          </p>
          {item.source?.documentName ? (
            <p className="flashcard__source">
              <Icon name="file" size={14} /> from {item.source.documentName}
              {item.source.pageNumber ? ` · page ${item.source.pageNumber}` : ''}
            </p>
          ) : null}

          <div className="flashcard__grades">
            {GRADES.map((g) => (
              <button
                key={g.id}
                type="button"
                className={`grade-btn grade-btn--${g.tone}`}
                disabled={busy}
                onClick={() => onRate(item, g.id)}
                title={g.hint}
              >
                {g.label}
              </button>
            ))}
          </div>
          <p className="muted-xs flashcard__grade-hint">
            How well did you know this? Your rating sets the next due date — the four buttons show the interval each
            one uses.
          </p>

          <div className="row-actions queue-item__hide">
            <Button variant="ghost" size="sm" onClick={onToggle}>
              Hide answer
            </Button>
          </div>
        </div>
      ) : (
        <div className="queue-item__actions">
          <Button size="sm" icon="eye" onClick={onToggle} disabled={busy}>
            Review
          </Button>
          {item.status === 'due' ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                icon="clock"
                disabled={busy}
                title="Move this card two hours later — no rating is recorded"
                onClick={() => onSnooze(item, 120)}
              >
                Later today
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="refresh"
                disabled={busy}
                title="Move this card to tomorrow — no rating is recorded"
                onClick={() => onSnooze(item, 1440)}
              >
                Tomorrow
              </Button>
            </>
          ) : (
            <span className="muted-xs">Rate it once to set its first due date.</span>
          )}
        </div>
      )}
    </li>
  );
}

export default function ReviewQueuePage() {
  const { learnerId, notify } = useApp();
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState(null);
  const [openKey, setOpenKey] = useState(null);
  const [busyKey, setBusyKey] = useState(null);

  const load = useCallback(
    async ({ silent = false, signal } = {}) => {
      if (!silent) {
        setState('loading');
        setError(null);
      }
      try {
        const queue = await api.dueFlashcards();
        if (signal?.aborted) return;
        setData(queue);
        setState('ready');
        setError(null);
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') return;
        // A background revalidation failure must not hide the queue the
        // learner is already looking at.
        if (silent) return;
        setError(err);
        setState('error');
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    load({ signal: controller.signal });
    return () => controller.abort();
  }, [load, learnerId]);

  const keyOf = (item) => `${item.deckId}:${item.cardId}`;

  /** Drop one card from the visible queue; the silent reload corrects the counts. */
  const removeItem = (item) => {
    setData((prev) => (prev ? { ...prev, items: prev.items.filter((i) => keyOf(i) !== keyOf(item)) } : prev));
    setOpenKey(null);
    load({ silent: true });
  };

  const handleRate = async (item, grade) => {
    const key = keyOf(item);
    setBusyKey(key);
    try {
      const result = await api.reviewFlashcards(item.deckId, [{ cardId: item.cardId, grade }]);
      const schedule = result.schedules?.find((s) => s.cardId === item.cardId);
      notify(
        schedule?.dueAt
          ? `Saved — “${grade}” means this card is next due ${formatDueIn(schedule.dueAt)}.`
          : 'Rating saved.',
        'success',
      );
      removeItem(item);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleSnooze = async (item, minutes) => {
    const key = keyOf(item);
    setBusyKey(key);
    try {
      const result = await api.snoozeFlashcard(item.deckId, item.cardId, minutes);
      notify(
        `Snoozed until ${formatDate(result.schedule?.dueAt)} — no rating was recorded.`,
        'success',
      );
      removeItem(item);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const counts = data?.counts ?? null;
  const items = data?.items ?? [];
  const nextDueAt = data?.nextDueAt ?? null;

  const emptyState = () => {
    if (!counts || counts.totalCards === 0) {
      return (
        <EmptyState
          icon="cards"
          title="No flashcards to review yet"
          description="The queue fills up from decks you build and from the ratings you give them — a card only appears once you have actually rated it, and its due date is set by that rating."
          action={
            <a className="ls-btn ls-btn--primary ls-btn--md" href="#/flashcards">
              <Icon name="cards" size={17} />
              <span>Create a flashcard deck</span>
            </a>
          }
        />
      );
    }
    return (
      <EmptyState
        icon="check"
        title="Nothing due right now"
        description={
          <>
            All {counts.totalCards} card{pluralise(counts.totalCards, '', 's')} across {counts.decks} deck
            {pluralise(counts.decks, '', 's')} are scheduled from your own ratings.
            {nextDueAt ? ` The next one is due ${formatDueIn(nextDueAt)} — ${formatDate(nextDueAt)}.` : ''}
            {' '}
            {counts.upcoming > 0
              ? `${counts.upcoming} card${pluralise(counts.upcoming, '', 's')} scheduled later`
              : 'Nothing is scheduled later'}
            {counts.snoozed > 0 ? `, including ${counts.snoozed} you snoozed` : ''}.
            {' '}
            Nothing is waiting because there is nothing to do — the schedule simply has not elapsed yet.
          </>
        }
        action={
          <>
            <a className="ls-btn ls-btn--primary ls-btn--md" href="#/flashcards">
              <Icon name="cards" size={17} />
              <span>Study a deck</span>
            </a>
            <Button variant="secondary" icon="refresh" onClick={() => load()}>
              Check again
            </Button>
          </>
        }
      />
    );
  };

  return (
    <div className="page">
      <section className="stat-row" aria-label="Queue summary">
        <StatTile
          label="Due now"
          value={counts ? counts.due : '—'}
          hint="Interval from your rating has elapsed"
          icon="clock"
          tone={counts && counts.due > 0 ? 'warning' : 'default'}
        />
        <StatTile
          label="Never rated"
          value={counts ? counts.newCards : '—'}
          hint="Waiting for their first rating"
          icon="cards"
        />
        <StatTile
          label="Scheduled later"
          value={counts ? counts.upcoming : '—'}
          hint={nextDueAt ? `Next due ${formatDueIn(nextDueAt)}` : 'Nothing scheduled after now'}
          icon="chart"
        />
        <StatTile
          label="Snoozed"
          value={counts ? counts.snoozed : '—'}
          hint="Moved aside by you, not rated"
          icon="refresh"
        />
      </section>

      {data?.note ? (
        <Alert tone="info" title="How this schedule works">
          <p>{data.note}</p>
        </Alert>
      ) : null}

      {state === 'loading' ? (
        <Card title="Due for review">
          <LoadingPanel label="Reading your schedule" rows={3} />
        </Card>
      ) : state === 'error' ? (
        <ErrorPanel error={error} onRetry={() => load()} title="Could not load the review queue" />
      ) : items.length === 0 ? (
        emptyState()
      ) : (
        <Card
          title={`Ready to review · ${items.length}`}
          subtitle={
            <>
              Sorted by how long each card has been waiting. Every reason below is built from your own ratings.
              {data && data.totalItems > items.length
                ? ` Showing ${items.length} of ${data.totalItems} due now.`
                : ''}
            </>
          }
          actions={
            <Button variant="ghost" size="sm" icon="refresh" onClick={() => load()}>
              Refresh
            </Button>
          }
        >
          <ul className="queue">
            {items.map((item) => {
              const key = keyOf(item);
              return (
                <QueueItem
                  key={key}
                  item={item}
                  open={openKey === key}
                  busy={busyKey === key}
                  onToggle={() => setOpenKey((current) => (current === key ? null : key))}
                  onRate={handleRate}
                  onSnooze={handleSnooze}
                />
              );
            })}
          </ul>
        </Card>
      )}

      {counts && counts.totalCards > 0 && items.length > 0 ? (
        <Card
          title="Scheduled later"
          subtitle="Cards whose intervals have not elapsed yet — they will appear here when they are due."
        >
          <p className="muted">
            {counts.upcoming > 0 ? (
              <>
                <strong>{counts.upcoming}</strong> card{pluralise(counts.upcoming, '', 's')} waiting
                {nextDueAt ? (
                  <>
                    {' · next due '}
                    <strong>{formatDate(nextDueAt)}</strong> ({formatDueIn(nextDueAt)})
                  </>
                ) : null}
                {counts.snoozed > 0 ? ` · ${counts.snoozed} of them you snoozed` : ''}
              </>
            ) : (
              'Nothing is scheduled beyond what is due now.'
            )}
          </p>
          <p className="muted-xs" style={{ marginTop: 'var(--s3)' }}>
            Scheduled dates never change on their own: they move only when you rate a card again or snooze it.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
