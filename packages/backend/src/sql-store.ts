import { NORM_VERSION, type EntityAttrs, type EntityType, type EntityValue, type FakeKind, type SealedReal } from '@anon/core';
import type { LoadedEntity } from '@anon/pipeline';
import { cleanDetector, parseDetector } from './detector';
import { newId } from './entities';
import { ConflictError, type Db, type Detector, type DocPatch, type DocRow, type EntityWrites, type NewDoc, type Param, type ProfileEntry, type ProjectRow, type ProjectSummary, type Store } from './platform';

/**
 * The desktop's store: one user, the schema in ../migrations, over SQLCipher
 * (through Rust) or node:sqlite in tests. The whole file is encrypted, so
 * real values are stored as plain JSON and value keys as they are.
 */

interface EntityDbRow {
  id: string;
  project_id: string;
  type: EntityType;
  real: string;
  real_key: string;
  fake: string;
  aliases: string;
  attrs: string;
  enabled: number;
  frozen_at: number | null;
}

type DocDbRow = Omit<DocRow, 'file_sealed' | 'phase'>;

function rowToEntity(r: EntityDbRow): LoadedEntity {
  const real = JSON.parse(r.real) as SealedReal;
  return {
    id: r.id,
    type: r.type,
    real: real.real,
    surfaces: real.surfaces,
    mentions: real.mentions,
    fake: JSON.parse(r.fake) as EntityValue,
    aliases: JSON.parse(r.aliases) as EntityValue[],
    attrs: JSON.parse(r.attrs) as EntityAttrs,
    enabled: r.enabled === 1,
    projectId: r.project_id,
    frozen: r.frozen_at !== null,
  };
}

const toDoc = (r: DocDbRow): DocRow => ({ ...r, file_sealed: true });

export class SqlStore implements Store {
  constructor(readonly db: Db) {}

  async getDetector(): Promise<Detector> {
    const row = (await this.db.all<{ value: string }>("SELECT value FROM settings WHERE key = 'detector'"))[0];
    // Until a model is picked: fast detection (rules and the engine's small model).
    return parseDetector(row?.value, { engine: 'none' });
  }

