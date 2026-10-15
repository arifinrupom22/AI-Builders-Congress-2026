/**
 * Transport-level security middleware.
 *
 * CORS is an explicit allowlist and never a wildcard. In production the SPA is
 * served by this same Express app, so cross-origin access is not needed at all
 * and any other Origin is refused. In development the Vite dev server origin is
 * allowed so the API can be called directly while debugging.
 */
import AppError from '../errors.js';

export function buildAllowedOrigins({ env, port, corsAllowedOrigins = [] }) {
  if (env === 'production') return corsAllowedOrigins;
  const dev = new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);
  return [...dev];
}

export function corsGuard(allowedOrigins) {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) return next(); // same-origin, curl, server-to-server
    if (!allowed.has(origin)) {
      return next(
        new AppError('This origin is not allowed to call the LearnSphere AI API.', {
          status: 403,
          code: 'origin_not_allowed',
          expose: true,
        }),
      );
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Learner-Id, X-Request-Id');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  };
}

/**
 * Response headers. No nonce-based CSP is set for the API; the SPA's headers are
 * applied to the static handler in app.js.
 */
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  // API responses must never be cached by a shared proxy: they can contain a
  // student's own material.
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

export default { corsGuard, securityHeaders, buildAllowedOrigins };
