/**
 * Sign in, create account and password reset.
 *
 * One component, three routes. The forms talk to the real auth API: the server
 * hashes the password, sets an HttpOnly session cookie and returns the public
 * user shape. Nothing secret is written to localStorage; only the CSRF token,
 * which is not a credential on its own, is echoed from its cookie.
 */
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../store/AppContext.jsx';
import { PublicChrome } from '../components/PublicChrome.jsx';
import { Icon } from '../components/Icons.jsx';
import { BrandLogo } from '../components/BrandLogo.jsx';
import { Alert, Button, Field } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.jsx';

const MIN_PASSWORD = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function safeNext(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Only same-app hash paths: never an absolute or protocol-relative URL.
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}

function PasswordInput({ id, value, onChange, autoComplete, creating = false, aria }) {
  const { t } = useApp();
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-field">
      <input
        id={id}
        className="ls-input password-field__input"
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        required
        minLength={creating ? MIN_PASSWORD : undefined}
        spellCheck="false"
        {...aria}
      />
      <button
        type="button"
        className="password-field__toggle"
        aria-label={visible ? t('auth.hidePassword') : t('auth.showPassword')}
        aria-pressed={visible}
        onClick={() => setVisible((open) => !open)}
      >
        <Icon name={visible ? 'eyeOff' : 'eye'} size={17} />
      </button>
    </div>
  );
}

function AuthError({ error, title }) {
  if (!error) return null;
  return (
    <Alert tone="error" title={title}>
      <p>{error.message}</p>
      {error.fields?.length ? (
        <ul className="ls-list ls-list--compact">
          {error.fields.map((field) => (
            <li key={`${field.path}-${field.message}`}>
              <strong>{field.path}</strong>: {field.message}
            </li>
          ))}
        </ul>
      ) : null}
    </Alert>
  );
}

function LoginForm({ next }) {
  const { t, signIn } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const emailValid = EMAIL_RE.test(email.trim());
  const canSubmit = emailValid && password.length > 0 && !busy;

  async function submit(event) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      navigate(next ?? '/dashboard');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth__form" onSubmit={submit} noValidate>
      <AuthError error={error} title={t('auth.loginFailed')} />

      <Field label={t('auth.email')} hint={t('auth.emailHint')} error={email && !emailValid ? t('auth.emailInvalid') : null}>
        {({ id, ...aria }) => (
          <input
            id={id}
            className="ls-input"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={email.length > 0 && !emailValid ? 'true' : undefined}
            {...aria}
          />
        )}
      </Field>

      <Field label={t('auth.password')}>
        {({ id, ...aria }) => (
          <PasswordInput
            id={id}
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            aria={aria}
          />
        )}
      </Field>

      <Button type="submit" icon="lock" loading={busy} disabled={!canSubmit}>
        {busy ? t('auth.working') : t('auth.signIn')}
      </Button>

      <div className="auth__links">
        <a href="#/reset">{t('auth.forgot')}</a>
        <span>
          {t('auth.noAccount')}{' '}
          <a href={`#/signup${next ? `?next=${encodeURIComponent(next)}` : ''}`}>{t('welcome.ctaSignup')}</a>
        </span>
      </div>
    </form>
  );
}

