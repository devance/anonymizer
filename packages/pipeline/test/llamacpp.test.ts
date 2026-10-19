import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { detectEntities } from '../src/detect';
import { llamaCppClient, llamaCppModel } from '../src/llamacpp';
import { baseUrlFetch, DetectorOfflineError, ModelError, type ModelClient } from '../src/model';

let server: Server | undefined;
afterEach(() => server?.close());

interface Fake {
  url: string;
  bodies: Array<Record<string, unknown>>;
  auth: Array<string | undefined>;
  maxInFlight: () => number;
}

/** A stand-in llama-server: answers each /v1/chat/completions with the given SSE events (or status). */
async function fakeLlama(events: (body: Record<string, unknown>) => string[], status = 200, delayMs = 0): Promise<Fake> {
  const bodies: Array<Record<string, unknown>> = [];
  const auth: Array<string | undefined> = [];
  let inFlight = 0;
  let max = 0;
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    auth.push(req.headers.authorization);
    if (req.url === '/v1/models') return void res.end(JSON.stringify({ object: 'list', data: [{ id: 'gemma-4-E4B-it-Q4_K_M.gguf' }] }));
    const body = JSON.parse(raw) as Record<string, unknown>;
    bodies.push(body);
    if (status !== 200) {
      res.writeHead(status, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: { code: status, message: status === 503 ? 'Loading model' : 'bad request', type: 'x' } }));
    }
    max = Math.max(max, ++inFlight);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const e of events(body)) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      res.write(e);
    }
    inFlight--;
    res.end();
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, bodies, auth, maxInFlight: () => max };
}

const data = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (content: string, finish: string | null = null) => data({ choices: [{ index: 0, delta: { content }, finish_reason: finish }], object: 'chat.completion.chunk' });
const answer = (json: string, finish = 'stop') => [
  data({ choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] }),
  // Split mid-token and mid-line, as TCP may deliver it.
  ...json.match(/.{1,7}/g)!.map((p) => delta(p)),
  delta('', finish),
  data({ choices: [], usage: { prompt_tokens: 812, completion_tokens: 27, total_tokens: 839 } }),
  'data: [DONE]\n\n',
];

const schema = { type: 'object' };
const client = (url: string, extra: Partial<Parameters<typeof llamaCppClient>[0]> = {}) =>
  llamaCppClient({ fetch: baseUrlFetch(url, 'k3y'), name: 'Gemma 4 E4B', maxChunkChars: 8000, ...extra });

