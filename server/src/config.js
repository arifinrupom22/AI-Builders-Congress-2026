/**
 * LearnSphere AI - server configuration.
 *
 * Reads the repo-root `.env` (if present) and normalises everything into one
 * frozen object. Nothing in here is ever sent to the browser: `publicConfig()`
 * is the only sanctioned way to expose config to the client, and it whitelists
 * fields. In particular the API key is NEVER included.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(__dirname, '..');
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');

// Load the root .env only (never a .env inside web/, so a stray frontend env
// file can never leak into the server process).
const envFile = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile, quiet: true });
}

/**
 * Environment values that were set but rejected, so startup can report them
 * instead of silently substituting a different number.
 */
const rejected = [];

function num(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;

  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed)) {
    rejected.push(`${name}=${raw} (not a number) - using ${fallback}`);
    return fallback;
  }

  // Out-of-range values fall back to the documented default rather than being
  // clamped. Clamping is actively harmful here: a shell that exports PORT=0
  // (the usual "pick any free port" convention) would be clamped up to 1, so
  // the server would try to bind a privileged port instead of 8787 and appear
  // to start while being unreachable.
  if (parsed < min || parsed > max) {
    rejected.push(`${name}=${raw} (outside ${min}..${max}) - using ${fallback}`);
    return fallback;
  }

  return parsed;
}

function str(name, fallback = '') {
  const raw = process.env[name];
  return raw === undefined || raw === null ? fallback : String(raw).trim();
}

export const PROVIDER_IDS = ['none', 'groq', 'gemini', 'openrouter', 'mistral', 'cloudflare', 'custom'];

/** Default base URLs + models for every supported OpenAI-compatible provider. */
export const PROVIDER_PRESETS = {
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-20b',
    trainsOnData: false,
    keyUrl: 'https://console.groq.com/keys',
    privacy: 'Groq states it does not train models on your inputs or outputs.',
  },
  gemini: {
    label: 'Google AI Studio (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // gemini-2.5-flash now returns 404 for newly created keys; the preview
    // alias is the one that answers with current AI Studio keys.
    defaultModel: 'gemini-3-flash-preview',
    trainsOnData: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    privacy:
      'WARNING: Google may use free-tier prompts and responses to improve its products. Ask before uploading private material.',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/free',
    // null == depends on whichever upstream model the router picks.
    trainsOnData: null,
    keyUrl: 'https://openrouter.ai/keys',
    privacy: 'Data handling depends on whichever upstream model the router selects.',
  },
  mistral: {
    label: 'Mistral La Plateforme',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    trainsOnData: true,
    keyUrl: 'https://console.mistral.ai/',
    privacy: 'WARNING: Mistral may train on Free-mode inputs unless you opt out in the Admin panel.',
  },
  cloudflare: {
    label: 'Cloudflare Workers AI',
    baseUrlTemplate: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1',
    defaultModel: '@cf/meta/llama-3.1-8b-instruct',
    trainsOnData: false,
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    privacy: 'Cloudflare states it does not train models on customer content.',
  },
  custom: {
    label: 'Custom OpenAI-compatible endpoint',
    baseUrl: '',
    defaultModel: '',
    trainsOnData: null,
    keyUrl: '',
    privacy: 'Unknown - you are responsible for the privacy policy of your own endpoint.',
  },
};

function resolveAi() {
  const requested = (str('LEARNSPHERE_AI_PROVIDER', 'none') || 'none').toLowerCase();
  const providerId = PROVIDER_IDS.includes(requested) ? requested : 'none';
  const preset = providerId === 'none' ? null : PROVIDER_PRESETS[providerId];

  const accountId = str('CF_ACCOUNT_ID');
  let baseUrl = str('LEARNSPHERE_AI_BASE_URL');
  if (!baseUrl && preset?.baseUrlTemplate && accountId) {
    baseUrl = preset.baseUrlTemplate.replace('{accountId}', accountId);
  }
  if (!baseUrl) baseUrl = preset?.baseUrl ?? '';
  baseUrl = baseUrl.replace(/\/+$/, '');

  const model = str('LEARNSPHERE_AI_MODEL') || preset?.defaultModel || '';
  const apiKey = str('LEARNSPHERE_AI_API_KEY');

  // A provider is only "configured" when we truly have everything needed to
  // call it. We never pretend a half-configured provider works.
  const missing = [];
  if (providerId !== 'none' && !apiKey) missing.push('LEARNSPHERE_AI_API_KEY');
  if (providerId !== 'none' && !baseUrl) missing.push('LEARNSPHERE_AI_BASE_URL');
  if (providerId === 'cloudflare' && !accountId && !str('LEARNSPHERE_AI_BASE_URL')) missing.push('CF_ACCOUNT_ID');

  const timeoutMs = num('AI_TIMEOUT_MS', 45000, { min: 3000, max: 180000 });

  return {
    providerId,
    label: preset?.label ?? 'Offline demo mode',
    privacy: preset?.privacy ?? 'No document text leaves this machine.',
    providerTrainsOnData: preset?.trainsOnData ?? null,
    baseUrl,
    apiKey,
    model,
    configured: providerId !== 'none' && missing.length === 0,
    missing,
    timeoutMs,
    // Extra providers tried in order when the primary fails. A free tier that
    // rate-limits (or a key that runs out mid-demo) must not take the app down.
    fallbacks: resolveFallbackProviders(timeoutMs, rejected),
  };
}

