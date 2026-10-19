import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, bytes } from '../api';
import { Icon } from '../components/icons';
import { Spinner } from '../components/ui';
import { t, useLang } from '../i18n';
import { navigate } from '../router';
import type { Target } from '../target-types';
import { jobsBusy, startBackend } from './backend';
import { Lock } from './Lock';
import { installLogging } from './log';
import { native, type AppStatus } from './native';
import { Onboarding } from './Onboarding';
import { DesktopSettings } from './Settings';

/**
 * The desktop build: the service runs in this page (packages/backend, over
 * SQLCipher and the engine through Rust), behind the vault's password.
 */

/** Locking drops the keys in Rust, then reloads so nothing decrypted stays in this page. */
async function lock() {
  await native.vaultLock();
  history.replaceState(null, '', '#/');
  location.reload();
}

const IDLE_LOCK_MS = 30 * 60_000;

/** Auto-lock after 30 minutes without input, unless the key is in the keychain anyway. */
function useIdleLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let timer = setTimeout(lock, IDLE_LOCK_MS);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(lock, IDLE_LOCK_MS);
    };
    const events = ['pointerdown', 'keydown', 'wheel'] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [enabled]);
}

/** The vault's state once unlocked, for Settings. */
let unlocked: AppStatus | null = null;

function Unlocked({ status, children }: { status: AppStatus; children: ReactNode }) {
  useIdleLock(!status.autoUnlock);
  return <>{children}</>;
}

/** new → first launch; locked → keychain, else the password screen; unlocked → the app. */
function Boot({ children }: { children: ReactNode }) {
  useLang();
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      let s = await native.appStatus();
      if (s.vault === 'locked' && s.autoUnlock && (await native.vaultAutoUnlock().catch(() => false))) s = await native.appStatus();
      if (s.vault === 'unlocked') {
        startBackend();
        unlocked = s;
      }
      setStatus(s);
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  if (error)
    return (
      <div className="boot">
        <div className="dv-notice error">
          <Icon name="warningCircle" />
          <span>{error}</span>
        </div>
      </div>
    );
  if (!status)
    return (
      <div className="boot">
        <Spinner />
      </div>
    );
  if (status.vault === 'new')
    return (
      <Onboarding
        onDone={() => {
          navigate('/', true);
          void refresh();
        }}
      />
    );
  if (status.vault === 'locked') return <Lock onUnlocked={() => void refresh()} />;
  return <Unlocked status={status}>{children}</Unlocked>;
}

function TopbarEnd() {
  return (
    <button type="button" className="dv-button icon-only lock-button" onClick={() => void lock()} aria-label={t('lock.lockNow')} title={t('lock.lockNow')}>
      <Icon name="lock" />
    </button>
  );
}

function SettingsSections() {
  return unlocked ? <DesktopSettings status={unlocked} onLock={() => void lock()} /> : null;
}

export const target: Target = {
  kind: 'desktop',
  request: async (path, init) => startBackend().app.request(path, init),
  /** The native save dialog writes the decrypted file where the user picks; then the fakes are frozen. */
  async saveDocument(id) {
    const { blobId, name } = await api.get<{ blobId: string; name: string }>(`/documents/${id}/export`);
    const path = await native.saveBlobAs(blobId, name);
    if (!path) return false;
    await api.post(`/documents/${id}/exported`);
    return true;
  },
  openExternal: (url) => void openUrl(url),
  Boot,
  TopbarEnd,
  SettingsSections,
  projectTabs: [],
  page: () => null,
  dragRegion: true,
  copy: {},
};

installLogging(jobsBusy);

// Dev builds: the scripted tests (desktop/e2e) reach the app's modules here.
if (import.meta.env.DEV) {
  // A file from the repo's fixtures/ folder (desktop/src-tauri/src/e2e.rs).
  const fixture = async (name: string) => new Uint8Array(await invoke<ArrayBuffer>('e2e_fixture', { name }));
  Object.assign(window, { __anon: { api, bytes, native, startBackend, navigate, fixture, target: 'desktop' } });
}