function SignupForm({ next }) {
  const { t, registerAccount, config } = useApp();
  const invitationOnly = config?.auth?.invitationOnly !== false;
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const emailValid = EMAIL_RE.test(email.trim());
  const passwordValid = password.length >= MIN_PASSWORD;
  const matches = confirm.length === 0 || confirm === password;
  const canSubmit = emailValid && passwordValid && confirm === password && !busy;

  async function submit(event) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await registerAccount(email.trim(), password, displayName.trim() || undefined);
      // A Firebase sign-up has no session yet: the email must be verified
      // first, so the form stays put and the toast explains the next step.
      if (result?.needsVerification) return;
      navigate(next ?? '/onboarding');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth__form" onSubmit={submit} noValidate>
      <AuthError error={error} title={t('auth.signupFailed')} />

      {invitationOnly ? (
        <Alert tone="info" title={t('auth.inviteOnlyTitle')}>
          <p>{t('auth.inviteOnlyBody')}</p>
        </Alert>
      ) : null}

      <Field label={t('auth.displayName')} hint={t('auth.displayNameHint')}>
        {({ id, ...aria }) => (
          <input
            id={id}
            className="ls-input"
            type="text"
            autoComplete="nickname"
            maxLength={60}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            {...aria}
          />
        )}
      </Field>

      <Field label={t('auth.email')} hint={t('auth.emailHint')} error={email && !emailValid ? t('auth.emailInvalid') : null}>
        {({ id, ...aria }) => (
          <input
            id={id}
            className="ls-input"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={email.length > 0 && !emailValid ? 'true' : undefined}
            {...aria}
          />
        )}
      </Field>

      <Field
        label={t('auth.password')}
        hint={t('auth.passwordHint', { min: MIN_PASSWORD })}
        error={password && !passwordValid ? t('auth.passwordShort', { min: MIN_PASSWORD }) : null}
      >
        {({ id, ...aria }) => (
          <PasswordInput
            id={id}
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            creating
            aria={aria}
          />
        )}
      </Field>

      <Field
        label={`${t('auth.password')} (2)`}
        error={!matches ? `${t('auth.passwordShort', { min: MIN_PASSWORD })}` : null}
      >
        {({ id, ...aria }) => (
          <PasswordInput
            id={id}
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            creating
            aria={!matches ? { 'aria-invalid': 'true' } : aria}
          />
        )}
      </Field>

      <Button type="submit" icon="user" loading={busy} disabled={!canSubmit}>
        {busy ? t('auth.working') : t('auth.createAccount')}
      </Button>

      <div className="auth__links">
        <span>
          {t('auth.haveAccount')}{' '}
          <a href={`#/login${next ? `?next=${encodeURIComponent(next)}` : ''}`}>{t('auth.signIn')}</a>
        </span>
      </div>
    </form>
  );
}

