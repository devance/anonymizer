import type { EntityType } from '@anon/core';

/**
 * Client for the Python document engine (engine/), a sidecar of the app
 * reached through the Rust proxy.
 */

export const PDF = 'application/pdf';
export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/tiff', 'image/webp']);

export function isEngineMime(mime: string): boolean {
  return mime === PDF || mime === DOCX || IMAGE_MIMES.has(mime);
}

export class EngineError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class PasswordRequiredError extends EngineError {}

export interface Field {
  id: string;
  text: string;
}

export interface Inspection {
  kind: 'pdf' | 'docx' | 'image';
  pages: number | null;
  ocr: 'none' | 'scan' | 'garbled';
  pageKinds: string[];
}

export interface Extraction {
  text: string;
  sha256: string;
  fields: Field[];
  pageKinds?: string[];
}

export interface CheckResult {
  text: string;
  fields: Field[];
  raster: string[];
  codes: Record<string, string[]>;
  metadata?: Record<string, string>;
}

/** A span the engine's detection model found; offsets into the text it was sent. */
export interface NerSpan {
  start: number;
  end: number;
  type: EntityType;
}

type Bytes = Uint8Array<ArrayBuffer>;

export interface Engine {
  inspect(file: Bytes, mime: string, password?: string): Promise<Inspection>;
  /** `pages`: how many the file has, when known (it sizes how long the call may take). */
  ocr(file: Bytes, mime: string, force: boolean, password?: string, pages?: number): Promise<Bytes>;
  extract(file: Bytes, mime: string, password?: string): Promise<Extraction>;
  rewrite(
    file: Bytes,
    mime: string,
    spec: { sha256: string; replacements: Array<{ start: number; end: number; text: string }>; fields: Field[] },
  ): Promise<{ file: Uint8Array<ArrayBuffer>; report: Record<string, unknown> }>;
  check(file: Bytes, mime: string): Promise<CheckResult>;
  /** Names, addresses and identifiers found by the small model bundled with the engine. */
  ner(text: string): Promise<NerSpan[]>;
}

type Fetcher = (path: string, init: RequestInit) => Promise<Response>;

/** How long a call may take, and how the engine's liveness is checked meanwhile. */
export interface EngineLimits {
  /** Ask /health this often while a call is out (ms). */
  probeEveryMs: number;
  /** One probe's own limit (ms). */
  probeTimeoutMs: number;
  /** Probes in a row without any answer before the engine counts as gone. */
  probeMisses: number;
  /** The most one call may take (ms), from its size. */
  ceilingMs: (path: string, size: { pages?: number; chars?: number }) => number;
}

/**
 * The engine bounds every step itself (engine/engine/guard.py: a step that stops
 * making progress answers 504, a hung OCR worker is killed after 300 s without a
 * page) and answers /health within a second, busy or not. So the client waits as
 * long as the engine is alive, and gives up when /health goes unanswered for
 * about a minute (a frozen or vanished engine) or when the call passes its
 * ceiling. Ceilings come from the slowest cases measured on an M1 core, times
 * about ten for the VPS's slower, shared cores and for queueing behind other
 * documents: an upside-down dense scan, 30 s a page; the raster check, 2.5 s a
 * page (60 at most); the detection model, 0.2 s per 1,000 characters.
 */
export const ENGINE_LIMITS: EngineLimits = {
  probeEveryMs: 15_000,
  probeTimeoutMs: 10_000,
  probeMisses: 4,
  ceilingMs(path, { pages, chars }) {
    const min = 60_000;
    switch (path) {
      case '/ner':
        return 2 * min + 2 * Math.ceil((chars ?? 0) / 1000) * 1000;
      case '/ocr':
        return 2 * min + Math.max(1, pages ?? 1) * 5 * min;
      case '/check':
        return 2 * min + 60 * 30_000;
      default:
        // inspect, extract, rewrite: milliseconds a page, a few seconds for a patched scan.
        return 30 * min;
    }
  },
};