/**
 * Additional providers, configured with numbered slots:
 *
 *   LEARNSPHERE_AI_FALLBACK1_PROVIDER=gemini
 *   LEARNSPHERE_AI_FALLBACK1_API_KEY=...
 *   LEARNSPHERE_AI_FALLBACK1_MODEL=gemini-2.5-flash    (optional)
 *   LEARNSPHERE_AI_FALLBACK1_BASE_URL=...              (optional)
 *
 * Up to three slots, so two spare Gemini keys can back up a Groq primary. A
 * slot that is only half filled is skipped and named in the config warnings
 * rather than silently pretending to be available.
 */
const FALLBACK_SLOTS = [1, 2, 3];

function resolveFallbackProviders(timeoutMs, rejected) {
  const providers = [];
  const seen = new Set();
  for (const slot of FALLBACK_SLOTS) {
    const prefix = `LEARNSPHERE_AI_FALLBACK${slot}`;
    const requested = (str(`${prefix}_PROVIDER`) || '').toLowerCase();
    if (!requested) continue;
    if (!PROVIDER_IDS.includes(requested) || requested === 'none') {
      rejected.push(`${prefix}_PROVIDER=${requested} (unknown provider) - slot skipped`);
      continue;
    }
    const preset = PROVIDER_PRESETS[requested];
    const accountId = str('CF_ACCOUNT_ID');
    let baseUrl = str(`${prefix}_BASE_URL`) || str('LEARNSPHERE_AI_BASE_URL');
    if (!baseUrl && preset?.baseUrlTemplate && accountId) {
      baseUrl = preset.baseUrlTemplate.replace('{accountId}', accountId);
    }
    if (!baseUrl) baseUrl = preset?.baseUrl ?? '';
    baseUrl = baseUrl.replace(/\/+$/, '');
    const model = str(`${prefix}_MODEL`) || preset?.defaultModel || '';
    const apiKey = str(`${prefix}_API_KEY`) || str('LEARNSPHERE_AI_API_KEY');

    const missing = [];
    if (!apiKey) missing.push(`${prefix}_API_KEY`);
    if (!baseUrl) missing.push(`${prefix}_BASE_URL`);
    if (missing.length > 0) {
      rejected.push(`${prefix}_PROVIDER=${requested} (incomplete: ${missing.join(', ')}) - slot skipped`);
      continue;
    }
    // One key per provider id: two Gemini slots holding the same key would just
    // repeat the same rate limit, so the duplicate is dropped.
    const key = `${requested}:${apiKey}`;
    if (seen.has(key)) continue;
    seen.add(key);

    providers.push({
      slot,
      providerId: requested,
      label: preset.label,
      privacy: preset.privacy,
      providerTrainsOnData: preset.trainsOnData,
      baseUrl,
      apiKey,
      model,
      configured: true,
      missing: [],
      timeoutMs,
    });
  }
  return providers;
}

const ai = resolveAi();
const envName = str('NODE_ENV', 'development') || 'development';

/**
 * Identity mode.
 *
 * 'required' is the only safe choice for a public deployment, so production
 * defaults to it. Development and the test suite keep the profile-based local
 * mode, which is what makes `npm run dev` work with no setup at all.
 */
const AUTH_MODES = ['local', 'required'];
// An empty value (the template ships `AUTH_MODE=`) means "use the default",
// which is `required` in production and `local` everywhere else.
const authModeDefault = envName === 'production' ? 'required' : 'local';
const requestedAuthMode = (str('AUTH_MODE') || authModeDefault).toLowerCase();
if (!AUTH_MODES.includes(requestedAuthMode)) {
  rejected.push(`AUTH_MODE=${requestedAuthMode} (unknown) - using local`);
}
const authMode = AUTH_MODES.includes(requestedAuthMode) ? requestedAuthMode : 'local';

