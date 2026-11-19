/**
 * Shared frame for the signed-out pages (welcome, sign in, sign up, reset).
 *
 * It carries the brand, the appearance/language controls and a footer. The
 * controls are the same components the signed-in shell uses, so a preference
 * chosen here survives into the app.
 */
import { useApp } from '../store/AppContext.jsx';
import { Icon } from './Icons.jsx';
import { BrandLogo } from './BrandLogo.jsx';
import { LANGUAGES } from '../lib/i18n.js';
import { THEMES } from '../lib/theme.js';

export function PreferencesControls({ className = '' }) {
  const { theme, setTheme, language, setLanguage, t } = useApp();

  return (
    <div className={`prefs ${className}`.trim()}>
      <div className="prefs__group" role="group" aria-label={t('common.theme')}>
        {THEMES.map((id) => (
          <button
            key={id}
            type="button"
            className={`prefs__button${theme === id ? ' is-active' : ''}`}
            aria-pressed={theme === id}
            onClick={() => setTheme(id)}
            title={t(`common.${id}`)}
          >
            <Icon name={id === 'light' ? 'sun' : id === 'dark' ? 'moon' : 'monitor'} size={15} />
            <span>{t(`common.${id}`)}</span>
          </button>
        ))}
      </div>

      <label className="prefs__lang">
        <span className="visually-hidden">{t('common.language')}</span>
        <Icon name="globe" size={15} />
        <select value={language} onChange={(event) => setLanguage(event.target.value)} aria-label={t('common.language')}>
          {LANGUAGES.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.native}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function PublicChrome({ children }) {
  const { t } = useApp();
  return (
    <div className="public">
      <a className="skip-link" href="#public-main">
        {t('shell.skip')}
      </a>
      <header className="public__header">
        <a className="public__brand" href="#/">
          <BrandLogo size={40} />
          <span>
            LearnSphere <strong>AI</strong>
          </span>
        </a>
        <PreferencesControls />
      </header>

      <main className="public__main" id="public-main">
        {children}
      </main>

      <footer className="public__footer">
        <span>{t('shell.footer')}</span>
        <span>{t('welcome.privacy')}</span>
      </footer>
    </div>
  );
}

export default PublicChrome;
