import { withMentions, type SealedReal, type Steps } from '@anon/core';
import {
  analyze,
  computeMatches,
  engineClient,
  isEngineMime,
  prepare,
  render as renderDoc,
  route,
  type Deps,
  type Field,
  type LoadedEntity,
  type ModelClient,
} from '@anon/pipeline';
import { elapsed, countByType } from './log';
import type { BlobOwner, Compute, ComputeEnv, DocRef, Detector } from './platform';

const enc = new TextEncoder();
const dec = new TextDecoder();

const TEXT_MIMES = new Set(['text/plain', 'text/markdown']);
export const isTextMime = (mime: string) => TEXT_MIMES.has(mime);

const owner = (doc: DocRef, sealed = true): BlobOwner => ({ projectId: doc.projectId, docId: doc.id, sealed });

async function readText(env: ComputeEnv, doc: DocRef): Promise<string> {
  if (!doc.textKey) throw new Error('document has no text');
  return dec.decode(await env.blobs.get(doc.textKey, owner(doc)));
}

/**
 * The compute steps over an engine, a model and a blob store. This is what
 * the desktop app runs in its page, and what the web's processor runs on the
 * VPS for each request: the same code reads, detects, matches and renders on
 * both targets.
 */
export function localCompute(env: ComputeEnv): Compute {
  const engine = engineClient(env.engine);
  const deps = (model: ModelClient | null): Deps => ({ engine, ner: (text) => engine.ner(text), model: () => model });
  const log = (doc: string, level: 'info' | 'warn' | 'error', msg: string) => env.log(level, 'job', `${doc} ${msg}`);

  return {
    async extract(doc, password) {
      if (!doc.fileKey) throw new Error('document has no file');
      const t = Date.now();
      log(doc.id, 'info', `extract: ${doc.mime}`);
      const p = await prepare(engine, await env.blobs.get(doc.fileKey, owner(doc, doc.fileSealed)), doc.mime, password);
      log(doc.id, 'info', `extract done in ${elapsed(t)}: ${p.pages ?? '?'} pages, ocr ${p.ocr}, ${p.text.length} chars, ${p.fields.length} fields${p.work ? ', working copy' : ''}`);
      const textKey = await env.blobs.put('t', enc.encode(p.text), owner(doc));
      const fieldsKey = await env.blobs.put('x', enc.encode(JSON.stringify(p.fields)), owner(doc));
      const workKey = p.work ? await env.blobs.put('w', p.work, owner(doc)) : null;
      return { textKey, fieldsKey, workKey, workMime: p.workMime ?? null, info: { sha256: p.sha256, ocr: p.ocr, pages: p.pages }, chars: p.text.length };
    },

    async detect(doc, detector, { useModel }) {
      let t = Date.now();
      const model = await env.model(detector);
      const text = await readText(env, doc);
      const known = await env.entities([doc.projectId]);
      log(
        doc.id,
        'info',
        `detect: rules and small model${model ? ` + ${model.name}, chunks of ${model.maxChunkChars}` : ''}${model && !useModel ? ' (over its cap: not used)' : ''}, ${text.length} chars, ${known.length} known values in the project${Date.now() - t > 1000 ? `, model ready in ${elapsed(t)}` : ''}`,
      );
      t = Date.now();
      const r = await analyze(deps(model), text, known, useModel, undefined, (done, total) => {
        if (total > 1) log(doc.id, 'info', `detect: part ${done}/${total} after ${elapsed(t)}`);
      });
      const failed = model && r.claudeError;
      const used = model && useModel ? model.name : undefined;
      log(
        doc.id,
        failed || r.nerError ? 'warn' : 'info',
        `detect done in ${elapsed(t)}: ${r.candidates.length} values (${countByType(r.candidates)})${r.modelSplits ? `; ${r.modelSplits} cut-off part(s) split and asked again` : ''}${r.nerError ? `; small model failed, rules only: ${r.nerError}` : ''}${failed ? `; ${model.name} failed: ${r.claudeError}` : ''}`,
      );
      return used ? { ...r, model: used } : r;
    },

    async review(doc, { overrides, steps }) {
      const text = doc.textKey ? await readText(env, doc) : '';
      const entities = await env.entities([doc.projectId]);
      const restore = doc.kind === 'external';
      return {
        text,
        // Outputs are shown as-is; only reviewable documents need matches.
        matches: doc.kind === 'source' || restore ? computeMatches(text, entities, restore, doc.projectId, overrides, steps.suggest?.items) : [],
        entities: entities.map((e) => ({ id: e.id, type: e.type, real: e.real.text, fake: e.fake.text, enabled: e.enabled, frozen: e.frozen })),
      };
    },

    async render(doc, { outId, overrides, steps }) {
      const restore = doc.kind === 'external';
      let file: Uint8Array<ArrayBuffer> | undefined;
      let fields: Field[] | undefined;
      if (isEngineMime(doc.mime)) {
        const key = doc.workKey ?? doc.fileKey;
        if (!key) throw new Error('document has no file');
        file = await env.blobs.get(key, owner(doc, doc.workKey ? true : doc.fileSealed));
        fields = doc.fieldsKey ? (JSON.parse(dec.decode(await env.blobs.get(doc.fieldsKey, owner(doc)))) as Field[]) : [];
      }
      const entities: LoadedEntity[] = await env.entities([doc.projectId]);
      const r = await renderDoc(deps(null), {
        text: await readText(env, doc),
        entities,
        restore,
        projectId: doc.projectId,
        overrides,
        steps,
        mime: doc.mime,
        filename: doc.filename,
        file,
        workMime: doc.workMime ?? undefined,
        fields,
      });
      const out: BlobOwner = { projectId: doc.projectId, docId: outId };
      // What this output wrote for each value, kept with the value so restoring it gives back the text as it was.
      const reals: Array<{ id: string; real: SealedReal }> = [];
      if (!restore) {
        for (const e of entities) {
          const logs = withMentions(e.mentions, outId, r.mentions[e.id]);
          if (logs) reals.push({ id: e.id, real: { real: e.real, surfaces: e.surfaces ?? [], mentions: logs } });
        }
      }
      return {
        fileKey: await env.blobs.put('f', r.file, out),
        textKey: await env.blobs.put('t', enc.encode(r.outText), out),
        size: r.file.length,
        outMime: r.outMime,
        outName: r.outName,
        verify: r.verify,
        entityHits: r.entityHits,
        reals,
      };
    },

    async restore(input) {
      const entities = await env.entities(input.projectIds);
      const prepared = input.file && isEngineMime(input.mime) ? await prepare(engine, input.file, input.mime, input.password) : undefined;
      const text = prepared?.text ?? input.text ?? (input.file ? dec.decode(input.file) : '');
      let model: ModelClient | null = null;
      // Suggestions are optional: a model that can't run just means none this time.
      if (input.suggest) model = await env.model(input.detector).catch(() => null);
      const t = Date.now();
      const r = await route(deps(model), { text, entities, projectId: input.projectId, suggest: input.suggest });
      if (prepared) r.steps.extract = { sha256: prepared.sha256, ocr: prepared.ocr, pages: prepared.pages };
      env.log(
        'info',
        'job',
        `restore: ${input.mime}, ${text.length} chars, project ${r.projectId} (${r.ranking.map((x) => `${x.projectId} ${x.hits}`).join(', ')}), ${r.steps.suggest ? `${r.steps.suggest.items.length} suggestions${r.steps.suggest.error ? `, model failed: ${r.steps.suggest.error}` : ''}` : 'no suggestions'}, ${elapsed(t)}`,
      );
      const o: BlobOwner = { projectId: r.projectId, docId: input.id };
      const file = input.file ?? enc.encode(text);
      return {
        projectId: r.projectId,
        ranking: r.ranking,
        steps: r.steps,
        usage: r.usage,
        fileKey: await env.blobs.put('f', file, o),
        textKey: await env.blobs.put('t', enc.encode(text), o),
        fieldsKey: prepared ? await env.blobs.put('x', enc.encode(JSON.stringify(prepared.fields)), o) : null,
        workKey: prepared?.work ? await env.blobs.put('w', prepared.work, o) : null,
        workMime: prepared?.workMime ?? null,
        size: file.length,
        chars: text.length,
      };
    },
  };
}

/** The steps a document went through, for compute calls. */
export function stepsOf(json: string): Steps {
  return JSON.parse(json) as Steps;
}

export type { Detector };