/**
 * Number of reverse-proxy hops to trust for `req.ip` (and therefore for rate
 * limiting). Only a hop count is accepted: `true`/an arbitrary header cannot be
 * configured, because trusting a client-supplied X-Forwarded-For would let any
 * caller mint a fresh identity for every request. 0 disables it.
 */
const trustProxyRaw = (str('TRUST_PROXY') || '0').toLowerCase();
const parsedTrustProxy = trustProxyRaw === 'false' ? 0 : Number.parseInt(trustProxyRaw, 10);
const trustProxy = Number.isFinite(parsedTrustProxy) ? Math.max(0, Math.min(5, parsedTrustProxy)) : 0;
if (trustProxyRaw !== '0' && !Number.isFinite(parsedTrustProxy)) {
  rejected.push(`TRUST_PROXY=${trustProxyRaw} (not a hop count) - using 0`);
}

/**
 * Firebase identity. Only the project id is needed to verify an ID token: the
 * signing certificates are fetched from Google and cached. The service-account
 * fields are kept for completeness and are never sent to the browser.
 */
const firebase = Object.freeze({
  projectId: str('FIREBASE_PROJECT_ID'),
  clientEmail: str('FIREBASE_CLIENT_EMAIL'),
  privateKey: str('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n'),
  configured: Boolean(str('FIREBASE_PROJECT_ID')),
});

/**
 * Supabase data store. Both values must be present; a half-configured pair is
 * treated as "not configured" and reported in the startup warnings so a typo
 * cannot silently keep writing to local disk.
 */
const supabaseUrl = str('SUPABASE_URL');
const supabaseKey = str('SUPABASE_SERVICE_ROLE_KEY');
const supabaseConfigured = Boolean(supabaseUrl && supabaseKey);
if ((supabaseUrl && !supabaseKey) || (!supabaseUrl && supabaseKey)) {
  rejected.push('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY (only one of the pair is set) - using the local JSON store');
}
const supabase = Object.freeze({
  url: supabaseUrl,
  serviceRoleKey: supabaseKey,
  storageBucket: str('SUPABASE_STORAGE_BUCKET') || 'materials',
  configured: supabaseConfigured,
});

