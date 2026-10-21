import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DetectorOfflineError } from '@anon/pipeline';
import { createBackend, type Blobs, type Db, type Param } from '../src/index';
import { fakeEngineFetch, fakeModel, model } from './fakes';
import type { Harness } from './suite';

/**
 * The desktop's platform in Node: node:sqlite for SQLCipher, a Map for the
 * blob store, and the shared stand-ins for the engine and the model. The real
 * engine and the Rust side have their own tests.
 */
export function nodeDb(): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) raw.exec(readFileSync(new URL(f, dir), 'utf8'));
  const prep = (sql: string, params: Param[] = []) => [raw.prepare(sql), params.map((p) => (typeof p === 'boolean' ? Number(p) : p))] as const;
  return {
    raw,
    async all<T>(sql: string, params?: Param[]) {
      const [st, ps] = prep(sql, params);
      return st.all(...ps) as T[];
    },
    async run(sql, params) {
      const [st, ps] = prep(sql, params);
      return { changes: Number(st.run(...ps).changes) };
    },
    async batch(stmts) {
      raw.exec('BEGIN');
      try {
        for (const s of stmts) {
          const [st, ps] = prep(s.sql, s.params);
          st.run(...ps);
        }
        raw.exec('COMMIT');
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

export function memoryBlobs(): Blobs & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  const get = async (id: string) => {
    const b = store.get(id);
    if (!b) throw new Error('blob missing');
    return new Uint8Array(b);
  };
  return {
    store,
    async put(kind, bytes) {
      const id = kind + crypto.randomUUID().replace(/-/g, '');
      store.set(id, new Uint8Array(bytes));
      return id;
    },
    get,
    open: get,
    async delete(ids) {
      for (const id of ids) store.delete(id);
    },
  };
}

export function testBackend() {
  const db = nodeDb();
  const blobs = memoryBlobs();
  const logs: string[] = [];
  const backend = createBackend({
    db,
    blobs,
    engine: fakeEngineFetch,
    log: (level, source, message) => void logs.push(`${level} [${source}] ${message}`),
    async model(detector) {
      if (detector.engine === 'none') return null;
      if (model.offline) throw new DetectorOfflineError('model not ready');
      return fakeModel();
    },
  });
  async function call(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    }
    return backend.app.request(path, { ...init, headers, body });
  }
  const count = async (sql: string) => (await db.all<{ n: number }>(sql))[0]!.n;
  const harness: Harness = {
    call,
    drain: () => backend.jobs.idle(),
    resumeWaiting: () => backend.jobs.resumeWaiting(),
    detector: { engine: 'builtin', model: 'gemma4-e4b' },
    // The user's own Ollama is no longer offered on the desktop.
    invalidDetectors: [{ engine: 'claude' }, { engine: 'ollama', model: 'gemma4:26b' }, { engine: 'local', model: 'gemma4:26b' }, { engine: 'builtin', model: 'bad name!' }, null],
    validDetector: { engine: 'builtin', model: 'gemma4-e2b' },
    frozenCount: () => count('SELECT COUNT(*) AS n FROM entities WHERE frozen_at IS NOT NULL'),
    blobCount: async () => blobs.store.size,
    hasBlob: async (key) => blobs.store.has(key),
    entityCount: () => count('SELECT COUNT(*) AS n FROM entities'),
    dbContains: async (text) => {
      const tables = (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((t) => t.name);
      for (const t of tables) if (JSON.stringify(await db.all(`SELECT * FROM ${t}`)).includes(text)) return true;
      return false;
    },
    logs,
  };
  return { ...backend, db, blobs, call, logs, harness };
}
