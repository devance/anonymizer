import { useState } from 'react';
import { AppMark } from '../components/Brand';
import { LangSwitch, ThemeSwitch } from '../components/Controls';
import { Icon } from '../components/icons';
import { ErrorNotice, Spinner } from '../components/ui';
import { t, useLang } from '../i18n';
import { native, errorCode } from './native';

export const MIN_PASSWORD = 10;

export function passwordOk(pw: string) {
  return [...pw].length >= MIN_PASSWORD;
}

/** Password + confirmation with a length hint; used at onboarding and in Settings. */
export function PasswordFields({ pw, setPw, again, setAgain, label, autoFocus }: { pw: string; setPw: (s: string) => void; again: string; setAgain: (s: string) => void; label?: string; autoFocus?: boolean }) {
  const mismatch = !!again && again !== pw && passwordOk(pw);
  return (
    <div className="pw">
      <input className="dv-input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={label ?? t('lock.password')} aria-label={label ?? t('lock.password')} autoFocus={autoFocus} autoComplete="new-password" />
      <input className="dv-input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} placeholder={t('lock.confirm')} aria-label={t('lock.confirm')} autoComplete="new-password" />
      <div className={`dv-hint${mismatch ? ' bad' : ''}`} aria-live="polite">
        {!passwordOk(pw) ? t('lock.tooShort', { n: MIN_PASSWORD }) : mismatch ? t('lock.mismatch') : ' '}
      </div>
    </div>
  );
}

/** Language and theme, top right of the screens that have no top bar. */
function Corner() {
  return (
    <div className="corner-controls">
      <LangSwitch />
      <ThemeSwitch />
    </div>
  );
}

/** The password screen at launch. Wrong attempts slow down after five. */
export function Lock({ onUnlocked }: { onUnlocked: () => void }) {
  useLang();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fails, setFails] = useState(0);
  const [forgot, setForgot] = useState(false);
  return (
    <div className="lockscreen">
      <div className="dv-backdrop" aria-hidden="true" />
      <div className="dragbar" data-tauri-drag-region />
      <Corner />
      {forgot ? (
        <Reset onBack={() => setForgot(false)} />
      ) : (
        <form
          className="dv-shell lock-card"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            if (fails >= 5) await new Promise((r) => setTimeout(r, Math.min(30, 2 ** (fails - 4)) * 1000));
            try {
              await native.vaultUnlock(pw);
              onUnlocked();
            } catch (err) {
              setFails((n) => n + 1);
              setError(errorCode(err) === 'wrong_password' ? t('lock.wrong') : errorCode(err));
              setPw('');
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="dv-core">
            <AppMark />
            <h1>{t('lock.title')}</h1>
            <p className="dv-lead">{t('lock.lead')}</p>
            <input className="dv-input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={t('lock.password')} aria-label={t('lock.password')} autoFocus autoComplete="current-password" />
            {error && (
              <div className="dv-notice error" role="alert">
                <Icon name="warningCircle" />
                <span>{error}</span>
              </div>
            )}
            <button className="dv-button primary big has-icon" type="submit" disabled={!pw || busy}>
              <span>{t('lock.unlock')}</span>
              <span className="dv-button-icon">{busy ? <Spinner /> : <Icon name="arrowRight" />}</span>
            </button>
            <button type="button" className="dv-button ghost small forgot" onClick={() => setForgot(true)}>
              {t('lock.forgot')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Forgotten password: nothing can be recovered, so the only way on is to erase. */
function Reset({ onBack }: { onBack: () => void }) {
  const [word, setWord] = useState('');
  const [error, setError] = useState<unknown>(null);
  const target = t('lock.eraseWord');
  return (
    <form
      className="dv-shell lock-card reset"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await native.vaultReset(word.trim());
          location.reload();
        } catch (err) {
          setError(new Error(errorCode(err)));
        }
      }}
    >
      <div className="dv-core">
        <span className="state-icon">
          <Icon name="key" />
        </span>
        <h1>{t('lock.forgotTitle')}</h1>
        <p className="dv-lead">{t('lock.forgotBody')}</p>
        <label className="dv-field">
          {t('lock.typeToErase', { word: target })}
          <input className="dv-input" value={word} onChange={(e) => setWord(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
        </label>
        <ErrorNotice error={error} />
        <div className="dv-dialog-actions">
          <button type="button" className="dv-button ghost" onClick={onBack}>
            {t('back')}
          </button>
          <button type="submit" className="dv-button danger solid" disabled={word.trim() !== target}>
            {t('lock.erase')}
          </button>
        </div>
      </div>
    </form>
  );
}
