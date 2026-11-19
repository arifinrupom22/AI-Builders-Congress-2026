/**
 * Authorised accounts, the shared team password and the password-change gate.
 *
 * These run the real app with AUTH_MODE=required. The invitation policy is the
 * production default; the isolation suites opt into the open policy instead, so
 * this file is the only place that asserts the allowlist behaviour.
 *
 * The password itself comes from TEAM_BOOTSTRAP_PASSWORD (the harness supplies
 * a test value), so none of these tests depends on a credential in source.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';
import { TEAM_MEMBERS, bootstrapPassword, provisionTeamAccounts, setTeamPasswords } from '../src/auth/team.js';

const TEAM_PASSWORD = bootstrapPassword();
const STRONG = 'a much better passphrase';

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
    const session = cookieFrom(res);
    if (session) cookie = session;
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: res.status, body: data, res };
  }
  return {
    call,
    login: (email, password) => call('/api/auth/login', { method: 'POST', body: { email, password } }),
    register: (email, password, displayName) =>
      call('/api/auth/register', { method: 'POST', body: { email, password, displayName } }),
    changePassword: (currentPassword, newPassword) =>
      call('/api/account/password', { method: 'POST', body: { currentPassword, newPassword } }),
  };
}

async function seededHarness(t) {
  const h = await createHarness({ env: { auth: { mode: 'required' } } });
  t.after(() => h.close());
  await provisionTeamAccounts({ store: h.store });
  return h;
}

test('provisioning creates the five team accounts once, with a salt per account', async (t) => {
  const h = await createHarness({ env: { auth: { mode: 'required' } } });
  t.after(() => h.close());

  const created = await provisionTeamAccounts({ store: h.store });
  assert.equal(created.length, 5);
  assert.deepEqual(created.sort(), TEAM_MEMBERS.map((member) => member.email).sort());

  const hashes = new Set();
  for (const member of TEAM_MEMBERS) {
    const record = await h.store.findUserByEmailKey(member.email);
    assert.ok(record, `${member.email} should exist`);
    assert.equal(record.displayName, member.displayName);
    // The requested state: no forced password change for the team accounts.
    assert.equal(record.mustChangePassword, false);
    assert.match(record.passwordHash, /^scrypt\$/);
    assert.ok(!record.passwordHash.includes(TEAM_PASSWORD));
    assert.ok(!JSON.stringify(record).includes(TEAM_PASSWORD));
    hashes.add(record.passwordHash);
  }
  // One shared password must never produce one shared hash: every account has
  // its own random salt.
  assert.equal(hashes.size, 5, 'each account needs its own scrypt hash and salt');

  const again = await provisionTeamAccounts({ store: h.store });
  assert.equal(again.length, 0);
});

test('all five accounts sign in with the team password and reach the app directly', async (t) => {
  const h = await seededHarness(t);

  for (const member of TEAM_MEMBERS) {
    const c = client(h.api.baseUrl);
    const session = await c.login(member.email, TEAM_PASSWORD);
    assert.equal(session.status, 200, `${member.email} should sign in`);
    assert.equal(session.body.user.email, member.email);
    assert.equal(session.body.user.displayName, member.displayName);
    // The mandatory password-change screen must not be requested.
    assert.equal(session.body.user.mustChangePassword, false);

    // ...and the app must actually open: no 403 password_change_required.
    const materials = await c.call('/api/materials');
    assert.equal(materials.status, 200, `${member.email} should reach the dashboard API`);
    const profile = await c.call('/api/account');
    assert.equal(profile.status, 200);
    assert.equal(profile.body.user.email, member.email);
  }
});

test('the first-login gate still works when an account is flagged', async (t) => {
  const h = await seededHarness(t);
  const member = TEAM_MEMBERS[0];
  const record = await h.store.findUserByEmailKey(member.email);

  // Flag the account as if it had just been provisioned with a temporary password.
  await h.store.setUserPassword(record.id, record.passwordHash, { mustChangePassword: true });

  const c = client(h.api.baseUrl);
  const signIn = await c.login(member.email, TEAM_PASSWORD);
  assert.equal(signIn.status, 200);
  assert.equal(signIn.body.user.mustChangePassword, true);

  // The shell can still boot; the learning routes cannot.
  assert.equal((await c.call('/api/config')).status, 200);
  assert.equal((await c.call('/api/health')).status, 200);
  const blocked = await c.call('/api/materials');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'password_change_required');

  // A team password reset clears the flag and keeps the account (same id).
  await setTeamPasswords({ store: h.store });
  const after = await c.call('/api/materials');
  assert.equal(after.status, 200, 'the gate opens without a new sign-in');
  assert.equal((await h.store.findUserByEmailKey(member.email)).id, record.id);
});

test('resetting the team password updates accounts in place and keeps their data', async (t) => {
  const h = await seededHarness(t);
  const member = TEAM_MEMBERS[1];
  const before = await h.store.findUserByEmailKey(member.email);

  // A study record that must survive the reset.
  await h.store.updateUserProfile(before.id, { subjects: ['Algorithms'] }, { onboardingCompleted: true });

  const result = await setTeamPasswords({ store: h.store, password: STRONG });
  assert.equal(result.updated.length, 5);
  assert.equal(result.created.length, 0);

  const after = await h.store.findUserByEmailKey(member.email);
  assert.equal(after.id, before.id, 'the account is updated, never recreated');
  assert.deepEqual(after.profile.subjects, ['Algorithms']);
  assert.equal(after.onboardingCompleted, true);
  assert.equal(after.mustChangePassword, false);
  assert.notEqual(after.passwordHash, before.passwordHash);

  const c = client(h.api.baseUrl);
  assert.equal((await c.login(member.email, STRONG)).status, 200);
  // The previous shared password no longer opens the account.
  const old = client(h.api.baseUrl);
  assert.equal((await old.login(member.email, TEAM_PASSWORD)).status, 401);
});

test('a password change requires the current password and signs out other devices', async (t) => {
  const h = await seededHarness(t);
  const first = client(h.api.baseUrl);
  const second = client(h.api.baseUrl);

  assert.equal((await first.login(TEAM_MEMBERS[2].email, TEAM_PASSWORD)).status, 200);
  assert.equal((await second.login(TEAM_MEMBERS[2].email, TEAM_PASSWORD)).status, 200);

  const wrong = await first.changePassword('not my password', STRONG);
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, 'current_password_invalid');

  const tooShort = await first.changePassword(TEAM_PASSWORD, 'short');
  assert.equal(tooShort.status, 400);

  const changed = await first.changePassword(TEAM_PASSWORD, STRONG);
  assert.equal(changed.status, 200);
  assert.equal(changed.body.user.mustChangePassword, false);

  // This tab stays signed in; the other device is revoked.
  assert.equal((await first.call('/api/materials')).status, 200);
  const revoked = await second.call('/api/materials');
  assert.equal(revoked.status, 401);

  // The old password stops working, the new one works.
  const stale = client(h.api.baseUrl);
  assert.equal((await stale.login(TEAM_MEMBERS[2].email, TEAM_PASSWORD)).status, 401);
  assert.equal((await stale.login(TEAM_MEMBERS[2].email, STRONG)).status, 200);
});

test('registration is invitation-only and uses the team display name', async (t) => {
  const h = await createHarness({ env: { auth: { mode: 'required', registrationPolicy: 'allowlist' } } });
  t.after(() => h.close());

  const stranger = client(h.api.baseUrl);
  const refused = await stranger.register('someone@example.com', STRONG, 'Stranger');
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'email_not_invited');

  const invited = client(h.api.baseUrl);
  const created = await invited.register(TEAM_MEMBERS[3].email, STRONG, 'A name I typed');
  assert.equal(created.status, 201);
  assert.equal(created.body.user.email, TEAM_MEMBERS[3].email);
  assert.equal(created.body.user.displayName, TEAM_MEMBERS[3].displayName);
  assert.equal(created.body.user.mustChangePassword, false);

  const duplicate = client(h.api.baseUrl);
  assert.equal((await duplicate.register(TEAM_MEMBERS[3].email, STRONG)).status, 409);
  assert.equal((await duplicate.login(TEAM_MEMBERS[3].email, STRONG)).status, 200);
});

test('the public config states invitation-only without revealing the list', async (t) => {
  const h = await createHarness({ env: { auth: { mode: 'required', registrationPolicy: 'allowlist' } } });
  t.after(() => h.close());

  const anon = client(h.api.baseUrl);
  const config = await anon.call('/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.auth.invitationOnly, true);
  assert.equal(config.body.auth.registrationPolicy, 'allowlist');

  const serialised = JSON.stringify(config.body);
  for (const member of TEAM_MEMBERS) {
    assert.ok(!serialised.includes(member.email), 'the allowlist must never be exposed');
  }
});

test('one account cannot sign in as, or read the data of, another', async (t) => {
  const h = await seededHarness(t);
  const rupom = client(h.api.baseUrl);
  const abir = client(h.api.baseUrl);

  assert.equal((await rupom.login(TEAM_MEMBERS[0].email, TEAM_PASSWORD)).status, 200);
  assert.equal((await abir.login(TEAM_MEMBERS[4].email, TEAM_PASSWORD)).status, 200);

  const abirMaterials = await abir.call('/api/materials');
  assert.equal(abirMaterials.status, 200);
  assert.equal(abirMaterials.body.materials.length, 0);

  const forged = await abir.call('/api/materials', { headers: { 'x-learner-id': 'someone-else' } });
  assert.equal(forged.status, 200);
  assert.equal(forged.body.materials.length, 0);
});
