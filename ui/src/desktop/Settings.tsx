import { openUrl } from '@tauri-apps/plugin-opener';
import { useState } from 'react';
import { api, type DetectionSettings } from '../api';
import { Icon } from '../components/icons';
import { ErrorNotice, Spinner, Toggle, useLoad } from '../components/ui';
import { t } from '../i18n';
import { Profile, Section, SITE_URL, SOURCE_URL } from '../pages/Settings';
import { ModelPicker } from './ModelPicker';
import { setDetector } from './models';
import { native, errorCode, type AppStatus } from './native';
import { PasswordFields, passwordOk } from './Lock';

/** The desktop's settings: the vault, the model on this computer, the data folder. */
export function DesktopSettings({ status, onLock }: { status: AppStatus; onLock: () => void }) {
  return (
    <>
      <Security status={status} onLock={onLock} />
      <Detection />
      <Profile />
      <Data status={status} />
      <About status={status} />
    </>
  );
}

function Security({ status, onLock }: { status: AppStatus; onLock: () => void }) {
  const [old, setOld] = useState('');
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [auto, setAuto] = useState(status.autoUnlock);
  const [autoPw, setAutoPw] = useState('');
  const [askAuto, setAskAuto] = useState<boolean | null>(null);
  return (
    <Section title={t('settings.security')} intro={t('settings.securityIntro')}>
      <div className="setting">
        <div className="setting-label">
          <div>{t('lock.lockNow')}</div>
          <div className="sub">{t('settings.lockHint')}</div>
        </div>
        <button className="dv-button" onClick={onLock}>
          <Icon name="lock" />
          {t('lock.lock')}
        </button>
      </div>
      <div className="setting">
        <div className="setting-label">
          <div>{t('lock.autoUnlock')}</div>
          <div className="sub">{t('lock.autoUnlockHint')}</div>
        </div>
        <Toggle on={auto} onChange={(v) => setAskAuto(v)} label={t('lock.autoUnlock')} />
      </div>
      {askAuto !== null && (
        <form
          className="form-block"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await native.vaultSetAutoUnlock(autoPw, askAuto);
              setAuto(askAuto);
              setAskAuto(null);
              setAutoPw('');
            } catch (err) {
              setError(new Error(errorCode(err) === 'wrong_password' ? t('lock.wrong') : errorCode(err)));
            }
          }}
        >
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="dv-input" type="password" value={autoPw} onChange={(e) => setAutoPw(e.target.value)} placeholder={t('settings.currentPassword')} aria-label={t('settings.currentPassword')} autoFocus style={{ flex: 1 }} />
            <button type="button" className="dv-button ghost" onClick={() => setAskAuto(null)}>
              {t('cancel')}
            </button>
            <button type="submit" className="dv-button primary" disabled={!autoPw}>
              {t('confirm')}
            </button>
          </div>
        </form>
      )}
      <form
        className="form-block"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setMsg(null);
          try {
            await native.vaultChangePassword(old, pw);
            setOld('');
            setPw('');
            setAgain('');
            setMsg(t('settings.passwordChanged'));
          } catch (err) {
            setError(new Error(errorCode(err) === 'wrong_password' ? t('lock.wrong') : errorCode(err)));
          }
        }}
      >
        <div>{t('settings.changePassword')}</div>
        <div className="fields">
          <input className="dv-input" type="password" value={old} onChange={(e) => setOld(e.target.value)} placeholder={t('settings.currentPassword')} aria-label={t('settings.currentPassword')} autoComplete="current-password" />
          <PasswordFields pw={pw} setPw={setPw} again={again} setAgain={setAgain} label={t('settings.newPassword')} />
        </div>
        <div>
          <button className="dv-button" type="submit" disabled={!old || !passwordOk(pw) || pw !== again}>
            <Icon name="key" />
            {t('settings.changePassword')}
          </button>
        </div>
        {msg && (
          <div className="dv-notice ok">
            <Icon name="checkCircle" />
            <span>{msg}</span>
          </div>
        )}
        <ErrorNotice error={error} />
      </form>
    </Section>
  );
}

