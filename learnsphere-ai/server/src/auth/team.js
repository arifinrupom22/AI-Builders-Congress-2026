/**
 * Authorised accounts.
 *
 * This deployment is invitation-only: exactly five team addresses may hold an
 * account. The list lives on the server and is never sent to the browser, so a
 * visitor cannot enumerate who has access.
 *
 * Passwords never live in this file. The one shared team password is read from
 * `TEAM_BOOTSTRAP_PASSWORD` at runtime (`.env`, git-ignored) and is only ever
 * held long enough to derive a per-account scrypt hash with its own random salt.
 * Nothing here logs it.
 */
import { PASSWORD_MIN, hashPassword } from './service.js';

export const TEAM_MEMBERS = Object.freeze([
  { email: 'arifinrupom30@gmail.com', displayName: 'Rupom' },
  { email: 'sneharahman634@gmail.com', displayName: 'Sneha' },
  { email: 'nabilanawshin12@gmail.com', displayName: 'Nabila' },
  { email: 'sbipro89@gmail.com', displayName: 'Biprojit' },
  { email: 'muhammadabirali@gmail.com', displayName: 'Abir' },
]);

/** The shared team password, read at call time so a restart is not required. */
export function bootstrapPassword() {
  return String(process.env.TEAM_BOOTSTRAP_PASSWORD ?? '').trim();
}

/** The allowlist as lower-case keys. Never expose this through the API. */
export const TEAM_EMAIL_KEYS = Object.freeze(TEAM_MEMBERS.map((member) => member.email.toLowerCase()));

export function findTeamMember(rawEmail) {
  const key = String(rawEmail ?? '').trim().toLowerCase();
  if (!key) return null;
  return TEAM_MEMBERS.find((member) => member.email === key) ?? null;
}

export function isTeamEmail(rawEmail) {
  return findTeamMember(rawEmail) !== null;
}

/**
 * Create the five accounts if they do not exist yet. Idempotent: it never
 * touches an account that already exists, so a password someone has chosen is
 * never reset by a restart. With no configured password it does nothing and
 * says so, rather than inventing a default.
 */
export async function provisionTeamAccounts({ store, logger }) {
  const password = bootstrapPassword();
  if (password.length < PASSWORD_MIN) {
    logger?.warn('team accounts not provisioned', {
      reason: `TEAM_BOOTSTRAP_PASSWORD is missing or shorter than ${PASSWORD_MIN} characters`,
      effect: 'No account was created or changed.',
    });
    return [];
  }

  const created = [];
  for (const member of TEAM_MEMBERS) {
    const existing = await store.findUserByEmailKey(member.email);
    if (existing) continue;
    // A fresh random salt per account, even for one shared password.
    const passwordHash = await hashPassword(password);
    await store.createUserRecord({
      email: member.email,
      emailKey: member.email,
      displayName: member.displayName,
      passwordHash,
      mustChangePassword: false,
    });
    created.push(member.email);
  }
  if (created.length > 0) {
    logger?.info('team accounts provisioned', { count: created.length });
  }
  return created;
}

/**
 * Set every authorised account to the configured team password.
 *
 * This is the deliberate counterpart to `provisionTeamAccounts`, which skips
 * existing rows: it updates the five accounts in place, so their id, profile,
 * materials, progress, plans and live sessions are all preserved. Each account
 * gets its own salt, and `mustChangePassword` is cleared so signing in goes
 * straight to the dashboard.
 *
 * Run it with `npm run team:set-password` after setting the environment value.
 */
export async function setTeamPasswords({ store, logger, password = bootstrapPassword() }) {
  const value = String(password ?? '').trim();
  if (value.length < PASSWORD_MIN) {
    throw new Error(
      `Refusing to set a team password shorter than ${PASSWORD_MIN} characters. Set TEAM_BOOTSTRAP_PASSWORD first.`,
    );
  }

  const updated = [];
  const created = [];
  for (const member of TEAM_MEMBERS) {
    const passwordHash = await hashPassword(value);
    const existing = await store.findUserByEmailKey(member.email);
    if (!existing) {
      await store.createUserRecord({
        email: member.email,
        emailKey: member.email,
        displayName: member.displayName,
        passwordHash,
        mustChangePassword: false,
      });
      created.push(member.email);
      continue;
    }
    await store.setUserPassword(existing.id, passwordHash, { mustChangePassword: false });
    updated.push(member.email);
  }

  logger?.info('team passwords set', { updated: updated.length, created: created.length });
  return { updated, created };
}

export default {
  TEAM_MEMBERS,
  findTeamMember,
  isTeamEmail,
  provisionTeamAccounts,
  setTeamPasswords,
  bootstrapPassword,
};
