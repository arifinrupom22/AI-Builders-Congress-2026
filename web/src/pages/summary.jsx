/**
 * Study summary — turn selected material into revision notes.
 *
 * The whole document is summarised (passages are sampled evenly across it by
 * the server), and every claim keeps its citation, so this is verifiable study
 * material rather than a paragraph that "sounds about right".
 *
 * Nothing is persisted: a summary is generated on demand and belongs to the
 * session, exactly like an answer in the AI Teacher.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../store/AppContext.jsx';
import { useRoute, navigate } from '../lib/router.jsx';
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
import { RichText } from '../lib/markdown.jsx';
import { pluralise } from '../lib/format.js';

const LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'Follow the material' },
  { value: 'en', label: 'English' },
  { value: 'bn', label: 'বাংলা (Bangla)' },
];

const DEFAULT_LENGTHS = [
  { id: 'brief', label: 'Brief', description: 'A quick overview and the few facts worth keeping.' },
  { id: 'standard', label: 'Standard', description: 'Overview, key points, key terms and a study order.' },
  { id: 'detailed', label: 'Detailed', description: 'A section-by-section guide covering the whole document.' },
];

function downloadMarkdown(text, filename) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function SummaryPage() {
  const { materials, materialsState, config, notify } = useApp();
  const route = useRoute();

  const ready = useMemo(() => materials.filter((m) => m.status === 'ready'), [materials]);
  const [selected, setSelected] = useState(() => {
    const fromUrl = route.params.get('ids');
    return fromUrl ? fromUrl.split(',').filter(Boolean) : [];
  });
  const [length, setLength] = useState('standard');
  const [language, setLanguage] = useState('auto');
  const [focus, setFocus] = useState('');
  const [state, setState] = useState('idle');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  // A link like #/summary?ids=<uuid> preselects that document.
  useEffect(() => {
    const fromUrl = route.params.get('ids');
    if (!fromUrl) return;
    const ids = fromUrl.split(',').filter(Boolean);
    setSelected((current) => (current.join(',') === ids.join(',') ? current : ids));
  }, [route.params]);

  const lengths = config?.summaryLengths?.length ? config.summaryLengths : DEFAULT_LENGTHS;

  const generate = useCallback(
    async (overrideIds = null) => {
      // `overrideIds` lets a per-document button summarise exactly that file
      // without waiting for the selection state to re-render.
      const ids = overrideIds ?? (selected.length > 0 ? selected : null);
      setState('loading');
      setError(null);
      try {
        const response = await api.summarise({
          materialIds: ids,
          length,
          language: language === 'auto' ? null : language,
          focus: focus.trim(),
        });
        setResult(response);
        setState('ready');
      } catch (err) {
        setError(err);
        setState('error');
      }
    },
    [selected, length, language, focus],
  );

  const copy = useCallback(async () => {
    if (!result?.summary) return;
    try {
      await navigator.clipboard.writeText(result.summary);
      setCopied(true);
      notify('Summary copied to the clipboard', 'success');
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      notify('Your browser blocked clipboard access. Use Download instead.', 'error');
    }
  }, [result, notify]);

  if (ready.length === 0 && materialsState !== 'loading') {
    return (
      <div className="page">
        <EmptyState
          icon="lightbulb"
          title="Nothing to summarise yet"
          description="Upload a PDF, Word document, Markdown or text note first. A summary can only be built from material you have indexed."
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
        title="What should this summary cover?"
        subtitle="The server samples passages evenly across the whole document, so the summary describes all of it, not just the start."
      >
        <div className="stack-sm">
          <ScopePicker materials={materials} selected={selected} onChange={setSelected} noun="documents" verb="Summarising" />

          <div className="summary-controls">
            <Field label="Detail" hint={lengths.find((l) => l.id === length)?.description}>
              {({ id }) => (
                <select id={id} className="ls-input" value={length} onChange={(e) => setLength(e.target.value)}>
                  {lengths.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            <Field label="Language" hint="Summaries follow the language the material is written in.">
              {({ id }) => (
                <select id={id} className="ls-input" value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {LANGUAGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            <Field label="Extra focus (optional)" hint="e.g. “focus on the exam topics” or “একেবারে সংক্ষেপে”.">
              {({ id, ...aria }) => (
                <input
                  id={id}
                  className="ls-input"
                  type="text"
                  maxLength={300}
                  value={focus}
                  placeholder="What matters most to you right now"
                  onChange={(e) => setFocus(e.target.value)}
                  {...aria}
                />
              )}
            </Field>
          </div>

          <div className="row-actions">
            <Button
              icon="lightbulb"
              loading={state === 'loading'}
              disabled={state === 'loading'}
              onClick={() => generate()}
            >
              {state === 'ready' ? 'Regenerate summary' : 'Generate summary'}
            </Button>
            {selected.length > 0 ? (
              <span className="muted-xs">
                {selected.length} document{pluralise(selected.length, '', 's')} selected
              </span>
            ) : null}
          </div>
        </div>

        {state === 'loading' ? <LoadingPanel label="Reading and summarising your material" rows={4} /> : null}

        {state === 'error' ? (
          <ErrorPanel
            error={error}
            title={error?.code === 'no_materials' ? 'Nothing to summarise' : 'Could not build a summary'}
            onRetry={() => generate()}
          />
        ) : null}
      </Card>

      {result ? (
        <Card
          title="Revision summary"
          subtitle={
            result.stats
              ? `${result.stats.passagesUsed} passage${pluralise(result.stats.passagesUsed, '', 's')} from ${
                  result.stats.documents.length
                } document${pluralise(result.stats.documents.length, '', 's')} · ${
                  result.length === 'brief' ? 'brief' : result.length === 'detailed' ? 'detailed' : 'standard'
                }`
              : ''
          }
          actions={
            <div className="row-actions">
              <Button variant="secondary" size="sm" icon={copied ? 'check' : 'quote'} onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon="file"
                onClick={() =>
                  downloadMarkdown(
                    result.summary,
                    `summary-${result.stats?.documents?.[0]?.replace(/\.[^.]+$/, '') ?? 'notes'}.md`,
                  )
                }
              >
                Download .md
              </Button>
            </div>
          }
        >
          <div className="stack-sm">
            <div className="summary-meta">
              <Badge tone={result.generationMode === 'live' ? 'success' : 'neutral'} icon={result.generationMode === 'live' ? 'sparkles' : 'shield'}>
                {result.generationMode === 'live' ? `Live · ${result.provider?.label}` : 'Local extractive'}
              </Badge>
              <Badge tone="neutral" icon="quote">
                {result.citations.length} citation{pluralise(result.citations.length, '', 's')}
              </Badge>
              <Badge tone="neutral" icon="file">
                {result.language === 'bn' ? 'বাংলা' : 'English'}
              </Badge>
            </div>

            {result.warnings?.map((warning, index) => (
              <Alert key={index} tone="warning" title="Worth knowing">
                <p>{warning.message}</p>
              </Alert>
            ))}

            <RichText text={result.summary} citations={result.citations} />

            {result.keyTerms?.length ? (
              <>
                <h3 className="subhead">Key terms found in this material</h3>
                <p className="summary-terms">
                  {result.keyTerms.map((term) => (
                    <span
                      key={term.term}
                      className="term-chip"
                      title={`${term.count} mention${pluralise(term.count, '', 's')}${
                        term.pageNumber ? ` · first seen on page ${term.pageNumber}` : ''
                      }`}
                    >
                      {term.term}
                    </span>
                  ))}
                </p>
              </>
            ) : null}

            {result.citations.length > 0 ? (
              <>
                <h3 className="subhead">Where this came from</h3>
                <div className="source-list">
                  {result.citations.map((citation) => (
                    <SourceCard key={`${citation.id}-${citation.passageId}`} citation={citation} />
                  ))}
                </div>
              </>
            ) : null}

            <p className="muted-xs provenance">{result.provenance}</p>
          </div>
        </Card>
      ) : null}

      {state === 'idle' && ready.length > 0 ? (
        <Alert tone="info" title="How this differs from the AI Teacher">
          <p>
            The AI Teacher answers one question from the passages that question retrieves. This page reads across the
            whole document instead, so a long file gets a summary of all of it, with the same citation checks.
          </p>
        </Alert>
      ) : null}

      <Card title="Your documents" subtitle="Only indexed documents can be summarised.">
        <ul className="material-list material-list--compact">
          {ready.map((material) => (
            <li key={material.id} className="material-row">
              <span className="material-row__icon">
                <Icon name="file" size={16} />
              </span>
              <div className="material-row__main">
                <div className="material-row__title-row">
                  <span className="material-row__name" title={material.name}>
                    {material.name}
                  </span>
                  <Badge tone="neutral">{material.ext ?? 'file'}</Badge>
                  {material.language ? (
                    <Badge tone={material.language === 'bn' ? 'warning' : 'neutral'}>
                      {material.language === 'bn' ? 'বাংলা' : 'English'}
                    </Badge>
                  ) : null}
                </div>
                <div className="material-row__meta">
                  <span>{material.passageCount} passages</span>
                </div>
              </div>
              <div className="material-row__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  icon="lightbulb"
                  onClick={() => {
                    setSelected([material.id]);
                    generate([material.id]);
                  }}
                  title={`Summarise only “${material.name}”`}
                >
                  Summarise
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
