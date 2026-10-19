import { beforeEach, describe, expect, it } from 'vitest';
import ORIGINAL from '../../../fixtures/text/assurance-habitation.txt?raw';
import type { Detector } from '../src/platform';
import { engineCalls, fakeEngine, model, PDF_PASSWORD, resetFakes } from './fakes';

/**
 * The service's behaviour, written once and run against both targets: the
 * desktop (packages/backend/test/api.test.ts: node:sqlite, in-memory jobs,
 * compute in-process) and the web (web/worker/test: the Worker in workerd
 * with D1, R2 and the queue, the processor in-process). A difference between
 * the two shows up here as a failing test.
 */
export interface Harness {
  /** A request to the API as the signed-in user ('/api/…'). */
  call(path: string, init?: RequestInit & { json?: unknown }): Promise<Response>;
  /** Run every queued job to the end. */
  drain(): Promise<void>;
  /** What the target does once the model is back (desktop: download done; web: the cron). */
  resumeWaiting(): Promise<number>;
  /** A big model this target offers, set before each test. */
  detector: Detector;
  /** Detector settings the target refuses and accepts. */
  invalidDetectors: unknown[];
  validDetector: Detector;
  frozenCount(): Promise<number>;
  blobCount(): Promise<number>;
  hasBlob(key: string): Promise<boolean>;
  entityCount(): Promise<number>;
  /** Whether this text appears anywhere in the database, as stored. */
  dbContains(text: string): Promise<boolean>;
  /** Everything both sides logged. */
  logs: string[];
}

export const DETECTED = {
  entities: [
    { text: 'Jean-François Tremblay', type: 'person', group: 'p1', first: 'Jean-François', last: 'Tremblay', gender: 'm', lang: 'fr' },
    { text: 'J.-F. Tremblay', type: 'person', group: 'p1' },
    { text: 'Tremblay', type: 'person', group: 'p1', last: 'Tremblay' },
    { text: 'Isabelle Côté', type: 'person', group: 'p2', first: 'Isabelle', last: 'Côté', gender: 'f' },
    { text: 'Nathalie Bergeron', type: 'person', group: 'p3', first: 'Nathalie', last: 'Bergeron', gender: 'f' },
    { text: 'Assurances Mirador inc.', type: 'organization', group: 'o1' },
    {
      text: '1842, rue des Érables, app. 3, Laval',
      type: 'address',
      group: 'a1',
      civic: '1842',
      street_type: 'rue',
      particle: 'des',
      street_name: 'Érables',
      unit: '3',
      city: 'Laval',
    },
    { text: 'HAB-48210937', type: 'id_number', group: 'i1' },
  ],
};

export const REAL = ['Tremblay', 'Côté', 'Bergeron', 'Érables', '662-1934', 'H7N 2K4', '046 454 286', '48210937', 'jf.tremblay', '14 mars 1981'];

export { ORIGINAL };

