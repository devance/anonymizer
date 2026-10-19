import { parseAmount, renderAmount } from './amounts';
import { EN_SURNAMES, FIRST_NAMES, FR_SURNAMES, NEVER_USE } from './data/names';
import { ORG_CORES, ORG_KIND_WORDS, ORG_SUFFIXES, STREETS, type StreetClass } from './data/places';
import { parseDateLoose, renderDate } from './dates';
import { luhnCheckDigit } from './detect';
import { collisionKeys } from './keys';
import { alnumKey, digitsKey, fold } from './normalize';
import { isEnglishAddress, parseAddress, parsePersonName, splitOrg, withoutTitles } from './parse';
import { reshapeAlnum, reshapeDigits, substituteAddress } from './substitute';
import type { AddressParts, EntityAttrs, EntityType, EntityValue, PersonParts } from './types';

export type Rng = () => number;

/** Deterministic RNG for tests. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function cryptoRng(): Rng {
  const buf = new Uint32Array(64);
  let i = buf.length;
  return () => {
    if (i >= buf.length) {
      crypto.getRandomValues(buf);
      i = 0;
    }
    return buf[i++]! / 4294967296;
  };
}

/**
 * Kinds of fake that must be unique. Person names and street addresses are
 * unique across the whole database, which is what lets a document the tool has
 * never seen be routed back to its project. Phones are unique per project only:
 * the fictional 555-01XX range has 100 numbers per area code.
 */
export type FakeKind = 'person_full' | 'person_last' | 'street' | 'postal' | 'email' | 'phone' | 'org';

export interface FakeContext {
  rng: Rng;
  isTaken(kind: FakeKind, key: string): boolean;
  claim(kind: FakeKind, key: string): void;
  /** Folded pieces of every real value in the project. A fake may not reuse any of them. */
  realParts: Set<string>;
  /** People already given fakes, so an email like jean.tremblay@… can follow its owner's fake name. */
  people?: Array<{ real: PersonParts; fake: PersonParts }>;
  /**
   * collisionKeys of every real value in the project. A fake sharing one is
   * drawn again: a fake surname that is some other person's real one, a fake
   * date that is another real date, a fake account number that is a real one.
   */
  realKeys?: ReadonlySet<string>;
}

export interface FakeResult {
  value: EntityValue;
  claims: Array<{ kind: FakeKind; key: string }>;
}

const NEVER = new Set(NEVER_USE.map(fold));
const POSTAL_FIRST = 'ABCEGHJKLMNPRSTVXY';
const POSTAL_OTHER = 'ABCEGHJKLMNPRSTVWXYZ';
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const QC_AREA_CODES = ['514', '438', '450', '579', '418', '581', '819', '873', '367'];

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function randDigits(rng: Rng, n: number, firstNonZero = false): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String(i === 0 && firstNonZero ? randInt(rng, 1, 9) : randInt(rng, 0, 9));
  return s;
}

/** Pick from `pool`, preferring entries within ±20% of the real length so the fake fits the same box on a PDF page. */
/**
 * Record the claims a fake still needs. Once a pool runs out a fake may share
 * a surname or company name with another one; that part is then not claimed
 * again (the claims table holds each key once).
 */
function claimFree(ctx: FakeContext, claims: FakeResult['claims']): FakeResult['claims'] {
  const fresh = claims.filter((c) => !ctx.isTaken(c.kind, c.key));
  for (const c of fresh) ctx.claim(c.kind, c.key);
  return fresh;
}

/** Two names of a pool joined with a hyphen ("Valmont-Norval"): the reserve once the pool's single names are taken. */
function joined(pool: readonly string[]): string[] {
  return pool.flatMap((a) => pool.filter((b) => b !== a).map((b) => `${a}-${b}`));
}

function chooseByLength(rng: Rng, pool: readonly string[], target: number | undefined, ok: (s: string) => boolean): string | undefined {
  const cands = pool.filter(ok);
  if (cands.length === 0) return undefined;
  if (!target) return pick(rng, cands);
  return pick(rng, lengthBand(cands, target));
}

