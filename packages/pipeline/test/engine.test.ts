import { describe, expect, it } from 'vitest';
import { EngineError, engineClient, type EngineLimits } from '../src/engine';

/** Fast limits: probe every 20 ms, 30 ms per probe, gone after 3 misses. */
const limits = (ceilingMs = 5_000): EngineLimits => ({ probeEveryMs: 20, probeTimeoutMs: 30, probeMisses: 3, ceilingMs: () => ceilingMs });

const never = () => new Promise<Response>(() => {});
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const after = <T>(ms: number, v: () => T) => new Promise<T>((r) => setTimeout(() => r(v()), ms));

/** A fetcher where /health and the call each behave as told; counts the probes. */
function engine(opts: { call: (init: RequestInit) => Promise<Response>; health: () => Promise<Response> }) {
  const seen = { probes: 0, aborted: false };
  const fetcher = (path: string, init: RequestInit) => {
    if (path === '/health') {
      seen.probes++;
      return opts.health();
    }
    init.signal?.addEventListener('abort', () => (seen.aborted = true));
    return opts.call(init);
  };
  return { fetcher, seen };
}

describe('engine client: no call waits forever', () => {
  it('waits for a slow engine as long as it answers /health', async () => {
    const e = engine({ call: () => after(300, () => json({ entities: [] })), health: async () => json({ ok: true }) });
    await expect(engineClient(e.fetcher, limits()).ner('Jean Tremblay')).resolves.toEqual([]);
    expect(e.seen.probes).toBeGreaterThan(3);
  });

  it('a busy engine whose /health says a lane is stuck still counts as alive: the engine answers that call itself', async () => {
    const e = engine({ call: () => after(200, () => json({ detail: 'the engine gave up on /ocr: no progress in 360 s' }, 504)), health: async () => json({ ok: false }, 503) });
    const err = await engineClient(e.fetcher, limits()).ocr(new Uint8Array(4), 'application/pdf', false).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).status).toBe(504);
    expect((err as EngineError).message).toBe('document engine /ocr: the engine gave up on /ocr: no progress in 360 s');
  });

  it('gives up on a frozen engine: neither the call nor /health answers', async () => {
    const e = engine({ call: never, health: never });
    const t = Date.now();
    const err = await engineClient(e.fetcher, limits()).extract(new Uint8Array(4), 'application/pdf').catch((x: unknown) => x);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).status).toBe(504);
    expect((err as EngineError).message).toMatch(/^document engine \/extract: the engine stopped answering/);
    expect(Date.now() - t).toBeLessThan(1_000);
    expect(e.seen.aborted).toBe(true);
  });

  it('gives up on an engine that went away mid-call', async () => {
    let up = true;
    setTimeout(() => (up = false), 60);
    const e = engine({ call: never, health: async () => (up ? json({ ok: true }) : Promise.reject(new TypeError('fetch failed'))) });
    await expect(engineClient(e.fetcher, limits()).check(new Uint8Array(4), 'application/pdf')).rejects.toThrow(/stopped answering/);
  });

  it('gives up at the ceiling even when the engine looks alive', async () => {
    const e = engine({ call: never, health: async () => json({ ok: true }) });
    await expect(engineClient(e.fetcher, limits(150)).inspect(new Uint8Array(4), 'application/pdf')).rejects.toThrow(/no answer after 0 s/);
  });

  it("answers as soon as the engine does, without waiting for a probe that's out", async () => {
    const e = engine({ call: () => after(30, () => json({ entities: [] })), health: never });
    const t = Date.now();
    await engineClient(e.fetcher, { ...limits(), probeEveryMs: 10, probeTimeoutMs: 2_000 }).ner('x');
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('sizes the ceiling for OCR by pages and for the model by characters', async () => {
    const sizes: Array<{ path: string; pages?: number; chars?: number }> = [];
    const l: EngineLimits = { ...limits(), ceilingMs: (path, size) => (sizes.push({ path, ...size }), 5_000) };
    const e = engine({ call: async () => json({ entities: [] }), health: async () => json({ ok: true }) });
    const c = engineClient(e.fetcher, l);
    await c.ner('abc');
    await c.ocr(new Uint8Array(4), 'application/pdf', false, undefined, 12).catch(() => {});
    expect(sizes).toEqual([
      { path: '/ner', chars: 3 },
      { path: '/ocr', pages: 12 },
    ]);
  });
});
