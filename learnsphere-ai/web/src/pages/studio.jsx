/**
 * Visual Study Studio — one source-grounded picture at a time.
 *
 * The server decides which visual the material can support (concept map,
 * flowchart, comparison table or timeline) and refuses honestly when none is
 * earned. This page's job is to draw what came back, keep every part
 * clickable down to the passage it cites, and offer the two natural next
 * steps: ask the AI Teacher about it, or practise it.
 *
 * Every renderer is plain DOM (buttons, lists, a real table) so it stays
 * readable on a phone, keyboard-navigable, and compatible with the text
 * version the server generates for screen readers.
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
  SourceCard,
} from '../components/ui.jsx';
import { formatDate, pluralise } from '../lib/format.js';

/** Fallback before /meta/options answers, so the form never flashes empty. */
const FALLBACK_KINDS = [
  { id: 'auto', label: 'Let the material choose', description: 'The server picks the visual your material can actually support.' },
  { id: 'concept-map', label: 'Concept map', description: 'Ideas as nodes with the relationships your material states.' },
  { id: 'flowchart', label: 'Flowchart', description: 'A process written as ordered steps.' },
  { id: 'comparison', label: 'Comparison table', description: 'Related concepts side by side.' },
  { id: 'timeline', label: 'Timeline', description: 'Events in the order the source dates them.' },
];

const KIND_ICONS = {
  'concept-map': 'sitemap',
  flowchart: 'target',
  comparison: 'library',
  timeline: 'clock',
};

const SIGNAL_LABELS = [
  ['datedSentences', 'dated sentences (timeline)'],
  ['sequenceSentences', 'ordered-step sentences (flowchart)'],
  ['comparisonSentences', 'contrast sentences (comparison)'],
  ['relationsBetweenTerms', 'connections between recurring terms (map)'],
  ['recurringTerms', 'recurring terms'],
  ['sentencesScanned', 'sentences scanned'],
];

/**
 * Resolve a clicked part key back to what the detail panel should show.
 * Keys: node/step/event ids ("n1", "s2", "e3"), "edge:<i>", or a cell
 * "<rowId>:<columnId>".
 */
export function resolvePart(visual, partKey) {
  if (!visual || !partKey) return null;
  const byId = (list, id) => list?.find((item) => item.id === id) ?? null;

  if (visual.kind === 'concept-map') {
    if (partKey.startsWith('edge:')) {
      const edge = visual.edges[Number(partKey.slice(5))];
      if (!edge) return null;
      const from = byId(visual.nodes, edge.from);
      const to = byId(visual.nodes, edge.to);
      return {
        eyebrow: 'Relationship',
        title: `${from?.label ?? edge.from} → ${edge.label ?? 'related to'} → ${to?.label ?? edge.to}`,
        text: edge.label
          ? `Your material connects these two ideas with “${edge.label}”.`
          : 'These two ideas appear together in your material.',
        sourceIds: edge.sourceIds,
      };
    }
    const node = byId(visual.nodes, partKey);
    if (!node) return null;
    return { eyebrow: 'Concept', title: node.label, text: node.explanation, sourceIds: node.sourceIds };
  }

  if (visual.kind === 'flowchart') {
    const step = byId(visual.steps, partKey);
    if (!step) return null;
    const index = visual.steps.indexOf(step) + 1;
    return { eyebrow: `Step ${index} of ${visual.steps.length}`, title: step.label, text: step.detail, sourceIds: step.sourceIds };
  }

  if (visual.kind === 'timeline') {
    const event = byId(visual.events, partKey);
    if (!event) return null;
    return { eyebrow: event.when, title: event.label, text: event.detail, sourceIds: event.sourceIds };
  }

  if (visual.kind === 'comparison') {
    const [rowId, columnId] = partKey.split(':');
    const row = byId(visual.rows, rowId);
    const cell = row?.cells?.find((c) => c.columnId === columnId);
    const column = visual.columns?.find((c) => c.id === columnId);
    if (!row || !cell) return null;
    return {
      eyebrow: `${row.label} · ${column?.label ?? columnId}`,
      title: column?.label ?? row.label,
      text: cell.text,
      sourceIds: cell.sourceIds,
    };
  }
  return null;
}

