import { createBackend, type Backend } from '@anon/backend';
import { api, type DetectionSettings } from '../api';
import { tauriPlatform } from './platform';

/** The local service, in this page: created once, after the vault is unlocked. */
let backend: Backend | null = null;

/** A job running or queued: the heartbeat tells Rust, so a hang mid-job is logged as such. */
export const jobsBusy = () => backend?.jobs.busy ?? false;

export function startBackend(): Backend {
  if (!backend) {
    backend = createBackend(tauriPlatform);
    void backend.recover();
    // The user's own Ollama can come back without the app knowing: retry parked documents now and then.
    setInterval(() => void retryOllama(), 60_000);
  }
  return backend;
}

async function retryOllama() {
  const s = await api.get<DetectionSettings>('/settings/detection').catch(() => null);
  if (s?.detector.engine === 'ollama' && s.waiting > 0) await startBackend().jobs.resumeWaiting();
}
