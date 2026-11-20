/**
 * Public welcome page.
 *
 * This is what a signed-out visitor sees at `/`. It is a real page with working
 * links: Explore LearnSphere opens the sign-in form, Create account opens the
 * public Create Account form. Nothing private is reachable from here.
 */
import { useApp } from '../store/AppContext.jsx';
import { PublicChrome } from '../components/PublicChrome.jsx';
import { Icon } from '../components/Icons.jsx';

const FEATURES = [
  { icon: 'quote', title: 'welcome.f1t', body: 'welcome.f1b' },
  { icon: 'quiz', title: 'welcome.f2t', body: 'welcome.f2b' },
  { icon: 'calendar', title: 'welcome.f3t', body: 'welcome.f3b' },
  { icon: 'shield', title: 'welcome.f4t', body: 'welcome.f4b' },
];

const STEPS = [
  { n: '01', title: 'welcome.step1', body: 'welcome.step1b' },
  { n: '02', title: 'welcome.step2', body: 'welcome.step2b' },
  { n: '03', title: 'welcome.step3', body: 'welcome.step3b' },
];

export default function WelcomePage() {
  const { t } = useApp();

  return (
    <PublicChrome>
      <section className="hero">
        <div className="hero__copy">
          <p className="hero__eyebrow">{t('welcome.eyebrow')}</p>
          <h1 className="hero__title">{t('welcome.title')}</h1>
          <p className="hero__lead">{t('welcome.lead')}</p>

          <div className="hero__actions">
            <a className="ls-btn ls-btn--primary ls-btn--md" href="#/login">
              {t('welcome.ctaExplore')}
              <Icon name="arrowRight" size={17} />
            </a>
            <a className="ls-btn ls-btn--secondary ls-btn--md" href="#/signup">
              {t('welcome.ctaSignup')}
            </a>
          </div>

          <p className="hero__privacy">
            <Icon name="lock" size={15} />
            {t('welcome.privacy')}
          </p>
        </div>

        <div className="hero__card" aria-hidden="true">
          <div className="hero__card-head">
            <span className="hero__card-dot" />
            <span className="hero__card-dot" />
            <span className="hero__card-dot" />
          </div>
          <div className="hero__q">How does the Calvin cycle use ATP?</div>
          <div className="hero__a">
            <p>
              The Calvin cycle uses ATP and NADPH from the light reactions to fix carbon dioxide into
              glucose.
            </p>
            <span className="hero__cite">
              <Icon name="quote" size={13} /> photosynthesis.pdf · p. 4
            </span>
          </div>
          <div className="hero__chips">
            <span>Grounded answer</span>
            <span>Practice quiz</span>
            <span>Study plan</span>
          </div>
        </div>
      </section>

      <section className="public__section" aria-labelledby="features-title">
        <h2 id="features-title" className="public__section-title">
          {t('welcome.how')}
        </h2>
        <div className="feature-grid">
          {FEATURES.map((feature) => (
            <article className="feature" key={feature.title}>
              <span className="feature__icon">
                <Icon name={feature.icon} size={19} />
              </span>
              <h3>{t(feature.title)}</h3>
              <p>{t(feature.body)}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="public__section" aria-label={t('welcome.how')}>
        <ol className="step-list">
          {STEPS.map((step) => (
            <li key={step.n} className="step-list__item">
              <span className="step-list__n">{step.n}</span>
              <div>
                <h3>{t(step.title)}</h3>
                <p>{t(step.body)}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </PublicChrome>
  );
}
