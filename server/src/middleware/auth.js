/**
 * Request identity.
 *
 * Two modes, one code path:
 *
 *  - `local`    — a single-user/demo deployment. The study profile is the
 *                 client-asserted `X-Learner-Id` (sanitised). Health and the
 *                 Settings screen say plainly that this is not authentication.
 *  - `required` — a multi-user deployment. A signed-in account from an
 *                 HttpOnly session cookie is the ONLY identity; the
 *                 `X-Learner-Id` header is ignored, and every API route except
 *                 health/config/auth answers 401 without a session.
 *
 * Session cookies are SameSite=Lax and HttpOnly, so they are not readable from
 * JavaScript and are not sent on cross-site POSTs. Mutating endpoints also sit
 * behind the origin allowlist in middleware/security.js.
 */
import crypto from 'node:crypto';
import AppError from '../errors.js';
import { publicUser } from '../auth/service.js';

export const SESSION_COOKIE = 'ls_session';
export const CSRF_COOKIE = 'ls_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** Paths that stay reachable without an account (health probe, config, auth). */
export const PUBLIC_API_PATHS = new Set([
  '/api/health',
  '/api/config',
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/session',
  '/api/auth/logout',
  '/api/auth/password-reset/request',
  '/api/auth/password-reset/confirm',
]);

