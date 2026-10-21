import { createBackend, type Backend } from '@anon/backend';
import { tauriPlatform } from './platform';

/** The local service, in this page: created once, after the vault is unlocked. */
let backend: Backend | null = null;

/** A job running or queued: the heartbeat tells Rust, so a hang mid-job is logged as such. */
export const jobsBusy = () => backend?.jobs.busy ?? false;

export function startBackend(): Backend {
  if (!backend) {
    backend = createBackend(tauriPlatform);
    void backend.recover();
  }
  return backend;
}