/** Names within 20% of the target length, or else the five closest. */
function lengthBand(pool: readonly string[], target: number): string[] {
  const slack = Math.max(1, Math.round(target * 0.2));
  const within = pool.filter((s) => Math.abs(s.length - target) <= slack);
  if (within.length > 0) return within;
  return [...pool].sort((a, b) => Math.abs(a.length - target) - Math.abs(b.length - target)).slice(0, 5);
}

/** A name's initials, folded: "Jean-Pierre" → "jp", "O." → "o". */
function initialsOf(name: string): string {
  return fold(name)
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .join('');
}

/** Language and gender of a first name, when it's one the fakes use. */
export function lookupFirst(first: string | undefined): { lang: 'fr' | 'en'; gender: 'f' | 'm' } | undefined {
  if (!first) return undefined;
  const key = fold(first);
  for (const lang of ['fr', 'en'] as const) {
    for (const gender of ['f', 'm'] as const) {
      if (FIRST_NAMES[lang][gender].some((n) => fold(n) === key)) return { lang, gender };
    }
  }
  return undefined;
}

function fakePerson(real: EntityValue, attrs: EntityAttrs | undefined, ctx: FakeContext): FakeResult {
  const given = withoutTitles(real.person ?? {});
  const rp: PersonParts = given.last || given.first ? given : parsePersonName(real.text);
  const known = lookupFirst(rp.first);
  const lang = attrs?.lang ?? known?.lang ?? (rp.last && EN_SURNAMES.some((s) => fold(s) === fold(rp.last!)) ? 'en' : 'fr');
  const gender: 'f' | 'm' = attrs?.gender === 'f' || attrs?.gender === 'm' ? attrs.gender : (known?.gender ?? (ctx.rng() < 0.5 ? 'f' : 'm'));
  const avoid = (s: string) => !ctx.realParts.has(fold(s)) && !NEVER.has(fold(s)) && !fold(s).split(' ').some((w) => ctx.realParts.has(w));
  // Two fake people sharing a first name would make a lone "Louise" ambiguous when restoring.
  const usedFirsts = new Set((ctx.people ?? []).map((p) => (p.fake.first ? fold(p.fake.first) : '')));
  const freshFirst = (s: string) => avoid(s) && !usedFirsts.has(fold(s));

  const firstPool = FIRST_NAMES[lang][gender];
  const drawFirst = (realFirst: string | undefined): string | undefined => {
    if (!realFirst) return undefined;
    if (/^\p{L}\.?$/u.test(realFirst)) return `${pick(ctx.rng, LETTERS.split(''))}.`;
    if (realFirst.includes('-')) {
      const compound =
        chooseByLength(ctx.rng, firstPool.filter((n) => n.includes('-')), realFirst.length, freshFirst) ??
        chooseByLength(ctx.rng, firstPool.filter((n) => n.includes('-')), realFirst.length, avoid);
      if (compound) return compound;
      const simple = firstPool.filter((n) => !n.includes('-') && avoid(n));
      return `${pick(ctx.rng, simple)}-${pick(ctx.rng, simple)}`;
    }
    const simple = firstPool.filter((n) => !n.includes('-'));
    return chooseByLength(ctx.rng, simple, realFirst.length, freshFirst) ?? chooseByLength(ctx.rng, simple, realFirst.length, avoid) ?? pick(ctx.rng, firstPool);
  };
  // A lone "M." can't be told from "Monsieur": "O. Lamy" written "M. Soucy" would read, and restore, as
  // "Monsieur Soucy". So a fake whose initial would be a lone M is drawn again, unless the real one's is too.
  // Only those draws change; every other one is what it was.
  const makeFirst = (realFirst: string | undefined): string | undefined => {
    for (let attempt = 0; ; attempt++) {
      const first = drawFirst(realFirst);
      if (!first || !realFirst || attempt >= 10 || initialsOf(first) !== 'm' || initialsOf(realFirst) === 'm') return first;
    }
  };

  const surnamePool = lang === 'en' ? [...EN_SURNAMES, ...FR_SURNAMES] : FR_SURNAMES;
  const makeLast = (realLast: string | undefined, allowTaken: boolean): string | undefined => {
    if (!realLast) return undefined;
    const ok = (s: string) => avoid(s) && fold(s) !== fold(realLast) && (allowTaken || !ctx.isTaken('person_last', fold(s)));
    const pool = lang === 'en' ? EN_SURNAMES : surnamePool;
    if (realLast.includes('-')) {
      const a = chooseByLength(ctx.rng, pool, undefined, ok);
      const b = chooseByLength(ctx.rng, pool, undefined, (s) => ok(s) && s !== a);
      return a && b ? `${a}-${b}` : undefined;
    }
    return chooseByLength(ctx.rng, pool, realLast.length, ok) ?? chooseByLength(ctx.rng, surnamePool, realLast.length, ok);
  };

  for (let attempt = 0; attempt < 60; attempt++) {
    // Surnames stay globally unique while the pool lasts; after that only the full name has to be.
    const fake: PersonParts = {
      first: makeFirst(rp.first),
      middle: rp.middle ? makeFirst(rp.middle) : undefined,
      last: makeLast(rp.last, attempt > 30),
    };
    if (rp.last && !fake.last) continue;
    const fullKey = fold([fake.first, fake.last].filter(Boolean).join(' '));
    // A one-word name may be shared once the pool runs out: restore never trusts a lone first or last name anyway.
    if (ctx.isTaken('person_full', fullKey) && ((fake.first && fake.last) || attempt <= 30)) continue;
    for (const k of Object.keys(fake) as Array<keyof PersonParts>) if (!fake[k]) delete fake[k];
    const claims: FakeResult['claims'] = [{ kind: 'person_full', key: fullKey }];
    if (fake.last) claims.push({ kind: 'person_last', key: fold(fake.last) });
    return { value: { text: [fake.first, fake.middle, fake.last].filter(Boolean).join(' '), person: fake }, claims: claimFree(ctx, claims) };
  }
  throw new Error('could not find an unused fake name');
}

