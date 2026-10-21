import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Entity } from '@anon/core';
import { afterEach, describe, expect, it } from 'vitest';
import { analyze } from '../src/compute';
import { ANSWER_TOKENS_PER_CHAR, completeEntries, detectEntities, hintsFor, MAX_SPLIT_ROUNDS, splitPiece, suggestSpans } from '../src/detect';
import { llamaCppClient } from '../src/llamacpp';
import { answerBudget, baseUrlFetch, CutOffError, estimateTokens, repetitionGuard, type ModelClient } from '../src/model';
import { ollamaClient } from '../src/ollama';

let server: Server | undefined;
afterEach(() => server?.close());

/** An answer like Gemma's: one entry per value, indented, about 70 characters each. */
const entry = (text: string, type = 'person', group = 'p1') => `  {"text": "${text}", "type": "${type}", "group": "${group}"}`;
const answerOf = (entries: string[]) => `{"entities": [\n${entries.join(',\n')}\n]}`;

/** Text with one person per paragraph: "Personne 0 Nom0", "Personne 1 Nom1", … */
const people = (n: number, filler = 'lorem ipsum dolor sit amet '.repeat(6)) =>
  Array.from({ length: n }, (_, i) => `Personne ${i} Nom${i}. ${filler}`).join('\n\n');

