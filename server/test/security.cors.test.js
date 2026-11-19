/**
 * Transport security: the CORS guard must never reject the app's own assets.
 *
 * This is a regression test for a production-only failure. Vite emits
 * `<script type="module">` and a `crossorigin` stylesheet link, and browsers send
 * an `Origin` header for both. The guard checked every Origin against the
 * cross-origin allowlist (empty in a same-origin production deployment), so the
 * built JS and CSS answered 403 and the SPA loaded unstyled and never mounted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { corsGuard } from '../src/middleware/security.js';

function call(guard, { origin, host, method = 'GET' }) {
  const headers = {};
  const req = { headers: { origin, host }, method };
  let outcome = 'next';
  const res = {
    setHeader(name, value) {
      headers[name] = value;
    },
    sendStatus(code) {
      outcome = code;
      return this;
    },
  };
  guard(req, res, (error) => {
    outcome = error ?? 'next';
  });
  return { outcome, headers };
}

test('cors: a same-origin request is never checked against the allowlist', () => {
  const guard = corsGuard([]);
  const { outcome } = call(guard, { origin: 'http://127.0.0.1:8787', host: '127.0.0.1:8787' });
  assert.equal(outcome, 'next');
});

test('cors: the browser Origin sent with a module script is accepted', () => {
  const guard = corsGuard([]);
  const { outcome, headers } = call(guard, {
    origin: 'https://learnsphere.example',
    host: 'learnsphere.example',
  });
  assert.equal(outcome, 'next');
  // Same-origin needs no CORS grant; sending one would be noise.
  assert.equal(headers['Access-Control-Allow-Origin'], undefined);
});

test('cors: a foreign origin is still refused', () => {
  const guard = corsGuard(['https://allowed.example']);
  const { outcome } = call(guard, { origin: 'https://evil.example', host: 'learnsphere.example' });
  assert.equal(outcome?.status, 403);
  assert.equal(outcome?.code, 'origin_not_allowed');
});

test('cors: an explicitly allowed origin receives the CORS grant', () => {
  const guard = corsGuard(['https://allowed.example']);
  const { outcome, headers } = call(guard, {
    origin: 'https://allowed.example',
    host: 'api.example',
  });
  assert.equal(outcome, 'next');
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://allowed.example');
  assert.equal(headers['Access-Control-Allow-Credentials'], 'true');
});

test('cors: a request without an Origin passes through', () => {
  const guard = corsGuard([]);
  const { outcome } = call(guard, { host: '127.0.0.1:8787' });
  assert.equal(outcome, 'next');
});

test('cors: a preflight from an allowed origin is answered, not forwarded', () => {
  const guard = corsGuard(['https://allowed.example']);
  const { outcome } = call(guard, {
    origin: 'https://allowed.example',
    host: 'api.example',
    method: 'OPTIONS',
  });
  assert.equal(outcome, 204);
});
