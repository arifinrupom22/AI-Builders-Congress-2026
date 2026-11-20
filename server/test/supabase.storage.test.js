import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../src/storage/store.js';
import { createSupabaseCollection, createSupabaseBlobs, createSupabaseClient } from '../src/storage/supabase.js';

/**
 * A client that records what the adapters ask it to do. The real client talks to
 * PostgREST; the adapters must not depend on anything above this surface.
 */
function recordingClient(initialRows = []) {
  const rows = structuredClone(initialRows);
  const calls = { inserts: [], updates: [], deletes: [] };
  return {
    calls,
    rows,
    async selectAll(_table, { filters }) {
      const column = filters.collection?.replace('eq.', '');
      return rows.filter((row) => row.collection === column).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    },
    async upsertRows(_table, inserted) {
      calls.inserts.push(...inserted);
      rows.push(...structuredClone(inserted));
    },
    async patchRows(_table, filters, patch) {
      calls.updates.push({ filters, patch });
      const row = rows.find((r) => r.collection === filters.collection && r.id === filters.id);
      if (row) Object.assign(row, structuredClone(patch));
    },
    async deleteRows(_table, filters) {
      calls.deletes.push(filters);
      const index = rows.findIndex((r) => r.collection === filters.collection && r.id === filters.id);
      if (index !== -1) rows.splice(index, 1);
    },
  };
}

test('a collection reads rows and writes only the difference', async () => {
  const client = recordingClient([{ collection: 'materials', id: 'a', owner_id: 'u1', data: { id: 'a', name: 'old' }, created_at: '1' }]);
  const collection = createSupabaseCollection({ client, collection: 'materials', scope: 'u1' });

  const rows = await collection.read();
  assert.deepEqual(rows, [{ id: 'a', name: 'old' }]);

  await collection.update((list) => {
    list[0].name = 'renamed';
    list.push({ id: 'b', name: 'fresh' });
  });

  assert.deepEqual(client.calls.inserts.map((row) => row.id), ['b']);
  assert.equal(client.calls.inserts[0].owner_id, 'u1');
  assert.deepEqual(client.calls.updates.map((entry) => entry.filters.id), ['a']);
  assert.equal(client.calls.updates[0].patch.data.name, 'renamed');
  assert.equal(client.calls.deletes.length, 0);
});

test('a removed row is deleted, and an unchanged collection writes nothing', async () => {
  const client = recordingClient([
    { collection: 'materials', id: 'a', owner_id: 'u1', data: { id: 'a' }, created_at: '1' },
    { collection: 'materials', id: 'b', owner_id: 'u1', data: { id: 'b' }, created_at: '2' },
  ]);
  const collection = createSupabaseCollection({ client, collection: 'materials', scope: 'u1' });

  await collection.update((list) => {
    list.splice(0, 1);
  });
  assert.deepEqual(client.calls.deletes, [{ collection: 'materials', id: 'a' }]);

  const callsBefore = JSON.stringify(client.calls);
  await collection.update(() => undefined);
  assert.equal(JSON.stringify(client.calls), callsBefore);
});

test('a failed mutator leaves the stored rows untouched', async () => {
  const client = recordingClient([{ collection: 'materials', id: 'a', owner_id: 'u1', data: { id: 'a' }, created_at: '1' }]);
  const collection = createSupabaseCollection({ client, collection: 'materials', scope: 'u1' });

  await assert.rejects(
    collection.update((list) => {
      list.push({ id: 'b' });
      throw new Error('validation failed');
    }),
  );
  assert.equal(client.calls.inserts.length, 0);
  assert.equal(client.rows.length, 1);
});

test('passages and uploaded files go through the database and object storage', async () => {
  const calls = [];
  const client = {
    async deleteRows(table, filters) {
      calls.push(['delete', table, filters]);
    },
    async upsertRows(table, rows) {
      calls.push(['upsert', table, rows.length]);
    },
    async selectAll(table) {
      calls.push(['select', table]);
      return [{ data: { text: 'one', page: 1 } }, { data: { text: 'two', page: 2 } }];
    },
    async uploadObject(objectPath, buffer) {
      calls.push(['upload', objectPath, buffer.toString()]);
      return objectPath;
    },
    async downloadObject(objectPath) {
      calls.push(['download', objectPath]);
      return Buffer.from('hello');
    },
    async removeObject(objectPath) {
      calls.push(['remove', objectPath]);
    },
  };

  const blobs = createSupabaseBlobs({ client });
  await blobs.savePassages('m1', [{ text: 'one' }, { text: 'two' }]);
  assert.equal((await blobs.readPassages('m1')).length, 2);
  await blobs.deletePassages('m1');
  assert.equal(await blobs.saveRaw('m1', '.PDF', Buffer.from('hello')), 'm1.pdf');
  assert.equal((await blobs.readRaw('m1', '.pdf')).toString(), 'hello');
  await blobs.deleteRaw('m1', '.pdf');

  assert.deepEqual(calls[0], ['delete', 'material_passages', { material_id: 'm1' }]);
  assert.deepEqual(calls[1], ['upsert', 'material_passages', 2]);
  assert.deepEqual(calls[2], ['select', 'material_passages']);
  assert.deepEqual(calls[3], ['delete', 'material_passages', { material_id: 'm1' }]);
  assert.deepEqual(calls[4], ['upload', 'm1.pdf', 'hello']);
  assert.deepEqual(calls[5], ['download', 'm1.pdf']);
  assert.deepEqual(calls[6], ['remove', 'm1.pdf']);
});

