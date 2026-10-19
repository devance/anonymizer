// The desktop app's screens, headless: no app window, nothing on the screen. The UI runs in
// headless Chromium from a Vite dev server this script starts, with the Tauri side mocked:
// SQLite (node:sqlite, the app's migrations) and the blob store in this process, a stand-in
// engine, a fixed clock and seeded randomness, so two runs give the same pixels. It drives
// screens.js and screens-lock.js (the same scripts as shots.sh) in French and English, at
// 1366x900 and 1024x700, light and dark, saving <lang>-<size>-<name>.png (and -full.png).
//
//   node desktop/e2e/headless.mjs <out-dir> [fr en]
//   REPO=/path/to/other/checkout node desktop/e2e/headless.mjs <out-dir>   that checkout's UI and scripts
//   SIZES=desk|min   one size;  STYLES=1   computed styles as JSON instead of PNGs
//   node desktop/e2e/headless.mjs --script files.js [out-dir]   one e2e script (smoke, files, pdf-ui),
//                    with the real engine (python -m engine.desktop) behind the mocked IPC
//
// Compare two runs with desktop/e2e/compare.mjs. Settle times are the scripts' own.
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every element's box and computed style, keyed by its path in the DOM (same in both versions).
function dumpStyles() {
  const path = (e) => {
    const parts = [];
    for (; e && e !== document.documentElement; e = e.parentElement) parts.unshift(e.tagName.toLowerCase() + ':' + [...e.parentElement.children].indexOf(e));
    return parts.join('/');
  };
  const out = {};
  for (const el of [document.documentElement, ...document.querySelectorAll('body, body *')]) {
    const cs = getComputedStyle(el);
    const st = {};
    for (let i = 0; i < cs.length; i++) {
      const k = cs[i];
      if (k.startsWith('--')) continue;
      st[k] = cs.getPropertyValue(k);
    }
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content && ps.content !== 'none') for (let i = 0; i < ps.length; i++) if (!ps[i].startsWith('--')) st[pseudo + ps[i]] = ps.getPropertyValue(ps[i]);
    }
    const r = el.getBoundingClientRect();
    out[path(el) || 'html'] = { cls: el.getAttribute('class') ?? '', rect: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100).join(','), st };
  }
  return out;
}

const REPO = resolve(process.env.REPO ?? join(dirname(fileURLToPath(import.meta.url)), '../..'));
// --script name.js: run one e2e script (smoke.js, files.js, pdf-ui.js...) instead of the screens,
// with the real engine (engine/.venv, python -m engine.desktop) behind the mocked IPC.
const scriptAt = process.argv.indexOf('--script');
const SCRIPT = scriptAt > 0 ? process.argv.splice(scriptAt, 2)[1] : null;
const out = process.argv[2] ?? (SCRIPT ? null : undefined);
if (out === undefined) {
  console.error('usage: node desktop/e2e/headless.mjs <out-dir> [fr en]\n       node desktop/e2e/headless.mjs --script files.js [out-dir]');
  process.exit(2);
}

// The UI's dev server (the e2e hooks, window.__anon, only exist in dev builds).
const port = await new Promise((res) => {
  const srv = createServer();
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => res(port));
  });
});
const vite = spawn(join(REPO, 'node_modules/.bin/vite'), ['--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: join(REPO, 'ui'), stdio: ['ignore', 'pipe', 'pipe'] });
process.on('exit', () => vite.kill('SIGTERM'));
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
  } catch {
    /* starting */
  }
  if (i > 600 || vite.exitCode !== null) throw new Error('the UI dev server did not start');
  await new Promise((r) => setTimeout(r, 100));
}
const BASE = `http://127.0.0.1:${port}/`;
const langs = process.argv.length > 3 ? process.argv.slice(3) : ['fr', 'en'];
const ALL_SIZES = { desk: [1366, 900], min: [1024, 700] };
const sizes = process.env.SIZES ? Object.fromEntries(process.env.SIZES.split(',').map((k) => [k, ALL_SIZES[k]])) : ALL_SIZES;
const catalog = JSON.parse(readFileSync(`${REPO}/desktop/src-tauri/resources/models.json`, 'utf8')).models;
const FIXED = new Date('2026-10-14T14:32:00-04:00');
// SQLite's clock is this process's: pin it to the page's fixed time too.
const pin = (sql) => sql.replaceAll('unixepoch()', String(FIXED.getTime() / 1000));
const migDir = `${REPO}/packages/backend/migrations`;
const migrations = (await import('node:fs')).readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort().map((f) => pin(readFileSync(`${migDir}/${f}`, 'utf8')));

