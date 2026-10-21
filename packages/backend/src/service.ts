import type { ReviewPayload, Steps } from '@anon/core';
import { DetectorOfflineError, NoKnownFakesError, PasswordRequiredError } from '@anon/pipeline';
import { isTextMime } from './compute';
import { isCloud } from './detector';
import { newId, profileCandidates, upsertCandidates } from './entities';
import { countByType, elapsed, errorText } from './log';
import type { DocRef, DocRow, Job, Review, Scope } from './platform';

/**
 * The service's steps over a Scope: what happens to a document between
 * upload and output, the same on both targets.
 */

export function refOf(doc: DocRow): DocRef {
  return {
    id: doc.id,
    projectId: doc.project_id,
    kind: doc.kind,
    mime: doc.mime,
    filename: doc.filename,
    fileKey: doc.file_key,
    fileSealed: doc.file_sealed,
    textKey: doc.text_key,
    workKey: doc.work_key,
    workMime: doc.work_mime,
    fieldsKey: doc.fields_key,
  };
}

const overridesOf = (doc: DocRow) => (JSON.parse(doc.review) as Review).overrides ?? {};

/**
 * A document parked for the model this many times in a row, each time right
 * after a resume that found the model ready (the PC answers but its model
 * never does, a llama-server that comes up and hangs), fails instead of
 * cycling between waiting and analyzing forever.
 */
export const MAX_PARKS = 5;

/**
 * Detect everything in a source document and turn it into project entities.
 * Files are extracted first (OCR included); then the rules, the engine's
 * small model, known values and the detector's model. Each step's result is
 * kept, so a retry doesn't redo finished work. When the model can't run, the
 * document is parked as 'waiting'.
 */
export async function analyzeSource(s: Scope, doc: DocRow, password?: string, resumed = false): Promise<void> {
  const { store } = s;
  await store.updateDoc(doc.id, { status: 'analyzing', error: null });
  const steps = JSON.parse(doc.steps) as Steps;
  try {
    if (!isTextMime(doc.mime) && !steps.extract) {
      await s.progress.set(doc.id, 'extract');
      const x = await s.compute.extract(refOf(doc), password);
      steps.extract = x.info;
      await store.updateDoc(doc.id, { textKey: x.textKey, fieldsKey: x.fieldsKey, workKey: x.workKey, workMime: x.workMime, steps });
      doc = { ...doc, text_key: x.textKey, fields_key: x.fieldsKey, work_key: x.workKey, work_mime: x.workMime };
    }
    if (!steps.detect) {
      await s.progress.set(doc.id, 'detect');
      const detector = await store.getDetector();
      const capped = isCloud(detector) && (await s.account.capReached());
      const r = await s.compute.detect(refOf(doc), detector, { useModel: !capped });
      if (r.usage) await s.account.recordUsage(r.usage);
      const t = Date.now();
      const saved = await upsertCandidates(store, doc.project_id, r.candidates);
      s.log('info', 'job', `${doc.id} fakes made and saved in ${elapsed(t)}: project has ${saved.length} values`);
      steps.detect = { at: Math.floor(Date.now() / 1000), found: r.candidates.length, nerError: r.nerError, claudeError: capped ? 'the monthly Claude usage cap is reached' : r.claudeError, model: r.model };
    }
    delete steps.parks;
    await store.updateDoc(doc.id, { status: 'needs_review', steps });
  } catch (err) {
    if (err instanceof DetectorOfflineError) {
      if (resumed) steps.parks = (steps.parks ?? 0) + 1;
      if ((steps.parks ?? 0) >= MAX_PARKS) {
        s.log('warn', 'job', `${doc.id} parked ${steps.parks} times in a row although the model looked ready: failed (${errorText(err)})`);
        await store.updateDoc(doc.id, { status: 'failed', error: 'detector_unanswered', steps });
        return;
      }
      s.log('info', 'job', `${doc.id} waiting for the model: ${errorText(err)}${steps.parks ? ` (parked ${steps.parks} times after a resume)` : ''}`);
      await store.updateDoc(doc.id, { status: 'waiting', steps });
      return;
    }
    await store.updateDoc(doc.id, { status: 'failed', error: err instanceof PasswordRequiredError ? 'password_required' : errorText(err).slice(0, 500), steps });
    throw err;
  } finally {
    await s.progress.set(doc.id, null);
  }
}

/** The review screen's data, recomputed from the text and the project's current entities. */
export async function reviewPayload(s: Scope, doc: DocRow): Promise<ReviewPayload> {
  const project = await s.store.getProject(doc.project_id);
  const outputs = await s.store.outputsOf(doc.id);
  const steps = JSON.parse(doc.steps) as Steps;
  const r = await s.compute.review(refOf(doc), { overrides: overridesOf(doc), steps });
  return {
    document: {
      id: doc.id,
      projectId: doc.project_id,
      projectName: project?.name ?? '',
      kind: doc.kind,
      status: doc.status,
      error: doc.error,
      filename: doc.filename,
      mime: doc.mime,
      createdAt: doc.created_at,
      parentId: doc.parent_id,
      outName: doc.out_name,
    },
    text: r.text,
    matches: r.matches,
    entities: r.entities,
    steps,
    outputs: outputs.map((o) => ({ id: o.id, kind: o.kind, createdAt: o.created_at, outName: o.out_name })),
  };
}

/**
 * The output for a reviewed document: the anonymized copy of a source, or the
 * restored copy of an outside document. Any earlier output is replaced.
 */