function Detection() {
  const { data, reload } = useLoad(() => api.get<DetectionSettings>('/settings/detection'), []);
  return (
    <Section title={t('settings.detection')} intro={t('settings.detectionIntro')} plain>
      {!data ? (
        <Spinner />
      ) : (
        <div className="stack">
          {data.waiting > 0 && (
            <div className="dv-notice">
              <Icon name="hourglass" />
              <span>{t('settings.waiting', { n: data.waiting })}</span>
            </div>
          )}
          <ModelPicker
            detector={data.detector}
            onChange={async (d) => {
              await setDetector(d);
              await reload();
            }}
          />
        </div>
      )}
    </Section>
  );
}

function Data({ status }: { status: AppStatus }) {
  const [word, setWord] = useState('');
  const [open, setOpen] = useState(false);
  const target = t('lock.eraseWord');
  return (
    <Section title={t('settings.data')} intro={t('settings.dataIntro')}>
      <div className="setting">
        <code className="grow truncate path">{status.dataDir}</code>
        <button className="dv-button" onClick={() => void native.revealDataDir()}>
          <Icon name="folderOpen" />
          {t('settings.reveal')}
        </button>
      </div>
      <div className="setting">
        <div className="setting-label grow">
          <div>{t('settings.logs')}</div>
          <div className="sub">{t('settings.logsIntro')}</div>
          <code className="truncate path">{status.logDir}</code>
        </div>
        <button className="dv-button" onClick={() => void native.revealLogs()}>
          <Icon name="folderOpen" />
          {t('settings.reveal')}
        </button>
      </div>
      {!open ? (
        <div className="setting">
          <div className="setting-label">
            <div>{t('settings.eraseAll')}</div>
            <div className="sub">{t('settings.eraseWarning')}</div>
          </div>
          <button className="dv-button danger" onClick={() => setOpen(true)}>
            <Icon name="trash" />
            {t('settings.erase')}
          </button>
        </div>
      ) : (
        <form
          className="form-block"
          onSubmit={async (e) => {
            e.preventDefault();
            await native.vaultReset(word.trim());
            location.reload();
          }}
        >
          <div className="dv-notice error">
            <Icon name="warningCircle" />
            <span>{t('settings.eraseWarning')}</span>
          </div>
          <label className="dv-field">
            {t('lock.typeToErase', { word: target })}
            <input className="dv-input" value={word} onChange={(e) => setWord(e.target.value)} autoFocus autoComplete="off" spellCheck={false} style={{ maxWidth: 320 }} />
          </label>
          <div className="row">
            <button type="button" className="dv-button ghost" onClick={() => setOpen(false)}>
              {t('cancel')}
            </button>
            <button type="submit" className="dv-button danger solid" disabled={word.trim() !== target}>
              {t('lock.erase')}
            </button>
          </div>
        </form>
      )}
    </Section>
  );
}

function About({ status }: { status: AppStatus }) {
  return (
    <Section title={t('settings.about')}>
      <div className="setting">
        <div className="setting-label">
          <div>{t('settings.version', { v: status.version })}</div>
          <div className="sub">{t('settings.license')}</div>
        </div>
        <button className="dv-button ghost small" onClick={() => void openUrl(`${SOURCE_URL}/releases/tag/v${status.version}`)}>
          {t('settings.source')}
          <Icon name="arrowUpRight" />
        </button>
        <button className="dv-button ghost small" onClick={() => void native.openNotices().catch(() => {})}>
          {t('settings.notices')}
        </button>
        <button className="dv-button ghost small" onClick={() => void openUrl(SITE_URL)}>
          devance.ca
          <Icon name="arrowUpRight" />
        </button>
      </div>
    </Section>
  );
}
