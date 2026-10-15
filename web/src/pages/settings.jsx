/**
 * Settings — configuration the student can actually see and change.
 *
 * The AI section states plainly whether a real model is in use, what the
 * provider's data policy is, and which environment variables are missing. The
 * API key itself is server-side only and is never sent to the browser, so it
 * cannot be displayed here even accidentally.
 */
import { useEffect, useState } from 'react';
import { useApp } from '../store/AppContext.jsx';
import { Icon } from '../components/Icons.jsx';
import { Alert, Badge, Button, Card, ErrorPanel, Field, StatTile } from '../components/ui.jsx';
import { formatBytes, formatNumber, pluralise } from '../lib/format.js';

const PROVIDER_IDS = ['none', 'groq', 'gemini', 'openrouter', 'mistral', 'cloudflare', 'custom'];

const ENV_SNIPPET = `# learnsphere-ai/.env
LEARNSPHERE_AI_PROVIDER=groq
LEARNSPHERE_AI_API_KEY=your-key-here
# optional: LEARNSPHERE_AI_MODEL=openai/gpt-oss-20b`;

function StudyProfileCard() {
  const { learnerId, setProfile, notify } = useApp();
  const [draft, setDraft] = useState(learnerId);

  useEffect(() => {
    setDraft(learnerId);
  }, [learnerId]);

  const valid = /^[A-Za-z0-9_-]{1,64}$/.test(draft.trim());

  return (
    <Card title="Study profile" subtitle="Keeps separate libraries side by side on this machine.">
      <Field
        label="Profile id"
        hint="Letters, numbers, dash and underscore. Switching profile switches which materials, sessions and quizzes you see."
        error={valid ? null : 'Use 1–64 characters: letters, numbers, dash or underscore only.'}
      >
        {({ id, ...aria }) => (
          <input
            id={id}
            className="ls-input"
            type="text"
            value={draft}
            maxLength={64}
            onChange={(e) => setDraft(e.target.value)}
            {...aria}
          />
        )}
      </Field>
      <div className="row-actions">
        <Button
          icon="check"
          disabled={!valid || draft.trim() === learnerId}
          onClick={() => {
            setProfile(draft);
            notify(`Switched to profile “${draft.trim()}”.`, 'success');
          }}
        >
          Switch profile
        </Button>
        <span className="muted-xs">Current profile: {learnerId}</span>
      </div>

      <Alert tone="warning" title="This is not authentication">
        <p>
          The profile id is asserted by this browser and used only to scope which rows the server reads
          and writes. It does not protect data from anyone else who can reach the server. Add real signed-in
          accounts before exposing LearnSphere AI to a network.
        </p>
      </Alert>
    </Card>
  );
}

