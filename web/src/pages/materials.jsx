/**
 * My Materials — upload, inspect, search and remove library documents.
 *
 * The page is deliberately explicit about what happened to a file: an upload
 * can succeed, or it can be stored-but-not-indexed, and those are shown as two
 * different outcomes rather than one vague "done".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Field,
  LoadingPanel,
  Spinner,
} from '../components/ui.jsx';
import { formatBytes, formatDate, formatNumber, formatRelative, pluralise, truncate } from '../lib/format.js';

const STATUS_TONES = { ready: 'success', processing: 'warning', failed: 'danger' };
const STATUS_LABELS = { ready: 'Indexed', processing: 'Processing', failed: 'Not indexed' };

/** Jump to the Study summary page with this one document preselected. */
function summariseOnly(material) {
  window.location.hash = `#/summary?ids=${material.id}`;
}

function MaterialRow({ material, onInspect, onDelete, busy }) {
  const tone = STATUS_TONES[material.status] ?? 'neutral';
  return (
    <li className="material-row">
      <span className={`material-row__icon material-row__icon--${tone}`}>
        <Icon name="file" size={18} />
      </span>

      <div className="material-row__main">
        <div className="material-row__title-row">
          <span className="material-row__name" title={material.name}>
            {material.name}
          </span>
          <Badge tone="neutral">{(material.ext ?? '').replace('.', '') || 'file'}</Badge>
          {material.language ? (
            <Badge tone={material.language === 'bn' ? 'warning' : 'neutral'}>
              {material.language === 'bn' ? 'বাংলা' : 'English'}
            </Badge>
          ) : null}
          <Badge tone={tone}>{STATUS_LABELS[material.status] ?? material.status}</Badge>
        </div>
        <div className="material-row__meta">
          <span>{formatBytes(material.sizeBytes)}</span>
          <span>{formatNumber(material.pageCount)} pages</span>
          <span>{formatNumber(material.passageCount)} passages</span>
          <span>{formatNumber(material.charCount)} characters</span>
          <span title={formatDate(material.createdAt)}>added {formatRelative(material.createdAt)}</span>
        </div>
        {material.error ? <p className="material-row__error">{material.error.message ?? 'Text could not be extracted.'}</p> : null}
        {material.warnings?.length ? (
          <ul className="material-row__warnings">
            {material.warnings.map((warning, i) => (
              <li key={i}>{typeof warning === 'string' ? warning : warning.message}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="material-row__actions">
        <Button
          variant="secondary"
          size="sm"
          icon="lightbulb"
          onClick={() => summariseOnly(material)}
          disabled={busy || material.status !== 'ready'}
          title={material.status === 'ready' ? 'Open a cited summary of this document' : 'Available once it is indexed'}
        >
          Summarise
        </Button>
        <Button variant="secondary" size="sm" icon="search" onClick={() => onInspect(material)} disabled={busy}>
          Inspect
        </Button>
        <Button
          variant="danger"
          size="sm"
          icon="trash"
          onClick={() => onDelete(material)}
          disabled={busy}
          aria-label={`Remove ${material.name}`}
        />
      </div>
    </li>
  );
}

function UploadPanel({ config, onUploaded }) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progressNote, setProgressNote] = useState('');
  // One entry per file, so a batch of ten uploads reports ten outcomes instead
  // of a single "done" that hides half of them.
  const [outcomes, setOutcomes] = useState([]);
  const inputRef = useRef(null);
  const { notify } = useApp();

  const limits = config?.limits;
  const allowed = limits?.allowedExtensions ?? ['.pdf', '.txt', '.md', '.markdown', '.docx', '.doc', '.rtf', '.odt'];
  const maxBytes = limits?.maxUploadBytes ?? 20 * 1024 * 1024;
  const maxDocuments = limits?.maxDocuments ?? 50;
  const maxFiles = limits?.maxFilesPerUpload ?? 10;

  const uploadAll = useCallback(
    async (fileList) => {
      const files = Array.from(fileList ?? []);
      if (inputRef.current) inputRef.current.value = '';
      if (files.length === 0) return;

      // Client-side checks first: a file the server would refuse should not cost
      // a round trip, and the message is clearer at the point of choice.
      const accepted = [];
      const rejected = [];
      for (const file of files) {
        const extension = `.${String(file.name).split('.').pop()?.toLowerCase() ?? ''}`;
        if (accepted.length >= maxFiles) {
          rejected.push({
            tone: 'danger',
            title: `Only ${maxFiles} files per drop`,
            body: `“${file.name}” was left out. Drop it in the next batch.`,
          });
        } else if (!allowed.includes(extension)) {
          rejected.push({
            tone: 'danger',
            title: `“${file.name}” is not a supported file type`,
            body: `Allowed: ${allowed.join(', ')}.`,
          });
        } else if (file.size > maxBytes) {
          rejected.push({
            tone: 'danger',
            title: `“${file.name}” is too large`,
            body: `${formatBytes(file.size)} is above the ${formatBytes(maxBytes)} per-file limit.`,
          });
        } else {
          accepted.push(file);
        }
      }

      setOutcomes(rejected);
      if (accepted.length === 0) return;

      setBusy(true);
      const collected = [...rejected];
      let failures = 0;

      for (let index = 0; index < accepted.length; index += 1) {
        const file = accepted[index];
        setProgressNote(
          accepted.length > 1
            ? `Extracting and indexing “${file.name}” (${index + 1} of ${accepted.length})…`
            : `Extracting and indexing “${file.name}”…`,
        );
        try {
          const result = await api.uploadMaterial(file);
          if (result?.__status === 422) {
            // Stored but not indexed: the record exists so the student can see
            // it and remove it, which is exactly what the server told us.
            collected.push({
              tone: 'warning',
              title: `“${result.material.name}” was stored but not indexed`,
              body: result.error?.message ?? 'No text could be extracted from this file.',
              provenance: result.provenance,
            });
          } else {
            const passages = result.material.passageCount ?? 0;
            const pages = result.material.pageCount ?? 0;
            const lang = result.material.language === 'bn' ? ' · detected as বাংলা' : '';
            collected.push({
              tone: 'success',
              title: `“${result.material.name}” is indexed`,
              body: `${formatNumber(passages)} passage${pluralise(passages, '', 's')} across ${formatNumber(
                pages,
              )} page${pluralise(pages, '', 's')} ${passages === 1 ? 'is' : 'are'} now searchable.${lang}`,
              provenance: result.provenance,
            });
          }
        } catch (err) {
          failures += 1;
          collected.push({
            tone: 'danger',
            title: `“${file.name}” could not be uploaded`,
            body: err.message,
            requestId: err.requestId,
            fields: err.fields,
          });
        }
        setOutcomes([...collected]);
      }

      setBusy(false);
      setProgressNote('');
      if (failures > 0) {
        notify(`${failures} of ${accepted.length} file${pluralise(accepted.length, '', 's')} could not be added`, 'error');
      } else if (accepted.length > 1) {
        notify(`Uploaded ${accepted.length} files`, 'success');
      } else {
        notify(`Uploaded ${accepted[0].name}`, 'success');
      }
      onUploaded?.();
    },
    [allowed, maxBytes, maxFiles, notify, onUploaded],
  );

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      setDragging(false);
      uploadAll(event.dataTransfer?.files);
    },
    [uploadAll],
  );

  return (
    <Card
      title="Add material"
      subtitle={`${allowed.join(' · ')} — up to ${formatBytes(maxBytes)} each, ${maxFiles} files at a time, ${maxDocuments} documents per profile.`}
    >
      <div
        className={`dropzone${dragging ? ' is-dragging' : ''}${busy ? ' is-busy' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          id="material-file"
          className="dropzone__input"
          type="file"
          multiple
          accept={allowed.join(',')}
          onChange={(e) => uploadAll(e.target.files)}
          disabled={busy}
        />
        <span className="dropzone__icon">
          {busy ? <Spinner size={22} /> : <Icon name="upload" size={22} />}
        </span>
        <div className="dropzone__text">
          <label htmlFor="material-file" className="dropzone__cta">
            {busy ? 'Indexing…' : 'Choose files'}
          </label>
          <span className="dropzone__hint">or drop them here — several at once is fine</span>
        </div>
        {progressNote ? <p className="dropzone__note">{progressNote}</p> : null}
      </div>

      {outcomes.length > 0 ? (
        <div className="stack-sm">
          {outcomes.map((outcome, index) => (
            <Alert key={`${outcome.title}-${index}`} tone={outcome.tone} title={outcome.title}>
              <p>{outcome.body}</p>
              {outcome.provenance ? <p className="muted-xs">{outcome.provenance}</p> : null}
              {outcome.requestId ? <p className="muted-xs">Request id: {outcome.requestId}</p> : null}
            </Alert>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function MaterialInspector({ material, onClose, onDeleted }) {
  const [detail, setDetail] = useState(null);
  const [passages, setPassages] = useState(null);
  const [page, setPage] = useState(1);
  const [state, setState] = useState('loading');
  const [error, setError] = useState(null);
  const limit = 5;

  const loadPassages = useCallback(
    async (nextPage, signal) => {
      try {
        const data = await api.getPassages(material.id, { page: nextPage, limit });
        if (signal?.aborted) return;
        setPassages(data);
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') return;
        setError(err);
      }
    },
    [material.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    setPage(1);
    api
      .getMaterial(material.id)
      .then((data) => {
        if (controller.signal.aborted) return;
        setDetail(data);
        setState('ready');
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err);
        setState('error');
      });
    return () => controller.abort();
  }, [material.id]);

  useEffect(() => {
    const controller = new AbortController();
    loadPassages(page, controller.signal);
    return () => controller.abort();
  }, [page, loadPassages]);

  return (
    <Card
      title={material.name}
      subtitle={`${formatBytes(material.sizeBytes)} · sha256 ${String(material.sha256 ?? '').slice(0, 12)}…`}
      actions={
        <div className="row-actions">
          <Button
            variant="danger"
            size="sm"
            icon="trash"
            onClick={async () => {
              await onDeleted(material);
            }}
          >
            Remove
          </Button>
          <Button variant="ghost" size="sm" icon="close" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      {state === 'loading' ? (
        <LoadingPanel label="Reading the indexed outline" rows={2} />
      ) : state === 'error' ? (
        <ErrorPanel error={error} title="Could not inspect this material" />
      ) : (
        <>
          <div className="kv-grid">
            <div className="kv">
              <span className="kv__k">Status</span>
              <span className="kv__v">{STATUS_LABELS[detail.material.status] ?? detail.material.status}</span>
            </div>
            <div className="kv">
              <span className="kv__k">Pages</span>
              <span className="kv__v">{formatNumber(detail.material.pageCount)}</span>
            </div>
            <div className="kv">
              <span className="kv__k">Passages</span>
              <span className="kv__v">{formatNumber(detail.passageCount)}</span>
            </div>
            <div className="kv">
              <span className="kv__k">Added</span>
              <span className="kv__v">{formatDate(detail.material.createdAt)}</span>
            </div>
          </div>

          <h3 className="subhead">Outline</h3>
          {detail.outline?.length ? (
            <ul className="outline-list">
              {detail.outline.map((entry) => (
                <li key={entry.passageId}>
                  <span className="outline-list__page">p. {entry.pageNumber}</span>
                  <span className="outline-list__heading">{entry.heading || '(no heading)'}</span>
                  <span className="outline-list__chars">{formatNumber(entry.charCount)} chars</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No passages were indexed from this file.</p>
          )}

          <h3 className="subhead">
            Passages {passages ? `(${formatNumber(passages.totalPassages)} total)` : ''}
          </h3>
          {passages?.passages?.length ? (
            <>
              <ul className="passage-list">
                {passages.passages.map((passage) => (
                  <li key={passage.passageId} className="passage">
                    <div className="passage__head">
                      <span className="passage__page">page {passage.pageNumber}</span>
                      <span className="passage__heading">{passage.heading || 'untitled section'}</span>
                    </div>
                    <p className="passage__text">{truncate(passage.text, 520)}</p>
                  </li>
                ))}
              </ul>
              <div className="pager">
                <Button variant="secondary" size="sm" icon="chevronLeft" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <span className="pager__label">
                  Page {page} · {passages.hasMore ? 'more available' : 'end of document'}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  iconRight="chevronRight"
                  disabled={!passages.hasMore}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </>
          ) : (
            <p className="muted">No passages were indexed from this file.</p>
          )}
        </>
      )}
    </Card>
  );
}

function SearchPanel({ materials }) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('all');
  const [result, setResult] = useState(null);
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);

  const run = useCallback(
    async (event) => {
      event?.preventDefault();
      if (!query.trim()) return;
      setState('loading');
      setError(null);
      try {
        const data = await api.searchMaterials({
          q: query.trim(),
          materialIds: scope === 'all' ? undefined : scope,
        });
        setResult(data);
        setState('ready');
      } catch (err) {
        setError(err);
        setState('error');
      }
    },
    [query, scope],
  );

  return (
    <Card title="Search inside your material" subtitle="Uses the same BM25 index the AI Teacher retrieves from.">
      <form className="search-form" onSubmit={run}>
        <Field label="Search terms">
          {({ id, ...aria }) => (
            <input
              id={id}
              className="ls-input"
              type="search"
              value={query}
              placeholder="e.g. photosynthesis, gradient descent, Ohm's law"
              onChange={(e) => setQuery(e.target.value)}
              {...aria}
            />
          )}
        </Field>
        <Field label="Scope">
          {({ id }) => (
            <select id={id} className="ls-input" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">All ready material</option>
              {materials
                .filter((m) => m.status === 'ready')
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          )}
        </Field>
        <Button type="submit" icon="search" loading={state === 'loading'}>
          Search
        </Button>
      </form>

      {state === 'error' ? <ErrorPanel error={error} title="Search failed" /> : null}

      {state === 'ready' && result ? (
        result.results?.length ? (
          <div className="stack-sm">
            <p className="muted-xs">
              {result.resultCount} passage{pluralise(result.resultCount, '', 's')} matched
              {result.supported ? '' : ' below the confidence threshold'} · searched {result.documentsSearched} indexed{' '}
              passage{pluralise(result.documentsSearched, '', 's')}
              {result.queryTerms?.length ? ` · terms: ${result.queryTerms.slice(0, 8).join(', ')}` : ''}
            </p>
            <ul className="search-results">
              {result.results.map((hit) => (
                <li key={hit.passageId} className="search-hit">
                  <div className="search-hit__head">
                    <span className="search-hit__doc">{hit.documentName}</span>
                    <span className="search-hit__page">p. {hit.pageNumber}</span>
                    <Badge tone="neutral">score {hit.score}</Badge>
                  </div>
                  {hit.heading ? <p className="search-hit__heading">{hit.heading}</p> : null}
                  <p className="search-hit__snippet">{hit.snippet}</p>
                  {hit.matchedTerms?.length ? (
                    <p className="search-hit__terms">
                      matched: {hit.matchedTerms.slice(0, 10).map((term) => (
                        <span key={term} className="term-chip">
                          {term}
                        </span>
                      ))}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <Alert tone="warning" title="No passage matched">
            <p>
              Your indexed material does not contain those terms above the confidence threshold.
              {result.queryTerms?.length ? ` Searched for: ${result.queryTerms.slice(0, 8).join(', ')}.` : ''}
            </p>
          </Alert>
        )
      ) : null}
    </Card>
  );
}

export default function MaterialsPage() {
  const { materials, materialsState, refreshMaterials, config, notify } = useApp();
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const onUploaded = useCallback(async () => {
    await refreshMaterials();
  }, [refreshMaterials]);

  const onDelete = useCallback(
    async (material) => {
      const confirmed = window.confirm(`Remove “${material.name}”? Its passages and index entry are deleted too.`);
      if (!confirmed) return;
      setBusy(true);
      try {
        await api.deleteMaterial(material.id);
        notify(`Removed ${material.name}`, 'success');
        if (selected?.id === material.id) setSelected(null);
        await refreshMaterials();
      } catch (err) {
        notify(err.message, 'error');
      } finally {
        setBusy(false);
      }
    },
    [notify, refreshMaterials, selected],
  );

  const totals = useMemo(
    () => ({
      passages: materials.reduce((sum, m) => sum + (m.passageCount || 0), 0),
      bytes: materials.reduce((sum, m) => sum + (m.sizeBytes || 0), 0),
    }),
    [materials],
  );

  return (
    <div className="page">
      <UploadPanel config={config} onUploaded={onUploaded} />

      {selected ? (
        <MaterialInspector
          material={selected}
          onClose={() => setSelected(null)}
          onDeleted={async (material) => {
            await onDelete(material);
          }}
        />
      ) : null}

      <Card
        title="Library"
        subtitle={
          materials.length
            ? `${materials.length} file${pluralise(materials.length, '', 's')} · ${formatNumber(totals.passages)} indexed passages · ${formatBytes(totals.bytes)} stored`
            : 'Nothing uploaded yet.'
        }
        actions={
          <Button variant="ghost" size="sm" icon="refresh" onClick={() => refreshMaterials()}>
            Refresh
          </Button>
        }
      >
        {materialsState === 'loading' && materials.length === 0 ? (
          <LoadingPanel label="Loading your library" rows={3} />
        ) : materialsState === 'error' ? (
          <ErrorPanel
            error={error}
            title="Could not load your library"
            onRetry={async () => {
              setError(null);
              try {
                await refreshMaterials();
              } catch (err) {
                setError(err);
              }
            }}
          />
        ) : materials.length === 0 ? (
          <EmptyState
            icon="library"
            title="No study material yet"
            description="Add a lecture note, a chapter, slides or your own notes: PDF, Word (.docx, .doc), Markdown (.md) and plain text (.txt) all work — in Bangla or English."
          />
        ) : (
          <ul className="material-list">
            {materials.map((material) => (
              <MaterialRow
                key={material.id}
                material={material}
                busy={busy}
                onInspect={(m) => setSelected(m)}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
      </Card>

      <SearchPanel materials={materials} />

      <Alert tone="info" title="How your files are handled">
        <p>
          Files stay on this machine. Text is extracted, split into passages and indexed locally with BM25.
          Only the few passages retrieved for a question are ever sent to an AI provider, and never the
          whole document.
        </p>
      </Alert>
    </div>
  );
}
