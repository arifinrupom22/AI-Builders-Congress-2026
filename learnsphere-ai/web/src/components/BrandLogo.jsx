/**
 * The LearnSphere AI mark.
 *
 * `logo.jpg` is the supplied brand artwork: the sphere-book mark with the
 * wordmark underneath. `logo-mark.png` is that same artwork cropped to the mark
 * only — measured from the file's own pixels, with identical margins on all
 * four sides — so the tile shows a correctly centred icon and the wordmark baked
 * into the original cannot collide with the text label beside it. The original
 * `logo.jpg` is untouched.
 */
export function BrandLogo({ size = 38, className = '' }) {
  return (
    <span
      className={`brand-tile ${className}`.trim()}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.26) }}
    >
      <img className="brand-tile__img" src="/logo-mark.png" alt="LearnSphere AI" width={size} height={size} />
    </span>
  );
}

export default BrandLogo;
