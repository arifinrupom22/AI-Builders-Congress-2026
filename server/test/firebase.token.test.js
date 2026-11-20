import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createFirebaseVerifier } from '../src/auth/firebase.js';

const PROJECT = 'learnsphere-test';
const KID = 'test-kid';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function sign(header, claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

const baseClaims = (overrides = {}) => ({
  iss: `https://securetoken.google.com/${PROJECT}`,
  aud: PROJECT,
  sub: 'firebase-uid-1',
  email: 'learner@example.com',
  email_verified: true,
  name: 'Learner',
  iat: 1_700_000_000,
  exp: 1_700_003_600,
  ...overrides,
});

const fixedNow = () => 1_700_000_000_000;

/** A verifier whose certificate endpoint is answered from memory. */
function verifier({ publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }), now = fixedNow, ok = true } = {}) {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok,
      status: ok ? 200 : 500,
      headers: { get: () => 'public, max-age=3600' },
      async json() {
        return { [KID]: publicKeyPem };
      },
    };
  };
  return { verifier: createFirebaseVerifier({ projectId: PROJECT, fetchImpl, now }), calls: () => calls };
}

test('a valid Firebase ID token yields the verified uid', async () => {
  const { verifier: verify } = verifier();
  const claims = await verify.verifyIdToken(sign({ alg: 'RS256', kid: KID }, baseClaims()));
  assert.equal(claims.uid, 'firebase-uid-1');
  assert.equal(claims.email, 'learner@example.com');
  assert.equal(claims.emailVerified, true);
  assert.equal(claims.displayName, 'Learner');
});

test('the certificate is cached between requests', async () => {
  const { verifier: verify, calls } = verifier();
  await verify.verifyIdToken(sign({ alg: 'RS256', kid: KID }, baseClaims()));
  await verify.verifyIdToken(sign({ alg: 'RS256', kid: KID }, baseClaims()));
  assert.equal(calls(), 1);
});

test('an unverified address is reported as such rather than as verified', async () => {
  const { verifier: verify } = verifier();
  const claims = await verify.verifyIdToken(sign({ alg: 'RS256', kid: KID }, baseClaims({ email_verified: false })));
  assert.equal(claims.emailVerified, false);
});

test('an expired token is rejected', async () => {
  const { verifier: verify } = verifier();
  const token = sign({ alg: 'RS256', kid: KID }, baseClaims({ exp: 1_699_999_000 }));
  assert.equal(await verify.verifyIdToken(token), null);
});

test('a token issued in the future is rejected', async () => {
  const { verifier: verify } = verifier();
  const token = sign({ alg: 'RS256', kid: KID }, baseClaims({ iat: 1_700_000_360 }));
  assert.equal(await verify.verifyIdToken(token), null);
});

test('a foreign audience or issuer is rejected', async () => {
  const { verifier: verify } = verifier();
  assert.equal(
    await verify.verifyIdToken(sign({ alg: 'RS256', kid: KID }, baseClaims({ aud: 'someone-else' }))),
    null,
  );
  assert.equal(
    await verify.verifyIdToken(sign({ alg: 'RS256', kid: KID }, baseClaims({ iss: 'https://securetoken.google.com/other' }))),
    null,
  );
});

test('an unsigned or tampered token is rejected', async () => {
  const { verifier: verify } = verifier();
  const token = sign({ alg: 'RS256', kid: KID }, baseClaims());
  const [header, payload] = token.split('.');
  assert.equal(await verify.verifyIdToken(`${header}.${payload}.`), null);
  assert.equal(
    await verify.verifyIdToken(sign({ alg: 'none', kid: KID }, baseClaims())),
    null,
  );

  // A token signed by a different key must not verify against Google's cert.
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode({ alg: 'RS256', kid: KID })}.${encode(baseClaims())}`;
  const forged = `${signingInput}.${crypto.sign('RSA-SHA256', Buffer.from(signingInput), other.privateKey).toString('base64url')}`;
  assert.equal(await verify.verifyIdToken(forged), null);
});

test('a missing uid is rejected', async () => {
  const { verifier: verify } = verifier();
  assert.equal(await verify.verifyIdToken(sign({ alg: 'RS256', kid: KID }, baseClaims({ sub: '' }))), null);
});

test('an unreachable certificate endpoint rejects instead of trusting the token', async () => {
  const { verifier: verify } = verifier({ ok: false });
  assert.equal(await verify.verifyIdToken(sign({ alg: 'RS256', kid: KID }, baseClaims())), null);
});

test('verification is inert when no project id is configured', async () => {
  const verify = createFirebaseVerifier({ projectId: '' });
  assert.equal(verify.configured, false);
  assert.equal(await verify.verifyIdToken(sign({ alg: 'RS256', kid: KID }, baseClaims())), null);
});
