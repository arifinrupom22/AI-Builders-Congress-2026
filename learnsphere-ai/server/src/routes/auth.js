/**
 * Account routes: register, sign in, sign out, current session.
 *
 * Responses never include a password hash, a session token, or the internal
 * user record. The token travels only in an HttpOnly cookie.
 */
import express from 'express';
import { z } from 'zod';
import AppError from '../errors.js';
import { parseBody } from './validate.js';
import { PASSWORD_MAX, PASSWORD_MIN } from '../auth/service.js';
import { rateLimit } from '../middleware/context.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  clearedCsrfCookie,
  clearedSessionCookie,
  csrfCookie,
  isSecureRequest,
  parseCookies,
  sessionCookie,
} from '../middleware/auth.js';

const email = z.string().trim().min(3).max(254);
const password = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);
const displayName = z.string().trim().max(60).optional();

// Sign-in accepts any non-empty password: a server-provisioned bootstrap
// credential is shorter than the normal minimum on purpose, and the account it
// belongs to is restricted to the password screen until it is replaced.
const loginPassword = z.string().min(1).max(PASSWORD_MAX);
const registerBody = z.object({ email, password, displayName });
const loginBody = z.object({ email, password: loginPassword });
const resetRequestBody = z.object({ email });
const resetConfirmBody = z.object({ token: z.string().min(20).max(200), password });

export function authRouter({ config, authService }) {
  const router = express.Router();

  // Credential endpoints are limited per IP only: limiting per email would let
  // an attacker lock a known account out, and there is no identity yet.
  const loginLimit = rateLimit({ windowMs: 60_000, max: 10, scope: 'ip', name: 'auth' });
  const registerLimit = rateLimit({ windowMs: 10 * 60_000, max: 8, scope: 'ip', name: 'auth' });
  const resetLimit = rateLimit({ windowMs: 15 * 60_000, max: 6, scope: 'ip', name: 'auth-reset' });

  // Local/demo deployments have no accounts. Say so instead of creating a
  // session that the identity layer would not use for authorization.
  function requireAccounts(req, res, next) {
    if (config.auth.mode === 'required') return next();
    return next(
      new AppError('Accounts are not enabled on this deployment.', {
        status: 400,
        code: 'accounts_disabled',
        expose: true,
      }),
    );
  }

  function sendSession(res, req, { user, session }, status = 200) {
    const maxAgeMs = Math.max(0, Date.parse(session.expiresAt) - Date.now());
    const secure = isSecureRequest(req);
    // Two cookies: the HttpOnly session, and a JS-readable CSRF token that is
    // echoed back in a header on state-changing requests.
    res.append('Set-Cookie', sessionCookie(session.token, { maxAgeMs, secure }));
    res.append('Set-Cookie', csrfCookie(session.csrfToken, { maxAgeMs, secure }));
    res.status(status).json({
      user,
      mode: config.auth.mode,
      expiresAt: session.expiresAt,
      // Same value as the ls_csrf cookie, for clients whose cookie jar is
      // managed by a proxy and for the first render after a redirect.
      csrfToken: session.csrfToken,
    });
  }

  router.get('/session', (req, res) => {
    res.json({
      user: req.auth?.user ?? null,
      authenticated: Boolean(req.auth?.authenticated),
      mode: config.auth.mode,
      // Local mode is a single-user demo: the profile header scopes data but
      // does not protect it. The UI repeats this warning.
      limitations:
        config.auth.mode === 'local'
          ? ['This deployment uses study profiles, not accounts. Anyone who can reach the API can use any profile id.']
          : [],
    });
  });

  router.post('/register', requireAccounts, registerLimit, async (req, res) => {
    const body = parseBody(registerBody, req.body);
    const result = await authService.register(body);
    req.log.info('account created', { userId: result.user.id });
    sendSession(res, req, result, 201);
  });

  router.post('/login', requireAccounts, loginLimit, async (req, res) => {
    const body = parseBody(loginBody, req.body);
    // A pre-login session is replaced, never reused.
    const previousToken = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
    const result = await authService.login({ ...body, previousToken });
    if (!result) {
      // One message for both unknown email and wrong password.
      throw new AppError('Email or password is not correct.', {
        status: 401,
        code: 'invalid_credentials',
        expose: true,
      });
    }
    req.log.info('signed in', { userId: result.user.id });
    sendSession(res, req, result);
  });

  /**
   * Password reset, step 1. The answer is identical for a known and an unknown
   * address. No email provider is bundled: where the deployment allows it, the
   * one-time token is returned so the flow can be completed locally; otherwise
   * it is only usable by whoever can read the configured inbox (not set up).
   */
  router.post('/password-reset/request', requireAccounts, resetLimit, async (req, res) => {
    const body = parseBody(resetRequestBody, req.body);
    const result = await authService.requestPasswordReset(body.email);
    const canDeliverDev = Boolean(config.auth.devReset && result.token);
    res.status(202).json({
      ok: true,
      message: 'If that email has an account, a reset token has been created. It expires in 30 minutes.',
      devToken: canDeliverDev ? result.token : undefined,
      delivery: canDeliverDev ? 'dev' : 'unconfigured',
    });
  });

  /** Password reset, step 2. Signs every existing device out. */
  router.post('/password-reset/confirm', requireAccounts, resetLimit, async (req, res) => {
    const body = parseBody(resetConfirmBody, req.body);
    await authService.resetPassword(body);
    res.json({ ok: true, message: 'Password updated. Sign in with your new password.' });
  });

  router.post('/logout', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    await authService.logout(cookies[SESSION_COOKIE]);
    const secure = isSecureRequest(req);
    res.append('Set-Cookie', clearedSessionCookie({ secure }));
    res.append('Set-Cookie', clearedCsrfCookie({ secure }));
    res.json({ ok: true });
  });

  return router;
}

export default authRouter;
