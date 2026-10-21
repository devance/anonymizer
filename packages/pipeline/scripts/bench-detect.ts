/**
 * Compare detection models on the synthetic documents in fixtures/detect.
 * Each document lists the values that must be caught; a model scores the
 * share it finds (regex + model, as in the app; a plain date or amount
 * doesn't count), per language and overall,
 * plus the values it reported that aren't listed (extras) and its time per document.
 *
 *   npx tsx packages/pipeline/scripts/bench-detect.ts [options] [ollama-model...]
 *
 *   --ollama URL   Ollama for the named models (default http://127.0.0.1:11434)
 *   --llama URL    also run llama-server at URL (whatever model it has loaded); key in LLAMA_API_KEY
 *   --claude       also run `claude -p` on this machine, as the reference
 *   --chunk N      maxChunkChars for Ollama and llama-server (default: OLLAMA_CHUNK_CHARS, LLAMA_CHUNK_CHARS)
 *   --known        analyze each document once, keep what it found as the project's known values
 *                  (as after a reviewed document), then analyze it again and score that second pass
 *   --runs N       run each model N times, to see the variance
 *   --json FILE    save every run, document and missed value
 *
 * Only synthetic documents: never point it at real ones.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fold, type Candidate, type Entity } from '@anon/core';
import { cliClaude } from '../src/cli-claude';
import { analyze, type Deps } from '../src/compute';
import { detectEntities } from '../src/detect';
import { LLAMA_CHUNK_CHARS, llamaCppClient, llamaCppModel } from '../src/llamacpp';
import { baseUrlFetch, type ModelClient } from '../src/model';
import { ollamaClient } from '../src/ollama';

type Lang = 'fr' | 'en';
const LANGS: Lang[] = ['fr', 'en'];

const args = process.argv.slice(2);
let ollamaUrl = 'http://127.0.0.1:11434';
let chunk: number | undefined;
let runs = 1;
let jsonOut: string | undefined;
const llamaUrls: string[] = [];
const models: string[] = [];
let claude = false;
let withKnown = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--ollama') ollamaUrl = args[++i]!;
  else if (a === '--llama') llamaUrls.push(args[++i]!);
  else if (a === '--claude') claude = true;
  else if (a === '--chunk') chunk = Number(args[++i]);
  else if (a === '--runs') runs = Number(args[++i]);
  else if (a === '--json') jsonOut = args[++i];
  else if (a === '--known') withKnown = true;
  else models.push(a);
}

const clients: ModelClient[] = [];
const suffix = `${chunk ? ` (chunk ${chunk})` : ''}${withKnown ? ' (known values)' : ''}`;
for (const m of models) clients.push({ ...ollamaClient({ url: ollamaUrl, model: m, maxChunkChars: chunk }), name: `${m} on Ollama${suffix}` });
for (const url of llamaUrls) {
  const fetch = baseUrlFetch(url, process.env.LLAMA_API_KEY);
  const loaded = await llamaCppModel(fetch);
  if (!loaded) throw new Error(`no llama-server answering at ${url}`);
  clients.push(llamaCppClient({ fetch, name: `${loaded} on llama-server${suffix}`, maxChunkChars: chunk ?? LLAMA_CHUNK_CHARS }));
}
if (claude) clients.push(cliClaude({ model: 'opus' }));
if (clients.length === 0) throw new Error('name at least one model (Ollama), --llama URL or --claude');

const dir = join(import.meta.dirname, '../../../fixtures/detect');
const docs = readdirSync(dir)
  .filter((f) => f.endsWith('.txt'))
  .map((f) => ({
    name: f.replace(/\.txt$/, ''),
    text: readFileSync(join(dir, f), 'utf8'),
    ...(JSON.parse(readFileSync(join(dir, f.replace(/\.txt$/, '.expected.json')), 'utf8')) as { lang: Lang; must: string[]; optional: string[] }),
  }));

const norm = (s: string) => fold(s).replace(/\s+/g, ' ');
// "Mme Martin", "K. Haddad" → the name the matcher derives them from.
const core = (s: string) => norm(s).replace(/^(m|mme|me|mr|mrs|ms|dr)\.? /, '').replace(/^([a-z]\.-?)+ ?/, '');

/**
 * A date of birth or an identifier reported as a plain date or amount stays
 * in the document unless the reviewer turns it on, so it doesn't count.
 */
