/**
 * The provider chain: a healthy primary answers, a failing primary falls
 * through to the next configured key, and only a total failure reaches the
 * caller (which degrades to the local teacher).
 *
 * No network is used: `fetch` is stubbed, so these tests are deterministic and
 * do not spend anyone's free-tier quota.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, AiProviderError } from '../src/ai/provider.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function answer(content) {
  return jsonResponse({
    choices: [{ message: { role: 'assistant', content } }],
    usage: { total_tokens: 12 },
  });
}

function primaryConfig(overrides = {}) {
  return {
    configured: true,
    providerId: 'groq',
    label: 'Groq',
    baseUrl: 'https://primary.test/v1',
    apiKey: 'primary-key',
    model: 'model-a',
    timeoutMs: 2000,
    fallbacks: [],
    ...overrides,
  };
}

function fallbackSlot(overrides = {}) {
  return {
    configured: true,
    providerId: 'gemini',
    label: 'Google AI Studio (Gemini)',
    baseUrl: 'https://fallback.test/v1',
    apiKey: 'fallback-key',
    model: 'gemini-2.5-flash',
    timeoutMs: 2000,
    ...overrides,
  };
}

/** Replace fetch for one test and record every call. */
function stubFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const call = {
      url: String(url),
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return handler(call, calls.length);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const messages = [{ role: 'user', content: 'explain photosynthesis' }];

test('a healthy primary answers and is named in the result', async (t) => {
  const calls = stubFetch(t, () => answer('from the primary'));
  const provider = createProvider(primaryConfig({ fallbacks: [fallbackSlot()] }));

  const reply = await provider.chat({ messages });
  assert.equal(reply.content, 'from the primary');
  assert.equal(reply.providerId, 'groq');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://primary.test/v1/chat/completions');
});

test('a failing primary falls through to the next provider', async (t) => {
  const calls = stubFetch(t, (call) =>
    call.url.startsWith('https://primary.test') ? jsonResponse({ error: 'boom' }, 500) : answer('from the fallback'),
  );
  const provider = createProvider(primaryConfig({ fallbacks: [fallbackSlot()] }));

  const reply = await provider.chat({ messages });
  assert.equal(reply.content, 'from the fallback');
  assert.equal(reply.providerId, 'gemini');
  assert.equal(reply.providerLabel, 'Google AI Studio (Gemini)');
  // The primary is retried (500 is retryable) before the chain moves on.
  assert.ok(calls.length >= 2);
  assert.ok(calls.at(-1).url.startsWith('https://fallback.test'));
});

test('a rejected key is not retried, and the fallback still answers', async (t) => {
  const calls = stubFetch(t, (call) =>
    call.url.startsWith('https://primary.test') ? jsonResponse({ error: 'bad key' }, 401) : answer('from the fallback'),
  );
  const provider = createProvider(primaryConfig({ fallbacks: [fallbackSlot()] }));

  const reply = await provider.chat({ messages });
  assert.equal(reply.content, 'from the fallback');
  // Exactly one attempt per provider: a bad key must not burn quota.
  assert.equal(calls.length, 2);
});

test('the last error is thrown when every provider fails', async (t) => {
  stubFetch(t, (call) => jsonResponse({ error: 'down' }, 500));
  const provider = createProvider(primaryConfig({ fallbacks: [fallbackSlot()] }));

  await assert.rejects(() => provider.chat({ messages }), (err) => {
    assert.ok(err instanceof AiProviderError);
    assert.equal(err.code, 'ai_provider_error');
    assert.equal(err.providerId, 'gemini');
    return true;
  });
});

test('an empty response is retried with a wider token budget', async (t) => {
  const calls = stubFetch(t, (_call, n) =>
    n === 1
      ? jsonResponse({ choices: [{ message: { role: 'assistant', content: '' } }] })
      : answer('second attempt'),
  );
  const provider = createProvider(primaryConfig());

  const reply = await provider.chat({ messages, maxTokens: 400 });
  assert.equal(reply.content, 'second attempt');
  assert.equal(calls.length, 2);
  // A reasoning model can spend a tight budget before writing anything, so the
  // retry asks for more room instead of repeating the same request.
  assert.ok(calls[1].body.max_tokens > calls[0].body.max_tokens);
  assert.equal(calls[0].body.max_tokens, 400);
});

test('a cancelled request does not try the fallback', async (t) => {
  const controller = new AbortController();
  controller.abort();
  const calls = stubFetch(t, () => jsonResponse({ error: 'bad key' }, 401));
  const provider = createProvider(primaryConfig({ fallbacks: [fallbackSlot()] }));

  await assert.rejects(() => provider.chat({ messages, signal: controller.signal }));
  assert.equal(calls.length, 1, 'the fallback must not be called for an abandoned request');
});

test('no configured provider means offline demo mode, not an error', () => {
  assert.equal(createProvider({ configured: false }), null);
});

test('the chain lists its providers without exposing keys', async (t) => {
  stubFetch(t, () => answer('ok'));
  const provider = createProvider(
    primaryConfig({ fallbacks: [fallbackSlot(), fallbackSlot({ providerId: 'openrouter', label: 'OpenRouter', apiKey: 'second-key' })] }),
  );

  assert.deepEqual(
    provider.providers.map((entry) => entry.id),
    ['groq', 'gemini', 'openrouter'],
  );
  const serialised = JSON.stringify(provider.providers);
  assert.ok(!serialised.includes('primary-key'));
  assert.ok(!serialised.includes('fallback-key'));
});

test('inline <thought> reasoning is stripped from a completion', async (t) => {
  const { stripReasoning } = await import('../src/ai/provider.js');

  assert.equal(
    stripReasoning('<thought>The student asked about ACID; quote the middle passage.</thought>Atomicity means all or nothing.'),
    'Atomicity means all or nothing.',
  );

  // Several blocks, mixed case and attributes, plus surrounding whitespace.
  assert.equal(
    stripReasoning('<THOUGHT step="1">a</THOUGHT>\n\n<thought>b</thought>\nThe answer.'),
    'The answer.',
  );

  // A cut-off response leaves an opening tag with no close: the tail is reasoning.
  assert.equal(stripReasoning('The answer so far.<thought>and then I would'), 'The answer so far.');

  // Clean text, empty input and a response that is nothing but reasoning.
  assert.equal(stripReasoning('Plain answer.'), 'Plain answer.');
  assert.equal(stripReasoning(''), '');
  assert.equal(stripReasoning('<thought>only planning</thought>'), '');
});

test('a provider answer that is only reasoning is retried instead of shown', async (t) => {
  const calls = stubFetch(t, (_call, count) =>
    count === 1
      ? jsonResponse({ choices: [{ message: { role: 'assistant', content: '<thought>planning only</thought>' } }] })
      : answer('<thought>planning</thought>The real answer.'),
  );
  const provider = createProvider(primaryConfig());

  const reply = await provider.chat({ messages });
  assert.equal(reply.content, 'The real answer.');
  assert.equal(calls.length, 2);
});
