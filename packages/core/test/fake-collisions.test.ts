import { describe, expect, it } from 'vitest';
import { collidesWith, collisionKeys, fold, makeFake, seededRng, toValue, type EntityAttrs, type EntityType, type EntityValue, type FakeContext, type FakeKind } from '../src';

/**
 * A fake may not equal a real value of its project, of any kind: drawn again
 * when it would (makeFake with ctx.realKeys), and the draws that don't collide
 * stay exactly what they were.
 */

function ctxFor(seed: number, realKeys?: Set<string>) {
  const taken = new Map<FakeKind, Set<string>>();
  const claimed: string[] = [];
  const ctx: FakeContext = {
    rng: seededRng(seed),
    isTaken: (k, key) => taken.get(k)?.has(key) ?? false,
    claim: (k, key) => {
      if (!taken.has(k)) taken.set(k, new Set());
      taken.get(k)!.add(key);
      claimed.push(`${k}|${key}`);
    },
    realParts: new Set(),
    realKeys,
  };
  return { ctx, claimed };
}

const CASES: Array<{ type: EntityType; text: string; attrs?: EntityAttrs }> = [
  { type: 'person', text: 'Olivier Lamy', attrs: { lang: 'fr', gender: 'm' } },
  { type: 'person', text: 'Lamy' },
  { type: 'address', text: '2215, boulevard des Forges, app. 302, Trois-Rivières' },
  { type: 'postal_code', text: 'G8Z 1V2' },
  { type: 'phone', text: '819 555-2291' },
  { type: 'email', text: 'gilles.roy1958@gmail.example' },
  { type: 'organization', text: 'Usinage St-Maurice inc.' },
  { type: 'dob', text: '17 août 1973' },
  { type: 'date', text: '2026-08-27' },
  { type: 'amount', text: '71 200 $' },
  { type: 'sin', text: '352 018 774' },
  { type: 'card_number', text: '4540 1298 3047 5618' },
  { type: 'health_card', text: 'LAMO 8402 1711' },
  { type: 'bank_account', text: '2049931-88' },
  { type: 'id_number', text: 'HYP-2026-0048317' },
  { type: 'other', text: 'Dossier 77812' },
];

const value = (type: EntityType, text: string): EntityValue => toValue({ type, text });

describe('fakes never equal a real value of their project', () => {
  for (const c of CASES) {
    it(`${c.type}: a draw that would equal a real value is drawn again, the same way for the same seed`, () => {
      const real = value(c.type, c.text);
      for (const seed of [1, 2, 3]) {
        // What this seed draws when nothing is in the way...
        const free = makeFake(c.type, real, c.attrs, ctxFor(seed).ctx).value;
        // ...turned into another real value of the project (its keys, minus the ones it shares with its own real value).
        const own = new Set(collisionKeys(c.type, real));
        const keys = new Set(collisionKeys(c.type, free).filter((k) => !own.has(k)));
        expect(keys.size, `${c.type} ${free.text} has no key of its own`).toBeGreaterThan(0);
        const a = ctxFor(seed, keys);
        const drawn = makeFake(c.type, real, c.attrs, a.ctx);
        expect(collidesWith(c.type, drawn.value, keys), `${c.type}: ${drawn.value.text}`).toBe(false);
        // Only what was kept is claimed, so a rejected fake stays free for others.
        expect(a.claimed).toEqual(drawn.claims.map((x) => `${x.kind}|${x.key}`));
        // Deterministic.
        expect(makeFake(c.type, real, c.attrs, ctxFor(seed, keys).ctx).value).toEqual(drawn.value);
        // And with an unrelated real value in the project, the draw is the free one.
        expect(makeFake(c.type, real, c.attrs, ctxFor(seed, new Set(['zzz-unrelated', 'id:000000000000'])).ctx).value).toEqual(free);
      }
    });
  }

  it('compares numbers across kinds the way the matcher finds them: a phone and an account with the same digits collide', () => {
    expect(collidesWith('phone', value('phone', '(819) 555-0123'), new Set(collisionKeys('bank_account', value('bank_account', '819 555 0123'))))).toBe(true);
    expect(collidesWith('dob', value('dob', '1973-08-17'), new Set(collisionKeys('date', value('date', '17 août 1973'))))).toBe(true);
    expect(collidesWith('amount', value('amount', '17 $'), new Set(collisionKeys('date', value('date', '17 août 1973'))))).toBe(false);
    // A surname against a street or a company: all words the matcher looks for.
    expect(collidesWith('person', value('person', 'Maxime Forges'), new Set(collisionKeys('address', value('address', '2215, boulevard des Forges'))))).toBe(true);
    // Initials are never matched alone, so they don't count.
    expect(collisionKeys('person', value('person', 'O. Lamy')).map(fold)).toEqual(['lamy']);
  });

  it('keeps a fake number two characters or more from every real one, its own included (the page-image check allows one wrong character)', () => {
    const alnum = (s: string) => s.replace(/[^0-9A-Z]/gi, '').toUpperCase();
    const diff = (a: string, b: string) => (a.length !== b.length ? Infinity : [...a].filter((ch, i) => ch !== b[i]).length);
    // Made-up documents use the fictional 555-01XX range, where the fake numbers are drawn too.
    const phones = ['450 555-0164', '450 555-0119', '450 555-0173', '450 555-0187'];
    const keys = new Set(phones.flatMap((t) => collisionKeys('phone', value('phone', t))));
    for (const real of phones) {
      for (const seed of [1, 2, 3, 4, 5]) {
        const fake = makeFake('phone', value('phone', real), undefined, ctxFor(seed, keys).ctx).value.text;
        for (const r of phones) expect(diff(alnum(fake).slice(-10), alnum(r)), `${fake} next to ${r}`).toBeGreaterThan(1);
      }
    }
    const postal = value('postal_code', 'G8Z 1V2');
    for (let seed = 1; seed <= 300; seed++) {
      const fake = makeFake('postal_code', postal, undefined, ctxFor(seed, new Set(collisionKeys('postal_code', postal))).ctx).value.text;
      expect(diff(alnum(fake), 'G8Z1V2'), fake).toBeGreaterThan(1);
    }
  });

  it('gives no one a lone "M." initial unless their own is M (it reads as "Monsieur")', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { ctx } = ctxFor(seed);
      for (const text of ['Olivier Lamy', 'O. Lamy']) {
        const f = makeFake('person', value('person', text), { lang: 'fr', gender: 'm' }, ctx).value.person!;
        expect(fold(f.first!)[0], `${seed}: ${f.first}`).not.toBe('m');
      }
    }
  });
});

describe('keepCivic', () => {
  it('changes only the street name, a range included', () => {
    for (const text of ['70-72, rue Sainte-Anne, Baie-Saint-Paul', '1842, rue des Érables, app. 4, Laval']) {
      const { ctx } = ctxFor(3);
      const fake = makeFake('address', value('address', text), undefined, { ...ctx, keepCivic: true }).value;
      const civic = text.split(',')[0]!;
      expect(fake.text.startsWith(`${civic}, `), fake.text).toBe(true);
      expect(fake.address?.civic).toBe(civic);
      expect(fold(fake.address!.streetName!)).not.toBe(fold(text.split(', ')[1]!.replace(/^rue (des )?/, '')));
      expect(fake.text).not.toContain(text.split(', ')[1]!);
    }
  });

  it('still changes the number when there is no street name to change', () => {
    const { ctx } = ctxFor(3);
    const real = { text: '70', address: { civic: '70' } };
    expect(makeFake('address', real, undefined, { ...ctx, keepCivic: true }).value.text).not.toBe('70');
  });
});
