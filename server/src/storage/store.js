/**
 * LearnSphere AI storage layer.
 *
 * ONE module owns every byte that touches disk, so swapping local disk for a
 * database or object store later means implementing this interface and nothing
 * else. Everything is scoped by `learnerId`: no read, write or delete can
 * return another learner's row, even if a caller passes a foreign id.
 *
 * KNOWN LIMITATION (documented, not hidden): `learnerId` is asserted by the
 * client via a header. It is a data-scoping mechanism in a single-user local
 * deployment, NOT authentication. Adding real accounts (with signed sessions
 * and per-user authorisation) is the next milestone before any multi-tenant
 * deployment - see docs/ARCHITECTURE.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { JsonCollection } from './jsonCollection.js';
import AppError from '../errors.js';

export const DEFAULT_LEARNER_ID = 'local';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEARNER_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Only these suffixes may become a filename on disk; anything else is stored
// as .bin. The set is the same one the extractor can actually read.
const ALLOWED_RAW_EXT = new Set([
  '.pdf',
  '.txt',
  '.md',
  '.markdown',
  '.docx',
  '.doc',
  '.docm',
  '.rtf',
  '.odt',
]);

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Reject anything that could escape the data directory or corrupt a filename. */
export function assertSafeId(id, label = 'id') {
  if (!isUuid(id)) throw AppError.badRequest(`Invalid ${label}.`);
  return id;
}