export default function SettingsPage() {
  const { ai, config, health, materials, reload, notify, learnerId } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      // Report what actually happened: a reload that could not reach the API
      // used to announce success and leave the stale values on screen.
      const status = await reload();
      if (status === 'ready') notify('Configuration reloaded.', 'success');
      else if (status === 'offline') notify('The API is still unreachable. Try again in a moment.', 'error');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const limits = config?.limits;
  const stored = materials.reduce((sum, m) => sum + (m.sizeBytes || 0), 0);

  return (
    <div className="page">
      <Card
        title="Answer engine"
        subtitle="Whether answers come from a live model or the local extractive teacher."
        actions={
          <Button variant="ghost" size="sm" icon="refresh" loading={busy} onClick={refresh}>
            Reload
          </Button>
        }
      >
        {error ? <ErrorPanel error={error} title="Could not reload configuration" /> : null}

        <div className="kv-grid kv-grid--three">
          <div className="kv">
            <span className="kv__k">Mode</span>
            <span className="kv__v">
              <Badge tone={ai?.mode === 'live' ? 'success' : 'warning'} icon={ai?.mode === 'live' ? 'sparkles' : 'shield'}>
                {ai?.mode === 'live' ? 'Live AI' : 'Local only'}
              </Badge>
            </span>
          </div>
          <div className="kv">
            <span className="kv__k">Provider</span>
            <span className="kv__v">{ai?.label ?? '—'}</span>
          </div>
          <div className="kv">
            <span className="kv__k">Model</span>
            <span className="kv__v">{ai?.model || 'none configured'}</span>
          </div>
        </div>

        <Alert tone={ai?.mode === 'live' ? 'info' : 'success'} title="Data handling">
          <p>{ai?.privacy ?? 'No document text leaves this machine.'}</p>
          {ai?.providerTrainsOnData === false ? (
            <p className="muted-xs">This provider states that it does not train on your inputs or outputs.</p>
          ) : null}
          {ai?.providerTrainsOnData === true ? (
            <p className="muted-xs">This provider may use free-tier inputs to improve its models — avoid private material.</p>
          ) : null}
        </Alert>

        {ai?.missingEnvVars?.length ? (
          <Alert tone="warning" title="Live AI is not fully configured">
            <p>Set these environment variables in the project <code className="md-code">.env</code> file, then restart the server:</p>
            <ul className="ls-list ls-list--compact">
              {ai.missingEnvVars.map((name) => (
                <li key={name}>
                  <code className="md-code">{name}</code>
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}

        <h3 className="subhead">Optional: enable a live model</h3>
        <p className="muted">
          The app is fully usable without a key. Adding one upgrades the wording of answers and quizzes;
          retrieval, citations and the quiz fallback stay exactly the same.
        </p>
        <pre className="code-block">{ENV_SNIPPET}</pre>
        <p className="muted-xs">
          Supported provider ids:{' '}
          {PROVIDER_IDS.map((id) => (
            <span key={id} className="term-chip">
              {id}
            </span>
          ))}
        </p>
        <p className="muted-xs">
          See <code className="md-code">.env.example</code> in the project root for the full list, including
          per-provider privacy notes. The API key is read only by the server and is never sent to this page.
        </p>
      </Card>

      <StudyProfileCard />

      <Card title="Retrieval and limits" subtitle="What the server enforces for this profile.">
        <div className="kv-grid kv-grid--three">
          <div className="kv">
            <span className="kv__k">Passages per answer</span>
            <span className="kv__v">{config?.retrieval?.topK ?? '—'}</span>
          </div>
          <div className="kv">
            <span className="kv__k">Confidence threshold</span>
            <span className="kv__v">{config?.retrieval?.minScore ?? '—'}</span>
          </div>
          <div className="kv">
            <span className="kv__k">Max upload size</span>
            <span className="kv__v">{formatBytes(limits?.maxUploadBytes ?? 0)}</span>
          </div>
          <div className="kv">
            <span className="kv__k">Documents per profile</span>
            <span className="kv__v">{limits?.maxDocuments ?? '—'}</span>
          </div>
          <div className="kv">
            <span className="kv__k">Accepted file types</span>
            <span className="kv__v">{(limits?.allowedExtensions ?? []).join(' · ') || '—'}</span>
          </div>
          <div className="kv">
            <span className="kv__k">Max quiz questions</span>
            <span className="kv__v">{limits?.maxQuizQuestions ?? '—'}</span>
          </div>
        </div>
        <p className="muted-xs">
          A passage is only used when its IDF-weighted term coverage reaches the confidence threshold.
          Below it, the teacher refuses to answer instead of guessing from a weak match.
        </p>
      </Card>

      <Card title="Your data" subtitle="Everything is stored on this machine.">
        <div className="stat-row stat-row--compact">
          <StatTile label="Documents" value={formatNumber(materials.length)} hint={`${formatBytes(stored)} stored`} icon="file" />
          <StatTile label="Indexed passages" value={formatNumber(health?.store?.passages ?? 0)} icon="database" />
          <StatTile label="Sessions" value={formatNumber(health?.store?.sessions ?? 0)} icon="teacher" />
          <StatTile label="Quiz attempts" value={formatNumber(health?.store?.attempts ?? 0)} icon="quiz" />
        </div>

        <p className="muted">
          Removing a document deletes its stored file, its passages and its index entry. Session history and
          quiz attempts can be deleted from their own screens.
        </p>

        {health?.notes?.length ? (
          <Alert tone="info" title="Server notes">
            <ul className="ls-list ls-list--compact">
              {health.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </Card>

      <Card title="About" subtitle="Build and provenance.">
        <div className="kv-grid kv-grid--three">
          <div className="kv">
            <span className="kv__k">Version</span>
            <span className="kv__v">v{config?.appVersion ?? health?.version ?? '—'}</span>
          </div>
          <div className="kv">
            <span className="kv__k">Environment</span>
            <span className="kv__v">{health?.environment ?? '—'}</span>
          </div>
          <div className="kv">
            <span className="kv__k">Server uptime</span>
            <span className="kv__v">
              {health?.uptimeSeconds != null ? `${formatNumber(health.uptimeSeconds)} s` : '—'}
            </span>
          </div>
          <div className="kv">
            <span className="kv__k">Study profile</span>
            <span className="kv__v">{learnerId}</span>
          </div>
          <div className="kv">
            <span className="kv__k">Indexed documents</span>
            <span className="kv__v">
              {formatNumber(health?.retrieval?.indexedMaterials ?? 0)} ·{' '}
              {formatNumber(health?.retrieval?.uniqueTerms ?? 0)} unique terms
            </span>
          </div>
          <div className="kv">
            <span className="kv__k">Last index build</span>
            <span className="kv__v">{health?.retrieval?.builtAt ? health.retrieval.builtAt.slice(11, 19) + ' UTC' : '—'}</span>
          </div>
        </div>

        <ul className="about-list">
          <li>
            <Icon name="flag" size={15} /> International AI Builders Congress 2026 — Challenge: AI Teacher
          </li>
          <li>
            <Icon name="user" size={15} /> Team NITER_Parallax
          </li>
          <li>
            <Icon name="shield" size={15} /> Answers are verified against retrieved passages; invented citations are
            stripped before display.
          </li>
          <li>
            <Icon name="target" size={15} /> LearnSphere AI does not measure mastery, ability or learning gain.
          </li>
        </ul>
        <p className="muted-xs">
          {materials.length} document{pluralise(materials.length, '', 's')} in this profile.
        </p>
      </Card>
    </div>
  );
}
