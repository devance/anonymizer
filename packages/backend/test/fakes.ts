import { DetectorOfflineError, type ModelClient } from '@anon/pipeline';

/**
 * Stand-ins for the document engine and the model, shared by the desktop's
 * tests (Node) and the web's (workerd): "PDFs" are UTF-8 text with a header,
 * so the file pipeline (queueing, storage, fields, leak checks) runs without
 * Python. The real engine has its own tests in engine/tests, and the parity
 * check (web/e2e/parity.ts) runs both targets on the real one.
 */

const dec = new TextDecoder();
const enc = new TextEncoder();
async function sha(text: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const PDF_PASSWORD = 'hunter2';

export const engineCalls: string[] = [];
export const fakeEngine = {
  raster: [] as string[],
  fields: [{ id: 'link:0:0', text: 'mailto:jf.tremblay@videotron.example' }],
  /** What the engine's detection model finds: these strings, wherever they appear. */
  ner: [] as Array<{ text: string; type: string }>,
  nerDown: false,
};

export function resetFakes() {
  engineCalls.length = 0;
  fakeEngine.raster = [];
  fakeEngine.fields = [{ id: 'link:0:0', text: 'mailto:jf.tremblay@videotron.example' }];
  fakeEngine.ner = [];
  fakeEngine.nerDown = false;
  model.offline = false;
  model.unanswered = false;
  model.calls.length = 0;
  model.detect = { entities: [] };
  model.suggest = { spans: [] };
}

export async function fakeEngineFetch(path: string, init: RequestInit = {}): Promise<Response> {
  engineCalls.push(path);
  const bodyText = async () => dec.decode(new Uint8Array(await new Response(init.body).arrayBuffer()));
  if (path === '/health') return Response.json({ ok: true });
  // "%LOCK" files are password-protected PDFs (password "hunter2"); /ocr with the password hands back a decrypted copy.
  const locked = async () => (await bodyText()).startsWith('%LOCK') && new Headers(init.headers).get('x-password') !== PDF_PASSWORD;
  if (path === '/inspect') {
    if (await locked()) return Response.json({ detail: 'password required' }, { status: 423 });
    return Response.json({ kind: 'pdf', pages: 1, ocr: (await bodyText()).startsWith('%SCAN') ? 'scan' : 'none', pageKinds: ['text'] });
  }
  if (path === '/ocr') {
    if (await locked()) return Response.json({ detail: 'password required' }, { status: 423 });
    return new Response(enc.encode((await bodyText()).replace(/^%(SCAN|LOCK)/, '%PDF')));
  }
  if (path === '/extract') {
    const text = (await bodyText()).replace(/^%(PDF|SCAN)\n/, '');
    return Response.json({ text, sha256: await sha(text), fields: fakeEngine.fields });
  }
  if (path === '/rewrite') {
    const form = await new Request('http://engine/rewrite', { method: 'POST', body: init.body, headers: init.headers }).formData();
    const file = form.get('file') as File;
    const spec = JSON.parse(form.get('spec') as string) as { sha256: string; replacements: Array<{ start: number; end: number; text: string }>; fields: Array<{ id: string; text: string }> };
    const text = (await file.text()).replace(/^%PDF\n/, '');
    if ((await sha(text)) !== spec.sha256) return Response.json({ detail: 'stale' }, { status: 409 });
    let out = '';
    let at = 0;
    for (const r of spec.replacements) {
      out += text.slice(at, r.start) + r.text;
      at = r.end;
    }
    out += text.slice(at);
    fakeEngine.fields = fakeEngine.fields.map((f) => spec.fields.find((n) => n.id === f.id) ?? f);
    return new Response(enc.encode(`%PDF\n${out}`), { headers: { 'x-report': '{"replaced":1}' } });
  }
  if (path === '/ner') {
    if (fakeEngine.nerDown) return Response.json({ detail: 'detection model missing' }, { status: 503 });
    const text = await bodyText();
    const entities = fakeEngine.ner.flatMap((n) => [...text.matchAll(new RegExp(n.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].map((m) => ({ start: m.index!, end: m.index! + n.text.length, type: n.type })));
    return Response.json({ entities });
  }
  if (path === '/check') {
    const text = (await bodyText()).replace(/^%PDF\n/, '');
    return Response.json({ text, fields: fakeEngine.fields, raster: fakeEngine.raster.length ? fakeEngine.raster : [text], codes: {} });
  }
  return Response.json({ detail: 'unknown' }, { status: 404 });
}

export interface ModelCall {
  system: string;
  user: string;
}

/** Answers the model would give, keyed by which prompt is asking. */
export const model = {
  offline: false,
  /** The PC answers (its status says online) but every model call times out. */
  unanswered: false,
  calls: [] as ModelCall[],
  detect: { entities: [] as unknown[] } as unknown,
  suggest: { spans: [] as unknown[] } as unknown,
};

export function fakeModel(local = true): ModelClient {
  return {
    name: 'fake',
    local,
    maxChunkChars: 40_000,
    maxAnswerTokens: 16_384,
    async structured<T>(system: string, user: string) {
      if (model.offline) throw new DetectorOfflineError('ECONNREFUSED');
      if (model.unanswered) throw new DetectorOfflineError('the PC stopped answering');
      model.calls.push({ system, user });
      const data = system.includes('anonymized by replacing') ? model.suggest : model.detect;
      if (typeof data === 'string') throw new Error('the model returned something unusable');
      return { data: data as T, usage: { input_tokens: 1000, output_tokens: 200 } };
    },
  };
}
