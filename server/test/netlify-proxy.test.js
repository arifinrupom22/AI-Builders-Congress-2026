import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { handler } from '../../netlify/functions/api.mjs';

const DEFAULT_BACKEND_ORIGIN = 'https://ai-builders-congress-2026.onrender.com';
const SITE = 'https://ai-builders-congress-2026.netlify.app';

/** Run `body` with the backend override removed and fetch replaced. */
async function withStubs({ backendUrl, fetchImpl } = {}, body) {
  const previousUrl = process.env.LEARNSPHERE_BACKEND_URL;
  const previousFetch = globalThis.fetch;
  if (backendUrl === undefined) delete process.env.LEARNSPHERE_BACKEND_URL;
  else process.env.LEARNSPHERE_BACKEND_URL = backendUrl;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  try {
    return await body();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.LEARNSPHERE_BACKEND_URL;
    else process.env.LEARNSPHERE_BACKEND_URL = previousUrl;
  }
}

function okResponse(payload = { status: 'ok' }) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A request as Netlify delivers it: the redirect rewrote /api/x to the function path. */
function invoke(pathname, init) {
  return new Request(`${SITE}${pathname}`, init);
}

test('Netlify API proxy returns a standard Response, not a legacy Lambda object', async () => {
  await withStubs({ fetchImpl: async () => okResponse() }, async () => {
    const result = await handler(invoke('/.netlify/functions/api/health'));
    // This assertion is the regression guard for the production failure
    // "NetlifyUserError: Function returned an unsupported value. Accepted types
    // are 'Response' or 'undefined'".
    assert.ok(result instanceof Response, 'the handler must resolve to a Response');
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type'), 'application/json');
    assert.deepEqual(await result.json(), { status: 'ok' });
  });
});

test('Netlify API proxy falls back to the deployed backend when no override is set', async () => {
  await withStubs({ fetchImpl: async (url) => {
    assert.equal(new URL(String(url)).origin, DEFAULT_BACKEND_ORIGIN);
    return okResponse();
  } }, async () => {
    const result = await handler(invoke('/.netlify/functions/api/health'));
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { status: 'ok' });
  });
});

test('Netlify API proxy rejects a malformed backend URL instead of guessing', async () => {
  await withStubs({ backendUrl: 'ftp://not-http.example', fetchImpl: async () => assert.fail('fetch must not run') }, async () => {
    const result = await handler(invoke('/.netlify/functions/api/health'));
    assert.equal(result.status, 503);
    const body = await result.json();
    assert.equal(body.error.code, 'invalid_backend_url');
    assert.equal(body.error.retryable, false);
  });
});

test('Netlify API proxy forwards API path, query, learner header and request body', async () => {
  let forwarded;
  await withStubs({
    backendUrl: 'https://learnsphere-api.example.test',
    fetchImpl: async (url, options) => {
      forwarded = { url: String(url), options };
      return okResponse();
    },
  }, async () => {
    const result = await handler(
      invoke('/.netlify/functions/api/summary?length=brief', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-learner-id': 'learner-1',
          origin: SITE,
          host: 'ai-builders-congress-2026.netlify.app',
          'accept-encoding': 'gzip, br',
        },
        body: '{"length":"brief"}',
      }),
    );

    assert.equal(forwarded.url, 'https://learnsphere-api.example.test/api/summary?length=brief');
    assert.equal(forwarded.options.method, 'POST');
    assert.equal(forwarded.options.headers.get('x-learner-id'), 'learner-1');
    assert.equal(forwarded.options.headers.get('content-type'), 'application/json');
    assert.equal(forwarded.options.headers.has('origin'), false);
    assert.equal(forwarded.options.headers.has('host'), false);
    // The proxy must negotiate its own encoding so it can decode the body.
    assert.equal(forwarded.options.headers.has('accept-encoding'), false);
    assert.equal(Buffer.from(forwarded.options.body).toString('utf8'), '{"length":"brief"}');
    assert.equal(result.status, 200);
  });
});

test('Netlify API proxy maps a direct /api path without doubling the prefix', async () => {
  const requested = [];
  await withStubs({
    backendUrl: 'https://learnsphere-api.example.test',
    fetchImpl: async (url) => {
      requested.push(String(url));
      return okResponse();
    },
  }, async () => {
    await handler(invoke('/api/materials/search?q=index'));
    await handler(invoke('/.netlify/functions/api/api/materials/search?q=index'));
  });
  assert.deepEqual(requested, [
    'https://learnsphere-api.example.test/api/materials/search?q=index',
    'https://learnsphere-api.example.test/api/materials/search?q=index',
  ]);
});

