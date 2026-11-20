/**
 * Firebase-only identity.
 *
 * Two rules are enforced here and neither is visible from the client:
 *
 *  1. When the server can verify Firebase tokens, an unverified address never
 *     gets a working identity, and a leftover cookie session from the retired
 *     password accounts cannot stand in for one.
 *  2. The password endpoints must not be able to mint an account or a session on
 *     such a deployment: that account would be an identity Firebase never
 *     verified, which is exactly the bypass this test guards against.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import { attachSession } from '../src/middleware/auth.js';
import { authRouter } from '../src/routes/auth.js';

const CONFIG = Object.freeze({
  auth: { mode: 'required', registrationPolicy: 'open', sessionTtlDays: 14 },
  firebase: { configured: true, projectId: 'learnsphere-test' },
});

function claims(overrides = {}) {
  return { uid: 'firebase-uid-1', email: 'learner@example.com', emailVerified: true, displayName: 'Learner', ...overrides };
}

/** A request shaped the way Express hands it to the middleware. */
function request({ path = '/materials', authorization = null, cookie = null } = {}) {
  const headers = {};
  if (authorization) headers.authorization = `Bearer ${authorization}`;
  if (cookie) headers.cookie = cookie;
  return {
    path,
    headers,
    get(name) {
      return headers[String(name).toLowerCase()];
    },
  };
}

const RESPONSE = { setHeader() {} };

/** Run attachSession and report what it decided. */
async function decide(req, { token = null, session = null } = {}) {
  const firebase = {
    configured: true,
    verifyIdToken: async (raw) => (typeof token === 'function' ? token(raw) : token),
  };
  const authService = {
    sessionFromToken: async () => session,
  };
  const store = {
    upsertFirebaseUser: async (verified) => ({
      id: 'account-1',
      email: verified.email,
      displayName: verified.displayName,
      onboardingCompleted: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  };
  let passed = null;
  await new Promise((resolve) => {
    attachSession({ config: CONFIG, authService, store, firebase })(req, RESPONSE, (err) => {
      passed = err ?? 'next';
      resolve();
    });
    // A middleware that calls next synchronously resolves the promise above.
  });
  return { error: passed === 'next' ? null : passed, req };
}

test('an unverified Firebase token is refused on a protected route', async () => {
  const { error } = await decide(request({ path: '/materials', authorization: 'id-token' }), {
    token: claims({ emailVerified: false }),
  });

  assert.ok(error, 'the request must not continue');
  assert.equal(error.status, 403);
  assert.equal(error.code, 'email_not_verified');
  assert.match(error.message, /verify your email/i);
});

test('an unverified Firebase token gets no identity on a public route either', async () => {
  const { error, req } = await decide(request({ path: '/auth/session', authorization: 'id-token' }), {
    token: claims({ emailVerified: false }),
    // A cookie session exists in this browser: it must not rescue the request.
    session: { user: { id: 'legacy-account' }, expiresAt: '2999-01-01T00:00:00.000Z', csrfHash: null },
  });

  assert.equal(error, null);
  assert.equal(req.auth.authenticated, false);
  assert.equal(req.auth.user, null);
});

test('a verified Firebase token resolves the account from the token only', async () => {
  const { error, req } = await decide(request({ path: '/materials', authorization: 'id-token' }), {
    token: claims,
  });

  assert.equal(error, null);
  assert.equal(req.auth.authenticated, true);
  assert.equal(req.auth.source, 'firebase');
  assert.equal(req.auth.user.id, 'account-1');
  assert.equal(req.learnerId, 'account-1');
});

test('a legacy cookie session cannot authenticate on a Firebase deployment', async () => {
  const { error, req } = await decide(request({ path: '/materials', cookie: 'ls_session=legacy-token-value-1234' }), {
    session: { user: { id: 'legacy-account' }, expiresAt: '2999-01-01T00:00:00.000Z', csrfHash: null },
  });

  assert.equal(error, null);
  assert.equal(req.auth.authenticated, false);
  assert.equal(req.learnerId, undefined);
});

test('an invalid Firebase token is a 401 on a protected route', async () => {
  const { error } = await decide(request({ path: '/materials', authorization: 'expired-token' }), { token: null });

  assert.equal(error?.status, 401);
  assert.equal(error?.code, 'invalid_token');
});

test('the password endpoints are closed when Firebase is the identity provider', async () => {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/auth',
    authRouter({
      config: CONFIG,
      authService: {
        register: async () => assert.fail('register must not run'),
        login: async () => assert.fail('login must not run'),
        requestPasswordReset: async () => assert.fail('reset must not run'),
        resetPassword: async () => assert.fail('reset must not run'),
        logout: async () => {},
      },
    }),
  );
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const [path, body] of [
      ['/api/auth/register', { email: 'learner@example.com', password: 'long-enough-password' }],
      ['/api/auth/login', { email: 'learner@example.com', password: 'long-enough-password' }],
      ['/api/auth/password-reset/request', { email: 'learner@example.com' }],
    ]) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      assert.equal(response.status, 403, `${path} must be closed`);
      assert.equal(payload.error.code, 'firebase_identity_required');
      assert.equal(response.headers.get('set-cookie'), null, `${path} must not issue a session`);
    }

    // The session probe and sign-out stay answerable, so the app can boot.
    const session = await fetch(`${base}/api/auth/session`);
    assert.equal(session.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
