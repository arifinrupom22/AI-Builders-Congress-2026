/**
 * Account isolation.
 *
 * These tests run the real app with AUTH_MODE=required: identity comes from a
 * server-verified session cookie, and the X-Learner-Id header must be ignored.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';

const PASSWORD = 'correct horse battery staple';

function cookieFrom(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  const cookie = raw.find((value) => value.startsWith('ls_session='));
  return cookie ? cookie.split(';')[0] : null;
}

function client(baseUrl) {
  let cookie = null;
  let csrf = null;
  async function call(pathname, { method = 'GET', body, headers = {} } = {}) {
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(mutating && csrf ? { 'x-csrf-token': csrf } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    csrf = data?.csrfToken ?? csrf;
    return { status: res.status, body: data, res };
  }
  return {
    call,
    async register(email, { password = PASSWORD, displayName } = {}) {
      const out = await call('/api/auth/register', {
        method: 'POST',
        body: { email, password, displayName },
      });
      cookie = cookieFrom(out.res) ?? cookie;
      return out;
    },
    async login(email, password = PASSWORD) {
      const out = await call('/api/auth/login', { method: 'POST', body: { email, password } });
      cookie = cookieFrom(out.res) ?? cookie;
      return out;
    },
    async upload(name, contents) {
      const form = new FormData();
      form.append('file', new Blob([contents], { type: 'text/plain' }), name);
      const res = await fetch(`${baseUrl}/api/materials`, {
        method: 'POST',
        headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) },
        body: form,
      });
      return { status: res.status, body: await res.json() };
    },
    get csrf() {
      return csrf;
    },
    get cookie() {
      return cookie;
    },
  };
}

const MATERIAL_TEXT =
  'Photosynthesis is the process by which green plants convert light energy into chemical energy.\n\nThe Calvin cycle fixes carbon dioxide into glucose using ATP and NADPH.';

test('account mode: unauthenticated API calls are rejected, health stays public', async (t) => {
  const h = await createHarness({ env: { auth: { mode: 'required' } } });
  t.after(() => h.close());

  const anon = client(h.api.baseUrl);
  const materials = await anon.call('/api/materials');
  assert.equal(materials.status, 401);
  assert.equal(materials.body.error.code, 'authentication_required');

  const progress = await anon.call('/api/progress');
  assert.equal(progress.status, 401);

  const health = await anon.call('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.auth.mode, 'required');
  assert.equal(health.body.auth.authenticated, false);

  const config = await anon.call('/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.auth.mode, 'required');
  assert.equal(config.body.auth.accounts, true);
});

test('account mode: registration, session, sign-in and sign-out', async (t) => {
  const h = await createHarness({ env: { auth: { mode: 'required' } } });
  t.after(() => h.close());

  const alice = client(h.api.baseUrl);
  const registered = await alice.register('Alice@Example.com', { displayName: 'Alice' });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.user.email, 'alice@example.com');
  assert.equal(registered.body.user.displayName, 'Alice');
  assert.ok(!('passwordHash' in registered.body.user));

  const setCookie = registered.res.headers.getSetCookie().join('\n');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);

  const session = await alice.call('/api/auth/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.authenticated, true);
  assert.equal(session.body.user.email, 'alice@example.com');

  // Duplicate registration is a conflict, not a second account.
  const duplicate = await client(h.api.baseUrl).register('alice@example.com');
  assert.equal(duplicate.status, 409);

  // Wrong password and unknown email answer identically.
  const wrong = await client(h.api.baseUrl).login('alice@example.com', 'wrong password here');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'invalid_credentials');
  const unknown = await client(h.api.baseUrl).login('nobody@example.com', PASSWORD);
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error.code, 'invalid_credentials');

  const bob = client(h.api.baseUrl);
  const signedIn = await bob.login('alice@example.com');
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.user.id, registered.body.user.id);

  const out = await bob.call('/api/auth/logout', { method: 'POST' });
  assert.equal(out.status, 200);
  assert.match(out.res.headers.getSetCookie().join('\n'), /Max-Age=0/);

  const after = await bob.call('/api/materials');
  assert.equal(after.status, 401);
});

test('account mode: two accounts never see each other’s materials', async (t) => {
  const h = await createHarness({ env: { auth: { mode: 'required' } } });
  t.after(() => h.close());

  const alice = client(h.api.baseUrl);
  await alice.register('alice@example.com');
  const bob = client(h.api.baseUrl);
  const bobAccount = await bob.register('bob@example.com');

  const uploaded = await alice.upload('alice-notes.txt', MATERIAL_TEXT);
  assert.equal(uploaded.status, 201);
  const aliceMaterialId = uploaded.body.material.id;

  const bobList = await bob.call('/api/materials');
  assert.equal(bobList.status, 200);
  assert.deepEqual(bobList.body.materials, []);

  // A header naming another account is ignored in account mode.
  const spoofed = await bob.call('/api/materials', {
    headers: { 'x-learner-id': aliceMaterialId },
  });
  assert.equal(spoofed.status, 200);
  assert.deepEqual(spoofed.body.materials, []);

  const foreign = await bob.call(`/api/materials/${aliceMaterialId}`);
  assert.equal(foreign.status, 404);

  const deleteForeign = await bob.call(`/api/materials/${aliceMaterialId}`, { method: 'DELETE' });
  assert.equal(deleteForeign.status, 404);

  const aliceList = await alice.call('/api/materials');
  assert.equal(aliceList.body.materials.length, 1);
  assert.equal(aliceList.body.materials[0].id, aliceMaterialId);
  assert.notEqual(bobAccount.body.user.id, aliceMaterialId);
});

test('account mode: an invalid session cookie is cleared and treated as signed out', async (t) => {
  const h = await createHarness({ env: { auth: { mode: 'required' } } });
  t.after(() => h.close());

  const res = await fetch(`${h.api.baseUrl}/api/materials`, {
    headers: { cookie: 'ls_session=not-a-real-session-token-value' },
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.getSetCookie().join('\n'), /Max-Age=0/);
});

test('firebase mode: a rejected ID token is ignored on the public session route but refused elsewhere', async (t) => {
  const h = await createHarness({
    env: {
      auth: { mode: 'required' },
      firebase: { projectId: 'test-project', configured: true },
    },
  });
  t.after(() => h.close());

  // A stale or revoked token must not stop the app from booting: /auth/session
  // answers "signed out" instead of failing the whole page load.
  const session = await fetch(`${h.api.baseUrl}/api/auth/session`, {
    headers: { authorization: 'Bearer not-a-real-firebase-id-token' },
  });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user, null);

  const materials = await fetch(`${h.api.baseUrl}/api/materials`, {
    headers: { authorization: 'Bearer not-a-real-firebase-id-token' },
  });
  assert.equal(materials.status, 401);
  assert.equal((await materials.json()).error?.code, 'invalid_token');
});
