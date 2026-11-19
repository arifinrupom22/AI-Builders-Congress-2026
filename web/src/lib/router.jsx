/**
 * A dependency-free hash router.
 *
 * The app is served both by the Vite dev server and by Express as a static SPA,
 * so a hash route (`#/quiz`) works everywhere without the server needing a
 * catch-all rewrite. Links are ordinary anchors, which keeps real click,
 * middle-click and copy-link behaviour.
 */
import { useCallback, useEffect, useState } from 'react';

export function parseHash(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const withSlash = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  const path = withSlash.replace(/\/+$/, '') || '/';
  return {
    path,
    segments: path.split('/').filter(Boolean),
    params: new URLSearchParams(queryPart),
  };
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

export function navigate(to) {
  const target = `#${to.startsWith('/') ? to : `/${to}`}`;
  if (window.location.hash === target) return;
  window.location.hash = target;
}

export function replace(to) {
  const target = `#${to.startsWith('/') ? to : `/${to}`}`;
  window.history.replaceState(null, '', target);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** Build a href for a route, optionally with query params. */
export function hrefTo(to, params) {
  const query = params ? new URLSearchParams(params).toString() : '';
  return `#${to}${query ? `?${query}` : ''}`;
}

export function Link({ to, children, onNavigate, ...rest }) {
  const handleClick = useCallback(() => {
    onNavigate?.();
  }, [onNavigate]);
  return (
    <a href={hrefTo(to)} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}

export default { useRoute, navigate, replace, hrefTo, Link, parseHash };
