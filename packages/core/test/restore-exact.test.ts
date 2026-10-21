import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyMatches,
  collisionKeys,
  detectRegex,
  findMatches,
  makeFake,
  MAX_MENTION_LOGS,
  mentionsOf,
  mergeDetections,
  seededRng,
  valueParts,
  withMentions,
  type Detection,
  type Entity,
  type EntityType,
  type FakeContext,
  type FakeKind,
  type Match,
} from '../src';

/**
 * Restoring an output the tool wrote gives back the original exactly, as it
 * was written: the initial of "O. Lamy" (whose fake "M. Soucy" reads like
 * "Monsieur Soucy"), "Margaret" where the value was first seen as "MARGARET",
 * an OCR'd "l7" (not "17"), the spaces between the columns of a signature
 * line. The anonymized output's own matches are logged with each value
 * (mentionsOf → MentionLog) and restore puts back what they replaced.
 */

const FIXTURES = new URL('../../../fixtures/', import.meta.url);

function build(dets: Detection[], seed = 7): Entity[] {
  const cands = mergeDetections(dets);
  const taken = new Map<FakeKind, Set<string>>();
  const people: NonNullable<FakeContext['people']> = [];
  const ctx: FakeContext = {
    rng: seededRng(seed),
    isTaken: (k, key) => taken.get(k)?.has(key) ?? false,
    claim: (k, key) => {
      if (!taken.has(k)) taken.set(k, new Set());
      taken.get(k)!.add(key);
    },
    realParts: new Set(cands.flatMap((c) => valueParts(c.type, c.real))),
    realKeys: new Set(cands.flatMap((c) => collisionKeys(c.type, c.real))),
    people,
  };
  const ordered = [...cands].sort((a, b) => (a.type === 'person' ? -1 : 0) - (b.type === 'person' ? -1 : 0));
  return ordered.map((c, i) => {
    const { value } = makeFake(c.type, c.real, c.attrs, ctx);
    if (c.type === 'person' && c.real.person && value.person) people.push({ real: c.real.person, fake: value.person });
    return { id: `e${i}`, type: c.type, real: c.real, fake: value, attrs: c.attrs, surfaces: c.surfaces, enabled: true };
  });
}

/** What the review checks by default when restoring: the sure hits. */
const restoreChecked = (ms: Match[]) => ms.filter((m) => m.confidence === 'high');

/** Anonymize, log what the output wrote (as a render does), then restore the output pasted back. */
function roundTrip(text: string, entities: Entity[], opts: { logged?: boolean } = {}) {
  const anon = findMatches(text, entities, 'anonymize');
  const out = applyMatches(text, anon);
  const logs = mentionsOf(anon);
  const logged = opts.logged === false ? entities : entities.map((e) => ({ ...e, mentions: logs.has(e.id) ? [{ doc: 'out-1', map: logs.get(e.id)! }] : [] }));
  const back = applyMatches(out, restoreChecked(findMatches(out, logged, 'restore')));
  return { out, back, logged };
}

const person = (text: string, groupKey: string, extra: Partial<Detection> = {}): Detection => ({ type: 'person', text, groupKey, source: 'claude', ...extra });

