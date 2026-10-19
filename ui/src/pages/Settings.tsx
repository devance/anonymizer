import { useState } from 'react';
import { target } from '@target';
import { api } from '../api';
import { Icon } from '../components/icons';
import { ErrorNotice, Toggle, markKind, typeLabel, typeOptions, useLoad } from '../components/ui';
import { setLang, t, useLang } from '../i18n';
import { toggleTheme, useTheme } from '../theme';

export const SOURCE_URL = 'https://github.com/devance/anonymizer';
export const SITE_URL = 'https://devance.ca';

/** Language and theme, then what this build has (desktop: security, model, data; web: model, CLI, usage), the user's own details among them. */
export function Settings() {
  return (
    <div className="dv-page narrow">
      <header className="home-head">
        <h1>{t('settings.title')}</h1>
      </header>
      <Appearance />
      <target.SettingsSections />
    </div>
  );
}

export function Section({ title, intro, children, plain }: { title: string; intro?: string; children: React.ReactNode; plain?: boolean }) {
  return (
    <section className="settings-section">
      <header>
        <h2>{title}</h2>
        {intro && <p>{intro}</p>}
      </header>
      {plain ? (
        children
      ) : (
        <div className="dv-shell">
          <div className="dv-core rows">{children}</div>
        </div>
      )}
    </section>
  );
}

function Appearance() {
  const lang = useLang();
  const theme = useTheme();
  return (
    <Section title={t('settings.appearance')}>
      <div className="setting">
        <div className="setting-label">{t('language')}</div>
        <div className="dv-segmented" role="group" aria-label={t('language')}>
          {(['fr', 'en'] as const).map((l) => (
            <button key={l} aria-pressed={lang === l} onClick={() => setLang(l)} lang={l}>
              {l === 'fr' ? 'Français' : 'English'}
            </button>
          ))}
        </div>
      </div>
      <div className="setting">
        <div className="setting-label">
          <div>{t('settings.darkTheme')}</div>
          <div className="sub">{t('settings.themeHint')}</div>
        </div>
        <Toggle on={theme === 'dark'} onChange={toggleTheme} label={t('settings.darkTheme')} />
      </div>
    </Section>
  );
}

/** The user's own values, seeded into every project they own. */
export function Profile() {
  const profile = useLoad(() => api.get<{ entries: Array<{ id: string; type: string; text: string }> }>('/profile'), []);
  const [type, setType] = useState('person');
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const entries = profile.data?.entries ?? [];
  return (
    <Section title={t('settings.profileTitle')} intro={t('settings.profileIntro')}>
      {entries.map((e) => (
        <div key={e.id} className="setting">
          <span className="type-tag" style={{ width: 150 }}>
            <i className={`dv-swatch ${markKind(e.type)}`} />
            {typeLabel(e.type)}
          </span>
          <span className="grow real">{e.text}</span>
          <button
            className="dv-button ghost danger small"
            onClick={async () => {
              await api.del(`/profile/${e.id}`);
              await profile.reload();
            }}
          >
            {t('remove')}
          </button>
        </div>
      ))}
      <form
        className="form-block"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await api.post('/profile', { type, text });
            setText('');
            await profile.reload();
          } catch (err) {
            setError(err);
          }
        }}
      >
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <select className="dv-select" value={type} onChange={(e) => setType(e.target.value)} aria-label={t('type')}>
            {typeOptions().map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <input className="dv-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('settings.profilePlaceholder')} style={{ flex: 1 }} aria-label={t('value')} />
          <button className="dv-button" type="submit" disabled={!text.trim()}>
            <Icon name="plus" />
            {t('add')}
          </button>
        </div>
        <ErrorNotice error={error} />
      </form>
    </Section>
  );
}
