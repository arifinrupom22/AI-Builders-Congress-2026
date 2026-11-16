/**
 * Guided learning path — one topic, broken into short steps you can walk
 * through in order, or drop back into at any point.
 *
 * Every step carries the five parts the server built: the prerequisite the
 * material states, a simple explanation, a Visual Study Studio picture when the
 * material supports one, a worked example, and a short recall question. Each
 * part shows the exact passage it came from, and a part the material does not
 * carry says "not covered in your material" instead of inventing text.
 *
 * Completion is the learner's own record of where they are. Nothing here is
 * scored, and nothing is sent anywhere to be graded.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../store/AppContext.jsx';
import { useRoute, navigate, hrefTo } from '../lib/router.jsx';
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
  SourceCard,
} from '../components/ui.jsx';
import { VisualCanvas, DetailPanel, resolvePart } from './studio.jsx';
import { formatDate, pluralise } from '../lib/format.js';

/** The exact phrase the server uses for a gap, so the UI can mirror it. */
const NOT_COVERED = 'not covered in your material';

const SIGNAL_LABELS = [
  ['recurringTerms', 'recurring terms'],
  ['sentencesScanned', 'usable sentences'],
  ['relationsBetweenTerms', 'stated connections between terms'],
  ['sequenceSentences', 'ordered-step sentences'],
  ['datedSentences', 'dated sentences'],
  ['comparisonSentences', 'contrast sentences'],
];

/**
 * The server prefixes a gap with what kind of part it is ("Prerequisite not
 * covered in your material: ..."). The label already says the kind, so show
 * only the detail after the fixed phrase.
 */
function gapDetail(note) {
  const text = String(note ?? '').trim();
  const at = text.toLowerCase().indexOf(NOT_COVERED);
  if (at === -1) return text;
  return text.slice(at + NOT_COVERED.length).replace(/^[\s:.-]+/, '');
}

