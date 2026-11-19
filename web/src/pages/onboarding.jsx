/**
 * First-run onboarding.
 *
 * Shown once, after signup or the first sign-in of an account that has not
 * completed it. It writes the learner's preferences to the account profile; the
 * skip button marks onboarding complete without inventing any preferences.
 * Every field is optional and can be edited again in Settings.
 */
import { useState } from 'react';
import { useApp } from '../store/AppContext.jsx';
import { PublicChrome } from '../components/PublicChrome.jsx';
import { Alert, Button, Field } from '../components/ui.jsx';
import { LANGUAGES } from '../lib/i18n.js';
import { navigate } from '../lib/router.jsx';

const LEVELS = [
  ['school', 'onboard.levelSchool'],
  ['college', 'onboard.levelCollege'],
  ['undergraduate', 'onboard.levelUndergrad'],
  ['postgraduate', 'onboard.levelPostgrad'],
  ['self-taught', 'onboard.levelSelf'],
  ['other', 'onboard.levelOther'],
];

function splitSubjects(text) {
  return text
    .split(',')
    .map((subject) => subject.trim())
    .filter(Boolean)
    .slice(0, 12);
}

export default function OnboardingPage() {
  const { auth, t, language, setLanguage, updateProfile, notify } = useApp();
  const profile = auth.user?.profile ?? {};
  const [step, setStep] = useState(1);
  const [level, setLevel] = useState(profile.level ?? '');
  const [subjects, setSubjects] = useState((profile.subjects ?? []).join(', '));
  const [examDate, setExamDate] = useState(profile.examDate ?? '');
  const [minutesPerDay, setMinutesPerDay] = useState(profile.minutesPerDay ?? 30);
  const [daysPerWeek, setDaysPerWeek] = useState(profile.daysPerWeek ?? 5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function finish({ skipped = false } = {}) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await updateProfile({
        language,
        ...(skipped
          ? {}
          : {
              level: level || null,
              subjects: splitSubjects(subjects),
              examDate: examDate || null,
              minutesPerDay: Number(minutesPerDay) || null,
              daysPerWeek: Number(daysPerWeek) || null,
            }),
        completeOnboarding: true,
      });
      if (!skipped) notify(t('onboard.finish'), 'success');
      navigate('/dashboard');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!auth.user) return null;

  return (
    <PublicChrome>
      <div className="onboard">
        <div className="onboard__card">
          <header className="onboard__head">
            <p className="onboard__eyebrow">{t('onboard.step', { n: step })}</p>
            <h1>{step === 1 ? t('onboard.title') : t('onboard.summaryTitle')}</h1>
            <p>{step === 1 ? t('onboard.lead') : t('onboard.summaryLead')}</p>
          </header>

          {error ? (
            <Alert tone="error" title={t('auth.genericError')}>
              <p>{error.message}</p>
            </Alert>
          ) : null}

          {step === 1 ? (
            <div className="onboard__form">
              <fieldset className="onboard__fieldset">
                <legend>{t('onboard.language')}</legend>
                <div className="onboard__choices">
                  {LANGUAGES.map((entry) => (
                    <label key={entry.id} className={`choice${language === entry.id ? ' is-selected' : ''}`}>
                      <input
                        type="radio"
                        name="language"
                        value={entry.id}
                        checked={language === entry.id}
                        onChange={() => setLanguage(entry.id)}
                      />
                      <span>{entry.native}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <Field label={t('onboard.level')} hint={t('onboard.optional')}>
                {({ id, ...aria }) => (
                  <select id={id} className="ls-input" value={level} onChange={(event) => setLevel(event.target.value)} {...aria}>
                    <option value="">{t('onboard.levelNone')}</option>
                    {LEVELS.map(([value, key]) => (
                      <option key={value} value={value}>
                        {t(key)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              <Field label={t('onboard.subjects')} hint={t('onboard.subjectsHint')}>
                {({ id, ...aria }) => (
                  <input
                    id={id}
                    className="ls-input"
                    type="text"
                    value={subjects}
                    onChange={(event) => setSubjects(event.target.value)}
                    placeholder="Databases, Algorithms"
                    {...aria}
                  />
                )}
              </Field>

              <div className="onboard__grid">
                <Field label={t('onboard.examDate')} hint={t('onboard.examDateHint')}>
                  {({ id, ...aria }) => (
                    <input
                      id={id}
                      className="ls-input"
                      type="date"
                      value={examDate}
                      onChange={(event) => setExamDate(event.target.value)}
                      {...aria}
                    />
                  )}
                </Field>
                <Field label={t('onboard.minutes')}>
                  {({ id, ...aria }) => (
                    <input
                      id={id}
                      className="ls-input"
                      type="number"
                      min={5}
                      max={600}
                      step={5}
                      value={minutesPerDay}
                      onChange={(event) => setMinutesPerDay(event.target.value)}
                      {...aria}
                    />
                  )}
                </Field>
                <Field label={t('onboard.days')}>
                  {({ id, ...aria }) => (
                    <input
                      id={id}
                      className="ls-input"
                      type="number"
                      min={1}
                      max={7}
                      value={daysPerWeek}
                      onChange={(event) => setDaysPerWeek(event.target.value)}
                      {...aria}
                    />
                  )}
                </Field>
              </div>
            </div>
          ) : (
            <dl className="onboard__summary">
              <div>
                <dt>{t('onboard.language')}</dt>
                <dd>{LANGUAGES.find((entry) => entry.id === language)?.native ?? language}</dd>
              </div>
              <div>
                <dt>{t('onboard.level')}</dt>
                <dd>{level ? t(LEVELS.find(([value]) => value === level)?.[1] ?? 'onboard.levelNone') : t('onboard.levelNone')}</dd>
              </div>
              <div>
                <dt>{t('onboard.subjects')}</dt>
                <dd>{splitSubjects(subjects).join(', ') || '—'}</dd>
              </div>
              <div>
                <dt>{t('onboard.examDate')}</dt>
                <dd>{examDate || '—'}</dd>
              </div>
              <div>
                <dt>{t('onboard.minutes')}</dt>
                <dd>{minutesPerDay || '—'}</dd>
              </div>
              <div>
                <dt>{t('onboard.days')}</dt>
                <dd>{daysPerWeek || '—'}</dd>
              </div>
            </dl>
          )}

          <div className="onboard__actions">
            {step === 2 ? (
              <Button variant="ghost" icon="chevronLeft" onClick={() => setStep(1)} disabled={busy}>
                {t('onboard.back')}
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => finish({ skipped: true })} disabled={busy}>
                {t('onboard.skip')}
              </Button>
            )}

            {step === 1 ? (
              <Button icon="chevronRight" iconRight="arrowRight" onClick={() => setStep(2)}>
                {t('onboard.next')}
              </Button>
            ) : (
              <Button icon="check" loading={busy} onClick={() => finish()}>
                {busy ? t('onboard.saving') : t('onboard.finish')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </PublicChrome>
  );
}
