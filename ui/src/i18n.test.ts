import { beforeAll, describe, expect, it } from 'vitest';
import { ENTITY_TYPES } from './entity-types';
import { webCopy } from './web/copy';

type I18n = typeof import('./i18n');
let i18n: I18n;

// i18n.ts reads the system language and sets <html lang> when it loads: give it the bare minimum.
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.document ??= { documentElement: {}, title: '' };
  g.navigator ??= { languages: ['fr-CA'], language: 'fr-CA' };
  i18n = await import('./i18n');
});

/** Every entry as text: functions are called with sample values, for one and for several. */
function texts(dict: Record<string, string | ((v: Record<string, string | number>) => string)>): Array<[string, string]> {
  const sample = (n: number) =>
    new Proxy({} as Record<string, string | number>, {
      get: (_, k) => (['n', 'c', 'total'].includes(String(k)) ? n : `«${String(k)}»`),
    });
  return Object.entries(dict).flatMap(([key, entry]) =>
    typeof entry === 'function' ? [1, 2].map((n): [string, string] => [key, entry(sample(n))]) : [[key, entry] as [string, string]],
  );
}

describe('i18n', () => {
  it('has the same keys in French and English', () => {
    const fr = Object.keys(i18n.messages.fr).sort();
    const en = Object.keys(i18n.messages.en).sort();
    expect(en.filter((k) => !fr.includes(k))).toEqual([]);
    expect(fr.filter((k) => !en.includes(k))).toEqual([]);
  });

  it('uses no em dash, en dash or spaced hyphen', () => {
    for (const lang of ['fr', 'en'] as const) {
      const bad = texts(i18n.messages[lang]).filter(([, text]) => /[—–]| - /.test(text));
      expect(bad.map(([key, text]) => `${lang} ${key}: ${text}`)).toEqual([]);
    }
  });

  it('has no empty entries', () => {
    for (const lang of ['fr', 'en'] as const) {
      expect(texts(i18n.messages[lang]).filter(([, text]) => !text.trim()).map(([key]) => `${lang} ${key}`)).toEqual([]);
    }
  });

  it('has every key the code asks for', () => {
    const sources = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const used = new Set<string>();
    for (const [file, code] of Object.entries(sources)) {
      if (file.endsWith('.test.ts')) continue;
      for (const m of code.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(100);
    // Keys built at run time: entity types, document kinds and states, tabs, where a leak was found.
    for (const type of ENTITY_TYPES) used.add(`type.${type}`);
    for (const kind of ['source', 'anonymized', 'external', 'restored']) used.add(`kind.${kind}`);
    for (const st of ['uploaded', 'analyzing', 'waiting', 'needs_review', 'rendering', 'ready', 'failed']) used.add(`status.${st}`);
    for (const tab of ['documents', 'values', 'members']) used.add(`tab.${tab}`);
    for (const where of ['text', 'links/fields', 'metadata', 'barcode', 'page image', 'filename']) used.add(`where.${where}`);
    const keys = new Set(Object.keys(i18n.messages.fr));
    expect([...used].filter((k) => !keys.has(k))).toEqual([]);
  });

  it('only overrides keys that exist, for the web build, under the same rules', () => {
    const keys = new Set(Object.keys(i18n.messages.fr));
    for (const lang of ['fr', 'en'] as const) {
      const dict = (webCopy[lang] ?? {}) as Record<string, string | ((v: Record<string, string | number>) => string)>;
      expect(Object.keys(dict).filter((k) => !keys.has(k))).toEqual([]);
      expect(texts(dict).filter(([, text]) => /[—–]| - /.test(text) || !text.trim())).toEqual([]);
    }
    expect(Object.keys(webCopy.fr ?? {}).sort()).toEqual(Object.keys(webCopy.en ?? {}).sort());
  });
});
