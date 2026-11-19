/**
 * Rate limiting must survive a client that invents a new learner id for every
 * request, and must not be resettable by a spoofed forwarding header.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';

test('changing the learner header does not reset the per-IP ceiling', async (t) => {
  // 10/minute per profile means a 40/minute IP ceiling.
  const h = await createHarness({ env: { limits: { rateLimitPerMinute: 10 } } });
  t.after(() => h.close());

  const statuses = [];
  for (let i = 0; i < 45; i += 1) {
    const res = await h.api.get('/api/progress', `rotating-${i}`);
    statuses.push(res.status);
  }

  assert.equal(statuses.slice(0, 12).every((status) => status === 200), true);
  assert.ok(
    statuses.includes(429),
    `expected the IP ceiling to trigger, saw: ${JSON.stringify(statuses)}`,
  );

  // Even the rejected request is shaped like every other API error.
  const limited = await h.api.get('/api/progress', 'another-new-id');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
  assert.ok(limited.body.error.details.retryAfterSeconds >= 1);
});

test('a spoofed X-Forwarded-For does not mint a new rate-limit identity', async (t) => {
  // TRUST_PROXY is off by default, so req.ip is the socket address.
  const h = await createHarness({ env: { limits: { rateLimitPerMinute: 10 } } });
  t.after(() => h.close());

  let sawLimit = false;
  for (let i = 0; i < 45; i += 1) {
    const res = await fetch(`${h.api.baseUrl}/api/progress`, {
      headers: {
        'x-learner-id': `spoof-${i}`,
        'x-forwarded-for': `203.0.113.${i}`,
      },
    });
    if (res.status === 429) sawLimit = true;
    await res.text();
  }
  assert.equal(sawLimit, true, 'a rotating X-Forwarded-For must not defeat the limiter');
});
