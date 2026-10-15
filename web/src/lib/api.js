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
  let payload;
  if (body instanceof FormData) {
    payload = body; // let the browser set the multipart boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${API_BASE_URL}/api${path}`, { method, headers, body: payload, signal });
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

  // --- AI teacher -----------------------------------------------------------
  ask: (payload) => request('/chat', { method: 'POST', body: payload }),
  listSessions: () => request('/chat/sessions'),
  getSession: (id) => request(`/chat/sessions/${encodeURIComponent(id)}`),
  deleteSession: (id) => request(`/chat/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // --- practice quizzes -----------------------------------------------------
  generateQuiz: (payload) => request('/quiz/generate', { method: 'POST', body: payload }),
  listQuizzes: () => request('/quiz'),
  getQuiz: (id) => request(`/quiz/${encodeURIComponent(id)}`),
  submitQuiz: (id, answers) =>
    request(`/quiz/${encodeURIComponent(id)}/submit`, { method: 'POST', body: { answers } }),

  // --- study summaries ------------------------------------------------------
  summarise: (payload) => request('/summary', { method: 'POST', body: payload }),
  summaryOptions: () => request('/summary/meta/options'),

  // --- progress -------------------------------------------------------------
  progress: () => request('/progress'),
  revision: () => request('/progress/revision'),
};

export default api;