function caught(value: string, cands: Candidate[]): boolean {
  const v = core(value);
  return cands.some((c) =>
    c.type !== 'date' &&
    c.type !== 'amount' &&
    [c.real.text, ...c.surfaces].some((t) => {
      const n = norm(t);
      return n.includes(v) || (v.includes(n) && n.length >= v.length * 0.6);
    }),
  );
}

const pct = (got: number, of: number) => (of ? `${((100 * got) / of).toFixed(1)}%` : 'n/a');
const tally = () => ({ fr: 0, en: 0 }) as Record<Lang, number>;

interface DocResult {
  name: string;
  lang: Lang;
  seconds: number;
  must: number;
  got: number;
  missed: string[];
  extras: string[];
  /** Values the model didn't copy as written: placed by the loose fallback, or dropped. */
  rewritten: string[];
  error?: string;
  /** Known values the scored pass had. */
  known: number;
  /** Each model call of the scored pass: characters sent, tokens in and out. */
  calls: Array<{ chars: number; input: number; output: number }>;
  splits: number;
}
interface RunResult {
  client: string;
  run: number;
  loadSeconds: number;
  must: Record<Lang, number>;
  got: Record<Lang, number>;
  recall: Record<Lang | 'all', number>;
  optional: { got: number; of: number };
  extras: Record<Lang, number>;
  rewritten: number;
  secondsPerDoc: number;
  docs: DocResult[];
}