export async function render(s: Scope, doc: DocRow): Promise<string> {
  const { store } = s;
  const restore = doc.kind === 'external';
  await s.progress.set(doc.id, 'render');
  const t = Date.now();
  s.log('info', 'job', `${doc.id} ${restore ? 'restore' : 'anonymize'}: ${doc.mime}`);
  try {
    const outId = newId();
    const r = await s.compute.render(refOf(doc), { outId, overrides: overridesOf(doc), steps: JSON.parse(doc.steps) as Steps });
    const previous = await store.outputsOf(doc.id);
    await store.insertDoc({
      id: outId,
      projectId: doc.project_id,
      kind: restore ? 'restored' : 'anonymized',
      parentId: doc.id,
      filename: doc.filename,
      outName: r.outName,
      mime: r.outMime,
      size: r.size,
      fileKey: r.fileKey,
      textKey: r.textKey,
      status: 'ready',
      steps: { verify: r.verify },
    });
    // Which entities this output used: exporting it freezes their fakes.
    await store.setDocEntities(doc.id, r.entityHits);
    if (r.reals?.length) await store.writeEntities(doc.project_id, { inserts: [], reals: r.reals, fakes: [], claims: [] });
    await deleteDocs(s, previous.map((p) => p.id));
    await store.updateDoc(doc.id, { status: restore ? 'needs_review' : 'ready', error: null });
    const v = r.verify;
    s.log(
      v.leaks.length > 0 ? 'warn' : 'info',
      'job',
      `${doc.id} output ${outId} in ${elapsed(t)}: ${r.outMime}, ${Object.keys(r.entityHits).length} values replaced${r.reals?.length ? ` (${r.reals.length} with new mentions kept for restore)` : ''}, check: ${v.leaks.length} left (${countByType(v.leaks)})${v.codePages?.length ? `, codes on ${v.codePages.length} pages` : ''}${v.missingWords ? `, ${v.missingWords} words moved` : ''}`,
    );
    return outId;
  } finally {
    await s.progress.set(doc.id, null);
  }
}

export class NoProjectsError extends Error {}

/**
 * Restore an outside document: read it (a file goes through the engine
 * first), work out which project its fakes came from, ask the model for
 * reworded mentions if wanted, and store it in that project for review.
 */
export async function startRestore(
  s: Scope,
  input: { text?: string; file?: Uint8Array<ArrayBuffer>; filename: string; mime: string; projectId?: string; suggest: boolean; password?: string },
): Promise<{ id: string; projectId: string; ranking: Array<{ projectId: string; hits: number }> }> {
  const projectIds = input.projectId ? [input.projectId] : (await s.store.listProjects()).map((p) => p.id);
  if (projectIds.length === 0) throw new NoProjectsError('No project to restore into');
  const detector = await s.store.getDetector();
  const suggest = input.suggest && !(isCloud(detector) && (await s.account.capReached()));
  const id = newId();
  const r = await s.compute.restore({ id, projectIds, projectId: input.projectId, text: input.text, file: input.file, mime: input.mime, password: input.password, suggest, detector });
  if (r.usage) await s.account.recordUsage(r.usage);
  await s.store.insertDoc({
    id,
    projectId: r.projectId,
    kind: 'external',
    filename: input.filename,
    mime: input.mime,
    size: r.size,
    fileKey: r.fileKey,
    textKey: r.textKey,
    fieldsKey: r.fieldsKey,
    workKey: r.workKey,
    workMime: r.workMime,
    status: 'needs_review',
    steps: r.steps,
  });
  return { id, projectId: r.projectId, ranking: r.ranking };
}

/** Remove documents, their outputs and their stored files. */
export async function deleteDocs(s: Scope, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await s.blobs.delete(await s.store.deleteDocs(ids));
}

/** The user's own values, caught in this project from now on. */
export async function seedProfile(s: Scope, projectId: string): Promise<void> {
  const profile = await s.store.loadProfile();
  if (profile.length > 0) await upsertCandidates(s.store, projectId, profileCandidates(profile));
}

/**
 * One analysis or render. A failed render leaves the review as it was, with
 * the error shown there; a failed analysis marks the document failed. The
 * error is rethrown so the queue can log it (and the web's retry transient ones).
 */
export async function runJob(s: Scope, job: Job): Promise<void> {
  const doc = await s.store.getDoc(job.docId);
  if (!doc) return;
  if (job.kind === 'analyze') return analyzeSource(s, doc, job.password, job.resumed);
  try {
    await render(s, doc);
  } catch (err) {
    const msg = err instanceof PasswordRequiredError ? 'password_required' : errorText(err);
    await s.store.updateDoc(doc.id, { status: 'needs_review', error: `render_failed: ${msg}`.slice(0, 500) });
    throw err;
  }
}

/** Documents parked for the model, queued again (the model just became ready). */
export async function resumeWaiting(s: Scope, limit?: number): Promise<number> {
  const detector = await s.store.getDetector();
  if (s.compute.detectorOnline && !(await s.compute.detectorOnline(detector))) return 0;
  const rows = await s.store.waitingDocs(limit);
  if (rows.length === 0) return 0;
  await s.store.markUploaded(rows.map((r) => r.id));
  const jobs: Job[] = rows.map((r) => ({ docId: r.id, projectId: r.project_id, kind: 'analyze', resumed: true }));
  if (s.queue.enqueueAll) await s.queue.enqueueAll(jobs);
  else for (const j of jobs) await s.queue.enqueue(j);
  return rows.length;
}

export { NoKnownFakesError };
