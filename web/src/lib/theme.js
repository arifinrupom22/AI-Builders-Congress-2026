/**
 * Light / Dark / System appearance.
 *
 * The resolved theme is written to `data-theme` on <html>, which is what the
 * stylesheet's token blocks key off. "System" follows the OS setting live and
 * re-resolves when it changes, so the app never disagrees with the desktop.
 */
const STORAGE_KEY = 'learnsphere.theme';
export const THEMES = ['light', 'dark', 'system'];

export function getStoredTheme() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (THEMES.includes(stored)) return stored;
  } catch {
    /* private browsing */
  }
  return 'system';
}

export function systemTheme() {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveTheme(theme) {
  return theme === 'system' ? systemTheme() : theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme) {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;
  return resolved;
}

export function persistTheme(theme) {
  const next = THEMES.includes(theme) ? theme : 'system';
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* the choice simply will not persist */
  }
  applyTheme(next);
  return next;
}

/** Re-apply the resolved theme whenever the OS appearance changes. */
export function watchSystemTheme(getTheme) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (getTheme() === 'system') applyTheme('system');
  };
  media.addEventListener?.('change', onChange);
  return () => media.removeEventListener?.('change', onChange);
}
