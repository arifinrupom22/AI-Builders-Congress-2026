/**
 * Practice quiz.
 *
 * The quiz payload from the server deliberately contains no answers, so the
 * results screen is the first moment a correct option or an explanation exists
 * in the browser. Skipped questions are scored as incorrect, which the UI says
 * out loud rather than hiding.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { formatPercent, formatRelative, pluralise, truncate } from '../lib/format.js';

const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

const STYLE_OPTIONS = [
  { id: 'mixed', label: 'Mixed — definitions plus source recognition' },
  { id: 'recall', label: 'Basic recall — definitions only' },
];

function GeneratorForm({
  limits,
  materials,
  onGenerated,
  onError,
  busy,
  setBusy,
  initialTopic = '',
  initialStyle = 'mixed',
  initialMaterials = [],
}) {
  const [topic, setTopic] = useState(initialTopic);
  const [count, setCount] = useState(5);
  const [style, setStyle] = useState(initialStyle === 'recall' ? 'recall' : 'mixed');
  const [language, setLanguage] = useState('auto');
  const [timeLimit, setTimeLimit] = useState('0');
  const [scope, setScope] = useState(() =>
    initialMaterials.filter((id) => materials.some((material) => material.id === id)),
  );

  const maxQuestions = limits?.maxQuizQuestions ?? 20;

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    onError(null);
    try {
      const result = await api.generateQuiz({
        topic: topic.trim(),
        questionCount: Number(count),
        materialIds: scope.length ? scope : null,
        language: language === 'auto' ? null : language,
        style,
        timeLimitMinutes: Number(timeLimit) > 0 ? Number(timeLimit) : null,
      });
      onGenerated(result);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Generate a quiz" subtitle="Questions are written from your indexed passages only.">
      <form className="quiz-form" onSubmit={submit}>
        <div className="quiz-form__row">
          <Field label="Topic focus" hint="Leave blank to cover the whole selection.">
            {({ id }) => (
              <input
                id={id}
                className="ls-input"
                type="text"
                value={topic}
                placeholder="e.g. cell respiration, chapter 4, Ohm's law"
                onChange={(e) => setTopic(e.target.value)}
              />
            )}
          </Field>
          <Field label="Questions">
            {({ id }) => (
              <select id={id} className="ls-input" value={count} onChange={(e) => setCount(e.target.value)}>
                {Array.from({ length: maxQuestions }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n} question{n === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
              label="Question style"
              hint={
                style === 'recall'
                  ? 'Every question asks what a concept in your material means. Built locally from definitions — no AI model is used for a recall drill.'
                  : 'Definitions plus recognising statements from your material.'
              }
            >
              {({ id }) => (
                <select id={id} className="ls-input" value={style} onChange={(e) => setStyle(e.target.value)}>
                  {STYLE_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Language" hint="By default the quiz is written in the language your material is written in.">
            {({ id }) => (
              <select id={id} className="ls-input" value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="auto">Follow the material</option>
                <option value="en">English</option>
                <option value="bn">বাংলা (Bangla)</option>
              </select>
            )}
          </Field>
          <Field
            label="Study timer"
            hint="Optional. A timer in this tab, not invigilation: the answers stay hidden until you submit, and a late submission is still scored normally."
          >
            {({ id }) => (
              <select id={id} className="ls-input" value={timeLimit} onChange={(e) => setTimeLimit(e.target.value)}>
                <option value="0">Untimed practice</option>
                <option value="5">5 minutes</option>
                <option value="10">10 minutes</option>
                <option value="15">15 minutes</option>
                <option value="20">20 minutes</option>
                <option value="30">30 minutes</option>
              </select>
            )}
          </Field>
        </div>

        <ScopePicker materials={materials} selected={scope} onChange={setScope} noun="documents" />

        <div className="quiz-form__actions">
          <Button type="submit" icon="sparkles" loading={busy}>
            Generate quiz
          </Button>
          <span className="muted-xs">
            If your material cannot support {count} questions, the server generates fewer rather than inventing facts.
          </span>
        </div>
      </form>
    </Card>
  );
}

/**
 * How a quiz was produced, stated plainly: fewer questions than requested, a
 * provider that could not be reached, and whether a model or the local
 * generator wrote the questions.
 */
