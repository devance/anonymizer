// The lock screen, for design reviews. Run after screens.js, on the data folder it left:
//   desktop/e2e/shots.sh desktop/e2e/screens-lock.js desktop/e2e/screens --keep-data /tmp/anon-screens
// The app opens locked on that folder: the screen, a wrong password, the forgotten-password
// page, then the right password.
const SCREENS_LANG = 'fr';
const SCREENS_THEMES = ['light', 'dark'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel) => document.querySelector(sel);
async function waitFor(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out: ' + what);
    await sleep(150);
  }
}
function fill(el, value) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const saved = Object.fromEntries(['anon:theme', 'anon:lang'].map((k) => [k, localStorage.getItem(k)]));
function restorePrefs() {
  for (const [k, v] of Object.entries(saved)) v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
}
const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
async function theme(want) {
  if (isDark() !== (want === 'dark')) $('.theme-switch').click();
  await sleep(350);
}
async function shot(name, settle = 900) {
  await sleep(settle);
  for (const th of SCREENS_THEMES) {
    await theme(th);
    await report(`SHOT ${name}-${th}`);
    await sleep(1100);
  }
}

try {
  await waitFor(() => $('.lockscreen'), 'lock screen');
  const l = $(`.lang button[lang="${SCREENS_LANG}"]`);
  if (l.getAttribute('aria-pressed') !== 'true') l.click();
  await shot('23-lock', 1200);

  fill($('.lock-card input[type=password]'), 'pas le bon mot de passe');
  $('.lock-card button[type=submit]').click();
  await waitFor(() => $('.lock-card .dv-notice.error'), 'wrong password');
  await shot('24-lock-wrong', 400);

  $('.lock-card .forgot').click();
  await waitFor(() => $('.lock-card.reset'), 'forgot');
  document.activeElement?.blur();
  await shot('25-lock-forgot');
  $('.lock-card.reset button.ghost').click();

  await waitFor(() => $('.lock-card input[type=password]'), 'back to lock');
  fill($('.lock-card input[type=password]'), 'correct horse battery');
  $('.lock-card button[type=submit]').click();
  await waitFor(() => $('.topbar'), 'unlocked');
  restorePrefs();
  await report('DONE');
} catch (e) {
  restorePrefs();
  await report('ERROR ' + e.message);
  throw e;
}
