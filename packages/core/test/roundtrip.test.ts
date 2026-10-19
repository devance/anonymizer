import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyMatches,
  detectRegex,
  findMatches,
  makeFake,
  mergeDetections,
  renderDate,
  seededRng,
  valueParts,
  type Detection,
  type Entity,
  type FakeContext,
  type FakeKind,
} from '../src';

const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/text/${name}`, import.meta.url), 'utf8');
const ORIGINAL = fixture('assurance-habitation.txt');

/** What Claude would return for the fixture. */
const CLAUDE: Detection[] = [
  { type: 'person', text: 'Jean-François Tremblay', groupKey: 'p1', person: { first: 'Jean-François', last: 'Tremblay' }, attrs: { gender: 'm', lang: 'fr' }, source: 'claude' },
  { type: 'person', text: 'J.-F. Tremblay', groupKey: 'p1', source: 'claude' },
  { type: 'person', text: 'Isabelle Côté', groupKey: 'p2', person: { first: 'Isabelle', last: 'Côté' }, attrs: { gender: 'f' }, source: 'claude' },
  { type: 'person', text: 'Côté', groupKey: 'p2', source: 'claude' },
  { type: 'person', text: 'Nathalie Bergeron', groupKey: 'p3', person: { first: 'Nathalie', last: 'Bergeron' }, attrs: { gender: 'f' }, source: 'claude' },
  {
    type: 'address',
    text: '1842, rue des Érables, app. 3, Laval (Québec) H7N 2K4',
    address: { civic: '1842', streetType: 'rue', particle: 'des', streetName: 'Érables', unit: '3', city: 'Laval', province: 'Québec' },
    source: 'claude',
  },
  { type: 'id_number', text: 'HAB-48210937', source: 'claude' },
];

function buildEntities(text: string, seed: number): Entity[] {
  const cands = mergeDetections([...detectRegex(text), ...CLAUDE]);
  const taken = new Map<FakeKind, Set<string>>();
  const realParts = new Set(cands.flatMap((c) => valueParts(c.type, c.real)));
  const people: NonNullable<FakeContext['people']> = [];
  const ctx: FakeContext = {
    rng: seededRng(seed),
    isTaken: (k, key) => taken.get(k)?.has(key) ?? false,
    claim: (k, key) => {
      if (!taken.has(k)) taken.set(k, new Set());
      taken.get(k)!.add(key);
    },
    realParts,
    people,
  };
  // People first, so emails can follow their owner's fake name.
  const ordered = [...cands].sort((a, b) => (a.type === 'person' ? -1 : 0) - (b.type === 'person' ? -1 : 0));
  return ordered.map((c, i) => {
    const { value } = makeFake(c.type, c.real, c.attrs, ctx);
    if (c.type === 'person' && c.real.person && value.person) people.push({ real: c.real.person, fake: value.person });
    return { id: `e${i}`, type: c.type, real: c.real, fake: value, attrs: c.attrs, surfaces: c.surfaces, enabled: true };
  });
}

const REAL_STRINGS = [
  'Tremblay',
  'Côté',
  'Bergeron',
  'Érables',
  '1842',
  '662-1934',
  '555 2290',
  'H7N 2K4',
  '046 454 286',
  '48210937',
  'jf.tremblay',
  'nbergeron',
  'videotron',
  '14 mars 1981',
  'Jean-François',
  'J.-F.',
];

describe('anonymize → restore round trip', () => {
  for (const seed of [1, 2, 3, 42, 1234]) {
    it(`seed ${seed}: removes every real value and restores the original exactly`, () => {
      const entities = buildEntities(ORIGINAL, seed);
      const anon = applyMatches(ORIGINAL, findMatches(ORIGINAL, entities, 'anonymize'));
      for (const s of REAL_STRINGS) expect(anon, `leaked "${s}"\n${anon}`).not.toContain(s);
      const restored = applyMatches(anon, findMatches(anon, entities, 'restore'));
      expect(restored).toBe(ORIGINAL);
    });
  }

  it('fakes never reuse a real name or street', () => {
    for (const seed of [5, 6, 7, 8, 9]) {
      const entities = buildEntities(ORIGINAL, seed);
      const fakes = entities.map((e) => e.fake.text.toLowerCase()).join(' | ');
      for (const s of ['tremblay', 'côté', 'bergeron', 'érables']) expect(fakes).not.toContain(s);
    }
  });
});

describe('restoring a document the tool has never seen', () => {
  const template = fixture('assurance-habitation.ai-rewrite.template.txt');

  function fill(entities: Entity[], side: 'real' | 'fake'): string {
    const get = (pred: (e: Entity) => boolean) => entities.find(pred)![side];
    const p1 = get((e) => e.type === 'person' && e.real.person?.last === 'Tremblay').person!;
    const p2 = get((e) => e.type === 'person' && e.real.person?.last === 'Côté').person!;
    const p3 = get((e) => e.type === 'person' && e.real.person?.last === 'Bergeron').person!;
    const addr = get((e) => e.type === 'address').address!;
    const phones = entities.filter((e) => e.type === 'phone');
    const ph1 = phones.find((e) => e.real.text.includes('662'))![side].text.replace(/\D/g, '');
    const ph2 = phones.find((e) => e.real.text.includes('2290'))![side].text.replace(/\D/g, '');
    const email = get((e) => e.type === 'email' && e.real.text.startsWith('jf.')).text;
    const dob = get((e) => e.type === 'dob').iso!;
    const vars: Record<string, string> = {
      P1_FULL: `${p1.first} ${p1.last}`,
      P1_FIRST: p1.first!,
      P1_LAST: p1.last!,
      P1_LAST_UPPER: p1.last!.toUpperCase(),
      P2_LAST: p2.last!,
      P3_FULL: `${p3.first} ${p3.last}`,
      POLICY: get((e) => e.type === 'id_number').text,
      CIVIC: addr.civic!,
      STREET_NAME: addr.streetName!,
      PHONE1_ALT: `${ph1.slice(0, 3)}.${ph1.slice(3, 6)}.${ph1.slice(6)}`,
      PHONE2_ALT: `(${ph2.slice(0, 3)}) ${ph2.slice(3, 6)}-${ph2.slice(6)}`,
      EMAIL: email,
      DOB_EN: renderDate(dob, { kind: 'month_d_y', monthLang: 'en', monthForm: 'full', monthCase: 'title', comma: true }),
    };
    return template.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => vars[k]!);
  }

  for (const seed of [1, 2, 3, 42, 1234]) {
    it(`seed ${seed}: restores reworded, reformatted and translated mentions`, () => {
      const entities = buildEntities(ORIGINAL, seed);
      const outside = fill(entities, 'fake');
      const expected = fill(entities, 'real');
      const matches = findMatches(outside, entities, 'restore');
      expect(matches.every((m) => m.confidence === 'high'), JSON.stringify(matches.filter((m) => m.confidence === 'low'))).toBe(true);
      expect(applyMatches(outside, matches)).toBe(expected);
    });
  }
});

describe('fake pools running out', () => {
  // Claims are unique across the whole database, so a long-lived one exhausts the small pools.
  function sharedCtx(seed: number) {
    const taken = new Map<FakeKind, Set<string>>();
    const claimed: string[] = [];
    const ctx: FakeContext = {
      rng: seededRng(seed),
      isTaken: (k, key) => taken.get(k)?.has(key) ?? false,
      claim: (k, key) => {
        if (taken.get(k)?.has(key)) throw new Error(`claimed twice: ${k} ${key}`);
        if (!taken.has(k)) taken.set(k, new Set());
        taken.get(k)!.add(key);
        claimed.push(`${k}|${key}`);
      },
      realParts: new Set(),
    };
    return { ctx, claimed };
  }

  it('keeps giving street names without a civic number, unique while the reserve lasts', () => {
    const { ctx } = sharedCtx(1);
    const names = Array.from({ length: 400 }, () => makeFake('address', { text: 'rue Principale' }, undefined, ctx).value.text);
    expect(new Set(names.slice(0, 300)).size).toBe(300);
  });

  it('keeps giving organizations past the pool, single names then joined ones', () => {
    const { ctx } = sharedCtx(2);
    const orgs = Array.from({ length: 450 }, () => makeFake('organization', { text: 'Assurances Mirador inc.' }, undefined, ctx).value.text);
    expect(new Set(orgs.slice(0, 380)).size).toBe(380);
    expect(orgs.every((o) => o.startsWith('Assurances ') && o.endsWith(' inc.'))).toBe(true);
  });

  it('keeps giving people past the surname and first name pools', () => {
    const { ctx } = sharedCtx(3);
    for (let i = 0; i < 200; i++) makeFake('person', { text: 'Craig Dunmore' }, { lang: 'en', gender: 'm' }, ctx);
    for (let i = 0; i < 120; i++) makeFake('person', { text: 'Louise', person: { first: 'Louise' } }, { lang: 'fr', gender: 'f' }, ctx);
  });
});

describe('values with nothing a shape-preserving fake may keep', () => {
  // These used to retry forever: in WebKit the retry was a tail call, so the app hung instead of failing.
  it('changes short all-letter values and terminates', () => {
    const ctx: FakeContext = { rng: seededRng(4), isTaken: () => false, claim: () => {}, realParts: new Set() };
    for (const [type, text] of [['other', 'RAMQ'], ['id_number', 'N/A'], ['bank_account', 'BMO'], ['dob', 'mai'], ['other', 'x']] as const) {
      const fake = makeFake(type, { text }, undefined, ctx).value.text;
      expect(fake).not.toBe(text);
      expect(fake).toHaveLength(text.length);
    }
    expect(makeFake('other', { text: '--' }, undefined, ctx).value.text).toBe('--');
  });
});

describe('OCR\'d dates', () => {
  it('replaces a date of birth the OCR misread, with a real date of the same year', () => {
    const text = 'Étienne Lebeau, né le l5 janvier 1975, domicilié à Laval. Born on Apri1 12, 1966.';
    const cands = mergeDetections([
      { type: 'dob', text: 'l5 janvier 1975', source: 'claude' },
      { type: 'dob', text: 'Apri1 12, 1966', source: 'claude' },
    ]);
    expect(cands.map((c) => c.real.iso)).toEqual(['1975-01-15', '1966-04-12']);
    const taken = new Map<FakeKind, Set<string>>();
    const ctx: FakeContext = {
      rng: seededRng(5),
      isTaken: (k, key) => taken.get(k)?.has(key) ?? false,
      claim: (k, key) => void (taken.get(k) ?? taken.set(k, new Set()).get(k)!).add(key),
      realParts: new Set(),
    };
    const entities: Entity[] = cands.map((c, i) => ({ id: `e${i}`, type: c.type, real: c.real, fake: makeFake(c.type, c.real, c.attrs, ctx).value, surfaces: c.surfaces, enabled: true }));
    expect(entities[0]!.fake.text).toMatch(/^\d{1,2} \p{L}+ 1975$/u);
    const out = applyMatches(text, findMatches(text, entities, 'anonymize'));
    expect(out).not.toContain('l5 janvier');
    expect(out).not.toContain('Apri1 12');
    expect(out).toContain(entities[0]!.fake.text);
    // Restoring writes the real date in the fake's format, so the OCR typo comes back corrected.
    const back = applyMatches(out, findMatches(out, entities, 'restore'));
    expect(back).toBe('Étienne Lebeau, né le 15 janvier 1975, domicilié à Laval. Born on April 12, 1966.');
  });
});

describe('values a model reports loosely', () => {
  const ctx = (): FakeContext => {
    const taken = new Map<FakeKind, Set<string>>();
    return {
      rng: seededRng(9),
      isTaken: (k, key) => taken.get(k)?.has(key) ?? false,
      claim: (k, key) => void (taken.get(k) ?? taken.set(k, new Set()).get(k)!).add(key),
      realParts: new Set(),
    };
  };
  const anonymize = (text: string, dets: Detection[]) => {
    const c = ctx();
    const entities: Entity[] = mergeDetections(dets).map((d, i) => ({ id: `e${i}`, type: d.type, real: d.real, fake: makeFake(d.type, d.real, d.attrs, c).value, surfaces: d.surfaces, enabled: true }));
    return applyMatches(text, findMatches(text, entities, 'anonymize'));
  };

  it('replaces the street even when the model rewrote its name', () => {
    const text = 'Dwelling located at 4388 Sherbrooke Street West, apartment 6, Westmount (Quebec) H3Z 1E1, with one parking space.';
    const out = anonymize(text, [
      {
        type: 'address',
        text: '4388 Sherbrooke Street West, apartment 6, Westmount (Quebec) H3Z 1E1',
        address: { civic: '4388', streetType: 'Street', streetName: 'Sherbrooke West', unit: 'apartment 6', city: 'Westmount' },
        source: 'claude',
      },
    ]);
    expect(out).not.toContain('Sherbrooke');
    expect(out).not.toContain('4388');
    expect(out).toMatch(/Street West, apartment 6, Westmount/);
  });

  it('keeps the name letters of a Quebec health card, with or without a label', () => {
    for (const reported of ['TREJ 6604 1215', 'RAMQ TREJ 6604 1215', '6604 1215']) {
      const text = 'Carte RAMQ : TREJ 6604 1215, exp. 2027.';
      const out = anonymize(text, [...detectRegex(text), { type: 'health_card', text: reported, source: 'claude' }]);
      expect(out).not.toContain('TREJ');
      expect(out).toMatch(/^Carte RAMQ : [A-Z]{4} \d{4} \d{4}, exp\. 2027\.$/);
    }
  });

  it('replaces an identifier reported with its label and context', () => {
    const text = 'Re: Purchase of 12 Elm Crescent, Beaconsfield (Lot 1 975 432, Cadastre of Québec). Transit 04512, Institution 828.';
    const out = anonymize(text, [
      { type: 'id_number', text: 'Lot 1 975 432, Cadastre of Québec', source: 'claude' },
      { type: 'bank_account', text: 'Transit 04512, Institution 828', source: 'claude' },
    ]);
    expect(out).not.toContain('1 975 432');
    expect(out).toContain('Cadastre of Québec');
    expect(out).toMatch(/\(Lot \d \d{3} \d{3}, Cadastre/);
    expect(out).not.toContain('04512');
    expect(out).not.toMatch(/Institution 828\b/);
  });
});


describe('name pieces that are common words', () => {
  const entity = (id: string, real: string, fake: string): Entity => ({
    id,
    type: 'person',
    real: { text: real },
    fake: { text: fake },
    surfaces: [real],
    enabled: true,
  });
  const run = (text: string, entities: Entity[]) => applyMatches(text, findMatches(text, entities, 'anonymize'));

  it('never turns every "le" into a surname when a person was read as "Paul Gagnon le"', () => {
    const text = "Paul Gagnon le 12 octobre 2010 au mesurage, le 14 octobre 2010 ainsi que le 30 septembre 2011. M. Gagnon a signé.";
    const out = run(text, [entity('p', 'Paul Gagnon le', 'Marc Cyr')]);
    expect(out).toContain('le 14 octobre 2010 ainsi que le 30 septembre');
    // Only the full mention of the broken person is swapped; no other "le".
    expect(out.match(/cyr/gi) ?? []).toHaveLength(1);
  });

  it('leaves the month alone when a first name is one', () => {
    const text = 'May Chen signed on May 12, 2026. Thanks, May.';
    const out = run(text, [entity('m', 'May Chen', 'Lisa Wong')]);
    expect(out).toBe('Lisa Wong signed on May 12, 2026. Thanks, May.');
  });

  it('matches a short surname alone only after a title', () => {
    const text = 'Rachel Ng signe. Mr. Ng agrees. Ng cells are not people. Do not sign, Mme Do said.';
    const out = run(text, [entity('a', 'Rachel Ng', 'Lisa Wu'), entity('b', 'Anne Do', 'Rose Ly')]);
    expect(out).toContain('Lisa Wu signe. Mr. Wu agrees. Ng cells');
    expect(out).toContain('Do not sign, Mme Ly said.');
  });
});
