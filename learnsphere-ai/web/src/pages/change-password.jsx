/**
 * First sign-in: replace the temporary password.
 *
 * Server-provisioned accounts arrive with a bootstrap password whose only
 * useful function is to be replaced. The API refuses every learning route while
 * `mustChangePassword` is set, and this screen is the only thing the shell will
 * show until it is cleared.
 */
import { useState } from 'react';
import { useApp } from '../store/AppContext.jsx';
import { PublicChrome } from '../components/PublicChrome.jsx';
import { BrandLogo } from '../components/BrandLogo.jsx';
import { Alert, Button, Field } from '../components/ui.jsx';
import { PasswordInput, MIN_PASSWORD } from './auth.jsx';
import { navigate } from '../lib/router.jsx';

export default function ChangePasswordPage() {
  const { auth, changePassword, t, notify } = useApp();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const longEnough = newPassword.length >= MIN_PASSWORD;
  const matches = confirm.length > 0 && confirm === newPassword;
  const differs = newPassword.length > 0 && newPassword !== currentPassword;
  const canSubmit = currentPassword.length > 0 && longEnough && matches && differs && !busy;

  async function submit(event) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await changePassword(currentPassword, newPassword);
      notify('Password saved. Welcome to LearnSphere AI.', 'success');
      navigate('/dashboard');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicChrome>
      <div className="auth">
        <div className="auth__panel">
          <div className="auth__brand">
            <BrandLogo size={46} />
            <div>
              <h1>Set your own password</h1>
              <p>
                {auth.user?.displayName ? `${auth.user.displayName}, your` : 'Your'} account still uses the temporary
                password it was created with. Choose a private one to open your library.
              </p>
            </div>
          </div>

          {error ? (
            <Alert tone="error" title="Password not changed">
              <p>{error.message}</p>
            </Alert>
          ) : null}

          <form className="auth__form" onSubmit={submit} noValidate>
            <Field label="Temporary password" hint="The password you just signed in with.">
              {({ id, ...aria }) => (
                <PasswordInput
                  id={id}
                  value={currentPassword}
                  onChange={setCurrentPassword}
                  autoComplete="current-password"
                  aria={aria}
                />
              )}
            </Field>

            <Field
              label="New password"
              hint={t('auth.passwordHint', { min: MIN_PASSWORD })}
              error={newPassword && !longEnough ? t('auth.passwordShort', { min: MIN_PASSWORD }) : null}
            >
              {({ id, ...aria }) => (
                <PasswordInput
                  id={id}
                  value={newPassword}
                  onChange={setNewPassword}
                  autoComplete="new-password"
                  creating
                  aria={aria}
                />
              )}
            </Field>

            <Field
              label="New password again"
              error={confirm && !matches ? 'The two passwords do not match.' : null}
            >
              {({ id, ...aria }) => (
                <PasswordInput
                  id={id}
                  value={confirm}
                  onChange={setConfirm}
                  autoComplete="new-password"
                  creating
                  aria={aria}
                />
              )}
            </Field>

            <Button type="submit" icon="lock" loading={busy} disabled={!canSubmit}>
              {busy ? t('auth.working') : 'Save password and continue'}
            </Button>
          </form>

          <p className="auth__note muted-xs">
            Changing your password signs out your other devices. Your study material is never affected.
          </p>
        </div>
      </div>
    </PublicChrome>
  );
}
