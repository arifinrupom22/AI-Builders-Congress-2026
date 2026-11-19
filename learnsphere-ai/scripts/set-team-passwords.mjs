/**
 * Reset the five authorised accounts to the team password.
 *
 * The password is read from TEAM_BOOTSTRAP_PASSWORD (`.env`) and is never
 * printed, logged or written to storage in the clear: each account gets its own
 * scrypt hash with its own random salt.
 *
 * Accounts are updated in place, so ids, profiles, materials, progress, plans
 * and existing sessions are preserved. `mustChangePassword` is cleared, so the
 * next sign-in goes straight to the dashboard.
 *
 * Usage:  npm run team:set-password
 */
import config from '../server/src/config.js';
import { createLogger } from '../server/src/logger.js';
import { createStore } from '../server/src/storage/store.js';
import { bootstrapPassword, setTeamPasswords } from '../server/src/auth/team.js';

const logger = createLogger({ level: 'info' });

if (!bootstrapPassword()) {
  console.error(
    'TEAM_BOOTSTRAP_PASSWORD is not set. Add it to .env (it is git-ignored) and run this again.\n' +
      'Nothing was changed.',
  );
  process.exit(1);
}

const store = await createStore({ dataDir: config.dataDir, logger });

try {
  const result = await setTeamPasswords({ store, logger });
  // Addresses only — never the credential.
  console.log(
    `Updated ${result.updated.length} account(s), created ${result.created.length}.\n` +
      `${result.updated.map((email) => `  updated  ${email}`).join('\n')}` +
      `${result.updated.length && result.created.length ? '\n' : ''}` +
      `${result.created.map((email) => `  created  ${email}`).join('\n')}`,
  );
  console.log('mustChangePassword is false for all five; existing data and sessions were kept.');
} catch (error) {
  console.error(`Could not set the team passwords: ${error.message}`);
  process.exitCode = 1;
}
