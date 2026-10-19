import { useEffect, useState } from 'react';
import type { Detector } from '../api';
import { startBackend } from './backend';
import { GlassTile } from '../components/Brand';
import { LangSwitch, ThemeSwitch } from '../components/Controls';
import { Icon, type IconName } from '../components/icons';
import { Logo } from '../components/Logo';
import { ModelPicker } from './ModelPicker';
import { ErrorNotice, Spinner } from '../components/ui';
import { t, useLang, type Key } from '../i18n';
import { getDetection, setDetector, useDownloads } from './models';
import { native, errorCode } from './native';
import { modelCatalog } from './platform';
import { PasswordFields, passwordOk } from './Lock';

type Step = 'welcome' | 'local' | 'password' | 'model' | 'ready';
const STEPS: Step[] = ['welcome', 'local', 'password', 'model', 'ready'];

/** First launch: what the app does, the password, the model. Ends unlocked. */
export function Onboarding({ onDone }: { onDone: () => void }) {
  useLang();
  const [step, setStep] = useState<Step>('welcome');
  const at = STEPS.indexOf(step);
  const next = () => setStep(STEPS[at + 1]!);
  return (
    <div className="onb" data-step={step}>
      <div className="dv-backdrop" aria-hidden="true" />
      <div className="dragbar" data-tauri-drag-region />
      <main className="onb-main">
        <div className="onb-body">
          <ol className="dots" aria-label={t('onb.progress')}>
            {STEPS.map((s, i) => (
              <li key={s} className={i === at ? 'current' : i < at ? 'done' : ''} aria-current={i === at ? 'step' : undefined}>
                <span className="dv-sr-only">{t('onb.stepOf', { n: i + 1, total: STEPS.length })}</span>
              </li>
            ))}
          </ol>
          {/* Keyed by step: each one enters with its own rise. */}
          <div className="onb-step" key={step}>
            {step === 'welcome' && <Welcome onNext={next} />}
            {step === 'local' && <Local onNext={next} />}
            {step === 'password' && <Password onNext={next} />}
            {step === 'model' && <Model onNext={next} />}
            {step === 'ready' && <Ready onDone={onDone} />}
          </div>
        </div>
      </main>
      <aside className="dv-panel onb-panel">
        <div className="onb-panel-top" data-tauri-drag-region>
          <span className="onb-brand">
            <Logo className="brand-logo" />
            <span className="sep" />
            <span className="product">{t('brand')}</span>
          </span>
          <span className="grow" data-tauri-drag-region />
          <LangSwitch onPanel />
          <ThemeSwitch onPanel />
        </div>
        <GlassTile />
        <p className="onb-panel-note">
          {t('onb.panelNote')}
          <span>{t('onb.panelSub')}</span>
        </p>
      </aside>
    </div>
  );
}

function Next({ label, onClick, icon = 'arrowRight', type = 'button', disabled, busy }: { label: string; onClick?: () => void; icon?: IconName; type?: 'button' | 'submit'; disabled?: boolean; busy?: boolean }) {
  return (
    <div className="actions">
      <button className="dv-button primary big has-icon" type={type} onClick={onClick} disabled={disabled} autoFocus={type === 'button'}>
        <span>{label}</span>
        <span className="dv-button-icon">{busy ? <Spinner /> : <Icon name={icon} />}</span>
      </button>
    </div>
  );
}

/** One of the three steps, with a specimen of what happens to a name. */
const HOW: Array<{ title: Key; body: Key; specimen: () => React.ReactNode }> = [
  {
    title: 'onb.how1',
    body: 'onb.how1Body',
    specimen: () => (
      <>
        <mark className="dv-mark person span">Tremblay</mark>
        <Icon name="arrowRight" />
        <span className="fake">Gagnon</span>
      </>
    ),
  },
  {
    title: 'onb.how2',
    body: 'onb.how2Body',
    specimen: () => (
      <>
        <span className="fake">Gagnon</span>
        <Icon name="arrowUpRight" />
        <span className="out">{t('onb.ai')}</span>
      </>
    ),
  },
  {
    title: 'onb.how3',
    body: 'onb.how3Body',
    specimen: () => (
      <>
        <span className="fake">Gagnon</span>
        <Icon name="arrowRight" />
        <mark className="dv-mark person span">Tremblay</mark>
      </>
    ),
  },
];

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <>
      <h1>{t('onb.welcomeTitle')}</h1>
      <p className="dv-lead">{t('onb.welcomeLead')}</p>
      <ol className="how dv-shell">
        {HOW.map((h) => (
          <li key={h.title} className="dv-core">
            <span className="specimen" aria-hidden="true">
              {h.specimen()}
            </span>
            <div>
              <strong>{t(h.title)}</strong>
              <p>{t(h.body)}</p>
            </div>
          </li>
        ))}
      </ol>
      <Next label={t('onb.start')} onClick={onNext} />
    </>
  );
}

