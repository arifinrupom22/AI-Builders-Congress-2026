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
import { createPortal } from 'react-dom';
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

/* ------------------------------------------------------------------------- */
/* Diagrams                                                                   */
/* ------------------------------------------------------------------------- */

const MAP_W = 1000;
const MAP_H = 700;

/**
 * Deterministic concept-map layout: the most connected concept sits in the
 * centre, everything else on one or two rings around it. No force simulation,
 * so the same visual always looks the same and nothing jumps while you read.
 */
function layoutConceptMap(nodes, edges) {
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const ordered = [...nodes].sort(
    (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.label.localeCompare(b.label),
  );
  const positions = new Map();
  const cx = MAP_W / 2;
  const cy = MAP_H / 2;
  if (ordered.length === 0) return { positions, hubId: null };

  positions.set(ordered[0].id, { x: cx, y: cy });
  const rest = ordered.slice(1);
  const rings = [
    { items: rest.slice(0, 7), rx: MAP_W * 0.3, ry: MAP_H * 0.33, phase: 0 },
    { items: rest.slice(7), rx: MAP_W * 0.44, ry: MAP_H * 0.45, phase: Math.PI / 7 },
  ];
  for (const ring of rings) {
    ring.items.forEach((node, index) => {
      const angle = -Math.PI / 2 + ring.phase + (index * 2 * Math.PI) / Math.max(ring.items.length, 1);
      positions.set(node.id, { x: cx + Math.cos(angle) * ring.rx, y: cy + Math.sin(angle) * ring.ry });
    });
  }
  return { positions, hubId: ordered[0].id };
}

/**
 * Rough half-width of a node box, from its label. The old geometry used one
 * fixed offset for every arrow, so arrows to wide nodes stopped in empty space
 * and short arrows vanished entirely - the "broken connections" students saw.
 */
function nodeRadius(node) {
  const label = String(node?.label ?? '');
  return { rx: Math.max(62, Math.min(150, 14 + label.length * 5.2)), ry: 30 };
}

/** Point where a ray from the centre leaves the node's box. */
function attachPoint(centre, dx, dy, { rx, ry }) {
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const t = 1 / Math.hypot(ux / rx, uy / ry);
  const gap = 7;
  return { x: centre.x + ux * (t + gap), y: centre.y + uy * (t + gap) };
}

/** A curved arrow that starts and ends exactly on the edge of each node box. */
function edgeGeometry(fromNode, toNode, fromPos, toPos) {
  const dx = toPos.x - fromPos.x;
  const dy = toPos.y - fromPos.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 90) return null;

  const start = attachPoint(fromPos, dx, dy, nodeRadius(fromNode));
  const end = attachPoint(toPos, -dx, -dy, nodeRadius(toNode));
  // Bend proportional to length, so short links stay nearly straight.
  const bend = Math.min(46, distance * 0.08);
  const ux = dx / distance;
  const uy = dy / distance;
  const control = { x: (start.x + end.x) / 2 - uy * bend, y: (start.y + end.y) / 2 + ux * bend };
  return {
    path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`,
    label: {
      x: 0.25 * start.x + 0.5 * control.x + 0.25 * end.x,
      y: 0.25 * start.y + 0.5 * control.y + 0.25 * end.y,
    },
  };
}

/** Concept map: a real node-and-edge picture, with every part still a button. */
function ConceptMap({ visual, selected, onSelect }) {
  const { positions, hubId } = useMemo(() => layoutConceptMap(visual.nodes, visual.edges), [visual.nodes, visual.edges]);
  const labelOf = (id) => visual.nodes.find((node) => node.id === id)?.label ?? id;

  const drawn = visual.edges.map((edge, index) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to || edge.from === edge.to) return null;
    const fromNode = visual.nodes.find((node) => node.id === edge.from);
    const toNode = visual.nodes.find((node) => node.id === edge.to);
    const geometry = edgeGeometry(fromNode, toNode, from, to);
    if (!geometry) return null;
    // Edge verbs are shown in the relationship list under the map, not as pills
    // floating over the drawing: at any real zoom the pills landed on top of
    // nodes and of each other, which is exactly the clutter students reported.
    // The arrow still shows the connection; the list names it in words.
    const generic = !edge.label || /^appears with$/i.test(edge.label.trim());
    return { key: `edge:${index}`, edge, geometry, generic };
  });

  return (
    <div className="viz viz--map">
      <div className="viz-map">
        <svg
          className="viz-map__edges"
          viewBox={`0 0 ${MAP_W} ${MAP_H}`}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <marker id="viz-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          </defs>
          <circle className="viz-map__halo" cx={MAP_W / 2} cy={MAP_H / 2} r={150} />
          <circle className="viz-map__halo viz-map__halo--wide" cx={MAP_W / 2} cy={MAP_H / 2} r={250} />
          {drawn.map((item) =>
            item ? (
              <path
                key={item.key}
                className={`viz-map__edge${selected === item.key ? ' is-selected' : ''}`}
                d={item.geometry.path}
                markerEnd="url(#viz-arrow)"
              />
            ) : null,
          )}
        </svg>


        {visual.nodes.map((node) => {
          const position = positions.get(node.id);
          if (!position) return null;
          const isHub = hubId === node.id;
          return (
            <button
              key={node.id}
              type="button"
              className={`viz-map__node${isHub ? ' viz-map__node--hub' : ''}${selected === node.id ? ' is-selected' : ''}`}
              style={{ left: `${(position.x / MAP_W) * 100}%`, top: `${(position.y / MAP_H) * 100}%` }}
              aria-pressed={selected === node.id}
              onClick={() => onSelect(node.id)}
            >
              <span className="viz-map__node-label">{node.label}</span>
              <span className="viz-map__node-meta">
                <Icon name="quote" size={11} /> {node.sourceIds.length}
              </span>
            </button>
          );
        })}
      </div>

      <h4 className="viz__subhead" id="viz-relations">
        Relationships stated in your material
      </h4>
      <ul className="viz-relations" aria-labelledby="viz-relations">
        {visual.edges.map((edge, index) => {
          const key = `edge:${index}`;
          return (
            <li key={key}>
              <button
                type="button"
                className={`viz-relation${selected === key ? ' is-selected' : ''}`}
                aria-pressed={selected === key}
                onClick={() => onSelect(key)}
              >
                <span className="viz-relation__node">{labelOf(edge.from)}</span>
                <Icon name="chevronRight" size={12} />
                <span className="viz-relation__label">{edge.label ?? 'appears with'}</span>
                <Icon name="chevronRight" size={12} />
                <span className="viz-relation__node">{labelOf(edge.to)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Flowchart: boxes joined by arrows, with a start and an end cap. */
function FlowChart({ visual, selected, onSelect }) {
  return (
    <div className="viz viz--flow">
      <p className="viz-caption">
        {visual.steps.length} steps, in the order your material gives them
      </p>
      <ol className="flow" aria-label="Steps">
        <li className="flow__cap" aria-hidden="true">
          Start
        </li>
        {visual.steps.map((step, index) => (
          <li key={step.id} className="flow__item">
            <span className="flow__link" aria-hidden="true" />
            <button
              type="button"
              className={`flow__box${selected === step.id ? ' is-selected' : ''}`}
              aria-pressed={selected === step.id}
              onClick={() => onSelect(step.id)}
            >
              <span className="flow__index" aria-hidden="true">
                {index + 1}
              </span>
              <span className="flow__body">
                <span className="flow__label">{step.label}</span>
                <span className="flow__meta">
                  <Icon name="quote" size={11} /> {step.sourceIds.length} source
                  {pluralise(step.sourceIds.length, '', 's')}
                </span>
              </span>
            </button>
          </li>
        ))}
        <li className="flow__link flow__link--plain" aria-hidden="true" style={{ listStyle: 'none' }} />
        <li className="flow__cap flow__cap--end" aria-hidden="true">
          End
        </li>
      </ol>
    </div>
  );
}

/** Timeline: a dated axis with one card per moment. */
function Timeline({ visual, selected, onSelect }) {
  return (
    <div className="viz viz--timeline">
      <p className="viz-caption">{visual.events.length} dated moments, in chronological order</p>
      <div className="viz-scroll" tabIndex={0} role="region" aria-label="Timeline, scrollable">
        <ol className="tl">
          {visual.events.map((event) => (
            <li key={event.id} className="tl__item">
              <span className="tl__when">{event.when}</span>
              <span className="tl__dot" aria-hidden="true" />
              <button
                type="button"
                className={`tl__card${selected === event.id ? ' is-selected' : ''}`}
                aria-pressed={selected === event.id}
                onClick={() => onSelect(event.id)}
              >
                <span className="tl__label">{event.label}</span>
                <span className="tl__meta">
                  <Icon name="quote" size={11} /> {event.sourceIds.length} source
                  {pluralise(event.sourceIds.length, '', 's')}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** The four renderers. Each part is a real button, so keyboard use works. */
export function VisualCanvas({ visual, selected, onSelect }) {
  if (visual.kind === 'concept-map') {
    return <ConceptMap visual={visual} selected={selected} onSelect={onSelect} />;
  }

  if (visual.kind === 'flowchart') {
    return <FlowChart visual={visual} selected={selected} onSelect={onSelect} />;
  }

  if (visual.kind === 'timeline') {
    return <Timeline visual={visual} selected={selected} onSelect={onSelect} />;
  }

  // Comparison: a real table so column/row relationships survive screen
  // readers, with horizontal scroll instead of shrinking text on mobile.
  return (
    <div className="viz viz--table">
      <p className="viz-caption">
        {visual.rows.length} aspect{pluralise(visual.rows.length, '', 's')} compared across{' '}
        {visual.columns.length} concept{pluralise(visual.columns.length, '', 's')}
      </p>
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

/* ------------------------------------------------------------------------- */
/* Explanation                                                                */
/* ------------------------------------------------------------------------- */

/** Compact [S#] markers, with the document and page in the tooltip. */
function SourceTags({ ids, citations }) {
  if (!ids?.length) return null;
  return (
    <span className="viz-cite">
      {ids.map((id) => {
        const citation = citations?.find((entry) => entry.id === id);
        return (
          <span
            key={id}
            className="viz-cite__id"
            title={citation ? `${citation.documentName} · page ${citation.pageNumber}` : id}
          >
            {id}
          </span>
        );
      })}
    </span>
  );
}

/**
 * The teaching half of a visual: overview, key concepts, ordered steps, an
 * example, what to remember and a one-line summary.
 *
 * Sections the material cannot support are absent, never padded with prose.
 * `mode` says whether the wording was written by the model (live) or quoted
 * from the source (quoted), because those are different promises.
 */
export function VisualExplanation({ explanation, citations }) {
  if (!explanation) return null;
  const { overview, keyConcepts = [], steps = [], example, remember = [], summary } = explanation;
  if (!overview && keyConcepts.length === 0 && steps.length === 0) return null;

  return (
    <section className="viz-explain" aria-label="Explanation of this visual">
      <header className="viz-explain__head">
        <h3 className="viz-explain__title">Explanation</h3>
        <span className="viz-explain__mode">
          {explanation.mode === 'quoted' ? 'Quoted from your material' : 'Written for you, checked against your material'}
        </span>
      </header>

      {overview ? (
        <div className="viz-explain__block viz-explain__block--lead">
          <h4>Topic overview</h4>
          <p>{overview}</p>
        </div>
      ) : null}

      {keyConcepts.length > 0 ? (
        <div className="viz-explain__block">
          <h4>Key concepts</h4>
          <ul className="viz-concepts">
            {keyConcepts.map((concept) => (
              <li key={concept.term} className="viz-concept">
                <span className="viz-concept__term">
                  {concept.term}
                  <SourceTags ids={concept.sourceIds} citations={citations} />
                </span>
                <span className="viz-concept__meaning">{concept.meaning}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {steps.length > 0 ? (
        <div className="viz-explain__block">
          <h4>Step by step</h4>
          <ol className="viz-steps">
            {steps.map((step, index) => (
              <li key={`${step.title}-${index}`} className="viz-step">
                <span className="viz-step__index" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="viz-step__body">
                  <span className="viz-step__title">
                    {step.title}
                    <SourceTags ids={step.sourceIds} citations={citations} />
                  </span>
                  {step.text && step.text !== step.title ? <span className="viz-step__text">{step.text}</span> : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {example ? (
        <div className="viz-explain__block viz-explain__block--example">
          <h4>
            Practical example
            <SourceTags ids={example.sourceIds} citations={citations} />
          </h4>
          <p>{example.text}</p>
        </div>
      ) : null}

      {remember.length > 0 ? (
        <div className="viz-explain__block">
          <h4>Remember this</h4>
          <ul className="viz-remember">
            {remember.map((item, index) => (
              <li key={`${item.text.slice(0, 24)}-${index}`}>
                {item.text}
                <SourceTags ids={item.sourceIds} citations={citations} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {summary ? (
        <div className="viz-explain__block viz-explain__block--summary">
          <h4>Short summary</h4>
          <p>{summary}</p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The diagram frame: fits the available width, and can be expanded for a
 * complex map. Zoom scales the whole drawing (nodes and arrows together), so
 * connections never drift away from the boxes they join.
 */
function DiagramFrame({ visual, selected, onSelect, kindLabel }) {
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const step = (delta) => setZoom((value) => Math.min(1.8, Math.max(1, Number((value + delta).toFixed(2)))));

  const frame = (
    <div className={`viz-frame${expanded ? ' viz-frame--expanded' : ''}`}>
      <div className="viz-frame__bar">
        <span className="viz-frame__name">
          <Icon name={KIND_ICONS[visual.kind] ?? 'eye'} size={14} /> {kindLabel}
        </span>
        <div className="viz-frame__tools">
          <button
            type="button"
            className="viz-frame__btn"
            onClick={() => step(-0.15)}
            disabled={zoom <= 1}
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="viz-frame__zoom" aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            className="viz-frame__btn"
            onClick={() => step(0.15)}
            disabled={zoom >= 1.8}
            aria-label="Zoom in"
          >
            +
          </button>
          <button type="button" className="viz-frame__btn viz-frame__btn--wide" onClick={() => setExpanded((v) => !v)}>
            <Icon name={expanded ? 'close' : 'external'} size={13} /> {expanded ? 'Close' : 'Expand'}
          </button>
        </div>
      </div>
      <div className="viz-frame__canvas">
        <div className="viz-frame__zoomable" style={{ '--viz-zoom': zoom }}>
          <VisualCanvas visual={visual} selected={selected} onSelect={onSelect} />
        </div>
      </div>
    </div>
  );

  // Rendered into <body> when expanded: a fixed element inside the page's
  // transformed/backdrop-filtered card is positioned against that card, which
  // left the sidebar showing through the overlay.
  return expanded ? createPortal(frame, document.body) : frame;
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
  const [language, setLanguage] = useState('auto');
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
        language,
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
  }, [topic, selected, kind, language, loadSaved]);

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

  const downloadText = useCallback(() => {
    if (!record?.visual) return;
    const body = `${record.visual.title}\n\n${record.visual.textVersion ?? ''}\n`;
    const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${String(record.visual.title ?? 'visual').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'visual'}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    notify('Downloaded as a markdown study page', 'success');
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
            <Field label="Page language" hint="Follows your topic and material when set to Auto.">
              {({ id }) => (
                <select id={id} className="ls-input" value={language} onChange={(e) => setLanguage(e.target.value)}>
                  <option value="auto">Auto</option>
                  <option value="en">English</option>
                  <option value="bn">{'\u09ac\u09be\u0982\u09b2\u09be'}</option>
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

        {state === 'loading' ? (
          <LoadingPanel label="Reading your material, checking its structure, then writing the explanation and the diagram" rows={4} />
        ) : null}

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

            <VisualExplanation explanation={record.visual.explanation} citations={record.citations} />

            <div className="viz-layout">
              <div className="viz-layout__canvas">
                <DiagramFrame
                  visual={record.visual}
                  selected={partKey}
                  onSelect={(key) => setPartKey(key)}
                  kindLabel={kindLabel}
                />
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
                <Button variant="secondary" size="sm" icon="download" onClick={downloadText}>
                  Download page
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
