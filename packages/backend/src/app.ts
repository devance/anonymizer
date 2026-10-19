import { ENTITY_TYPES, mergeDetections, toValue, valueKey, type EntityType } from '@anon/core';
import { isEngineMime, NoKnownFakesError, PasswordRequiredError } from '@anon/pipeline';
import { Hono, type Context, type Env } from 'hono';
import { isTextMime } from './compute';
import { cleanDetector, isDetector } from './detector';
import { newId, profileCandidates, updateEntity, upsertCandidates } from './entities';
import { errorText } from './log';
import type { BlobOwner, DocRow, Review, Scope } from './platform';
import { deleteDocs, NoProjectsError, resumeWaiting, reviewPayload, seedProfile, startRestore } from './service';

const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 60 * 1024 * 1024;

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const EXT_MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  pdf: PDF,
  docx: DOCX,
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

function isEntityType(t: unknown): t is EntityType {
  return typeof t === 'string' && (ENTITY_TYPES as readonly string[]).includes(t);
}

interface Input {
  text?: string;
  file?: Uint8Array<ArrayBuffer>;
  filename: string;
  mime: string;
  extra: Record<string, unknown>;
}

/**
 * A JSON body ({ text, filename }) or a file: .txt/.md, PDF, Word or a photo.
 * Browsers label HEIC and some PDFs as octet-stream, so the extension decides.
 */
async function readInput(c: Context): Promise<Input | Response> {
  const type = c.req.header('content-type') ?? '';
  if (type.startsWith('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return c.json({ error: 'missing file' }, 400);
    const name = file.name || 'document.txt';
    const mime = EXT_MIME[name.toLowerCase().split('.').pop() ?? ''] ?? file.type;
    if (!isTextMime(mime) && !isEngineMime(mime)) return c.json({ error: 'unsupported_file' }, 415);
    if (file.size > (isTextMime(mime) ? MAX_TEXT_BYTES : MAX_FILE_BYTES)) return c.json({ error: 'file_too_large' }, 413);
    const extra: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) if (typeof v === 'string') extra[k] = v;
    if (isTextMime(mime)) return { text: await file.text(), filename: name, mime, extra };
    return { file: new Uint8Array(await file.arrayBuffer()), filename: name, mime, extra };
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body.text !== 'string' || !body.text.trim()) return c.json({ error: 'missing text' }, 400);
  if (body.text.length > MAX_TEXT_BYTES) return c.json({ error: 'file_too_large' }, 413);
  const filename = typeof body.filename === 'string' && body.filename.trim() ? body.filename.trim() : 'texte-colle.txt';
  return { text: body.text, filename, mime: filename.endsWith('.md') ? 'text/markdown' : 'text/plain', extra: body };
}

const passwordOf = (extra: Record<string, unknown>) => (typeof extra.password === 'string' && extra.password ? extra.password : undefined);

function ownerOf(doc: DocRow, which: 'file' | 'work'): BlobOwner {
  return { projectId: doc.project_id, docId: doc.id, sealed: which === 'work' || doc.file_sealed };
}

export interface ApiOptions<E extends Env> {
  /** The scope of a request: who is asking, and the target's store, blobs and compute. */
  scope: (c: Context<E>) => Scope | Promise<Scope>;
  /** Error messages in 500 answers. The desktop shows them; the web says "internal error". */
  exposeErrors: boolean;
}

/**
 * The API both targets serve: in the desktop page through app.request(), on
 * the web through the Worker (under /api for the browser, /cli/v1 for the CLI).
 * Anything that depends on where it runs comes from the Scope.
 */