/** A model that answers with every "Personne N NomN" of its piece, and cuts off past `cutAbove` characters of document. */
function fakeModel(opts: { cutAbove?: number; contextTokens?: number; maxAnswerTokens?: number; maxChunkChars?: number; always?: boolean } = {}) {
  const calls: string[] = [];
  const model: ModelClient = {
    name: 'fake',
    local: true,
    maxChunkChars: opts.maxChunkChars ?? 100_000,
    contextTokens: opts.contextTokens,
    maxAnswerTokens: opts.maxAnswerTokens ?? 100_000,
    async structured<T>(_system: string, user: string) {
      calls.push(user);
      const doc = /<document part="\d+">\n([\s\S]*)\n<\/document>/.exec(user)?.[1] ?? '';
      const found = [...doc.matchAll(/Personne \d+ Nom\d+/g)].map((m) => entry(m[0]));
      if (opts.always || (opts.cutAbove !== undefined && doc.length > opts.cutAbove)) {
        // What a stuck model leaves: the first entries complete, then a cut mid-entry.
        throw new CutOffError('fake: the answer was cut off', 'length', answerOf(found).slice(0, 200), { input_tokens: 10, output_tokens: 1000 });
      }
      return { data: JSON.parse(answerOf(found)) as T, usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
  return { model, calls };
}

describe('repetitionGuard', () => {
  const feed = (text: string, size = 7) => {
    const g = repetitionGuard();
    for (let i = 0; i < text.length; i += size) {
      const stuck = g.push(text.slice(i, i + size));
      if (stuck) return { stuck, at: i };
    }
    return null;
  };

  it('lets a normal answer through: 150 different values, a few written twice', () => {
    const entries = Array.from({ length: 150 }, (_, i) => entry(i % 30 === 0 ? 'Lamy' : `Valeur ${i} ${'x'.repeat(i % 7)}`, 'person', `p${i}`));
    expect(feed(answerOf(entries))).toBeNull();
  });

  it('stops the same entries looping, long before an answer limit', () => {
    const loop = [entry('Olivier Lamy', 'person', 'p3'), entry('O. Lamy', 'person', 'p3'), entry('M. Lamy', 'person', 'p3')];
    const text = answerOf([entry('Véronique Gauthier-Lamy'), ...Array.from({ length: 200 }, (_, i) => loop[i % 3]!)]);
    const r = feed(text);
    expect(r?.stuck).toMatch(/^rule repeat: the last 1200 characters repeat every \d+$/);
    expect(r!.at).toBeLessThan(2500);
  });

  it('stops one value written over and over with a new group each time', () => {
    const text = answerOf(Array.from({ length: 200 }, (_, i) => entry('Lamy', 'person', `p${i}`)));
    expect(feed(text)?.stuck).toBe('rule same-value: one value written 41 times');
  });

  it('stops values the model invents one after another (E4B counting "i457", "i458"…)', () => {
    const source = '<document part="1">\nCoopérative de crédit Haute-Mauricie, dossier HYP-2026-0048317, Mathieu Lacasse, Laval (Québec)\n</document>';
    const real = [entry('Coopérative de crédit Haute-Mauricie', 'organization', 'o1'), entry('HYP-2026-0048317', 'id_number', 'i1'), entry('Mathieu Lacasse'), entry('Laval, Québec', 'address', 'a1')];
    const counting = Array.from({ length: 300 }, (_, i) => entry(`i${457 + i}`, 'id_number', `i${520 + i}`));
    const g = repetitionGuard({ source });
    let stuck: string | null = null;
    let at = 0;
    const text = answerOf([...real, ...counting]);
    for (; at < text.length && !stuck; at += 9) stuck = g.push(text.slice(at, at + 9));
    expect(stuck).toMatch(/15 values in a row that aren't in the text/);
    expect(at).toBeLessThan(text.length / 10);
    // Values written a little differently ("Laval, Québec") or a few slips in a row are fine.
    const ok = repetitionGuard({ source });
    const slips = answerOf([...real, entry('Mathieu Lacase'), entry('M. Lacasse'), entry('Lacasse M.'), ...real]);
    expect([...slips].map((c) => ok.push(c)).filter(Boolean)).toEqual([]);
  });

  it('stops 26B looping on one date, as on the live project (the rule, not the value, in the message)', () => {
    const real = Array.from({ length: 90 }, (_, i) => entry(`Valeur ${i}`, 'person', `p${i}`));
    const loop = Array.from({ length: 478 }, () => '{"text": "2026-08-27", "type": "date", "group": "dt1"}');
    const g = repetitionGuard();
    const text = `{"entities": [${[...real, ...loop].join(', ')}`;
    let stuck: string | null = null;
    let at = 0;
    for (; at < text.length && !stuck; at += 9) stuck = g.push(text.slice(at, at + 9));
    expect(stuck).toMatch(/^rule (repeat|same-value)/);
    expect(stuck).not.toContain('2026');
    expect(at).toBeLessThan(text.length / 3);
  });

  it('stops a run of whitespace (the JSON grammar allows any amount)', () => {
    expect(feed(`{"entities": [${' \n'.repeat(150)}`)?.stuck).toMatch(/whitespace/);
  });
});

describe('completeEntries', () => {
  it('keeps the entries finished before the cut', () => {
    const partial = '{"entities": [\n  {"text": "Jean \\"JF\\" Roy", "type": "person", "group": "p1", "first": "Jean"},\n  {"text": "{x}", "type": "other", "group": "o1"},\n  {"text": "H7N 2';
    expect(completeEntries(partial)).toEqual([
      { text: 'Jean "JF" Roy', type: 'person', group: 'p1', first: 'Jean' },
      { text: '{x}', type: 'other', group: 'o1' },
    ]);
    expect(completeEntries('')).toEqual([]);
    expect(completeEntries('{"entities": [] , "x": [{"text": "no"}]}')).toEqual([]);
  });
});

describe('splitting a cut-off part', () => {
  it('splits at the paragraph break nearest the middle, and not below the minimum', () => {
    const text = people(4);
    const [a, b] = splitPiece(text, { start: 0, end: text.length })!;
    expect(a.end).toBe(b.start);
    expect(text.slice(a.end - 2, a.end)).toBe('\n\n');
    expect(splitPiece('short', { start: 0, end: 5 })).toBeNull();
  });

  it('recovers every value when a long part comes back cut off', async () => {
    const text = people(16);
    const { model, calls } = fakeModel({ cutAbove: 1500 });
    const progress: Array<[number, number]> = [];
    const r = await detectEntities(model, text, [], (d, t) => progress.push([d, t]));
    expect(r.incomplete).toBeUndefined();
    expect(r.splits).toBeGreaterThan(0);
    expect(new Set(r.detections.map((d) => d.text))).toEqual(new Set(Array.from({ length: 16 }, (_, i) => `Personne ${i} Nom${i}`)));
    // Every call that answered was within the limit; the cut-off ones were asked again in halves.
    expect(calls.length).toBe(1 + 2 * r.splits);
    expect(progress.at(-1)).toEqual([calls.length, calls.length]);
    // The cut-off calls' tokens count too (Claude bills them).
    expect(r.usage.output_tokens).toBe((calls.length - r.splits) * 5 + r.splits * 1000);
  });

  it('gives up after a bounded number of rounds, keeps what was finished and says so', async () => {
    const text = people(64);
    const { model, calls } = fakeModel({ always: true });
    const r = await detectEntities(model, text, []);
    expect(r.incomplete).toMatch(/still cut off after splitting/);
    // One call, then at most MAX_SPLIT_ROUNDS rounds of halves.
    expect(calls.length).toBeLessThanOrEqual(2 ** (MAX_SPLIT_ROUNDS + 1) - 1);
    expect(r.detections.length).toBeGreaterThan(0);
  });

  it('analyze keeps the model values of an incomplete pass and reports it', async () => {
    const { model } = fakeModel({ always: true });
    const r = await analyze({ engine: null as never, model: () => model }, people(8), [], true);
    expect(r.claudeError).toMatch(/still cut off/);
    expect(r.candidates.some((c) => c.real.text === 'Personne 0 Nom0')).toBe(true);
  });

  it('splits restore suggestions too', async () => {
    const calls: string[] = [];
    const model: ModelClient = {
      name: 'fake',
      local: true,
      maxChunkChars: 100_000,
      maxAnswerTokens: 100_000,
      async structured<T>(_s: string, user: string) {
        calls.push(user);
        const doc = /<document>\n([\s\S]*)\n<\/document>/.exec(user)![1]!;
        if (doc.length > 1000) throw new CutOffError('cut', 'length');
        const spans = [...doc.matchAll(/Personne \d+ Nom\d+/g)].map((m) => ({ text: m[0], fake_id: 'e1' }));
        return { data: { spans } as T, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    const fake = { id: 'e1', type: 'person', real: { text: 'x' }, fake: { text: 'Personne 0 Nom0' }, enabled: true } as Entity;
    const r = await suggestSpans(model, people(8), [fake]);
    expect(r.incomplete).toBeUndefined();
    expect(r.suggestions).toHaveLength(8);
    expect(calls.length).toBeGreaterThan(1);
  });
});

describe('token budget', () => {
  it('sizes parts so prompt and planned answer fit the window', async () => {
    const text = people(60);
    const { model, calls } = fakeModel({ contextTokens: 4096, maxAnswerTokens: 2048 });
    const r = await detectEntities(model, text, []);
    expect(r.splits).toBe(0);
    expect(calls.length).toBeGreaterThan(1);
    for (const user of calls) {
      const doc = /<document part="\d+">\n([\s\S]*)\n<\/document>/.exec(user)![1]!;
      expect(doc.length * ANSWER_TOKENS_PER_CHAR).toBeLessThanOrEqual(2048);
      expect(estimateTokens(user) + doc.length * ANSWER_TOKENS_PER_CHAR).toBeLessThanOrEqual(4096);
    }
    expect(r.detections).toHaveLength(60);
  });

  it('gives the answer what the window leaves, and refuses a prompt that leaves too little', () => {
    expect(answerBudget('m', 16384, 32768, 'x'.repeat(2500), 'y'.repeat(25_000))).toBe(16384);
    expect(answerBudget('m', 16384, 16384, 'x'.repeat(2500), 'y'.repeat(25_000))).toBe(16384 - 1000 - 10_000 - 256);
    expect(() => answerBudget('m', 16384, 16384, '', 'y'.repeat(40_000))).toThrow(CutOffError);
  });

  it('known values: only those in the part, one line per type', () => {
    const e = (id: string, type: Entity['type'], text: string) => ({ id, type, real: { text }, fake: { text: 'f' + id }, enabled: false }) as Entity;
    const hints = [e('1', 'person', 'Olivier Lamy'), e('2', 'person', 'Denise Lamy'), e('3', 'sin', '271 846 396'), e('4', 'person', 'Absent Ailleurs')];
    const out = hintsFor('Olivier Lamy, NAS 271 846 396, et Denise Lamy.', hints);
    expect(out).toBe('\n\nAlready known in this document (report their mentions too):\n- person: Olivier Lamy | Denise Lamy\n- sin: 271 846 396');
    expect(hintsFor('rien ici', hints)).toBe('');
    // Dates and amounts aren't listed (26B looped on a listed date).
    expect(hintsFor('Le 2026-08-27, 84 500 $.', [e('5', 'date', '2026-08-27'), e('6', 'amount', '84 500 $')])).toBe('');
  });
});

describe('clients stop a stuck answer', () => {
  /** A server that streams `pieces` slowly and records whether the client hung up early. */
  async function streaming(contentType: string, pieces: string[]): Promise<{ url: string; bodies: Array<Record<string, unknown>>; closedEarly: () => boolean }> {
    const bodies: Array<Record<string, unknown>> = [];
    let early = false;
    server = createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': contentType });
      let sent = 0;
      res.on('close', () => {
        if (sent < pieces.length) early = true;
      });
      for (const p of pieces) {
        if (res.destroyed) break;
        res.write(p);
        sent++;
        await new Promise((r) => setTimeout(r, 1));
      }
      res.end();
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, bodies, closedEarly: () => early };
  }
  const looping = Array.from({ length: 400 }, () => entry('Olivier Lamy', 'person', 'p3') + ',\n');

  it('Ollama: a looping answer is stopped and the stream closed; num_predict fits the window', async () => {
    const lines = [JSON.stringify({ message: { content: '{"entities": [\n' } }), ...looping.map((c) => JSON.stringify({ message: { content: c } })), JSON.stringify({ done: true, done_reason: 'length' })];
    const s = await streaming('application/x-ndjson', lines.map((l) => l + '\n'));
    const err = await ollamaClient({ url: s.url, model: 'gemma4:26b' }).structured('sys', 'doc', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CutOffError);
    expect((err as CutOffError).reason).toBe('repetition');
    expect(completeEntries((err as CutOffError).partial).length).toBeGreaterThan(10);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.closedEarly()).toBe(true);
    expect(s.bodies[0]).toMatchObject({ options: { num_ctx: 32768, num_predict: 16384 } });
  });

  it('Ollama: a cut-off answer says how many tokens, and carries what was written', async () => {
    const lines = [{ message: { content: '{"entities": [\n' + entry('Jean Roy') + ',\n  {"te' } }, { done: true, done_reason: 'length', prompt_eval_count: 5514, eval_count: 16384 }];
    const s = await streaming('application/x-ndjson', lines.map((l) => JSON.stringify(l) + '\n'));
    const err = (await ollamaClient({ url: s.url, model: 'gemma4:26b' }).structured('s', 'u', {}).catch((e: unknown) => e)) as CutOffError;
    expect(err).toBeInstanceOf(CutOffError);
    expect(err.message).toMatch(/5514 prompt \+ 16384 answer tokens, limit 16384 of 32768/);
    expect(completeEntries(err.partial)).toEqual([{ text: 'Jean Roy', type: 'person', group: 'p1' }]);
  });

  it('llama-server: a looping answer is stopped; max_tokens is what the context leaves', async () => {
    const sse = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
    const s = await streaming('text/event-stream', [sse('{"entities": [\n'), ...looping.map(sse), 'data: [DONE]\n\n']);
    const client = llamaCppClient({ fetch: baseUrlFetch(s.url), name: 'Gemma 4 E4B', maxChunkChars: 8000, contextTokens: 8192 });
    const user = 'u'.repeat(10_000);
    const err = await client.structured('s', user, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CutOffError);
    expect((err as CutOffError).reason).toBe('repetition');
    expect(s.bodies[0]!.max_tokens).toBe(8192 - 1 - 4000 - 256);
  });

  it('llama-server: a prompt that leaves no room is not sent', async () => {
    const s = await streaming('text/event-stream', []);
    const client = llamaCppClient({ fetch: baseUrlFetch(s.url), name: 'g', maxChunkChars: 8000, contextTokens: 4096 });
    await expect(client.structured('s', 'u'.repeat(9000), {})).rejects.toMatchObject({ reason: 'prompt' });
    expect(s.bodies).toHaveLength(0);
  });
});

describe('titles from the model', () => {
  it('drops a lone "Mme" the model put in a group, and titles in name parts', async () => {
    const reported = [
      { text: 'Véronique Gauthier-Lamy', type: 'person', group: 'p2', first: 'Véronique', last: 'Gauthier-Lamy' },
      { text: 'Mme', type: 'person', group: 'p2', gender: 'f' },
      { text: 'Mme Lebeau', type: 'person', group: 'p5', first: 'Mme', middle: '', last: 'Lebeau' },
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
    const r = await detectEntities(model, 'Véronique Gauthier-Lamy (cellulaire, Mme). Mme Lebeau.', []);
    expect(r.detections.map((d) => d.text)).toEqual(['Véronique Gauthier-Lamy', 'Mme Lebeau']);
    expect(r.detections[1]!.person).toEqual({ last: 'Lebeau' });
  });
});
