/**
 * LearnSphere AI storage layer.
 *
 * ONE module owns every byte that touches disk, so swapping local disk for a
 * database or object store later means implementing this interface and nothing
 * else. Everything is scoped by `learnerId`: no read, write or delete can
 * return another learner's row, even if a caller passes a foreign id.
 *
 * Identity is resolved before any of these methods run (middleware/auth.js).
 * With `AUTH_MODE=required` the learner id is the id of a server-verified
 * account session. With `AUTH_MODE=local` it is asserted by the client via a
 * header and is a data-scoping mechanism for a single-user deployment, NOT
 * authentication - the health endpoint and README say so explicitly.
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

export async function createStore({ dataDir, logger, adapters = null }) {
  const chunksDir = path.join(dataDir, 'chunks');
  const rawDir = path.join(dataDir, 'raw');
  // A database driver supplies its own collections and blob store; only the
  // local JSON driver needs directories on disk.
  if (!adapters) {
    await fs.mkdir(chunksDir, { recursive: true });
    await fs.mkdir(rawDir, { recursive: true });
  }
  const collection = (name, defaultValue) =>
    adapters?.collections ? adapters.collections(name) : new JsonCollection(path.join(dataDir, `${name}.json`), defaultValue);

  const materials = collection('materials', []);
  const sessions = collection('sessions', []);
  const quizzes = collection('quizzes', []);
  const attempts = collection('attempts', []);
  const decks = collection('flashcard-decks', []);
  const reviews = collection('flashcard-reviews', []);
  const visuals = collection('studio-visuals', []);
  const paths = collection('learning-paths', []);
  // Accounts and their sessions. Sessions store only a SHA-256 digest of the
  // cookie token, so a copy of this file cannot be replayed as a login.
  const users = collection('users', []);
  const authSessions = collection('auth-sessions', []);
  // Single-use password-reset tokens. Only the digest is stored, and a token
  // is deleted as soon as it is used or when the password changes.
  const passwordResets = collection('password-resets', []);
  const plans = collection('study-plans', []);

  // ---- passages ------------------------------------------------------------
  // Passages and uploaded originals are the only large blobs in the system. A
  // database driver can keep them in object storage; the default keeps them as
  // files next to the JSON collections.
  const blobs = adapters?.blobs ?? null;

  const chunkFile = (materialId) => path.join(chunksDir, `${assertSafeId(materialId, 'material id')}.json`);

  async function savePassages(materialId, passages) {
    if (blobs) return blobs.savePassages(materialId, passages);
    const file = chunkFile(materialId);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(passages), 'utf8');
    await fs.rename(tmp, file);
  }

  async function readPassages(materialId) {
    if (blobs) return blobs.readPassages(materialId);
    try {
      return JSON.parse(await fs.readFile(chunkFile(materialId), 'utf8'));
    } catch {
      return [];
    }
  }

  async function deletePassages(materialId) {
    if (blobs) return blobs.deletePassages(materialId);
    await fs.rm(chunkFile(materialId), { force: true });
  }

  // ---- raw uploads ---------------------------------------------------------
  function rawPath(materialId, ext) {
    const safeExt = ALLOWED_RAW_EXT.has(String(ext).toLowerCase()) ? String(ext).toLowerCase() : '.bin';
    return path.join(rawDir, `${assertSafeId(materialId, 'material id')}${safeExt}`);
  }

  async function saveRaw(materialId, ext, buffer) {
    if (blobs) return blobs.saveRaw(materialId, ext, buffer);
    const file = rawPath(materialId, ext);
    await fs.writeFile(file, buffer);
    return file;
  }

  async function readRaw(materialId, ext) {
    if (blobs) return blobs.readRaw(materialId, ext);
    return fs.readFile(rawPath(materialId, ext));
  }

  async function deleteRaw(materialId, ext) {
    if (blobs) return blobs.deleteRaw(materialId, ext);
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
    // Learner-set organisation. `subject` is null (not a placeholder string)
    // so the UI can offer a real "Unsorted" bucket instead of inventing one.
    subject: m.subject ?? null,
    tags: Array.isArray(m.tags) ? m.tags : [],
    pinned: m.pinned === true,
  });

  const store = {
    dataDir,
    materials,
    sessions,
    quizzes,
    attempts,
    decks,
    reviews,
    visuals,
    paths,
    users,
    authSessions,
    passwordResets,
    plans,

    // --- accounts -----------------------------------------------------------
    /** Internal record, including the password hash. Never send this out. */
    async createUserRecord({ email, emailKey, displayName, passwordHash, mustChangePassword = false }) {
      const record = {
        id: crypto.randomUUID(),
        email,
        emailKey,
        displayName,
        passwordHash,
        // Learner-chosen preferences. Optional everywhere; `auto` follows the
        // language of the material.
        profile: {
          language: 'auto',
          level: null,
          subjects: [],
          examDate: null,
          minutesPerDay: null,
          daysPerWeek: null,
        },
        onboardingCompleted: false,
        // Set for a server-provisioned bootstrap password; the API blocks every
        // learning route until the owner sets a real one.
        mustChangePassword: mustChangePassword === true,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      await users.update((list) => {
        if (list.some((u) => u.emailKey === emailKey)) {
          throw AppError.conflict('An account with this email already exists. Sign in instead.');
        }
        list.push(record);
      });
      return record;
    },

    /**
     * Bind a verified Firebase identity to an account row.
     *
     * An account row is found by `firebaseUid` only, and a brand-new account is
     * keyed by the Firebase UID directly. There is no email-based adoption of an
     * older row: every account belongs to the Firebase identity that signed up
     * for it, so its materials, quizzes and progress are that identity's own.
     */
    async upsertFirebaseUser({ uid, email, displayName, emailVerified = false }) {
      if (typeof uid !== 'string' || uid.length === 0) throw AppError.badRequest('A verified Firebase uid is required.');
      const emailKey = String(email ?? '').trim().toLowerCase();
      let record = null;

      // Fast path: this identity is already bound exactly as the token says, so
      // there is nothing to write. Without it every authenticated API request
      // would rewrite the account row (a whole-collection read plus a write).
      // Accounts are keyed by the Firebase UID only. There is no email-based
      // adoption of a pre-existing row: every account in this deployment is
      // created by its own Firebase sign-up.
      const known = await users.read();
      const bound = known.find((u) => u.firebaseUid === uid) ?? null;
      if (
        bound &&
        bound.firebaseUid === uid &&
        bound.authProvider === 'firebase' &&
        bound.emailVerified === (emailVerified === true) &&
        bound.mustChangePassword !== true
      ) {
        return bound;
      }
      await users.update((list) => {
        let idx = list.findIndex((u) => u.firebaseUid === uid);
        const stamp = nowIso();
        if (idx === -1) {
          record = {
            id: uid,
            firebaseUid: uid,
            email: email ?? null,
            emailKey: emailKey || null,
            displayName: displayName || (email ? email.split('@')[0] : 'Learner'),
            passwordHash: null,
            authProvider: 'firebase',
            emailVerified: emailVerified === true,
            profile: {
              language: 'auto',
              level: null,
              subjects: [],
              examDate: null,
              minutesPerDay: null,
              daysPerWeek: null,
            },
            onboardingCompleted: false,
            mustChangePassword: false,
            createdAt: stamp,
            updatedAt: stamp,
          };
          list.push(record);
          return;
        }
        const next = {
          ...list[idx],
          firebaseUid: uid,
          authProvider: 'firebase',
          emailVerified: emailVerified === true,
          updatedAt: stamp,
        };
        // Never overwrite an address or name the account already has: the
        // token is the authority for the uid, not for the profile.
        if (!next.email && email) next.email = email;
        if (!next.emailKey && emailKey) next.emailKey = emailKey;
        if (!next.displayName && displayName) next.displayName = displayName;
        next.mustChangePassword = false;
        list[idx] = next;
        record = next;
      });
      return record;
    },

    async findUserByEmailKey(emailKey) {
      const all = await users.read();
      return all.find((u) => u.emailKey === emailKey) ?? null;
    },

    async getUserById(id) {
      // Account ids are either a UUID (built-in password accounts) or a
      // Firebase UID (alphanumeric, 28 characters). Both are opaque server-side
      // values; neither is ever taken from a request body.
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
      const all = await users.read();
      return all.find((u) => u.id === id) ?? null;
    },

    async updateUserProfile(userId, patch, { onboardingCompleted } = {}) {
      let updated = null;
      await users.update((list) => {
        const idx = list.findIndex((u) => u.id === userId);
        if (idx === -1) return;
        const next = { ...list[idx], profile: { ...(list[idx].profile ?? {}), ...(patch ?? {}) } };
        if (typeof onboardingCompleted === 'boolean') next.onboardingCompleted = onboardingCompleted;
        next.updatedAt = nowIso();
        list[idx] = next;
        updated = next;
      });
      return updated;
    },

    async setUserPassword(userId, passwordHash, { mustChangePassword } = {}) {
      let updated = null;
      await users.update((list) => {
        const idx = list.findIndex((u) => u.id === userId);
        if (idx === -1) return;
        const next = { ...list[idx], passwordHash, updatedAt: nowIso() };
        if (typeof mustChangePassword === 'boolean') next.mustChangePassword = mustChangePassword;
        list[idx] = next;
        updated = next;
      });
      return updated;
    },

    async createAuthSession({ tokenHash, csrfHash = null, userId, expiresAt }) {
      await authSessions.update((list) => {
        const now = Date.now();
        for (let i = list.length - 1; i >= 0; i -= 1) {
          if (Date.parse(list[i].expiresAt) <= now) list.splice(i, 1);
        }
        // `id` is required by the database driver, which keys every row on it:
        // a row without an id is silently dropped, and the session would never
        // be readable again. The JSON driver ignores the extra field.
        list.push({ id: crypto.randomUUID(), tokenHash, csrfHash, userId, expiresAt, createdAt: nowIso() });
      });
    },

    async findAuthSession(tokenHash) {
      const all = await authSessions.read();
      return all.find((s) => s.tokenHash === tokenHash) ?? null;
    },

    async deleteAuthSession(tokenHash) {
      if (typeof tokenHash !== 'string') return false;
      let removed = false;
      await authSessions.update((list) => {
        const idx = list.findIndex((s) => s.tokenHash === tokenHash);
        if (idx !== -1) {
          list.splice(idx, 1);
          removed = true;
        }
      });
      return removed;
    },

    async deleteAuthSessionsForUser(userId) {
      await authSessions.update((list) => {
        for (let i = list.length - 1; i >= 0; i -= 1) {
          if (list[i].userId === userId) list.splice(i, 1);
        }
      });
    },

    /** Replace a reset token for this user; older ones stop working. */
    async createPasswordReset({ tokenHash, userId, expiresAt }) {
      await passwordResets.update((list) => {
        for (let i = list.length - 1; i >= 0; i -= 1) {
          if (list[i].userId === userId || Date.parse(list[i].expiresAt) <= Date.now()) list.splice(i, 1);
        }
        // See createAuthSession: a reset row needs an id to be stored at all.
        list.push({ id: crypto.randomUUID(), tokenHash, userId, expiresAt, createdAt: nowIso() });
      });
    },

    async findPasswordReset(tokenHash) {
      if (typeof tokenHash !== 'string' || tokenHash.length === 0) return null;
      const all = await passwordResets.read();
      return all.find((row) => row.tokenHash === tokenHash) ?? null;
    },

    async deletePasswordResetsForUser(userId) {
      await passwordResets.update((list) => {
        for (let i = list.length - 1; i >= 0; i -= 1) {
          if (list[i].userId === userId) list.splice(i, 1);
        }
      });
    },

    /**
     * Everything one learner owns, for an export or a deletion.
     * Scoped by learnerId like every other method; the caller never supplies a
     * row id. Password hashes are removed before a record ever leaves here.
     */
    async collectLearnerData(learnerId) {
      const [mats, sess, quizRows, attemptRows, deckRows, reviewRows, visualRows, pathRows, planRows] =
        await Promise.all([
          materials.read(),
          sessions.read(),
          quizzes.read(),
          attempts.read(),
          decks.read(),
          reviews.read(),
          visuals.read(),
          paths.read(),
          plans.read(),
        ]);
      const mine = (rows) => rows.filter((row) => row.learnerId === learnerId);
      const ownedMaterials = mine(mats);
      const passages = {};
      for (const material of ownedMaterials) {
        passages[material.id] = await readPassages(material.id);
      }
      return {
        exportedAt: nowIso(),
        learnerId,
        materials: ownedMaterials.map(({ learnerId: _owner, ...rest }) => rest),
        passages,
        sessions: mine(sess),
        quizzes: mine(quizRows),
        attempts: mine(attemptRows),
        flashcardDecks: mine(deckRows),
        flashcardReviews: mine(reviewRows),
        visuals: mine(visualRows),
        learningPaths: mine(pathRows),
        studyPlans: mine(planRows),
      };
    },

    /** Remove every row and file owned by one learner. Returns what was removed. */
    async deleteLearnerData(learnerId) {
      const owned = (await materials.read()).filter((m) => m.learnerId === learnerId);
      for (const material of owned) {
        await deletePassages(material.id);
        await deleteRaw(material.id, material.ext);
      }
      const removed = {};
      const purge = async (collection, key) => {
        let count = 0;
        await collection.update((list) => {
          for (let i = list.length - 1; i >= 0; i -= 1) {
            if (list[i].learnerId === learnerId) {
              list.splice(i, 1);
              count += 1;
            }
          }
        });
        removed[key] = count;
      };
      await purge(materials, 'materials');
      await purge(sessions, 'sessions');
      await purge(quizzes, 'quizzes');
      await purge(attempts, 'attempts');
      await purge(decks, 'decks');
      await purge(reviews, 'reviews');
      await purge(visuals, 'visuals');
      await purge(paths, 'paths');
      await purge(plans, 'plans');
      return removed;
    },

    async deleteUserRecord(userId) {
      let removed = false;
      await users.update((list) => {
        const idx = list.findIndex((u) => u.id === userId);
        if (idx !== -1) {
          list.splice(idx, 1);
          removed = true;
        }
      });
      await authSessions.update((list) => {
        for (let i = list.length - 1; i >= 0; i -= 1) {
          if (list[i].userId === userId) list.splice(i, 1);
        }
      });
      await passwordResets.update((list) => {
        for (let i = list.length - 1; i >= 0; i -= 1) {
          if (list[i].userId === userId) list.splice(i, 1);
        }
      });
      return removed;
    },

    // --- study plans --------------------------------------------------------
    async savePlan(record) {
      await plans.update((list) => {
        list.push(record);
        if (list.length > 50) {
          list.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
          list.splice(0, list.length - 50);
        }
      });
      return record;
    },

    async getPlan(id, learnerId) {
      assertSafeId(id, 'plan id');
      const all = await plans.read();
      return all.find((p) => p.id === id && p.learnerId === learnerId) ?? null;
    },

    async listPlans(learnerId, { limit = 20 } = {}) {
      const all = await plans.read();
      return all
        .filter((p) => p.learnerId === learnerId)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, limit);
    },

    /** Mutate one plan in place; returns null when it does not belong to the learner. */
    async updatePlan(id, learnerId, mutator) {
      assertSafeId(id, 'plan id');
      let updated = null;
      await plans.update((list) => {
        const idx = list.findIndex((p) => p.id === id && p.learnerId === learnerId);
        if (idx === -1) return;
        const draft = { ...list[idx] };
        mutator(draft);
        draft.updatedAt = nowIso();
        list[idx] = draft;
        updated = draft;
      });
      return updated;
    },

    async deletePlan(id, learnerId) {
      assertSafeId(id, 'plan id');
      let removed = false;
      await plans.update((list) => {
        const idx = list.findIndex((p) => p.id === id && p.learnerId === learnerId);
        if (idx !== -1) {
          list.splice(idx, 1);
          removed = true;
        }
      });
      return removed;
    },

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
      subject = null,
      tags = [],
      pinned = false,
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
        subject,
        tags,
        pinned,
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

    /**
     * Patch learner-set organisation fields (subject, tags, pinned).
     * Separated from `updateMaterial` so an index/status update can never
     * clobber the learner's own labelling, and vice versa.
     */
    async organiseMaterial(id, learnerId, patch) {
      assertSafeId(id, 'material id');
      let updated = null;
      await materials.update((list) => {
        const idx = list.findIndex((m) => m.id === id && m.learnerId === learnerId);
        if (idx === -1) return;
        const next = { ...list[idx] };
        if ('subject' in patch) next.subject = patch.subject;
        if ('tags' in patch) next.tags = patch.tags;
        if ('pinned' in patch) next.pinned = patch.pinned;
        list[idx] = { ...next, updatedAt: nowIso() };
        updated = publicMaterial(list[idx]);
      });
      return updated;
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

    // --- flashcards ---------------------------------------------------------
    async saveDeck(deck) {
      await decks.update((list) => {
        list.push(deck);
      });
      return deck;
    },

    async getDeck(id, learnerId) {
      assertSafeId(id, 'deck id');
      const all = await decks.read();
      return all.find((d) => d.id === id && d.learnerId === learnerId) ?? null;
    },

    async listDecks(learnerId, { limit = 50 } = {}) {
      const all = await decks.read();
      return all
        .filter((d) => d.learnerId === learnerId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit);
    },

    /** Mutate a deck in place via `mutator`; returns the updated record. */
    async updateDeck(id, learnerId, mutator) {
      assertSafeId(id, 'deck id');
      let updated = null;
      await decks.update((list) => {
        const idx = list.findIndex((d) => d.id === id && d.learnerId === learnerId);
        if (idx === -1) return;
        const draft = { ...list[idx] };
        mutator(draft);
        list[idx] = draft;
        updated = draft;
      });
      return updated;
    },

    async deleteDeck(id, learnerId) {
      assertSafeId(id, 'deck id');
      let removed = false;
      await decks.update((list) => {
        const idx = list.findIndex((d) => d.id === id && d.learnerId === learnerId);
        if (idx !== -1) {
          list.splice(idx, 1);
          removed = true;
        }
      });
      // Review history describes a deck that no longer exists; keep the store
      // free of orphans rather than leaving rows nothing can ever show.
      if (removed) {
        await reviews.update((list) => {
          for (let i = list.length - 1; i >= 0; i -= 1) {
            if (list[i].deckId === id && list[i].learnerId === learnerId) list.splice(i, 1);
          }
        });
      }
      return removed;
    },

    async saveReview(review) {
      await reviews.update((list) => {
        list.push(review);
      });
      return review;
    },

    async listReviews(learnerId, { deckId = null, limit = 200 } = {}) {
      const all = await reviews.read();
      return all
        .filter((r) => r.learnerId === learnerId && (!deckId || r.deckId === deckId))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit);
    },

    async listAttempts(learnerId, { limit = 200 } = {}) {
      const all = await attempts.read();
      return all
        .filter((a) => a.learnerId === learnerId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit);
    },

    // --- Visual Study Studio ------------------------------------------------
    /**
     * Save a studio visual, keeping the collection bounded: a picture's value
     * is in its citations, and an ever-growing file would eventually outweigh
     * any one of them. The oldest beyond the cap are pruned.
     */
    async saveVisual(visual, { maxSaved = 30 } = {}) {
      await visuals.update((list) => {
        list.push(visual);
        if (list.length > maxSaved) {
          list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
          list.splice(0, list.length - maxSaved);
        }
      });
      return visual;
    },

    async getVisual(id, learnerId) {
      assertSafeId(id, 'visual id');
      const all = await visuals.read();
      return all.find((v) => v.id === id && v.learnerId === learnerId) ?? null;
    },

    async listVisuals(learnerId, { limit = 50 } = {}) {
      const all = await visuals.read();
      return all
        .filter((v) => v.learnerId === learnerId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit);
    },

    async deleteVisual(id, learnerId) {
      assertSafeId(id, 'visual id');
      let removed = false;
      await visuals.update((list) => {
        const idx = list.findIndex((v) => v.id === id && v.learnerId === learnerId);
        if (idx !== -1) {
          list.splice(idx, 1);
          removed = true;
        }
      });
      return removed;
    },

    // --- guided learning path ----------------------------------------------
    async savePath(record) {
      await paths.update((list) => {
        list.push(record);
        // Same ceiling logic as visuals: a path's worth is in its citations,
        // and an unbounded file would eventually outweigh any one of them.
        if (list.length > 30) {
          list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
          list.splice(0, list.length - 30);
        }
      });
      return record;
    },

    async getPath(id, learnerId) {
      assertSafeId(id, 'learning path id');
      const all = await paths.read();
      return all.find((p) => p.id === id && p.learnerId === learnerId) ?? null;
    },

    async listPaths(learnerId, { limit = 50 } = {}) {
      const all = await paths.read();
      return all
        .filter((p) => p.learnerId === learnerId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit);
    },

    /** Mutate a saved path in place via `mutator`; returns the updated record. */
    async updatePath(id, learnerId, mutator) {
      assertSafeId(id, 'learning path id');
      let updated = null;
      await paths.update((list) => {
        const idx = list.findIndex((p) => p.id === id && p.learnerId === learnerId);
        if (idx === -1) return;
        const draft = { ...list[idx] };
        mutator(draft);
        draft.updatedAt = nowIso();
        list[idx] = draft;
        updated = draft;
      });
      return updated;
    },

    async deletePath(id, learnerId) {
      assertSafeId(id, 'learning path id');
      let removed = false;
      await paths.update((list) => {
        const idx = list.findIndex((p) => p.id === id && p.learnerId === learnerId);
        if (idx !== -1) {
          list.splice(idx, 1);
          removed = true;
        }
      });
      return removed;
    },

    // --- maintenance --------------------------------------------------------
    /** Used only by tests and the sample seeder. */
    async reset() {
      for (const collection of [
        materials,
        sessions,
        quizzes,
        attempts,
        decks,
        reviews,
        visuals,
        paths,
        users,
        authSessions,
        plans,
      ]) {
        await collection.update((data) => {
          if (Array.isArray(data)) data.length = 0;
        });
      }
      await passwordResets.update((data) => {
        if (Array.isArray(data)) data.length = 0;
      });
      await fs.rm(chunksDir, { recursive: true, force: true });
      await fs.rm(rawDir, { recursive: true, force: true });
      await fs.mkdir(chunksDir, { recursive: true });
      await fs.mkdir(rawDir, { recursive: true });
    },

    async stats(learnerId) {
      const [mats, sess, quizzesAll, attemptsAll, decksAll] = await Promise.all([
        store.listMaterials(learnerId),
        store.listSessions(learnerId, { limit: 1000 }),
        store.listQuizzes(learnerId, { limit: 1000 }),
        store.listAttempts(learnerId, { limit: 1000 }),
        store.listDecks(learnerId, { limit: 1000 }),
      ]);
      return {
        materials: mats.length,
        readyMaterials: mats.filter((m) => m.status === 'ready').length,
        passages: mats.reduce((sum, m) => sum + (m.passageCount || 0), 0),
        sessions: sess.length,
        quizzes: quizzesAll.length,
        attempts: attemptsAll.length,
        flashcardDecks: decksAll.length,
      };
    },
  };

  logger?.info('store ready', { dataDir });
  return store;
}

export default createStore;
