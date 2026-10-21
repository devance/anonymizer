// Scripted smoke test, run inside the app by desktop/e2e/run.sh (debug build,
// throwaway data folder), or against the web target by web/e2e/run.mjs (local
// Worker, processor and engine). Drives the same modules the UI uses.
const { api, native, startBackend, target } = window.__anon;
const web = target === 'web';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error('assert: ' + msg);
};
async function waitFor(fn, what, ms = 120000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out: ' + what);
    await sleep(300);
  }
}

const ORIGINAL = `Assurances Mirador inc.
Avis de renouvellement

Assuré : M. Jean-François Tremblay
Adresse du risque : 1842, rue des Érables, app. 3, Laval (Québec) H7N 2K4
Téléphone : (450) 662-1934   Courriel : jf.tremblay@videotron.example
Date de naissance de l'assuré : 14 mars 1981
NAS : 046 454 286`;

if (!web) {
  let s = await native.appStatus();
  await report('status ' + s.vault);
  assert(s.vault === 'new', 'fresh data folder');
  await native.vaultCreate('correct horse battery', false);
  s = await native.appStatus();
  assert(s.vault === 'unlocked', 'unlocked after create');
  startBackend();
  await report('vault created');
} else {
  const me = await api.get('/me');
  await report('signed in as ' + me.email + (me.admin ? ', admin' : ''));
}

// Basic mode: no model needed for this smoke test.
await api.put('/settings/detection', { engine: 'none' });
await api.post('/profile', { type: 'person', text: 'Jean-François Tremblay' });
const { id: pid } = await api.post('/projects', { name: 'Achat maison' });
const { id } = await api.post(`/projects/${pid}/documents`, { text: ORIGINAL, filename: 'Tremblay.txt' });
const review = await waitFor(async () => {
  const r = await api.get(`/documents/${id}`);
  return r.document.status === 'needs_review' && r;
}, 'analysis');
await report('matches ' + review.matches.length + ' ' + [...new Set(review.matches.map((m) => m.type))].join(','));
assert(review.matches.length >= 5, 'regex + profile matches');

await api.post(`/documents/${id}/render`);
const out = await waitFor(async () => {
  const r = await api.get(`/documents/${id}`);
  return r.document.status === 'ready' && r.outputs[0];
}, 'render');
const outDoc = await api.get(`/documents/${out.id}`);
for (const real of ['Tremblay', '662-1934', 'H7N 2K4', '046 454 286', 'jf.tremblay', '14 mars 1981']) assert(!outDoc.text.includes(real), 'leaked ' + real);
await report('anonymized ok: ' + outDoc.text.split('\n')[3]);

// An outside rewrite using the fakes comes back with the real values.
const { entities } = await api.get(`/projects/${pid}/entities`);
const fake = (real) => entities.find((e) => e.real === real).fake;
const outside = `Hello ${fake('Jean-François Tremblay')}, please call ${fake('(450) 662-1934')}.`;
const r = await api.post('/restore', { text: outside, suggest: false });
await api.post(`/documents/${r.id}/render`);
const restoredOut = await waitFor(async () => {
  const d = await api.get(`/documents/${r.id}`);
  return d.outputs[0];
}, 'restore render');
const restored = await api.get(`/documents/${restoredOut.id}`);
await report('restored: ' + restored.text);
assert(restored.text === 'Hello Jean-François Tremblay, please call (450) 662-1934.', 'restore roundtrip');

if (web) {
  // The cron: nothing parked, nothing stuck; the processor and the engine answer.
  const det = await api.get('/settings/detection');
  await report('detector ' + det.detector.engine + ', remote PC ' + (det.status?.local.online ? 'on' : 'off') + ', ' + det.waiting + ' waiting');
  assert((await window.__e2eScheduled()) === 200, 'cron ran');
  assert((await api.get('/projects')).projects.length === 1, 'one project');
  await report('DONE');
  // The scripts run inside an async function (e2e.rs, web/e2e/run.mjs): the web stops here.
  return;
}

// Lock, wrong password, right password.
await native.vaultLock();
assert((await native.appStatus()).vault === 'locked', 'locked');
let wrong = '';
try {
  await native.vaultUnlock('not the password');
} catch (e) {
  wrong = String(e);
}
assert(wrong === 'wrong_password', 'wrong password refused: ' + wrong);
await native.vaultUnlock('correct horse battery');
const again = await api.get('/projects');
assert(again.projects.length === 1, 'data back after unlock');
await report('lock/unlock ok');

const sys = await native.systemInfo();
await report(`system ${sys.ramGb} GB ${sys.arch} ${sys.osVersion}`);
const st = await native.sidecarStatus();
await report('engine ' + (st.engine ? 'up' : 'down: ' + st.engineError));
await report('DONE');