/** Compact source chips for one part's citations. */
function PartSources({ ids, citations }) {
  const found = (ids ?? []).map((id) => citations.find((c) => c.id === id)).filter(Boolean);
  if (found.length === 0) return null;
  return (
    <ul className="path-cites">
      {found.map((citation) => (
        <li key={`${citation.id}-${citation.passageId}`}>
          <a
            className="path-cite"
            href={hrefTo('/materials', { id: citation.materialId })}
            title={citation.snippet}
          >
            <Icon name="quote" size={12} />
            <span>
              [{citation.id}] {citation.documentName} · p. {citation.pageNumber}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** A plain text part: a gap states itself, a covered part quotes the source. */
function PartBlock({ label, icon, part, citations, children }) {
  if (!part) return null;
  return (
    <div className={`path-part${part.covered ? '' : ' path-part--gap'}`}>
      <p className="path-part__label">
        <Icon name={icon} size={14} />
        <span>{label}</span>
      </p>
      {part.covered ? (
        <>
          {part.concept ? (
            <p className="path-part__concept">
              Builds on <strong>{part.concept}</strong>
            </p>
          ) : null}
          <p className="path-part__text">{part.text}</p>
          <PartSources ids={part.sourceIds} citations={citations} />
        </>
      ) : (
        <p className="path-part__gap">
          <span className="path-gap">{NOT_COVERED}</span>
          {gapDetail(part.note) ? <span className="path-part__note">{gapDetail(part.note)}</span> : null}
        </p>
      )}
      {children}
    </div>
  );
}

/** The recall question hides its answer until the learner asks for it. */
function RecallBlock({ question, citations, revealed, onReveal }) {
  if (!question) return null;
  if (!question.covered) {
    return (
      <div className="path-part path-part--gap">
        <p className="path-part__label">
          <Icon name="lightbulb" size={14} />
          <span>Recall question</span>
        </p>
        <p className="path-part__gap">
          <span className="path-gap">{NOT_COVERED}</span>
          {gapDetail(question.note) ? <span className="path-part__note">{gapDetail(question.note)}</span> : null}
        </p>
      </div>
    );
  }
  return (
    <div className="path-part">
      <p className="path-part__label">
        <Icon name="lightbulb" size={14} />
        <span>Recall question</span>
      </p>
      <p className="path-part__question">{question.prompt}</p>
      {revealed ? (
        <div className="path-answer">
          <p className="path-part__eyebrow">Answer</p>
          <p className="path-part__text">{question.answer}</p>
          <PartSources ids={question.sourceIds} citations={citations} />
        </div>
      ) : (
        <div className="row-actions">
          <Button variant="secondary" size="sm" icon="eye" onClick={onReveal}>
            Show the answer
          </Button>
          <span className="muted-xs">Say it out loud first — the answer comes straight from your material.</span>
        </div>
      )}
    </div>
  );
}

/** The step's studio picture, built on demand and then stored on the path. */
function VisualBlock({ step, busy, onBuild, partKey, onSelect }) {
  const support = step.visual;
  if (!support) return null;

  if (!support.supported) {
    return (
      <div className="path-part path-part--gap">
        <p className="path-part__label">
          <Icon name="sitemap" size={14} />
          <span>Visual</span>
        </p>
        <p className="path-part__gap">
          <span className="path-gap">no visual built</span>
          <span className="path-part__note">{support.reason}</span>
        </p>
      </div>
    );
  }

  if (!support.visual) {
    return (
      <div className="path-part">
        <p className="path-part__label">
          <Icon name="sitemap" size={14} />
          <span>Visual · {support.label}</span>
        </p>
        <p className="path-part__text">
          The passages for this step carry enough structure for a {String(support.label ?? '').toLowerCase()}. Build it
          here — it comes from the Visual Study Studio, with the same citations and the same honesty rules.
        </p>
        <div className="row-actions">
          <Button variant="secondary" size="sm" icon="eye" loading={busy} disabled={busy} onClick={onBuild}>
            Build this visual
          </Button>
        </div>
      </div>
    );
  }

  const visualCitations = support.citations ?? [];
  return (
    <div className="path-part">
      <p className="path-part__label">
        <Icon name="sitemap" size={14} />
        <span>Visual · {support.label}</span>
      </p>
      <div className="viz-layout path-viz">
        <div className="viz-layout__canvas">
          <VisualCanvas visual={support.visual} selected={partKey} onSelect={onSelect} />
        </div>
        <aside className="viz-layout__panel">
          <DetailPanel
            part={resolvePart(support.visual, partKey)}
            citations={visualCitations}
            kindLabel={support.label}
            onClose={() => onSelect(null)}
          />
        </aside>
      </div>
      <details className="viz-text">
        <summary>
          <Icon name="file" size={14} /> Accessible text version of this visual
        </summary>
        <pre className="viz-text__body">{support.visual.textVersion}</pre>
      </details>
    </div>
  );
}

function PathStep({
  step,
  index,
  total,
  citations,
  expanded,
  onToggle,
  answerRevealed,
  onReveal,
  onToggleComplete,
  completing,
  onBuildVisual,
  visualBusy,
  partKey,
  onSelectPart,
  onContinue,
}) {
  return (
    <li className={`path-step${step.completed ? ' path-step--done' : ''}${expanded ? ' path-step--open' : ''}`}>
      <button type="button" className="path-step__head" onClick={onToggle} aria-expanded={expanded}>
        <span className="path-step__index" aria-hidden="true">
          {step.completed ? <Icon name="check" size={14} /> : index + 1}
        </span>
        <span className="path-step__heading">
          <span className="path-step__title">{step.title}</span>
          <span className="path-step__meta">
            Step {index + 1} of {total} · {step.sourceIds.length} source
            {pluralise(step.sourceIds.length, '', 's')}
          </span>
        </span>
        <span className="path-step__state">
          {step.completed ? (
            <Badge tone="success" icon="check">
              Completed
            </Badge>
          ) : null}
        </span>
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={16} className="path-step__chevron" />
      </button>

      {expanded ? (
        <div className="path-step__body">
          <PartBlock label="Prerequisite" icon="flag" part={step.prerequisite} citations={citations} />
          <PartBlock label="Explanation" icon="lightbulb" part={step.explanation} citations={citations} />
          <VisualBlock
            step={step}
            busy={visualBusy}
            onBuild={onBuildVisual}
            partKey={partKey}
            onSelect={onSelectPart}
          />
          <PartBlock label="Worked example" icon="quote" part={step.example} citations={citations} />
          <RecallBlock
            question={step.question}
            citations={citations}
            revealed={answerRevealed}
            onReveal={onReveal}
          />

          <div className="path-step__actions">
            <Button
              variant={step.completed ? 'secondary' : 'primary'}
              size="sm"
              icon="check"
              loading={completing}
              onClick={() => onToggleComplete(!step.completed)}
            >
              {step.completed ? 'Mark as not done' : 'Mark this step complete'}
            </Button>
            {index < total - 1 ? (
              <Button variant="secondary" size="sm" iconRight="chevronRight" onClick={onContinue}>
                Continue to step {index + 2}
              </Button>
            ) : step.completed ? (
              <span className="muted-xs">That was the last step of this path.</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export default function LearningPathPage() {
  const { materials, materialsState, notify } = useApp();
  const route = useRoute();
  const urlId = route.params.get('id');

  const ready = useMemo(() => materials.filter((m) => m.status === 'ready'), [materials]);

  const [scope, setScope] = useState(() => {
    const fromUrl = route.params.get('ids');
    return fromUrl ? fromUrl.split(',').filter(Boolean) : [];
  });
  const [topic, setTopic] = useState('');
  const [record, setRecord] = useState(null);
  const [state, setState] = useState('idle'); // idle | loading
  const [refusal, setRefusal] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState([]);
  const [savedState, setSavedState] = useState('loading');

  const [openStepId, setOpenStepId] = useState(null);
  const [revealed, setRevealed] = useState({}); // stepId -> true
  const [completing, setCompleting] = useState(null); // stepId
  const [visualBusy, setVisualBusy] = useState(null); // stepId
  const [partKeys, setPartKeys] = useState({}); // stepId -> part key

  const firstOpenStep = (path) =>
    path.steps.find((step) => !step.completed)?.id ?? path.steps[0]?.id ?? null;

  const loadSaved = useCallback(async () => {
    setSavedState('loading');
    try {
      const data = await api.listPaths();
      setSaved(data.paths ?? []);
      setSavedState('ready');
    } catch {
      setSavedState('error');
    }
  }, []);

  useEffect(() => {
    loadSaved();
  }, [loadSaved]);

  // A link like #/path?id=<uuid> reopens a saved path where it was left.
  useEffect(() => {
    if (!urlId) return undefined;
    let cancelled = false;
    setError(null);
    api
      .getPath(urlId)
      .then((data) => {
        if (cancelled) return;
        setRecord(data.path);
        setOpenStepId(firstOpenStep(data.path));
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [urlId]);

  const generate = useCallback(async () => {
    setState('loading');
    setRefusal(null);
    setError(null);
    try {
      const data = await api.generatePath({
        topic: topic.trim(),
        materialIds: scope.length ? scope : null,
      });
      setRecord(data.path);
      setOpenStepId(firstOpenStep(data.path));
      setRevealed({});
      setPartKeys({});
      setState('idle');
      loadSaved();
    } catch (err) {
      setState('idle');
      if (err?.status === 422) setRefusal(err);
      else setError(err);
    }
  }, [topic, scope, loadSaved]);

  const openSaved = useCallback(async (id) => {
    setState('loading');
    setRefusal(null);
    setError(null);
    try {
      const data = await api.getPath(id);
      setRecord(data.path);
      setOpenStepId(firstOpenStep(data.path));
      setRevealed({});
      setPartKeys({});
    } catch (err) {
      setError(err);
    } finally {
      setState('idle');
    }
  }, []);

  const removeSaved = useCallback(
    async (id) => {
      try {
        await api.deletePath(id);
        setSaved((list) => list.filter((item) => item.id !== id));
        if (record?.id === id) {
          setRecord(null);
          setOpenStepId(null);
        }
        notify('Learning path deleted', 'success');
      } catch (err) {
        notify(err.message, 'error');
      }
    },
    [record, notify],
  );

  const toggleComplete = useCallback(
    async (stepId, completed) => {
      if (!record) return;
      setCompleting(stepId);
      try {
        const data = await api.setStepCompleted(record.id, stepId, completed);
        setRecord(data.path);
        setSaved((list) =>
          list.map((item) =>
            item.id === data.path.id
              ? { ...item, completed: data.path.steps.filter((s) => s.completed).length }
              : item,
          ),
        );
      } catch (err) {
        notify(err.message, 'error');
      } finally {
        setCompleting(null);
      }
    },
    [record, notify],
  );

  const buildVisual = useCallback(
    async (stepId) => {
      if (!record) return;
      setVisualBusy(stepId);
      try {
        const data = await api.generateStepVisual(record.id, stepId);
        setRecord((current) => ({
          ...current,
          steps: current.steps.map((step) => (step.id === stepId ? { ...step, visual: data.visual } : step)),
        }));
      } catch (err) {
        notify(err.message, 'error');
      } finally {
        setVisualBusy(null);
      }
    },
    [record, notify],
  );

  const copyText = useCallback(async () => {
    if (!record?.textVersion) return;
    try {
      await navigator.clipboard.writeText(record.textVersion);
      notify('Text version copied to the clipboard', 'success');
    } catch {
      notify('Your browser blocked clipboard access.', 'error');
    }
  }, [record, notify]);

  const counters = useMemo(() => {
    if (!record) return { total: 0, completed: 0 };
    return {
      total: record.steps.length,
      completed: record.steps.filter((step) => step.completed).length,
    };
  }, [record]);

  const kindLabelOf = (item) => (item === 'live' ? 'Live model' : 'Local extractive');

  if (materialsState !== 'loading' && ready.length === 0) {
    return (
      <div className="page">
        <EmptyState
          icon="route"
          title="Nothing to learn a path from yet"
          description="A learning path is built only from your own indexed material — every step quotes the passage it came from. Upload a chapter, notes or a lecture PDF first."
          action={
            <Button icon="upload" onClick={() => navigate('/materials')}>
              Go to My Materials
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="page">
      <Card
        title="What do you want to learn?"
        subtitle="Pick one narrow topic. The path is built from your indexed material and breaks it into short, ordered steps — and where the material is silent, the step says so instead of guessing."
      >
        <div className="stack-sm">
          <ScopePicker materials={materials} selected={scope} onChange={setScope} noun="documents" verb="Building from" />

          <Field label="Topic" hint="One concept works best — e.g. photosynthesis, recursion, the Calvin cycle. Leave it blank to work through the whole selection in source order.">
            {({ id, ...aria }) => (
              <input
                id={id}
                {...aria}
                className="ls-input"
                type="text"
                maxLength={300}
                value={topic}
                placeholder="e.g. photosynthesis, recursion, chapter 4"
                onChange={(e) => setTopic(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    generate();
                  }
                }}
              />
            )}
          </Field>

          <div className="row-actions">
            <Button icon="route" loading={state === 'loading'} disabled={state === 'loading'} onClick={generate}>
              {record ? 'Build another path' : 'Build my learning path'}
            </Button>
            <span className="muted-xs">
              {scope.length > 0
                ? `${scope.length} document${pluralise(scope.length, '', 's')} selected`
                : `Using all ${ready.length} ready document${pluralise(ready.length, '', 's')}`}
            </span>
          </div>
        </div>

        {state === 'loading' ? <LoadingPanel label="Reading your material and ordering the steps" rows={4} /> : null}

        {error ? <ErrorPanel error={error} title="Could not build the learning path" onRetry={generate} /> : null}

        {refusal ? (
          <Alert tone="warning" title="Your material cannot support that path yet">
            <p>{refusal.message}</p>
            {refusal.details?.found ? (
              <details className="viz-signals">
                <summary>What was actually found in your text</summary>
                <ul className="viz-signals__list">
                  {SIGNAL_LABELS.map(([key, label]) => (
                    <li key={key}>
                      <strong>{refusal.details.found[key] ?? 0}</strong> {label}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <p>
              Nothing was invented to fill the gap. Try a broader topic, select more documents, or ask the{' '}
              <a href="#/chat">AI Teacher</a> about it instead.
            </p>
            {refusal.requestId ? <p className="muted-xs">Request id: {refusal.requestId}</p> : null}
          </Alert>
        ) : null}
      </Card>

      {record ? (
        <Card
          className="path-record"
          title={record.topic}
          subtitle={`${counters.completed} of ${counters.total} step${pluralise(counters.total, '', 's')} completed · ${
            record.citations?.length ?? 0
          } citation${pluralise(record.citations?.length ?? 0, '', 's')} · ${
            record.stats?.documents?.length ?? 0
          } document${pluralise(record.stats?.documents?.length ?? 0, '', 's')}`}
          actions={
            <div className="row-actions">
              <Badge
                tone={record.generationMode === 'live' ? 'success' : 'neutral'}
                icon={record.generationMode === 'live' ? 'sparkles' : 'shield'}
              >
                {kindLabelOf(record.generationMode)}
              </Badge>
              <Button
                variant="danger"
                size="sm"
                icon="trash"
                onClick={() => removeSaved(record.id)}
                title={`Delete “${record.topic}”`}
              >
                Delete
              </Button>
            </div>
          }
        >
          <div className="stack-sm">
            {record.warnings?.map((warning, index) => (
              <Alert key={index} tone="warning" title="Worth knowing">
                <p>{typeof warning === 'string' ? warning : warning.message}</p>
              </Alert>
            ))}

            <ProgressBar
              label={`${counters.completed} of ${counters.total} steps completed`}
              value={counters.completed}
              max={counters.total}
            />

            <ol className="path-steps">
              {record.steps.map((step, index) => (
                <PathStep
                  key={step.id}
                  step={step}
                  index={index}
                  total={counters.total}
                  citations={record.citations ?? []}
                  expanded={openStepId === step.id}
                  onToggle={() => setOpenStepId(openStepId === step.id ? null : step.id)}
                  answerRevealed={Boolean(revealed[step.id])}
                  onReveal={() => setRevealed((current) => ({ ...current, [step.id]: true }))}
                  onToggleComplete={(completed) => toggleComplete(step.id, completed)}
                  completing={completing === step.id}
                  onBuildVisual={() => buildVisual(step.id)}
                  visualBusy={visualBusy === step.id}
                  partKey={partKeys[step.id] ?? null}
                  onSelectPart={(key) => setPartKeys((current) => ({ ...current, [step.id]: key }))}
                  onContinue={() => {
                    setOpenStepId(record.steps[index + 1]?.id ?? step.id);
                  }}
                />
              ))}
            </ol>

            <details className="viz-text">
              <summary>
                <Icon name="file" size={14} /> Accessible text version of this path
              </summary>
              <p className="muted-xs">
                The whole path as plain text — for screen readers, notes, or a small screen. Gaps are written out in
                words.
              </p>
              <pre className="viz-text__body">{record.textVersion}</pre>
              <div className="row-actions">
                <Button variant="secondary" size="sm" icon="quote" onClick={copyText}>
                  Copy text version
                </Button>
              </div>
            </details>

            {record.citations?.length ? (
              <>
                <h3 className="subhead">Every source this path cites</h3>
                <div className="source-list">
                  {record.citations.map((citation) => (
                    <SourceCard
                      key={`${citation.id}-${citation.passageId}`}
                      citation={citation}
                      onInspect={() => navigate(`/materials?id=${encodeURIComponent(citation.materialId)}`)}
                    />
                  ))}
                </div>
              </>
            ) : null}

            <p className="muted-xs provenance">{record.provenance}</p>
          </div>
        </Card>
      ) : null}

      {!record && state === 'idle' && !refusal && !error ? (
        <Alert tone="info" title="How a path stays honest">
          <p>
            Steps are earned from your text, not filled in around it. Each one quotes the passage behind its
            prerequisite, explanation and example, and a part your material does not cover says{' '}
            <strong>{NOT_COVERED}</strong> — a path with a named gap is more useful than one with an invented fact.
          </p>
        </Alert>
      ) : null}

      {savedState === 'loading' ? <LoadingPanel label="Loading your saved paths" rows={2} /> : null}

      {savedState === 'ready' && saved.length > 0 ? (
        <Card title="Saved paths" subtitle="Stored with their citations and your progress — reopen one any time.">
          <ul className="material-list material-list--compact">
            {saved.map((item) => (
              <li key={item.id} className="material-row">
                <span className="material-row__icon">
                  <Icon name="route" size={16} />
                </span>
                <div className="material-row__main">
                  <div className="material-row__title-row">
                    <span className="material-row__name" title={item.topic}>
                      {item.topic}
                    </span>
                    <Badge tone={item.completed >= item.steps ? 'success' : 'neutral'}>
                      {item.completed}/{item.steps} done
                    </Badge>
                  </div>
                  <div className="material-row__meta">
                    <span>
                      {item.steps} step{pluralise(item.steps, '', 's')} · {item.citations} citation
                      {pluralise(item.citations, '', 's')}
                    </span>
                    <span>{formatDate(item.updatedAt ?? item.createdAt, { withTime: false })}</span>
                  </div>
                </div>
                <div className="material-row__actions">
                  <Button variant="secondary" size="sm" icon="eye" onClick={() => openSaved(item.id)}>
                    Open
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    icon="trash"
                    onClick={() => removeSaved(item.id)}
                    title={`Delete “${item.topic}”`}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