function streetClass(a: AddressParts): StreetClass {
  if (isEnglishAddress(a)) return 'en';
  const p = a.particle ? fold(a.particle) : '';
  if (p === 'des' || p === 'du' || p === 'de la' || p === "de l'" || p === "d'" || p === 'de') return p;
  return 'none';
}

function fakeAddress(real: EntityValue, ctx: FakeContext): FakeResult {
  const ra: AddressParts = { ...parseAddress(real.text), ...real.address };
  const cls = streetClass(ra);
  const civicDigits = ra.civic?.match(/^\d+/)?.[0] ?? '';
  const civicSuffix = ra.civic?.slice(civicDigits.length) ?? '';
  const newCivic = () => {
    if (!civicDigits) return ra.civic;
    let civic: string;
    do civic = randDigits(ctx.rng, civicDigits.length, true) + civicSuffix;
    while (civic === ra.civic);
    return civic;
  };
  const make = (civic: string | undefined, name: string | undefined): FakeResult => {
    const fa: AddressParts = { ...ra, civic, streetName: name };
    for (const k of Object.keys(fa) as Array<keyof AddressParts>) if (!fa[k]) delete fa[k];
    const claims = claimFree(ctx, [{ kind: 'street', key: `${(civic ?? '').toLowerCase()}|${fold(name ?? '')}` }]);
    return { value: { text: substituteAddress(real.text, ra, fa), address: fa }, claims };
  };
  if (!ra.streetName) return make(newCivic(), undefined);
  const ok = (s: string) => !ctx.realParts.has(fold(s)) && fold(s) !== fold(ra.streetName!);
  const pool = STREETS[cls].filter(ok);
  // Fakes are unique across the database: a name of the same length first,
  // then any name of the same kind, then two joined. A civic number leaves
  // plenty of room; without one only the name can change.
  for (const names of [lengthBand(pool, ra.streetName.length), pool, joined(pool)]) {
    if (names.length === 0) continue;
    for (let attempt = 0; attempt < 30; attempt++) {
      const civic = newCivic();
      const name = pick(ctx.rng, names);
      if (!ctx.isTaken('street', `${(civic ?? '').toLowerCase()}|${fold(name)}`)) return make(civic, name);
    }
    const free = names.filter((n) => !ctx.isTaken('street', `${(ra.civic ?? '').toLowerCase()}|${fold(n)}`));
    if (!civicDigits && free.length > 0) return make(ra.civic, pick(ctx.rng, free));
  }
  // Every name taken: share one rather than fail the document.
  return make(newCivic(), pick(ctx.rng, pool.length > 0 ? pool : STREETS[cls]));
}

