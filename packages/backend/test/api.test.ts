import { describe, expect, it } from 'vitest';
import { model } from './fakes';
import { testBackend } from './helpers';
import { apiSuite, DETECTED, ORIGINAL } from './suite';

// The behaviour both targets share, on the desktop's platform. web/worker/test runs the same suite on the web's.
describe('desktop', () => {
  apiSuite(async () => testBackend().harness);
});

describe('desktop only', () => {
  it('reads an Ollama setting from an older version as fast detection only', async () => {
    const t = testBackend();
    await t.db.run("INSERT INTO settings (key, value) VALUES ('detector', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [JSON.stringify({ engine: 'ollama', model: 'gemma4:26b' })]);
    expect(((await (await t.call('/api/settings/detection')).json()) as { detector: unknown }).detector).toEqual({ engine: 'none' });
  });

  it('recovers jobs cut short when the app quit', async () => {
    model.detect = DETECTED;
    const t = testBackend();
    const { id: pid } = (await (await t.call('/api/projects', { method: 'POST', json: { name: 'Interrompu' } })).json()) as { id: string };
    const add = async (text: string) => {
      const { id } = (await (await t.call(`/api/projects/${pid}/documents`, { method: 'POST', json: { text } })).json()) as { id: string };
      await t.jobs.idle();
      return id;
    };
    const id = await add(ORIGINAL);
    await t.db.run("UPDATE documents SET status = 'rendering' WHERE id = ?", [id]);
    const other = await add('Jean-François Tremblay');
    await t.db.run("UPDATE documents SET status = 'analyzing', steps = '{}' WHERE id = ?", [other]);
    await t.recover();
    await t.jobs.idle();
    const a = (await (await t.call(`/api/documents/${id}`)).json()) as { document: { status: string; error: string } };
    expect(a.document).toMatchObject({ status: 'needs_review', error: 'render_interrupted' });
    expect(((await (await t.call(`/api/documents/${other}`)).json()) as { document: { status: string } }).document.status).toBe('needs_review');
    const log = t.logs.join('\n');
    for (const step of ['analyze started', 'finished in', 'recovery:']) expect(log).toContain(step);
  });

  it('keeps every value in the one encrypted file: real values in plain JSON, keys as they are', async () => {
    model.detect = DETECTED;
    const t = testBackend();
    await t.call('/api/settings/detection', { method: 'PUT', json: { engine: 'builtin', model: 'gemma4-e4b' } });
    const { id: pid } = (await (await t.call('/api/projects', { method: 'POST', json: { name: 'Clair' } })).json()) as { id: string };
    await t.call(`/api/projects/${pid}/documents`, { method: 'POST', json: { text: ORIGINAL } });
    await t.jobs.idle();
    const rows = await t.db.all<{ real: string; real_key: string }>("SELECT real, real_key FROM entities WHERE type = 'person'");
    expect(rows.some((r) => r.real.includes('Jean-François Tremblay') && r.real_key.includes('tremblay'))).toBe(true);
  });
});
