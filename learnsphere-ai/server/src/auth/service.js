/**
 * Password accounts.
 *
 * This is the server-verified identity behind `AUTH_MODE=required`. It exists
 * because a header such as `X-Learner-Id` is a data-scoping convenience, not
 * authentication: anyone who can reach the API can send someone else's id.
 *
 * Rules:
 *  - Passwords are hashed with scrypt and a per-user random salt. The plain
 *    password is never stored, logged, or returned.
 *  - Session tokens are random 32-byte values. Only their SHA-256 hash is
 *    stored, so a copy of the data directory cannot be replayed as a login.
 *  - Login failures do not say whether the email exists, and an unknown email
 *    still pays for one scrypt comparison so timing does not leak it either.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import AppError from '../errors.js';

const scrypt = promisify(crypto.scrypt);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_BYTES = 16;
const SESSION_BYTES = 32;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
export const EMAIL_MAX = 254;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseEmail(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

export function isValidEmail(raw) {
  const email = normaliseEmail(raw);
  return email.length >= 3 && email.length <= EMAIL_MAX && EMAIL_RE.test(email);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = await scrypt(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    profile: user.profile ?? {
      language: 'auto',
      level: null,
      subjects: [],
      examDate: null,
      minutesPerDay: null,
      daysPerWeek: null,
    },
    onboardingCompleted: user.onboardingCompleted === true,
    createdAt: user.createdAt,
  };
}

export function createAuthService({ store, config }) {
  /** A hash of a throwaway password, used only to spend comparable time. */
  let dummyHash = null;
  async function burnComparison(password) {
    if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(16).toString('hex'));
    await verifyPassword(password, dummyHash);
  }

  function ttlMs() {
    return (config.auth?.sessionTtlDays ?? 14) * 24 * 60 * 60 * 1000;
  }

  async function startSession(userId) {
    const token = crypto.randomBytes(SESSION_BYTES).toString('base64url');
    // CSRF token: readable by this origin's JavaScript and echoed back in a
    // header. It is bound to the session record, so another site cannot guess
    // it, and a stolen cookie alone cannot produce it (same-site policy plus
    // the header check). Only its digest is stored.
    const csrfToken = crypto.randomBytes(SESSION_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlMs()).toISOString();
    await store.createAuthSession({
      tokenHash: hashToken(token),
      csrfHash: hashToken(csrfToken),
      userId,
      expiresAt,
    });
    return { token, csrfToken, expiresAt };
  }

  return {
    enabled: true,

    async register({ email, password, displayName }) {
      const emailKey = normaliseEmail(email);
      if (!isValidEmail(emailKey)) throw AppError.badRequest('Enter a valid email address.');
      if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
        throw AppError.badRequest(`Choose a password of at least ${PASSWORD_MIN} characters.`);
      }
      if (password.length > PASSWORD_MAX) {
        throw AppError.badRequest(`A password can be at most ${PASSWORD_MAX} characters.`);
      }

      const passwordHash = await hashPassword(password);
      const user = await store.createUserRecord({
        email: emailKey,
        emailKey,
        displayName: (displayName ?? '').trim().slice(0, 60) || emailKey.split('@')[0],
        passwordHash,
      });
      const session = await startSession(user.id);
      return { user: publicUser(user), session };
    },

    /** Returns null for a wrong password *and* an unknown email. */
    async login({ email, password, previousToken = null }) {
      const emailKey = normaliseEmail(email);
      const guess = typeof password === 'string' ? password : '';
      if (!isValidEmail(emailKey) || guess.length === 0 || guess.length > PASSWORD_MAX) {
        await burnComparison(guess.slice(0, PASSWORD_MAX));
        return null;
      }

      const record = await store.findUserByEmailKey(emailKey);
      if (!record) {
        await burnComparison(guess);
        return null;
      }
      const ok = await verifyPassword(guess, record.passwordHash);
      if (!ok) return null;
      // Rotate: the pre-login token must not stay usable alongside the new one.
      if (previousToken) await store.deleteAuthSession(hashToken(previousToken));
      const session = await startSession(record.id);
      return { user: publicUser(record), session };
    },

    async sessionFromToken(token) {
      if (typeof token !== 'string' || token.length < 20) return null;
      const session = await store.findAuthSession(hashToken(token));
      if (!session) return null;
      if (Date.parse(session.expiresAt) <= Date.now()) {
        await store.deleteAuthSession(session.tokenHash);
        return null;
      }
      const user = await store.getUserById(session.userId);
      if (!user) {
        await store.deleteAuthSession(session.tokenHash);
        return null;
      }
      return { user: publicUser(user), expiresAt: session.expiresAt, csrfHash: session.csrfHash ?? null };
    },

    /** Verify the signed-in account's own password (used before deleting it). */
    async verifyAccountPassword(userId, password) {
      const record = await store.getUserById(userId);
      if (!record || typeof password !== 'string' || password.length === 0) return false;
      return verifyPassword(password, record.passwordHash);
    },

    /**
     * Start a password reset. The caller's response is always generic, so this
     * cannot be used to discover which emails have accounts.
     * Returns the plain token for the caller to deliver; never logs it.
     */
    async requestPasswordReset(rawEmail) {
      const emailKey = normaliseEmail(rawEmail);
      if (!isValidEmail(emailKey)) return { token: null, user: null };
      const user = await store.findUserByEmailKey(emailKey);
      if (!user) return { token: null, user: null };

      const token = crypto.randomBytes(SESSION_BYTES).toString('base64url');
      const expiresAt = new Date(Date.now() + (config.auth?.resetTokenTtlMinutes ?? 30) * 60_000).toISOString();
      await store.createPasswordReset({ tokenHash: hashToken(token), userId: user.id, expiresAt });
      return { token, user: { id: user.id, email: user.email } };
    },

    async resetPassword({ token, password }) {
      if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
        throw AppError.badRequest(`Choose a password of at least ${PASSWORD_MIN} characters.`);
      }
      if (password.length > PASSWORD_MAX) throw AppError.badRequest(`A password can be at most ${PASSWORD_MAX} characters.`);
      if (typeof token !== 'string' || token.length < 20) {
        throw AppError.badRequest('This reset token is not valid. Request a new one.');
      }

      const row = await store.findPasswordReset(hashToken(token));
      if (!row || Date.parse(row.expiresAt) <= Date.now()) {
        throw AppError.badRequest('This reset token has expired. Request a new one.');
      }
      const user = await store.getUserById(row.userId);
      if (!user) {
        await store.deletePasswordResetsForUser(row.userId);
        throw AppError.badRequest('This reset token is not valid. Request a new one.');
      }

      const passwordHash = await hashPassword(password);
      await store.setUserPassword(user.id, passwordHash);
      // A reset signs every device out and burns all outstanding tokens.
      await store.deleteAuthSessionsForUser(user.id);
      await store.deletePasswordResetsForUser(user.id);
      return true;
    },

    async logout(token) {
      if (typeof token !== 'string' || token.length < 20) return;
      await store.deleteAuthSession(hashToken(token));
    },

    /** Revoke every session of one account (used after a password change). */
    async logoutEverywhere(userId) {
      await store.deleteAuthSessionsForUser(userId);
    },

    ttlMs,
    hashToken,
  };
}

export default createAuthService;
