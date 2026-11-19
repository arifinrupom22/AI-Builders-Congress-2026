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
 *  - Providers are a chain: the primary is tried first and, if it fails, the
 *    configured fallbacks are tried in order. A free tier that rate-limits in
 *    the middle of a demo degrades to the next key instead of to an error.
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
const MAX_OUTPUT_TOKENS = 4096;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Output budget for one attempt.
 *
 * Reasoning models (Groq's `gpt-oss`, for example) spend part of the budget on
 * internal reasoning before writing the answer. With a tight cap, a long
 * question in Bangla could use the whole budget thinking and return empty
 * content. Retries therefore widen the budget instead of repeating the same
 * request into the same wall.
 */
function tokenBudget(maxTokens, attempt) {
  if (attempt <= 1) return maxTokens;
  return Math.min(MAX_OUTPUT_TOKENS, Math.round(maxTokens * (1 + 0.75 * (attempt - 1))));
}

/**
 * Remove a provider's inline chain of thought from a completion.
 *
 * Gemini's thinking models emit their planning text inside <thought> blocks in
 * the same string as the answer (Groq's `gpt-oss` puts it in a separate field).
 * That planning quotes the prompt back and sometimes reasons about the student,
 * so it must never reach the UI: only the answer after the closing tag is shown.
 * A response cut off mid-thought leaves an opening tag with no close, and
 * everything after it is reasoning, so it is dropped too.
 */
const THOUGHT_BLOCK = /<thought\b[^>]*>[\s\S]*?<\/thought\s*>/gi;
const OPEN_THOUGHT_BLOCK = /<thought\b[^>]*>[\s\S]*$/i;

export function stripReasoning(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  let out = text.replace(THOUGHT_BLOCK, '');
  if (/<thought\b/i.test(out)) out = out.replace(OPEN_THOUGHT_BLOCK, '');
  return out.trim();
}

function createSingleProvider(slot, logger) {
  const { providerId, baseUrl, apiKey, model, timeoutMs } = slot;
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
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: tokenBudget(maxTokens, attempt),
      }),
      signal: combined,
    });

    if (!response.ok) {
      // Read a bounded slice of the error body for diagnosis, but never log the
      // request. Provider messages are safe to relay for 4xx (they describe the
      // request we made, not the material).
      await response.text().catch(() => '');
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
    const message = data?.choices?.[0]?.message;
    // Some providers separate reasoning from the answer; where they do, the
    // answer is the content field alone. Where they inline it, it is stripped.
    const content = typeof message?.content === 'string' ? message.content : '';
    const answer = stripReasoning(content);
    if (answer.length === 0) {
      throw new AiProviderError('The AI provider returned an empty response.', {
        status: 502,
        code: 'ai_empty_response',
        retryable: true,
        providerId,
      });
    }
    return { content: answer, usage: data?.usage ?? null, attempt };
  }

  return {
    id: providerId,
    label: slot.label,
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
          logger?.warn('ai provider retry', {
            providerId,
            attempt,
            status: err?.status ?? null,
            code: err?.code ?? null,
            delay,
          });
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

/**
 * The provider chain.
 *
 * `chat()` returns the first successful answer, tagged with the provider that
 * produced it (`providerId`, `providerLabel`), so the transcript and the logs
 * say which key was used. If every provider fails, the last error is thrown -
 * the caller (the teacher, quiz generator, ...) already knows how to degrade to
 * the deterministic local answer and say what broke.
 */
export function createProvider(aiConfig = config.ai, logger = null) {
  if (!aiConfig.configured) return null;

  const slots = [aiConfig, ...(aiConfig.fallbacks ?? [])].filter((slot) => slot?.configured);
  const clients = slots.map((slot) => createSingleProvider(slot, logger));
  const primary = clients[0];

  return {
    id: primary.id,
    label: primary.label,
    model: primary.model,
    /** Every provider in the chain, primary first. No keys. */
    providers: clients.map((client) => ({ id: client.id, label: client.label, model: client.model })),

    async chat(args = {}) {
      let lastError = null;

      for (let index = 0; index < clients.length; index += 1) {
        const client = clients[index];
        try {
          const result = await client.chat(args);
          if (index > 0) {
            logger?.info('answer served by fallback provider', {
              providerId: client.id,
              skipped: clients.slice(0, index).map((c) => c.id),
            });
          }
          return { ...result, providerId: client.id, providerLabel: client.label };
        } catch (err) {
          lastError = err;
          // The browser went away: stop trying, this is not a provider fault.
          if (args.signal?.aborted) throw err;
          if (index < clients.length - 1) {
            logger?.warn('ai provider unavailable, trying the next provider', {
              providerId: client.id,
              code: err?.code ?? null,
              status: err?.status ?? null,
            });
          }
        }
      }

      throw lastError;
    },
  };
}

export default createProvider;
