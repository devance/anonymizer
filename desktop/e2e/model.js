// Real model run, inside the app (desktop/e2e/run.sh model.js): downloads the
// model through Rust (resume, sha256), starts llama-server with its draft,
// and runs every fixtures/detect document through detection and render.
// Reports detection time per document and the required values still present
// in the anonymized text, per language.
// E2E_MODEL picks the model (default gemma4-e4b); set E2E_MODELS in run.sh's
// environment to keep downloads between runs.
const { api, native, startBackend } = window.__anon;
const invoke = window.__TAURI_INTERNALS__.invoke;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error('assert: ' + msg);
};
async function waitFor(fn, what, ms = 600000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out: ' + what);
    await sleep(300);
  }
}
const text = async (name) => new TextDecoder().decode(new Uint8Array(await invoke('e2e_fixture', { name })));
const fold = (s) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\s‐-―−-]+/g, ' ')
    .trim();

const MODEL = (await invoke('e2e_env', { name: 'E2E_MODEL' })) || 'gemma4-e4b';
const DOCS = [
  'assurance-habitation', 'bail-logement', 'cheque-specimen', 'succession-ocr', 'dossier-hypothecaire',
  'home-insurance-en', 'residential-lease-en', 'void-cheque-en', 'estate-ocr-en', 'notary-letter-en', 'fleet-policy-en',
];

await native.vaultCreate('correct horse battery', false);
startBackend();

let m = (await native.modelCatalog()).find((x) => x.id === MODEL);
assert(m && m.available, 'model in catalog');
if (!m.complete) {
  const t0 = Date.now();
  let last = -1;
  await native.modelDownload(MODEL, (p) => {
    const step = Math.floor((p.received / p.total) * 10);
    if (step !== last || p.phase !== 'downloading') {
      last = step;
      void report(`download ${p.phase} ${Math.round((p.received / p.total) * 100)}% ${(p.bytesPerSec / 1e6).toFixed(1)} MB/s`);
    }
  });
  await report(`downloaded ${(m.totalSize / 1e9).toFixed(2)} GB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
m = (await native.modelCatalog()).find((x) => x.id === MODEL);
assert(m.installed && m.complete, 'installed with its draft');

await api.put('/settings/detection', { engine: 'builtin', model: MODEL });
const t0 = Date.now();
await native.llamaStart(MODEL);
await report(`llama-server up in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const totals = {};
for (const name of DOCS) {
  const body = await text(`detect/${name}.txt`);
  const exp = JSON.parse(await text(`detect/${name}.expected.json`));
  const { id: pid } = await api.post('/projects', { name });
  const start = Date.now();
  const { id } = await api.post(`/projects/${pid}/documents`, { text: body, filename: `${name}.txt` });
  const review = await waitFor(async () => {
    const r = await api.get(`/documents/${id}`);
    if (r.document.status === 'error') throw new Error(`${name}: ${r.document.error}`);
    return r.document.status === 'needs_review' && r;
  }, `analysis of ${name}`);
  const secs = (Date.now() - start) / 1000;
  assert(!review.steps.detect?.claudeError, `${name}: ${review.steps.detect?.claudeError}`);
  await api.post(`/documents/${id}/render`);
  const out = await waitFor(async () => {
    const r = await api.get(`/documents/${id}`);
    return r.document.status === 'ready' && r.outputs[0];
  }, `render of ${name}`);
  const anon = fold((await api.get(`/documents/${out.id}`)).text);
  const left = exp.must.filter((v) => anon.includes(fold(v)));
  const t = (totals[exp.lang] ??= { must: 0, left: 0, secs: 0, docs: 0 });
  t.must += exp.must.length;
  t.left += left.length;
  t.secs += secs;
  t.docs += 1;
  await report(`${name} [${exp.lang}] ${secs.toFixed(1)} s, ${review.steps.detect.found} found, ${left.length}/${exp.must.length} left ${JSON.stringify(left)}`);
}
for (const [lang, t] of Object.entries(totals)) {
  await report(`${MODEL} ${lang}: ${(100 * (1 - t.left / t.must)).toFixed(1)}% removed (${t.must - t.left}/${t.must}), ${(t.secs / t.docs).toFixed(1)} s/doc`);
}
await report('DONE');
