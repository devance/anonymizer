import { useSyncExternalStore } from 'react';
import { api, type DetectionSettings, type Detector } from '../api';
import { startBackend } from './backend';
import { native, errorCode, type DownloadProgress, type ModelInfo } from './native';
import { modelCatalog } from './platform';


/**
 * Model downloads outlive the screen that started them: progress lives here,
 * and parked documents resume when one finishes.
 */

export interface DownloadState {
  progress: DownloadProgress | null;
  error: string | null;
  running: boolean;
}

const downloads = new Map<string, DownloadState>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  listeners.forEach((l) => l());
}

export function useDownloads(): ReadonlyMap<string, DownloadState> {
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => version,
  );
  return downloads;
}

export async function startDownload(id: string): Promise<void> {
  if (downloads.get(id)?.running) return;
  downloads.set(id, { progress: null, error: null, running: true });
  emit();
  try {
    await native.modelDownload(id, (p) => {
      downloads.set(id, { progress: p, error: null, running: p.phase !== 'done' });
      emit();
    });
    downloads.set(id, { progress: downloads.get(id)?.progress ?? null, error: null, running: false });
    await modelCatalog(true);
    // Documents that waited for this model can go now.
    await startBackend().jobs.resumeWaiting();
  } catch (err) {
    const code = errorCode(err);
    downloads.set(id, { progress: downloads.get(id)?.progress ?? null, error: code === 'cancelled' ? null : code, running: false });
  }
  emit();
}

export async function cancelDownload(id: string) {
  await native.modelCancel(id);
}

/**
 * The model to suggest for this much memory: the largest whose catalog
 * threshold is met (the RAM tiers in the catalog), else the lightest.
 */
export function suggestModel(models: ModelInfo[], ramGb: number): ModelInfo | null {
  const ok = models.filter((m) => m.available);
  const fit = ok.filter((m) => m.suggestRamGb != null && m.suggestRamGb <= ramGb).sort((a, b) => b.suggestRamGb! - a.suggestRamGb!);
  return fit[0] ?? [...ok].sort((a, b) => a.minRamGb - b.minRamGb)[0] ?? null;
}

export async function setDetector(detector: Detector) {
  await api.put('/settings/detection', detector);
}

export async function getDetection() {
  return api.get<DetectionSettings>('/settings/detection');
}

export { formatBytes } from '../components/ui';
