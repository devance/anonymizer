// A text PDF and a scanned one through the real engine: OCR, fast detection
// (the engine's small model and the rules, no big model), rewrite, leak check,
// with the time each takes. Run with desktop/e2e/run.sh files.js (needs engine/dist built),
// or on the web target with node web/e2e/run.mjs files.js (needs engine/.venv).
const { api, bytes, native, startBackend, fixture, target } = window.__anon;
const web = target === 'web';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => {
  if (!c) throw new Error('assert: ' + m);
};
async function waitFor(fn, what, ms = 180000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out: ' + what);
    await sleep(500);
  }
}

if (!web) {
  await native.vaultCreate('correct horse battery', false);
  startBackend();
}
await api.put('/settings/detection', { engine: 'none' });
if (!web) {
  const st = await waitFor(async () => (await native.sidecarStatus()).engine || null, 'engine up', 60000);
  await report('engine up ' + st);
}

for (const name of ['assurance-habitation.pdf', 'assurance-habitation-scan.pdf']) {
  const { id: pid } = await api.post('/projects', { name });
  const form = new FormData();
  form.append('file', new File([await fixture('files/' + name)], name, { type: 'application/pdf' }));
  const t0 = Date.now();
  const { id } = await api.post(`/projects/${pid}/documents`, form);
  const review = await waitFor(async () => {
    const r = await api.get(`/documents/${id}`);
    if (r.document.status === 'failed') throw new Error('analysis failed: ' + r.document.error);
    return r.document.status === 'needs_review' && r;
  }, 'analysis ' + name);
  const analyzed = (Date.now() - t0) / 1000;
  const people = review.matches.filter((m) => m.type === 'person').map((m) => m.surface);
  await report(`${name}: ${review.matches.length} matches, ${people.length} people, ocr=${review.steps.extract?.ocr}, analyzed in ${analyzed.toFixed(1)} s`);
  assert(review.text.includes('Tremblay'), 'text extracted');
  assert(!review.steps.detect?.nerError, 'small model ran: ' + review.steps.detect?.nerError);
  assert(people.some((p) => p.includes('Tremblay')) && people.some((p) => p.includes('Côté')), 'people found by the small model');
  const t1 = Date.now();
  await api.post(`/documents/${id}/render`);
  const out = await waitFor(async () => {
    const r = await api.get(`/documents/${id}`);
    if (r.document.error) throw new Error('render: ' + r.document.error);
    return r.document.status === 'ready' && r.outputs[0];
  }, 'render ' + name);
  const outDoc = await api.get(`/documents/${out.id}`);
  const leaks = outDoc.steps.verify?.leaks ?? [];
  const rendered = (Date.now() - t1) / 1000;
  await report(`${name}: rendered in ${rendered.toFixed(1)} s, leaks ${JSON.stringify(leaks)}, missingWords ${outDoc.steps.verify?.missingWords}`);
  // The text PDF is the goal: a few seconds from drop to anonymized file (on the web, through the queue and the processor).
  if (!name.includes('scan')) assert(analyzed + rendered <= (web ? 8 : 3), `text PDF took ${(analyzed + rendered).toFixed(1)} s`);
  assert(!out.outName.includes('Tremblay'), 'filename swapped');
  assert(leaks.length === 0, 'no leaks');
  const exp = await api.get(`/documents/${out.id}/export`);
  assert(exp.blobId, 'exportable');
  // The copy is a PDF, through the same route the app saves from.
  const head = new TextDecoder().decode((await bytes(`/documents/${out.id}/file`)).slice(0, 5));
  assert(head === '%PDF-', 'a PDF came back: ' + head);
}
await report('DONE');
