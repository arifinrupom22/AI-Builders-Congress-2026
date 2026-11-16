/** Presentation-only formatting helpers. No logic about the domain lives here. */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'];

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  let index = 0;
  let size = value;
  while (size >= 1024 && index < BYTE_UNITS.length - 1) {
    size /= 1024;
    index += 1;
  }
  const rounded = size >= 10 || index === 0 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${BYTE_UNITS[index]}`;
}

export function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString();
}

export function formatDate(iso, { withTime = true } = {}) {
  if (!iso) return 'unknown date';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown date';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

const DAY_MS = 86_400_000;

export function formatRelative(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / 3_600_000)} h ago`;
  const days = Math.floor(diff / DAY_MS);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 31) return `${Math.floor(days / 7)} wk ago`;
  return formatDate(iso, { withTime: false });
}

/** Integer percentage as a string, or a dash when there is nothing to measure. */
export function formatPercent(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n)}%` : '—';
}

/** "3 of 5" style count, tolerant of missing numbers. */
export function formatCount(part, whole) {
  return `${formatNumber(part)} of ${formatNumber(whole)}`;
}

export function pluralise(count, singular, plural = `${singular}s`) {
  return Number(count) === 1 ? singular : plural;
}

function spellOut(ms, { ceiling = false } = {}) {
  const abs = Math.max(0, ms);
  if (abs < 45_000) return 'a moment';
  if (abs < 90 * 60_000) {
    const n = Math.max(1, Math[ceiling ? 'round' : 'floor'](abs / 60_000));
    return `${n} minute${n === 1 ? '' : 's'}`;
  }
  if (abs < 30 * DAY_MS) {
    const n = Math.max(1, Math[ceiling ? 'round' : 'floor'](abs / 3_600_000));
    return `${n} hour${n === 1 ? '' : 's'}`;
  }
  if (abs < 70 * DAY_MS) {
    const n = Math.max(1, Math[ceiling ? 'round' : 'floor'](abs / DAY_MS));
    return `${n} day${n === 1 ? '' : 's'}`;
  }
  const weeks = Math.max(1, Math.round(abs / (7 * DAY_MS)));
  return `${weeks} week${weeks === 1 ? '' : 's'}`;
}

/** "in 3 days" / "now" / "2 days ago" — a one-directional delta for due dates. */
export function formatDueIn(iso, now = Date.now()) {
  const time = Date.parse(iso ?? '');
  if (Number.isNaN(time)) return 'at an unknown time';
  const diff = time - now;
  if (diff <= 60_000 && diff >= -60_000) return 'now';
  if (diff > 0) return `in ${spellOut(diff, { ceiling: true })}`;
  return `${spellOut(-diff)} ago`;
}

/** A queue chip: "due now", "due in 3 days", "overdue by 2 days", or "new". */
export function formatDue(iso, { now = Date.now(), isNew = false } = {}) {
  if (isNew) return 'new';
  const time = Date.parse(iso ?? '');
  if (Number.isNaN(time)) return 'unscheduled';
  const diff = time - now;
  if (diff <= 60_000 && diff >= -60_000) return 'due now';
  if (diff > 0) return `due in ${spellOut(diff, { ceiling: true })}`;
  return `overdue by ${spellOut(-diff)}`;
}

/** Interval length in plain words: 600000 -> "10 minutes", 3d -> "3 days". */
export function formatInterval(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return 'unscheduled';
  if (value < 3_600_000) {
    const n = Math.max(1, Math.round(value / 60_000));
    return `${n} minute${n === 1 ? '' : 's'}`;
  }
  return spellOut(value, { ceiling: true });
}

/** Title-case a route id such as "not-found" into something readable. */
export function humanise(value) {
  return String(value ?? '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function dayLabel(day) {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function truncate(text, max = 160) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