const results: RunResult[] = [];
for (const client of clients) {
  let raw: string[] = [];
  let calls: DocResult['calls'] = [];
  const spy: ModelClient = {
    ...client,
    async structured<T>(system: string, user: string, schema: Record<string, unknown>) {
      const r = await client.structured<T>(system, user, schema);
      calls.push({ chars: system.length + user.length, input: r.usage.input_tokens, output: r.usage.output_tokens });
      for (const e of (r.data as { entities?: Array<{ text?: string }> }).entities ?? []) if (e.text?.trim()) raw.push(e.text);
      return r;
    },
  };
  const deps: Deps = { engine: null as never, model: () => spy };
  for (let run = 1; run <= runs; run++) {
    // Load the model first so the first document's time is only its own.
    const t0 = Date.now();
    await detectEntities(client, 'Bonjour, ceci est un essai.', []).catch((err: unknown) => console.error(`  warm-up failed: ${err}`));
    const loadSeconds = (Date.now() - t0) / 1000;
    const must = tally();
    const got = tally();
    const extras = tally();
    let opt = 0;
    let optGot = 0;
    let ms = 0;
    let rewritten = 0;
    const out: DocResult[] = [];
    for (const d of docs) {
      let known: Entity[] = [];
      let firstError: string | undefined;
      if (withKnown) {
        const first = await analyze(deps, d.text, [], true);
        firstError = first.claudeError;
        known = first.candidates.map((c, i) => ({ id: `k${i}`, type: c.type, real: c.real, fake: { text: `fake ${i}` }, surfaces: c.surfaces, enabled: true }));
      }
      raw = [];
      calls = [];
      const t1 = Date.now();
      const r = await analyze(deps, d.text, known, true);
      const took = Date.now() - t1;
      ms += took;
      const folded = fold(d.text);
      const doc: DocResult = {
        name: d.name,
        lang: d.lang,
        seconds: took / 1000,
        must: d.must.length,
        got: 0,
        missed: [],
        extras: [],
        rewritten: [...new Set(raw.filter((t) => !folded.includes(fold(t))))],
        error: r.claudeError ?? (firstError ? `first pass: ${firstError}` : undefined),
        known: known.length,
        calls: [...calls],
        splits: r.modelSplits ?? 0,
      };
      rewritten += doc.rewritten.length;
      for (const v of d.must) {
        if (caught(v, r.candidates)) doc.got++;
        else doc.missed.push(v.replace(/\n/g, ' '));
      }
      for (const v of d.optional) {
        opt++;
        if (caught(v, r.candidates)) optGot++;
      }
      const listed = [...d.must, ...d.optional].map(core);
      for (const c of r.candidates) {
        const n = norm(c.real.text);
        if (!listed.some((v) => n.includes(v) || v.includes(n))) doc.extras.push(`${c.type} "${c.real.text}"`);
      }
      must[d.lang] += doc.must;
      got[d.lang] += doc.got;
      extras[d.lang] += doc.extras.length;
      out.push(doc);
      const tokens = doc.calls.map((c) => `${c.input}+${c.output}`).join(', ');
      console.error(
        `  ${client.name} #${run} ${d.name}: ${doc.got}/${doc.must}, ${doc.seconds.toFixed(1)} s, ${doc.known} known, ${doc.calls.length} call(s) [${tokens}]${doc.splits ? `, ${doc.splits} split` : ''}${doc.error ? ` ERROR ${doc.error}` : ''}`,
      );
    }
    const all = must.fr + must.en;
    const res: RunResult = {
      client: client.name,
      run,
      loadSeconds,
      must,
      got,
      recall: { fr: got.fr / must.fr, en: got.en / must.en, all: (got.fr + got.en) / all },
      optional: { got: optGot, of: opt },
      extras,
      rewritten,
      secondsPerDoc: ms / docs.length / 1000,
      docs: out,
    };
    results.push(res);
    console.log(
      `\n## ${client.name}, run ${run}: FR ${got.fr}/${must.fr} (${pct(got.fr, must.fr)}), EN ${got.en}/${must.en} (${pct(got.en, must.en)}), ` +
        `all ${got.fr + got.en}/${all} (${pct(got.fr + got.en, all)}), optional ${optGot}/${opt}, extras ${extras.fr + extras.en}, rewritten ${rewritten}, ` +
        `${res.secondsPerDoc.toFixed(1)} s/doc (load ${loadSeconds.toFixed(1)} s)`,
    );
    for (const d of out) {
      if (d.error) console.log(`  error   ${d.name}: ${d.error}`);
      for (const m of d.missed) console.log(`  missed  ${d.name}: ${m}`);
    }
    for (const d of out) for (const e of d.extras) console.log(`  extra   ${d.name}: ${e}`);
    for (const d of out) for (const u of d.rewritten) console.log(`  rewritten ${d.name}: "${u.replace(/\n/g, ' ')}"`);
  }
}

console.log('\n| Model | Run | FR | EN | All | Extras | s/doc |\n|---|---|---|---|---|---|---|');
for (const r of results) {
  const all = r.must.fr + r.must.en;
  console.log(
    `| ${r.client} | ${r.run} | ${pct(r.got.fr, r.must.fr)} | ${pct(r.got.en, r.must.en)} | ${pct(r.got.fr + r.got.en, all)} | ${r.extras.fr + r.extras.en} | ${r.secondsPerDoc.toFixed(1)} |`,
  );
}

if (jsonOut) {
  const fixtures = Object.fromEntries(
    LANGS.map((l) => [l, { docs: docs.filter((d) => d.lang === l).length, must: docs.filter((d) => d.lang === l).reduce((n, d) => n + d.must.length, 0) }]),
  );
  writeFileSync(jsonOut, JSON.stringify({ date: new Date().toISOString(), host: hostname(), chunk: chunk ?? null, known: withKnown, fixtures, results }, null, 2));
  console.error(`saved ${jsonOut}`);
}
