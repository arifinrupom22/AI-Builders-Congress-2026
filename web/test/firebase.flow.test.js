/**
 * Firebase email-verification flow.
 *
 * The Firebase SDK is replaced by a fake that records every call, so the rules
 * that matter are asserted without a browser, a network or a real project:
 * the verification link is sent and awaited, an unverified account never keeps
 * a session, a failed send does not turn a created account into "signup failed",
 * and resend/re-check behave the same way.
 *
 * Run with `npm test` in the web workspace (part of the root `npm test`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VERIFICATION_CONTINUE_PATH,
  createFirebaseAuthFlow,
  verificationActionCodeSettings,
} from '../src/lib/firebaseAuthCore.js';

const ORIGIN = 'https://ai-builders-congress-2026.onrender.com';

/** A fake `firebase/auth` module. */
function fakeSdk({ verified = false, sendError = null, continueUriFails = false, createError = null } = {}) {
  const calls = [];
  const user = { uid: 'uid-1', email: 'learner@example.com', emailVerified: verified };
  const sdk = {
    auth: { currentUser: null },
    async createUserWithEmailAndPassword(auth, email, password) {
      calls.push(['create', email, password]);
      if (createError) throw Object.assign(new Error(createError.message), { code: createError.code });
      auth.currentUser = user;
      return { user };
    },
    async updateProfile(target, patch) {
      calls.push(['updateProfile', patch.displayName]);
    },
    async sendEmailVerification(target, settings) {
      calls.push(['sendEmailVerification', settings ?? null]);
      if (continueUriFails && settings) {
        throw Object.assign(new Error('continue uri'), { code: 'auth/unauthorized-continue-uri' });
      }
      if (sendError) throw Object.assign(new Error(sendError.message), { code: sendError.code });
    },
    async signInWithEmailAndPassword(auth, email, password) {
      calls.push(['signIn', email, password]);
      auth.currentUser = user;
      return { user };
    },
    async signOut(auth) {
      calls.push(['signOut']);
      auth.currentUser = null;
    },
    async reload(target) {
      calls.push(['reload']);
    },
  };
  return { sdk, calls, user };
}

const names = (calls) => calls.map(([name]) => name);

test('the continue URL is only built for an origin Firebase accepts', () => {
  assert.deepEqual(verificationActionCodeSettings(ORIGIN), {
    url: `${ORIGIN}${VERIFICATION_CONTINUE_PATH}`,
    handleCodeInApp: false,
  });
  assert.equal(verificationActionCodeSettings('http://localhost:5173')?.url, `http://localhost:5173${VERIFICATION_CONTINUE_PATH}`);
  assert.equal(verificationActionCodeSettings('http://example.com'), null);
  assert.equal(verificationActionCodeSettings(''), null);
  assert.equal(verificationActionCodeSettings('not a url'), null);
});

test('registering creates the account, sends the link with the continue URL, then signs out', async () => {
  const { sdk, calls } = fakeSdk();
  const flow = createFirebaseAuthFlow({ sdk, origin: ORIGIN });

  const result = await flow.register({ email: 'learner@example.com', password: 'long-enough-password', displayName: 'Learner' });

  assert.deepEqual(names(calls), ['create', 'updateProfile', 'sendEmailVerification', 'signOut']);
  assert.deepEqual(calls[2][1], { url: `${ORIGIN}${VERIFICATION_CONTINUE_PATH}`, handleCodeInApp: false });
  assert.equal(result.accountCreated, true);
  assert.equal(result.verificationSent, true);
  assert.equal(result.verificationError, null);
  // The account must not be left signed in before the address is verified.
  assert.equal(sdk.auth.currentUser, null);
});

test('registration still succeeds when the verification email cannot be sent', async () => {
  const { sdk, calls } = fakeSdk({ sendError: { code: 'auth/too-many-requests', message: 'Too many attempts.' } });
  const flow = createFirebaseAuthFlow({ sdk, origin: ORIGIN, describeError: (err) => err.message });

  const result = await flow.register({ email: 'learner@example.com', password: 'long-enough-password' });

  assert.equal(result.accountCreated, true);
  assert.equal(result.verificationSent, false);
  assert.equal(result.verificationError, 'Too many attempts.');
  assert.ok(names(calls).includes('signOut'), 'the account is signed out even when the send fails');
  assert.equal(sdk.auth.currentUser, null);
});

