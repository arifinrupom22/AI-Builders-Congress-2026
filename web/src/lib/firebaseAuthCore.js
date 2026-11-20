/**
 * Firebase email/password flow.
 *
 * This module holds the part of the sign-up/sign-in sequence that has rules
 * worth testing: create the account, send the verification link, never leave an
 * unverified account signed in, and never report a created account as a failed
 * sign-up just because the email could not be sent.
 *
 * The Firebase SDK is injected instead of imported so the logic can be tested
 * without a browser, a network or a Firebase project (see web/test). The loader
 * and the project configuration live in firebase.js.
 */

/** Where Firebase should send the browser after the verification link is used. */
export const VERIFICATION_CONTINUE_PATH = '/#/login?verified=1';

const UNUSABLE_CONTINUE_CODES = new Set(['auth/unauthorized-continue-uri', 'auth/invalid-continue-uri']);

/**
 * `ActionCodeSettings` for the verification email, or null when this origin
 * cannot be a continue URL. Firebase only accepts HTTPS continue URLs (plus
 * localhost during development), and the domain must be listed under
 * Authentication -> Settings -> Authorized domains.
 */
export function verificationActionCodeSettings(origin, path = VERIFICATION_CONTINUE_PATH) {
  if (typeof origin !== 'string' || origin.length === 0) return null;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  return { url: `${url.origin}${path}`, handleCodeInApp: false };
}

function defaultDescribeError(err) {
  return typeof err?.message === 'string' && err.message ? err.message : 'Firebase could not send the verification email.';
}

/**
 * @param {object} options
 * @param {object} options.sdk the `firebase/auth` module plus a ready `auth` instance.
 * @param {string} [options.origin] the browser origin, used for the continue URL.
 * @param {(err: unknown) => string} [options.describeError] maps a Firebase error to a sentence.
 */
export function createFirebaseAuthFlow({ sdk, origin = '', describeError = defaultDescribeError }) {
  const auth = sdk.auth;
  const settings = verificationActionCodeSettings(origin);

  async function signOutQuietly() {
    try {
      await sdk.signOut(auth);
    } catch {
      /* already signed out */
    }
  }

  /**
   * Send the verification link. A continue URL the Firebase project does not
   * authorise must not cost the person their email, so the call is retried with
   * Firebase's own handler page before the failure is reported.
   */
  async function sendVerificationLink(user) {
    if (!settings) {
      await sdk.sendEmailVerification(user);
      return { sent: true, usedDefaultHandler: true };
    }
    try {
      await sdk.sendEmailVerification(user, { ...settings });
      return { sent: true, usedDefaultHandler: false };
    } catch (err) {
      if (!UNUSABLE_CONTINUE_CODES.has(err?.code)) throw err;
      await sdk.sendEmailVerification(user);
      return { sent: true, usedDefaultHandler: true };
    }
  }

  /** Sign in without deciding anything, so the callers can share the checks. */
  async function signInOnce(email, password) {
    const credential = await sdk.signInWithEmailAndPassword(auth, email, password);
    const user = credential?.user ?? auth?.currentUser ?? null;
    return {
      user,
      emailVerified: user?.emailVerified === true,
      email: user?.email ?? email,
    };
  }

  return {
    auth,

    /** The settings that will be attached to the verification email (may be null). */
    actionCodeSettings: settings ? { ...settings } : null,

    /**
     * Create the account and send the verification link.
     *
     * A failure to create the account throws (nothing exists yet). A failure to
     * send the link does not: the account does exist, so the caller must show the
     * verification-pending screen with a resend action instead of "signup
     * failed", which would leave the person retrying a sign-up that can no
     * longer succeed.
     */
    async register({ email, password, displayName }) {
      const credential = await sdk.createUserWithEmailAndPassword(auth, email, password);
      const user = credential?.user ?? auth?.currentUser ?? null;
      if (!user) throw new Error('Firebase did not return the new account.');

      if (displayName) {
        // A missing display name is cosmetic: it must not sink the sign-up.
        try {
          await sdk.updateProfile(user, { displayName });
        } catch {
          /* the email address is still the account name */
        }
      }

      let verification = { sent: false, usedDefaultHandler: false };
      let verificationError = null;
      try {
        verification = await sendVerificationLink(user);
      } catch (err) {
        verificationError = describeError(err);
      }

      // An unverified account must not hold a session, in this tab or any other.
      await signOutQuietly();

      return {
        email,
        accountCreated: true,
        verificationSent: verification.sent === true,
        usedDefaultHandler: verification.usedDefaultHandler === true,
        verificationError,
      };
    },

    /**
     * Sign in and report the verification state. An unverified account is signed
     * out again: the app must not keep a session it cannot use.
     */
    async signIn({ email, password }) {
      const result = await signInOnce(email, password);
      if (!result.emailVerified) {
        await signOutQuietly();
        return { emailVerified: false, email: result.email };
      }
      return { emailVerified: true, email: result.email };
    },

    /**
     * Send the verification link again. The account has no session, so Firebase
     * requires a fresh sign-in first; that session is never kept.
     */
    async resend({ email, password }) {
      const result = await signInOnce(email, password);
      if (result.emailVerified) {
        await signOutQuietly();
        return { alreadyVerified: true, verificationSent: false };
      }
      let sent;
      try {
        sent = await sendVerificationLink(result.user);
      } catch (err) {
        await signOutQuietly();
        throw err;
      }
      await signOutQuietly();
      return {
        alreadyVerified: false,
        verificationSent: sent.sent === true,
        usedDefaultHandler: sent.usedDefaultHandler === true,
      };
    },

    /**
     * Re-read the verification state after the person says they used the link.
     * Firebase only refreshes `emailVerified` on a new sign-in or on
     * `user.reload()`, so the check signs in, reads the fresh value and leaves
     * the account signed out again.
     */
    async check({ email, password }) {
      const result = await signInOnce(email, password);
      await signOutQuietly();
      return { emailVerified: result.emailVerified, email: result.email };
    },

    /** Refresh the signed-in user's own record (`user.reload()`), if any. */
    async reload() {
      const user = auth?.currentUser;
      if (!user) return { signedIn: false, emailVerified: false };
      await sdk.reload(user);
      return { signedIn: true, emailVerified: user.emailVerified === true };
    },
  };
}

export default createFirebaseAuthFlow;
