import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../../netlify/functions/api.mjs';

const DEFAULT_BACKEND_ORIGIN = 'https://ai-builders-congress-2026.onrender.com';

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

test('Netlify API proxy falls back to the deployed backend when no override is set', async () => {
  await withStubs({ fetchImpl: async (url) => {
    assert.equal(new URL(String(url)).origin, DEFAULT_BACKEND_ORIGIN);
    return okResponse();
  } }, async () => {
    const result = await handler({ path: '/.netlify/functions/api/health', httpMethod: 'GET' });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(Buffer.from(result.body, 'base64').toString('utf8')), { status: 'ok' });
  });
});

test('Netlify API proxy rejects a malformed backend URL instead of guessing', async () => {
  await withStubs({ backendUrl: 'ftp://not-http.example', fetchImpl: async () => assert.fail('fetch must not run') }, async () => {
    const result = await handler({ path: '/.netlify/functions/api/health', httpMethod: 'GET' });
    assert.equal(result.statusCode, 503);
    const body = JSON.parse(result.body);
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
    const result = await handler({
      path: '/.netlify/functions/api/summary',
      rawQuery: 'length=brief',
      httpMethod: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-learner-id': 'learner-1',
        origin: 'https://learnsphere.netlify.app',
        host: 'learnsphere.netlify.app',
        'accept-encoding': 'gzip, br',
      },
      body: '{"length":"brief"}',
    });

    assert.equal(forwarded.url, 'https://learnsphere-api.example.test/api/summary?length=brief');
    assert.equal(forwarded.options.method, 'POST');
    assert.equal(forwarded.options.headers.get('x-learner-id'), 'learner-1');
    assert.equal(forwarded.options.headers.has('origin'), false);
    assert.equal(forwarded.options.headers.has('host'), false);
    // The proxy must negotiate its own encoding so it can decode the body.
    assert.equal(forwarded.options.headers.has('accept-encoding'), false);
    assert.equal(forwarded.options.body, '{"length":"brief"}');
    assert.equal(result.statusCode, 200);
  });
});

test('Netlify API proxy maps a direct /api path and keeps the query string', async () => {
  let requested;
  await withStubs({
    backendUrl: 'https://learnsphere-api.example.test',
    fetchImpl: async (url) => {
      requested = String(url);
      return okResponse();
    },
  }, async () => {
    await handler({ path: '/api/materials/search', rawQuery: 'q=index', httpMethod: 'GET' });
  });
  assert.equal(requested, 'https://learnsphere-api.example.test/api/materials/search?q=index');
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
    const result = await handler({ path: '/.netlify/functions/api/health', httpMethod: 'GET' });
    assert.equal(result.statusCode, 503);
    assert.equal(result.headers['retry-after'], '2');
    const body = JSON.parse(result.body);
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
    const result = await handler({ path: '/.netlify/functions/api/health', httpMethod: 'GET' });
    assert.equal(result.statusCode, 502);
    const body = JSON.parse(result.body);
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
    const result = await handler({ path: '/.netlify/functions/api/materials/missing', httpMethod: 'GET' });
    assert.equal(result.statusCode, 404);
    assert.equal(JSON.parse(Buffer.from(result.body, 'base64').toString('utf8')).error.code, 'not_found');
  });
});
