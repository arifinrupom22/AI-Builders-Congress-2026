/**
 * One inline SVG sprite component. All icons share a 24x24 grid and inherit
 * `currentColor`, so they follow the theme without extra CSS.
 */
const ICONS = {
  home: <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />,
  library: (
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H9v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
      <path d="M9 4h4.5A1.5 1.5 0 0 1 15 5.5v13A1.5 1.5 0 0 1 13.5 20H9z" />
      <path d="m17 6 3 13" />
    </>
  ),
  teacher: (
    <>
      <path d="M8.5 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
      <path d="M3 20v-1.2A4.8 4.8 0 0 1 7.8 14h1.4" />
      <path d="m16 3 1.3 3.2L20.5 7.5l-3.2 1.3L16 12l-1.3-3.2L11.5 7.5l3.2-1.3z" />
    </>
  ),
  quiz: (
    <>
      <path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1Z" />
      <path d="M16 5h1.5A1.5 1.5 0 0 1 19 6.5v13A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-13A1.5 1.5 0 0 1 6.5 5H8" />
      <path d="m8.5 13 2 2 4-4.5" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20h16" />
      <path d="M7 20v-6M12 20V7M17 20v-9" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.6-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10.3 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4 1.7 1.7 0 0 0-1.6 0Z" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4" />
      <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
      <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-3.8-3.8" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 13 4.5 4.5L19 7" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  alert: (
    <>
      <path d="M12 4.5 3 19.5h18z" />
      <path d="M12 10v4" />
      <path d="M12 17.2h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <path d="M12 8h.01" />
    </>
  ),
  chevronRight: <path d="m9 5 7 7-7 7" />,
  chevronDown: <path d="m5 9 7 7 7-7" />,
  chevronLeft: <path d="m15 5-7 7 7 7" />,
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-14-4.6L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14 4.6l2-1.6" />
      <path d="M20 20v-4h-4" />
    </>
  ),
  sparkles: (
    <>
      <path d="m12 4 1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7z" />
      <path d="m18.5 15 .8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </>
  ),
  file: (
    <>
      <path d="M7 3h7l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v4h4" />
      <path d="M9 13h6M9 17h4" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  send: <path d="M4.5 12 20 4l-4.5 16-4-6.5z" />,
  shield: (
    <>
      <path d="M12 3.5 19 6v6c0 4-3 7-7 8.5-4-1.5-7-4.5-7-8.5V6z" />
      <path d="m9.2 12 2 2 3.6-4" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6.5" rx="7" ry="3" />
      <path d="M5 6.5v11c0 1.7 3.1 3 7 3s7-1.3 7-3v-11" />
      <path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5" />
    </>
  ),
  quote: (
    <>
      <path d="M9 6c-2.5 1.2-4 3.4-4 6.5V18h5v-5H7c0-3 1-4.5 2.8-5.4z" />
      <path d="M19 6c-2.5 1.2-4 3.4-4 6.5V18h5v-5h-3c0-3 1-4.5 2.8-5.4z" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m15.5 8.5-2 5-5 2 2-5z" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  lightbulb: (
    <>
      <path d="M9 17h6" />
      <path d="M10 20h4" />
      <path d="M12 3a6 6 0 0 0-3 11.2V17h6v-2.8A6 6 0 0 0 12 3Z" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  flag: (
    <>
      <path d="M6 21V4" />
      <path d="M6 5h10l-1.5 3.5L16 12H6" />
    </>
  ),
};

export function Icon({ name, size = 20, title, className = '', ...rest }) {
  const glyph = ICONS[name];
  if (!glyph) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`icon ${className}`.trim()}
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {glyph}
    </svg>
  );
}

export const ICON_NAMES = Object.keys(ICONS);

export default Icon;
