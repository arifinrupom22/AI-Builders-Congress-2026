/**
 * Flashcards: active recall over your own material.
 *
 * The question is shown first; the answer (with its source document and page)
 * appears only when the learner asks for it. Grading is Again / Hard / Good /
 * Easy, recorded per card so the deck can show what to revisit. The grades are
 * the learner's own self-assessment — the app never turns them into a score or
 * a claim about ability.
 *
 * In local/demo mode the deck is built from definition sentences in the
 * material itself, so every answer is a verbatim sentence from the learner's
 * own documents. When the material cannot support a useful card the server
 * refuses with an explanation, and this page shows that explanation rather
 * than an empty deck.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../store/AppContext.jsx';
import { Icon } from '../components/Icons.jsx';
import { ScopePicker } from '../components/ScopePicker.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorPanel,
  Field,
  LoadingPanel,
  ProgressBar,
  StatTile,
} from '../components/ui.jsx';
import { formatRelative, pluralise, truncate } from '../lib/format.js';

const GRADES = [
  { id: 'again', label: 'Again', hint: 'I forgot this', tone: 'danger' },
  { id: 'hard', label: 'Hard', hint: 'Barely remembered', tone: 'warning' },
  { id: 'good', label: 'Good', hint: 'Remembered with effort', tone: 'accent' },
  { id: 'easy', label: 'Easy', hint: 'Knew it instantly', tone: 'success' },
];

const GRADE_TONES = Object.fromEntries(GRADES.map((g) => [g.id, g.tone]));

/** Fisher–Yates so each session reorders the deck without changing the server copy. */
function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function GeneratorForm({ limits, materials, onGenerated, busy, setBusy }) {
  const [topic, setTopic] = useState('');
  const [count, setCount] = useState(10);
  const [language, setLanguage] = useState('auto');
  const [scope, setScope] = useState([]);

  const maxCards = limits?.maxFlashcards ?? 20;

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.generateFlashcards({
        topic: topic.trim(),
        cardCount: Number(count),
        materialIds: scope.length ? scope : null,
        language: language === 'auto' ? null : language,
      });
      onGenerated(result);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Create a deck" subtitle="Cards are written from your indexed passages only — nothing is invented to fill a gap.">
      <form className="quiz-form" onSubmit={submit}>
        <div className="quiz-form__row">
          <Field label="Topic focus" hint="Leave blank to cover the whole selection.">
            {({ id }) => (
              <input
                id={id}
                className="ls-input"
                type="text"
                value={topic}
                placeholder="e.g. normalisation, chapter 2, ACID properties"
                onChange={(e) => setTopic(e.target.value)}
              />
            )}
          </Field>
          <Field label="Cards">
            {({ id }) => (
              <select id={id} className="ls-input" value={count} onChange={(e) => setCount(e.target.value)}>
                {Array.from({ length: maxCards }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n} card{n === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Language" hint="By default cards follow the language your material is written in.">
            {({ id }) => (
              <select id={id} className="ls-input" value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="auto">Follow the material</option>
                <option value="en">English</option>
                <option value="bn">বাংলা (Bangla)</option>
              </select>
            )}
          </Field>
        </div>

        <ScopePicker materials={materials} selected={scope} onChange={setScope} noun="documents" />

        <div className="quiz-form__actions">
          <Button type="submit" icon="sparkles" loading={busy}>
            Create deck
          </Button>
          <span className="muted-xs">
            If your material cannot support {count} cards, the server builds fewer rather than inventing facts.
          </span>
        </div>
      </form>
    </Card>
  );
}

function GenerationNotices({ meta }) {
  return (
    <>
      {meta?.warnings?.length ? (
        <Alert tone="warning" title="Fewer cards than you asked for">
          <ul className="ls-list ls-list--compact">
            {meta.warnings.map((warning, i) => (
              <li key={warning.code ?? i}>{warning.message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {meta?.fallback ? (
        <Alert tone="warning" title="The AI provider could not be used">
          <p>{meta.fallback.message} These cards were built locally from your material instead.</p>
        </Alert>
      ) : null}
      {meta?.provenance ? <p className="muted-xs">{meta.provenance}</p> : null}
    </>
  );
}

/**
 * One card at a time: question first, answer on request, then the four grades.
 * "Again" puts the card back at the end of this session's queue, so a card you
 * forgot comes round once more before the deck ends.
 */
function StudySession({ deck, onGraded, onExit, saving }) {
  const [queue, setQueue] = useState(() => shuffle(deck.cards).map((card) => card.id));
  const [revealed, setRevealed] = useState(false);
  const [sessionResults, setSessionResults] = useState([]);
  const [done, setDone] = useState(false);

  const cardsById = useMemo(() => new Map(deck.cards.map((card) => [card.id, card])), [deck.cards]);
  const currentId = queue[0];
  const card = currentId ? cardsById.get(currentId) : null;
  const total = deck.cards.length;
  const seen = new Set(sessionResults.map((r) => r.cardId)).size;

  const grade = (gradeId) => {
    setSessionResults((results) => [...results, { cardId: currentId, grade: gradeId }]);
    setQueue((remaining) => {
      const next = remaining.slice(1);
      // "Again" re-queues the card unless it has already come round twice,
      // which keeps a forgotten card from looping forever in one session.
      const alreadyRepeated = sessionResults.filter((r) => r.cardId === currentId).length >= 1;
      if (gradeId === 'again' && !alreadyRepeated) return [...next, currentId];
      return next;
    });
    setRevealed(false);
    if (queue.length <= 1) setDone(true);
  };

  useEffect(() => {
    if (done && sessionResults.length > 0) onGraded(sessionResults);
    // Only fire when the session transitions to done.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  if (done) {
    const counts = { again: 0, hard: 0, good: 0, easy: 0 };
    for (const result of sessionResults) counts[result.grade] += 1;
    return (
      <Card title="Session complete" subtitle={`${sessionResults.length} rating${pluralise(sessionResults.length, '', 's')} across ${seen} card${pluralise(seen, '', 's')}`}>
        <div className="stat-row stat-row--compact">
          {GRADES.map((g) => (
            <StatTile key={g.id} label={g.label} value={counts[g.id]} tone={g.tone === 'danger' ? 'danger' : g.tone === 'warning' ? 'warning' : g.tone === 'success' ? 'success' : 'default'} />
          ))}
        </div>
        <p className="muted-xs" style={{ marginTop: 'var(--s4)' }}>
          {saving ? 'Saving your ratings…' : 'Your ratings are saved to this deck. They show what to revisit — LearnSphere AI does not treat them as a measure of ability.'}
        </p>
        <div className="row-actions" style={{ marginTop: 'var(--s4)' }}>
          <Button icon="refresh" onClick={() => {
            setQueue(shuffle(deck.cards).map((c) => c.id));
            setSessionResults([]);
            setRevealed(false);
            setDone(false);
          }}>
            Study again
          </Button>
          <Button variant="ghost" onClick={onExit}>
            Back to decks
          </Button>
        </div>
      </Card>
    );
  }

  if (!card) return null;

  return (
    <Card title={deck.title} subtitle={`Card ${seen + 1} of ${total} · ${deck.language === 'bn' ? 'বাংলা' : 'English'}`}>
      <div className="quiz-progress">
        <ProgressBar value={seen} max={total} label="Cards reviewed" />
        <span className="muted-xs">
          {seen} of {total} rated
        </span>
      </div>

      <div className="flashcard">
        <p className="flashcard__label">Question</p>
        <p className="flashcard__question" lang={deck.language === 'bn' ? 'bn' : undefined}>
          {card.question}
        </p>

        {revealed ? (
          <>
            <hr className="flashcard__divider" />
            <p className="flashcard__label flashcard__label--answer">Answer</p>
            <p className="flashcard__answer" lang={deck.language === 'bn' ? 'bn' : undefined}>
              {card.answer}
            </p>
            {card.source?.documentName ? (
              <p className="flashcard__source">
                <Icon name="file" size={14} />
                from {card.source.documentName}
                {card.source.pageNumber ? ` · page ${card.source.pageNumber}` : ''}
              </p>
            ) : null}
            <div className="flashcard__grades">
              {GRADES.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className={`grade-btn grade-btn--${g.tone}`}
                  onClick={() => grade(g.id)}
                  title={g.hint}
                >
                  {g.label}
                </button>
              ))}
            </div>
            <p className="muted-xs flashcard__grade-hint">How well did you know this? “Again” brings the card back before the deck ends.</p>
          </>
        ) : (
          <div className="flashcard__reveal">
            <Button icon="eye" size="lg" onClick={() => setRevealed(true)}>
              Show answer
            </Button>
            <p className="muted-xs">Try to recall it first — that struggle is the point.</p>
          </div>
        )}
      </div>

      <div className="quiz-submit">
        <Button variant="ghost" icon="close" onClick={onExit}>
          End session
        </Button>
        {sessionResults.length > 0 ? (
          <span className="muted-xs">{sessionResults.length} rating{pluralise(sessionResults.length, '', 's')} so far — they are saved when the deck ends.</span>
        ) : null}
      </div>
    </Card>
  );
}

export default function FlashcardsPage() {
  const { materials, config, notify, learnerId } = useApp();
  const [decks, setDecks] = useState([]);
  const [decksState, setDecksState] = useState('loading');
  const [activeDeck, setActiveDeck] = useState(null);
  const [meta, setMeta] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const loadDecks = useCallback(async () => {
    setDecksState('loading');
    try {
      const data = await api.listFlashcardDecks();
      setDecks(data.decks ?? []);
      setDecksState('ready');
    } catch {
      setDecksState('error');
    }
  }, []);

  useEffect(() => {
    loadDecks();
  }, [loadDecks, learnerId]);

  const readyMaterials = materials.filter((m) => m.status === 'ready');

  const handleGraded = async (results) => {
    if (!activeDeck || results.length === 0) return;
    setSaving(true);
    try {
      await api.reviewFlashcards(activeDeck.id, results);
      await loadDecks();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      {readyMaterials.length === 0 ? (
        <EmptyState
          icon="library"
          title="Nothing to make flashcards from yet"
          description="Decks are built from your indexed passages, so upload a study material first."
          action={
            <a className="ls-btn ls-btn--primary ls-btn--md" href="#/materials">
              <Icon name="upload" size={17} />
              <span>Add study material</span>
            </a>
          }
        />
      ) : (
        <GeneratorForm
          limits={config?.limits}
          materials={materials}
          busy={busy}
          setBusy={setBusy}
          onGenerated={(payload) => {
            setMeta({
              warnings: payload.warnings ?? [],
              fallback: payload.fallback ?? null,
              provenance: payload.provenance ?? null,
            });
            setActiveDeck(payload.deck);
            setError(null);
            notify(`Deck ready with ${payload.deck.cards.length} card${pluralise(payload.deck.cards.length, '', 's')}.`, 'success');
            loadDecks();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      )}

      {error ? <ErrorPanel error={error} title="Flashcard generation failed" onRetry={() => setError(null)} /> : null}

      <GenerationNotices meta={meta} />

      {activeDeck ? (
        <StudySession
          deck={activeDeck}
          saving={saving}
          onGraded={handleGraded}
          onExit={() => {
            setActiveDeck(null);
            setMeta(null);
            loadDecks();
          }}
        />
      ) : null}

      <Card
        title="Your decks"
        subtitle={decks.length ? `${decks.length} deck${pluralise(decks.length, '', 's')} · every answer cites its document and page` : 'No decks yet.'}
        actions={
          <Button variant="ghost" size="sm" icon="refresh" onClick={loadDecks}>
            Refresh
          </Button>
        }
      >
        {decksState === 'loading' ? (
          <LoadingPanel label="Loading decks" rows={2} />
        ) : decksState === 'error' ? (
          <Alert tone="warning" title="Could not load your decks">
            <p>The rest of the page still works.</p>
          </Alert>
        ) : decks.length === 0 ? (
          <p className="muted">Create a deck above and it will be listed here with your review history.</p>
        ) : (
          <ul className="row-list">
            {decks.map((deck) => (
              <li key={deck.id} className="row-list__item">
                <span className="row-list__icon">
                  <Icon name="cards" size={17} />
                </span>
                <div className="row-list__main">
                  <span className="row-list__title">{truncate(deck.title, 70)}</span>
                  <span className="row-list__meta">
                    {deck.cardCount} card{pluralise(deck.cardCount, '', 's')}
                    {' · '}
                    {deck.language === 'bn' ? 'বাংলা' : 'English'}
                    {' · '}
                    {deck.generationMode === 'live' ? 'model-written' : 'built locally'}
                    {deck.lastReviewedAt ? ` · reviewed ${formatRelative(deck.lastReviewedAt)}` : ' · not reviewed yet'}
                  </span>
                </div>
                <div className="row-list__side row-actions">
                  {deck.reviewedCards > 0 ? (
                    <Badge tone="accent" icon="target">
                      {deck.reviewedCards}/{deck.cardCount} seen
                    </Badge>
                  ) : null}
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="cards"
                    onClick={async () => {
                      try {
                        const data = await api.getFlashcardDeck(deck.id);
                        setMeta(null);
                        setActiveDeck(data.deck);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      } catch (err) {
                        notify(err.message, 'error');
                      }
                    }}
                  >
                    Study
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="trash"
                    aria-label={`Delete deck ${deck.title}`}
                    onClick={async () => {
                      const proceed = window.confirm(`Delete “${deck.title}” and its review history? This cannot be undone.`);
                      if (!proceed) return;
                      try {
                        await api.deleteFlashcardDeck(deck.id);
                        notify('Deck deleted.', 'success');
                        loadDecks();
                      } catch (err) {
                        notify(err.message, 'error');
                      }
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {decks.length > 0 ? (
        <div className="stat-row">
          <StatTile label="Decks" value={decks.length} icon="cards" />
          <StatTile
            label="Cards"
            value={decks.reduce((sum, d) => sum + d.cardCount, 0)}
            hint="Across all decks"
            icon="library"
          />
          <StatTile
            label="Rated again"
            value={decks.reduce((sum, d) => sum + (d.gradeTotals?.again ?? 0), 0)}
            hint="Cards to revisit first"
            icon="refresh"
          />
          <StatTile
            label="Rated easy"
            value={decks.reduce((sum, d) => sum + (d.gradeTotals?.easy ?? 0), 0)}
            hint="Cards you know well"
            icon="check"
          />
        </div>
      ) : null}

      <Alert tone="info" title="How flashcards stay honest">
        <p>
          Every card's answer is a sentence from your own documents, and each card shows the file and page it came
          from so you can check it. When your material does not contain enough to build a card, the deck is smaller —
          and the server says so — rather than padded with invented facts. In local mode no AI model is used at all.
        </p>
      </Alert>
    </div>
  );
}