const FACTS: Array<[IconName, Key]> = [
  ['cloudSlash', 'onb.local1'],
  ['cpu', 'onb.local2'],
  ['lockKey', 'onb.local3'],
  ['code', 'onb.local4'],
];

function Local({ onNext }: { onNext: () => void }) {
  return (
    <>
      <h1>{t('onb.localTitle')}</h1>
      <p className="dv-lead">{t('onb.localLead')}</p>
      <ul className="facts dv-shell">
        <div className="dv-core">
          {FACTS.map(([icon, key]) => (
            <li key={key}>
              <span className="fact-icon">
                <Icon name={icon} />
              </span>
              <span>{t(key)}</span>
            </li>
          ))}
        </div>
      </ul>
      <Next label={t('continue')} onClick={onNext} />
    </>
  );
}

function Password({ onNext }: { onNext: () => void }) {
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [autoUnlock, setAutoUnlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ok = passwordOk(pw) && pw === again && understood;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ok) return;
        setBusy(true);
        setError(null);
        try {
          await native.vaultCreate(pw, autoUnlock);
          startBackend();
          onNext();
        } catch (err) {
          setError(new Error(errorCode(err)));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1>{t('onb.passwordTitle')}</h1>
      <p className="dv-lead">{t('onb.passwordLead')}</p>
      <div className="onb-fields">
        <PasswordFields pw={pw} setPw={setPw} again={again} setAgain={setAgain} autoFocus />
        <div className="dv-notice">
          <Icon name="warning" />
          <span>{t('onb.passwordWarning')}</span>
        </div>
        <label className="check">
          <input className="dv-checkbox" type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
          <span>{t('onb.understood')}</span>
        </label>
        <label className="check">
          <input className="dv-checkbox" type="checkbox" checked={autoUnlock} onChange={(e) => setAutoUnlock(e.target.checked)} />
          <span>
            {t('lock.autoUnlock')}
            {autoUnlock && <span className="sub">{t('lock.autoUnlockHint')}</span>}
          </span>
        </label>
        <ErrorNotice error={error} />
      </div>
      <Next label={t('onb.createVault')} type="submit" icon="lock" disabled={!ok || busy} busy={busy} />
    </form>
  );
}

function Model({ onNext }: { onNext: () => void }) {
  const [detector, setD] = useState<Detector | null>(null);
  useEffect(() => {
    // Fast detection is built in; a deep check is something to add later, by choice.
    void (async () => setD((await getDetection()).detector))();
  }, []);
  return (
    <>
      <h1>{t('onb.modelTitle')}</h1>
      <p className="dv-lead">{t('onb.modelLead')}</p>
      <div className="onb-models">
        {!detector ? (
          <Spinner />
        ) : (
          <ModelPicker
            compact
            detector={detector}
            onChange={async (d) => {
              await setDetector(d);
              setD(d);
            }}
          />
        )}
      </div>
      <Next label={t('continue')} onClick={onNext} disabled={!detector} />
    </>
  );
}

function Ready({ onDone }: { onDone: () => void }) {
  const downloads = useDownloads();
  const [model, setModel] = useState<string | null>(null);
  useEffect(() => {
    // What reads documents now: a model's name, or basic mode.
    void (async () => {
      const [{ detector }, models] = await Promise.all([getDetection(), modelCatalog()]);
      if (detector.engine === 'builtin') setModel(models.find((m) => m.id === detector.model)?.name ?? detector.model);
      else if (detector.engine === 'ollama') setModel(`Ollama, ${detector.model}`);
      else setModel(t('model.fast'));
    })();
  }, []);
  const downloading = [...downloads.values()].some((d) => d.running);
  return (
    <>
      <h1>{t('onb.readyTitle')}</h1>
      <p className="dv-lead">{t('onb.readyLead')}</p>
      <ul className="facts dv-shell">
        <div className="dv-core">
          <li>
            <span className="fact-icon">
              <Icon name="lockKey" />
            </span>
            <span>{t('onb.readyVault')}</span>
          </li>
          <li>
            <span className="fact-icon">
              <Icon name="cpu" />
            </span>
            <span>
              {t('onb.readyModel', { m: model ?? '' })}
              {downloading && <span className="sub">{t('onb.readyDownloading')}</span>}
            </span>
          </li>
        </div>
      </ul>
      <Next label={t('onb.go')} onClick={onDone} />
    </>
  );
}