export function normaliseLearnerId(raw) {
  if (typeof raw !== 'string') return DEFAULT_LEARNER_ID;
  const trimmed = raw.trim();
  return LEARNER_RE.test(trimmed) ? trimmed : DEFAULT_LEARNER_ID;
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const nowIso = () => new Date().toISOString();

export async function createStore({ dataDir, logger }) {
  const chunksDir = path.join(dataDir, 'chunks');
  const rawDir = path.join(dataDir, 'raw');
  await fs.mkdir(chunksDir, { recursive: true });
  await fs.mkdir(rawDir, { recursive: true });

  const materials = new JsonCollection(path.join(dataDir, 'materials.json'), []);
  const sessions = new JsonCollection(path.join(dataDir, 'sessions.json'), []);
  const quizzes = new JsonCollection(path.join(dataDir, 'quizzes.json'), []);
  const attempts = new JsonCollection(path.join(dataDir, 'attempts.json'), []);

  // ---- passages ------------------------------------------------------------
  const chunkFile = (materialId) => path.join(chunksDir, `${assertSafeId(materialId, 'material id')}.json`);

  async function savePassages(materialId, passages) {
    const file = chunkFile(materialId);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(passages), 'utf8');
    await fs.rename(tmp, file);
  }

  async function readPassages(materialId) {
    try {
      return JSON.parse(await fs.readFile(chunkFile(materialId), 'utf8'));
    } catch {
      return [];
    }
  }

  async function deletePassages(materialId) {
    await fs.rm(chunkFile(materialId), { force: true });
  }

  // ---- raw uploads ---------------------------------------------------------
  function rawPath(materialId, ext) {
    const safeExt = ALLOWED_RAW_EXT.has(String(ext).toLowerCase()) ? String(ext).toLowerCase() : '.bin';
    return path.join(rawDir, `${assertSafeId(materialId, 'material id')}${safeExt}`);
  }

  async function saveRaw(materialId, ext, buffer) {
    const file = rawPath(materialId, ext);
    await fs.writeFile(file, buffer);
    return file;
  }

  async function readRaw(materialId, ext) {
    return fs.readFile(rawPath(materialId, ext));
  }

  async function deleteRaw(materialId, ext) {
    await fs.rm(rawPath(materialId, ext), { force: true });
  }

  // ---- materials -----------------------------------------------------------
  const publicMaterial = (m) => ({
    id: m.id,
    name: m.name,
    sizeBytes: m.sizeBytes,
    kind: m.kind,
    // The extension is what the library UI groups files by; sending it avoids
    // the client re-deriving it (and getting it wrong for "notes.final.md").
    ext: m.ext ?? null,
    // Dominant language detected from the extracted text. Used to default the
    // quiz and summary language to the language of the material.
    language: m.language ?? null,
    status: m.status,
    error: m.error ?? null,
    warnings: m.warnings ?? [],
    pageCount: m.pageCount ?? 0,
    passageCount: m.passageCount ?? 0,
    charCount: m.charCount ?? 0,
    sha256: m.sha256,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    source: m.source ?? 'upload',
  });

  const store = {
    dataDir,
    materials,
    sessions,
    quizzes,
    attempts,

    // --- materials ----------------------------------------------------------
    async listMaterials(learnerId) {
      const all = await materials.read();
      return all
        .filter((m) => m.learnerId === learnerId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map(publicMaterial);
    },

    async getMaterial(id, learnerId) {
      assertSafeId(id, 'material id');
      const all = await materials.read();
      const found = all.find((m) => m.id === id && m.learnerId === learnerId);
      return found ? publicMaterial(found) : null;
    },

    async countMaterials(learnerId) {
      const all = await materials.read();
      return all.filter((m) => m.learnerId === learnerId).length;
    },

    async createMaterial({
      learnerId,
      name,
      sizeBytes,
      kind,
      ext,
      mimeType,
      hash,
      status = 'processing',
      source = 'upload',
      language = null,
    }) {
      const material = {
        id: crypto.randomUUID(),
        learnerId,
        name,
        sizeBytes,
        kind,
        ext,
        mimeType,
        sha256: hash,
        status,
        language,
        error: null,
        warnings: [],
        pageCount: 0,
        passageCount: 0,
        charCount: 0,
        source,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      await materials.update((list) => {
        list.push(material);
      });
      return publicMaterial(material);
    },

    /** Internal (non-public) record, e.g. to learn the file extension. */
    async getRawMaterialRecord(id, learnerId) {
      const all = await materials.read();
      return all.find((m) => m.id === id && m.learnerId === learnerId) ?? null;
    },

    async findMaterialByHash(learnerId, hash) {
      const all = await materials.read();
      const found = all.find((m) => m.learnerId === learnerId && m.sha256 === hash && m.status === 'ready');
      return found ? publicMaterial(found) : null;
    },

    async updateMaterial(id, learnerId, patch) {
      assertSafeId(id, 'material id');
      let updated = null;
      await materials.update((list) => {
        const idx = list.findIndex((m) => m.id === id && m.learnerId === learnerId);
        if (idx === -1) return;
        list[idx] = { ...list[idx], ...patch, updatedAt: nowIso() };
        updated = publicMaterial(list[idx]);
      });
      return updated;
    },

    async deleteMaterial(id, learnerId) {
      assertSafeId(id, 'material id');
      const record = await store.getRawMaterialRecord(id, learnerId);
      if (!record) return false;
      await materials.update((list) => {
        const idx = list.findIndex((m) => m.id === id && m.learnerId === learnerId);
        if (idx !== -1) list.splice(idx, 1);
      });
      await Promise.all([deletePassages(id), deleteRaw(id, record.ext)]);
      return true;
    },

    savePassages,
    readPassages,
    saveRaw,
    readRaw,

    /** Every passage belonging to one learner (used to build the search index). */
    async allPassagesForLearner(learnerId) {
      const all = await materials.read();
      const owned = all.filter((m) => m.learnerId === learnerId && m.status === 'ready');
      const groups = await Promise.all(
        owned.map(async (m) => ({
          material: publicMaterial(m),
          passages: await readPassages(m.id),
        })),
      );
      return groups;
    },

    // --- chat sessions ------------------------------------------------------
    async listSessions(learnerId, { limit = 20 } = {}) {
      const all = await sessions.read();
      return all
        .filter((s) => s.learnerId === learnerId)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, limit)
        .map((s) => ({
          id: s.id,
          title: s.title,
          messageCount: s.messages.length,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          lastQuestion: [...s.messages].reverse().find((m) => m.role === 'user')?.content ?? null,
        }));
    },

    async getSession(id, learnerId) {
      assertSafeId(id, 'session id');
      const all = await sessions.read();
      return all.find((s) => s.id === id && s.learnerId === learnerId) ?? null;
    },

    async createSession(learnerId, title = 'New study session') {
      const session = {
        id: crypto.randomUUID(),
        learnerId,
        title,
        messages: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      await sessions.update((list) => {
        list.push(session);
      });
      return session;
    },

    /** Append messages, enforcing a per-session cap so a file cannot grow forever. */
    async appendMessages(id, learnerId, newMessages, { maxMessages = 200 } = {}) {
      assertSafeId(id, 'session id');
      let result = null;
      await sessions.update((list) => {
        const idx = list.findIndex((s) => s.id === id && s.learnerId === learnerId);
        if (idx === -1) return;
        const joined = [...list[idx].messages, ...newMessages];
        list[idx].messages = joined.slice(-maxMessages);
        list[idx].updatedAt = nowIso();
        const firstQuestion = joined.find((m) => m.role === 'user');
        if (firstQuestion && (list[idx].title === 'New study session' || !list[idx].title)) {
          list[idx].title = firstQuestion.content.slice(0, 70);
        }
        result = list[idx];
      });
      return result;
    },

    async deleteSession(id, learnerId) {
      assertSafeId(id, 'session id');
      let removed = false;
      await sessions.update((list) => {
        const idx = list.findIndex((s) => s.id === id && s.learnerId === learnerId);
        if (idx !== -1) {
          list.splice(idx, 1);
          removed = true;
        }
      });
      return removed;
    },

    // --- quizzes ------------------------------------------------------------
    async saveQuiz(quiz) {
      await quizzes.update((list) => {
        list.push(quiz);
      });
      return quiz;
    },

    async getQuiz(id, learnerId) {
      assertSafeId(id, 'quiz id');
      const all = await quizzes.read();
      return all.find((q) => q.id === id && q.learnerId === learnerId) ?? null;
    },

    async listQuizzes(learnerId, { limit = 50 } = {}) {
      const all = await quizzes.read();
      return all
        .filter((q) => q.learnerId === learnerId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit);
    },

    async saveAttempt(attempt) {
      await attempts.update((list) => {
        list.push(attempt);
      });
      return attempt;
    },

    async listAttempts(learnerId, { limit = 200 } = {}) {
      const all = await attempts.read();
      return all
        .filter((a) => a.learnerId === learnerId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit);
    },

    // --- maintenance --------------------------------------------------------
    /** Used only by tests and the sample seeder. */
    async reset() {
      for (const collection of [materials, sessions, quizzes, attempts]) {
        await collection.update((data) => {
          if (Array.isArray(data)) data.length = 0;
        });
      }
      await fs.rm(chunksDir, { recursive: true, force: true });
      await fs.rm(rawDir, { recursive: true, force: true });
      await fs.mkdir(chunksDir, { recursive: true });
      await fs.mkdir(rawDir, { recursive: true });
    },

    async stats(learnerId) {
      const [mats, sess, quizzesAll, attemptsAll] = await Promise.all([
        store.listMaterials(learnerId),
        store.listSessions(learnerId, { limit: 1000 }),
        store.listQuizzes(learnerId, { limit: 1000 }),
        store.listAttempts(learnerId, { limit: 1000 }),
      ]);
      return {
        materials: mats.length,
        readyMaterials: mats.filter((m) => m.status === 'ready').length,
        passages: mats.reduce((sum, m) => sum + (m.passageCount || 0), 0),
        sessions: sess.length,
        quizzes: quizzesAll.length,
        attempts: attemptsAll.length,
      };
    },
  };

  logger?.info('store ready', { dataDir });
  return store;
}

export default createStore;
