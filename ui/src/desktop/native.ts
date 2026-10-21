import { Channel, invoke } from '@tauri-apps/api/core';

/**
 * Typed wrappers for the app's Rust commands. Keys never cross this line:
 * the page sends passwords, Rust keeps the master key.
 */

export interface AppStatus {
  vault: 'new' | 'locked' | 'unlocked';
  autoUnlock: boolean;
  version: string;
  dataDir: string;
  logDir: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  tier: 'standard' | 'accurate' | 'best';
  file: string;
  size: number;
  license: string;
  licenseUrl: string;
  /** Below this, warn that it may be slow. */
  minRamGb: number;
  ctx: number;
  chunkChars: number;
  available: boolean;
  /** The model is on disk and can run. */
  installed: boolean;
  /** Its speed-up draft is there too. */
  complete: boolean;
  /** Model and draft. */
  totalSize: number;
  partialBytes: number;
  downloading: boolean;
}

export interface DownloadProgress {
  received: number;
  total: number;
  bytesPerSec: number;
  phase: 'downloading' | 'verifying' | 'done';
}

export interface SystemInfo {
  ramGb: number;
  os: string;
  osVersion: string;
  arch: string;
  cpu: string;
}

export interface SidecarStatus {
  engine: boolean;
  engineError: string | null;
  llama: boolean;
  llamaModel: string | null;
  llamaError: string | null;
}

export const native = {
  appStatus: () => invoke<AppStatus>('app_status'),
  vaultCreate: (password: string, autoUnlock: boolean) => invoke<void>('vault_create', { password, autoUnlock }),
  vaultUnlock: (password: string) => invoke<void>('vault_unlock', { password }),
  vaultAutoUnlock: () => invoke<boolean>('vault_auto_unlock'),
  vaultLock: () => invoke<void>('vault_lock'),
  vaultChangePassword: (old: string, next: string) => invoke<void>('vault_change_password', { old, new: next }),
  vaultSetAutoUnlock: (password: string, enabled: boolean) => invoke<void>('vault_set_auto_unlock', { password, enabled }),
  vaultReset: (confirm: string) => invoke<void>('vault_reset', { confirm }),

  modelCatalog: () => invoke<ModelInfo[]>('model_catalog'),
  modelDownload: (id: string, onProgress: (p: DownloadProgress) => void) => {
    const channel = new Channel<DownloadProgress>();
    channel.onmessage = onProgress;
    return invoke<void>('model_download', { id, onProgress: channel });
  },
  modelCancel: (id: string) => invoke<void>('model_cancel', { id }),
  modelDelete: (id: string) => invoke<void>('model_delete', { id }),
  modelImport: (id: string) => invoke<boolean>('model_import', { id }),
  llamaStart: (id: string, ctx = 0) => invoke<void>('llama_start', { id, ctx }),
  llamaStop: () => invoke<void>('llama_stop'),

  sidecarStatus: () => invoke<SidecarStatus>('sidecar_status'),
  systemInfo: () => invoke<SystemInfo>('system_info'),

  /** Opens the save dialog in Rust and writes the decrypted file there. Null if cancelled. */
  saveBlobAs: (blobId: string, suggestedName: string) => invoke<string | null>('save_blob_as', { blobId, suggestedName }),
  revealDataDir: () => invoke<void>('reveal_data_dir'),
  revealLogs: () => invoke<void>('reveal_logs'),
  openNotices: () => invoke<void>('open_notices'),
};

/** Error codes from Rust come back as plain strings. */
export function errorCode(err: unknown): string {
  return typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
}