function backend() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const m of migrations) raw.exec(m);
  const conv = (ps = []) => ps.map((p) => (typeof p === 'boolean' ? Number(p) : p === null || typeof p !== 'object' ? p : JSON.stringify(p)));
  const blobs = new Map();
  let n = 0;
  const state = { vault: 'new' };
  return {
    state,
    db(cmd, a) {
      if (cmd === 'db_all') return raw.prepare(pin(a.sql)).all(...conv(a.params));
      if (cmd === 'db_run') return { changes: Number(raw.prepare(pin(a.sql)).run(...conv(a.params)).changes) };
      if (cmd === 'db_batch') {
        raw.exec('BEGIN');
        try {
          for (const s of a.stmts) raw.prepare(pin(s.sql)).run(...conv(s.params));
          raw.exec('COMMIT');
        } catch (e) {
          raw.exec('ROLLBACK');
          throw e;
        }
        return null;
      }
      if (cmd === 'blob_put') {
        const id = a.kind + String(++n).padStart(8, '0');
        blobs.set(id, a.b64);
        return id;
      }
      if (cmd === 'blob_get') {
        if (!blobs.has(a.id)) throw new Error('blob missing');
        return blobs.get(a.id);
      }
      if (cmd === 'blob_delete') {
        for (const id of a.ids) blobs.delete(id);
        return null;
      }
      throw new Error('unknown ' + cmd);
    },
  };
}

