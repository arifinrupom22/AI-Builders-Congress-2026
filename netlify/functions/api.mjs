/**
 * Netlify Function: same-origin proxy from the published SPA to the Express API.
 *
 * The static site and the Express API are deployed separately (Netlify and
 * Render), so the browser cannot call the API on a relative path by itself.
 * This function gives `/api/*` a same-origin endpoint that forwards to the real
 * backend, which also means the production app needs no CORS grant at all.
 *
 * RUNTIME CONTRACT: this module has a default export, so Netlify runs it as a
 * modern (Functions 2.0) handler. It is invoked with a standard `Request` and
 * MUST return a standard `Response`. It previously returned the older Lambda
 * shape `{ statusCode, headers, body }`, and the production function failed with
 * "NetlifyUserError: Function returned an unsupported value. Accepted types are
 * 'Response' or 'undefined'" - every `/api/*` call answered 502. Keep the return
 * type, not just the payload, covered by tests.
 *
 * Backend selection, in order:
 *   1. `LEARNSPHERE_BACKEND_URL` - the environment variable to set in the
 *      Netlify UI with the *Functions* scope (Project configuration ->
 *      Environment variables). Point it at a fork, a staging API or a different
 *      host and nothing else has to change.
 *   2. `DEFAULT_BACKEND_URL` - this project's deployed API. It is a public
 *      origin, not a credential, so keeping it as the default means the site
 *      still works when the environment variable is missing or was set with the
 *      wrong scope. A proxy that answers 503 because of an unset variable is
 *      indistinguishable, from the browser, from a broken deployment.
 */
const DEFAULT_BACKEND_URL = 'https://ai-builders-congress-2026.onrender.com';

/**
 * Netlify stops a synchronous function at 10 seconds, so the upstream call has
 * to give up first and answer with something the UI can explain. Render's free
 * tier can take ~30s to wake a sleeping instance, which is why the reply is
 * marked retryable: the client retries a few times instead of showing a dead end.
 */
const UPSTREAM_TIMEOUT_MS = 9000;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

/**
 * Headers that must not be copied from the browser to the upstream hop.
 * `host`/`connection`/`transfer-encoding` etc. describe the Netlify hop rather
 * than the request; `content-length` is recomputed by fetch from the body.
 * `accept-encoding` is dropped because the reply's `content-encoding` is
 * dropped too: forwarding the browser's list while handing back already-decoded
 * bytes would make the browser try to decode plain text.
 */
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  // The origin is what CORS checks; the backend must see the proxy as a direct
  // caller, exactly like a server-side request from the same deployment.
  'origin',
]);

/** Headers that describe the upstream hop, not the proxied response. */
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-encoding',
  'set-cookie',
]);

function jsonResponse(status, code, message, { retryable = false, headers = {} } = {}) {
  return new Response(JSON.stringify({ error: { code, message, retryable } }), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...(retryable ? { 'retry-after': '2' } : {}),
      ...headers,
    },
  });
}

/**
 * Map the invoking URL back to the API path the backend serves.
 *
 * The redirect in `netlify.toml` rewrites `/api/x` to
 * `/.netlify/functions/api/x`, but a runtime may expose either the rewritten or
 * the original pathname on `request.url`, so both shapes are accepted. The
 * mapping is idempotent: it never adds a second `/api` prefix.
 */
function apiPathFromPathname(pathname) {
  const functionPrefix = '/.netlify/functions/api';
  let rest = String(pathname || '/');
  if (rest === functionPrefix) rest = '/';
  else if (rest.startsWith(`${functionPrefix}/`)) rest = rest.slice(functionPrefix.length);

  if (rest === '/api') return '/api';
  if (rest.startsWith('/api/')) return rest;
  return `/api${rest.startsWith('/') ? rest : `/${rest}`}`;
}