describe('restore gives back the text as it was written', () => {
  it('keeps an initial whose fake initial is M. (read as "Monsieur" when rebuilt)', () => {
    const text = 'Emprunteur : Olivier Lamy.\n| Banque | O. Lamy | 15 905,00 $ |\nLocataire : O. Lamy\n';
    const entities = build([person('Olivier Lamy', 'p1', { person: { first: 'Olivier', last: 'Lamy' } }), person('O. Lamy', 'p1')]);
    // Force the case that went wrong: a fake first name starting with M.
    const e = entities.find((x) => x.type === 'person')!;
    e.fake = { text: 'Maxime Soucy', person: { first: 'Maxime', last: 'Soucy' } };
    const { out, back } = roundTrip(text, entities);
    expect(out).toContain('M. Soucy');
    expect(back).toBe(text);
  });

  it('keeps the case of each mention, with or without the log', () => {
    const text = '1. MARGARET KOWALCZYK, born on April 12, 1966.\nThe immovable is transmitted to Margaret\nKowalczyk and to her son.\n';
    const entities = build([person('MARGARET KOWALCZYK', 'p1', { person: { first: 'MARGARET', last: 'KOWALCZYK' } }), person('Margaret\nKowalczyk', 'p1')]);
    expect(roundTrip(text, entities).back).toBe(text);
    // Without a log (an output from before, or retyped by an AI) the capitalised mention is rebuilt capitalised.
    expect(roundTrip(text, entities, { logged: false }).back).toBe(text);
  });

  it('puts back OCR typos as they were, in the order they were written', () => {
    const text = '3. Dennis Kowalczyk, born on l7 August 1973, residing in Toronto.\nBirth certificate: 17 August 1973.\nLot: 2 648 175, 3O, Apri1 12, 1966.\n';
    const entities = build([
      person('Dennis Kowalczyk', 'p1', { person: { first: 'Dennis', last: 'Kowalczyk' } }),
      { type: 'dob', text: 'l7 August 1973', source: 'claude' },
      { type: 'dob', text: '17 August 1973', source: 'claude' },
      { type: 'dob', text: 'Apri1 12, 1966', source: 'claude' },
    ]);
    const { out, back } = roundTrip(text, entities);
    expect(out).not.toContain('August 1973');
    expect(back).toBe(text);
  });

  it('gives back two spellings of one value that share a fake in the order they came (Ëtienne, then Étienne)', () => {
    const text = '3. Ëtienne Lebeau, né le 5 janvier 1975.\nLe lot est transmis à Étienne Lebeau, à parts égales.\nSigné : Étienne Lebeau\n';
    const entities = build([
      person('Ëtienne Lebeau', 'p1', { person: { first: 'Ëtienne', last: 'Lebeau' } }),
      person('Étienne Lebeau', 'p1', { person: { first: 'Étienne', last: 'Lebeau' } }),
    ]);
    expect(entities.filter((e) => e.type === 'person')).toHaveLength(1);
    const { out, back } = roundTrip(text, entities);
    expect(out).not.toContain('Lebeau');
    expect(back).toBe(text);
  });

  it('keeps the columns of a signature line read as one value', () => {
    const text = 'Signé à Montréal.\n\nGilles Roy                    Amélie Martin                    K. Haddad\nLocateur                      Locataire                        Locataire\n';
    const entities = build([person('Gilles Roy                    Amélie Martin                    K. Haddad', 'p1')]);
    expect(entities[0]!.real.text).toBe('Gilles Roy Amélie Martin K. Haddad');
    const { out, back } = roundTrip(text, entities);
    expect(out).not.toContain('Gilles');
    expect(back).toBe(text);
  });

  it('rebuilds a mention an AI retyped (no exact log) as before', () => {
    const text = 'Signed: Raymond Ostrowski\n';
    const entities = build([person('Raymond Ostrowski', 'p1', { person: { first: 'Raymond', last: 'Ostrowski' } })]);
    const { out, logged } = roundTrip(text, entities);
    const fake = entities[0]!.fake.text;
    const retyped = out.replace(fake, fake.toUpperCase());
    expect(applyMatches(retyped, findMatches(retyped, logged, 'restore'))).toBe('Signed: RAYMOND OSTROWSKI\n');
  });

  it('picks the output a text came from when two outputs wrote the same fake over different spellings', () => {
    const entities = build([person('Ëtienne Lebeau', 'p1', { person: { first: 'Ëtienne', last: 'Lebeau' } }), { type: 'sin', text: '130 692 544', source: 'regex' }]);
    const [p, sin] = [entities.find((e) => e.type === 'person')!, entities.find((e) => e.type === 'sin')!];
    const a = 'Ëtienne Lebeau, NAS 130 692 544.';
    const b = 'Étienne Lebeau.';
    const outA = applyMatches(a, findMatches(a, entities, 'anonymize'));
    const logsA = mentionsOf(findMatches(a, entities, 'anonymize'));
    const logsB = mentionsOf(findMatches(b, entities, 'anonymize'));
    const logged = [
      { ...p, mentions: [{ doc: 'A', map: logsA.get(p.id)! }, { doc: 'B', map: logsB.get(p.id)! }] },
      { ...sin, mentions: [{ doc: 'A', map: logsA.get(sin.id)! }] },
    ];
    // B is newer, but A shares the SIN with this text: A's spelling comes back.
    expect(applyMatches(outA, findMatches(outA, logged, 'restore'))).toBe(a);
  });

  it('logs each output once, newest last, and forgets the oldest past the limit', () => {
    const map = { 'Maxime Soucy': ['Olivier Lamy'] };
    expect(withMentions(undefined, 'o1', undefined)).toBeNull();
    const one = withMentions(undefined, 'o1', map)!;
    expect(one).toEqual([{ doc: 'o1', map }]);
    // The same thing written again by another render: nothing to store.
    expect(withMentions(one, 'o2', { 'Maxime Soucy': ['Olivier Lamy'] })).toBeNull();
    let logs = one;
    for (let i = 0; i < MAX_MENTION_LOGS + 5; i++) logs = withMentions(logs, `x${i}`, { [`Fake ${i}`]: ['Olivier Lamy'] })!;
    expect(logs).toHaveLength(MAX_MENTION_LOGS);
    expect(logs[logs.length - 1]!.doc).toBe(`x${MAX_MENTION_LOGS + 4}`);
  });

  it('logs the real surfaces in order, one entry when they are all the same', () => {
    const ms = (rows: Array<[number, string, string]>): Match[] =>
      rows.map(([start, surface, replacement]) => ({ start, end: start + surface.length, surface, replacement, entityId: 'e', type: 'person', kind: 'full', confidence: 'high' }));
    expect(mentionsOf(ms([[30, 'Étienne', 'Jonathan'], [0, 'Ëtienne', 'Jonathan'], [50, 'LEBEAU', 'GENDRON'], [60, 'LEBEAU', 'GENDRON']])).get('e')).toEqual({
      Jonathan: ['Ëtienne', 'Étienne'],
      GENDRON: ['LEBEAU'],
    });
  });
});