function GenerationNotices({ meta, mode }) {
  const generationMode = meta?.generationMode ?? mode;
  return (
    <>
      {meta?.warnings?.length ? (
        <Alert tone="warning" title="Fewer questions than you asked for">
          <ul className="ls-list ls-list--compact">
            {meta.warnings.map((warning, i) => (
              <li key={warning.code ?? i}>{warning.message}</li>
            ))}
          </ul>
          <p className="muted-xs">Nothing is invented to make up the shortfall - that is deliberate.</p>
        </Alert>
      ) : null}

      {meta?.fallback ? (
        <Alert tone="warning" title="The AI provider could not be used">
          <p>
            {meta.fallback.message} These questions were written locally from your material instead, so the quiz
            still works.
          </p>
        </Alert>
      ) : null}

      {meta?.style === 'recall' ? (
        <Alert tone="info" title="Basic recall drill">
          <p>
            Every question asks what a concept in your material means. This drill is built locally from definitions in
            your documents; no AI model is used for it.
          </p>
        </Alert>
      ) : null}

      {meta?.provenance ? <p className="muted-xs">{meta.provenance}</p> : null}

      {generationMode ? (
        <p className="muted-xs">
          <Badge tone={generationMode === 'live' ? 'success' : 'neutral'} icon={generationMode === 'live' ? 'sparkles' : 'shield'}>
            {generationMode === 'live' ? 'Model-written questions' : 'Locally generated questions'}
          </Badge>
        </p>
      ) : null}
    </>
  );
}

const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

function QuizRunner({ quiz, onSubmit, submitting }) {
  const [answers, setAnswers] = useState(() => Array(quiz.questions.length).fill(null));
  const answeredCount = answers.filter((a) => a !== null).length;
  const limit = quiz.timeLimitSeconds ?? null;
  const [elapsed, setElapsed] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const sent = useRef(false);
  const answersRef = useRef(answers);
  answersRef.current = answers;

  const select = (index, optionIndex) => {
    setAnswers((list) => list.map((value, i) => (i === index ? optionIndex : value)));
  };

  // A tab-local timer. It pauses when this tab is closed; that is stated in the
  // UI rather than pretending it is an invigilated countdown.
  useEffect(() => {
    if (!limit) return undefined;
    const id = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(id);
  }, [limit]);

  const remaining = limit ? Math.max(0, limit - elapsed) : null;

  useEffect(() => {
    if (!limit) return;
    if (remaining === 60) setAnnouncement('One minute left on your study timer.');
    if (remaining === 10) setAnnouncement('Ten seconds left on your study timer.');
    if (remaining === 0 && !sent.current) {
      sent.current = true;
      setAnnouncement('Time is up. Your answers were submitted.');
      onSubmit(answersRef.current, elapsed, { auto: true });
    }
  }, [remaining, limit, elapsed, onSubmit]);

  const submitNow = () => {
    if (sent.current) return;
    sent.current = true;
    onSubmit(answers, elapsed, { auto: false });
  };

  return (
    <>
      <Card
        title={quiz.title}
        subtitle={`${quiz.questions.length} question${pluralise(quiz.questions.length, '', 's')} · generated ${formatRelative(quiz.createdAt)}`}
      >
        <div className="quiz-progress">
          <ProgressBar value={answeredCount} max={quiz.questions.length} label="Questions answered" />
          <span className="muted-xs">
            {answeredCount} of {quiz.questions.length} answered
          </span>
          {limit ? (
            <span className={`quiz-timer${remaining <= 60 ? ' quiz-timer--low' : ''}`} role="timer" aria-live="off">
              <Icon name="clock" size={14} /> {clock(remaining)} left of {clock(limit)}
            </span>
          ) : null}
        </div>
        {limit ? (
          <p className="muted-xs quiz-timer__note">
            The timer runs in this tab only and is a study aid, not invigilation. Answers stay hidden until you submit;
            submitting after the timer still scores normally and is labelled as over time.
          </p>
        ) : null}
        <span className="sr-only" role="status" aria-live="polite">
          {announcement}
        </span>

        <ol className="quiz-questions">
          {quiz.questions.map((question, index) => (
            <li key={question.id} className="quiz-question">
              <p className="quiz-question__prompt">
                <span className="quiz-question__number">{index + 1}</span>
                {question.prompt}
              </p>
              {question.sourceDocument ? (
                <p className="quiz-question__source">
                  from {question.sourceDocument}
                  {question.sourcePage ? ` · page ${question.sourcePage}` : ''}
                </p>
              ) : null}
              <div className="quiz-options">
                {question.options.map((option, optionIndex) => {
                  const checked = answers[index] === optionIndex;
                  return (
                    <label key={`${question.id}-${optionIndex}`} className={`quiz-option${checked ? ' is-selected' : ''}`}>
                      <input
                        type="radio"
                        name={question.id}
                        checked={checked}
                        onChange={() => select(index, optionIndex)}
                      />
                      <span className="quiz-option__letter">{OPTION_LETTERS[optionIndex] ?? optionIndex + 1}</span>
                      <span className="quiz-option__text">{option}</span>
                    </label>
                  );
                })}
              </div>
            </li>
          ))}
        </ol>

        <div className="quiz-submit">
          <Button
            icon="check"
            loading={submitting}
            onClick={() => {
              const unanswered = answers.filter((a) => a === null).length;
              if (unanswered > 0) {
                const proceed = window.confirm(
                  `${unanswered} question${unanswered === 1 ? ' is' : 's are'} unanswered. They will be scored as incorrect. Submit anyway?`,
                );
                if (!proceed) return;
              }
              submitNow();
            }}
          >
            Submit answers
          </Button>
          <span className="muted-xs">Skipped questions count as incorrect, the usual exam convention.</span>
        </div>
      </Card>
    </>
  );
}

