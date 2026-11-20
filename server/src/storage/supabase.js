/**
 * Supabase (PostgreSQL + Storage) adapters.
 *
 * The application's storage contract is tiny: a "collection" exposes
 * `read()` and `update(mutator)`, and uploaded files/passages are addressed by
 * material id. `createSupabaseStore` implements exactly those two things over
 * Supabase's REST API (PostgREST + Storage) and then reuses the existing store
 * implementation, so no learning feature changes when the database changes.
 *
 * Only the **service-role key** is used, and only on the server. Requests go
 * out with the key in an `apikey`/`Authorization` header and are never proxied
 * to the browser. Because a service-role request bypasses Row Level Security,
 * every query here is additionally scoped by owner id: the identity always
 * comes from a verified Firebase ID token, never from the request body.
 *
 * Schema: see `supabase/migrations/0001_init.sql`.
 *   records(collection, id, owner_id, data jsonb, created_at, updated_at)
 *   material_passages(material_id, position, data jsonb)
 *   storage bucket "materials" (private)
 */

const PAGE_SIZE = 1000;

function normaliseBaseUrl(raw) {
  const value = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    // A copied "REST endpoint" (`…/rest/v1`) is the same project. Accepting it
    // here avoids building `…/rest/v1/rest/v1/records`, which answers every
    // read with a 404.
    return url.origin + url.pathname.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  } catch {
    return '';
  }
}

