// What a person does, by clicking: first launch, drop a PDF on the home page,
// Anonymize, review, Create anonymized copy. Timed from the click to the
// review and from the click to the copy, with a screenshot at each step.
//   desktop/e2e/shots.sh e2e/pdf-ui.js build/pdf-ui
// Then three PDFs at once, to see the queue empty in a few seconds, and a
// check that the window may be dragged (the capability). On the web target
// (node web/e2e/run.mjs pdf-ui.js --shots dir) the first launch and the window are the desktop's own.
const { api, native, fixture, target } = window.__anon;
const web = target === 'web';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const assert = (c, m) => {
  if (!c) throw new Error('assert: ' + m);
};
async function waitFor(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out: ' + what);
    await sleep(50);
  }
}
const button = (re) => $$('button').find((b) => re.test(b.textContent.trim()) && !b.disabled);
function fill(el, value) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
async function shot(name) {
  await sleep(600);
  await report(`SHOT ${name}`);
  await sleep(1100);
}
async function drop(name) {
  const dt = new DataTransfer();
  dt.items.add(new File([await fixture('files/' + name)], name, { type: 'application/pdf' }));
  const zone = $('section.dv-shell');
  zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  await waitFor(() => $('.file-card'), 'file card');
}

const fr = document.documentElement.lang === 'fr';
if (!web) {
  // First launch, by clicking.
  await waitFor(() => $('.onb'), 'onboarding');
  button(fr ? /Commencer/ : /Get started/).click();
  await waitFor(() => $('.facts'), 'local step');
  $('.onb-step .actions button').click();
  await waitFor(() => $('.onb-step input[type=password]'), 'password step');
  const [pw, again] = $$('.onb-step input[type=password]');
  fill(pw, 'correct horse battery');
  fill(again, 'correct horse battery');
  $$('.onb-step input[type=checkbox]')[0].click();
  await sleep(100);
  $('.onb-step .actions button').click();
  await waitFor(() => $('.models .model'), 'model step', 60000);
  await shot('1-onboarding-detection');
  assert($('.model.selected')?.textContent.includes(fr ? 'Détection rapide' : 'Fast detection'), 'fast detection selected by default');
  $('.onb-step .actions button').click();
  await waitFor(() => $('.onb-step h1') && /prêt|set/i.test($('.onb-step h1').textContent), 'ready step');
  $('.onb-step .actions button').click();
  await waitFor(() => $('.topbar'), 'app');

  // The window can be moved: the drag command is allowed (no mouse is down, so it may fail otherwise).
  const drag = await window.__TAURI_INTERNALS__.invoke('plugin:window|start_dragging', { label: 'main' }).then(
    () => 'ok',
    (e) => String(e),
  );
  assert(!/not allowed/i.test(drag), 'window drag allowed: ' + drag);
  await report('window drag: ' + drag);

  await waitFor(async () => (await native.sidecarStatus()).engine || null, 'engine up', 60000);
} else {
  await waitFor(() => $('.topbar'), 'app');
  await api.put('/settings/detection', { engine: 'none' });
}
await waitFor(() => $('section.dv-shell'), 'home');

// One PDF, by hand, before any project exists: Anonymize starts one.
await drop('assurance-habitation.pdf');
await shot('2-home-file');
let t = performance.now();
button(fr ? /^Anonymiser/ : /^Anonymize/).click();
await waitFor(() => $('mark.span'), 'review', 30000);
const toReview = (performance.now() - t) / 1000;
const people = $$('mark.span').length;
await report(`review on screen ${toReview.toFixed(2)} s after the click, ${people} highlighted values`);
await shot('3-review');
t = performance.now();
button(fr ? /Créer la copie anonymisée/ : /Create anonymized copy/).click();
await waitFor(() => $('.dv-notice.ok'), 'copy ready', 30000);
const toCopy = (performance.now() - t) / 1000;
await report(`anonymized copy on screen ${toCopy.toFixed(2)} s after the click`);
await shot('4-copy');
// On the web the page polls the queue every second: a little more waiting is expected.
assert(toReview + toCopy <= (web ? 6 : 3), `PDF took ${(toReview + toCopy).toFixed(2)} s of waiting`);
const out = location.hash.split('/').pop();
const outDoc = await api.get(`/documents/${out}`);
assert((outDoc.steps.verify?.leaks ?? []).length === 0, 'no leaks: ' + JSON.stringify(outDoc.steps.verify?.leaks));
assert(!/Tremblay|Côté|Bergeron/.test(outDoc.text), 'names replaced in the copy');

// Three at once: the queue empties in a few seconds.
const pid = outDoc.document.projectId;
t = performance.now();
const ids = [];
for (const name of ['assurance-habitation.pdf', 'assurance-habitation-scan.pdf', 'assurance-habitation.pdf']) {
  const form = new FormData();
  form.append('file', new File([await fixture('files/' + name)], name, { type: 'application/pdf' }));
  ids.push((await api.post(`/projects/${pid}/documents`, form)).id);
}
await waitFor(async () => (await Promise.all(ids.map((id) => api.get(`/documents/${id}`)))).every((r) => r.document.status === 'needs_review'), 'queue', 30000);
await report(`three PDFs analyzed in ${((performance.now() - t) / 1000).toFixed(2)} s`);

window.__anon.navigate('/settings');
await waitFor(() => $('.model-picker'), 'settings');
$('.model-picker')?.scrollIntoView();
await shot('5-settings-detection');
await report('DONE');