  async setDetector(detector: Detector): Promise<void> {
    await this.db.run(
      `INSERT INTO settings (key, value) VALUES ('detector', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
      [JSON.stringify(cleanDetector(detector))],
    );
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const rows = await this.db.all<{ id: string; name: string; created_at: number; documents: number }>(
      `SELECT p.id, p.name, p.created_at,
              (SELECT COUNT(*) FROM documents d WHERE d.project_id = p.id AND d.parent_id IS NULL) AS documents
         FROM projects p ORDER BY p.created_at DESC, p.rowid DESC`,
    );
    return rows.map((r) => ({ ...r, role: 'owner', members: 1 }));
  }

  async getProject(id: string): Promise<ProjectRow | null> {
    const r = (await this.db.all<{ id: string; name: string; created_at: number }>('SELECT id, name, created_at FROM projects WHERE id = ?', [id]))[0];
    return r ? { ...r, role: 'owner' } : null;
  }

  async createProject(name: string): Promise<string> {
    const id = newId();
    await this.db.run('INSERT INTO projects (id, name) VALUES (?, ?)', [id, name]);
    return id;
  }

  async renameProject(id: string, name: string): Promise<void> {
    await this.db.run('UPDATE projects SET name = ? WHERE id = ?', [name, id]);
  }

  async deleteProject(id: string): Promise<void> {
    await this.db.run('DELETE FROM projects WHERE id = ?', [id]);
  }

  async loadEntities(projectIds: string[]): Promise<LoadedEntity[]> {
    const out: LoadedEntity[] = [];
    for (let i = 0; i < projectIds.length; i += 50) {
      const slice = projectIds.slice(i, i + 50);
      const rows = await this.db.all<EntityDbRow>(`SELECT * FROM entities WHERE project_id IN (${slice.map(() => '?').join(',')}) ORDER BY created_at, rowid`, slice);
      out.push(...rows.map(rowToEntity));
    }
    return out;
  }

  async entityIndex(projectId: string): Promise<Map<string, string>> {
    const rows = await this.db.all<{ id: string; type: string; real_key: string }>('SELECT id, type, real_key FROM entities WHERE project_id = ? AND norm_v = ?', [
      projectId,
      NORM_VERSION,
    ]);
    return new Map(rows.map((r) => [`${r.type}|${r.real_key}`, r.id]));
  }

  async indexKey(_projectId: string, _type: EntityType, key: string): Promise<string> {
    return key;
  }

  async loadClaims(projectId: string): Promise<Map<FakeKind, Set<string>>> {
    const rows = await this.db.all<{ kind: FakeKind; key: string }>("SELECT kind, key FROM fake_claims WHERE scope = '' OR scope = ?", [projectId]);
    const out = new Map<FakeKind, Set<string>>();
    for (const r of rows) {
      if (!out.has(r.kind)) out.set(r.kind, new Set());
      out.get(r.kind)!.add(r.key);
    }
    return out;
  }

  async writeEntities(projectId: string, w: EntityWrites): Promise<void> {
    const stmts: Array<{ sql: string; params: Param[] }> = [];
    for (const s of w.reals) stmts.push({ sql: 'UPDATE entities SET real = ? WHERE id = ? AND project_id = ?', params: [JSON.stringify(s.real), s.id, projectId] });
    for (const f of w.fakes) {
      stmts.push({ sql: 'UPDATE entities SET fake = ?, aliases = ? WHERE id = ? AND project_id = ?', params: [JSON.stringify(f.fake), JSON.stringify(f.aliases), f.id, projectId] });
    }
    for (const e of w.inserts) {
      stmts.push({
        sql: 'INSERT INTO entities (id, project_id, type, real, real_key, norm_v, fake, attrs, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params: [e.id, projectId, e.type, JSON.stringify(e.real), e.indexKey, NORM_VERSION, JSON.stringify(e.fake), JSON.stringify(e.attrs), e.enabled ? 1 : 0],
      });
    }
    for (const c of w.claims) stmts.push({ sql: 'INSERT INTO fake_claims (kind, scope, key, entity_id) VALUES (?, ?, ?, ?)', params: [c.kind, c.scope, c.key, c.entityId] });
    try {
      await this.db.batch(stmts);
    } catch (err) {
      if (/UNIQUE/i.test(String(err))) throw new ConflictError(String(err));
      throw err;
    }
  }

  async setEntity(projectId: string, id: string, patch: { enabled?: boolean; fake?: EntityValue; aliases?: EntityValue[] }): Promise<void> {
    if (patch.enabled !== undefined) await this.db.run('UPDATE entities SET enabled = ? WHERE id = ? AND project_id = ?', [patch.enabled ? 1 : 0, id, projectId]);
    if (patch.fake) {
      await this.db.run('UPDATE entities SET fake = ?, aliases = ? WHERE id = ? AND project_id = ?', [JSON.stringify(patch.fake), JSON.stringify(patch.aliases ?? []), id, projectId]);
    }
  }

  async deleteEntity(projectId: string, id: string): Promise<void> {
    await this.db.run('DELETE FROM entities WHERE id = ? AND project_id = ? AND frozen_at IS NULL', [id, projectId]);
  }

  async freezeEntitiesOf(docId: string): Promise<void> {
    await this.db.run('UPDATE entities SET frozen_at = unixepoch() WHERE frozen_at IS NULL AND id IN (SELECT entity_id FROM document_entities WHERE document_id = ?)', [docId]);
  }

  async insertDoc(d: NewDoc): Promise<void> {
    await this.db.run(
      `INSERT INTO documents (id, project_id, kind, parent_id, filename, out_name, mime, size, file_key, text_key, fields_key, work_key, work_mime, status, steps)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        d.id,
        d.projectId,
        d.kind,
        d.parentId ?? null,
        d.filename,
        d.outName ?? null,
        d.mime,
        d.size,
        d.fileKey,
        d.textKey ?? null,
        d.fieldsKey ?? null,
        d.workKey ?? null,
        d.workMime ?? null,
        d.status,
        JSON.stringify(d.steps ?? {}),
      ],
    );
  }

  async getDoc(id: string): Promise<DocRow | null> {
    const r = (await this.db.all<DocDbRow>('SELECT * FROM documents WHERE id = ?', [id]))[0];
    return r ? toDoc(r) : null;
  }

  async listDocs(projectId: string): Promise<DocRow[]> {
    const rows = await this.db.all<DocDbRow>('SELECT * FROM documents WHERE project_id = ? ORDER BY created_at DESC, rowid DESC', [projectId]);
    return rows.map(toDoc);
  }

  async outputsOf(docId: string) {
    return this.db.all<{ id: string; kind: string; created_at: number; out_name: string | null }>(
      'SELECT id, kind, created_at, out_name FROM documents WHERE parent_id = ? ORDER BY created_at DESC, rowid DESC',
      [docId],
    );
  }

  async updateDoc(id: string, patch: DocPatch): Promise<void> {
    const sets: string[] = ['updated_at = unixepoch()'];
    const vals: Param[] = [];
    const set = (col: string, v: Param) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.error !== undefined) set('error', patch.error);
    if (patch.steps !== undefined) set('steps', JSON.stringify(patch.steps));
    if (patch.review !== undefined) set('review', JSON.stringify(patch.review));
    if (patch.textKey !== undefined) set('text_key', patch.textKey);
    if (patch.fieldsKey !== undefined) set('fields_key', patch.fieldsKey);
    if (patch.workKey !== undefined) set('work_key', patch.workKey);
    if (patch.workMime !== undefined) set('work_mime', patch.workMime);
    await this.db.run(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
  }

  async deleteDocs(ids: string[]): Promise<string[]> {
    const keys: string[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const slice = ids.slice(i, i + 50);
      const marks = slice.map(() => '?').join(',');
      const rows = await this.db.all<{ file_key: string | null; text_key: string | null; work_key: string | null; fields_key: string | null }>(
        `SELECT file_key, text_key, work_key, fields_key FROM documents WHERE id IN (${marks}) OR parent_id IN (${marks})`,
        [...slice, ...slice],
      );
      for (const r of rows) for (const k of [r.file_key, r.text_key, r.work_key, r.fields_key]) if (k) keys.push(k);
      await this.db.run(`DELETE FROM documents WHERE id IN (${marks}) OR parent_id IN (${marks})`, [...slice, ...slice]);
    }
    return keys;
  }

  async setDocEntities(docId: string, hits: Record<string, number>): Promise<void> {
    await this.db.batch([
      { sql: 'DELETE FROM document_entities WHERE document_id = ?', params: [docId] },
      ...Object.entries(hits).map(([entityId, n]) => ({ sql: 'INSERT INTO document_entities (document_id, entity_id, hits) VALUES (?, ?, ?)', params: [docId, entityId, n] })),
    ]);
  }

  async waitingDocs(limit = 1000) {
    return this.db.all<{ id: string; project_id: string }>("SELECT id, project_id FROM documents WHERE status = 'waiting' ORDER BY updated_at LIMIT ?", [limit]);
  }

  async markUploaded(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 100) {
      const slice = ids.slice(i, i + 100);
      await this.db.run(`UPDATE documents SET status = 'uploaded', updated_at = unixepoch() WHERE id IN (${slice.map(() => '?').join(',')})`, slice);
    }
  }

  async countWaiting(): Promise<number> {
    return (await this.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM documents WHERE status = 'waiting'"))[0]?.n ?? 0;
  }

  async loadProfile(): Promise<ProfileEntry[]> {
    const rows = await this.db.all<{ id: string; type: EntityType; real: string }>('SELECT id, type, real FROM profile_entities ORDER BY created_at, rowid');
    return rows.map((r) => ({ id: r.id, type: r.type, real: JSON.parse(r.real) as EntityValue }));
  }

  async addProfileEntry(type: EntityType, real: EntityValue): Promise<string> {
    const id = newId();
    await this.db.run('INSERT INTO profile_entities (id, type, real) VALUES (?, ?, ?)', [id, type, JSON.stringify(real)]);
    return id;
  }

  async deleteProfileEntry(id: string): Promise<void> {
    await this.db.run('DELETE FROM profile_entities WHERE id = ?', [id]);
  }

  /**
   * After unlock (desktop only): analyses the app was running when it quit
   * start over, renders cut short go back to review. Returns the documents to
   * queue, oldest first, waiting ones included.
   */
  async recoverInterrupted(): Promise<{ cut: number; renders: number; queue: Array<{ id: string; project_id: string }> }> {
    const cut = await this.db.run("UPDATE documents SET status = 'uploaded', updated_at = unixepoch() WHERE status = 'analyzing'");
    const renders = await this.db.run("UPDATE documents SET status = 'needs_review', error = 'render_interrupted', updated_at = unixepoch() WHERE status = 'rendering'");
    const queue = await this.db.all<{ id: string; project_id: string }>("SELECT id, project_id FROM documents WHERE status IN ('uploaded', 'waiting') AND kind = 'source' ORDER BY created_at");
    return { cut: cut.changes, renders: renders.changes, queue };
  }
}
