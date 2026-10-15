/**
 * AI provider client.
 *
 * Every supported provider (Groq, Google AI Studio, OpenRouter, Mistral,
 * Cloudflare Workers AI, or any custom gateway) exposes an OpenAI-compatible
 * `/chat/completions` endpoint, so there is exactly one code path to maintain.
 *
 * Design rules:
 *  - The client is created only when the provider is genuinely configured.
 *    `null` means "offline demo mode", which is a first-class state, not an error.
 *  - We do NOT send `response_format` / tool calls: support varies per provider
 *    and a portable prompt + tolerant parser is more reliable here.
 *  - Retries are limited to genuinely retryable failures (429, 5xx, network).
 *    A 401 or 400 is returned to the caller immediately - retrying a bad key
 *    would just burn free-tier quota.
 *  - Request and response bodies are never logged: they contain coursework.
 */
import config from '../config.js';

export class AiProviderError extends Error {
  constructor(message, { status = 502, code = 'ai_provider_error', retryable = false, providerId = null } = {}) {
    super(message);
    this.name = 'AiProviderError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.providerId = providerId;
  }
}

const RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createProvider(aiConfig = config.ai, logger = null) {
  if (!aiConfig.configured) return null;

  const { providerId, baseUrl, apiKey, model, timeoutMs } = aiConfig;
  const endpoint = `${baseUrl}/chat/completions`;

  async function once({ messages, temperature, maxTokens, signal }, attempt) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        // OpenRouter asks for these; other providers ignore them.
        'HTTP-Referer': 'https://github.com/niter-parallax/learnsphere-ai',
        'X-Title': 'LearnSphere AI',
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      signal: combined,
    });

    if (!response.ok) {
      // Read a bounded slice of the error body for diagnosis, but never log the
      // request. Provider messages are safe to relay for 4xx (they describe the
      // request we made, not the material).
      const bodyText = (await response.text().catch(() => '')).slice(0, 400);
      const retryable = RETRY_STATUSES.has(response.status);
      const hint =
        response.status === 401 || response.status === 403
          ? 'The AI provider rejected the API key.'
          : response.status === 429
            ? 'The AI provider rate limit was reached.'
            : response.status === 404
              ? `The AI provider does not recognise the model "${model}".`
              : 'The AI provider returned an error.';
      throw new AiProviderError(hint, {
        status: response.status === 429 ? 429 : 502,
        code: response.status === 401 || response.status === 403 ? 'ai_auth_failed' : 'ai_provider_error',
        retryable,
        providerId,
      });
    }

    const data = await response.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new AiProviderError('The AI provider returned an empty response.', {
        status: 502,
        code: 'ai_empty_response',
        retryable: true,
        providerId,
      });
    }
    return { content: content.trim(), usage: data?.usage ?? null, attempt };
  }

  return {
    id: providerId,
    label: aiConfig.label,
    model,

    async chat({ messages, temperature = 0.2, maxTokens = 1400, signal } = {}) {
      const maxAttempts = 3;
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          return await once({ messages, temperature, maxTokens, signal }, attempt);
        } catch (err) {
          lastError = err;
          const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
          if (aborted) {
            throw new AiProviderError('The AI provider took too long to respond.', {
              status: 504,
              code: 'ai_timeout',
              retryable: true,
              providerId,
            });
          }
          const isNetwork = err instanceof TypeError; // fetch network failure
          const retryable = err instanceof AiProviderError ? err.retryable : isNetwork;
          if (!retryable || attempt === maxAttempts) break;
          // Exponential backoff with jitter, kept short enough for a UI spinner.
          const delay = Math.min(4000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
          logger?.warn('ai provider retry', { providerId, attempt, status: err?.status ?? null, delay });
          await sleep(delay);
        }
      }

      throw lastError instanceof AiProviderError
        ? lastError
        : new AiProviderError('Could not reach the AI provider.', {
            status: 502,
            code: 'ai_unreachable',
            retryable: true,
            providerId,
          });
    },
  };
}

export default createProvider;
