/**
 * Regression: one failed update must not poison the collection.
 *
 * The old queue chained every write onto the previous promise. A rejected
 * mutator (or a failed disk write) left the chain rejected, so every later
 * update returned that same error without running, and the in-memory cache had
 * already been mutated in place - the failed write leaked into reads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonCollection } from '../src/storage/jsonCollection.js';

async function tempFile(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'learnsphere-queue-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'items.json');
}

test('a failed mutator does not poison later updates or the cache', async (t) => {
  const file = await tempFile(t);
  const collection = new JsonCollection(file, []);
  await collection.update((list) => list.push({ id: 1 }));

  await assert.rejects(
    collection.update((list) => {
      list.push({ id: 'partial' });
      throw new Error('mutator failed');
    }),
    /mutator failed/,
  );

  // The failed mutation was discarded, not left in memory.
  assert.deepEqual(await collection.read(), [{ id: 1 }]);

  const result = await collection.update((list) => {
    list.push({ id: 2 });
    return list.length;
  });
  assert.equal(result, 2);
  assert.deepEqual(await collection.read(), [{ id: 1 }, { id: 2 }]);

  // And the successful write really reached the file.
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), [{ id: 1 }, { id: 2 }]);
});

test('a failed commit keeps the cache consistent with the file', async (t) => {
  const file = await tempFile(t);
  const collection = new JsonCollection(file, []);
  await collection.update((list) => list.push({ id: 'kept' }));

  // Make the directory read-only for a moment on POSIX so the temp write fails.
  if (process.platform === 'win32') {
    // Windows does not honour directory mode bits; simulate the disk failure by
    // replacing the target with a directory, which makes rename fail.
    const blocked = path.join(path.dirname(file), 'blocked');
    await fs.writeFile(blocked, 'x');
    const blocker = new JsonCollection(path.join(blocked, 'nested.json'), []);
    await assert.rejects(blocker.update((list) => list.push({ id: 'gone' })));
    assert.deepEqual(await blocker.read(), []);
    return;
  }

  const dir = path.dirname(file);
  await fs.chmod(dir, 0o500);
  t.after(() => fs.chmod(dir, 0o700).catch(() => {}));
  await assert.rejects(collection.update((list) => list.push({ id: 'lost' })));
  await fs.chmod(dir, 0o700);

  assert.deepEqual(await collection.read(), [{ id: 'kept' }]);
  const next = await collection.update((list) => {
    list.push({ id: 'after' });
    return list.length;
  });
  assert.equal(next, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), [{ id: 'kept' }, { id: 'after' }]);
});