export const config = Object.freeze({
  version: '0.1.0',
  env: envName,
  trustProxy,
  port: num('PORT', 8787, { min: 1, max: 65535 }),
  corsAllowedOrigins: str('CORS_ALLOWED_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  projectRoot: PROJECT_ROOT,
  dataDir: str('LEARNSPHERE_DATA_DIR') || path.join(SERVER_ROOT, 'data'),

  upload: {
    maxBytes: num('MAX_UPLOAD_MB', 20, { min: 1, max: 100 }) * 1024 * 1024,
    maxDocuments: num('MAX_DOCUMENTS', 50, { min: 1, max: 1000 }),
    maxFilesPerRequest: num('MAX_FILES_PER_UPLOAD', 10, { min: 1, max: 50 }),
    // Every extension here has a reader in documents/extract.js. The list is
    // exported through publicConfig() so the upload control can advertise
    // exactly what the server will accept instead of a hard-coded guess.
    allowedExtensions: ['.pdf', '.txt', '.md', '.markdown', '.docx', '.doc', '.docm', '.rtf', '.odt'],
    allowedMimeTypes: [
      'application/pdf',
      'text/plain',
      'text/markdown',
      'text/rtf',
      'application/rtf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-word.document.macroEnabled.12',
      'application/vnd.oasis.opendocument.text',
      'application/octet-stream', // browsers are inconsistent for .md, .odt and .doc
    ],
  },

  retrieval: {
    topK: num('RETRIEVAL_TOP_K', 4, { min: 1, max: 12 }),
    // Minimum IDF-weighted query-term coverage for a passage to count as
    // "supported by your material". Below this we say so honestly.
    minScore: Number.parseFloat(str('RETRIEVAL_MIN_SCORE', '0.35')) || 0.35,
    contextChars: num('RETRIEVAL_CONTEXT_CHARS', 6000, { min: 1000, max: 40000 }),
    // A summary has to cover a whole document, so it is allowed a wider budget
    // than a question answer. Passages are sampled evenly across the document
    // up to this size rather than ranked by relevance.
    summaryChars: num('SUMMARY_CONTEXT_CHARS', 9000, { min: 2000, max: 40000 }),
  },

  limits: {
    rateLimitPerMinute: num('RATE_LIMIT_PER_MINUTE', 120, { min: 10, max: 10000 }),
    jsonBodyLimit: '256kb',
    chatQuestionMaxChars: num('CHAT_QUESTION_MAX_CHARS', 2000, { min: 1, max: 20000 }),
    maxQuizQuestions: num('MAX_QUIZ_QUESTIONS', 20, { min: 1, max: 50 }),
    maxFlashcards: num('MAX_FLASHCARDS', 20, { min: 1, max: 50 }),
    maxChatMessagesPerSession: num('MAX_CHAT_MESSAGES', 200, { min: 1, max: 5000 }),
  },

  auth: {
    mode: authMode,
    /**
     * 'allowlist' (default) restricts account creation to the team addresses in
     * auth/team.js. 'open' is for a deployment that should accept any sign-up;
     * it is never the default and the UI is told about it explicitly.
     */
    registrationPolicy: (str('AUTH_REGISTRATION_POLICY') || 'allowlist').toLowerCase() === 'open' ? 'open' : 'allowlist',
    sessionTtlDays: num('SESSION_TTL_DAYS', 14, { min: 1, max: 90 }),
    cookieName: 'ls_session',
    resetTokenTtlMinutes: num('AUTH_RESET_TTL_MINUTES', 30, { min: 5, max: 120 }),
    // No email provider is bundled. On non-production deployments the reset
    // token is returned to the page so the flow can actually be completed;
    // production returns the same generic answer and logs nothing sensitive.
    // Set AUTH_DEV_RESET=0 to hide even the development token.
    devReset: str('AUTH_DEV_RESET') === '0' ? false : envName !== 'production',
    resetEmailConfigured: Boolean(str('AUTH_RESET_EMAIL')),
  },

  ai,
  firebase,
  supabase,

  /** Environment variables that were set but rejected, with the value used instead. */
  warnings: rejected,

  /** Whitelisted, safe-to-expose configuration for the frontend. */
  publicConfig() {
    return {
      appVersion: this.version,
      ai: {
        providerId: this.ai.providerId,
        label: this.ai.label,
        model: this.ai.model,
        configured: this.ai.configured,
        // 'live' == real model answers. 'demo' == deterministic local answers.
        mode: this.ai.configured ? 'live' : 'demo',
        privacy: this.ai.privacy,
        providerTrainsOnData: this.ai.providerTrainsOnData,
        missingEnvVars: this.ai.missing,
        // Which providers can answer, primary first. Ids, labels and models
        // only - keys never leave the server.
        providers: [
          {
            id: this.ai.providerId,
            label: this.ai.label,
            model: this.ai.model,
            role: 'primary',
            configured: this.ai.configured,
          },
          ...this.ai.fallbacks.map((fallback) => ({
            id: fallback.providerId,
            label: fallback.label,
            model: fallback.model,
            role: 'fallback',
            configured: true,
          })),
        ],
      },
      retrieval: { topK: this.retrieval.topK, minScore: this.retrieval.minScore },
      auth: {
        mode: this.auth.mode,
        passwordReset: {
          emailConfigured: this.auth.resetEmailConfigured,
          // True only where the server deliberately shows the one-time token.
          devToken: this.auth.devReset,
        },
        // True only when the server verifies identity. The UI uses this to
        // decide between "sign in" and the profile switcher, and must never
        // present a profile id as an account.
        accounts: this.auth.mode !== 'local',
        // Which provider signs people in: Firebase when the server can verify
        // its tokens, otherwise the built-in password accounts (local demo and
        // any account not yet migrated).
        provider: this.firebase.configured ? 'firebase' : 'password',
        firebaseConfigured: this.firebase.configured,
        // Where application data lives. The UI only uses this for diagnostics.
        store: this.supabase.configured ? 'supabase' : 'json',
        // The allowlist itself is never exposed; only the fact that sign-up is
        // invitation-only, so the form can say so before a request is made.
        registrationPolicy: this.auth.registrationPolicy,
        invitationOnly: this.auth.registrationPolicy === 'allowlist',
        sessionTtlDays: this.auth.sessionTtlDays,
      },
      limits: {
        maxUploadBytes: this.upload.maxBytes,
        maxDocuments: this.upload.maxDocuments,
        maxFilesPerUpload: this.upload.maxFilesPerRequest,
        allowedExtensions: this.upload.allowedExtensions,
        maxQuizQuestions: this.limits.maxQuizQuestions,
        maxFlashcards: this.limits.maxFlashcards,
        chatQuestionMaxChars: this.limits.chatQuestionMaxChars,
      },
    };
  },
});

export default config;
