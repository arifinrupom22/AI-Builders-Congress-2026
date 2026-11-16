/**
 * Per-request context: request id, learner scoping, and rate limiting.
 *
 * Identity comes from middleware/auth.js. This module only sanitises the
 * client-asserted profile id for local mode and provides the limiter.
 *
 * Rate limiting has two independent dimensions:
 *   - `ip`      — a hard ceiling per connection address. It cannot be reset by
 *                 changing a header, which is what makes it a real ceiling.
 *   - `learner` — fairness per study profile / signed-in account. In local mode
 *                 this key is client-supplied, so it smooths traffic but is not
 *                 a security boundary; in account mode the server has already
 *                 verified it.
 *
 * `req.ip` only reflects X-Forwarded-For when TRUST_PROXY is set to a hop count
 * (see config.js). A default deployment therefore cannot be tricked into a new
 * address by sending that header.
 */
import crypto from 'node:crypto';
import AppError from '../errors.js';
import { normaliseLearnerId } from '../storage/store.js';

export function requestContext(logger) {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = typeof incoming === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(incoming) ? incoming : crypto.randomUUID();
    req.learnerId = normaliseLearnerId(req.get('x-learner-id'));
    res.setHeader('X-Request-Id', req.id);
    req.log = logger.child({ requestId: req.id, learnerId: req.learnerId });
    // Deliberately no request logging here: URLs and bodies can contain the
    // student's question text. Duration-only logging happens on response finish.
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
      req.log[level]('request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Math.round(ms),
      });
    });
    next();
  };
}

/**
 * Fixed-window in-memory rate limiter.
 * Single-process only by design; documented as such. A multi-instance
 * deployment must move this to shared storage.
 */
export function rateLimit({ windowMs = 60_000, max = 120, scope = 'learner', name = 'api' } = {}) {
  const hits = new Map();
  // A client can invent unlimited learner ids, so the map is bounded. Oldest
  // entries are dropped first; dropping a counter can only be more permissive,
  // and the per-IP cap in the same route still applies.
  const MAX_KEYS = 10_000;

  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, entry] of hits) if (entry.start < cutoff) hits.delete(key);
  }, windowMs * 2);
  sweep.unref?.();

  function keyFor(req) {
    if (scope === 'ip') return `ip:${req.ip ?? 'unknown'}`;
    if (req.auth?.user?.id) return `user:${req.auth.user.id}`;
    return `learner:${req.learnerId}`;
  }

  return (req, res, next) => {
    const key = keyFor(req);
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now - entry.start >= windowMs) {
      if (hits.size >= MAX_KEYS) {
        let drop = Math.ceil(MAX_KEYS / 10);
        for (const k of hits.keys()) {
          hits.delete(k);
          if (--drop <= 0) break;
        }
      }
      hits.set(key, { start: now, count: 1 });
      res.setHeader(`X-RateLimit-${name}-Limit`, String(max));
      res.setHeader(`X-RateLimit-${name}-Remaining`, String(max - 1));
      return next();
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    res.setHeader(`X-RateLimit-${name}-Limit`, String(max));
    res.setHeader(`X-RateLimit-${name}-Remaining`, String(remaining));

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.start + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return next(
        new AppError(`Too many requests. Try again in ${retryAfter} second(s).`, {
          status: 429,
          code: 'rate_limited',
          details: { retryAfterSeconds: retryAfter },
          expose: true,
        }),
      );
    }
    return next();
  };
}

export default { requestContext, rateLimit };