export function createApi<E extends Env = Env>(opts: ApiOptions<E>) {
  const api = new Hono<E>();
  const scope = (c: Context<E>) => opts.scope(c);

  api.onError((err, c) => {
    // Messages only: never document content.
    console.error(`${c.req.method} ${c.req.path}: ${errorText(err)}`);
    return c.json({ error: opts.exposeErrors && err instanceof Error ? err.message : 'internal error' }, 500);
  });

  async function docOf(c: Context<E>): Promise<{ s: Scope; doc: DocRow } | null> {
    const s = await scope(c);
    const doc = await s.store.getDoc(c.req.param('id')!);
    return doc ? { s, doc } : null;
  }

  // ---- settings ----

  api.get('/settings/detection', async (c) => {
    const s = await scope(c);
    const [detector, waiting, status] = await Promise.all([s.store.getDetector(), s.store.countWaiting(), s.compute.status?.().catch(() => null) ?? Promise.resolve(undefined)]);
    return c.json({ detector, waiting, admin: s.account.admin, engines: s.account.engines, ...(status !== undefined ? { status } : {}) });
  });

  api.put('/settings/detection', async (c) => {
    const s = await scope(c);
    if (!s.account.admin) return c.json({ error: 'forbidden' }, 403);
    const body = await c.req.json().catch(() => null);
    if (!isDetector(body, s.account.engines)) return c.json({ error: 'invalid detector' }, 400);
    await s.store.setDetector(cleanDetector(body));
    // Documents that waited for a model may be able to go now.
    await resumeWaiting(s);
    return c.json({ ok: true });
  });

  // ---- projects ----

  api.get('/projects', async (c) => c.json({ projects: await (await scope(c)).store.listProjects() }));

  api.post('/projects', async (c) => {
    const s = await scope(c);
    const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
    const name = body.name?.trim();
    if (!name) return c.json({ error: 'missing name' }, 400);
    const id = await s.store.createProject(name.slice(0, 200));
    // The user's own details are caught in every document from the start.
    await seedProfile(s, id);
    return c.json({ id }, 201);
  });

  api.get('/projects/:pid', async (c) => {
    const s = await scope(c);
    const project = await s.store.getProject(c.req.param('pid'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const docs = await s.store.listDocs(project.id);
    return c.json({
      project: { id: project.id, name: project.name, createdAt: project.created_at, role: project.role },
      documents: docs.map((d) => ({
        id: d.id,
        kind: d.kind,
        parentId: d.parent_id,
        filename: d.filename,
        outName: d.out_name,
        mime: d.mime,
        status: d.status,
        error: d.error,
        createdAt: d.created_at,
        progress: s.progress.get(d),
      })),
    });
  });

  api.patch('/projects/:pid', async (c) => {
    const s = await scope(c);
    const project = await s.store.getProject(c.req.param('pid'));
    if (!project || project.role !== 'owner') return c.json({ error: 'not found' }, 404);
    const { name } = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
    if (!name?.trim()) return c.json({ error: 'missing name' }, 400);
    await s.store.renameProject(project.id, name.trim().slice(0, 200));
    return c.json({ ok: true });
  });

  api.delete('/projects/:pid', async (c) => {
    const s = await scope(c);
    const project = await s.store.getProject(c.req.param('pid'));
    if (!project || project.role !== 'owner') return c.json({ error: 'not found' }, 404);
    const roots = (await s.store.listDocs(project.id)).filter((d) => d.parent_id === null);
    await deleteDocs(s, roots.map((d) => d.id));
    await s.store.deleteProject(project.id);
    return c.json({ ok: true });
  });

  // ---- entities ----

  api.get('/projects/:pid/entities', async (c) => {
    const s = await scope(c);
    const project = await s.store.getProject(c.req.param('pid'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const entities = await s.store.loadEntities([project.id]);
    return c.json({
      entities: entities.map((e) => ({
        id: e.id,
        type: e.type,
        real: e.real.text,
        fake: e.fake.text,
        aliases: (e.aliases ?? []).map((a) => a.text),
        surfaces: e.surfaces ?? [],
        enabled: e.enabled,
        frozen: e.frozen,
      })),
    });
  });

  /** Add a value the detectors missed. */
  api.post('/projects/:pid/entities', async (c) => {
    const s = await scope(c);
    const project = await s.store.getProject(c.req.param('pid'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const { type, text } = await c.req.json<{ type?: string; text?: string }>().catch(() => ({}) as { type?: string; text?: string });
    if (!isEntityType(type) || !text?.trim()) return c.json({ error: 'invalid entity' }, 400);
    const before = new Set((await s.store.loadEntities([project.id])).map((e) => e.id));
    const cands = mergeDetections([{ type, text: text.trim(), source: 'manual' }]);
    const after = await upsertCandidates(s.store, project.id, cands);
    const created = after.find((e) => !before.has(e.id)) ?? after.find((e) => e.type === type && valueKey(type, e.real) === cands[0]?.key);
    if (created && !created.enabled) await updateEntity(s.store, project.id, created.id, { enabled: true });
    return c.json({ id: created?.id }, 201);
  });

  api.patch('/projects/:pid/entities/:eid', async (c) => {
    const s = await scope(c);
    const project = await s.store.getProject(c.req.param('pid'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json<{ enabled?: boolean; fake?: string }>().catch(() => ({}) as { enabled?: boolean; fake?: string });
    const r = await updateEntity(s.store, project.id, c.req.param('eid'), { enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined, fakeText: typeof body.fake === 'string' ? body.fake : undefined });
    if (r === 'fake_is_real') return c.json({ error: 'fake_is_real' }, 409);
    return r === 'ok' ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  api.delete('/projects/:pid/entities/:eid', async (c) => {
    const s = await scope(c);
    const project = await s.store.getProject(c.req.param('pid'));
    if (!project) return c.json({ error: 'not found' }, 404);
    await s.store.deleteEntity(project.id, c.req.param('eid'));
    return c.json({ ok: true });
  });

  // ---- documents ----

  /** Every analysis is queued: the UI goes straight to the document and follows its progress. */
  api.post('/projects/:pid/documents', async (c) => {
    const s = await scope(c);
    const project = await s.store.getProject(c.req.param('pid'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const input = await readInput(c);
    if (input instanceof Response) return input;
    const id = newId();
    const owner = { projectId: project.id, docId: id };
    const file = input.file ?? new TextEncoder().encode(input.text!);
    const fileKey = await s.blobs.put('f', file, owner);
    const textKey = input.file ? null : await s.blobs.put('t', new TextEncoder().encode(input.text!), owner);
    await s.store.insertDoc({ id, projectId: project.id, kind: 'source', filename: input.filename, mime: input.mime, size: file.length, fileKey, textKey, status: 'uploaded' });
    await s.queue.enqueue({ docId: id, projectId: project.id, kind: 'analyze', password: passwordOf(input.extra) });
    return c.json({ id, queued: true }, 202);
  });

  api.get('/documents/:id', async (c) => {
    const found = await docOf(c);
    if (!found) return c.json({ error: 'not found' }, 404);
    const { s, doc } = found;
    c.header('cache-control', 'no-store');
    return c.json({ ...(await reviewPayload(s, doc)), progress: s.progress.get(doc) });
  });

  api.post('/documents/:id/analyze', async (c) => {
    const found = await docOf(c);
    if (!found || found.doc.kind !== 'source') return c.json({ error: 'not found' }, 404);
    const { s, doc } = found;
    const body = await c.req.json<{ password?: string; redetect?: boolean }>().catch(() => ({}) as { password?: string; redetect?: boolean });
    const steps = JSON.parse(doc.steps) as Record<string, unknown>;
    // Run the model again (after changing it in Settings), keeping the extraction.
    if (body.redetect) delete steps.detect;
    // Asked for by someone: a fresh count of parks for the model.
    const parked = 'parks' in steps;
    delete steps.parks;
    await s.store.updateDoc(doc.id, { status: 'uploaded', error: null, ...(body.redetect || parked ? { steps } : {}) });
    await s.queue.enqueue({ docId: doc.id, projectId: doc.project_id, kind: 'analyze', password: typeof body.password === 'string' && body.password ? body.password : undefined });
    return c.json({ queued: true }, 202);
  });

  api.patch('/documents/:id/review', async (c) => {
    const found = await docOf(c);
    if (!found) return c.json({ error: 'not found' }, 404);
    const { s, doc } = found;
    const body = await c.req.json<{ overrides?: Record<string, boolean> }>().catch(() => ({}) as { overrides?: Record<string, boolean> });
    const review = JSON.parse(doc.review) as Review;
    const overrides = { ...review.overrides };
    for (const [k, v] of Object.entries(body.overrides ?? {})) {
      if (/^\d+:\d+$/.test(k) && typeof v === 'boolean') overrides[k] = v;
    }
    await s.store.updateDoc(doc.id, { review: { ...review, overrides } });
    return c.json({ ok: true });
  });

  api.post('/documents/:id/render', async (c) => {
    const found = await docOf(c);
    if (!found || (found.doc.kind !== 'source' && found.doc.kind !== 'external')) return c.json({ error: 'not found' }, 404);
    const { s, doc } = found;
    await s.store.updateDoc(doc.id, { status: 'rendering', error: null });
    await s.queue.enqueue({ docId: doc.id, projectId: doc.project_id, kind: 'render' });
    return c.json({ queued: true }, 202);
  });

  /** Bytes for in-app previews: the working copy (an OCR'd scan, a photo turned PDF) or the file. Never freezes. */
  api.get('/documents/:id/:which{work|file}', async (c) => {
    const found = await docOf(c);
    if (!found) return c.json({ error: 'not found' }, 404);
    const { s, doc } = found;
    const which = c.req.param('which') === 'work' && doc.work_key ? 'work' : 'file';
    const key = which === 'work' ? doc.work_key : doc.file_key;
    if (!key) return c.json({ error: 'file missing' }, 404);
    const mime = which === 'work' ? (doc.work_mime ?? PDF) : doc.mime;
    return c.body(await s.blobs.open(key, ownerOf(doc, which)), 200, { 'content-type': isTextMime(mime) ? `${mime}; charset=utf-8` : mime, 'cache-control': 'no-store' });
  });

  /** Desktop: what to save for an output; the native save dialog writes the blob, then /exported freezes the fakes. */
  api.get('/documents/:id/export', async (c) => {
    const found = await docOf(c);
    if (!found || !found.doc.file_key) return c.json({ error: 'not found' }, 404);
    return c.json({ blobId: found.doc.file_key, name: found.doc.out_name ?? found.doc.filename });
  });

  /** An anonymized output left the app (saved or copied): its fakes can't silently change any more. */
  api.post('/documents/:id/exported', async (c) => {
    const found = await docOf(c);
    if (!found) return c.json({ error: 'not found' }, 404);
    const { s, doc } = found;
    if (doc.kind === 'anonymized' && doc.parent_id) await s.store.freezeEntitiesOf(doc.parent_id);
    return c.json({ ok: true });
  });

  /** Web and CLI: the file as a download. An anonymized output's fakes are frozen from here on. */
  api.get('/documents/:id/download', async (c) => {
    const found = await docOf(c);
    if (!found || !found.doc.file_key) return c.json({ error: 'not found' }, 404);
    const { s, doc } = found;
    if (doc.kind === 'anonymized' && doc.parent_id) await s.store.freezeEntitiesOf(doc.parent_id);
    const name = doc.out_name ?? doc.filename;
    return c.body(await s.blobs.open(doc.file_key!, ownerOf(doc, 'file')), 200, {
      'content-type': isTextMime(doc.mime) ? `${doc.mime}; charset=utf-8` : doc.mime,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'no-store',
    });
  });

  api.delete('/documents/:id', async (c) => {
    const found = await docOf(c);
    if (!found) return c.json({ error: 'not found' }, 404);
    await deleteDocs(found.s, [found.doc.id]);
    return c.json({ ok: true });
  });

  // ---- restore ----

  api.post('/restore', async (c) => {
    const s = await scope(c);
    const input = await readInput(c);
    if (input instanceof Response) return input;
    const projectId = typeof input.extra.projectId === 'string' && input.extra.projectId ? input.extra.projectId : undefined;
    if (projectId && !(await s.store.getProject(projectId))) return c.json({ error: 'not found' }, 404);
    const suggest = input.extra.suggest === undefined ? true : input.extra.suggest === true || input.extra.suggest === 'true';
    try {
      const result = await startRestore(s, { text: input.text, file: input.file, filename: input.filename, mime: input.mime, projectId, suggest, password: passwordOf(input.extra) });
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof NoKnownFakesError || err instanceof NoProjectsError) return c.json({ error: 'no_known_fakes' }, 422);
      if (err instanceof PasswordRequiredError) return c.json({ error: 'password_required' }, 423);
      throw err;
    }
  });

  // ---- profile: the user's own values, seeded into every project they own ----

  api.get('/profile', async (c) => {
    const entries = await (await scope(c)).store.loadProfile();
    return c.json({ entries: entries.map((e) => ({ id: e.id, type: e.type, text: e.real.text })) });
  });

  api.post('/profile', async (c) => {
    const s = await scope(c);
    const { type, text } = await c.req.json<{ type?: string; text?: string }>().catch(() => ({}) as { type?: string; text?: string });
    if (!isEntityType(type) || !text?.trim()) return c.json({ error: 'invalid entry' }, 400);
    const real = toValue({ type, text: text.trim() });
    const id = await s.store.addProfileEntry(type, real);
    // Existing projects catch it from now on too.
    for (const p of await s.store.listProjects()) if (p.role === 'owner') await upsertCandidates(s.store, p.id, profileCandidates([{ type, real }]));
    return c.json({ id }, 201);
  });

  api.delete('/profile/:id', async (c) => {
    await (await scope(c)).store.deleteProfileEntry(c.req.param('id'));
    return c.json({ ok: true });
  });

  return api;
}
