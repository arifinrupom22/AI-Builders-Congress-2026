/**
 * Per-request context: request id, learner scoping, and rate limiting.
 *
 * The learner id is asserted by the client (X-Learner-Id). That is a
 * data-scoping mechanism for a single-user local deployment, not authentication.
 * It is sanitised to a strict character set and length so it can never be used
 * as a path or a key injection vector, and every store query filters on it.
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
export function rateLimit({ windowMs = 60_000, max = 120, keyFn = (req) => `${req.learnerId}:${req.ip}` } = {}) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, entry] of hits) if (entry.start < cutoff) hits.delete(key);
  }, windowMs * 2);
  sweep.unref?.();

  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now - entry.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(max - 1));
      return next();
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));

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