test('an unauthorised continue URL is retried without it so the email is still sent', async () => {
  const { sdk, calls } = fakeSdk({ continueUriFails: true });
  const flow = createFirebaseAuthFlow({ sdk, origin: ORIGIN });

  const result = await flow.register({ email: 'learner@example.com', password: 'long-enough-password' });

  assert.equal(result.verificationSent, true);
  assert.equal(result.usedDefaultHandler, true);
  const sends = calls.filter(([name]) => name === 'sendEmailVerification');
  assert.equal(sends.length, 2);
  assert.ok(sends[1][1] == null, 'the retry uses Firebase\'s own handler page');
});

test('a sign-up that Firebase rejects throws instead of pretending an account exists', async () => {
  const { sdk } = fakeSdk({ createError: { code: 'auth/email-already-in-use', message: 'in use' } });
  const flow = createFirebaseAuthFlow({ sdk, origin: ORIGIN });

  await assert.rejects(() => flow.register({ email: 'learner@example.com', password: 'long-enough-password' }), /in use/);
});

test('an unverified account cannot sign in and is signed out again', async () => {
  const { sdk, calls } = fakeSdk({ verified: false });
  const flow = createFirebaseAuthFlow({ sdk, origin: ORIGIN });

  const result = await flow.signIn({ email: 'learner@example.com', password: 'long-enough-password' });

  assert.equal(result.emailVerified, false);
  assert.deepEqual(names(calls), ['signIn', 'signOut']);
  assert.equal(sdk.auth.currentUser, null);
});

test('a verified account signs in and keeps its session', async () => {
  const { sdk, calls } = fakeSdk({ verified: true });
  const flow = createFirebaseAuthFlow({ sdk, origin: ORIGIN });

  const result = await flow.signIn({ email: 'learner@example.com', password: 'long-enough-password' });

  assert.equal(result.emailVerified, true);
  assert.deepEqual(names(calls), ['signIn']);
  assert.ok(sdk.auth.currentUser, 'the verified session is the one the API token comes from');
});

test('resending signs in, sends the link, and signs out', async () => {
  const { sdk, calls } = fakeSdk({ verified: false });
  const flow = createFirebaseAuthFlow({ sdk, origin: ORIGIN });

  const result = await flow.resend({ email: 'learner@example.com', password: 'long-enough-password' });

  assert.deepEqual(names(calls), ['signIn', 'sendEmailVerification', 'signOut']);
  assert.equal(result.alreadyVerified, false);
  assert.equal(result.verificationSent, true);
  assert.equal(sdk.auth.currentUser, null);
});

test('resending reports an already verified account without sending', async () => {
  const { sdk, calls } = fakeSdk({ verified: true });
  const flow = createFirebaseAuthFlow({ sdk, origin: ORIGIN });

  const result = await flow.resend({ email: 'learner@example.com', password: 'long-enough-password' });

  assert.equal(result.alreadyVerified, true);
  assert.deepEqual(names(calls), ['signIn', 'signOut']);
});

test('a failed resend surfaces the Firebase error and leaves no session', async () => {
  const { sdk, calls } = fakeSdk({ verified: false, sendError: { code: 'auth/quota-exceeded', message: 'Daily limit' } });
  const flow = createFirebaseAuthFlow({ sdk, origin: ORIGIN });

  await assert.rejects(
    () => flow.resend({ email: 'learner@example.com', password: 'long-enough-password' }),
    (err) => err.code === 'auth/quota-exceeded',
  );
  assert.deepEqual(names(calls), ['signIn', 'sendEmailVerification', 'signOut']);
  assert.equal(sdk.auth.currentUser, null);
});

test('checking after the link is used reports the refreshed state', async () => {
  const { sdk, user, calls } = fakeSdk({ verified: false });
  const flow = createFirebaseAuthFlow({ sdk, origin: ORIGIN });

  const before = await flow.check({ email: 'learner@example.com', password: 'long-enough-password' });
  assert.equal(before.emailVerified, false);

  // Firebase marks the address verified when the link is opened.
  user.emailVerified = true;

  const after = await flow.check({ email: 'learner@example.com', password: 'long-enough-password' });
  assert.equal(after.emailVerified, true);
  assert.equal(names(calls).filter((name) => name === 'signOut').length, 2, 'each check signs out again');
  assert.equal(sdk.auth.currentUser, null);
});

test('reloading a signed-out account reports that there is no session', async () => {
  const { sdk } = fakeSdk();
  const flow = createFirebaseAuthFlow({ sdk, origin: ORIGIN });

  assert.deepEqual(await flow.reload(), { signedIn: false, emailVerified: false });
});