function fakePostal(real: EntityValue, ctx: FakeContext): FakeResult {
  const realKey = alnumKey(real.text);
  const first = POSTAL_FIRST.includes(realKey[0] ?? '') ? realKey[0]! : pick(ctx.rng, POSTAL_FIRST.split(''));
  for (let attempt = 0; attempt < 200; attempt++) {
    const key = `${first}${randInt(ctx.rng, 0, 9)}${pick(ctx.rng, POSTAL_OTHER.split(''))}${randInt(ctx.rng, 0, 9)}${pick(ctx.rng, POSTAL_OTHER.split(''))}${randInt(ctx.rng, 0, 9)}`;
    if (key === realKey || ctx.isTaken('postal', key)) continue;
    ctx.claim('postal', key);
    return { value: { text: reshapeAlnum(real.text, key) ?? `${key.slice(0, 3)} ${key.slice(3)}` }, claims: [{ kind: 'postal', key }] };
  }
  throw new Error('could not find an unused fake postal code');
}

function fakePhone(real: EntityValue, ctx: FakeContext): FakeResult {
  const d = digitsKey(real.text).slice(-10);
  const area = d.length === 10 ? d.slice(0, 3) : pick(ctx.rng, QC_AREA_CODES);
  for (let attempt = 0; attempt < 400; attempt++) {
    const key = `${area}55501${randDigits(ctx.rng, 2)}`;
    if (key === d || ctx.isTaken('phone', key)) continue;
    ctx.claim('phone', key);
    const text = reshapeDigits(real.text, d.length === 10 ? key : key.slice(-d.length)) ?? `${area}-555-${key.slice(6)}`;
    return { value: { text }, claims: [{ kind: 'phone', key }] };
  }
  throw new Error(`no fictional 555-01XX numbers left for area code ${area} in this project`);
}

function ascii(s: string): string {
  return fold(s).replace(/[^a-z0-9]/g, '');
}

function fakeEmail(real: EntityValue, ctx: FakeContext): FakeResult {
  const [local = '', domain = ''] = real.text.trim().toLowerCase().split('@');
  const tld = domain.split('.').pop();
  const fakeDomain = tld === 'org' ? 'example.org' : tld === 'net' ? 'example.net' : 'example.com';
  const tokens = local.split(/([._-])/);
  const owner = ctx.people?.find(({ real: p }) => tokens.some((t) => (p.last && ascii(t).includes(ascii(p.last))) || (p.first && ascii(t) === ascii(p.first))));
  let fakeLocal: string;
  if (owner) {
    const rf = ascii(owner.real.first ?? '');
    const rl = ascii(owner.real.last ?? '');
    const ff = ascii(owner.fake.first ?? '');
    const fl = ascii(owner.fake.last ?? '');
    const ri = (owner.real.first ?? '').split(/[\s-]+/).filter(Boolean).map((w) => ascii(w)[0] ?? '').join('');
    const fi = (owner.fake.first ?? '').split(/[\s-]+/).filter(Boolean).map((w) => ascii(w)[0] ?? '').join('');
    fakeLocal = tokens
      .map((t) => {
        if (/^[._-]$/.test(t) || !t) return t;
        if (rf && rl && t === rf[0] + rl) return ff[0] + fl;
        if (rf && rl && t === rl + rf[0]) return fl + ff[0];
        if (ri && t === ri) return fi;
        let out = t;
        if (rl && out.includes(rl)) out = out.replace(rl, fl);
        if (rf && out.includes(rf)) out = out.replace(rf, ff);
        return out.replace(/\d+/g, (m) => randDigits(ctx.rng, m.length));
      })
      .join('');
  } else {
    const first = ascii(pick(ctx.rng, [...FIRST_NAMES.fr.f, ...FIRST_NAMES.fr.m]));
    const last = ascii(pick(ctx.rng, FR_SURNAMES));
    fakeLocal = `${first}.${last}`;
  }
  let key = `${fakeLocal}@${fakeDomain}`;
  for (let n = 2; ctx.isTaken('email', key); n++) key = `${fakeLocal}${n}@${fakeDomain}`;
  ctx.claim('email', key);
  return { value: { text: key }, claims: [{ kind: 'email', key }] };
}