/** The four renderers. Each part is a real button, so keyboard use works. */
export function VisualCanvas({ visual, selected, onSelect }) {
  if (visual.kind === 'concept-map') {
    const labelOf = (id) => visual.nodes.find((n) => n.id === id)?.label ?? id;
    return (
      <div className="viz viz--map">
        <div className="viz-map__nodes">
          {visual.nodes.map((node) => (
            <button
              key={node.id}
              type="button"
              className={`viz-node${selected === node.id ? ' is-selected' : ''}`}
              aria-pressed={selected === node.id}
              onClick={() => onSelect(node.id)}
            >
              <span className="viz-node__label">{node.label}</span>
              <span className="viz-node__meta">
                <Icon name="quote" size={11} /> {node.sourceIds.length}
              </span>
            </button>
          ))}
        </div>
        <h4 className="viz__subhead" id="viz-relations">
          Relationships stated in your material
        </h4>
        <ul className="viz-edges" aria-labelledby="viz-relations">
          {visual.edges.map((edge, index) => {
            const key = `edge:${index}`;
            return (
              <li key={key}>
                <button
                  type="button"
                  className={`viz-edge${selected === key ? ' is-selected' : ''}`}
                  aria-pressed={selected === key}
                  onClick={() => onSelect(key)}
                >
                  <span className="viz-edge__node">{labelOf(edge.from)}</span>
                  <Icon name="chevronRight" size={13} />
                  <span className="viz-edge__label">{edge.label ?? 'appears with'}</span>
                  <Icon name="chevronRight" size={13} />
                  <span className="viz-edge__node">{labelOf(edge.to)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  if (visual.kind === 'flowchart') {
    return (
      <div className="viz viz--flow">
        <h4 className="viz__subhead" id="viz-steps">
          {visual.steps.length} steps, in the order your material gives them
        </h4>
        <ol className="viz-flow" aria-labelledby="viz-steps">
          {visual.steps.map((step, index) => (
            <li key={step.id} className="viz-flow__item">
              <span className="viz-flow__index" aria-hidden="true">
                {index + 1}
              </span>
              <button
                type="button"
                className={`viz-part${selected === step.id ? ' is-selected' : ''}`}
                aria-pressed={selected === step.id}
                onClick={() => onSelect(step.id)}
              >
                <span className="viz-part__label">{step.label}</span>
                <span className="viz-part__meta">
                  <Icon name="quote" size={11} /> {step.sourceIds.length} source{pluralise(step.sourceIds.length, '', 's')}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  if (visual.kind === 'timeline') {
    return (
      <div className="viz viz--timeline">
        <h4 className="viz__subhead" id="viz-events">
          {visual.events.length} dated moments, in chronological order
        </h4>
        <ol className="viz-timeline" aria-labelledby="viz-events">
          {visual.events.map((event) => (
            <li key={event.id} className="viz-timeline__item">
              <span className="viz-timeline__dot" aria-hidden="true" />
              <span className="viz-timeline__when">{event.when}</span>
              <button
                type="button"
                className={`viz-part${selected === event.id ? ' is-selected' : ''}`}
                aria-pressed={selected === event.id}
                onClick={() => onSelect(event.id)}
              >
                <span className="viz-part__label">{event.label}</span>
                <span className="viz-part__meta">
                  <Icon name="quote" size={11} /> {event.sourceIds.length} source{pluralise(event.sourceIds.length, '', 's')}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  // Comparison: a real table so column/row relationships survive screen
  // readers, with horizontal scroll instead of shrinking text on mobile.
  return (
    <div className="viz viz--table">
      <div className="viz-scroll" tabIndex={0} role="region" aria-label="Comparison table, scrollable">
        <table className="viz-table">
          <thead>
            <tr>
              <th scope="col" className="viz-table__corner">
                Aspect
              </th>
              {visual.columns.map((column) => (
                <th key={column.id} scope="col">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visual.rows.map((row) => (
              <tr key={row.id}>
                <th scope="row" className="viz-table__rowhead">
                  {row.label}
                </th>
                {row.cells.map((cell) => {
                  const key = `${row.id}:${cell.columnId}`;
                  return (
                    <td key={cell.columnId}>
                      <button
                        type="button"
                        className={`viz-cell${selected === key ? ' is-selected' : ''}`}
                        aria-pressed={selected === key}
                        onClick={() => onSelect(key)}
                      >
                        {cell.text}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The click-through panel: explanation, exact passage, and the next moves. */
export function DetailPanel({ part, citations, kindLabel, onClose }) {
  if (!part) {
    return (
      <div className="viz-panel viz-panel--hint">
        <p className="viz-panel__hint">
          <Icon name="eye" size={16} /> Click any{' '}
          {kindLabel === 'Concept map' ? 'concept or relationship' : kindLabel === 'Comparison table' ? 'cell' : 'item'} to
          see its explanation, the exact passage it came from, and what to do next.
        </p>
      </div>
    );
  }

  const sources = part.sourceIds.map((id) => citations.find((c) => c.id === id)).filter(Boolean);
  const conceptTitle = part.title.split(' → ')[0];

  return (
    <div className="viz-panel" role="region" aria-label="Selected part">
      <div className="viz-panel__head">
        <span className="viz-panel__eyebrow">{part.eyebrow}</span>
        <button type="button" className="viz-panel__close" onClick={onClose} aria-label="Close explanation">
          <Icon name="close" size={15} />
        </button>
      </div>
      <h4 className="viz-panel__title">{part.title}</h4>
      <p className="viz-panel__text">{part.text}</p>

      <h5 className="viz-panel__label">Where this comes from</h5>
      <div className="source-list source-list--tight">
        {sources.map((citation) => (
          <SourceCard
            key={`${citation.id}-${citation.passageId}`}
            citation={citation}
            onInspect={() => navigate(`/materials?id=${encodeURIComponent(citation.materialId)}`)}
          />
        ))}
      </div>

      <h5 className="viz-panel__label">What to do next</h5>
      <div className="viz-panel__actions">
        <a className="ls-btn ls-btn--primary ls-btn--sm" href={hrefTo('/chat', { q: `Explain ${truncateForLink(conceptTitle)}` })}>
          <Icon name="teacher" size={15} />
          <span>Ask the AI Teacher</span>
        </a>
        <a className="ls-btn ls-btn--secondary ls-btn--sm" href={hrefTo('/quiz', { topic: truncateForLink(conceptTitle) })}>
          <Icon name="quiz" size={15} />
          <span>Practise this</span>
        </a>
      </div>
    </div>
  );
}

function truncateForLink(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > 90 ? `${value.slice(0, 89)}…` : value;
}

export default function StudioPage() {
  const { materials, materialsState, notify } = useApp();
  const route = useRoute();

  const ready = useMemo(() => materials.filter((m) => m.status === 'ready'), [materials]);

  const [selected, setSelected] = useState(() => {
    const fromUrl = route.params.get('ids');
    return fromUrl ? fromUrl.split(',').filter(Boolean) : [];
  });
  const [topic, setTopic] = useState('');
  const [kind, setKind] = useState('auto');
  const [options, setOptions] = useState(FALLBACK_KINDS);
  const [state, setState] = useState('idle'); // idle | loading | ready
  const [record, setRecord] = useState(null);
  const [refusal, setRefusal] = useState(null); // 422: no visual is possible
  const [error, setError] = useState(null);
  const [partKey, setPartKey] = useState(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState([]);
  const [savedState, setSavedState] = useState('loading');

  // A link like #/studio?ids=<uuid> preselects that document.
  useEffect(() => {
    const fromUrl = route.params.get('ids');
    if (!fromUrl) return;
    const ids = fromUrl.split(',').filter(Boolean);
    setSelected((current) => (current.join(',') === ids.join(',') ? current : ids));
  }, [route.params]);

  const loadSaved = useCallback(async () => {
    setSavedState('loading');
    try {
      const data = await api.listVisuals();
      setSaved(data.visuals ?? []);
      setSavedState('ready');
    } catch {
      setSavedState('error');
    }
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .visualOptions()
      .then((data) => {
        if (alive && data.kinds?.length) {
          setOptions([{ id: 'auto', label: 'Let the material choose', description: 'The server picks the visual your material can actually support.' }, ...data.kinds]);
        }
      })
      .catch(() => {
        /* the fallback list keeps the form usable offline */
      });
    loadSaved();
    return () => {
      alive = false;
    };
  }, [loadSaved]);

  const generate = useCallback(async () => {
    setState('loading');
    setRefusal(null);
    setError(null);
    setPartKey(null);
    try {
      const created = await api.generateVisual({
        topic: topic.trim(),
        materialIds: selected.length ? selected : null,
        kind,
      });
      setRecord(created);
      setState('ready');
      loadSaved();
    } catch (err) {
      setState('idle');
      if (err?.status === 422) {
        setRefusal(err);
      } else {
        setError(err);
      }
    }
  }, [topic, selected, kind, loadSaved]);

  const openSaved = useCallback(async (id) => {
    setState('loading');
    setRefusal(null);
    setError(null);
    setPartKey(null);
    try {
      const data = await api.getVisual(id);
      setRecord(data.visual);
      setState('ready');
    } catch (err) {
      setState('idle');
      setError(err);
    }
  }, []);

  const removeSaved = useCallback(
    async (id) => {
      try {
        await api.deleteVisual(id);
        setSaved((list) => list.filter((item) => item.id !== id));
        if (record?.id === id) {
          setRecord(null);
          setState('idle');
        }
        notify('Visual deleted', 'success');
      } catch (err) {
        notify(err.message, 'error');
      }
    },
    [record, notify],
  );

  const copyText = useCallback(async () => {
    if (!record?.visual?.textVersion) return;
    try {
      await navigator.clipboard.writeText(record.visual.textVersion);
      setCopied(true);
      notify('Text version copied to the clipboard', 'success');
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      notify('Your browser blocked clipboard access.', 'error');
    }
  }, [record, notify]);

  const part = useMemo(() => (record ? resolvePart(record.visual, partKey) : null), [record, partKey]);
  const kindLabel = options.find((option) => option.id === record?.visual?.kind)?.label ?? record?.visual?.kind ?? '';

  if (ready.length === 0 && materialsState !== 'loading') {
    return (
      <div className="page">
        <EmptyState
          icon="sitemap"
          title="Nothing to visualise yet"
          description="A visual can only be built from your own indexed material — the studio draws what your documents actually contain, and nothing else. Upload a chapter, notes or a lecture PDF first."
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
        title="What should we picture?"
        subtitle="The server checks your material for real structure — dated events, ordered steps, stated contrasts, connected terms — and only draws what it finds."
      >
        <div className="stack-sm">
          <ScopePicker materials={materials} selected={selected} onChange={setSelected} noun="documents" verb="Visualising" />

          <div className="studio-controls">
            <Field label="Topic focus (optional)" hint="Leave blank to picture the whole selection.">
              {({ id }) => (
                <input
                  id={id}
                  className="ls-input"
                  type="text"
                  maxLength={300}
                  value={topic}
                  placeholder="e.g. cell respiration, the French Revolution, chapter 4"
                  onChange={(e) => setTopic(e.target.value)}
                />
              )}
            </Field>
            <Field label="Visual" hint={options.find((o) => o.id === kind)?.description}>
              {({ id }) => (
                <select id={id} className="ls-input" value={kind} onChange={(e) => setKind(e.target.value)}>
                  {options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>

          <div className="row-actions">
            <Button icon="sitemap" loading={state === 'loading'} disabled={state === 'loading'} onClick={generate}>
              {state === 'ready' ? 'Build another visual' : 'Build the visual'}
            </Button>
            <span className="muted-xs">
              {selected.length > 0
                ? `${selected.length} document${pluralise(selected.length, '', 's')} selected`
                : `Using all ${ready.length} ready document${pluralise(ready.length, '', 's')}`}
            </span>
          </div>
        </div>

        {state === 'loading' ? <LoadingPanel label="Reading your material and checking its structure" rows={4} /> : null}

        {error ? <ErrorPanel error={error} title="Could not build the visual" onRetry={() => generate()} /> : null}

        {refusal ? (
          <Alert tone="warning" title="This material cannot support that visual">
            <p>{refusal.message}</p>
            {refusal.details?.found ? (
              <details className="viz-signals">
                <summary>What the studio did find in your text</summary>
                <ul className="viz-signals__list">
                  {SIGNAL_LABELS.map(([key, label]) => (
                    <li key={key}>
                      <strong>{refusal.details.found[key] ?? 0}</strong> {label}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {refusal.details?.supported?.length ? (
              <p>
                Your material <strong>can</strong> support:{' '}
                {refusal.details.supported
                  .map((id) => options.find((o) => o.id === id)?.label ?? id)
                  .join(', ')}
                . Switch the visual type above and try again.
              </p>
            ) : (
              <p>
                Nothing in this selection carries enough structure for any of the four visuals. Try a chapter with a
                process or a history, ask the{' '}
                <a href="#/chat">AI Teacher</a> instead, or write a{' '}
                <a href="#/summary">study summary</a>.
              </p>
            )}
            {refusal.requestId ? <p className="muted-xs">Request id: {refusal.requestId}</p> : null}
          </Alert>
        ) : null}
      </Card>

      {record ? (
        <Card
          title={record.visual.title}
          subtitle={`${kindLabel} · ${record.stats?.passagesUsed ?? record.citations?.length ?? 0} grounded passage${pluralise(
            record.stats?.passagesUsed ?? record.citations?.length ?? 0,
            '',
            's',
          )} · ${record.citations.length} citation${pluralise(record.citations.length, '', 's')}`}
          actions={
            <div className="row-actions">
              <Badge
                tone={record.generationMode === 'live' ? 'success' : 'neutral'}
                icon={record.generationMode === 'live' ? 'sparkles' : 'shield'}
              >
                {record.generationMode === 'live' ? `Live · ${record.provider ?? 'model'}` : 'Local extractive'}
              </Badge>
              <Badge tone="neutral" icon={KIND_ICONS[record.visual.kind] ?? 'eye'}>
                {kindLabel}
              </Badge>
            </div>
          }
        >
          <div className="stack-sm">
            {record.warnings?.map((warning, index) => (
              <Alert key={index} tone="warning" title="Worth knowing">
                <p>{typeof warning === 'string' ? warning : warning.message}</p>
              </Alert>
            ))}

            <div className="viz-layout">
              <div className="viz-layout__canvas">
                <VisualCanvas visual={record.visual} selected={partKey} onSelect={(key) => setPartKey(key)} />
              </div>
              <aside className="viz-layout__panel">
                <DetailPanel part={part} citations={record.citations} kindLabel={kindLabel} onClose={() => setPartKey(null)} />
              </aside>
            </div>

            <details className="viz-text">
              <summary>
                <Icon name="file" size={14} /> Accessible text version
              </summary>
              <p className="muted-xs">
                The same picture as plain text, for screen readers, copying into notes, or reading on a small screen.
              </p>
              <pre className="viz-text__body">{record.visual.textVersion}</pre>
              <div className="row-actions">
                <Button variant="secondary" size="sm" icon={copied ? 'check' : 'quote'} onClick={copyText}>
                  {copied ? 'Copied' : 'Copy text version'}
                </Button>
              </div>
            </details>

            {record.citations.length > 0 ? (
              <>
                <h3 className="subhead">Every source this picture cites</h3>
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

      {state === 'idle' && !refusal && !error ? (
        <Alert tone="info" title="How the studio keeps visuals honest">
          <p>
            Every node, step, row and event links to the exact passage and page it came from. When a source has no
            dates, no steps and no stated connections, the studio says so instead of inventing a picture — that refusal
            is the feature, because a diagram of guesses is worse than no diagram.
          </p>
        </Alert>
      ) : null}

      {savedState === 'ready' && saved.length > 0 ? (
        <Card title="Saved visuals" subtitle="Stored with their citations — reopen one any time.">
          <ul className="material-list material-list--compact">
            {saved.map((item) => (
              <li key={item.id} className="material-row">
                <span className="material-row__icon">
                  <Icon name={KIND_ICONS[item.kind] ?? 'eye'} size={16} />
                </span>
                <div className="material-row__main">
                  <div className="material-row__title-row">
                    <span className="material-row__name" title={item.title}>
                      {item.title}
                    </span>
                    <Badge tone="neutral">{options.find((o) => o.id === item.kind)?.label ?? item.kind}</Badge>
                  </div>
                  <div className="material-row__meta">
                    <span>
                      {item.parts} part{pluralise(item.parts, '', 's')} · {item.citations} citation
                      {pluralise(item.citations, '', 's')}
                    </span>
                    <span>{formatDate(item.createdAt, { withTime: false })}</span>
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
                    title={`Delete “${item.title}”`}
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
