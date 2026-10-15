/**
 * Practice quiz.
 *
 * The quiz payload from the server deliberately contains no answers, so the
 * results screen is the first moment a correct option or an explanation exists
 * in the browser. Skipped questions are scored as incorrect, which the UI says
 * out loud rather than hiding.
 */
import { useCallback, useEffect, useState } from 'react';
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

function GeneratorForm({ limits, materials, onGenerated, onError, busy, setBusy }) {
  const [topic, setTopic] = useState('');
  const [count, setCount] = useState(5);
  const [language, setLanguage] = useState('auto');
  const [scope, setScope] = useState([]);

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
          <Field label="Language" hint="By default the quiz is written in the language your material is written in.">
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

function QuizRunner({ quiz, onSubmit, submitting }) {
  const [answers, setAnswers] = useState(() => Array(quiz.questions.length).fill(null));
  const answeredCount = answers.filter((a) => a !== null).length;

  const select = (index, optionIndex) => {
    setAnswers((list) => list.map((value, i) => (i === index ? optionIndex : value)));
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
        </div>

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
              onSubmit(answers);
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

function Results({ quiz, result, onRetake, onNew }) {
  const { score, results, topics, retryAdvice, scoringNote } = result;
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
              </li>
            );
          })}
        </ol>
      </Card>
    </>
  );
}

export default function QuizPage() {
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
          onError={setError}
          onGenerated={(payload) => {
            setQuiz(payload.quiz);
            setMeta({
              warnings: payload.warnings ?? [],
              fallback: payload.fallback ?? null,
              provenance: payload.provenance ?? null,
              generationMode: payload.generationMode ?? null,
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
          onSubmit={async (answers) => {
            setSubmitting(true);
            try {
              const payload = await api.submitQuiz(quiz.id, answers);
              setResult(payload);
              loadHistory();
              notify(`Scored ${payload.score.percent}%`, payload.score.percent >= 50 ? 'success' : 'warning');
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
