/**
 * LearnSphere AI — root application.
 *
 * Wires the shared store, the hash router and the page components together.
 * A single error boundary sits around everything so a render failure shows a
 * readable message instead of a blank page.
 */
import { Component, useCallback, useEffect, useState } from 'react';
import { AppProvider, useApp } from './store/AppContext.jsx';
import { useRoute } from './lib/router.jsx';
import { AppShell } from './components/AppShell.jsx';
import { Alert, Button, LoadingPanel } from './components/ui.jsx';
import { Icon } from './components/Icons.jsx';

import HomePage from './pages/home.jsx';
import MaterialsPage from './pages/materials.jsx';
import ChatPage from './pages/chat.jsx';
import SummaryPage from './pages/summary.jsx';
import QuizPage from './pages/quiz.jsx';
import ProgressPage from './pages/progress.jsx';
import SettingsPage from './pages/settings.jsx';
import NotFoundPage from './pages/not-found.jsx';

const ROUTES = [
  { path: '/', Component: HomePage },
  { path: '/materials', Component: MaterialsPage },
  { path: '/summary', Component: SummaryPage },
  { path: '/chat', Component: ChatPage },
  { path: '/quiz', Component: QuizPage },
  { path: '/progress', Component: ProgressPage },
  { path: '/settings', Component: SettingsPage },
];

function resolveRoute(route) {
  const match = ROUTES.find((entry) => entry.path === route.path);
  return match?.Component ?? NotFoundPage;
}

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the technical detail in the console; the UI stays human-readable.
    console.error('LearnSphere AI render error', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash__panel">
          <Icon name="alert" size={26} />
          <h1>LearnSphere AI hit an unexpected error</h1>
          <p>{String(this.state.error?.message ?? this.state.error)}</p>
          <p className="muted-xs">The rest of the app is unaffected. Reload to recover.</p>
          <Button icon="refresh" onClick={() => window.location.reload()}>
            Reload the app
          </Button>
        </div>
      </div>
    );
  }
}

const CONFIG_ERROR_CODES = ['backend_not_configured', 'invalid_backend_url'];
// Codes only an API proxy produces. Seeing one means a hosted deployment is in
// the path, even on localhost (Netlify Dev, or the proxy run by hand).
const PROXY_ERROR_CODES = [...CONFIG_ERROR_CODES, 'backend_timeout', 'backend_unavailable'];

function Runtime() {
  const route = useRoute();
  const { bootState, bootError, bootAttempt, bootRetryLimit, reload } = useApp();
  const [retrying, setRetrying] = useState(false);
  const Page = resolveRoute(route);

  // Retry in place: nothing the student already has in this browser is cleared.
  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      await reload();
    } finally {
      setRetrying(false);
    }
  }, [reload]);

  // Each route starts at the top of the page.
  useEffect(() => {
    document.getElementById('content')?.scrollTo?.({ top: 0 });
    window.scrollTo({ top: 0 });
  }, [route.path]);

  if (bootState === 'loading') {
    return (
      <div className="boot">
        <div className="boot__card">
          <span className="boot__mark">
            <Icon name="compass" size={26} />
          </span>
          <h1 className="boot__title">LearnSphere AI</h1>
          <p className="boot__text">
            {bootAttempt > 0
              ? `Waking up the hosted API — a free-tier server sleeps when idle. Attempt ${bootAttempt + 1} of ${bootRetryLimit + 1}…`
              : 'Connecting to your study server…'}
          </p>
          <LoadingPanel label="Loading configuration" rows={2} />
        </div>
      </div>
    );
  }

  if (bootState === 'offline') {
    const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
    const isConfigProblem = CONFIG_ERROR_CODES.includes(bootError?.code);
    // Loopback means this is a dev machine, where the fix is to start Express —
    // unless the failure came from a proxy, which only exists in a deployment.
    const hosted = !isLoopback || PROXY_ERROR_CODES.includes(bootError?.code);
    const title = !hosted
      ? 'The study server is not running'
      : isConfigProblem
        ? 'Connect the LearnSphere API'
        : 'The LearnSphere API is not answering yet';

    return (
      <div className="boot">
        <div className="boot__card">
          <span className="boot__mark boot__mark--warn">
            <Icon name="alert" size={26} />
          </span>
          <h1 className="boot__title">{title}</h1>
          <p className="boot__text">
            {!hosted
              ? 'LearnSphere AI needs its local Express backend for retrieval, uploads and progress.'
              : isConfigProblem
                ? 'The web app is published, but its API function has no usable backend address.'
                : 'The request reached the API but it did not answer. A free-tier server can sleep when idle and needs a moment to start.'}
          </p>
          <Alert tone="warning" title={hosted ? (isConfigProblem ? 'Finish the API deployment' : 'Try again') : 'Start the backend, then reload'}>
            {!hosted ? (
              <>
                <p>
                  From the project folder run <code className="md-code">npm run dev</code>, which starts the
                  Express server on port 8787 and the Vite dev server on port 5173.
                </p>
                {bootError?.message ? <p className="muted-xs">{bootError.message}</p> : null}
              </>
            ) : isConfigProblem ? (
              <>
                <p>
                  Deploy the backend from <code className="md-code">render.yaml</code>, then in Netlify open{' '}
                  <strong>Project configuration → Environment variables</strong> and set{' '}
                  <code className="md-code">LEARNSPHERE_BACKEND_URL</code> to the backend URL. Its scope must
                  include <strong>Functions</strong>, and a new deploy is needed for the change to apply.
                </p>
                <p className="muted-xs">
                  The API function ships with this project's own backend as its default, so this message
                  normally means the whole function was not deployed. Deploy from the repository or the
                  Netlify CLI; uploading only the built static folder omits server-side functions.
                </p>
                {bootError?.message ? <p className="muted-xs">{bootError.message}</p> : null}
              </>
            ) : (
              <>
                <p>
                  Retrying here keeps your library, profile and drafts. If it stays down, the{' '}
                  <code className="md-code">/api/health</code> endpoint of the backend service can be checked
                  on its own.
                </p>
                {bootError?.message ? <p className="muted-xs">{bootError.message}</p> : null}
              </>
            )}
          </Alert>
          <div className="boot__actions">
            <Button icon="refresh" loading={retrying} onClick={retry}>
              {retrying ? 'Trying again…' : 'Try again'}
            </Button>
            <Button variant="ghost" icon="external" onClick={() => window.location.reload()}>
              Reload the page
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <AppShell route={route}>
      <Page route={route} />
    </AppShell>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <Runtime />
      </AppProvider>
    </ErrorBoundary>
  );
}

export default App;
