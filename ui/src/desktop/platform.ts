import { Channel, invoke } from '@tauri-apps/api/core';
import type { Blobs, BlobKind, Db, DesktopPlatform, Detector, LocalFetch, Param } from '@anon/backend';
import { DetectorOfflineError, llamaCppClient, type ModelClient } from '@anon/pipeline';
import { log } from './log';
import { native, errorCode, type ModelInfo } from './native';

/**
 * The backend's platform inside the app: SQLCipher and the encrypted blob
 * store through Rust commands, and the helpers through Rust's proxy.
 */

const db: Db = {
  all: <T>(sql: string, params: Param[] = []) => invoke<T[]>('db_all', { sql, params }),
  run: (sql, params = []) => invoke<{ changes: number }>('db_run', { sql, params }),
  batch: async (stmts) => {
    await invoke('db_batch', { stmts: stmts.map((s) => ({ sql: s.sql, params: s.params ?? [] })) });
  },
};

// Rust seals every blob with the vault's key; which document it belongs to doesn't change that.
const getBlob = async (id: string) => new Uint8Array(await invoke<ArrayBuffer>('blob_get', { id }));
const blobs: Blobs = {
  put: (kind: BlobKind, bytes: Uint8Array) => invoke<string>('blob_put', bytes, { headers: { 'x-kind': kind } }),
  get: getBlob,
  open: getBlob,
  delete: (ids: string[]) => invoke<void>('blob_delete', { ids }),
};

type Target = 'engine' | 'llama';

async function bodyOf(init: RequestInit): Promise<{ bytes: Uint8Array; contentType?: string }> {
  if (init.body === undefined || init.body === null) return { bytes: new Uint8Array() };
  // Let Request serialize FormData/strings/blobs, and keep the multipart boundary it picks.
  const req = new Request('http://local/', { method: 'POST', body: init.body, headers: init.headers });
  return { bytes: new Uint8Array(await req.arrayBuffer()), contentType: req.headers.get('content-type') ?? undefined };
}

function headersOf(init: RequestInit, contentType?: string): Record<string, string> {
  const h: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => (h[k] = v));
  if (contentType) h['content-type'] = contentType;
  return h;
}

function sidecarError(err: unknown): never {
  const code = errorCode(err);
  if (code === 'sidecar_down') throw new DetectorOfflineError(code);
  throw new Error(code);
}

/** Buffered request: engine calls (files in, files out). */
function buffered(target: Target): LocalFetch {
  return async (path, init = {}) => {
    const { bytes, contentType } = await bodyOf(init);
    const req = { target, method: init.method ?? 'GET', path, headers: headersOf(init, contentType) };
    const raw = new Uint8Array(await invoke<ArrayBuffer>('local_http', bytes, { headers: { 'x-anon-req': JSON.stringify(req) } }).catch(sidecarError));
    const metaLen = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true);
    const meta = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + metaLen))) as { status: number; headers: Record<string, string> };
    return new Response(raw.subarray(4 + metaLen), { status: meta.status, headers: meta.headers });
  };
}

/** Streamed request: model output (SSE, NDJSON), so timeouts and cut-offs behave like fetch. */
function streamed(target: Target): LocalFetch {
  return async (path, init = {}) => {
    const { bytes, contentType } = await bodyOf(init);
    const req = { target, method: init.method ?? 'POST', path, headers: headersOf(init, contentType) };
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let id: number | undefined;
    let open = true;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => void (controller = c),
      // The reader stopped early (answer complete, or timed out): stop the request too.
      cancel: () => {
        open = false;
        if (id !== undefined) void invoke('local_http_cancel', { id });
      },
    });
    // Rust may still send data or its end marker after the reader is gone.
    const settle = (f: () => void) => {
      if (!open) return;
      try {
        f();
      } catch {
        open = false;
      }
    };
    let resolveMeta!: (m: { status: number; headers: Record<string, string> }) => void;
    let rejectMeta!: (e: unknown) => void;
    const meta = new Promise<{ status: number; headers: Record<string, string> }>((res, rej) => ((resolveMeta = res), (rejectMeta = rej)));
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buf) => {
      const msg = new Uint8Array(buf);
      const payload = msg.subarray(1);
      switch (msg[0]) {
        case 0:
          resolveMeta(JSON.parse(new TextDecoder().decode(payload)));
          break;
        case 1:
          settle(() => controller.enqueue(payload.slice()));
          break;
        case 2:
          settle(() => controller.close());
          open = false;
          break;
        default: {
          const err = new TextDecoder().decode(payload) === 'sidecar_down' ? new DetectorOfflineError('sidecar_down') : new Error(new TextDecoder().decode(payload));
          rejectMeta(err);
          settle(() => controller.error(err));
          open = false;
        }
      }
    };
    id = await invoke<number>('local_http_stream', { req, body: new TextDecoder().decode(bytes), onEvent: channel }).catch(sidecarError);
    if (!open) void invoke('local_http_cancel', { id });
    init.signal?.addEventListener('abort', () => {
      void invoke('local_http_cancel', { id });
      settle(() => controller.error(new DOMException('aborted', 'AbortError')));
      open = false;
    });
    const m = await meta;
    return new Response(body, { status: m.status, headers: m.headers });
  };
}

let catalog: Promise<ModelInfo[]> | null = null;
export function modelCatalog(refresh = false): Promise<ModelInfo[]> {
  if (refresh || !catalog) catalog = native.modelCatalog();
  return catalog;
}

/** Fires after llama-server is up on a model, so parked documents can go. */
export const modelEvents = new EventTarget();

/** Each model call in the log: how long, how many tokens, how fast. */
function timed(m: ModelClient): ModelClient {
  return {
    ...m,
    async structured<T>(system: string, user: string, schema: Record<string, unknown>) {
      const t = performance.now();
      try {
        const r = await m.structured<T>(system, user, schema);
        const s = (performance.now() - t) / 1000;
        log('info', 'model', `${m.name}: ${user.length} chars in, ${r.usage.input_tokens} prompt + ${r.usage.output_tokens} output tokens in ${s.toFixed(1)} s (${(r.usage.output_tokens / s).toFixed(1)} tok/s)`);
        return r;
      } catch (err) {
        log('warn', 'model', `${m.name}: failed after ${((performance.now() - t) / 1000).toFixed(1)} s: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
        throw err;
      }
    },
  };
}

async function model(detector: Detector): Promise<ModelClient | null> {
  // Claude is the web's (on the VPS); the desktop never sends a document anywhere.
  if (detector.engine === 'none' || detector.engine === 'claude' || detector.engine === 'ollama') return null;
  const m = (await modelCatalog()).find((x) => x.id === detector.model);
  if (!m) return null;
  try {
    await native.llamaStart(m.id);
  } catch (err) {
    // Not downloaded yet, or it won't load: the document waits instead of failing.
    throw new DetectorOfflineError(errorCode(err));
  }
  modelEvents.dispatchEvent(new Event('ready'));
  return timed(llamaCppClient({ fetch: streamed('llama'), name: m.name, maxChunkChars: m.chunkChars, contextTokens: m.ctx }));
}

export const tauriPlatform: DesktopPlatform = { db, blobs, engine: buffered('engine'), model, log };
