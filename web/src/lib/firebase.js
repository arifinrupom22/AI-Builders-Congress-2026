/**
 * Firebase Authentication (browser).
 *
 * The Firebase SDK is loaded lazily: a deployment without Firebase configured
 * never downloads it, and the app keeps working exactly as before. All values
 * come from Vite environment variables, which are public by design - the
 * Firebase web config is not a secret. The privileged keys
 * (SUPABASE_SERVICE_ROLE_KEY, FIREBASE_PRIVATE_KEY) live only on the server.
 *
 * The flow itself (send the verification link, refuse an unverified session,
 * resend, re-check) lives in firebaseAuthCore.js so it can be tested without a
 * browser; this file only loads the SDK and passes it in.
 */

import { createFirebaseAuthFlow } from './firebaseAuthCore.js';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '',
};

/** True only when the minimum web config is present. */
export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId && firebaseConfig.appId,
);

const MESSAGES = {
  'auth/email-already-in-use': 'An account with this email already exists. Sign in instead, then resend the verification email if it never arrived.',
  'auth/invalid-email': 'That email address is not valid.',
  'auth/invalid-credential': 'Email or password is not correct.',
  'auth/wrong-password': 'Email or password is not correct.',
  'auth/user-not-found': 'Email or password is not correct.',
  'auth/weak-password': 'Choose a stronger password (at least 8 characters).',
  'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
  'auth/quota-exceeded': 'The daily verification-email limit for this project has been reached. Try again later.',
  'auth/network-request-failed': 'Cannot reach Firebase. Check the connection and try again.',
  'auth/operation-not-allowed': 'Email/password sign-in is not enabled in the Firebase project.',
  'auth/missing-password': 'Enter your password.',
  'auth/missing-email': 'Enter your email address.',
  'auth/invalid-api-key': 'This build has an invalid Firebase API key. Rebuild the frontend with the project values.',
};

/** A human-readable message for a Firebase error code. */
export function firebaseErrorMessage(err) {
  const code = typeof err?.code === 'string' ? err.code : '';
  return MESSAGES[code] ?? err?.message ?? 'Firebase could not complete that request.';
}

let sdkPromise = null;
let flow = null;

/** The initialised Firebase auth instance plus the auth SDK functions. */
async function getFirebaseSdk() {
  if (!isFirebaseConfigured) return null;
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const [{ initializeApp, getApps }, authSdk] = await Promise.all([
        import('firebase/app'),
        import('firebase/auth'),
      ]);
      const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
      const auth = authSdk.getAuth(app);
      // `getAuth` returns before the persisted session has been read back from
      // IndexedDB. Waiting for it is what keeps a signed-in user signed in after
      // a page refresh: without this the first request after a reload carried no
      // ID token, so the app looked signed out.
      await auth.authStateReady?.();
      return { auth, sdk: authSdk };
    })();
  }
  return sdkPromise;
}

async function getFirebaseFlow() {
  const loaded = await getFirebaseSdk();
  if (!loaded) return null;
  if (!flow) {
    flow = createFirebaseAuthFlow({
      sdk: { auth: loaded.auth, ...loaded.sdk },
      origin: typeof window === 'undefined' ? '' : window.location.origin,
      describeError: firebaseErrorMessage,
    });
  }
  return flow;
}

/** The current Firebase ID token, or null when signed out / not configured. */
export async function firebaseIdToken(forceRefresh = false) {
  const loaded = await getFirebaseSdk();
  const user = loaded?.auth?.currentUser;
  if (!user) return null;
  return user.getIdToken(forceRefresh);
}

/** Sign in; an unverified account is signed out again and reported as such. */
export async function firebaseSignIn(email, password) {
  const active = await getFirebaseFlow();
  if (!active) throw new Error('Firebase is not configured for this build.');
  return active.signIn({ email, password });
}

/**
 * Create the account and send the verification link.
 * The flow signs the new account out: an unverified account must not hold a
 * session, and the server refuses its token with `email_not_verified`.
 */
export async function firebaseRegister(email, password, displayName) {
  const active = await getFirebaseFlow();
  if (!active) throw new Error('Firebase is not configured for this build.');
  return active.register({ email, password, displayName });
}

export async function firebaseSignOut() {
  const loaded = await getFirebaseSdk();
  if (!loaded) return;
  await loaded.auth.signOut();
}

export async function firebaseSendPasswordReset(email) {
  const loaded = await getFirebaseSdk();
  if (!loaded) throw new Error('Firebase is not configured for this build.');
  await loaded.sdk.sendPasswordResetEmail(loaded.auth, email);
}

/** Refresh the signed-in user's own record; used while a session exists. */
export async function firebaseReloadUser() {
  const active = await getFirebaseFlow();
  if (!active) return null;
  const result = await active.reload();
  return result.signedIn ? { emailVerified: result.emailVerified } : null;
}

/** Re-send the verification link to an account that cannot sign in yet. */
export async function firebaseResendVerification(email, password) {
  const active = await getFirebaseFlow();
  if (!active) throw new Error('Firebase is not configured for this build.');
  return active.resend({ email, password });
}

/** Re-read `emailVerified` after the person says they used the link. */
export async function firebaseCheckVerification(email, password) {
  const active = await getFirebaseFlow();
  if (!active) throw new Error('Firebase is not configured for this build.');
  return active.check({ email, password });
}

export default {
  isFirebaseConfigured,
  firebaseIdToken,
  firebaseSignIn,
  firebaseRegister,
  firebaseSignOut,
  firebaseSendPasswordReset,
  firebaseReloadUser,
  firebaseResendVerification,
  firebaseCheckVerification,
  firebaseErrorMessage,
};
