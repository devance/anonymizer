import { setLang, t, useLang } from '../i18n';
import { toggleTheme, useTheme } from '../theme';
import { Icon } from './icons';

/** FR | EN, as two pills; the current language is pressed. */
export function LangSwitch({ onPanel }: { onPanel?: boolean }) {
  const lang = useLang();
  return (
    <div className={`dv-segmented lang${onPanel ? ' on-panel' : ''}`} role="group" aria-label={t('language')}>
      {(['fr', 'en'] as const).map((l) => (
        <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)} lang={l} title={l === 'fr' ? 'Français' : 'English'}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

/** Shows the theme you would switch to, like devance.ca. */
export function ThemeSwitch({ onPanel }: { onPanel?: boolean }) {
  const theme = useTheme();
  const label = theme === 'dark' ? t('theme.toLight') : t('theme.toDark');
  return (
    <button type="button" className={`dv-button icon-only theme-switch${onPanel ? ' on-panel' : ''}`} onClick={toggleTheme} aria-label={label} title={label}>
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  );
}
