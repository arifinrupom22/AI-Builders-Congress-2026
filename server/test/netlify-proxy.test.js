import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../../netlify/functions/api.mjs';

test('Netlify API proxy explains when no backend has been configured', async () => {
  const previous = process.env.LEARNSPHERE_BACKEND_URL;
  delete process.env.LEARNSPHERE_BACKEND_URL;
  try {
    const result = await handler({ path: '/.netlify/functions/api/health', httpMethod: 'GET' });
    assert.equal(result.statusCode, 503);
    assert.equal(JSON.parse(result.body).error.code, 'backend_not_configured');
  } finally {
    if (previous === undefined) delete process.env.LEARNSPHERE_BACKEND_URL;
    else process.env.LEARNSPHERE_BACKEND_URL = previous;
  }
});

test('Netlify API proxy forwards API path, query, learner header and request body', async () => {
  const previousUrl = process.env.LEARNSPHERE_BACKEND_URL;
  const previousFetch = globalThis.fetch;
  process.env.LEARNSPHERE_BACKEND_URL = 'https://learnsphere-api.example.test';
  let forwarded;
  globalThis.fetch = async (url, options) => {
    forwarded = { url: String(url), options };
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await handler({
      path: '/.netlify/functions/api/summary',
      rawQuery: 'length=brief',
      httpMethod: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-learner-id': 'learner-1',
        origin: 'https://learnsphere.netlify.app',
        host: 'learnsphere.netlify.app',
      },
      body: '{"length":"brief"}',
    });

    assert.equal(forwarded.url, 'https://learnsphere-api.example.test/api/summary?length=brief');
    assert.equal(forwarded.options.method, 'POST');
    assert.equal(forwarded.options.headers.get('x-learner-id'), 'learner-1');
    assert.equal(forwarded.options.headers.has('origin'), false);
    assert.equal(forwarded.options.body, '{"length":"brief"}');
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(Buffer.from(result.body, 'base64').toString('utf8')), { status: 'ok' });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.LEARNSPHERE_BACKEND_URL;
    else process.env.LEARNSPHERE_BACKEND_URL = previousUrl;
  }
});