/** Minimal REST client. Throws on a non-2xx so callers never see partial data. */
export function createSupabaseClient({ url, serviceRoleKey, fetchImpl = globalThis.fetch, storageBucket = 'materials' } = {}) {
  const baseUrl = normaliseBaseUrl(url);
  const key = String(serviceRoleKey ?? '').trim();
  const configured = Boolean(baseUrl && key);

  const headers = (extra = {}) => ({
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...extra,
  });

  async function request(path, { method = 'GET', body, prefer, headers: extraHeaders } = {}) {
    if (!configured) throw new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: headers({
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(prefer ? { Prefer: prefer } : {}),
        ...(extraHeaders ?? {}),
      }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Supabase ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /** Read every row matching the filter, following `Range` pagination. */
  async function selectAll(table, { filters = {}, order = 'created_at.asc', columns = '*' } = {}) {
    const out = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const query = new URLSearchParams({ select: columns, order });
      for (const [column, value] of Object.entries(filters)) {
        query.set(column, value === null ? 'is.null' : `eq.${value}`);
      }
      const page = await request(`/rest/v1/${table}?${query.toString()}`, {
        headers: { Range: `${offset}-${offset + PAGE_SIZE - 1}`, 'Range-Unit': 'items' },
      });
      if (!Array.isArray(page) || page.length === 0) break;
      out.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return out;
  }

  async function upsertRows(table, rows, onConflict) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const query = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
    await request(`/rest/v1/${table}${query}`, {
      method: 'POST',
      body: rows,
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }

  async function patchRows(table, filters, patch) {
    const query = new URLSearchParams();
    for (const [column, value] of Object.entries(filters)) query.set(column, `eq.${value}`);
    await request(`/rest/v1/${table}?${query.toString()}`, {
      method: 'PATCH',
      body: patch,
      prefer: 'return=minimal',
    });
  }

  async function deleteRows(table, filters) {
    const query = new URLSearchParams();
    for (const [column, value] of Object.entries(filters)) query.set(column, `eq.${value}`);
    await request(`/rest/v1/${table}?${query.toString()}`, { method: 'DELETE', prefer: 'return=minimal' });
  }

  // --- object storage ------------------------------------------------------
  async function uploadObject(path, buffer, contentType = 'application/octet-stream') {
    const response = await fetchImpl(`${baseUrl}/storage/v1/object/${storageBucket}/${encodeURI(path)}`, {
      method: 'POST',
      headers: headers({ 'Content-Type': contentType, 'x-upsert': 'true' }),
      body: buffer,
    });
    if (!response.ok) {
      throw new Error(`Supabase storage upload failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
    }
  }

  async function downloadObject(path) {
    const response = await fetchImpl(`${baseUrl}/storage/v1/object/${storageBucket}/${encodeURI(path)}`, {
      headers: headers(),
    });
    if (!response.ok) throw new Error(`Supabase storage download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }

  async function removeObject(path) {
    await fetchImpl(`${baseUrl}/storage/v1/object/${storageBucket}/${encodeURI(path)}`, {
      method: 'DELETE',
      headers: headers(),
    }).catch(() => {});
  }

  return {
    configured,
    baseUrl,
    storageBucket,
    selectAll,
    upsertRows,
    patchRows,
    deleteRows,
    uploadObject,
    downloadObject,
    removeObject,
  };
}

const rowId = (row) => (row && typeof row.id === 'string' ? row.id : null);

/**
 * A collection backed by the `records` table.
 *
 * `read()`/`update(mutator)` match the JSON file collection the rest of the
 * server already uses. `update` loads the rows, runs the mutator on a copy, and
 * writes only the difference (insert / patch / delete), so the call sites and
 * their validation stay unchanged.
 */
export function createSupabaseCollection({ client, collection, scope = null, logger = null }) {
  // `client.selectAll` adds the `eq.` operator itself, so these are raw values.
  const filters = () => (scope ? { collection, owner_id: scope } : { collection });

  async function readRows() {
    const rows = await client.selectAll('records', { filters: filters(), order: 'created_at.asc' });
    return rows.map((row) => row.data ?? {});
  }

  async function writeDiff(before, after) {
    const beforeById = new Map(before.map((row) => [rowId(row), row]).filter(([id]) => id));
    const afterById = new Map(after.map((row) => [rowId(row), row]).filter(([id]) => id));

    const inserts = [];
    const updates = [];
    for (const [id, row] of afterById) {
      const previous = beforeById.get(id);
      if (!previous) inserts.push(row);
      else if (JSON.stringify(previous) !== JSON.stringify(row)) updates.push(row);
    }
    const deletes = [...beforeById.keys()].filter((id) => !afterById.has(id));

    const stamp = new Date().toISOString();
    await client.upsertRows(
      'records',
      inserts.map((row) => ({
        collection,
        id: rowId(row),
        owner_id: scope ?? row.learnerId ?? null,
        data: row,
        created_at: stamp,
        updated_at: stamp,
      })),
      'collection,id',
    );

    for (const row of updates) {
      await client.patchRows('records', { collection, id: rowId(row) }, { data: row, updated_at: stamp });
    }
    for (const id of deletes) {
      await client.deleteRows('records', { collection, id });
    }
    if (logger && (inserts.length || updates.length || deletes.length)) {
      logger.debug?.('supabase collection written', {
        collection,
        inserted: inserts.length,
        updated: updates.length,
        deleted: deletes.length,
      });
    }
  }

  return {
    async read() {
      return readRows();
    },
    async update(mutator) {
      const before = await readRows();
      const draft = structuredClone(before);
      const result = await mutator(draft);
      await writeDiff(before, draft);
      return result;
    },
  };
}

/**
 * File + passage storage backed by Supabase Storage and `material_passages`.
 * Implements the same six functions the modular store expects.
 */
export function createSupabaseBlobs({ client }) {
  const objectPath = (materialId, ext) => `${materialId}${String(ext || '.bin').toLowerCase()}`;

  return {
    async savePassages(materialId, passages) {
      await client.deleteRows('material_passages', { material_id: materialId });
      const rows = (passages ?? []).map((passage, position) => ({ material_id: materialId, position, data: passage }));
      // Chunked so a large document cannot exceed a single request body limit.
      for (let i = 0; i < rows.length; i += 200) {
        await client.upsertRows('material_passages', rows.slice(i, i + 200), 'material_id,position');
      }
    },
    async readPassages(materialId) {
      try {
        const rows = await client.selectAll('material_passages', {
          filters: { material_id: materialId },
          order: 'position.asc',
        });
        return rows.map((row) => row.data ?? {});
      } catch {
        return [];
      }
    },
    async deletePassages(materialId) {
      await client.deleteRows('material_passages', { material_id: materialId }).catch(() => {});
    },
    async saveRaw(materialId, ext, buffer) {
      await client.uploadObject(objectPath(materialId, ext), buffer);
      return objectPath(materialId, ext);
    },
    async readRaw(materialId, ext) {
      return client.downloadObject(objectPath(materialId, ext));
    },
    async deleteRaw(materialId, ext) {
      await client.removeObject(objectPath(materialId, ext));
    },
  };
}

/** Adapters for `createStore({ adapters })`. */
export function createSupabaseAdapters({ url, serviceRoleKey, logger, fetchImpl, storageBucket }) {
  const client = createSupabaseClient({ url, serviceRoleKey, fetchImpl, storageBucket });
  return {
    client,
    configured: client.configured,
    collections: (name) => createSupabaseCollection({ client, collection: name, logger }),
    blobs: createSupabaseBlobs({ client }),
  };
}

export default createSupabaseAdapters;
