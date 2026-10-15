/**
 * LearnSphere AI — root application.
 *
 * Wires the shared store, the hash router and the page components together.
 * A single error boundary sits around everything so a render failure shows a
 * readable message instead of a blank page.
 */
import { Component, useEffect } from 'react';
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

function Runtime() {
  const route = useRoute();
  const { bootState, bootError } = useApp();
  const Page = resolveRoute(route);

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
          <p className="boot__text">Connecting to your local study server…</p>
          <LoadingPanel label="Loading configuration" rows={2} />
        </div>
      </div>
    );
  }

  if (bootState === 'offline') {
    const isHostedDeployment =
      !['localhost', '127.0.0.1', '::1'].includes(window.location.hostname) ||
      ['backend_not_configured', 'backend_unavailable', 'invalid_backend_url'].includes(bootError?.code);
    return (
      <div className="boot">
        <div className="boot__card">
          <span className="boot__mark boot__mark--warn">
            <Icon name="alert" size={26} />
          </span>
          <h1 className="boot__title">
            {isHostedDeployment ? 'Connect the LearnSphere API' : 'The study server is not running'}
          </h1>
          <p className="boot__text">
            {isHostedDeployment
              ? 'Netlify publishes the web app separately from its Express backend. Connect a deployed LearnSphere API to enable uploads, retrieval and progress.'
              : 'LearnSphere AI needs its local Express backend for retrieval, uploads and progress.'}
          </p>
          <Alert tone="warning" title={isHostedDeployment ? 'Finish the API deployment' : 'Start the backend, then reload'}>
            {isHostedDeployment ? (
              <>
                <p>
                  Deploy the backend from <code className="md-code">render.yaml</code>. Set{' '}
                  <code className="md-code">CORS_ALLOWED_ORIGINS</code> on the backend to this site's URL.
                  In Netlify, set <code className="md-code">VITE_API_BASE_URL</code> and{' '}
                  <code className="md-code">LEARNSPHERE_BACKEND_URL</code> to the backend URL, then redeploy.
                </p>
                <p className="muted-xs">Deploy from the repository or Netlify CLI so the API function is included; uploading only the static folder omits server-side functions.</p>
                {bootError?.code && !['http_error', 'backend_not_configured'].includes(bootError.code) ? (
                  <p className="muted-xs">{bootError.message}</p>
                ) : null}
              </>
            ) : (
              <>
                <p>
                  From the project folder run <code className="md-code">npm run dev</code>, which starts the
                  Express server on port 8787 and the Vite dev server on port 5173.
                </p>
                {bootError?.message ? <p className="muted-xs">{bootError.message}</p> : null}
              </>
            )}
          </Alert>
          <Button icon="refresh" onClick={() => window.location.reload()}>
            Reload
          </Button>
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