export function apiSuite(harness: () => Promise<Harness>) {
  let t: Harness;
  const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

  beforeEach(async () => {
    resetFakes();
    model.detect = DETECTED;
    t = await harness();
    expect((await t.call('/api/settings/detection', { method: 'PUT', json: t.detector })).status).toBe(200);
  });

  async function newProject(name = 'Achat maison'): Promise<string> {
    const res = await t.call('/api/projects', { method: 'POST', json: { name } });
    expect(res.status).toBe(201);
    return (await json<{ id: string }>(res)).id;
  }

  /** Upload text and wait for its analysis. */
  async function addText(pid: string, text: string, filename?: string): Promise<string> {
    const res = await t.call(`/api/projects/${pid}/documents`, { method: 'POST', json: { text, filename } });
    expect(res.status).toBe(202);
    const { id } = await json<{ id: string }>(res);
    await t.drain();
    return id;
  }

  async function renderAndRead(id: string): Promise<{ outId: string; text: string }> {
    expect((await t.call(`/api/documents/${id}/render`, { method: 'POST' })).status).toBe(202);
    await t.drain();
    const after = await json<{ outputs: Array<{ id: string }> }>(await t.call(`/api/documents/${id}`));
    const outId = after.outputs[0]!.id;
    return { outId, text: await (await t.call(`/api/documents/${outId}/file`)).text() };
  }

  describe('anonymize and restore', () => {
    it('anonymizes, then restores an outside rewrite', async () => {
      const pid = await newProject();
      const id = await addText(pid, ORIGINAL, 'Tremblay_assurance.txt');
      expect(model.calls).toHaveLength(1);
      expect(model.calls[0]!.user).toContain('Jean-François Tremblay');

      const review = await json<{ document: { status: string }; matches: Array<{ checked: boolean; type: string }> }>(await t.call(`/api/documents/${id}`));
      expect(review.document.status).toBe('needs_review');
      expect(review.matches.length).toBeGreaterThan(10);
      // Organizations are detected but left alone unless turned on.
      expect(review.matches.some((m) => m.type === 'organization')).toBe(false);

      const { outId, text: anon } = await renderAndRead(id);
      for (const s of REAL) expect(anon).not.toContain(s);
      expect(anon).toContain('Assurances Mirador inc.');
      const exp = await json<{ blobId: string; name: string }>(await t.call(`/api/documents/${outId}/export`));
      expect(exp.name).not.toContain('Tremblay');
      expect(await t.hasBlob(exp.blobId)).toBe(true);

      // Saving (desktop) or downloading (web) froze the fakes it used.
      const frozen = await t.frozenCount();
      await t.call(`/api/documents/${outId}/exported`, { method: 'POST' });
      expect(await t.frozenCount()).toBeGreaterThan(frozen + 5);
      const download = await t.call(`/api/documents/${outId}/download`);
      expect(download.headers.get('content-disposition')).toMatch(/^attachment; filename\*=UTF-8''/);
      expect(download.headers.get('content-disposition')).not.toContain('Tremblay');
      expect(await download.text()).toBe(anon);

      // An outside AI rewrites the anonymized letter in English with the fakes reshaped.
      const entities = (await json<{ entities: Array<{ type: string; real: string; fake: string }> }>(await t.call(`/api/projects/${pid}/entities`))).entities;
      const fake = (real: string) => entities.find((e) => e.real === real)!.fake;
      const p1 = fake('Jean-François Tremblay');
      const p1Last = p1.split(' ').pop()!;
      const outside = `Dear ${p1}, the ${p1Last}s' policy ${fake('HAB-48210937')} renews soon. Mr. ${p1Last.toUpperCase()} can call ${fake('Nathalie Bergeron')}.`;

      const r = await t.call('/api/restore', { method: 'POST', json: { text: outside, suggest: false } });
      expect(r.status).toBe(201);
      const restoreRes = await json<{ id: string; projectId: string }>(r);
      expect(restoreRes.projectId).toBe(pid);
      const { text: restored } = await renderAndRead(restoreRes.id);
      expect(restored).toBe("Dear Jean-François Tremblay, the Tremblays' policy HAB-48210937 renews soon. Mr. TREMBLAY can call Nathalie Bergeron.");

      // Text with no known fake can't be routed anywhere.
      expect((await t.call('/api/restore', { method: 'POST', json: { text: 'Nothing known here.', suggest: false } })).status).toBe(422);

      // The diagnostic log has every step, and nothing real.
      const log = t.logs.join('\n');
      for (const step of ['detect done', 'fakes made and saved', 'output', 'restore:']) expect(log).toContain(step);
      for (const s of [...REAL, 'Jean-François', 'Nathalie', 'Tremblay_assurance', 'Achat maison', ...entities.map((e) => e.fake)]) expect(log).not.toContain(s);
    });

    it('restores its own output, pasted back, exactly as the original was written', async () => {
      // An initial whose fake could read as "M." (Monsieur), a name first seen in capitals, an OCR'd
      // date, and a signature line read as one value: the parity check's restore mismatches.
      const original =
        'Prêt de Olivier Lamy, né le l7 août 1973.\n| Banque Nationale | O. Lamy | 15 905,00 $ |\nM. Lamy a signé ; MARGARET KOWALCZYK aussi, puis Margaret\nKowalczyk.\n\nOlivier Lamy                    Margaret Kowalczyk\n';
      model.detect = {
        entities: [
          { text: 'Olivier Lamy', type: 'person', group: 'p1', first: 'Olivier', last: 'Lamy', gender: 'm' },
          { text: 'O. Lamy', type: 'person', group: 'p1' },
          { text: 'MARGARET KOWALCZYK', type: 'person', group: 'p2', first: 'MARGARET', last: 'KOWALCZYK', gender: 'f' },
          { text: 'l7 août 1973', type: 'dob', group: 'd1' },
          { text: 'Olivier Lamy                    Margaret Kowalczyk', type: 'person', group: 'p3' },
        ],
      } as unknown as typeof DETECTED;
      const pid = await newProject('Exact');
      const id = await addText(pid, original);
      const { outId, text: anon } = await renderAndRead(id);
      for (const s of ['Lamy', 'KOWALCZYK', 'Margaret', 'l7 août']) expect(anon).not.toContain(s);
      await t.call(`/api/documents/${outId}/download`);
      const r = await json<{ id: string }>(await t.call('/api/restore', { method: 'POST', json: { text: anon, projectId: pid, suggest: false } }));
      expect((await renderAndRead(r.id)).text).toBe(original);
      // Rendering the same document again writes the same mentions: nothing more to store, and still exact.
      const again = await renderAndRead(id);
      expect(again.text).toBe(anon);
      const r2 = await json<{ id: string }>(await t.call('/api/restore', { method: 'POST', json: { text: anon, projectId: pid, suggest: false } }));
      expect((await renderAndRead(r2.id)).text).toBe(original);
      for (const s of ['O. Lamy', 'l7 août', 'MARGARET']) expect(t.logs.join('\n')).not.toContain(s);
    });

    it('draws a new fake when a later value turns out to equal it, and the old outputs still restore', async () => {
      const pid = await newProject('Collision');
      await t.call('/api/profile', { method: 'POST', json: { type: 'person', text: 'Marie-Ève Lapointe' } });
      type E = { id: string; type: string; real: string; fake: string; aliases: string[]; frozen: boolean };
      const list = async () => (await json<{ entities: E[] }>(await t.call(`/api/projects/${pid}/entities`))).entities;
      const mine = (await list()).find((e) => e.real === 'Marie-Ève Lapointe')!;
      const oldLast = mine.fake.split(' ').pop()!;

      // The profile's fake leaves the tool in a first document.
      const first = 'Signé : Marie-Ève Lapointe, le 3 mai.';
      model.detect = { entities: [{ text: 'Marie-Ève Lapointe', type: 'person', group: 'p1', first: 'Marie-Ève', last: 'Lapointe', gender: 'f' }] } as unknown as typeof DETECTED;
      const a = await addText(pid, first);
      const outA = await renderAndRead(a);
      expect(outA.text).toContain(mine.fake);
      await t.call(`/api/documents/${outA.outId}/download`);
      expect((await list()).find((e) => e.id === mine.id)!.frozen).toBe(true);

      // A later document names a real person with that very surname.
      const second = `Locataire : Paul ${oldLast}, voisin de Marie-Ève Lapointe.`;
      model.detect = {
        entities: [
          { text: `Paul ${oldLast}`, type: 'person', group: 'p2', first: 'Paul', last: oldLast, gender: 'm' },
          { text: 'Marie-Ève Lapointe', type: 'person', group: 'p1', first: 'Marie-Ève', last: 'Lapointe', gender: 'f' },
        ],
      } as unknown as typeof DETECTED;
      const b = await addText(pid, second);
      const after = await list();
      const me = after.find((e) => e.id === mine.id)!;
      expect(me.fake).not.toBe(mine.fake);
      expect(me.aliases).toContain(mine.fake);
      // No fake in the project shares a word with a real value any more.
      const words = (s: string) => s.toLowerCase().split(/[\s,-]+/).filter((w) => w.length > 2 && !w.endsWith('.'));
      const realWords = new Set(after.flatMap((e) => words(e.real)));
      for (const e of after) for (const w of words(e.fake)) expect(realWords.has(w), `${e.fake} / ${e.real}`).toBe(false);
      expect((await renderAndRead(b)).text).not.toMatch(new RegExp(`(^|[^\\p{L}])${oldLast}([^\\p{L}]|$)`, 'u'));

      // The first output, pasted back, still restores (its fake is an alias now).
      const r = await json<{ id: string; projectId: string }>(await t.call('/api/restore', { method: 'POST', json: { text: outA.text, projectId: pid, suggest: false } }));
      expect((await renderAndRead(r.id)).text).toBe(first);
    });

    it('draws again an existing fake that a value added by hand equals, of any kind', async () => {
      const pid = await newProject('Collision manuelle');
      await addText(pid, ORIGINAL);
      type E = { id: string; type: string; real: string; fake: string };
      const list = async () => (await json<{ entities: E[] }>(await t.call(`/api/projects/${pid}/entities`))).entities;
      const before = await list();
      const policy = before.find((e) => e.real === 'HAB-48210937')!;
      const dob = before.find((e) => e.type === 'dob')!;
      for (const [type, text] of [['id_number', policy.fake], ['date', dob.fake]] as const) {
        expect((await t.call(`/api/projects/${pid}/entities`, { method: 'POST', json: { type, text } })).status).toBe(201);
      }
      const after = await list();
      expect(after.find((e) => e.id === policy.id)!.fake).not.toBe(policy.fake);
      expect(after.find((e) => e.id === dob.id)!.fake).not.toBe(dob.fake);
      // Everything else kept its fake.
      for (const e of before.filter((x) => x.id !== policy.id && x.id !== dob.id)) expect(after.find((x) => x.id === e.id)!.fake).toBe(e.fake);
      // A fake typed by hand can't be a real value of the project either.
      const p1 = after.find((e) => e.real === 'Jean-François Tremblay')!;
      for (const fake of ['Isabelle Côté', 'Paul Bergeron', 'Jean-François Tremblay']) {
        const res = await t.call(`/api/projects/${pid}/entities/${p1.id}`, { method: 'PATCH', json: { fake } });
        expect(res.status, fake).toBe(409);
        expect(await json(res)).toEqual({ error: 'fake_is_real' });
      }
      expect((await list()).find((e) => e.id === p1.id)!.fake).toBe(p1.fake);
    });

    it('only sends fakes to the model when suggesting restore spans', async () => {
      const pid = await newProject('Suggestions');
      await addText(pid, ORIGINAL);
      const entities = (await json<{ entities: Array<{ id: string; real: string; fake: string }> }>(await t.call(`/api/projects/${pid}/entities`))).entities;
      const p1 = entities.find((e) => e.real === 'Jean-François Tremblay')!;
      const last = p1.fake.split(' ').pop()!;
      // One letter off ("Leroux" ends in x already: then z).
      const misspelled = last.slice(0, -1) + (last.endsWith('x') ? 'z' : 'x');
      const outside = `${p1.fake} wrote to M. ${misspelled}.`;
      model.calls.length = 0;
      model.suggest = { spans: [{ text: misspelled, fake_id: p1.id }] };

      const { id } = await json<{ id: string }>(await t.call('/api/restore', { method: 'POST', json: { text: outside, projectId: pid } }));
      expect(model.calls).toHaveLength(1);
      for (const s of ['Tremblay', 'Côté', 'Bergeron', 'Érables', '046 454 286', '046454286', 'HAB-48210937']) expect(model.calls[0]!.user).not.toContain(s);

      const review = await json<{ matches: Array<{ suggested?: boolean; checked: boolean; key: string; replacement: string }> }>(await t.call(`/api/documents/${id}`));
      const suggestion = review.matches.find((m) => m.suggested)!;
      expect(suggestion.checked).toBe(false);
      await t.call(`/api/documents/${id}/review`, { method: 'PATCH', json: { overrides: { [suggestion.key]: true } } });
      expect((await renderAndRead(id)).text).toBe(`Jean-François Tremblay wrote to M. ${suggestion.replacement}.`);
    });

    it('keeps going with regex detection when the model fails, and reports it', async () => {
      const pid = await newProject('Sans modèle');
      model.detect = 'not json';
      const id = await addText(pid, ORIGINAL);
      const review = await json<{ document: { status: string }; steps: { detect?: { claudeError?: string } }; matches: Array<{ type: string }> }>(await t.call(`/api/documents/${id}`));
      expect(review.document.status).toBe('needs_review');
      expect(review.steps.detect?.claudeError).toBeTruthy();
      expect(review.matches.map((m) => m.type)).toEqual(expect.arrayContaining(['sin', 'phone', 'email', 'postal_code', 'dob']));
    });

    it('ignores a label the model typed as a number and finishes values with nothing to keep', async () => {
      const pid = await newProject('Étiquettes');
      model.detect = {
        entities: [
          { text: 'RAMQ', type: 'health_card', group: 'h1' },
          { text: 'TREJ 6604 1215', type: 'health_card', group: 'h2' },
          { text: 'BMO', type: 'other', group: 'x1' },
        ],
      };
      const text = 'Carte RAMQ : TREJ 6604 1215. Banque : BMO.';
      const id = await addText(pid, text);
      const review = await json<{ document: { status: string }; matches: Array<{ start: number; end: number }> }>(await t.call(`/api/documents/${id}`));
      expect(review.document.status).toBe('needs_review');
      expect(review.matches.map((m) => text.slice(m.start, m.end)).sort()).toEqual(['BMO', 'TREJ 6604 1215']);
    });

    it('finds names with the small model in the engine alone, with no big model set', async () => {
      await t.call('/api/settings/detection', { method: 'PUT', json: { engine: 'none' } });
      fakeEngine.ner = [
        { text: 'Jean-François Tremblay', type: 'person' },
        { text: 'Isabelle Côté', type: 'person' },
        { text: '1842, rue des Érables', type: 'address' },
        // The model calls many dates "date of birth"; without "né le" or a Naissance column it's a plain date.
        { text: '1er décembre 2026', type: 'dob' },
      ];
      const pid = await newProject('Détection rapide');
      const id = await addText(pid, ORIGINAL);
      fakeEngine.ner = [];
      expect(model.calls).toHaveLength(0);
      expect(engineCalls).toContain('/ner');
      const review = await json<{ document: { status: string }; steps: { detect?: { nerError?: string; claudeError?: string } }; matches: Array<{ type: string; surface: string }> }>(
        await t.call(`/api/documents/${id}`),
      );
      expect(review.document.status).toBe('needs_review');
      expect(review.steps.detect?.nerError).toBeUndefined();
      expect(review.steps.detect?.claudeError).toBeUndefined();
      const found = (type: string) => review.matches.filter((m) => m.type === type).map((m) => m.surface);
      expect(found('person')).toEqual(expect.arrayContaining(['Jean-François Tremblay', 'Isabelle Côté']));
      expect(found('address')).toEqual(expect.arrayContaining(['1842, rue des Érables']));
      expect(found('dob')).not.toContain('1er décembre 2026');
      expect(t.logs.some((l) => l.includes('detect: rules and small model,'))).toBe(true);
    });

    it('keeps the rules going when the small model is missing, and says so', async () => {
      await t.call('/api/settings/detection', { method: 'PUT', json: { engine: 'none' } });
      fakeEngine.nerDown = true;
      const pid = await newProject('Mode de base');
      const id = await addText(pid, ORIGINAL);
      fakeEngine.nerDown = false;
      expect(model.calls).toHaveLength(0);
      const review = await json<{ document: { status: string }; steps: { detect?: { nerError?: string } }; matches: Array<{ type: string }> }>(await t.call(`/api/documents/${id}`));
      expect(review.document.status).toBe('needs_review');
      expect(review.steps.detect?.nerError).toMatch(/detection model missing/);
      expect(review.matches.map((m) => m.type)).toEqual(expect.arrayContaining(['sin', 'phone', 'email']));
      expect(t.logs.some((l) => l.includes('small model failed, rules only'))).toBe(true);
    });

    it('reuses fakes across documents in a project and re-analysis does not call the model again', async () => {
      const pid = await newProject('Deux documents');
      const a = await addText(pid, ORIGINAL);
      const before = (await json<{ entities: unknown[] }>(await t.call(`/api/projects/${pid}/entities`))).entities.length;
      await addText(pid, 'Note: Jean-François Tremblay a appelé.');
      const after = (await json<{ entities: unknown[] }>(await t.call(`/api/projects/${pid}/entities`))).entities.length;
      expect(after).toBe(before);
      model.calls.length = 0;
      await t.call(`/api/documents/${a}/analyze`, { method: 'POST' });
      await t.drain();
      expect(model.calls).toHaveLength(0);
      // Unless asked to detect again (after changing the model).
      await t.call(`/api/documents/${a}/analyze`, { method: 'POST', json: { redetect: true } });
      await t.drain();
      expect(model.calls).toHaveLength(1);
    });

    it("seeds the user's own values into new and existing projects", async () => {
      const existing = await newProject('Avant');
      await t.call('/api/profile', { method: 'POST', json: { type: 'person', text: 'Marie-Ève Lapointe' } });
      const later = await newProject('Après');
      for (const pid of [existing, later]) {
        const { entities } = await json<{ entities: Array<{ real: string }> }>(await t.call(`/api/projects/${pid}/entities`));
        expect(entities.map((e) => e.real)).toContain('Marie-Ève Lapointe');
      }
    });

    it('edits values: a manual one, a new fake, turning one off, deleting an unused one', async () => {
      const pid = await newProject('Valeurs');
      const id = await addText(pid, ORIGINAL);
      const added = await json<{ id: string }>(await t.call(`/api/projects/${pid}/entities`, { method: 'POST', json: { type: 'other', text: 'Mirador' } }));
      let { entities } = await json<{ entities: Array<{ id: string; real: string; fake: string; enabled: boolean }> }>(await t.call(`/api/projects/${pid}/entities`));
      expect(entities.find((e) => e.id === added.id)).toMatchObject({ real: 'Mirador', enabled: true });
      const p1 = entities.find((e) => e.real === 'Jean-François Tremblay')!;
      await t.call(`/api/projects/${pid}/entities/${p1.id}`, { method: 'PATCH', json: { fake: 'Luc Ouellet' } });
      const isabelle = entities.find((e) => e.real === 'Isabelle Côté')!;
      await t.call(`/api/projects/${pid}/entities/${isabelle.id}`, { method: 'PATCH', json: { enabled: false } });
      await t.call(`/api/projects/${pid}/entities/${added.id}`, { method: 'DELETE' });
      ({ entities } = await json<{ entities: Array<{ id: string; real: string; fake: string; enabled: boolean }> }>(await t.call(`/api/projects/${pid}/entities`)));
      expect(entities.find((e) => e.id === p1.id)!.fake).toBe('Luc Ouellet');
      expect(entities.find((e) => e.id === isabelle.id)!.enabled).toBe(false);
      expect(entities.some((e) => e.id === added.id)).toBe(false);
      const { text } = await renderAndRead(id);
      expect(text).toContain('Luc Ouellet');
      expect(text).toContain('Isabelle Côté');
    });

    it('renames a project, lists it, and rejects bad input', async () => {
      const pid = await newProject('Ancien nom');
      expect((await t.call(`/api/projects/${pid}`, { method: 'PATCH', json: { name: 'Nouveau nom' } })).status).toBe(200);
      const { projects } = await json<{ projects: Array<{ id: string; name: string; documents: number; role: string }> }>(await t.call('/api/projects'));
      expect(projects.find((p) => p.id === pid)).toMatchObject({ name: 'Nouveau nom', documents: 0, role: 'owner' });
      expect((await t.call('/api/projects', { method: 'POST', json: { name: ' ' } })).status).toBe(400);
      expect((await t.call(`/api/projects/${pid}/documents`, { method: 'POST', json: { text: '' } })).status).toBe(400);
      expect((await t.call(`/api/projects/${pid}/entities`, { method: 'POST', json: { type: 'nope', text: 'x' } })).status).toBe(400);
      expect((await t.call('/api/projects/nope')).status).toBe(404);
      expect((await t.call('/api/documents/nope')).status).toBe(404);
      const form = new FormData();
      form.append('file', new File(['x'], 'macro.xlsm'));
      expect((await t.call(`/api/projects/${pid}/documents`, { method: 'POST', body: form })).status).toBe(415);
    });
  });

  describe('files (fake engine)', () => {
    it('queues a PDF, extracts it, rewrites it with fields, and checks the output for leaks', async () => {
      const pid = await newProject('Fichiers');
      const form = new FormData();
      form.append('file', new File([`%SCAN\n${ORIGINAL}`], 'police Tremblay.pdf', { type: 'application/pdf' }));
      const up = await t.call(`/api/projects/${pid}/documents`, { method: 'POST', body: form });
      expect(up.status).toBe(202);
      const { id } = await json<{ id: string }>(up);
      await t.drain();
      expect(engineCalls).toEqual(expect.arrayContaining(['/inspect', '/ocr', '/extract']));
      const review = await json<{ document: { status: string; filename: string }; text: string }>(await t.call(`/api/documents/${id}`));
      expect(review.document.status).toBe('needs_review');
      expect(review.document.filename).toBe('police Tremblay.pdf');
      expect(review.text).toContain('Jean-François Tremblay');
      // The working copy (the OCR'd scan) is there for the preview.
      expect(await (await t.call(`/api/documents/${id}/work`)).text()).toContain('%PDF');

      fakeEngine.raster = ['Signé : J.-F. Tremb1ay'];
      const { outId, text } = await renderAndRead(id);
      const after = await json<{ document: { status: string }; outputs: Array<{ id: string; outName: string }> }>(await t.call(`/api/documents/${id}`));
      expect(after.document.status).toBe('ready');
      expect(after.outputs[0]!.outName).not.toContain('Tremblay');
      expect(after.outputs[0]!.outName.endsWith('.pdf')).toBe(true);
      for (const s of REAL) expect(text).not.toContain(s);
      // The mailto link was rewritten too.
      expect(fakeEngine.fields[0]!.text).not.toContain('tremblay');
      // OCR of the rendered page "saw" a misread real name: reported as a leak.
      const outReview = await json<{ steps: { verify: { leaks: Array<{ type: string; where: string }> } } }>(await t.call(`/api/documents/${outId}`));
      expect(outReview.steps.verify.leaks).toEqual([expect.objectContaining({ type: 'person', where: 'page image' })]);

      // Rendering again replaces the earlier output.
      const second = await renderAndRead(id);
      expect(second.outId).not.toBe(outId);
      expect((await t.call(`/api/documents/${outId}`)).status).toBe(404);
    });

    it('asks for the password of a protected PDF and keeps it out of storage', async () => {
      const pid = await newProject('Mot de passe');
      const form = new FormData();
      form.append('file', new File([`%LOCK\n${ORIGINAL}`], 'protege.pdf', { type: 'application/pdf' }));
      const { id } = await json<{ id: string }>(await t.call(`/api/projects/${pid}/documents`, { method: 'POST', body: form }));
      await t.drain();
      expect((await json<{ document: { status: string; error: string } }>(await t.call(`/api/documents/${id}`))).document).toMatchObject({ status: 'failed', error: 'password_required' });
      expect((await t.call(`/api/documents/${id}/analyze`, { method: 'POST', json: { password: PDF_PASSWORD } })).status).toBe(202);
      await t.drain();
      const review = await json<{ document: { status: string }; text: string }>(await t.call(`/api/documents/${id}`));
      expect(review.document.status).toBe('needs_review');
      expect(review.text).toContain('Jean-François Tremblay');
      expect(await t.dbContains(PDF_PASSWORD)).toBe(false);
    });
  });

  describe('model availability', () => {
    it('parks documents while the model cannot run and analyzes them once it is ready', async () => {
      const pid = await newProject('Modèle absent');
      model.offline = true;
      const id = await addText(pid, ORIGINAL);
      expect((await json<{ document: { status: string } }>(await t.call(`/api/documents/${id}`))).document.status).toBe('waiting');
      expect((await json<{ waiting: number }>(await t.call('/api/settings/detection'))).waiting).toBe(1);
      model.offline = false;
      expect(await t.resumeWaiting()).toBe(1);
      await t.drain();
      const review = await json<{ document: { status: string }; matches: unknown[] }>(await t.call(`/api/documents/${id}`));
      expect(review.document.status).toBe('needs_review');
      expect(review.matches.length).toBeGreaterThan(0);
    });

    it('validates the detector setting', async () => {
      for (const d of t.invalidDetectors) expect((await t.call('/api/settings/detection', { method: 'PUT', json: d })).status).toBe(400);
      expect((await t.call('/api/settings/detection', { method: 'PUT', json: { ...t.validDetector, extra: 'dropped' } })).status).toBe(200);
      expect((await json<{ detector: unknown }>(await t.call('/api/settings/detection'))).detector).toEqual(t.validDetector);
    });

    it('deletes a project with its documents and stored files', async () => {
      const blobs = await t.blobCount();
      const entities = await t.entityCount();
      const pid = await newProject('À effacer');
      const id = await addText(pid, ORIGINAL);
      await renderAndRead(id);
      expect(await t.blobCount()).toBeGreaterThan(blobs);
      expect(await t.entityCount()).toBeGreaterThan(entities);
      await t.call(`/api/projects/${pid}`, { method: 'DELETE' });
      expect(await t.blobCount()).toBe(blobs);
      expect(await t.entityCount()).toBe(entities);
      expect((await t.call(`/api/projects/${pid}`)).status).toBe(404);
      expect((await t.call(`/api/documents/${id}`)).status).toBe(404);
    });
  });
}
