/**
 * Public registration.
 *
 * Any visitor may create an account on a fresh deployment, and a deployment can
 * close sign-ups without breaking accounts that already exist. There is no
 * invitation list, no seeded account and no default credential.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';

const STRONG = 'a much better passphrase';

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
        const raw = res.headers.getSetCookie?.() ?? [];
        const session = raw.find((value) => value.startsWith('ls_session='));
        if (session) cookie = session.split(';')[0];
        if (data?.csrfToken) csrf = data.csrfToken;
        return { status: res.status, body: data };
    }
    return {
        call,
        register: (email, password, displayName) =>
            call('/api/auth/register', { method: 'POST', body: { email, password, displayName } }),
        login: (email, password) => call('/api/auth/login', { method: 'POST', body: { email, password } }),
    };
}

test('any visitor can create an account, with no seed list or default password', async (t) => {
    const h = await createHarness({ env: { auth: { mode: 'required' } } });
    t.after(() => h.close());

    const newcomer = client(h.api.baseUrl);
    const created = await newcomer.register('newcomer@example.com', STRONG, 'Newcomer');
    assert.equal(created.status, 201);
    assert.equal(created.body.user.email, 'newcomer@example.com');
    assert.equal(created.body.user.displayName, 'Newcomer');
    assert.equal(created.body.user.mustChangePassword, false);
    assert.ok(!JSON.stringify(created.body).includes('scrypt$'));

    // The account owns nothing yet, and its own library opens normally.
    const materials = await newcomer.call('/api/materials');
    assert.equal(materials.status, 200);
    assert.equal(materials.body.materials.length, 0);

    const signIn = await client(h.api.baseUrl).login('newcomer@example.com', STRONG);
    assert.equal(signIn.status, 200);

    // No pre-existing account is created by the server at startup: this one is
    // the only account row in a fresh store.
    assert.equal((await h.store.users.read()).length, 1);
});

test('the public config reports open registration by default', async (t) => {
    const h = await createHarness({ env: { auth: { mode: 'required' } } });
    t.after(() => h.close());

    const config = await client(h.api.baseUrl).call('/api/config');
    assert.equal(config.status, 200);
    assert.equal(config.body.auth.registrationPolicy, 'open');
    assert.equal(config.body.auth.invitationOnly, false);
});

test('a deployment can close registration without breaking existing accounts', async (t) => {
    const h = await createHarness({ env: { auth: { mode: 'required' } } });
    t.after(() => h.close());

    const first = client(h.api.baseUrl);
    assert.equal((await first.register('early@example.com', STRONG)).status, 201);

    configClose(h);

    const late = client(h.api.baseUrl);
    const refused = await late.register('late@example.com', STRONG);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'registration_closed');

    // The account created before the policy changed still signs in.
    assert.equal((await client(h.api.baseUrl).login('early@example.com', STRONG)).status, 200);
});

/** Flip the running harness config, as a restart with the env value would. */
function configClose(h) {
    h.config.auth.registrationPolicy = 'closed';
}
