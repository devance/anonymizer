import type { ModelClient } from '@anon/pipeline';
import { Hono } from 'hono';
import { createApi } from './app';
import { localCompute } from './compute';
import { DESKTOP_ACCOUNT } from './account';
import { Jobs } from './jobs';
import type { Blobs, Db, Detector, LocalFetch, Log, Scope } from './platform';
import { SqlStore } from './sql-store';

export * from './platform';
export { createApi, type ApiOptions } from './app';
export { localCompute, isTextMime } from './compute';
export { cleanDetector, isCloud, isDetector, parseDetector } from './detector';
export { newId, setFakeRng, upsertCandidates, updateEntity } from './entities';
export { Jobs } from './jobs';
export { countByType, elapsed, errorText } from './log';
export { analyzeSource, deleteDocs, NoProjectsError, refOf, render, resumeWaiting, reviewPayload, runJob, seedProfile, startRestore } from './service';
export { SqlStore } from './sql-store';
export { DESKTOP_ACCOUNT } from './account';

/** What the desktop app provides: its database, blob store, engine and models (ui/src/platform/tauri.ts; Node in tests). */
export interface DesktopPlatform {
  db: Db;
  blobs: Blobs;
  engine: LocalFetch;
  log: Log;
  /** A client for this detector, ready to take requests (the app starts llama-server here). Throws DetectorOfflineError when it can't run now. */
  model(detector: Detector): Promise<ModelClient | null>;
}

/**
 * The desktop's local service. `app.request('/api/…')` answers like the web
 * API; `jobs` runs analyses and renders one at a time.
 */
export function createBackend(p: DesktopPlatform) {
  const store = new SqlStore(p.db);
  let scope: Scope;
  const jobs = new Jobs(() => scope);
  scope = {
    store,
    blobs: p.blobs,
    compute: localCompute({ engine: p.engine, model: p.model, entities: (ids) => store.loadEntities(ids), blobs: p.blobs, log: p.log }),
    queue: jobs,
    progress: jobs,
    account: DESKTOP_ACCOUNT,
    log: p.log,
  };
  const app = new Hono().route('/api', createApi({ scope: () => scope, exposeErrors: true }));
  return { app, jobs, store, scope, recover: () => jobs.recover(store) };
}

export type Backend = ReturnType<typeof createBackend>;
