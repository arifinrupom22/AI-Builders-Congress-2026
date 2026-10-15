/**
 * Durable JSON collection with atomic writes.
 *
 * Deliberately dependency-free. Writes are serialised per file and committed
 * with a temp-file + rename so a crash mid-write can never leave a truncated
 * JSON file behind. Reads are cached in memory because every collection here is
 * small (a student's own materials).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export class JsonCollection {
  #file;
  #cache = null;
  #queue = Promise.resolve();
  #default;

  constructor(file, defaultValue) {
    this.#file = file;
    this.#default = defaultValue;
  }

  async #read() {
    if (this.#cache !== null) return this.#cache;
    try {
      const raw = await fs.readFile(this.#file, 'utf8');
      const parsed = JSON.parse(raw);
      this.#cache = Array.isArray(this.#default)
        ? Array.isArray(parsed)
          ? parsed
          : []
        : parsed && typeof parsed === 'object'
          ? parsed
          : structuredClone(this.#default);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // A corrupted store must not take the whole app down. Preserve the bad
        // file for inspection and carry on with an empty collection.
        const backup = `${this.#file}.corrupt-${Date.now()}`;
        await fs.rename(this.#file, backup).catch(() => {});
      }
      this.#cache = structuredClone(this.#default);
    }
    return this.#cache;
  }

  /** Read, mutate, and persist. The mutator may be async. */
  async update(mutator) {
    this.#queue = this.#queue.then(async () => {
      const data = await this.#read();
      const result = await mutator(data);
      await this.#commit(data);
      return result;
    });
    return this.#queue;
  }

  async read() {
    await this.#queue.catch(() => {});
    return this.#read();
  }

  async #commit(data) {
    const payload = JSON.stringify(data, null, 2);
    const dir = path.dirname(this.#file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.#file)}.${process.pid}.tmp`);
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, this.#file);
  }
}

export default JsonCollection;
