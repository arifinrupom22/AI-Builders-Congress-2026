/**
 * Small UI kit. All visual styling lives in styles/index.css; these components
 * only supply structure, semantics and the right ARIA attributes.
 */
import { useId } from 'react';
import { Icon } from './Icons.jsx';

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  disabled = false,
  type = 'button',
  className = '',
  ...rest
}) {
  return (
    <button
      type={type}
      className={`ls-btn ls-btn--${variant} ls-btn--${size} ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : icon ? <Icon name={icon} size={size === 'sm' ? 15 : 17} /> : null}
      {children ? <span>{children}</span> : null}
      {iconRight && !loading ? <Icon name={iconRight} size={size === 'sm' ? 15 : 17} /> : null}
    </button>
  );
}

export function Spinner({ size = 18, label }) {
  return (
    <span className="ls-spinner" style={{ width: size, height: size }} role="status" aria-label={label ?? 'Loading'}>
      <span className="ls-spinner__ring" />
    </span>
  );
}

export function Card({ as: Tag = 'section', title, subtitle, actions, children, className = '', tone = 'default' }) {
  return (
    <Tag className={`ls-card ls-card--${tone} ${className}`.trim()}>
      {(title || actions) && (
        <header className="ls-card__head">
          <div className="ls-card__heading">
            {title ? <h2 className="ls-card__title">{title}</h2> : null}
            {subtitle ? <p className="ls-card__subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="ls-card__actions">{actions}</div> : null}
        </header>
      )}
      <div className="ls-card__body">{children}</div>
    </Tag>
  );
}

export function Badge({ children, tone = 'neutral', icon, title }) {
  return (
    <span className={`ls-badge ls-badge--${tone}`} title={title}>
      {icon ? <Icon name={icon} size={13} /> : null}
      {children}
    </span>
  );
}

export function StatTile({ label, value, hint, icon, tone = 'default' }) {
  return (
    <div className={`stat-tile stat-tile--${tone}`}>
      <div className="stat-tile__head">
        <span className="stat-tile__label">{label}</span>
        {icon ? <Icon name={icon} size={16} className="stat-tile__icon" /> : null}
      </div>
      <div className="stat-tile__value">{value}</div>
      {hint ? <div className="stat-tile__hint">{hint}</div> : null}
    </div>
  );
}

export function Field({ label, hint, error, children, id: providedId }) {
  const generated = useId();
  const id = providedId ?? generated;
  return (
    <div className={`ls-field${error ? ' ls-field--error' : ''}`}>
      {label ? (
        <label className="ls-field__label" htmlFor={id}>
          {label}
        </label>
      ) : null}
      {children({ id, 'aria-describedby': hint || error ? `${id}-msg` : undefined })}
      {error ? (
        <p className="ls-field__error" id={`${id}-msg`}>
          {error}
        </p>
      ) : hint ? (
        <p className="ls-field__hint" id={`${id}-msg`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Alert({ tone = 'info', title, children, icon, actions }) {
  const iconName = icon ?? (tone === 'danger' || tone === 'warning' ? 'alert' : tone === 'success' ? 'check' : 'info');
  return (
    <div className={`ls-alert ls-alert--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={iconName} size={18} className="ls-alert__icon" />
      <div className="ls-alert__body">
        {title ? <p className="ls-alert__title">{title}</p> : null}
        {children ? <div className="ls-alert__content">{children}</div> : null}
        {actions ? <div className="ls-alert__actions">{actions}</div> : null}
      </div>
    </div>
  );
}

export function EmptyState({ icon = 'compass', title, description, action, children }) {
  return (
    <div className="ls-empty">
      <span className="ls-empty__icon">
        <Icon name={icon} size={24} />
      </span>
      <h3 className="ls-empty__title">{title}</h3>
      {description ? <p className="ls-empty__desc">{description}</p> : null}
      {action ? <div className="ls-empty__action">{action}</div> : null}
      {children}
    </div>
  );
}

export function ProgressBar({ value, max = 100, tone = 'accent', label }) {
  const safeMax = max > 0 ? max : 1;
  const pct = Math.max(0, Math.min(100, (Number(value) || 0) / safeMax * 100));
  return (
    <div
      className={`ls-meter ls-meter--${tone}`}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span className="ls-meter__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function SkeletonRows({ rows = 3 }) {
  return (
    <div className="ls-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="ls-skeleton__row" />
      ))}
    </div>
  );
}

/** Standard "this could not load" panel with an optional retry. */
export function ErrorPanel({ error, onRetry, title = 'Something went wrong', hint }) {
  const message = error?.message ?? 'Unknown error.';
  const isOffline = error?.isOffline;
  return (
    <Alert tone={isOffline ? 'warning' : 'danger'} title={title}>
      <p>{message}</p>
      {hint ? <p>{hint}</p> : null}
      {error?.requestId ? <p className="muted-xs">Request id: {error.requestId}</p> : null}
      {error?.fields?.length ? (
        <ul className="ls-list ls-list--compact">
          {error.fields.map((field) => (
            <li key={`${field.path}-${field.message}`}>
              <strong>{field.path}</strong>: {field.message}
            </li>
          ))}
        </ul>
      ) : null}
      {onRetry ? (
        <div className="ls-alert__actions">
          <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
    </Alert>
  );
}

export function LoadingPanel({ label = 'Loading…', rows = 3 }) {
  return (
    <div className="ls-loading" aria-live="polite">
      <p className="ls-loading__label">
        <Spinner size={16} /> {label}
      </p>
      <SkeletonRows rows={rows} />
    </div>
  );
}

/** Citation / source card used by the AI Teacher answers. */
export function SourceCard({ citation, onInspect }) {
  return (
    <div className="source-card">
      <div className="source-card__head">
        <span className="source-card__id">{citation.id}</span>
        <span className="source-card__file" title={citation.documentName}>
          {citation.documentName}
        </span>
        <span className="source-card__page">p. {citation.pageNumber}</span>
      </div>
      {citation.heading ? <p className="source-card__heading">{citation.heading}</p> : null}
      <p className="source-card__snippet">{citation.snippet}</p>
      <div className="source-card__foot">
        {typeof citation.relevance === 'number' ? (
          <span className="source-card__score">relevance {citation.relevance.toFixed(2)}</span>
        ) : null}
        {onInspect ? (
          <Button variant="ghost" size="sm" icon="external" onClick={() => onInspect(citation)}>
            Open passage
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export default {
  Button,
  Spinner,
  Card,
  Badge,
  StatTile,
  Field,
  Alert,
  EmptyState,
  ProgressBar,
  SkeletonRows,
  ErrorPanel,
  LoadingPanel,
  SourceCard,
};
