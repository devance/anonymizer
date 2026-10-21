import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { joinNameParts } from '../src/detect';
import { DetectorOfflineError, ModelError } from '../src/model';
import { ollamaClient, ollamaStatus } from '../src/ollama';

let server: Server | undefined;
afterEach(() => server?.close());

/** A stand-in Ollama: answers /api/chat with the given NDJSON lines (or status). */
async function fakeOllama(lines: unknown[], status = 200): Promise<{ url: string; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'gemma4:26b', size: 18e9 }] }));
    if (req.url === '/api/ps') return void res.end(JSON.stringify({ models: [] }));
    bodies.push(JSON.parse(raw));
    res.writeHead(status, { 'content-type': 'application/x-ndjson' });
    for (const l of lines) res.write(JSON.stringify(l) + '\n');
    res.end();
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, bodies };
}

const schema = { type: 'object' };

describe('ollamaClient', () => {
  it('streams the answer and asks for schema-shaped JSON at temperature 0', async () => {
    const o = await fakeOllama([
      { message: { content: '{"entities":' } },
      { message: { content: '[]}' } },
      { done: true, done_reason: 'stop', prompt_eval_count: 900, eval_count: 12 },
    ]);
    const r = await ollamaClient({ url: o.url, model: 'gemma4:26b' }).structured('sys', 'doc', schema);
    expect(r).toEqual({ data: { entities: [] }, usage: { input_tokens: 900, output_tokens: 12 } });
    expect(o.bodies[0]).toMatchObject({ model: 'gemma4:26b', format: schema, think: false, stream: true, options: { temperature: 0 } });
  });

  it('turns a PC that is off into DetectorOfflineError', async () => {
    const o = await fakeOllama([]);
    await new Promise((r) => server!.close(r));
    await expect(ollamaClient({ url: o.url, model: 'gemma4:26b' }).structured('s', 'u', schema)).rejects.toBeInstanceOf(DetectorOfflineError);
  });

  it('reports a missing model and a cut-off answer as model errors, not offline', async () => {
    const missing = await fakeOllama([{ error: 'model not found' }], 404);
    await expect(ollamaClient({ url: missing.url, model: 'nope:1b' }).structured('s', 'u', schema)).rejects.toThrow(/not installed/);
    server!.close();
    const cut = await fakeOllama([{ message: { content: '{"entities":[' } }, { done: true, done_reason: 'length' }]);
    await expect(ollamaClient({ url: cut.url, model: 'gemma4:26b' }).structured('s', 'u', schema)).rejects.toBeInstanceOf(ModelError);
  });

  it('reports status, and offline when nothing answers', async () => {
    const o = await fakeOllama([]);
    expect(await ollamaStatus(o.url)).toEqual({ online: true, models: [{ name: 'gemma4:26b', sizeGb: 18 }], loaded: [] });
    await new Promise((r) => server!.close(r));
    expect((await ollamaStatus(o.url)).online).toBe(false);
  });
});

describe('joinNameParts', () => {
  it('adds the full name when a model only reported its pieces', () => {
    const text = 'Assuré : M. Jean-François Tremblay\nMonsieur Tremblay,';
    const parts = [
      { text: 'Jean-François', type: 'person' as const, groupKey: 'c0:p1', person: { first: 'Jean-François' }, source: 'claude' as const },
      { text: 'Tremblay', type: 'person' as const, groupKey: 'c0:p1', person: { last: 'Tremblay' }, source: 'claude' as const },
    ];
    const out = joinNameParts(text, parts);
    expect(out).toHaveLength(3);
    expect(out[2]).toMatchObject({ text: 'Jean-François Tremblay', person: { first: 'Jean-François', last: 'Tremblay' }, groupKey: 'c0:p1' });
  });

  it('leaves groups alone when the full name is there or the pieces are apart', () => {
    const full = [{ text: 'Isabelle Côté', type: 'person' as const, groupKey: 'g', person: { first: 'Isabelle', last: 'Côté' }, source: 'claude' as const }];
    expect(joinNameParts('Isabelle Côté', full)).toHaveLength(1);
    const apart = [
      { text: 'Luc', type: 'person' as const, groupKey: 'h', person: { first: 'Luc' }, source: 'claude' as const },
      { text: 'Roy', type: 'person' as const, groupKey: 'h', person: { last: 'Roy' }, source: 'claude' as const },
    ];
    expect(joinNameParts('Luc a vu le roi. Roy est parti.', apart)).toHaveLength(2);
  });
});
