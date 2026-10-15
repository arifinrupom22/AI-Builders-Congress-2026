/**
 * Minimal structured logger with secret redaction.
 *
 * Deliberately does not log document contents, questions, or answers: a study
 * assistant holds coursework that may be private, and logs are the easiest
 * place to leak it by accident. We log counts, ids, durations and errors.
 */

const SECRET_KEYS = /(api[-_]?key|authorization|token|secret|password|cookie|set-cookie)/i;

/** Any string that looks like a provider key gets masked before printing. */
const SECRET_SHAPED = /\b(sk-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]{10,})\b/g;

export function redact(value) {
  if (typeof value === 'string') return value.replace(SECRET_SHAPED, '[REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger({ level = 'info', sink = console } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(lvl, message, meta) {
    if (LEVELS[lvl] < threshold) return;
    const line = {
      t: new Date().toISOString(),
      level: lvl,
      msg: redact(message),
      ...(meta ? redact(meta) : {}),
    };
    const text = JSON.stringify(line);
    if (lvl === 'error') sink.error(text);
    else if (lvl === 'warn') sink.warn(text);
    else sink.log(text);
  }

  return {
    level,
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    child(bindings) {
      const child = createLogger({ level, sink });
      const wrap = (lvl) => (m, meta) => emit(lvl, m, { ...bindings, ...(meta ?? {}) });
      return { ...child, debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
    },
  };
}

export default createLogger;