describe('llamaCppClient', () => {
  it('streams the answer with usage, and asks for schema-shaped JSON at temperature 0', async () => {
    const s = await fakeLlama(() => answer('{"entities":[{"text":"Côté","type":"person"}]}'));
    const r = await client(s.url).structured('sys', 'doc', schema);
    expect(r).toEqual({ data: { entities: [{ text: 'Côté', type: 'person' }] }, usage: { input_tokens: 812, output_tokens: 27 } });
    expect(s.bodies[0]).toMatchObject({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'doc' },
      ],
      temperature: 0,
      max_tokens: 8192,
      response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } },
      stream: true,
      stream_options: { include_usage: true },
      chat_template_kwargs: { enable_thinking: false },
      cache_prompt: true,
    });
    expect(s.auth[0]).toBe('Bearer k3y');
  });

  it('sends paths to the injected fetch', async () => {
    const s = await fakeLlama(() => answer('{}'));
    const paths: string[] = [];
    const proxy = (path: string, init?: RequestInit) => {
      paths.push(path);
      return fetch(s.url + path, init);
    };
    await llamaCppClient({ fetch: proxy, name: 'g', maxChunkChars: 8000, maxTokens: 100 }).structured('s', 'u', schema);
    expect(paths).toEqual(['/v1/chat/completions']);
    expect(s.bodies[0]).toMatchObject({ max_tokens: 100 });
    expect(await llamaCppModel(proxy)).toBe('gemma-4-E4B-it-Q4_K_M.gguf');
  });

  it('reports a cut-off answer and a mid-stream error as model errors', async () => {
    const cut = await fakeLlama(() => answer('{"entities":[', 'length'));
    await expect(client(cut.url).structured('s', 'u', schema)).rejects.toThrow(/cut off/);
    server!.close();
    const failed = await fakeLlama(() => [delta('{"ent'), 'error: {"code":500,"message":"decode failed","type":"server_error"}\n\n']);
    const err = await client(failed.url).structured('s', 'u', schema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as Error).message).toMatch(/decode failed/);
    server!.close();
    const bad = await fakeLlama(() => [], 400);
    await expect(client(bad.url).structured('s', 'u', schema)).rejects.toBeInstanceOf(ModelError);
  });

  it('turns a server that is down, loading or gone quiet into DetectorOfflineError', async () => {
    const s = await fakeLlama(() => []);
    await new Promise((r) => server!.close(r));
    await expect(client(s.url).structured('s', 'u', schema)).rejects.toBeInstanceOf(DetectorOfflineError);
    expect(await llamaCppModel(baseUrlFetch(s.url))).toBeNull();
    const loading = await fakeLlama(() => [], 503);
    await expect(client(loading.url).structured('s', 'u', schema)).rejects.toBeInstanceOf(DetectorOfflineError);
    server!.close();
    const quiet = await fakeLlama(() => [delta('{'), delta('}')], 200, 300);
    await expect(client(quiet.url, { idleTimeoutMs: 100 }).structured('s', 'u', schema)).rejects.toBeInstanceOf(DetectorOfflineError);
    server!.close();
    const dropped = await fakeLlama(() => [delta('{"entities":[]}')]);
    await expect(client(dropped.url).structured('s', 'u', schema)).rejects.toBeInstanceOf(DetectorOfflineError);
  });

  it('runs a long document one chunk at a time and reports progress', async () => {
    const s = await fakeLlama((body) => {
      const user = (body.messages as Array<{ content: string }>)[1]!.content;
      const name = /Personne (\w+)/.exec(user)?.[1] ?? 'X';
      return answer(JSON.stringify({ entities: [{ text: `Personne ${name}`, type: 'person', group: 'p1' }] }));
    }, 200, 20);
    const text = ['Alpha', 'Beta', 'Gamma'].map((n) => `Personne ${n}. ${'lorem ipsum '.repeat(60)}`).join('\n\n');
    const progress: Array<[number, number]> = [];
    const r = await detectEntities(client(s.url, { maxChunkChars: 800 }), text, [], (d, t) => progress.push([d, t]));
    expect(s.bodies).toHaveLength(3);
    expect(s.maxInFlight()).toBe(1);
    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(r.detections.map((d) => d.text)).toEqual(['Personne Alpha', 'Personne Beta', 'Personne Gamma']);
    expect(r.usage).toEqual({ input_tokens: 3 * 812, output_tokens: 3 * 27 });
  });
});

describe('detectEntities', () => {
  it('sends every chunk at once when the model sets no limit', async () => {
    let inFlight = 0;
    let max = 0;
    const model: ModelClient = {
      name: 'fake',
      local: true,
      maxChunkChars: 800,
      maxAnswerTokens: 8192,
      async structured<T>() {
        max = Math.max(max, ++inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return { data: { entities: [] } as T, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    const text = ['a', 'b', 'c', 'd'].map((n) => `${n} ${'lorem ipsum '.repeat(60)}`).join('\n\n');
    await detectEntities(model, text, []);
    expect(max).toBe(4);
  });

  it('reads a date reported right after "born" as a date of birth', async () => {
    const model: ModelClient = {
      name: 'fake',
      local: true,
      maxChunkChars: 8000,
      maxAnswerTokens: 8192,
      async structured<T>() {
        const entities = [
          { text: 'Apri1 12, 1966', type: 'date', group: 'd1' },
          { text: 'June 3, 2026', type: 'date', group: 'd2' },
        ];
        return { data: { entities } as T, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    const r = await detectEntities(model, 'MARGARET KOWALCZYK, born on Apri1 12, 1966. Signed on June 3, 2026.', []);
    expect(r.detections.map((d) => d.type)).toEqual(['dob', 'date']);
  });

  it('places values the model reformatted or OCR-corrected, but not short ones', async () => {
    const reported = [
      { text: '1842, rue des Érables, Laval, Québec, H7N 2K4', type: 'address', group: 'a1' },
      { text: 'April 12, 1966', type: 'dob', group: 'd1' },
      { text: '0-1-2', type: 'id_number', group: 'i1' },
    ];
    const model: ModelClient = {
      name: 'fake',
      local: true,
      maxChunkChars: 8000,
      maxAnswerTokens: 8192,
      async structured<T>() {
        return { data: { entities: reported } as T, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    const text = 'Adresse : 1842, rue des Érables, Laval (Québec) H7N 2K4\nnée le Apri1 12, 1966, dossier O12';
    const r = await detectEntities(model, text, []);
    expect(r.detections.map((d) => d.text)).toEqual(['1842, rue des Érables, Laval (Québec) H7N 2K4', 'Apri1 12, 1966']);
  });
});
