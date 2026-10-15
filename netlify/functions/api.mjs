const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function jsonResponse(statusCode, code, message) {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: { code, message } }),
  };
}

function apiPathFromEvent(event) {
  const path = String(event.path ?? '/');
  const functionPrefix = '/.netlify/functions/api';
  const suffix = path.startsWith(functionPrefix) ? path.slice(functionPrefix.length) : path;
  if (suffix === '/api' || suffix.startsWith('/api/')) return suffix;
  return `/api${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

export async function handler(event) {
  const configuredBackend = process.env.LEARNSPHERE_BACKEND_URL?.trim();
  if (!configuredBackend) {
    return jsonResponse(
      503,
      'backend_not_configured',
      'This Netlify site has no LearnSphere API configured. Deploy the server and set LEARNSPHERE_BACKEND_URL in the Netlify site environment, then redeploy.',
    );
  }

  let backend;
  try {
    backend = new URL(configuredBackend);
    if (!['http:', 'https:'].includes(backend.protocol)) throw new Error('Unsupported backend protocol');
  } catch {
    return jsonResponse(503, 'invalid_backend_url', 'LEARNSPHERE_BACKEND_URL must be a valid http or https URL.');
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
    if (['host', 'connection', 'content-length', 'content-encoding', 'origin'].includes(key)) continue;
    if (value !== undefined && value !== null) headers.set(key, value);
  }

  const method = String(event.httpMethod ?? 'GET').toUpperCase();
  const body = ['GET', 'HEAD'].includes(method) || event.body == null
    ? undefined
    : event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : event.body;

  try {
    const upstream = await fetch(target, { method, headers, body, redirect: 'manual' });
    const responseHeaders = {};
    upstream.headers.forEach((value, name) => {
      if (!['connection', 'content-length', 'content-encoding', 'transfer-encoding'].includes(name.toLowerCase())) {
        responseHeaders[name] = value;
      }
    });
    const responseBody = method === 'HEAD' || upstream.status === 204 || upstream.status === 304
      ? ''
      : Buffer.from(await upstream.arrayBuffer()).toString('base64');

    return {
      statusCode: upstream.status,
      headers: responseHeaders,
      body: responseBody,
      isBase64Encoded: responseBody !== '',
    };
  } catch {
    return jsonResponse(
      502,
      'backend_unavailable',
      'The LearnSphere API could not be reached. Check that the backend service is running and that LEARNSPHERE_BACKEND_URL is correct.',
    );
  }
}