/** An Engine over HTTP; `fetcher` is swappable so tests can run without Docker. */
export function engineClient(fetcher: Fetcher, limits: EngineLimits = ENGINE_LIMITS): Engine {
  /**
   * Does the engine answer at all? Any status counts: a 503 from a stuck lane is
   * still an engine that answers. Timed here, not only by the signal: the
   * desktop's fetch goes through Rust and doesn't stop on abort.
   */
  async function alive(): Promise<boolean> {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fetcher('/health', { method: 'GET', signal: ctrl.signal }).then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((r) => (timer = setTimeout(() => (ctrl.abort(), r(false)), limits.probeTimeoutMs))),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * One call, request and reading of the answer, bounded: by the engine's
   * liveness (probed in a bounded loop that stops with the call) and by the
   * call's ceiling. Throws EngineError(504) when it gives up.
   */
  async function call<T>(path: string, init: RequestInit, read: (res: Response) => Promise<T>, size: { pages?: number; chars?: number } = {}): Promise<T> {
    const ceiling = limits.ceilingMs(path, size);
    const ctrl = new AbortController();
    const started = performance.now();
    let settled = false;
    let wake: () => void = () => {};
    let giveUp!: (reason: string) => void;
    const gaveUp = new Promise<never>((_, reject) => {
      giveUp = (reason) => {
        ctrl.abort();
        reject(new EngineError(504, `document engine ${path}: ${reason}`));
      };
    });
    gaveUp.catch(() => {});
    const watch = async () => {
      let misses = 0;
      while (!settled) {
        const left = ceiling - (performance.now() - started);
        if (left <= 0) return giveUp(`no answer after ${Math.round(ceiling / 1000)} s`);
        await new Promise<void>((r) => {
          const timer = setTimeout(r, Math.min(limits.probeEveryMs, left));
          wake = () => (clearTimeout(timer), r());
        });
        if (settled || performance.now() - started >= ceiling) continue;
        misses = (await alive()) ? 0 : misses + 1;
        if (misses >= limits.probeMisses && !settled) return giveUp(`the engine stopped answering (no reply to ${misses} health checks)`);
      }
    };
    // Not awaited at the end: a probe still out would hold up an answer that's already here. It sees `settled` and stops.
    void watch();
    try {
      return await Promise.race([
        (async () => {
          const res = await fetcher(path, { ...init, signal: ctrl.signal });
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { detail?: string; error?: string } | null;
            const msg = body?.detail ?? body?.error ?? `${res.status}`;
            if (res.status === 423) throw new PasswordRequiredError(423, 'This PDF is password-protected');
            throw new EngineError(res.status, `document engine ${path}: ${msg}`);
          }
          return read(res);
        })(),
        gaveUp,
      ]);
    } finally {
      settled = true;
      wake();
    }
  }

  function headers(mime: string, extra: Record<string, string | undefined> = {}): Record<string, string> {
    const h: Record<string, string> = { 'x-mime': mime };
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) h[k] = v;
    return h;
  }

  return {
    async inspect(file, mime, password) {
      return call('/inspect', { method: 'POST', body: file, headers: headers(mime, { 'x-password': password }) }, (r) => r.json());
    },
    async ocr(file, mime, force, password, pages) {
      return call(
        '/ocr',
        { method: 'POST', body: file, headers: headers(mime, { 'x-force': force ? '1' : '0', 'x-password': password }) },
        async (r) => new Uint8Array(await r.arrayBuffer()),
        { pages },
      );
    },
    async extract(file, mime, password) {
      return call('/extract', { method: 'POST', body: file, headers: headers(mime, { 'x-password': password }) }, (r) => r.json());
    },
    async rewrite(file, mime, spec) {
      const form = new FormData();
      form.append('file', new Blob([file], { type: mime }), 'file');
      form.append('spec', JSON.stringify(spec));
      form.append('mime', mime);
      return call('/rewrite', { method: 'POST', body: form }, async (r) => ({ file: new Uint8Array(await r.arrayBuffer()), report: JSON.parse(r.headers.get('x-report') ?? '{}') }));
    },
    async check(file, mime) {
      return call('/check', { method: 'POST', body: file, headers: headers(mime) }, (r) => r.json());
    },
    async ner(text) {
      return call(
        '/ner',
        { method: 'POST', body: new TextEncoder().encode(text), headers: { 'content-type': 'text/plain; charset=utf-8' } },
        async (r) => ((await r.json()) as { entities: NerSpan[] }).entities,
        { chars: text.length },
      );
    },
  };
}

export function httpEngine(baseUrl: string): Engine {
  return engineClient((path, init) => fetch(`${baseUrl}${path}`, init));
}