export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header.length === 0) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name || name in out) continue;
    const raw = part.slice(index + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export function sessionCookie(token, { maxAgeMs, secure }) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearedSessionCookie({ secure }) {
  const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * The CSRF token is deliberately readable by this origin's JavaScript so the
 * client can echo it in a header. It is not a credential on its own: it is
 * bound to a server-side session record and rejected without that cookie.
 */
export function csrfCookie(token, { maxAgeMs, secure }) {
  const attrs = [
    `${CSRF_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearedCsrfCookie({ secure }) {
  const attrs = [`${CSRF_COOKIE}=`, 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function hashesMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** True when the browser connection itself is HTTPS (behind a trusted proxy too). */
function isSecureRequest(req) {
  return req.secure === true || req.protocol === 'https';
}

/**
 * Attach the signed-in account when a valid session cookie is present.
 * In local mode a missing cookie simply leaves the profile-scoped identity in
 * place; in required mode the guard below rejects the request.
 */
export function attachSession({ config, authService, store = null, firebase = null }) {
  const mode = config.auth?.mode ?? 'local';
  return async (req, res, next) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[SESSION_COOKIE];
      req.auth = { mode, authenticated: false, user: null };

      // --- Firebase ID token -------------------------------------------------
      // A bearer token is checked before anything else. The uid is taken from
      // the verified token only: a client cannot name the account it wants to
      // be, and an unverified address never receives a working session.
      const authorization = req.get('authorization');
      if (firebase?.configured && typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
        const raw = authorization.slice('Bearer '.length).trim();
        const claims = raw ? await firebase.verifyIdToken(raw) : null;
        // The public auth routes must stay answerable. A stale, revoked or
        // unverified token is a normal "signed out" state there, not a broken
        // server - otherwise one bad token in storage stops the app booting at
        // all. Every protected route still refuses it.
        const rejectable = !PUBLIC_API_PATHS.has(req.path) && !PUBLIC_API_PATHS.has(`/api${req.path}`);

        if (!claims && rejectable) {
          throw new AppError('Your session has expired. Sign in again.', {
            status: 401,
            code: 'invalid_token',
            expose: true,
          });
        }
        if (claims && claims.emailVerified !== true && rejectable) {
          throw new AppError('Verify your email address before using LearnSphere AI. Check your inbox for the link.', {
            status: 403,
            code: 'email_not_verified',
            expose: true,
          });
        }
        if (claims && claims.emailVerified === true) {
          const account = store?.upsertFirebaseUser ? await store.upsertFirebaseUser(claims) : null;
          if (!account) {
            throw new AppError('This account could not be loaded. Try signing in again.', {
              status: 401,
              code: 'account_unavailable',
              expose: true,
            });
          }
          req.auth = {
            mode: 'required',
            authenticated: true,
            source: 'firebase',
            user: publicUser(account),
          };
          req.learnerId = account.id;
          res.setHeader('Cache-Control', 'no-store');
          return next();
        }
        // Otherwise fall through: a legacy session cookie, or an anonymous
        // visitor on a public route.
      }

      // Firebase is the only identity provider on a deployment that can verify
      // its tokens. A cookie session left over from the retired password
      // accounts must not authenticate here: Firebase never verified that
      // address, and the account rows it points at are not Firebase-owned.
      if (firebase?.configured) return next();

      if (token) {
        const session = await authService.sessionFromToken(token);
        if (session) {
          req.auth = {
            mode,
            authenticated: true,
            user: session.user,
            expiresAt: session.expiresAt,
            csrfHash: session.csrfHash ?? null,
          };
          // The account, not the browser, decides whose data this is.
          req.learnerId = session.user.id;
          res.setHeader('Cache-Control', 'no-store');
        } else if (mode === 'required') {
          res.setHeader('Set-Cookie', clearedSessionCookie({ secure: isSecureRequest(req) }));
        }
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireAuthentication({ config }) {
  const mode = config.auth?.mode ?? 'local';
  if (mode !== 'required') return (req, res, next) => next();

  return (req, res, next) => {
    if (req.auth?.authenticated) return next();
    if (PUBLIC_API_PATHS.has(req.path) || PUBLIC_API_PATHS.has(`/api${req.path}`)) return next();
    return next(
      new AppError('Sign in to use LearnSphere AI.', {
        status: 401,
        code: 'authentication_required',
        expose: true,
      }),
    );
  };
}

/**
 * Double-submit CSRF protection for cookie-authenticated state changes.
 *
 * Safe methods pass. Local mode (no cookie session) passes: there is no ambient
 * credential for another site to ride on. Account mode requires the header to
 * hash to the value bound to the session record.
 */
export function csrfGuard({ authService }) {
  const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
  return (req, res, next) => {
    if (SAFE.has(req.method)) return next();
    if (!req.auth?.authenticated) return next();
    // A bearer-token request carries no ambient credential, so there is nothing
    // for another origin to ride on: CSRF does not apply.
    if (req.auth.source === 'firebase') return next();
    // Signing in/out must work before a CSRF token exists.
    const path = req.originalUrl || req.url || '';
    if (path.startsWith('/api/auth/')) return next();

    const header = req.get(CSRF_HEADER);
    const expected = req.auth.csrfHash;
    if (!header || !expected || !hashesMatch(authService.hashToken(header), expected)) {
      return next(
        new AppError('This request could not be verified. Reload the page and try again.', {
          status: 403,
          code: 'csrf_failed',
          expose: true,
        }),
      );
    }
    return next();
  };
}

/**
 * A server-provisioned account starts with a temporary password. Until the owner
 * replaces it, every learning route is refused: the bootstrap credential can
 * change the password and nothing else.
 */
// Public reads the app cannot boot without, plus the one route that clears the
// flag. Without these the shell would fail to load and never reach the screen
// that asks for the new password.
const PASSWORD_CHANGE_ALLOWED_PATHS = new Set(['/config', '/health', '/account/password']);

export function requirePasswordChange() {
  return (req, res, next) => {
    if (!req.auth?.authenticated) return next();
    if (req.auth.user?.mustChangePassword !== true) return next();
    if (PASSWORD_CHANGE_ALLOWED_PATHS.has(req.path)) return next();
    return next(
      new AppError('Choose your own password before using LearnSphere AI.', {
        status: 403,
        code: 'password_change_required',
        expose: true,
      }),
    );
  };
}

export { isSecureRequest };
export default {
  attachSession,
  requireAuthentication,
  requirePasswordChange,
  csrfGuard,
  parseCookies,
  sessionCookie,
  clearedSessionCookie,
  csrfCookie,
  clearedCsrfCookie,
};
