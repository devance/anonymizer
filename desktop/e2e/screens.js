// Every screen of the app, for design reviews, in both themes:
//   desktop/e2e/shots.sh desktop/e2e/screens.js desktop/e2e/screens --keep-data /tmp/anon-screens
// Starts from a fresh data folder: goes through first launch by clicking, seeds a project in basic
// mode (no model), then visits each page. States the app can't reach without the document engine
// or a model (analyzing, waiting, a PDF password, a model download) are shown with stubbed
// answers; everything else is real. Then screens-lock.js reuses the data folder for the lock screen.
// SCREENS_LANG / SCREENS_THEMES below pick the language and themes.
const SCREENS_LANG = 'fr';
const SCREENS_THEMES = ['light', 'dark'];

const { api, navigate, target } = window.__anon;
// The web target (node web/e2e/run.mjs screens.js --shots dir) has no first launch; it adds members and the CLI sign-in.
const web = target === 'web';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
async function waitFor(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out: ' + what);
    await sleep(150);
  }
}
const button = (text) => $$('button').find((b) => b.textContent.trim().includes(text));
function fill(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

// The page's own preferences outlive this run (same WebView storage as the real app): put them back.
const saved = Object.fromEntries(['anon:theme', 'anon:lang', 'anon:lastProject'].map((k) => [k, localStorage.getItem(k)]));
function restorePrefs() {
  for (const [k, v] of Object.entries(saved)) v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
}

const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
async function theme(want) {
  if (isDark() !== (want === 'dark')) $('.theme-switch').click();
  await sleep(350);
}
async function lang(want) {
  const b = $(`.lang button[lang="${want}"]`);
  if (b && b.getAttribute('aria-pressed') !== 'true') b.click();
  await sleep(200);
}

/** One screenshot per theme; `settle` waits for entrance animations first. */
async function shot(name, settle = 900) {
  await sleep(settle);
  for (const th of SCREENS_THEMES) {
    await theme(th);
    await report(`SHOT ${name}-${th}`);
    await sleep(1100);
  }
}

// Stubbed answers for states that need the engine or a model.
const realGet = api.get;
const stubs = new Map();
api.get = (path) => (stubs.has(path) ? Promise.resolve(structuredClone(stubs.get(path))) : realGet(path));
const { native } = window.__anon;
if (!web) native.modelDownload = async (id, onProgress) => {
  const total = (await native.modelCatalog()).find((m) => m.id === id)?.totalSize ?? 4e9;
  onProgress({ received: total * 0.38, total, bytesPerSec: 41.5e6, phase: 'downloading' });
  return new Promise(() => {});
};

try {
  if (web) {
    await waitFor(() => $('.topbar'), 'app');
    await lang(SCREENS_LANG);
  } else {
    // ---------- First launch ----------
    await waitFor(() => $('.onb'), 'onboarding');
    await lang(SCREENS_LANG);
    await shot('01-welcome', 1800);

    button(SCREENS_LANG === 'fr' ? 'Commencer' : 'Get started').click();
    await waitFor(() => $('.facts'), 'local step');
    await shot('02-local');

    $('.onb-step .actions button').click();
    await waitFor(() => $('.onb-step input[type=password]'), 'password step');
    const [pw, again] = $$('.onb-step input[type=password]');
    fill(pw, 'correct horse battery');
    fill(again, 'correct horse battery');
    $$('.onb-step input[type=checkbox]')[0].click();
    await sleep(200);
    document.activeElement?.blur();
    await shot('03-password');

    $('.onb-step .actions button').click();
    await waitFor(() => $('.models .model'), 'model step', 60000);
    await sleep(400);
    // A download in progress on the suggested model.
    const download = $$('.model-actions button').find((b) => /Télécharger|Download/.test(b.textContent));
    download?.click();
    await sleep(300);
    await shot('04-model');

    $('.onb-step .actions button').click();
    await waitFor(() => $('.onb-step h1') && /prêt|set/i.test($('.onb-step h1').textContent), 'ready step');
    await shot('05-ready');

    $('.onb-step .actions button').click();
    await waitFor(() => $('.topbar'), 'app');
  }

  // ---------- Seed: basic mode, three projects, a real document ----------
  await api.put('/settings/detection', { engine: 'none' });
  await api.post('/profile', { type: 'person', text: 'Jean-François Tremblay' });
  await api.post('/profile', { type: 'address', text: '1842, rue des Érables, app. 3, Laval (Québec)' });
  const { id: p2 } = await api.post('/projects', { name: 'Succession Bélanger' });
  const { id: p3 } = await api.post('/projects', { name: 'Refinancement Côté' });
  const { id: pid } = await api.post('/projects', { name: 'Achat Sainte-Adèle' });
  void p2;
  void p3;
  await api.post(`/projects/${pid}/entities`, { type: 'person', text: 'Isabelle Gagné' });
  await api.post(`/projects/${pid}/entities`, { type: 'address', text: '27, chemin du Lac-Brûlé, Sainte-Adèle (Québec)' });
  await api.post(`/projects/${pid}/entities`, { type: 'organization', text: 'Desjardins Sécurité financière' });
  const LETTER = `Groupe hypothécaire Laurentides
Demande de financement hypothécaire

Emprunteur : M. Jean-François Tremblay
Coemprunteuse : Mme Isabelle Gagné
Adresse actuelle : 1842, rue des Érables, app. 3, Laval (Québec) H7N 2K4
Téléphone : (450) 662-1934
Courriel : jf.tremblay@videotron.example
Date de naissance : 14 mars 1981
NAS : 046 454 286

Propriété visée : 27, chemin du Lac-Brûlé, Sainte-Adèle (Québec) J8B 1R3
Prix d'achat : 485 000 $
Mise de fonds : 97 000 $

Employeur : Desjardins Sécurité financière, depuis 2014
Revenu annuel brut : 92 400 $

M. Tremblay souhaite signer chez le notaire avant le 1er juillet. Mme Gagné fournira ses deux derniers avis de cotisation.`;
  const { id: did } = await api.post(`/projects/${pid}/documents`, { text: LETTER, filename: 'Demande-financement-Tremblay.txt' });
  await waitFor(async () => (await realGet(`/documents/${did}`)).document.status === 'needs_review', 'analysis');

  // ---------- Home (it loaded before the seed: come back to it) ----------
  navigate('/restore');
  await sleep(300);
  navigate('/');
  await waitFor(() => $('.project-link'), 'home');
  await shot('06-home');
  fill($('.composer textarea'), LETTER.split('\n').slice(0, 9).join('\n'));
  await sleep(200);
  document.activeElement?.blur();
  await shot('07-home-text', 300);
  fill($('.composer textarea'), '');

  // ---------- Review ----------
  navigate(`/doc/${did}`);
  await waitFor(() => $('mark.span'), 'review');
  await shot('08-review');
  const showRepl = $('.summary button[role=switch]');
  showRepl.click();
  await shot('09-review-replacements', 400);
  showRepl.click();
  // Selecting a missed value opens the popover that adds it.
  const first = $('.paper .doc-text').firstChild;
  const range = document.createRange();
  range.setStart(first, 'Groupe hypothécaire '.length);
  range.setEnd(first, 'Groupe hypothécaire Laurentides'.length);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  $('.paper').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  await waitFor(() => $('.popover'), 'popover');
  await shot('09b-review-select', 500);
  getSelection().removeAllRanges();
  $('.paper').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

  // ---------- Output ----------
  button(SCREENS_LANG === 'fr' ? 'Créer la copie anonymisée' : 'Create anonymized copy').click();
  await waitFor(() => location.hash.includes('/doc/') && !location.hash.endsWith(did) && $('.dv-notice.ok'), 'output', 60000);
  const outId = location.hash.split('/').pop();
  await shot('10-output');

  // ---------- Project: documents, values, delete dialog ----------
  navigate(`/p/${pid}`);
  await waitFor(() => $('.doc-row'), 'project');
  await shot('11-project');
  $$('.tabs-row [role=tab]')[1].click();
  await waitFor(() => $('table tbody tr'), 'values');
  await shot('12-values');
  if (web) {
    await api.post(`/projects/${pid}/members`, { email: 'notaire@example.org' });
    $$('.tabs-row [role=tab]')[2].click();
    await waitFor(() => $('.member-row'), 'members');
    await shot('12b-members');
  }
  $$('.tabs-row [role=tab]')[0].click();
  $('.dv-page-head button.danger').click();
  await waitFor(() => $('dialog[open]'), 'dialog');
  await shot('13-dialog', 700);
  $('dialog[open] button.ghost').click();
  await sleep(300);

  // ---------- Restore: the form, then the review of an outside text ----------
  navigate('/restore');
  await waitFor(() => $('.restore-options'), 'restore');
  const { entities } = await realGet(`/projects/${pid}/entities`);
  const fake = (real) => entities.find((e) => e.real === real)?.fake ?? real;
  const outside = `Bonjour ${fake('Jean-François Tremblay')},

Voici le résumé de votre dossier. La propriété du ${fake('27, chemin du Lac-Brûlé, Sainte-Adèle (Québec)')} respecte les critères du prêteur. Pour la suite, ${fake('Isabelle Gagné')} doit transmettre ses avis de cotisation, et nous vous joindrons au ${fake('(450) 662-1934')}.`;
  await shot('14-restore');
  fill($('.composer textarea'), outside);
  await sleep(200);
  document.activeElement?.blur();
  await shot('15-restore-text', 300);
  const { id: rid } = await api.post('/restore', { text: outside, suggest: false });
  navigate(`/doc/${rid}`);
  await waitFor(() => $('mark.span'), 'restore review');
  await shot('16-restore-review');

  // ---------- Settings, top to bottom ----------
  navigate('/settings');
  await waitFor(() => $('.models .model'), 'settings');
  await shot('17-settings');
  $$('.settings-section')[2].scrollIntoView({ block: 'start' });
  await shot('18-settings-models', 400);
  window.scrollTo(0, document.body.scrollHeight);
  await shot('19-settings-data', 400);
  window.scrollTo(0, 0);

  if (web) {
    // ---------- The page anon login opens ----------
    navigate(`/cli/authorize?port=53682&state=${'s'.repeat(24)}&code_challenge=${'A'.repeat(43)}&label=anon%20on%20laptop`);
    await waitFor(() => $('.cli-card'), 'cli authorize');
    await shot('19b-cli-authorize');
  }

  // ---------- Stubbed states ----------
  const base = await realGet(`/documents/${did}`);
  const stub = (id, document, extra = {}) =>
    stubs.set(`/documents/${id}`, { ...base, ...extra, document: { ...base.document, id, filename: 'Releve-hypothecaire-2025.pdf', mime: 'application/pdf', ...document } });
  stub('analyzing', { status: 'analyzing' }, { progress: 'detect', matches: [] });
  stub('waiting', { status: 'waiting' }, { matches: [] });
  stub('password', { status: 'failed', error: 'password_required' }, { matches: [] });
  navigate('/doc/analyzing');
  await waitFor(() => $('.phases'), 'analyzing');
  await shot('20-analyzing');
  navigate('/doc/waiting');
  await waitFor(() => $('.state-icon'), 'waiting');
  await shot('21-waiting');
  navigate('/doc/password');
  await waitFor(() => $('.state-icon'), 'password');
  document.activeElement?.blur();
  await shot('22-pdf-password');
  // An output where the check found real values left (one was skipped in review).
  const out = await realGet(`/documents/${outId}`);
  stubs.set('/documents/leaky', {
    ...out,
    document: { ...out.document, id: 'leaky' },
    steps: { ...out.steps, verify: { ...out.steps.verify, leaks: [{ entityId: 'x', type: 'person', hits: 2, where: 'text' }] } },
  });
  navigate('/doc/leaky');
  await waitFor(() => $('.dv-notice.error'), 'leaks');
  await shot('10b-output-leaks');

  restorePrefs();
  await report('DONE');
} catch (e) {
  restorePrefs();
  await report('ERROR ' + e.message + ' | ' + document.body.innerText.slice(0, 300).replace(/\s+/g, ' '));
  throw e;
}