function ResetForm() {
  const { t, config } = useApp();
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [devToken, setDevToken] = useState(null);
  const [message, setMessage] = useState(null);
  const [requesting, setRequesting] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const emailValid = EMAIL_RE.test(email.trim());
  const passwordValid = password.length >= MIN_PASSWORD;
  const matches = confirm === password;

  async function request(event) {
    event.preventDefault();
    if (!emailValid || requesting) return;
    setRequesting(true);
    setError(null);
    try {
      if (config?.auth?.provider === 'firebase') {
        const { firebaseSendPasswordReset } = await import('../lib/firebase.js');
        await firebaseSendPasswordReset(email.trim());
        setMessage(t('reset.sent'));
        setDone(true);
        return;
      }
      const result = await api.requestPasswordReset(email.trim());
      setMessage(result.message ?? t('reset.sent'));
      if (result.devToken) {
        setDevToken(result.devToken);
        setToken(result.devToken);
      }
    } catch (err) {
      setError(err);
    } finally {
      setRequesting(false);
    }
  }

  async function confirmReset(event) {
    event.preventDefault();
    if (!token.trim() || !passwordValid || !matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.confirmPasswordReset({ token: token.trim(), password });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth__form">
      <AuthError error={error} title={t('reset.title')} />

      {done ? (
        <Alert tone="success" title={t('reset.done')}>
          <p>
            <a href="#/login">{t('reset.backToLogin')}</a>
          </p>
        </Alert>
      ) : (
        <>
          <form className="auth__form" onSubmit={request} noValidate>
            <Field label={t('auth.email')} hint={t('auth.emailHint')} error={email && !emailValid ? t('auth.emailInvalid') : null}>
              {({ id, ...aria }) => (
                <input
                  id={id}
                  className="ls-input"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  {...aria}
                />
              )}
            </Field>
            <Button type="submit" variant="secondary" icon="mail" loading={requesting} disabled={!emailValid}>
              {requesting ? t('reset.requesting') : t('reset.request')}
            </Button>
          </form>

          {message ? (
            <Alert tone="info" title={config?.auth?.passwordReset?.emailConfigured ? t('reset.emailConfigured') : t('reset.notConfigured')}>
              <p>{message}</p>
            </Alert>
          ) : null}

          {devToken ? (
            <Alert tone="warning" title={t('reset.devTitle')}>
              <p>{t('reset.devBody')}</p>
              <code className="md-code reset__token">{devToken}</code>
            </Alert>
          ) : null}

          <hr className="auth__divider" />

          <form className="auth__form" onSubmit={confirmReset} noValidate>
            <Field label={t('reset.token')}>
              {({ id, ...aria }) => (
                <input
                  id={id}
                  className="ls-input"
                  type="text"
                  autoComplete="one-time-code"
                  spellCheck="false"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  {...aria}
                />
              )}
            </Field>

            <Field
              label={t('reset.newPassword')}
              hint={t('auth.passwordHint', { min: MIN_PASSWORD })}
              error={password && !passwordValid ? t('auth.passwordShort', { min: MIN_PASSWORD }) : null}
            >
              {({ id, ...aria }) => (
                <PasswordInput id={id} value={password} onChange={setPassword} autoComplete="new-password" creating aria={aria} />
              )}
            </Field>

            <Field label={`${t('reset.newPassword')} (2)`} error={confirm && !matches ? t('auth.passwordShort', { min: MIN_PASSWORD }) : null}>
              {({ id, ...aria }) => (
                <PasswordInput id={id} value={confirm} onChange={setConfirm} autoComplete="new-password" creating aria={aria} />
              )}
            </Field>

            <Button type="submit" icon="lock" loading={busy} disabled={!token.trim() || !passwordValid || !matches}>
              {busy ? t('reset.confirming') : t('reset.confirm')}
            </Button>
          </form>
        </>
      )}

      <div className="auth__links">
        <a href="#/login">{t('reset.backToLogin')}</a>
      </div>
    </div>
  );
}

export default function AuthPage({ route }) {
  const { t, config } = useApp();
  const view = route?.path === '/signup' ? 'signup' : route?.path === '/reset' ? 'reset' : 'login';
  const next = useMemo(() => safeNext(route?.params?.get?.('next')), [route]);
  const [announce, setAnnounce] = useState('');

  // Route changes should be announced and the page title kept in sync.
  useEffect(() => {
    const title = view === 'signup' ? t('auth.signupTitle') : view === 'reset' ? t('reset.title') : t('auth.loginTitle');
    document.title = `${title} · LearnSphere AI`;
    setAnnounce(title);
  }, [view, t]);

  return (
    <PublicChrome>
      <div className="auth">
        <div className="auth__panel">
          <div className="auth__brand">
            <BrandLogo size={46} />
            <div>
              <h1>
                {view === 'signup' ? t('auth.signupTitle') : view === 'reset' ? t('reset.title') : t('auth.loginTitle')}
              </h1>
              <p>
                {view === 'signup' ? t('auth.signupLead') : view === 'reset' ? t('reset.lead') : t('auth.loginLead')}
              </p>
            </div>
          </div>

          <p className="visually-hidden" role="status" aria-live="polite">
            {announce}
          </p>

          {view === 'login' ? <LoginForm next={next} /> : null}
          {view === 'signup' ? <SignupForm next={next} /> : null}
          {view === 'reset' ? <ResetForm /> : null}

          <p className="auth__note muted-xs">
            <Icon name="shield" size={14} /> {t('auth.sessionNote')}
          </p>
        </div>
      </div>
    </PublicChrome>
  );
}

export { PasswordInput, MIN_PASSWORD };