/**
 * Keep the look of an identifier: digits become other digits, letters other
 * letters, separators stay. Short all-letter prefixes ("AUT-", "POL") are kept
 * since they usually encode a product line, not a person.
 */
function shapePreserving(text: string, rng: Rng): string {
  const scramble = (keepShortWords: boolean) =>
    text.replace(/[\p{L}\p{N}]+/gu, (tok) => {
      if (keepShortWords && /^\p{L}+$/u.test(tok) && tok.length <= 4) return tok;
      let s = '';
      for (let i = 0; i < tok.length; i++) {
        const c = tok[i]!;
        if (/\d/.test(c)) s += String(i === 0 && c !== '0' ? randInt(rng, 1, 9) : randInt(rng, 0, 9));
        else if (/\p{L}/u.test(c)) {
          const l = pick(rng, LETTERS.split(''));
          s += c === c.toLowerCase() ? l.toLowerCase() : l;
        } else s += c;
      }
      return s;
    });
  // A loop, not a retry by recursion: WebKit runs a self-call in tail position
  // as a jump, so "RAMQ" (nothing it may change) used to spin forever.
  for (let attempt = 0; attempt < 12; attempt++) {
    const out = scramble(attempt < 2);
    if (out !== text) return out;
  }
  return text;
}

function fakeDate(real: EntityValue, keepYear: boolean, rng: Rng): EntityValue {
  const parsed = parseDateLoose(real.text);
  const iso = real.iso ?? parsed?.iso;
  if (!iso || !parsed) return { text: shapePreserving(real.text, rng) };
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  let fake: string;
  if (keepYear) {
    // Same year so any age an AI works out from the document stays right.
    let nm: number;
    let nd: number;
    do {
      nm = randInt(rng, 1, 12);
      nd = randInt(rng, 1, 28);
    } while (nm === m && nd === d);
    fake = `${y}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
  } else {
    const shift = randInt(rng, 20, 400) * (rng() < 0.5 ? -1 : 1);
    fake = new Date(Date.UTC(y, m - 1, d + shift)).toISOString().slice(0, 10);
  }
  return { text: renderDate(fake, parsed.format), iso: fake };
}

function fakeAmount(real: EntityValue, rng: Rng): EntityValue {
  const hit = parseAmount(real.text);
  const value = real.amount ?? hit?.value;
  if (value === undefined || !hit) return { text: real.text };
  let factor: number;
  do factor = 0.85 + rng() * 0.3;
  while (factor > 0.97 && factor < 1.03);
  // Keep round numbers round: 250 000 $ becomes 270 000 $, not 271 843 $.
  const zeros = (String(Math.round(value)).match(/0+$/)?.[0].length ?? 0);
  const step = 10 ** Math.min(zeros, Math.max(0, String(Math.round(value)).length - 2));
  let fake = Math.round((value * factor) / step) * step;
  if (hit.format.decimals > 0 && step === 1) fake = Number((value * factor).toFixed(hit.format.decimals));
  if (fake === value) fake += step;
  return { text: renderAmount(fake, hit.format), amount: fake };
}

function fakeOrg(real: EntityValue, ctx: FakeContext): FakeResult {
  const s = splitOrg(real.text, ORG_KIND_WORDS, ORG_SUFFIXES);
  const cores = ORG_CORES.filter((c) => !ctx.realParts.has(fold(c)));
  const free = (names: string[]) => names.filter((c) => !ctx.isTaken('org', fold(c)));
  // Single names, then two joined, then (every one taken) a shared one.
  const core = [free(cores), free(joined(cores)), cores.length > 0 ? cores : [...ORG_CORES]].map((l) => (l.length > 0 ? pick(ctx.rng, l) : undefined)).find(Boolean)!;
  return { value: { text: [s.kind, core, s.suffix].filter(Boolean).join(' ') }, claims: claimFree(ctx, [{ kind: 'org', key: fold(core) }]) };
}

/** Draws before a fake that still shares a key with a real value is kept anyway (pools that ran out). */
const COLLISION_DRAWS = 20;

/**
 * A fake for a real value. One that would equal a real value of the project
 * (ctx.realKeys; its own real value aside, which the generators already
 * avoid) is drawn again, in a bounded loop: what a rejected draw claimed is
 * released and counted as taken for the next draw, so a fake built without
 * chance (an email from its owner's fake name) moves on too. With the same
 * seed the result is the same; a draw that collides with nothing is exactly
 * what it was before this check existed.
 */
export function makeFake(type: EntityType, real: EntityValue, attrs: EntityAttrs | undefined, ctx: FakeContext): FakeResult {
  if (!ctx.realKeys || ctx.realKeys.size === 0) return drawFake(type, real, attrs, ctx);
  const own = new Set(collisionKeys(type, real));
  const keys = ctx.realKeys;
  const rejected = new Map<FakeKind, Set<string>>();
  for (let attempt = 0; ; attempt++) {
    const pending: Array<{ kind: FakeKind; key: string }> = [];
    const trial: FakeContext = {
      ...ctx,
      isTaken: (k, v) => ctx.isTaken(k, v) || (rejected.get(k)?.has(v) ?? false),
      claim: (k, v) => void pending.push({ kind: k, key: v }),
    };
    const r = drawFake(type, real, attrs, trial);
    const clash = collisionKeys(type, r.value).some((k) => keys.has(k) && !own.has(k));
    if (!clash || attempt >= COLLISION_DRAWS - 1) {
      for (const c of pending) ctx.claim(c.kind, c.key);
      return r;
    }
    for (const c of pending) {
      if (!rejected.has(c.kind)) rejected.set(c.kind, new Set());
      rejected.get(c.kind)!.add(c.key);
    }
  }
}

/** Whether a value (a fake, usually) shares a collision key with any of `keys`. */
export function collidesWith(type: EntityType, value: EntityValue, keys: ReadonlySet<string>): boolean {
  return collisionKeys(type, value).some((k) => keys.has(k));
}

function drawFake(type: EntityType, real: EntityValue, attrs: EntityAttrs | undefined, ctx: FakeContext): FakeResult {
  switch (type) {
    case 'person':
      return fakePerson(real, attrs, ctx);
    case 'address':
      return fakeAddress(real, ctx);
    case 'postal_code':
      return fakePostal(real, ctx);
    case 'phone':
      return fakePhone(real, ctx);
    case 'email':
      return fakeEmail(real, ctx);
    case 'organization':
      return fakeOrg(real, ctx);
    case 'dob':
      return { value: fakeDate(real, true, ctx.rng), claims: [] };
    case 'date':
      return { value: fakeDate(real, false, ctx.rng), claims: [] };
    case 'amount':
      return { value: fakeAmount(real, ctx.rng), claims: [] };
    case 'sin': {
      // SINs starting with 0 are never issued.
      const partial = '0' + randDigits(ctx.rng, 7);
      const key = partial + luhnCheckDigit(partial);
      return { value: { text: reshapeDigits(real.text, key) ?? key }, claims: [] };
    }
    case 'card_number': {
      const d = digitsKey(real.text);
      const partial = (d[0] ?? '4') + randDigits(ctx.rng, Math.max(12, d.length) - 2);
      const key = partial + luhnCheckDigit(partial);
      return { value: { text: reshapeDigits(real.text, key) ?? key }, claims: [] };
    }
    case 'health_card': {
      const k = alnumKey(real.text);
      const key = Array.from({ length: 4 }, () => pick(ctx.rng, LETTERS.split(''))).join('') + randDigits(ctx.rng, Math.max(0, k.length - 4));
      return { value: { text: reshapeAlnum(real.text, key) ?? key }, claims: [] };
    }
    default:
      return { value: { text: shapePreserving(real.text, ctx.rng) }, claims: [] };
  }
}
