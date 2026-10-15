/**
 * Netlify Function: same-origin proxy from the published SPA to the Express API.
 *
 * The static site and the Express API are deployed separately (Netlify and
 * Render), so the browser cannot call the API on a relative path by itself.
 * This function gives `/api/*` a same-origin endpoint that forwards to the real
 * backend, which also means the production app needs no CORS grant at all.
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
 * Netlify kills a synchronous function after 10 seconds, so the upstream call
 * has to give up first and answer with something the UI can explain. Render's
 * free tier can take ~30s to wake a sleeping instance, which is why the reply is
 * marked retryable: the client retries a few times instead of showing a dead end.
 */
const UPSTREAM_TIMEOUT_MS = 9000;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function jsonResponse(statusCode, code, message, { retryable = false, headers = {} } = {}) {
  return {
    statusCode,
    headers: {
      ...JSON_HEADERS,
      ...(retryable ? { 'retry-after': '2' } : {}),
      ...headers,
    },
    body: JSON.stringify({ error: { code, message, retryable } }),
  };
}

/** Headers that must not be copied between the browser and the upstream hop. */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-encoding',
  // Forwarding the browser's encoding list while stripping `content-encoding`
  // from the reply would hand the browser compressed bytes it will not decode,
  // so the runtime negotiates and decodes the upstream response itself.
  'accept-encoding',
  // The origin is what CORS checks; the backend must see the proxy as a direct
  // caller, exactly like a server-side request from the same deployment.
  'origin',
]);

function apiPathFromEvent(event) {
  const path = String(event.path ?? '/');
  const functionPrefix = '/.netlify/functions/api';
  const suffix = path.startsWith(functionPrefix) ? path.slice(functionPrefix.length) : path;
  if (suffix === '/api' || suffix.startsWith('/api/')) return suffix;
  return `/api${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

function resolveBackendUrl() {
  const configured = process.env.LEARNSPHERE_BACKEND_URL?.trim();
  return { url: configured || DEFAULT_BACKEND_URL, source: configured ? 'env' : 'default' };
}

export async function handler(event) {
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

  const path = apiPathFromEvent(event);
  const rawQuery = event.rawQuery ?? '';
  const target = new URL(`${backend.origin}${path}`);
  if (rawQuery) target.search = rawQuery;
  else if (event.queryStringParameters) {
    target.search = new URLSearchParams(event.queryStringParameters).toString();
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (value !== undefined && value !== null) headers.set(key, value);
  }

  const method = String(event.httpMethod ?? 'GET').toUpperCase();
  const body =
    ['GET', 'HEAD'].includes(method) || event.body == null
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : event.body;

  let upstream;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
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

  const responseHeaders = {};
  upstream.headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (['connection', 'content-length', 'content-encoding', 'transfer-encoding'].includes(key)) return;
    responseHeaders[key] = value;
  });

  const responseBody =
    method === 'HEAD' || upstream.status === 204 || upstream.status === 304
      ? ''
      : Buffer.from(await upstream.arrayBuffer()).toString('base64');

  return {
    statusCode: upstream.status,
    headers: responseHeaders,
    body: responseBody,
    isBase64Encoded: responseBody !== '',
  };
}

export default handler;
