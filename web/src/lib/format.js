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
