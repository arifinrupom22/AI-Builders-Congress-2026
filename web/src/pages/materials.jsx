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
import { useRoute } from '../lib/router.jsx';
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

const STATUS_TONES = { ready: 'success', processing: 'warning', empty: 'warning', failed: 'danger' };
const STATUS_LABELS = {
  ready: 'Ready to study',
  processing: 'Indexing…',
  empty: 'Nothing to study',
  failed: 'Indexing failed',
};

/** A one-line explanation of what a status means for the learner. */
function statusExplains(material) {
  switch (material.status) {
    case 'ready':
      return `${formatNumber(material.passageCount)} passage${pluralise(material.passageCount, '', 's')} indexed and searchable.`;
    case 'processing':
      return 'Still being extracted and indexed — this updates on its own.';
    case 'empty':
      return 'No selectable text was found, so there is nothing to study from this file yet.';
    case 'failed':
      return material.error?.message ?? 'Text could not be extracted. The file is kept so you can see why.';
    default:
      return null;
  }
}

/** Jump to the Study summary page with this one document preselected. */
function summariseOnly(material) {
  window.location.hash = `#/summary?ids=${material.id}`;
}

function MaterialRow({ material, onInspect, onDelete, onTogglePin, busy }) {
  const tone = STATUS_TONES[material.status] ?? 'neutral';
  const explain = statusExplains(material);
  return (
    <li className={`material-row${material.pinned ? ' is-pinned' : ''}`}>
      <span className={`material-row__icon material-row__icon--${tone}`}>
        <Icon name="file" size={18} />
      </span>

      <div className="material-row__main">
        <div className="material-row__title-row">
          {material.pinned ? (
            <span className="material-row__pin-flag" title="Pinned" aria-label="Pinned">
              <Icon name="pin" size={14} />
            </span>
          ) : null}
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
          {material.subject ? <span>in {material.subject}</span> : <span>Unsorted</span>}
        </div>
        {material.tags?.length ? (
          <ul className="material-row__tags">
            {material.tags.map((tag) => (
              <li key={tag} className="tag-chip">
                <Icon name="tag" size={11} /> {tag}
              </li>
            ))}
          </ul>
        ) : null}
        {explain ? (
          <p className={`material-row__status material-row__status--${tone}`}>{explain}</p>
        ) : null}
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
          variant="ghost"
          size="sm"
          icon="pin"
          onClick={() => onTogglePin(material)}
          disabled={busy}
          aria-pressed={material.pinned}
          title={material.pinned ? 'Unpin this document' : 'Pin this document to the top of your library'}
        >
          {material.pinned ? 'Unpin' : 'Pin'}
        </Button>
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

function MaterialInspector({ material, onClose, onDeleted, onOrganised, subjects, busy }) {
  const [detail, setDetail] = useState(null);
  const [passages, setPassages] = useState(null);
  const [page, setPage] = useState(1);
  const [state, setState] = useState('loading');
  const [error, setError] = useState(null);
  const [subjectDraft, setSubjectDraft] = useState(material.subject ?? '');
  const [tagDraft, setTagDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const limit = 5;
  const { notify } = useApp();

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

  const save = useCallback(
    async (patch) => {
      setSaving(true);
      try {
        const result = await api.organiseMaterial(material.id, patch);
        onOrganised?.(result.material);
      } catch (err) {
        notify(err.message, 'error');
      } finally {
        setSaving(false);
      }
    },
    [material.id, notify, onOrganised],
  );

  const addTag = useCallback(() => {
    const tag = tagDraft.trim();
    if (!tag) return;
    const tags = [...(material.tags ?? []), tag];
    setTagDraft('');
    save({ tags });
  }, [material.tags, save, tagDraft]);

  const removeTag = useCallback(
    (tag) => {
      save({ tags: (material.tags ?? []).filter((t) => t !== tag) });
    },
    [material.tags, save],
  );

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
              <span className="kv__v">
                <Badge tone={STATUS_TONES[detail.material.status] ?? 'neutral'}>
                  {STATUS_LABELS[detail.material.status] ?? detail.material.status}
                </Badge>
              </span>
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
            <div className="kv">
              <span className="kv__k">Type</span>
              <span className="kv__v">
                {(detail.material.ext ?? '').replace('.', '') || 'file'} · {formatBytes(detail.material.sizeBytes)}
              </span>
            </div>
            <div className="kv">
              <span className="kv__k">Detected language</span>
              <span className="kv__v">
                {detail.material.language === 'bn' ? 'বাংলা' : detail.material.language === 'en' ? 'English' : '—'}
              </span>
            </div>
          </div>

          {/* Source details: how to identify this exact file elsewhere. */}
          <h3 className="subhead">Source details</h3>
          <dl className="source-facts">
            <div className="source-facts__row">
              <dt>File name</dt>
              <dd>{detail.material.name}</dd>
            </div>
            <div className="source-facts__row">
              <dt>SHA-256</dt>
              <dd className="source-facts__hash">{detail.material.sha256}</dd>
            </div>
            <div className="source-facts__row">
              <dt>Origin</dt>
              <dd>{detail.material.source === 'upload' ? 'Uploaded from this device' : detail.material.source}</dd>
            </div>
            <div className="source-facts__row">
              <dt>Uploaded</dt>
              <dd>{formatDate(detail.material.createdAt)}</dd>
            </div>
          </dl>
          <p className="muted-xs">
            Every citation the AI Teacher and quiz generator produce points back to this file, its page
            numbers and its passages. Labelling a document never changes its text or its citations.
          </p>

          {/* Organisation: subject, tags, pin. All learner-set. */}
          <h3 className="subhead">Organisation</h3>
          <div className="organise">
            <Field label="Subject" hint="Group documents by course or topic. Leave empty to keep it in Unsorted.">
              {({ id, ...aria }) => (
                <div className="organise__row">
                  <input
                    id={id}
                    className="ls-input"
                    type="text"
                    list="subject-suggestions"
                    maxLength={60}
                    value={subjectDraft}
                    placeholder="e.g. Physics, DBMS, Higher Math"
                    onChange={(e) => setSubjectDraft(e.target.value)}
                    disabled={saving || busy}
                    {...aria}
                  />
                  <Button
                    variant="secondary"
                    onClick={() => save({ subject: subjectDraft.trim() || null })}
                    loading={saving}
                    disabled={busy || subjectDraft.trim() === (material.subject ?? '')}
                  >
                    Save
                  </Button>
                </div>
              )}
            </Field>
            <datalist id="subject-suggestions">
              {subjects.map((subject) => (
                <option key={subject} value={subject} />
              ))}
            </datalist>

            <div className="organise__field">
              <span className="ls-field__label">Tags</span>
              {material.tags?.length ? (
                <ul className="chip-list organise__tags">
                  {material.tags.map((tag) => (
                    <li key={tag} className="chip">
                      <Icon name="tag" size={12} /> {tag}
                      <button
                        type="button"
                        className="chip__remove"
                        aria-label={`Remove tag ${tag}`}
                        onClick={() => removeTag(tag)}
                        disabled={saving || busy}
                      >
                        <Icon name="close" size={11} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted-xs">No tags yet.</p>
              )}
              <div className="organise__row organise__row--tags">
                <input
                  className="ls-input"
                  type="text"
                  maxLength={32}
                  value={tagDraft}
                  placeholder="e.g. exam, revision, unit-1"
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                  disabled={saving || busy}
                  aria-label="New tag"
                />
                <Button variant="secondary" icon="plus" onClick={addTag} loading={saving} disabled={busy || !tagDraft.trim()}>
                  Add tag
                </Button>
              </div>
              <p className="ls-field__hint">Up to 12 tags. Press Enter to add.</p>
            </div>

            <div className="organise__field">
              <Button
                variant={material.pinned ? 'primary' : 'secondary'}
                icon="pin"
                onClick={() => save({ pinned: !material.pinned })}
                loading={saving}
                disabled={busy}
                aria-pressed={material.pinned}
              >
                {material.pinned ? 'Pinned to top' : 'Pin to top'}
              </Button>
              <p className="ls-field__hint">Pinned documents stay at the top of your library.</p>
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

const SORTS = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'name', label: 'Name (A–Z)' },
  { id: 'largest', label: 'Largest first' },
];

const STATUS_FILTERS = [
  { id: 'all', label: 'Any status' },
  { id: 'ready', label: 'Ready to study' },
  { id: 'processing', label: 'Indexing' },
  { id: 'failed', label: 'Failed' },
  { id: 'empty', label: 'Nothing to study' },
];

/** Pin first, then apply the chosen sort order. */
function sortMaterials(list, sort) {
  const bySort = {
    newest: (a, b) => (a.createdAt < b.createdAt ? 1 : -1),
    oldest: (a, b) => (a.createdAt > b.createdAt ? 1 : -1),
    name: (a, b) => a.name.localeCompare(b.name),
    largest: (a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0),
  };
  const compare = bySort[sort] ?? bySort.newest;
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return compare(a, b);
  });
}

function LibraryToolbar({
  materials,
  subjects,
  tags,
  query,
  setQuery,
  subject,
  setSubject,
  tag,
  setTag,
  type,
  setType,
  status,
  setStatus,
  sort,
  setSort,
}) {
  const kinds = useMemo(() => {
    const set = new Set(materials.map((m) => (m.ext ?? '').replace('.', '')).filter(Boolean));
    return [...set].sort();
  }, [materials]);

  const dirty = query || subject !== 'all' || tag !== 'all' || type !== 'all' || status !== 'all';

  return (
    <div className="lib-toolbar">
      <Field label="Search documents">
        {({ id, ...aria }) => (
          <input
            id={id}
            className="ls-input"
            type="search"
            value={query}
            placeholder="Search by name, subject or tag"
            onChange={(e) => setQuery(e.target.value)}
            {...aria}
          />
        )}
      </Field>

      <Field label="Subject">
        {({ id }) => (
          <select id={id} className="ls-input" value={subject} onChange={(e) => setSubject(e.target.value)}>
            <option value="all">All subjects</option>
            {subjects.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            <option value="__unsorted__">Unsorted</option>
          </select>
        )}
      </Field>

      <Field label="Tag">
        {({ id }) => (
          <select id={id} className="ls-input" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="all">Any tag</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="File type">
        {({ id }) => (
          <select id={id} className="ls-input" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">Any type</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="Status">
        {({ id }) => (
          <select id={id} className="ls-input" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_FILTERS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="Sort by">
        {({ id }) => (
          <select id={id} className="ls-input" value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      {dirty ? (
        <Button
          variant="ghost"
          size="sm"
          icon="close"
          onClick={() => {
            setQuery('');
            setSubject('all');
            setTag('all');
            setType('all');
            setStatus('all');
          }}
        >
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

function CollectionsRail({ subjects, counts, subject, setSubject }) {
  return (
    <nav className="collections" aria-label="Collections">
      <p className="collections__title">Collections</p>
      <ul className="collections__list">
        <li>
          <button
            type="button"
            className={`collections__item${subject === 'all' ? ' is-active' : ''}`}
            onClick={() => setSubject('all')}
          >
            <Icon name="library" size={15} />
            <span className="collections__name">All material</span>
            <span className="collections__count">{counts.all}</span>
          </button>
        </li>
        {subjects.map((s) => (
          <li key={s}>
            <button
              type="button"
              className={`collections__item${subject === s ? ' is-active' : ''}`}
              onClick={() => setSubject(s)}
            >
              <Icon name="folder" size={15} />
              <span className="collections__name">{s}</span>
              <span className="collections__count">{counts.subjects[s] ?? 0}</span>
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            className={`collections__item${subject === '__unsorted__' ? ' is-active' : ''}`}
            onClick={() => setSubject('__unsorted__')}
          >
            <Icon name="file" size={15} />
            <span className="collections__name">Unsorted</span>
            <span className="collections__count">{counts.unsorted}</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}

export default function MaterialsPage() {
  const { materials, materialsState, refreshMaterials, config, notify } = useApp();
  const route = useRoute();
  // Only the id is held; the record itself is derived from the live list so an
  // organisation change or a refresh cannot leave the open panel showing stale
  // subject/tags/pin values.
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // A link like #/materials?id=<uuid> opens that document's inspector, so a
  // citation elsewhere in the app can send the student to the source file.
  useEffect(() => {
    const id = route.params.get('id');
    if (id && id !== selectedId) setSelectedId(id);
  }, [route.params, selectedId]);

  // Library filters. All client-side: the library is small and the learner
  // should see results as they type.
  const [query, setQuery] = useState('');
  const [subject, setSubject] = useState('all');
  const [tag, setTag] = useState('all');
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('newest');

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
        if (selectedId === material.id) setSelectedId(null);
        await refreshMaterials();
      } catch (err) {
        notify(err.message, 'error');
      } finally {
        setBusy(false);
      }
    },
    [notify, refreshMaterials, selectedId],
  );

  /** Organisation save from the inspector. The list refresh restores the row. */
  const onOrganised = useCallback(
    async (updated) => {
      await refreshMaterials();
      return updated;
    },
    [refreshMaterials],
  );

  const onTogglePin = useCallback(
    async (material) => {
      setBusy(true);
      try {
        await api.organiseMaterial(material.id, { pinned: !material.pinned });
        notify(material.pinned ? `Unpinned ${material.name}` : `Pinned ${material.name}`, 'success');
        await refreshMaterials();
      } catch (err) {
        notify(err.message, 'error');
      } finally {
        setBusy(false);
      }
    },
    [notify, refreshMaterials],
  );

  const totals = useMemo(
    () => ({
      passages: materials.reduce((sum, m) => sum + (m.passageCount || 0), 0),
      bytes: materials.reduce((sum, m) => sum + (m.sizeBytes || 0), 0),
    }),
    [materials],
  );

  // Derived from the live library, so the open inspector always shows current
  // values. If the document was deleted, the panel closes itself.
  const selected = useMemo(
    () => materials.find((m) => m.id === selectedId) ?? null,
    [materials, selectedId],
  );

  /** Subjects in use, sorted. "Unsorted" is derived, never stored. */
  const subjects = useMemo(() => {
    const set = new Set(materials.map((m) => m.subject).filter(Boolean));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [materials]);

  const tags = useMemo(() => {
    const set = new Set();
    for (const m of materials) for (const t of m.tags ?? []) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [materials]);

  const counts = useMemo(() => {
    const bySubject = {};
    let unsorted = 0;
    for (const m of materials) {
      if (m.subject) bySubject[m.subject] = (bySubject[m.subject] ?? 0) + 1;
      else unsorted += 1;
    }
    return { subjects: bySubject, unsorted, all: materials.length };
  }, [materials]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = materials.filter((m) => {
      if (subject !== 'all') {
        if (subject === '__unsorted__' ? m.subject : m.subject !== subject) return false;
      }
      if (tag !== 'all' && !(m.tags ?? []).includes(tag)) return false;
      if (type !== 'all' && (m.ext ?? '').replace('.', '') !== type) return false;
      if (status !== 'all' && m.status !== status) return false;
      if (needle) {
        const haystack = [m.name, m.subject ?? '', ...(m.tags ?? [])].join(' ').toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
    return sortMaterials(list, sort);
  }, [materials, query, subject, tag, type, status, sort]);

  return (
    <div className="page">
      <UploadPanel config={config} onUploaded={onUploaded} />

      {selected ? (
        <MaterialInspector
          material={selected}
          subjects={subjects}
          busy={busy}
          onOrganised={onOrganised}
          onClose={() => setSelectedId(null)}
          onDeleted={async (material) => {
            await onDelete(material);
          }}
        />
      ) : null}

      <div className="library">
        <CollectionsRail subjects={subjects} counts={counts} subject={subject} setSubject={setSubject} />

        <Card
          title="Library"
          subtitle={
            materials.length
              ? `${filtered.length === materials.length ? `${materials.length} file${pluralise(materials.length, '', 's')}` : `Showing ${filtered.length} of ${materials.length}`} · ${formatNumber(totals.passages)} indexed passages · ${formatBytes(totals.bytes)} stored`
              : 'Nothing uploaded yet.'
          }
          actions={
            <Button variant="ghost" size="sm" icon="refresh" onClick={() => refreshMaterials()}>
              Refresh
            </Button>
          }
        >
          <LibraryToolbar
            materials={materials}
            subjects={subjects}
            tags={tags}
            query={query}
            setQuery={setQuery}
            subject={subject}
            setSubject={setSubject}
            tag={tag}
            setTag={setTag}
            type={type}
            setType={setType}
            status={status}
            setStatus={setStatus}
            sort={sort}
            setSort={setSort}
          />

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
          ) : filtered.length === 0 ? (
            <EmptyState
              icon="search"
              title="No document matches these filters"
              description="Try a different subject, tag or file type — or clear the filters to see your whole library."
              action={
                <Button
                  variant="secondary"
                  icon="close"
                  onClick={() => {
                    setQuery('');
                    setSubject('all');
                    setTag('all');
                    setType('all');
                    setStatus('all');
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <ul className="material-list">
              {filtered.map((material) => (
                <MaterialRow
                  key={material.id}
                  material={material}
                  busy={busy}
                  onInspect={(m) => setSelectedId(m.id)}
                  onDelete={onDelete}
                  onTogglePin={onTogglePin}
                />
              ))}
            </ul>
          )}
        </Card>
      </div>

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