test('Netlify API proxy keeps a base path configured in the backend URL', async () => {
  let requested;
  await withStubs({
    backendUrl: 'https://learnsphere-api.example.test/learnsphere/',
    fetchImpl: async (url) => {
      requested = String(url);
      return okResponse();
    },
  }, async () => {
    await handler(invoke('/.netlify/functions/api/materials'));
  });
  assert.equal(requested, 'https://learnsphere-api.example.test/learnsphere/api/materials');
});

test('Netlify API proxy reports a slow upstream as a retryable timeout', async () => {
  await withStubs({
    backendUrl: 'https://learnsphere-api.example.test',
    fetchImpl: async () => {
      const error = new Error('upstream took too long');
      error.name = 'TimeoutError';
      throw error;
    },
  }, async () => {
    const result = await handler(invoke('/.netlify/functions/api/health'));
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('retry-after'), '2');
    const body = await result.json();
    assert.equal(body.error.code, 'backend_timeout');
    assert.equal(body.error.retryable, true);
  });
});

test('Netlify API proxy reports an unreachable upstream as a retryable failure', async () => {
  await withStubs({
    backendUrl: 'https://learnsphere-api.example.test',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  }, async () => {
    const result = await handler(invoke('/.netlify/functions/api/health'));
    assert.equal(result.status, 502);
    const body = await result.json();
    assert.equal(body.error.code, 'backend_unavailable');
    assert.equal(body.error.retryable, true);
  });
});

test('Netlify API proxy passes an upstream error status and body through unchanged', async () => {
  await withStubs({
    backendUrl: 'https://learnsphere-api.example.test',
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'No such material.' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
  }, async () => {
    const result = await handler(invoke('/.netlify/functions/api/materials/missing'));
    assert.equal(result.status, 404);
    assert.equal((await result.json()).error.code, 'not_found');
  });
});

test('Netlify API proxy returns an empty body for 204 without stale entity headers', async () => {
  await withStubs({
    backendUrl: 'https://learnsphere-api.example.test',
    fetchImpl: async () =>
      new Response(null, {
        status: 204,
        headers: { 'content-length': '0', 'content-encoding': 'gzip', 'cache-control': 'no-store' },
      }),
  }, async () => {
    const result = await handler(invoke('/.netlify/functions/api/materials/x', { method: 'DELETE' }));
    assert.equal(result.status, 204);
    assert.equal(result.headers.get('content-length'), null);
    assert.equal(result.headers.get('content-encoding'), null);
    assert.equal(await result.text(), '');
  });
});

test('Netlify API proxy answers HEAD with headers only and keeps the declared length', async () => {
  await withStubs({
    backendUrl: 'https://learnsphere-api.example.test',
    fetchImpl: async () => new Response(null, { status: 200, headers: { 'content-length': '42' } }),
  }, async () => {
    const result = await handler(invoke('/.netlify/functions/api/health', { method: 'HEAD' }));
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-length'), '42');
    assert.equal(await result.text(), '');
  });
});

test('Netlify API proxy keeps every Set-Cookie value separate', async () => {
  await withStubs({
    backendUrl: 'https://learnsphere-api.example.test',
    fetchImpl: async () => {
      const headers = new Headers();
      headers.append('set-cookie', 'a=1; Path=/');
      headers.append('set-cookie', 'b=2; Path=/');
      return new Response('{}', { status: 200, headers });
    },
  }, async () => {
    const result = await handler(invoke('/.netlify/functions/api/health'));
    assert.deepEqual(result.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
  });
});

test('netlify.toml routes /api before the SPA fallback and publishes the built site', () => {
  const toml = fs.readFileSync(new URL('../../netlify.toml', import.meta.url), 'utf8');
  const rules = [...toml.matchAll(/\[\[redirects\]\]([\s\S]*?)(?=\n\[|$)/g)].map((match) => match[1]);

  assert.equal(rules.length, 2, 'expected exactly the API rule and the SPA fallback');
  assert.match(rules[0], /from = "\/api\/\*"/);
  assert.match(rules[0], /to = "\/\.netlify\/functions\/api\/:splat"/);
  assert.match(rules[0], /status = 200/);
  // Without force, an existing static file could satisfy /api/* and the
  // function would never run; with it, the API rule always wins over the SPA
  // fallback below, so there is no path back into index.html.
  assert.match(rules[0], /force = true/);
  assert.match(rules[1], /from = "\/\*"/);
  assert.match(rules[1], /to = "\/index\.html"/);

  assert.match(toml, /publish = "web\/dist"/);
  assert.match(toml, /directory = "netlify\/functions"/);
});

test('Netlify API proxy does not leak the backend host in its own error replies', async () => {
  await withStubs({
    backendUrl: 'https://internal-api.example.test',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  }, async () => {
    const result = await handler(invoke('/.netlify/functions/api/health'));
    assert.equal((await result.text()).includes('internal-api.example.test'), false);
  });
});
