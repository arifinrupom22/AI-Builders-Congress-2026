/**
 * LearnSphere AI — API client.
 *
 * One thin wrapper around fetch so every request:
 *   - is prefixed with /api (the Vite dev server proxies it to Express),
 *   - carries the study-profile header the server uses to scope data,
 *   - turns an error response into a typed ApiError instead of a raw Response.
 *
 * The server never trusts the client, so nothing here is a security boundary:
 * it exists to keep the UI code free of fetch/bookkeeping noise.
 */

const LEARNER_STORAGE_KEY = 'learnsphere.learnerId';
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
export const DEFAULT_LEARNER_ID = 'local';
const LEARNER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The CSRF token is issued by the server as a readable cookie and echoed back
 * in a header. The HttpOnly session cookie is what actually authenticates; the
 * header proves the request came from this origin's own JavaScript.
 */
function csrfToken() {
  try {
    const match = document.cookie.match(/(?:^|;\s*)ls_csrf=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/** A failed API call, with the server's machine-readable code attached. */
export class ApiError extends Error {
  constructor(message, { status = 0, code = 'network_error', details = null, requestId = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  /** Field-level validation messages, when the server rejected the input. */
  get fields() {
    return Array.isArray(this.details?.fields) ? this.details.fields : [];
  }

  get isOffline() {
    return this.status === 0;
  }

  get isRateLimited() {
    return this.status === 429;
  }
}

export function normaliseLearnerId(raw) {
  const trimmed = String(raw ?? '').trim();
  return LEARNER_RE.test(trimmed) ? trimmed : DEFAULT_LEARNER_ID;
}

/** The active study profile. Stored locally; not an authentication mechanism. */
export function getLearnerId() {
  try {
    const stored = normaliseLearnerId(window.localStorage.getItem(LEARNER_STORAGE_KEY));
    return stored;
  } catch {
    return DEFAULT_LEARNER_ID;
  }
}

export function setLearnerId(raw) {
  const id = normaliseLearnerId(raw);
  try {
    window.localStorage.setItem(LEARNER_STORAGE_KEY, id);
  } catch {
    /* private browsing — the profile simply will not persist */
  }
  return id;
}

function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

/**
 * @param {string} path path after /api, e.g. "/materials"
 * @param {{method?:string, body?:unknown, signal?:AbortSignal, acceptStatuses?:number[]}} options
 */
async function request(path, { method = 'GET', body, signal, acceptStatuses = [] } = {}) {
  const headers = { 'X-Learner-Id': getLearnerId(), Accept: 'application/json' };
  if (!SAFE_METHODS.has(method)) {
    const token = csrfToken();
    if (token) headers['X-CSRF-Token'] = token;
  }
  let payload;
  if (body instanceof FormData) {
    payload = body; // let the browser set the multipart boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response;
  try {
    // Cookies are how a signed-in account's session travels; in local mode
    // there is simply no session cookie to send.
    response = await fetch(`${API_BASE_URL}/api${path}`, {
      method,
      headers,
      body: payload,
      signal,
      credentials: 'include',
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(
      'Cannot reach the LearnSphere AI server. Start it with "npm run dev" and try again.',
      { code: 'network_error' },
    );
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok && !acceptStatuses.includes(response.status)) {
    const error = data?.error ?? {};
    throw new ApiError(error.message || `Request failed with status ${response.status}.`, {
      status: response.status,
      code: error.code ?? 'http_error',
      details: error.details ?? null,
      requestId: error.requestId ?? null,
    });
  }

  if (!response.ok) {
    // An accepted non-2xx (e.g. 422 on upload) still carries a useful body.
    return { ...data, __status: response.status };
  }

  if (data === null) {
    throw new ApiError('The server returned a response the app could not read.', {
      status: response.status,
      code: 'malformed_response',
    });
  }
  return data;
}

export const api = {
  // --- accounts -------------------------------------------------------------
  /** Always 200; `user` is null when signed out. */
  session: () => request('/auth/session'),
  login: (payload) => request('/auth/login', { method: 'POST', body: payload }),
  register: (payload) => request('/auth/register', { method: 'POST', body: payload }),
  logout: () => request('/auth/logout', { method: 'POST', body: {} }),
  requestPasswordReset: (email) =>
    request('/auth/password-reset/request', { method: 'POST', body: { email } }),
  confirmPasswordReset: (payload) =>
    request('/auth/password-reset/confirm', { method: 'POST', body: payload }),

  // --- account ---------------------------------------------------------------
  account: () => request('/account'),
  updateProfile: (patch) => request('/account/profile', { method: 'PATCH', body: patch }),
  exportAccount: () => request('/account/export'),
  deleteAccount: (payload = {}) => request('/account', { method: 'DELETE', body: payload }),

  // --- system ---------------------------------------------------------------
  config: () => request('/config'),
  health: () => request('/health'),
  metaOptions: () => request('/materials/meta/options'),

  // --- materials ------------------------------------------------------------
  listMaterials: () => request('/materials'),
  getMaterial: (id) => request(`/materials/${encodeURIComponent(id)}`),
  getPassages: (id, { page = 1, limit = 5 } = {}) =>
    request(`/materials/${encodeURIComponent(id)}/passages${buildQuery({ page, limit })}`),
  searchMaterials: ({ q, limit = 8, materialIds } = {}) =>
    request(`/materials/search${buildQuery({ q, limit, materialIds })}`),
  uploadMaterial: (file, { signal } = {}) => {
    const form = new FormData();
    form.append('file', file);
    // 422 means "stored, but the text could not be extracted" — a real answer,
    // not a transport failure, so the UI decides what to say about it.
    return request('/materials', { method: 'POST', body: form, signal, acceptStatuses: [422] });
  },
  deleteMaterial: (id) => request(`/materials/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Learner-set organisation: subject, tags, pinned. Content is untouched. */
  organiseMaterial: (id, patch) =>
    request(`/materials/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),

  // --- AI teacher -----------------------------------------------------------
  ask: (payload) => request('/chat', { method: 'POST', body: payload }),
  listSessions: () => request('/chat/sessions'),
  getSession: (id) => request(`/chat/sessions/${encodeURIComponent(id)}`),
  deleteSession: (id) => request(`/chat/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // --- practice quizzes -----------------------------------------------------
  generateQuiz: (payload) => request('/quiz/generate', { method: 'POST', body: payload }),
  listQuizzes: () => request('/quiz'),
  getQuiz: (id) => request(`/quiz/${encodeURIComponent(id)}`),
  /** Concept-level feedback for one wrong answer; confidence is context only. */
  diagnoseGap: (id, { questionId, confidence = null }) =>
    request(`/quiz/${encodeURIComponent(id)}/gap`, {
      method: 'POST',
      body: { questionId, confidence },
    }),
  /** `elapsedSeconds` is context for the optional study timer, never a score input. */
  submitQuiz: (id, answers, elapsedSeconds = null) =>
    request(`/quiz/${encodeURIComponent(id)}/submit`, {
      method: 'POST',
      body: { answers, ...(elapsedSeconds != null ? { elapsedSeconds } : {}) },
    }),

  // --- flashcards ----------------------------------------------------------
  generateFlashcards: (payload) => request('/flashcards/generate', { method: 'POST', body: payload }),
  listFlashcardDecks: () => request('/flashcards'),
  getFlashcardDeck: (id) => request(`/flashcards/${encodeURIComponent(id)}`),
  reviewFlashcards: (id, results) =>
    request(`/flashcards/${encodeURIComponent(id)}/review`, { method: 'POST', body: { results } }),
  deleteFlashcardDeck: (id) => request(`/flashcards/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** The "Due for review" queue. `summary` asks for counts only (entry points). */
  dueFlashcards: ({ limit, summary } = {}) =>
    request(`/flashcards/due${buildQuery({ limit, summary: summary ? '1' : undefined })}`),
  /** Push one card's due date later. Records no rating. */
  snoozeFlashcard: (id, cardId, minutes) =>
    request(`/flashcards/${encodeURIComponent(id)}/snooze`, {
      method: 'POST',
      body: { cardId, ...(minutes ? { minutes } : {}) },
    }),

  // --- study summaries ------------------------------------------------------
  summarise: (payload) => request('/summary', { method: 'POST', body: payload }),
  summaryOptions: () => request('/summary/meta/options'),

  // --- Visual Study Studio --------------------------------------------------
  /** Builds one source-grounded visual; 422 explains what the material lacks. */
  generateVisual: (payload) => request('/visuals/generate', { method: 'POST', body: payload }),
  visualOptions: () => request('/visuals/meta/options'),
  listVisuals: () => request('/visuals'),
  getVisual: (id) => request(`/visuals/${encodeURIComponent(id)}`),
  deleteVisual: (id) => request(`/visuals/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // --- guided learning path -------------------------------------------------
  /** Builds a grounded path; 422 explains what the material does not cover. */
  generatePath: (payload) => request('/learning-path/generate', { method: 'POST', body: payload }),
  listPaths: () => request('/learning-path'),
  getPath: (id) => request(`/learning-path/${encodeURIComponent(id)}`),
  deletePath: (id) => request(`/learning-path/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Marks one step done or not done — the learner's own record, never scored. */
  setStepCompleted: (id, stepId, completed) =>
    request(`/learning-path/${encodeURIComponent(id)}/progress`, {
      method: 'PATCH',
      body: { stepId, completed },
    }),
  /** Builds a step's studio visual once; the result is stored on the path. */
  generateStepVisual: (id, stepId) =>
    request(`/learning-path/${encodeURIComponent(id)}/steps/${encodeURIComponent(stepId)}/visual`, {
      method: 'POST',
      body: {},
    }),

  // --- progress -------------------------------------------------------------
  progress: () => request('/progress'),
  revision: () => request('/progress/revision'),

  // --- learning DNA ---------------------------------------------------------
  /** Read-only evidence profile derived from this profile's attempts and ratings. */
  learningDna: () => request('/dna'),

  // --- adaptive exam coach --------------------------------------------------
  /** The next recommended quiz and the plan behind it; read-only. */
  coachPlan: () => request('/coach/plan'),

  // --- teach-back ------------------------------------------------------------
  /** Word-level, source-grounded feedback; read-only and never graded. */
  teachBack: (payload) => request('/teachback', { method: 'POST', body: payload }),

  // --- study plan -----------------------------------------------------------
  listPlans: () => request('/plan'),
  planToday: () => request('/plan/today'),
  getPlan: (id) => request(`/plan/${encodeURIComponent(id)}`),
  createPlan: (payload) => request('/plan', { method: 'POST', body: payload }),
  updatePlan: (id, patch) => request(`/plan/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  setPlanTask: (id, taskId, status) =>
    request(`/plan/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      body: { status },
    }),
  refreshPlan: (id) => request(`/plan/${encodeURIComponent(id)}/refresh`, { method: 'POST', body: {} }),
  deletePlan: (id) => request(`/plan/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export default api;