test('an unconfigured client refuses to send a request', async () => {
  const client = createSupabaseClient({ url: '', serviceRoleKey: '' });
  assert.equal(client.configured, false);
  await assert.rejects(client.selectAll('records'), /not configured/);
});

test('a malformed Supabase URL is treated as not configured', () => {
  const client = createSupabaseClient({ url: 'not a url', serviceRoleKey: 'key' });
  assert.equal(client.configured, false);
});

test('the whole store works against database adapters without touching disk', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learnsphere-supabase-'));
  const memory = new Map();
  const adapters = {
    collections: (name) => ({
      async read() {
        return structuredClone(memory.get(name) ?? []);
      },
      async update(mutator) {
        const draft = structuredClone(memory.get(name) ?? []);
        const result = await mutator(draft);
        memory.set(name, draft);
        return result;
      },
    }),
    blobs: {
      async savePassages(materialId, passages) {
        memory.set(`passages:${materialId}`, passages);
      },
      async readPassages(materialId) {
        return memory.get(`passages:${materialId}`) ?? [];
      },
      async deletePassages(materialId) {
        memory.delete(`passages:${materialId}`);
      },
      async saveRaw(materialId, ext, buffer) {
        memory.set(`raw:${materialId}`, buffer);
        return `${materialId}${ext}`;
      },
      async readRaw(materialId) {
        return memory.get(`raw:${materialId}`);
      },
      async deleteRaw(materialId) {
        memory.delete(`raw:${materialId}`);
      },
    },
  };

  const store = await createStore({ dataDir, logger: null, adapters });

  const material = await store.createMaterial({
    learnerId: 'firebase-uid-1',
    name: 'notes.md',
    sizeBytes: 10,
    kind: 'text',
    ext: '.md',
    mimeType: 'text/markdown',
    hash: 'abc',
    status: 'ready',
  });
  await store.savePassages(material.id, [{ text: 'grounded passage' }]);
  await store.updateMaterial(material.id, 'firebase-uid-1', { passageCount: 1 });

  assert.equal((await store.listMaterials('firebase-uid-1')).length, 1);
  assert.equal((await store.listMaterials('someone-else')).length, 0);
  assert.equal((await store.readPassages(material.id))[0].text, 'grounded passage');

  const session = await store.createSession('firebase-uid-1', 'First');
  await store.appendMessages(session.id, 'firebase-uid-1', [
    { role: 'user', content: 'What is a transaction?' },
    { role: 'assistant', content: 'Atomicity, consistency, isolation, durability.' },
  ]);
  const stored = await store.getSession(session.id, 'firebase-uid-1');
  assert.equal(stored.messages.length, 2);
  assert.equal(await store.getSession(session.id, 'someone-else'), null);

  assert.equal(await store.deleteMaterial(material.id, 'firebase-uid-1'), true);
  assert.equal(await store.readPassages(material.id).then((rows) => rows.length), 0);

  // Nothing was written to the data directory: the adapters are the only sink.
  const onDisk = await fs.readdir(dataDir);
  assert.deepEqual(onDisk, []);

  await fs.rm(dataDir, { recursive: true, force: true });
});

test('a Firebase identity is attached to an existing account by email', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learnsphere-firebase-user-'));
  const store = await createStore({ dataDir, logger: null });

  const legacy = await store.createUserRecord({
    email: 'arifinrupom30@gmail.com',
    emailKey: 'arifinrupom30@gmail.com',
    displayName: 'Rupom',
    passwordHash: 'scrypt',
  });

  const attached = await store.upsertFirebaseUser({
    uid: 'firebase-uid-42',
    email: 'arifinrupom30@gmail.com',
    displayName: 'Rupom',
    emailVerified: true,
  });

  // The same row keeps its id, so every material and plan still belongs to it.
  assert.equal(attached.id, legacy.id);
  assert.equal(attached.firebaseUid, 'firebase-uid-42');
  assert.equal(attached.authProvider, 'firebase');
  assert.equal(attached.emailVerified, true);
  assert.equal((await store.findUserByEmailKey('arifinrupom30@gmail.com')).id, legacy.id);

  const fresh = await store.upsertFirebaseUser({ uid: 'firebase-uid-9', email: 'new@example.com', emailVerified: true });
  assert.equal(fresh.id, 'firebase-uid-9');
  assert.equal(fresh.displayName, 'new');
  assert.equal(fresh.mustChangePassword, false);
  assert.equal((await store.getUserById('firebase-uid-9')).email, 'new@example.com');

  await fs.rm(dataDir, { recursive: true, force: true });
});
