/**
 * AI Teacher — ask questions about your own material.
 *
 * The UI is built around honesty rather than fluency:
 *   - every answer shows whether a real model or the local extractive teacher
 *     produced it (`generationMode`), and the server's own provenance sentence,
 *   - a refusal (`kind: insufficient_material` / `no_materials`) is presented as
 *     a valid answer with the next action spelled out,
 *   - citations are chips that open the exact retrieved passage.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../store/AppContext.jsx';
import { Icon } from '../components/Icons.jsx';
import { RichText } from '../lib/markdown.jsx';
import { Badge, Button, Card, EmptyState, ErrorPanel, Field, SourceCard, Spinner } from '../components/ui.jsx';
import { ScopePicker } from '../components/ScopePicker.jsx';
import { formatRelative, pluralise, truncate } from '../lib/format.js';

const KIND_LABELS = {
  grounded: { tone: 'success', label: 'Grounded in your material' },
  insufficient_material: { tone: 'warning', label: 'Your material does not cover this' },
  no_materials: { tone: 'warning', label: 'Library empty' },
};

function ModeControls({ modes, lengths, mode, length, onMode, onLength }) {
  return (
    <div className="composer__controls">
      <Field label="Teaching mode">
        {({ id }) => (
          <select id={id} className="ls-input" value={mode} onChange={(e) => onMode(e.target.value)}>
            {modes.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Answer length">
        {({ id }) => (
          <select id={id} className="ls-input" value={length} onChange={(e) => onLength(e.target.value)}>
            {lengths.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </Field>
    </div>
  );
}

function ModeHint({ modes, mode }) {
  const active = modes.find((m) => m.id === mode);
  if (!active) return null;
  return <p className="composer__hint">{active.description}</p>;
}

function MessageBubble({ message, onCitation }) {
  if (message.role === 'user') {
    return (
      <div className="msg msg--user">
        <div className="msg__bubble">
          <p className="msg__text">{message.content}</p>
        </div>
        <span className="msg__time">{formatRelative(message.createdAt)}</span>
      </div>
    );
  }

  const kind = KIND_LABELS[message.kind] ?? null;
  const retrieval = message.retrieval;

  return (
    <div className="msg msg--assistant">
      <div className="msg__avatar" aria-hidden="true">
        <Icon name="teacher" size={18} />
      </div>
      <div className="msg__body">
        <div className="msg__meta">
          {kind ? <Badge tone={kind.tone}>{kind.label}</Badge> : null}
          <Badge tone={message.generationMode === 'live' ? 'success' : 'neutral'} icon={message.generationMode === 'live' ? 'sparkles' : 'shield'}>
            {message.generationMode === 'live' ? 'Model answer' : 'Local extractive answer'}
          </Badge>
          {message.mode ? <span className="msg__mode">{message.mode.replace(/_/g, ' ')}</span> : null}
          <span className="msg__time">{formatRelative(message.createdAt)}</span>
        </div>

        <RichText text={message.content} citations={message.citations ?? []} onCitation={onCitation} className="msg__rich" />

        {message.citations?.length ? (
          <details className="sources">
            <summary>
              <Icon name="quote" size={14} />
              {message.citations.length} source{pluralise(message.citations.length, '', 's')}
            </summary>
            <div className="sources__grid">
              {message.citations.map((citation) => (
                <SourceCard key={citation.id} citation={citation} onInspect={onCitation} />
              ))}
            </div>
          </details>
        ) : null}

        {message.warnings?.length ? (
          <ul className="warnings">
            {message.warnings.map((warning, i) => (
              <li key={i}>
                <Icon name="alert" size={14} />
                <span>{typeof warning === 'string' ? warning : warning.message}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {message.provenance ? <p className="provenance">{message.provenance}</p> : null}

        {retrieval ? (
          <details className="retrieval">
            <summary>How this answer was retrieved</summary>
            <div className="retrieval__grid">
              <span>
                <strong>{retrieval.passages?.length ?? 0}</strong> passage(s) used
              </span>
              <span>
                <strong>{retrieval.documentsSearched ?? 0}</strong> indexed passage
                {pluralise(retrieval.documentsSearched ?? 0, '', 's')} searched
              </span>
              <span>
                <strong>{retrieval.minScore ?? '—'}</strong> confidence threshold
              </span>
              {retrieval.truncated ? <span className="retrieval__warn">context was truncated to fit the model</span> : null}
            </div>
            {retrieval.unknownTerms?.length ? (
              <p className="muted-xs">Words your material never uses: {retrieval.unknownTerms.slice(0, 10).join(', ')}</p>
            ) : null}
            {retrieval.closestPassages?.length ? (
              <ul className="retrieval__candidates">
                {retrieval.closestPassages.slice(0, 3).map((candidate) => (
                  <li key={candidate.passageId}>
                    closest match: {candidate.documentName} p.{candidate.pageNumber} (score {candidate.score})
                  </li>
                ))}
              </ul>
            ) : null}
          </details>
        ) : null}
      </div>
    </div>
  );
}

function SourceModal({ citation, onClose }) {
  if (!citation) return null;
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Source ${citation.id}`}>
      <button type="button" className="modal__scrim" aria-label="Close source" onClick={onClose} />
      <div className="modal__panel">
        <header className="modal__head">
          <div>
            <span className="modal__eyebrow">Retrieved passage {citation.id}</span>
            <h2 className="modal__title">{citation.documentName}</h2>
            <p className="modal__sub">
              page {citation.pageNumber}
              {citation.heading ? ` · ${citation.heading}` : ''}
              {typeof citation.relevance === 'number' ? ` · relevance ${citation.relevance.toFixed(2)}` : ''}
            </p>
          </div>
          <Button variant="ghost" size="sm" icon="close" onClick={onClose}>
            Close
          </Button>
        </header>
        <p className="modal__text">{citation.snippet}</p>
        <p className="muted-xs">
          This is the exact text the answer was allowed to use. Open My Materials to read the surrounding pages.
        </p>
      </div>
    </div>
  );
}

export default function ChatPage({ route }) {
  const { config, materials, notify, learnerId } = useApp();
  const modes = config?.answerModes ?? [{ id: 'simple', label: 'Explain simply', description: '' }];
  const lengths = config?.answerLengths ?? [{ id: 'standard', label: 'Standard' }];

  const [mode, setMode] = useState('simple');
  const [length, setLength] = useState('standard');
  const [scope, setScope] = useState([]);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState([]);
  const [sessionId, setSessionId] = useState(route?.params?.get('session') ?? null);
  const [sessions, setSessions] = useState([]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null);

  const streamRef = useRef(null);
  const readyMaterials = materials.filter((m) => m.status === 'ready');

  const loadSessions = useCallback(async () => {
    try {
      const data = await api.listSessions();
      setSessions(data.sessions ?? []);
    } catch {
      /* the session list is a convenience; the composer still works */
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions, learnerId]);

  // Open a specific session from the URL, otherwise start a clean one.
  useEffect(() => {
    const requested = route?.params?.get('session');
    if (!requested) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getSession(requested);
        if (cancelled) return;
        setSessionId(data.session.id);
        setMessages(data.session.messages ?? []);
      } catch (err) {
        if (cancelled) return;
        notify(err.message, 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route?.params, notify]);

  useEffect(() => {
    const node = streamRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, asking]);

  const starterPrompts = useMemo(() => {
    const first = readyMaterials.slice(0, 3).map((m) => m.name);
    if (first.length === 0) return [];
    return [
      `Explain the key ideas in "${truncate(first[0], 48)}"`,
      first[0] ? `What should I memorise from "${truncate(first[0], 48)}"?` : null,
      first[1] ? `Give me a step-by-step walkthrough of a topic in "${truncate(first[1], 48)}"` : null,
    ].filter(Boolean);
  }, [readyMaterials]);

  const ask = useCallback(
    async (text) => {
      const value = String(text ?? question).trim();
      if (value.length < 2) {
        notify('Type a question first.', 'warning');
        return;
      }
      if (readyMaterials.length === 0) {
        notify('Upload a study material first — there is nothing to teach from yet.', 'warning');
        return;
      }

      setAsking(true);
      setError(null);
      const optimistic = {
        role: 'user',
        content: value,
        mode,
        createdAt: new Date().toISOString(),
      };
      setMessages((list) => [...list, optimistic]);
      setQuestion('');

      try {
        const result = await api.ask({
          question: value,
          mode,
          length,
          materialIds: scope.length ? scope : null,
          sessionId,
        });

        setSessionId(result.sessionId);
        setMessages((list) => [
          ...list,
          {
            role: 'assistant',
            content: result.answer,
            mode,
            length,
            kind: result.kind,
            generationMode: result.generationMode,
            citations: result.citations,
            warnings: result.warnings,
            provenance: result.provenance,
            retrieval: result.retrieval,
            createdAt: new Date().toISOString(),
          },
        ]);
        loadSessions();
      } catch (err) {
        setError(err);
        notify(err.message, 'error');
      } finally {
        setAsking(false);
      }
    },
    [question, mode, length, scope, sessionId, readyMaterials.length, notify, loadSessions],
  );

  const startNewSession = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    setError(null);
    window.history.replaceState(null, '', '#/chat');
  }, []);

  return (
    <div className="page chat">
      <aside className="chat__sessions">
        <Card
          title="Study sessions"
          subtitle={sessions.length ? `${sessions.length} saved` : 'None saved yet'}
          actions={
            <Button variant="secondary" size="sm" icon="plus" onClick={startNewSession}>
              New
            </Button>
          }
        >
          {sessions.length === 0 ? (
            <p className="muted">Ask a question and it will be saved here automatically.</p>
          ) : (
            <ul className="session-list">
              {sessions.map((session) => (
                <li key={session.id} className={`session${session.id === sessionId ? ' is-active' : ''}`}>
                  <a className="session__link" href={`#/chat?session=${session.id}`}>
                    <span className="session__title">{truncate(session.title, 46)}</span>
                    <span className="session__meta">
                      {session.messageCount} msg · {formatRelative(session.updatedAt)}
                    </span>
                  </a>
                  <button
                    type="button"
                    className="session__delete"
                    aria-label={`Delete session ${session.title}`}
                    onClick={async () => {
                      try {
                        await api.deleteSession(session.id);
                        if (session.id === sessionId) startNewSession();
                        await loadSessions();
                        notify('Session deleted', 'success');
                      } catch (err) {
                        notify(err.message, 'error');
                      }
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </aside>

      <section className="chat__main">
        <Card
          title="Ask the AI Teacher"
          subtitle="Answers are restricted to what your uploaded material actually says."
          className="chat__card"
        >
          <div className="chat__stream" ref={streamRef} aria-live="polite">
            {messages.length === 0 ? (
              readyMaterials.length === 0 ? (
                <EmptyState
                  icon="library"
                  title="Upload something to teach from"
                  description="The AI Teacher only answers from your own documents, so an empty library means there is nothing to explain yet."
                  action={
                    <a className="ls-btn ls-btn--primary ls-btn--md" href="#/materials">
                      <Icon name="upload" size={17} />
                      <span>Add study material</span>
                    </a>
                  }
                />
              ) : (
                <div className="chat__intro">
                  <h3 className="chat__intro-title">What would you like to understand?</h3>
                  <p className="muted">
                    {readyMaterials.length} document{pluralise(readyMaterials.length, '', 's')} indexed ·{' '}
                    {readyMaterials.reduce((sum, m) => sum + (m.passageCount || 0), 0)} searchable passage
                    {pluralise(readyMaterials.reduce((sum, m) => sum + (m.passageCount || 0), 0), '', 's')}.
                  </p>
                  {starterPrompts.length ? (
                    <div className="chat__starters">
                      {starterPrompts.map((prompt) => (
                        <button key={prompt} type="button" className="starter" onClick={() => ask(prompt)}>
                          <Icon name="lightbulb" size={15} />
                          <span>{prompt}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            ) : (
              messages.map((message, index) => (
                <MessageBubble key={`${message.role}-${index}-${message.createdAt}`} message={message} onCitation={setSource} />
              ))
            )}

            {asking ? (
              <div className="msg msg--assistant">
                <div className="msg__avatar" aria-hidden="true">
                  <Icon name="teacher" size={18} />
                </div>
                <div className="msg__body">
                  <p className="ls-loading__label">
                    <Spinner size={16} /> Retrieving passages and composing an answer…
                  </p>
                </div>
              </div>
            ) : null}
          </div>

          {error ? (
            <div className="stack-sm">
              <ErrorPanel error={error} title="That question failed" onRetry={() => ask()} />
            </div>
          ) : null}

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              ask();
            }}
          >
            <ModeControls modes={modes} lengths={lengths} mode={mode} length={length} onMode={setMode} onLength={setLength} />
            <ModeHint modes={modes} mode={mode} />
            <ScopePicker materials={materials} selected={scope} onChange={setScope} />

            <div className="composer__input">
              <label className="sr-only" htmlFor="chat-question">
                Your question
              </label>
              <textarea
                id="chat-question"
                className="ls-input ls-input--area"
                rows={3}
                value={question}
                maxLength={config?.limits?.chatQuestionMaxChars ?? 2000}
                placeholder="Ask about a topic in your material, or paste a question you are stuck on…"
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    ask();
                  }
                }}
              />
              <div className="composer__actions">
                <span className="composer__count">
                  {question.length}/{config?.limits?.chatQuestionMaxChars ?? 2000} · Ctrl+Enter to send
                </span>
                <Button type="submit" icon="send" loading={asking} disabled={question.trim().length < 2}>
                  Ask
                </Button>
              </div>
            </div>
          </form>
        </Card>
      </section>

      <SourceModal citation={source} onClose={() => setSource(null)} />
    </div>
  );
}