/** Keep any base path in the configured backend URL, e.g. https://host/learnsphere. */
function upstreamPath(basePath, apiPath) {
  const base = basePath.replace(/\/+$/, '');
  if (!base) return apiPath;
  if (base.endsWith('/api') && apiPath.startsWith('/api/')) return `${base}${apiPath.slice(4)}`;
  return `${base}${apiPath}`;
}

function resolveBackendUrl() {
  const configured = process.env.LEARNSPHERE_BACKEND_URL?.trim();
  return { url: configured || DEFAULT_BACKEND_URL, source: configured ? 'env' : 'default' };
}

function upstreamSignal(request) {
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  // Combine with the browser's abort signal when the runtime provides one, so a
  // visitor who navigates away does not keep the upstream call alive.
  if (typeof AbortSignal.any === 'function' && request.signal) {
    return AbortSignal.any([request.signal, timeout]);
  }
  return timeout;
}

export async function handler(request) {
  const { url: backendUrl, source } = resolveBackendUrl();

  let backend;
  try {
    backend = new URL(backendUrl);
    if (!['http:', 'https:'].includes(backend.protocol)) throw new Error('Unsupported backend protocol');
  } catch {
    console.error('LearnSphere proxy: LEARNSPHERE_BACKEND_URL is not a usable URL');
    return jsonResponse(
      503,
      'invalid_backend_url',
      'LEARNSPHERE_BACKEND_URL must be a valid http or https URL. Fix it in the Netlify environment variables, then redeploy.',
    );
  }

  let requestUrl;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return jsonResponse(400, 'bad_request', 'The request URL could not be read.');
  }

  const path = apiPathFromPathname(requestUrl.pathname);
  const target = new URL(backend.origin);
  target.pathname = upstreamPath(backend.pathname, path);
  target.search = requestUrl.search;

  const method = String(request.method ?? 'GET').toUpperCase();

  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) return;
    headers.set(name, value);
  });

  let body;
  if (!['GET', 'HEAD'].includes(method)) {
    const buffer = await request.arrayBuffer();
    body = buffer.byteLength > 0 ? buffer : undefined;
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: upstreamSignal(request),
    });
  } catch (err) {
    // The backend host is private infrastructure detail, so it goes to the
    // function log rather than into the response the browser receives.
    console.error('LearnSphere proxy: upstream request failed', {
      backend: backend.origin,
      backendSource: source,
      path,
      method,
      reason: err?.name ?? 'unknown',
    });

    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return jsonResponse(
        503,
        'backend_timeout',
        'The LearnSphere API did not answer in time. A sleeping free-tier server takes up to a minute to start, so this request can simply be retried.',
        { retryable: true },
      );
    }
    return jsonResponse(
      502,
      'backend_unavailable',
      'The LearnSphere API could not be reached. Check that the backend service is running, then try again.',
      { retryable: true },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (DROPPED_RESPONSE_HEADERS.has(key)) return;
    responseHeaders.append(key, value);
  });
  // `forEach` merges multiple Set-Cookie values into one broken string; the
  // dedicated accessor keeps them separate.
  for (const cookie of upstream.headers.getSetCookie?.() ?? []) {
    responseHeaders.append('set-cookie', cookie);
  }

  // A Response may only carry an RFC 9110 status code. An upstream that answers
  // 1xx (a protocol switch, which fetch cannot complete) would otherwise throw
  // here and turn one odd upstream reply into a blank 502 for the browser.
  const status = upstream.status < 200 || upstream.status > 599 ? 502 : upstream.status;

  // 204, 205 and 304 must not carry a body, and HEAD returns headers only.
  const bodyless = method === 'HEAD' || status === 204 || status === 205 || status === 304;
  if (bodyless) {
    const declaredLength = upstream.headers.get('content-length');
    if (method === 'HEAD' && declaredLength) responseHeaders.set('content-length', declaredLength);
    return new Response(null, { status, headers: responseHeaders });
  }

  const payload = await upstream.arrayBuffer();
  return new Response(payload, { status, headers: responseHeaders });
}

export default handler;
