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
    defaultModel: 'gemini-2.5-flash',
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
    timeoutMs: num('AI_TIMEOUT_MS', 45000, { min: 3000, max: 180000 }),
  };
}

const ai = resolveAi();

export const config = Object.freeze({
  version: '0.1.0',
  env: str('NODE_ENV', 'development') || 'development',
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
    maxChatMessagesPerSession: num('MAX_CHAT_MESSAGES', 200, { min: 1, max: 5000 }),
  },

  ai,

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
      },
      retrieval: { topK: this.retrieval.topK, minScore: this.retrieval.minScore },
      limits: {
        maxUploadBytes: this.upload.maxBytes,
        maxDocuments: this.upload.maxDocuments,
        maxFilesPerUpload: this.upload.maxFilesPerRequest,
        allowedExtensions: this.upload.allowedExtensions,
        maxQuizQuestions: this.limits.maxQuizQuestions,
        chatQuestionMaxChars: this.limits.chatQuestionMaxChars,
      },
    };
  },
});

export default config;
