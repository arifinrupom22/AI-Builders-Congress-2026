/**
 * Firebase ID token verification (server side, no SDK).
 *
 * Firebase signs ID tokens with RS256 and publishes the matching X.509
 * certificates at a fixed URL. Verifying them here needs only Node's crypto
 * module, which keeps the server's dependency list unchanged.
 *
 * Everything a caller can influence is checked: the algorithm is pinned to
 * RS256, the signature is verified against Google's certificate selected by
 * `kid`, the issuer must be this project, the audience must be this project id,
 * the token must not be expired (and not issued in the future), and `sub` must
 * be a non-empty Firebase UID. A token that fails any check returns null - the
 * caller must never fall back to a client-supplied identity.
 */

const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const CLOCK_SKEW_SECONDS = 60;

function decodeJsonSegment(segment) {
  const padded = String(segment).replace(/-/g, '+').replace(/_/g, '/');
  const json = Buffer.from(padded, 'base64').toString('utf8');
  return JSON.parse(json);
}

function splitToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) return null;
  return { header, payload, signature, signingInput: `${header}.${payload}` };
}

/**
 * @param {object} options
 * @param {string} options.projectId Firebase project id (`FIREBASE_PROJECT_ID`).
 * @param {Function} [options.fetchImpl] injectable for tests.
 * @param {Function} [options.now] injectable clock (ms since epoch).
 */
export function createFirebaseVerifier({ projectId = '', fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const configured = typeof projectId === 'string' && projectId.trim().length > 0;
  /** @type {{certs: Record<string, string>, expiresAt: number}} */
  let cache = { certs: {}, expiresAt: 0 };
  // One in-flight refresh, so a burst of requests cannot stampede Google.
  let refreshing = null;

  async function loadCertificates() {
    if (cache.expiresAt > now() && Object.keys(cache.certs).length > 0) return cache.certs;
    if (!refreshing) {
      refreshing = (async () => {
        const response = await fetchImpl(CERT_URL, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`certificate fetch failed (${response.status})`);
        const certs = await response.json();
        // Google's cache-control is authoritative; one hour is the conservative
        // fallback when it is missing or unparseable.
        const cacheControl = response.headers?.get?.('cache-control') ?? '';
        const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1] ?? 3600);
        cache = { certs, expiresAt: now() + Math.max(60, maxAge) * 1000 };
        return certs;
      })().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  /**
   * @param {string} token the raw `Authorization: Bearer` value.
   * @returns {Promise<null | {uid:string,email:string|null,emailVerified:boolean,displayName:string|null}>}
   */
  async function verifyIdToken(token) {
    if (!configured) return null;
    const parts = splitToken(token);
    if (!parts) return null;

    let header;
    let claims;
    try {
      header = decodeJsonSegment(parts.header);
      claims = decodeJsonSegment(parts.payload);
    } catch {
      return null;
    }

    if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return null;

    let certs;
    try {
      certs = await loadCertificates();
    } catch {
      return null;
    }
    const certificate = certs?.[header.kid];
    if (typeof certificate !== 'string') return null;

    try {
      const verifier = new (await import('node:crypto')).createVerify('RSA-SHA256');
      verifier.update(parts.signingInput);
      verifier.end();
      if (!verifier.verify(certificate, Buffer.from(parts.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))) {
        return null;
      }
    } catch {
      return null;
    }

    const currentSeconds = Math.floor(now() / 1000);
    if (typeof claims?.exp !== 'number' || claims.exp <= currentSeconds) return null;
    if (typeof claims?.iat !== 'number' || claims.iat > currentSeconds + CLOCK_SKEW_SECONDS) return null;
    if (claims.aud !== projectId) return null;
    if (claims.iss !== `https://securetoken.google.com/${projectId}`) return null;
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) return null;

    return {
      uid: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : null,
      emailVerified: claims.email_verified === true,
      displayName: typeof claims.name === 'string' ? claims.name : null,
    };
  }

  return { configured, verifyIdToken };
}

export default createFirebaseVerifier;
