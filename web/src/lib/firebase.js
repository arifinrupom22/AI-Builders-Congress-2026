/**
 * Firebase Authentication (browser).
 *
 * The Firebase SDK is loaded lazily: a deployment without Firebase configured
 * never downloads it, and the app keeps working exactly as before. All values
 * come from Vite environment variables, which are public by design - the
 * Firebase web config is not a secret. The privileged keys
 * (SUPABASE_SERVICE_ROLE_KEY, FIREBASE_PRIVATE_KEY) live only on the server.
 */

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

let authPromise = null;

async function getFirebaseAuth() {
  if (!isFirebaseConfigured) return null;
  if (!authPromise) {
    authPromise = (async () => {
      const [{ initializeApp, getApps }, { getAuth }] = await Promise.all([
        import('firebase/app'),
        import('firebase/auth'),
      ]);
      const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
      const auth = getAuth(app);
      // `getAuth` returns before the persisted session has been read back from
      // IndexedDB. Waiting for it is what keeps a signed-in user signed in after
      // a page refresh: without this the first request after a reload carried no
      // ID token, so the app looked signed out.
      await auth.authStateReady?.();
      return auth;
    })();
  }
  return authPromise;
}

const MESSAGES = {
  'auth/email-already-in-use': 'An account with this email already exists. Sign in instead.',
  'auth/invalid-email': 'That email address is not valid.',
  'auth/invalid-credential': 'Email or password is not correct.',
  'auth/wrong-password': 'Email or password is not correct.',
  'auth/user-not-found': 'Email or password is not correct.',
  'auth/weak-password': 'Choose a stronger password (at least 8 characters).',
  'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
  'auth/network-request-failed': 'Cannot reach Firebase. Check the connection and try again.',
  'auth/operation-not-allowed': 'Email/password sign-in is not enabled in the Firebase project.',
  'auth/missing-password': 'Enter your password.',
};

/** A human-readable message for a Firebase error code. */
export function firebaseErrorMessage(err) {
  const code = typeof err?.code === 'string' ? err.code : '';
  return MESSAGES[code] ?? err?.message ?? 'Firebase could not complete that request.';
}

/** The current Firebase ID token, or null when signed out / not configured. */
export async function firebaseIdToken(forceRefresh = false) {
  const auth = await getFirebaseAuth();
  const user = auth?.currentUser;
  if (!user) return null;
  return user.getIdToken(forceRefresh);
}

export async function firebaseSignIn(email, password) {
  const auth = await getFirebaseAuth();
  if (!auth) throw new Error('Firebase is not configured for this build.');
  const { signInWithEmailAndPassword } = await import('firebase/auth');
  const credential = await signInWithEmailAndPassword(auth, email, password);
  return {
    emailVerified: credential.user.emailVerified === true,
    email: credential.user.email ?? email,
  };
}

/**
 * Create the account, set the display name, and send the verification link.
 * The caller signs the new account out: an unverified account must not hold a
 * session, and the server refuses its token with `email_not_verified`.
 */
export async function firebaseRegister(email, password, displayName) {
  const auth = await getFirebaseAuth();
  if (!auth) throw new Error('Firebase is not configured for this build.');
  const { createUserWithEmailAndPassword, sendEmailVerification, updateProfile } = await import('firebase/auth');
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  if (displayName) {
    await updateProfile(credential.user, { displayName }).catch(() => {});
  }
  await sendEmailVerification(credential.user);
  await auth.signOut();
  return { email, verificationSent: true };
}

export async function firebaseSignOut() {
  const auth = await getFirebaseAuth();
  if (!auth) return;
  await auth.signOut();
}

export async function firebaseSendPasswordReset(email) {
  const auth = await getFirebaseAuth();
  if (!auth) throw new Error('Firebase is not configured for this build.');
  const { sendPasswordResetEmail } = await import('firebase/auth');
  await sendPasswordResetEmail(auth, email);
}

export async function firebaseReloadUser() {
  const auth = await getFirebaseAuth();
  if (!auth?.currentUser) return null;
  await auth.currentUser.reload();
  return { emailVerified: auth.currentUser.emailVerified === true };
}

/** Re-send the verification link to the account that just signed up. */
export async function firebaseResendVerification(email, password) {
  const auth = await getFirebaseAuth();
  if (!auth) throw new Error('Firebase is not configured for this build.');
  const { signInWithEmailAndPassword, sendEmailVerification } = await import('firebase/auth');
  const credential = await signInWithEmailAndPassword(auth, email, password);
  if (credential.user.emailVerified) {
    await auth.signOut();
    return { alreadyVerified: true };
  }
  await sendEmailVerification(credential.user);
  await auth.signOut();
  return { alreadyVerified: false };
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
  firebaseErrorMessage,
};
