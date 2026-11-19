/** 404 — an unknown route inside the app. */
import { Icon } from '../components/Icons.jsx';
import { NAV } from '../components/AppShell.jsx';
import { Card } from '../components/ui.jsx';

export default function NotFoundPage({ route }) {
  return (
    <div className="page">
      <Card>
        <div className="ls-empty">
          <span className="ls-empty__icon">
            <Icon name="compass" size={24} />
          </span>
          <h2 className="ls-empty__title">There is nothing at that address</h2>
          <p className="ls-empty__desc">
            <code className="md-code">#{route?.path ?? '/'}</code> is not a screen in LearnSphere AI. Pick one
            from the list below.
          </p>
        </div>

        <ul className="row-list">
          {NAV.map((entry) => (
            <li key={entry.to} className="row-list__item">
              <span className="row-list__icon">
                <Icon name={entry.icon} size={17} />
              </span>
              <div className="row-list__main">
                <a className="row-list__title ls-link" href={`#${entry.to}`}>
                  {entry.title}
                </a>
                <span className="row-list__meta">{entry.blurb}</span>
              </div>
              <Icon name="chevronRight" size={16} />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
