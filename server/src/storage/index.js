/**
 * Storage driver selection.
 *
 * One call site (`server/src/index.js`) decides where data lives:
 *
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set -> Supabase (PostgreSQL +
 *   Storage). The learning logic is untouched: only the collection and blob
 *   adapters differ, which is what keeps the API contract and the existing
 *   test suite valid.
 *
 *   Otherwise -> the dependency-free JSON collections on local disk, so
 *   `npm run dev` and the test suite still need no external service.
 *
 * A configured-but-unreachable Supabase must not silently fall back to disk:
 * that would split a deployment's data across two stores. Startup therefore
 * probes the database and fails loudly instead.
 */
import { createStore } from './store.js';
import { createSupabaseAdapters } from './supabase.js';

export async function createDataStore({ config, logger }) {
  const supabase = config.supabase ?? {};

  if (supabase.configured) {
    const adapters = createSupabaseAdapters({
      url: supabase.url,
      serviceRoleKey: supabase.serviceRoleKey,
      storageBucket: supabase.storageBucket,
      logger,
    });

    if (typeof supabase.fetchImpl === 'function' || supabase.url) {
      // A cheap read proves the URL, the key and the migration are all valid
      // before the server starts accepting requests.
      try {
        await adapters.client.selectAll('records', {
          filters: { collection: 'eq.users' },
          columns: 'id',
        });
        logger?.info('Supabase storage connected', { url: adapters.client.baseUrl });
      } catch (err) {
        logger?.error('Supabase storage is not reachable; refusing to start on a different store', {
          message: err.message,
          fix: 'Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and apply supabase/migrations/0001_init.sql.',
        });
        throw err;
      }
    }

    const store = await createStore({ dataDir: config.dataDir, logger, adapters });
    store.driver = 'supabase';
    return store;
  }

  const store = await createStore({ dataDir: config.dataDir, logger });
  store.driver = 'json';
  return store;
}

export default createDataStore;