// Runs in the page before the app: the Tauri IPC, seeded randomness.
function mock({ catalog }) {
  let seed = 0x2f6b1c3d;
  const rnd = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Math.random = rnd;
  crypto.getRandomValues = (arr) => {
    const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    for (let i = 0; i < u8.length; i++) u8[i] = Math.floor(rnd() * 256);
    return arr;
  };
  crypto.randomUUID = () => {
    const h = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };

  const b64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const callbacks = new Map();
  let nextId = 1;
  const send = (channel, message, index) => callbacks.get(Number(String(channel).split(':')[1]))?.({ message, index });

  const models = catalog.map((m) => {
    const total = m.size + (m.draft ? m.draft.size : 0);
    const { draft, urls, sha256, ...rest } = m;
    return { suggestRamGb: null, ...rest, available: true, installed: false, complete: false, totalSize: total, partialBytes: 0, downloading: false };
  });

  // The engine: health, and a detection model that finds nothing (the rules still run).
  function engine(req, body) {
    const json = (status, obj) => {
      const meta = enc.encode(JSON.stringify({ status, headers: { 'content-type': 'application/json' } }));
      const payload = enc.encode(JSON.stringify(obj));
      const outb = new Uint8Array(4 + meta.length + payload.length);
      new DataView(outb.buffer).setUint32(0, meta.length, true);
      outb.set(meta, 4);
      outb.set(payload, 4 + meta.length);
      return outb.buffer;
    };
    if (req.path === '/health') return json(200, { ok: true });
    if (req.path === '/ner') return json(200, { entities: [] });
    void body;
    return json(404, { detail: 'unknown' });
  }

  async function invoke(cmd, args, options) {
    switch (cmd) {
      case 'app_status':
      case 'vault_create':
      case 'vault_unlock':
      case 'vault_lock':
      case 'vault_auto_unlock':
      {
        const r = await window.__vault(cmd, args && !(args instanceof Uint8Array) ? args : {});
        if (r && r.error) throw r.error;
        return r ?? null;
      }
      case 'db_all':
      case 'db_run':
      case 'db_batch':
      case 'blob_delete':
        return window.__backend(cmd, args);
      case 'blob_put':
        return window.__backend(cmd, { kind: options.headers['x-kind'], b64: b64(args) });
      case 'blob_get':
        return unb64(await window.__backend(cmd, args)).buffer;
      case 'model_catalog':
        return structuredClone(models);
      case 'system_info':
        return { ramGb: 32, os: 'macos', osVersion: '15.5', arch: 'aarch64', cpu: 'Apple M1 Max' };
      case 'sidecar_status':
        return { engine: true, engineError: null, llama: false, llamaModel: null, llamaError: null };
      case 'config_get':
        return { ollamaBase: null };
      case 'local_http':
        if (window.__engineHttp) return unb64(await window.__engineHttp(options.headers['x-anon-req'], b64(args instanceof Uint8Array ? args : new Uint8Array()))).buffer;
        return engine(JSON.parse(options.headers['x-anon-req']), args);
      case 'e2e_fixture':
        return unb64(await window.__fixture(args.name)).buffer;
      case 'local_http_stream':
      case 'llama_start':
        throw 'sidecar_down';
      case 'model_download':
        return new Promise(() => {});
      default:
        return null;
    }
  }

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(cb, once) {
      const id = nextId++;
      callbacks.set(id, (m) => {
        if (once) callbacks.delete(id);
        cb(m);
      });
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    convertFileSrc: (p) => p,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    plugins: {},
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  void send;
}

// Same pixels run after run: one raster thread, no GPU, no partial or async raster.
const browser = await chromium.launch({
  args: ['--disable-gpu', '--disable-gpu-rasterization', '--disable-partial-raster', '--num-raster-threads=1', '--disable-checker-imaging', '--disable-threaded-animation', '--disable-threaded-scrolling', '--force-color-profile=srgb', '--disable-lcd-text', '--deterministic-mode'],
});
if (out) mkdirSync(out, { recursive: true });

if (SCRIPT) {
  // The engine as the app runs it: a sidecar on a random port with a per-launch token.
  const { randomBytes } = await import('node:crypto');
  const token = randomBytes(24).toString('hex');
  const eng = spawn(join(REPO, 'engine/.venv/bin/python'), ['-m', 'engine.desktop'], { cwd: join(REPO, 'engine'), env: { ...process.env, ANON_ENGINE_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
  process.on('exit', () => eng.kill('SIGTERM'));
  eng.stderr.on('data', (d) => process.env.WATCH && process.stderr.write(d));
  const enginePort = await new Promise((res, rej) => {
    let buf = '';
    eng.stdout.on('data', (d) => {
      buf += d;
      const m = /ANON_ENGINE_PORT=(\d+)/.exec(buf);
      if (m) res(Number(m[1]));
    });
    eng.on('exit', (c) => rej(new Error(`engine exited ${c}`)));
  });
  const be = backend();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
  await ctx.addInitScript(mock, { catalog });
  await ctx.exposeFunction('__backend', (cmd, args) => be.db(cmd, args));
  // The vault as Rust keeps it (the keys themselves are Rust's, tested with cargo test).
  await ctx.exposeFunction('__vault', (cmd, args) => {
    if (cmd === 'app_status') return { vault: be.state.vault, autoUnlock: false, version: '0.4.0', dataDir: '/tmp/anon', logDir: '/tmp/anon/logs' };
    if (cmd === 'vault_create') return void ((be.state.password = args.password), (be.state.vault = 'unlocked'));
    if (cmd === 'vault_unlock') {
      if (args.password !== be.state.password) return { error: 'wrong_password' };
      return void (be.state.vault = 'unlocked');
    }
    if (cmd === 'vault_auto_unlock') return false;
    if (cmd === 'vault_lock') return void (be.state.vault = 'locked');
  });
  // local_http as Rust does it: the request to the engine with its token, the answer framed.
  await ctx.exposeFunction('__engineHttp', async (reqJson, bodyB64) => {
    const req = JSON.parse(reqJson);
    const body = Buffer.from(bodyB64, 'base64');
    const res = await fetch(`http://127.0.0.1:${enginePort}${req.path}`, {
      method: req.method,
      headers: { ...(req.headers ?? {}), authorization: `Bearer ${token}` },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const payload = Buffer.from(await res.arrayBuffer());
    const meta = Buffer.from(JSON.stringify({ status: res.status, headers: Object.fromEntries(res.headers) }));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(meta.length);
    return Buffer.concat([len, meta, payload]).toString('base64');
  });
  await ctx.exposeFunction('__fixture', (name) => {
    if (name.includes('..') || name.startsWith('/')) throw new Error('bad name');
    return readFileSync(join(REPO, 'fixtures', name)).toString('base64');
  });
  let page;
  let result = null;
  await ctx.exposeFunction('__report', async (line) => {
    if (line.startsWith('SHOT ') && out) await page.screenshot({ path: `${out}/${line.slice(5)}.png` });
    console.log(`E2E ${line}`);
    if (line === 'DONE') result = 'DONE';
    else if (line.startsWith('FAIL')) result = line;
  });
  page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__anon, null, { timeout: 60000 });
  const code = readFileSync(existsSync(SCRIPT) ? SCRIPT : `${REPO}/desktop/e2e/${SCRIPT}`, 'utf8');
  await page.evaluate(`(async () => { const report = (line) => window.__report(String(line)); try { ${code}\n } catch (e) { await report('FAIL ' + e + (e && e.stack ? ' @ ' + e.stack : '')); } })()`).catch((e) => (result ??= `FAIL ${e.message}`));
  await browser.close();
  vite.kill('SIGTERM');
  eng.kill('SIGTERM');
  if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(' | ')}`);
  console.log(result === 'DONE' ? `headless ${SCRIPT} ok` : `headless ${SCRIPT} failed: ${result ?? 'no DONE'}`);
  process.exit(result === 'DONE' ? 0 : 1);
}

async function run(page, file, lang, shotPrefix) {
  let script = readFileSync(`${REPO}/desktop/e2e/${file}`, 'utf8').replace("const SCREENS_LANG = 'fr';", `const SCREENS_LANG = '${lang}';`);
  const result = await page.evaluate(
    `(async () => { const report = (line) => window.__report(String(line)); try { ${script}\n } catch (e) { await report('FAIL ' + e + (e && e.stack ? ' @ ' + e.stack : '')); } })()`,
  );
  void result;
  void shotPrefix;
}

const combos = langs.flatMap((lang) => Object.entries(sizes).map(([sn, size]) => [lang, sn, size]));
await Promise.all(combos.map(async ([lang, sn, [w, h]]) => {
  {
    const be = backend();
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: process.env.MOTION ? 'no-preference' : 'reduce' });
    await ctx.addInitScript(mock, { catalog });
    await ctx.exposeFunction('__backend', (cmd, args) => be.db(cmd, args));
    await ctx.exposeFunction('__vault', (cmd, args) => {
      const s = be.state;
      if (cmd === 'app_status') return { vault: s.vault, autoUnlock: false, version: '0.4.0', dataDir: '/Users/marie/Library/Application Support/ca.devance.anonymizer', logDir: '/Users/marie/.devance/logs' };
      if (cmd === 'vault_create') return void (s.vault = 'unlocked');
      if (cmd === 'vault_auto_unlock') return false;
      if (cmd === 'vault_lock') return void (s.vault = 'locked');
      if (cmd === 'vault_unlock') {
        if (args.password !== 'correct horse battery') return { error: 'wrong_password' };
        s.vault = 'unlocked';
        return null;
      }
    });
    let page;
    const log = [];
    // The page's clock is frozen, so the script's own timeouts never fire: give up on a stall.
    let last = Date.now();
    const dog = setInterval(() => {
      if (Date.now() - last < 120000) return;
      console.log('STALLED', lang, sn, 'after', log.at(-1));
      clearInterval(dog);
      void ctx.close();
    }, 5000);
    await ctx.exposeFunction('__report', async (line) => {
      log.push(line);
      last = Date.now();
      if (process.env.WATCH) console.log('report', lang, sn, line);
      if (line.startsWith('SHOT ')) {
        const name = `${lang}-${sn}-${line.slice(5)}`;
        await Promise.race([page.evaluate(() => document.fonts.ready), new Promise((r) => setTimeout(r, 5000))]);
        if (process.env.STYLES) {
          const dump = await page.evaluate(dumpStyles);
          writeFileSync(`${out}/${name}.json`, JSON.stringify(dump));
          return;
        }
        if (process.env.WATCH) console.log('fonts ok', name);
        try {
          // A full-page capture resizes the viewport, which can move the scroll: put it back after.
          const at = await page.evaluate(() => [window.scrollX, window.scrollY]);
          await page.screenshot({ path: `${out}/${name}.png`, animations: 'disabled', timeout: 20000 });
          await page.screenshot({ path: `${out}/${name}-full.png`, fullPage: true, animations: 'disabled', timeout: 20000 });
          await page.evaluate(([x, y]) => new Promise((r) => (window.scrollTo(x, y), requestAnimationFrame(() => requestAnimationFrame(r)))), at);
        } catch (e) {
          console.log('SHOT FAILED', name, e.message.split('\n')[0]);
        }
      } else console.log(`${lang} ${sn}: ${line}`);
    });
    await ctx.clock.setFixedTime(FIXED);
    page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    page.on('console', (m) => m.type() === 'error' && console.log('console', m.text().slice(0, 300)));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const watch = process.env.WATCH && setInterval(async () => {
      const t = Date.now();
      const st = await Promise.race([page.evaluate(() => location.hash + ' | ' + [...document.querySelectorAll('[class*=notice]')].map((e) => e.outerHTML.slice(0, 120)).join(' ## ')), new Promise((r) => setTimeout(() => r('EVAL HUNG'), 5000))]);
      console.log('watch', lang, sn, st);
    }, 15000);
    await run(page, 'screens.js', lang);
    clearInterval(watch);
    // The lock screen: the same data, opened locked.
    be.state.vault = 'locked';
    page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await run(page, 'screens-lock.js', lang);
    clearInterval(dog);
    await ctx.close().catch(() => {});
  }
}).map((p) => p.catch((e) => console.log('combo failed', e.message.split('\n')[0]))));
await browser.close();
vite.kill('SIGTERM');
console.log('done', out);
process.exit(0);