// ---------------------------------------------------------------- every fixture
/** The values a fixture's expected.json lists, typed by their look (as web/e2e/parity.ts's stand-in model does). */
function typeOf(v: string): EntityType {
  if (/@/.test(v)) return 'email';
  if (/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/i.test(v)) return 'postal_code';
  if (/\$|€/.test(v)) return 'amount';
  if (/^\(?\d{3}\)?[ .-]?\d{3}[ .-]\d{4}$/.test(v)) return 'phone';
  if (
    /\b(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(v) ||
    /^\d{4}-\d{2}-\d{2}$/.test(v)
  )
    return 'date';
  if (/^\d+[A-Z]?,? (rue|avenue|boulevard|chemin|rang|place|street|road|drive|av\.|boul\.)/i.test(v) || (/^\d+,? /.test(v) && /[a-z]/i.test(v) && v.split(' ').length > 2)) return 'address';
  if (/\d/.test(v)) return 'id_number';
  if (/\b(inc|ltée|ltd|banque|bank|caisse|desjardins|ciusss|assurances?|insurance|notaires?|group|groupe|société|corp|cabinet|llp|s\.e\.n\.c)\b/i.test(v)) return 'organization';
  return 'person';
}

function fixtureDetections(text: string, expected: { must?: string[]; optional?: string[] }): Detection[] {
  const values = [...new Set([...(expected.must ?? []), ...(expected.optional ?? [])])].filter((v) => text.includes(v));
  const dets: Detection[] = values.map((v) => {
    const type = typeOf(v);
    const words = v.split(/\s+/);
    const d: Detection = { type, text: v, source: 'claude', groupKey: type === 'person' ? words[words.length - 1]! : v };
    if (type === 'person' && words.length > 1 && !/\.$/.test(words[0]!)) d.person = { first: words[0]!, last: words.slice(1).join(' ') };
    return d;
  });
  return [...detectRegex(text), ...dets];
}

describe('every fixture comes back exactly from its anonymized output', () => {
  const dir = new URL('detect/', FIXTURES);
  const names = readdirSync(dir).filter((f) => f.endsWith('.txt'));
  expect(names.length).toBeGreaterThan(10);
  for (const name of names) {
    for (const seed of [1, 20261016]) {
      it(`${name}, seed ${seed}`, () => {
        const text = readFileSync(new URL(name, dir), 'utf8');
        const expected = JSON.parse(readFileSync(new URL(name.replace(/\.txt$/, '.expected.json'), dir), 'utf8'));
        const entities = build(fixtureDetections(text, expected), seed);
        const { out, back } = roundTrip(text, entities);
        expect(out).not.toBe(text);
        expect(back).toBe(text);
      });
    }
  }
});
