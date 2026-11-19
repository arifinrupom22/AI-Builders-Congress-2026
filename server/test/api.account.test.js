/**
 * Accounts, CSRF, session rotation, password reset, export and deletion.
 *
 * Each test boots the real app in AUTH_MODE=required and talks to it over HTTP
 * with the same cookie jar and CSRF header the browser uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';

const PASSWORD = 'correct horse battery staple';
const TEXT =
  'Photosynthesis is the process by which green plants convert light energy into chemical energy.\n\nThe Calvin cycle fixes carbon dioxide into glucose using ATP and NADPH.';

function client(baseUrl) {
  const cookies = new Map();
  let csrf = null;

  const cookieHeader = () =>
    [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

  function absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = raw.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1);
      if (attrs.some((attr) => attr.trim().toLowerCase() === 'max-age=0')) cookies.delete(name);
      else cookies.set(name, value);
    }
  }

  async function call(pathname, { method = 'GET', body, headers = {}, csrfToken } = {}) {
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const token = csrfToken === undefined ? csrf : csrfToken;
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookies.size ? { cookie: cookieHeader() } : {}),
        ...(mutating && token ? { 'x-csrf-token': token } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    absorb(res);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: res.status, body: data, res };
  }

  return {
    call,
    async register(email, password = PASSWORD) {
      return call('/api/auth/register', { method: 'POST', body: { email, password } });
    },
    async login(email, password = PASSWORD) {
      return call('/api/auth/login', { method: 'POST', body: { email, password } });
    },
    async upload(name, contents) {
      const form = new FormData();
      form.append('file', new Blob([contents], { type: 'text/plain' }), name);
      const res = await fetch(`${baseUrl}/api/materials`, {
        method: 'POST',
        headers: {
          ...(cookies.size ? { cookie: cookieHeader() } : {}),
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: form,
      });
      absorb(res);
      return { status: res.status, body: await res.json() };
    },
    get csrf() {
      return csrf;
    },
    get cookies() {
      return cookies;
    },
  };
}

async function requiredHarness(t) {
  const h = await createHarness({ env: { auth: { mode: 'required' } } });
  t.after(() => h.close());
  return h;
}

test('signup creates a session, a private library and a signed-in identity', async (t) => {
  const h = await requiredHarness(t);
  const alice = client(h.api.baseUrl);

  const created = await alice.register('Alice@Example.com');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.user.email, 'alice@example.com');
  assert.equal(created.body.user.onboardingCompleted, false);
  assert.ok(alice.cookies.get('ls_session'), 'session cookie is set');
  assert.ok(alice.cookies.get('ls_csrf'), 'csrf cookie is set');
  assert.ok(!JSON.stringify(created.body).includes('scrypt$'));

  const session = await alice.call('/api/auth/session');
  assert.equal(session.body.authenticated, true);
  assert.equal(session.body.user.email, 'alice@example.com');
  // Even with the account cookie, a forged header cannot change whose data it is.
  const lib = await alice.call('/api/materials', { headers: { 'x-learner-id': 'local' } });
  assert.equal(lib.status, 200);
  assert.deepEqual(lib.body.materials, []);
});

test('logged-out visitors cannot read private APIs, even with an X-Learner-Id', async (t) => {
  const h = await requiredHarness(t);
  const anon = client(h.api.baseUrl);

  const session = await anon.call('/api/auth/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.user, null);

  for (const pathname of ['/api/materials', '/api/progress', '/api/account', '/api/quiz']) {
    const res = await anon.call(pathname, { headers: { 'x-learner-id': 'local' } });
    assert.equal(res.status, 401, `${pathname} must require a session`);
    assert.equal(res.body.error.code, 'authentication_required');
  }

  const upload = await anon.upload('anon.txt', TEXT);
  assert.equal(upload.status, 401);
});

test('one account cannot read another account’s materials or progress', async (t) => {
  const h = await requiredHarness(t);
  const alice = client(h.api.baseUrl);
  const bob = client(h.api.baseUrl);
  await alice.register('alice@example.com');
  await bob.register('bob@example.com');

  const uploaded = await alice.upload('alice-notes.txt', TEXT);
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const materialId = uploaded.body.material.id;

  const aliceLib = await alice.call('/api/materials');
  assert.equal(aliceLib.body.materials.length, 1);

  const bobLib = await bob.call('/api/materials');
  assert.deepEqual(bobLib.body.materials, []);

  const bobRead = await bob.call(`/api/materials/${materialId}`);
  assert.equal(bobRead.status, 404, 'a foreign material id must look like a missing one');
  const bobDelete = await bob.call(`/api/materials/${materialId}`, { method: 'DELETE' });
  assert.equal(bobDelete.status, 404);
  assert.equal((await alice.call(`/api/materials/${materialId}`)).status, 200, 'alice keeps her material');

  const aliceProgress = await alice.call('/api/progress');
  const bobProgress = await bob.call('/api/progress');
  assert.equal(aliceProgress.status, 200);
  assert.equal(bobProgress.status, 200);
  assert.equal(aliceProgress.body.totals.materials, 1);
  assert.equal(bobProgress.body.totals.materials, 0);
});

test('state-changing requests need the session-bound CSRF token', async (t) => {
  const h = await requiredHarness(t);
  const alice = client(h.api.baseUrl);
  await alice.register('alice@example.com');
  assert.ok(alice.csrf);

  const missing = await alice.call('/api/account/profile', {
    method: 'PATCH',
    body: { language: 'en' },
    csrfToken: '',
  });
  assert.equal(missing.status, 403);
  assert.equal(missing.body.error.code, 'csrf_failed');

  const wrong = await alice.call('/api/account/profile', {
    method: 'PATCH',
    body: { language: 'en' },
    csrfToken: 'a'.repeat(43),
  });
  assert.equal(wrong.status, 403);

  const ok = await alice.call('/api/account/profile', { method: 'PATCH', body: { language: 'en' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('profile preferences persist and onboarding can be completed once', async (t) => {
  const h = await requiredHarness(t);
  const alice = client(h.api.baseUrl);
  await alice.register('alice@example.com');

  const saved = await alice.call('/api/account/profile', {
    method: 'PATCH',
    body: {
      language: 'bn',
      level: 'undergraduate',
      subjects: ['Databases', 'databases', ' Maths'],
      examDate: '2026-12-20',
      minutesPerDay: 45,
      daysPerWeek: 5,
      completeOnboarding: true,
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.user.profile.language, 'bn');
  assert.deepEqual(saved.body.user.profile.subjects, ['Databases', 'Maths']);
  assert.equal(saved.body.user.onboardingCompleted, true);

  const session = await alice.call('/api/auth/session');
  assert.equal(session.body.user.onboardingCompleted, true);
  assert.equal(session.body.user.profile.examDate, '2026-12-20');
  assert.equal(session.body.user.profile.minutesPerDay, 45);
});

test('signing in rotates the session token and invalidates the previous one', async (t) => {
  const h = await requiredHarness(t);
  const alice = client(h.api.baseUrl);
  await alice.register('alice@example.com');
  const firstSession = alice.cookies.get('ls_session');
  const firstCsrf = alice.csrf;

  const login = await alice.login('alice@example.com');
  assert.equal(login.status, 200);
  assert.notEqual(alice.cookies.get('ls_session'), firstSession);
  assert.notEqual(alice.csrf, firstCsrf);

  const stale = await fetch(`${h.api.baseUrl}/api/materials`, {
    headers: { cookie: `ls_session=${firstSession}` },
  });
  assert.equal(stale.status, 401, 'the pre-login token must stop working');
});

test('wrong password and unknown email give the same answer', async (t) => {
  const h = await requiredHarness(t);
  const alice = client(h.api.baseUrl);
  await alice.register('alice@example.com');

  const wrongPassword = await client(h.api.baseUrl).login('alice@example.com', 'this is not it');
  const unknownEmail = await client(h.api.baseUrl).login('nobody@example.com');
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  assert.equal(wrongPassword.body.error.message, unknownEmail.body.error.message);
});

test('password reset issues a single-use token, changes the password and signs devices out', async (t) => {
  const h = await requiredHarness(t);
  const alice = client(h.api.baseUrl);
  await alice.register('alice@example.com');
  const oldSession = alice.cookies.get('ls_session');

  const unknown = await client(h.api.baseUrl).call('/api/auth/password-reset/request', {
    method: 'POST',
    body: { email: 'nobody@example.com' },
  });
  const known = await alice.call('/api/auth/password-reset/request', {
    method: 'POST',
    body: { email: 'alice@example.com' },
  });
  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.equal(known.body.message, unknown.body.message, 'no email enumeration');
  assert.ok(known.body.devToken, 'development deployments surface the one-time token');

  const NEW_PASSWORD = 'a different long password';
  const tooShort = await alice.call('/api/auth/password-reset/confirm', {
    method: 'POST',
    body: { token: known.body.devToken, password: 'short' },
  });
  assert.equal(tooShort.status, 400);

  const confirmed = await alice.call('/api/auth/password-reset/confirm', {
    method: 'POST',
    body: { token: known.body.devToken, password: NEW_PASSWORD },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

  const reused = await alice.call('/api/auth/password-reset/confirm', {
    method: 'POST',
    body: { token: known.body.devToken, password: 'yet another password' },
  });
  assert.equal(reused.status, 400, 'a token works exactly once');

  const stale = await fetch(`${h.api.baseUrl}/api/materials`, {
    headers: { cookie: `ls_session=${oldSession}` },
  });
  assert.equal(stale.status, 401, 'a reset signs existing sessions out');

  assert.equal((await client(h.api.baseUrl).login('alice@example.com')).status, 401);
  assert.equal((await client(h.api.baseUrl).login('alice@example.com', NEW_PASSWORD)).status, 200);
});

test('export returns only the caller’s own data and no credentials', async (t) => {
  const h = await requiredHarness(t);
  const alice = client(h.api.baseUrl);
  const bob = client(h.api.baseUrl);
  await alice.register('alice@example.com');
  await bob.register('bob@example.com');

  assert.equal((await alice.upload('alice-notes.txt', TEXT)).status, 201);
  assert.equal((await bob.upload('bob-notes.txt', 'A transaction is a unit of work.')).status, 201);

  const exported = await alice.call('/api/account/export');
  assert.equal(exported.status, 200);
  assert.match(exported.res.headers.get('content-disposition') ?? '', /attachment/);
  assert.equal(exported.body.materials.length, 1);
  assert.equal(exported.body.materials[0].name, 'alice-notes.txt');
  assert.ok(exported.body.passages[exported.body.materials[0].id]?.length > 0);
  assert.equal(exported.body.account.email, 'alice@example.com');
  assert.ok(!JSON.stringify(exported.body).includes('scrypt$'));
  assert.ok(!JSON.stringify(exported.body).includes('bob-notes.txt'));
});

test('deleting an account requires its password and removes its data', async (t) => {
  const h = await requiredHarness(t);
  const alice = client(h.api.baseUrl);
  await alice.register('alice@example.com');
  assert.equal((await alice.upload('alice-notes.txt', TEXT)).status, 201);

  const wrong = await alice.call('/api/account', { method: 'DELETE', body: { password: 'not my password' } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, 'password_required');
  assert.equal((await alice.call('/api/materials')).body.materials.length, 1, 'nothing was removed');

  const removed = await alice.call('/api/account', { method: 'DELETE', body: { password: PASSWORD } });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.accountDeleted, true);
  assert.equal(removed.body.removed.materials, 1);

  const after = await fetch(`${h.api.baseUrl}/api/materials`, {
    headers: { cookie: `ls_session=${alice.cookies.get('ls_session') ?? 'stale'}` },
  });
  assert.equal(after.status, 401);
  assert.equal((await client(h.api.baseUrl).login('alice@example.com')).status, 401);
});

test('local demo mode cannot store account preferences but can clear its own data', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await h.api.upload('notes.txt', Buffer.from(TEXT, 'utf8'), { mimeType: 'text/plain' });

  const profile = await h.api.patch('/api/account/profile', { language: 'bn' });
  assert.equal(profile.status, 400);
  assert.equal(profile.body.error.code, 'accounts_disabled');

  // Credential endpoints are closed too, so a demo cannot mint an account that
  // the identity layer would not enforce.
  const register = await h.api.post('/api/auth/register', { email: 'x@example.com', password: PASSWORD });
  assert.equal(register.status, 400);
  assert.equal(register.body.error.code, 'accounts_disabled');
  const login = await h.api.post('/api/auth/login', { email: 'x@example.com', password: PASSWORD });
  assert.equal(login.status, 400);

  const unconfirmed = await h.api.del('/api/account');
  assert.equal(unconfirmed.status, 400);
  assert.equal((await h.api.get('/api/materials')).body.materials.length, 1);

  const removed = await h.api.fetch(`${h.api.baseUrl}/api/account`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'x-learner-id': 'test-learner' },
    body: JSON.stringify({ confirm: 'DELETE' }),
  });
  assert.equal(removed.status, 200);
  assert.equal((await h.api.get('/api/materials')).body.materials.length, 0);
});