const CONFIDENCE_CHOICES = [
  { id: 'guessed', label: 'I guessed' },
  { id: 'unsure', label: 'Unsure' },
  { id: 'confident', label: 'Confident' },
];

function GapSource({ source }) {
  if (!source?.documentName) return null;
  return (
    <p className="gap-source">
      <Icon name="quote" size={13} />
      <a href={`#/materials?id=${encodeURIComponent(source.materialId ?? '')}`}>
        {source.documentName}
        {source.pageNumber ? ` · page ${source.pageNumber}` : ''}
      </a>
    </p>
  );
}

/**
 * Concept-level feedback for one wrong answer.
 *
 * It is fetched only for a wrong answer the learner actually gave, and only
 * after the quiz was submitted. The server decides what the material supports:
 * a cited explanation and one follow-up question where it can, and an honest
 * "not enough evidence" with the passage to review where it cannot. Confidence
 * is optional and shown as context — it never changes the feedback.
 */
function KnowledgeGap({ quizId, item }) {
  const [open, setOpen] = useState(false);
  const [gap, setGap] = useState(null);
  const [state, setState] = useState('idle'); // idle | loading | ready | error
  const [error, setError] = useState(null);
  const [confidence, setConfidence] = useState(null);
  const [selected, setSelected] = useState(null);

  const load = useCallback(
    async (level) => {
      setState('loading');
      setError(null);
      try {
        const data = await api.diagnoseGap(quizId, { questionId: item.questionId, confidence: level ?? null });
        setGap(data.gap);
        setState('ready');
      } catch (err) {
        setError(err);
        setState('error');
      }
    },
    [quizId, item.questionId],
  );

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && state === 'idle') load(null);
  };

  const reportConfidence = (level) => {
    setConfidence(level);
    load(level);
  };

  return (
    <div className="gap">
      <button
        type="button"
        className="gap-toggle"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={`gap-${item.questionId}`}
      >
        <Icon name="target" size={15} />
        <span>Why did I miss this?</span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} />
      </button>

      {open ? (
        <div className="gap-panel" id={`gap-${item.questionId}`} role="region" aria-label="Knowledge gap feedback">
          {state === 'loading' && !gap ? (
            <p className="gap-note">Checking your material for this concept…</p>
          ) : null}

          {state === 'error' ? (
            <Alert tone="warning" title="Could not build gap feedback">
              <p>{error?.message ?? 'Try again in a moment.'}</p>
              <div className="row-actions">
                <Button variant="secondary" size="sm" icon="refresh" onClick={() => load(confidence)}>
                  Try again
                </Button>
              </div>
            </Alert>
          ) : null}

          {gap ? (
            <>
              <div className="gap-head">
                <span className="gap-eyebrow">Concept connected to this miss</span>
                <span className="gap-concept">{gap.concept}</span>
              </div>

              {gap.status === 'insufficient' ? (
                <Alert tone="warning" title="Not enough evidence to identify a cause">
                  <p>{gap.reason}</p>
                  {gap.review?.documentName ? (
                    <p>
                      <a
                        className="gap-link"
                        href={`#/materials?id=${encodeURIComponent(gap.review.materialId ?? '')}`}
                      >
                        <Icon name="file" size={14} /> Review {gap.review.documentName}
                        {gap.review.pageNumber ? ` · page ${gap.review.pageNumber}` : ''}
                      </a>
                    </p>
                  ) : null}
                </Alert>
              ) : (
                <>
                  <p className="gap-explanation">
                    <strong>From your material:</strong> {gap.explanation.text}
                  </p>
                  <GapSource source={gap.explanation.source} />

                  <div className="gap-diagnostic">
                    <span className="gap-eyebrow">One follow-up diagnostic question</span>
                    <p className="gap-prompt">{gap.diagnostic.prompt}</p>
                    <ul className="gap-options">
                      {gap.diagnostic.options.map((option, index) => {
                        const chosen = selected === index;
                        const isAnswer = index === gap.diagnostic.answerIndex;
                        const stateClass = chosen
                          ? isAnswer
                            ? 'is-correct'
                            : 'is-wrong'
                          : selected !== null && isAnswer
                            ? 'is-correct'
                            : '';
                        return (
                          <li key={`${item.questionId}-gap-${index}`}>
                            <button
                              type="button"
                              className={`gap-option ${stateClass}`.trim()}
                              aria-pressed={chosen}
                              onClick={() => setSelected(index)}
                            >
                              <span className="gap-option__letter">{OPTION_LETTERS[index] ?? index + 1}</span>
                              <span>{option}</span>
                              {selected !== null && isAnswer ? <Icon name="check" size={15} /> : null}
                              {chosen && !isAnswer ? <Icon name="close" size={15} /> : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    {selected !== null ? (
                      <p className="gap-answer-note">
                        <strong>{selected === gap.diagnostic.answerIndex ? 'Correct.' : 'Not quite.'}</strong>{' '}
                        {gap.diagnostic.explanation}
                      </p>
                    ) : (
                      <p className="gap-note">
                        Answer it to check yourself. This diagnostic is not scored and does not change your quiz result.
                      </p>
                    )}
                    <GapSource source={gap.diagnostic.source} />
                  </div>
                </>
              )}

              <div className="gap-context">
                <p className="gap-note">{gap.context.note}</p>
                <p className="gap-note">{gap.confidence.note}</p>
              </div>

              <div className="gap-confidence">
                <span className="gap-eyebrow">How confident were you in your answer? (optional)</span>
                <div className="row-actions">
                  {CONFIDENCE_CHOICES.map((choice) => (
                    <button
                      key={choice.id}
                      type="button"
                      className={`gap-confidence__choice${confidence === choice.id ? ' is-active' : ''}`}
                      aria-pressed={confidence === choice.id}
                      onClick={() => reportConfidence(choice.id)}
                    >
                      {choice.label}
                    </button>
                  ))}
                  {confidence ? (
                    <button
                      type="button"
                      className="gap-confidence__choice"
                      onClick={() => reportConfidence(null)}
                    >
                      Prefer not to say
                    </button>
                  ) : null}
                </div>
                <p className="gap-note">
                  Confidence is kept as context only. It is never treated as proof of a misconception.
                </p>
              </div>

              <p className="gap-note gap-disclaimer">{gap.disclaimer}</p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Results({ quiz, result, onRetake, onNew }) {
  const { score, results, topics, retryAdvice, scoringNote, timing } = result;
  const minutes = timing?.elapsedSeconds != null ? clock(timing.elapsedSeconds) : null;
  const tone = score.percent >= 80 ? 'success' : score.percent >= 50 ? 'warning' : 'danger';

  return (
    <>
      <Card title="Your result" className="quiz-result">
        <div className="quiz-score">
          <div className={`quiz-score__ring quiz-score__ring--${tone}`}>
            <span className="quiz-score__value">{score.percent}%</span>
            <span className="quiz-score__label">
              {score.correctCount} of {score.total}
            </span>
          </div>
          <div className="quiz-score__body">
            <p className="quiz-score__headline">
              You answered {score.correctCount} of {score.total} correctly
              {score.answeredCount < score.total ? `, and left ${score.total - score.answeredCount} blank` : ''}.
            </p>
            <p className="muted-xs">{scoringNote}</p>
            {timing?.timeLimitSeconds ? (
              <p className="muted-xs">
                Study timer: you used {minutes ?? 'an unknown time'} of the {clock(timing.timeLimitSeconds)} limit.
                {timing.overLimit
                  ? ' That is over the limit you set; the score is unaffected and this quiz was not invigilated.'
                  : ' The timer never affects the score.'}
              </p>
            ) : null}
            <p className="quiz-score__advice">{retryAdvice}</p>
            <div className="row-actions">
              <Button variant="secondary" icon="refresh" onClick={onRetake}>
                Retake this quiz
              </Button>
              <Button icon="sparkles" onClick={onNew}>
                Generate a new quiz
              </Button>
            </div>
          </div>
        </div>

        {topics?.length ? (
          <div className="topic-list topic-list--tight">
            {topics.map((topic) => (
              <div key={topic.topic} className="topic-list__item">
                <div className="topic-list__head">
                  <span className="topic-list__name">{truncate(topic.topic, 80)}</span>
                  <Badge tone={topic.accuracy >= 80 ? 'success' : topic.accuracy >= 50 ? 'warning' : 'danger'}>
                    {topic.correct}/{topic.total}
                  </Badge>
                </div>
                <ProgressBar value={topic.accuracy} tone={topic.accuracy >= 80 ? 'success' : topic.accuracy >= 50 ? 'warning' : 'danger'} />
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      <Card title="Answer review" subtitle={`Quiz: ${quiz.title}`}>
        <ol className="review-list">
          {results.map((item, index) => {
            const outcome = item.skipped ? 'skipped' : item.correct ? 'correct' : 'wrong';
            return (
              <li key={item.questionId} className={`review review--${outcome}`}>
                <div className="review__head">
                  <span className="review__number">{index + 1}</span>
                  <span className="review__prompt">{item.prompt}</span>
                  <Badge tone={item.correct ? 'success' : item.skipped ? 'neutral' : 'danger'}>
                    {item.correct ? 'Correct' : item.skipped ? 'Skipped' : 'Incorrect'}
                  </Badge>
                </div>

                <ul className="review__options">
                  {item.options.map((option, optionIndex) => {
                    const isCorrect = optionIndex === item.correctIndex;
                    const isChosen = optionIndex === item.selectedIndex;
                    const state = isCorrect ? 'is-correct' : isChosen ? 'is-wrong' : '';
                    return (
                      <li key={`${item.questionId}-${optionIndex}`} className={`review__option ${state}`.trim()}>
                        <span className="review__letter">{OPTION_LETTERS[optionIndex] ?? optionIndex + 1}</span>
                        <span>{option}</span>
                        {isCorrect ? <Icon name="check" size={15} /> : null}
                        {isChosen && !isCorrect ? <Icon name="close" size={15} /> : null}
                      </li>
                    );
                  })}
                </ul>

                {item.explanation ? (
                  <p className="review__explanation">
                    <strong>Why:</strong> {item.explanation}
                  </p>
                ) : null}
                {item.source?.documentName ? (
                  <p className="review__source">
                    Source: {item.source.documentName}
                    {item.source.pageNumber ? ` · page ${item.source.pageNumber}` : ''}
                    {item.source.heading ? ` · ${truncate(item.source.heading, 70)}` : ''}
                  </p>
                ) : null}

                {/* Only a wrong answer the learner actually gave can open this. */}
                {outcome === 'wrong' ? <KnowledgeGap quizId={quiz.id} item={item} /> : null}
              </li>
            );
          })}
        </ol>
      </Card>
    </>
  );
}

export default function QuizPage({ route }) {
  const { materials, config, notify, learnerId } = useApp();
  const [quiz, setQuiz] = useState(null);
  const [meta, setMeta] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyState, setHistoryState] = useState('loading');

  const loadHistory = useCallback(async () => {
    setHistoryState('loading');
    try {
      const data = await api.listQuizzes();
      setHistory(data.quizzes ?? []);
      setHistoryState('ready');
    } catch {
      setHistoryState('error');
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory, learnerId]);

  const readyMaterials = materials.filter((m) => m.status === 'ready');

  return (
    <div className="page">
      {readyMaterials.length === 0 ? (
        <EmptyState
          icon="library"
          title="Nothing to quiz you on yet"
          description="Practice questions are written from your indexed passages, so upload a study material first."
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
          // A link like #/quiz?topic=<concept> pre-fills the focus, which is
          // how the Visual Study Studio offers "practise this concept".
          initialTopic={route?.params?.get('topic') ?? ''}
          initialStyle={route?.params?.get('style') ?? 'mixed'}
          // A coach link may narrow the quiz to the documents it was recorded
          // from, so its suggestion stays on the concept it named.
          initialMaterials={(route?.params?.get('materials') ?? '').split(',').filter(Boolean)}
          onError={setError}
          onGenerated={(payload) => {
            setQuiz(payload.quiz);
            setMeta({
              warnings: payload.warnings ?? [],
              fallback: payload.fallback ?? null,
              provenance: payload.provenance ?? null,
              generationMode: payload.generationMode ?? null,
              style: payload.style ?? payload.quiz.style ?? 'mixed',
            });
            setResult(null);
            setError(null);
            const total = payload.quiz.questions.length;
            notify(`Generated ${total} question${pluralise(total, '', 's')} — good luck.`, 'success');
            loadHistory();
          }}
        />
      )}

      {error ? (
        <ErrorPanel
          error={error}
          title="Quiz generation failed"
          hint={
            error.status === 422
              ? 'Try a different topic, a smaller question count, or upload more of the relevant chapter. Nothing is invented to fill the gap.'
              : null
          }
          onRetry={() => setError(null)}
        />
      ) : null}

      <GenerationNotices meta={meta} mode={quiz?.generationMode} />

      {quiz && !result ? (
        <QuizRunner
          quiz={quiz}
          submitting={submitting}
          onSubmit={async (answers, elapsedSeconds, { auto = false } = {}) => {
            setSubmitting(true);
            try {
              const payload = await api.submitQuiz(quiz.id, answers, elapsedSeconds);
              setResult(payload);
              loadHistory();
              notify(
                auto
                  ? `Time up — submitted automatically. Scored ${payload.score.percent}%`
                  : `Scored ${payload.score.percent}%`,
                payload.score.percent >= 50 ? 'success' : 'warning',
              );
            } catch (err) {
              notify(err.message, 'error');
              setError(err);
            } finally {
              setSubmitting(false);
            }
          }}
        />
      ) : null}

      {quiz && result ? (
        <Results
          quiz={quiz}
          result={result}
          onRetake={() => setResult(null)}
          onNew={() => {
            setQuiz(null);
            setResult(null);
            setMeta(null);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      ) : null}

      <Card
        title="Quiz history"
        subtitle={history.length ? `${history.length} generated` : 'No quizzes generated yet.'}
        actions={
          <Button variant="ghost" size="sm" icon="refresh" onClick={loadHistory}>
            Refresh
          </Button>
        }
      >
        {historyState === 'loading' ? (
          <LoadingPanel label="Loading quiz history" rows={2} />
        ) : historyState === 'error' ? (
          <Alert tone="warning" title="Could not load quiz history">
            <p>The rest of the page still works.</p>
          </Alert>
        ) : history.length === 0 ? (
          <p className="muted">Generate a quiz and it will be listed here with your best score.</p>
        ) : (
          <ul className="row-list">
            {history.map((entry) => (
              <li key={entry.id} className="row-list__item">
                <div className="row-list__main">
                  <span className="row-list__title">{truncate(entry.title, 70)}</span>
                  <span className="row-list__meta">
                    {entry.questionCount} question{pluralise(entry.questionCount, '', 's')} · {entry.generationMode === 'live' ? 'model-generated' : 'local generation'}
                    {' · '}
                    {formatRelative(entry.createdAt)}
                    {entry.attempts.length ? ` · ${entry.attempts.length} attempt${pluralise(entry.attempts.length, '', 's')}` : ''}
                  </span>
                </div>
                <div className="row-list__side row-actions">
                  {entry.bestPercent !== null && entry.bestPercent !== undefined ? (
                    <Badge tone={entry.bestPercent >= 80 ? 'success' : entry.bestPercent >= 50 ? 'warning' : 'danger'}>
                      best {formatPercent(entry.bestPercent)}
                    </Badge>
                  ) : null}
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="quiz"
                    onClick={async () => {
                      try {
                        const data = await api.getQuiz(entry.id);
                        setQuiz(data.quiz);
                        setMeta(null);
                        setResult(null);
                        setError(null);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      } catch (err) {
                        notify(err.message, 'error');
                      }
                    }}
                  >
                    {entry.attempts.length ? 'Retake' : 'Take'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {history.length > 0 ? (
        <div className="stat-row">
          <StatTile label="Quizzes generated" value={history.length} icon="sparkles" />
          <StatTile
            label="Attempts"
            value={history.reduce((sum, q) => sum + q.attempts.length, 0)}
            hint="Every attempt is stored locally"
            icon="quiz"
          />
          <StatTile
            label="Questions available"
            value={history.reduce((sum, q) => sum + q.questionCount, 0)}
            hint="Across all generated quizzes"
            icon="target"
          />
        </div>
      ) : null}
    </div>
  );
}
