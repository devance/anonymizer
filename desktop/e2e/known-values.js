// A project with many known values, then the long mortgage file again, with a real model:
// the case where Gemma's answer came back cut off on the live site (2026-10-17).
// Web only, with Ollama: E2E_OLLAMA=http://127.0.0.1:11434 node web/e2e/run.mjs known-values.js
// E2E_MODEL picks the Ollama model (default gemma4:26b), E2E_REPEAT the number of re-runs (default 3).
// Synthetic fixtures only.
const { api, target } = window.__anon;
const env = async (name) => (window.__e2eEnv ? window.__e2eEnv(name) : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => {
  if (!c) throw new Error('assert: ' + m);
};
async function waitFor(fn, what, ms = 900000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out: ' + what);
    await sleep(500);
  }
}
assert(target === 'web', 'web target (Ollama on the remote PC)');
const MODEL = (await env('E2E_MODEL')) || 'gemma4:26b';
const REPEAT = Number((await env('E2E_REPEAT')) || 3);
const text = async (name) => new TextDecoder().decode(new Uint8Array(await window.__anon.fixture(name)));

await api.put('/settings/detection', { engine: 'ollama', model: MODEL });
const { id: pid } = await api.post('/projects', { name: 'known-values' });

async function analyze(name) {
  const body = await text(`detect/${name}.txt`);
  const t0 = Date.now();
  const { id } = await api.post(`/projects/${pid}/documents`, { text: body, filename: `${name}.txt` });
  const r = await waitFor(async () => {
    const d = await api.get(`/documents/${id}`);
    if (d.document.status === 'failed') throw new Error(`${name}: ${d.document.error}`);
    return d.document.status === 'needs_review' && d;
  }, 'analysis of ' + name);
  return { id, r, secs: (Date.now() - t0) / 1000 };
}

/** Render as `anon anonymize --yes` does; the copy's own check (real values left) comes back. */
async function keep(id, name) {
  await api.post(`/documents/${id}/render`);
  const out = await waitFor(async () => {
    const d = await api.get(`/documents/${id}`);
    if (d.document.error) throw new Error('render: ' + d.document.error);
    return d.document.status === 'ready' && d.outputs[0];
  }, 'render of ' + name);
  const copy = await api.get(`/documents/${out.id}`);
  return { leaks: copy.steps.verify?.leaks ?? [], text: copy.text };
}

/** The copy back through restore, as `anon restore --yes` does (model suggestions on, only the sure matches applied). */
async function restore(text) {
  const { id } = await api.post('/restore', { text, filename: 'copy.txt', projectId: pid, suggest: true });
  await api.post(`/documents/${id}/render`);
  const out = await waitFor(async () => {
    const d = await api.get(`/documents/${id}`);
    if (d.document.error) throw new Error('restore: ' + d.document.error);
    return d.outputs.find((o) => o.kind === 'restored');
  }, 'restore');
  return (await api.get(`/documents/${out.id}`)).text;
}

// A courtesy title alone is never a person (nor a mention of one).
const TITLE = /^(m|mme|mlle|me|mr|mrs|ms|miss|dr|pr|madame|monsieur|maître)\.?$/i;

// The live project's history: a one-page letter, then the mortgage file, both kept.
for (const name of ['assurance-habitation', 'dossier-hypothecaire']) {
  const { id, r, secs } = await analyze(name);
  await report(`${name}: ${r.steps.detect?.found} found in ${secs.toFixed(1)} s${r.steps.detect?.claudeError ? `, model error: ${r.steps.detect.claudeError}` : ''}`);
  await keep(id, name);
}
const known = (await api.get(`/projects/${pid}/entities`)).entities?.length;
await report(`project has ${known} known values`);

let failed = 0;
let titles = 0;
let leaky = 0;
let inexact = 0;
for (let i = 1; i <= REPEAT; i++) {
  const { id, r, secs } = await analyze('dossier-hypothecaire');
  const err = r.steps.detect?.claudeError;
  if (err) failed++;
  const people = r.matches.filter((m) => m.type === 'person');
  const asTitle = people.filter((m) => TITLE.test(m.surface.trim()));
  titles += asTitle.length;
  const { leaks, text: copy } = await keep(id, 'dossier-hypothecaire');
  if (leaks.length) leaky++;
  const back = await restore(copy);
  const exact = back === (await text('detect/dossier-hypothecaire.txt'));
  if (!exact) inexact++;
  const now = (await api.get(`/projects/${pid}/entities`)).entities?.length;
  await report(
    `dossier-hypothecaire again #${i} with ${now} known: ${r.steps.detect?.found} found, ${r.matches.length} spans, ${people.length} person, in ${secs.toFixed(1)} s` +
      `${err ? `, MODEL ERROR: ${err}` : ', model ok'}${asTitle.length ? `, TITLE AS PERSON x${asTitle.length}` : ''}${leaks.length ? `, LEAKS ${JSON.stringify(leaks.map((l) => l.type ?? l))}` : ''}${exact ? ', restore exact' : ', RESTORE NOT EXACT'}`,
  );
}
if (await env('E2E_DUMP')) {
  // Synthetic values only: for reproducing a run outside the stack.
  for (const e of (await api.get(`/projects/${pid}/entities`)).entities) await report(`ENTITY ${JSON.stringify(e)}`);
}
assert(failed === 0, `${failed} of ${REPEAT} runs lost the model pass`);
assert(titles === 0, `a title alone became a person ${titles} time(s)`);
assert(leaky === 0, `${leaky} of ${REPEAT} copies kept real values`);
assert(inexact === 0, `${inexact} of ${REPEAT} restores weren't exact`);
await report('DONE');
