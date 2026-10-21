import { EN_STREET_TYPES, PARTICLES, STREET_TYPES } from './data/places';
import { fold } from './normalize';
import type { AddressParts, PersonParts } from './types';

const TITLES = /^(m\.|mme|mlle|me|dr|dre|mr\.?|mrs\.?|ms\.?|miss|monsieur|madame|maître|maitre|docteur|docteure|sir)\s+/i;

/** Courtesy titles and honorifics, folded, without their period. */
const TITLE_WORDS = new Set([
  'm', 'mm', 'mme', 'mmes', 'mlle', 'mlles', 'me', 'mes', 'dr', 'dre', 'drs', 'pr', 'pre', 'prof', 'monsieur', 'messieurs', 'madame', 'mesdames',
  'mademoiselle', 'mesdemoiselles', 'maitre', 'maitres', 'docteur', 'docteure', 'professeur', 'professeure',
  'mr', 'mrs', 'ms', 'mx', 'miss', 'mister', 'madam', 'sir', 'dame', 'messrs', 'hon', 'rev',
]);

/**
 * "Mme", "M.", "Dr", "Me", "M. et Mme", "Mr & Mrs": courtesy titles and
 * nothing else. Never a person value nor a mention of one, whatever a model
 * returns: it stands for whoever the sentence is about, and replacing it
 * with one person's fake name leaves that person's other titles behind and
 * can't be restored.
 */
export function isTitleOnly(text: string): boolean {
  const words = fold(text).split(/[^\p{L}]+/u).filter(Boolean);
  return words.length > 0 && words.some((w) => TITLE_WORDS.has(w)) && words.every((w) => TITLE_WORDS.has(w) || w === 'et' || w === 'and');
}

/** Person parts without the titles a model put in them: { first: "Mme", last: "Lebeau" } → { last: "Lebeau" }. */
export function withoutTitles(p: PersonParts): PersonParts {
  const out: PersonParts = {};
  for (const k of ['first', 'middle', 'last'] as const) {
    let v = p[k]?.trim();
    while (v && TITLES.test(v)) v = v.replace(TITLES, '');
    if (v && !isTitleOnly(v)) out[k] = v;
  }
  return out;
}

/** "Tremblay, Jean", "M. Jean-Pierre Tremblay", "TREMBLAY Jean" → parts. */
export function parsePersonName(text: string): PersonParts {
  // OCR debris stuck to a word ("Me ·Paul Gervais") isn't part of the name.
  let t = text.trim().replace(/\s+/g, ' ').replace(/(^| )[^\p{L}\p{N} ]+(?=\p{L})/gu, '$1');
  while (TITLES.test(t)) t = t.replace(TITLES, '');
  if (isTitleOnly(t)) return {};
  if (t.includes(',')) {
    const [last, rest] = t.split(',', 2).map((s) => s.trim()) as [string, string];
    const given = rest.split(' ').filter(Boolean);
    return clean({ first: given[0], middle: given.slice(1).join(' ') || undefined, last });
  }
  const words = t.split(' ').filter(Boolean);
  if (words.length === 1) return { last: words[0] };
  // "TREMBLAY Jean": an all-caps first word followed by a normal one is surname-first. "V. Lamy" is an initial.
  const [w0, w1] = words as [string, string];
  if (words.length === 2 && w0 === w0.toUpperCase() && w1 !== w1.toUpperCase() && !/^(\p{L}\.-?)+$/u.test(w0)) {
    return { first: w1, last: w0 };
  }
  return clean({
    first: words[0],
    middle: words.length > 2 ? words.slice(1, -1).join(' ') : undefined,
    last: words[words.length - 1],
  });
}

function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined || o[k] === '') delete o[k];
  return o;
}

const TYPE_SET = new Set(STREET_TYPES);
const DIRECTIONS = new Set(['est', 'ouest', 'nord', 'sud', 'east', 'west', 'north', 'south']);

function isType(word: string): boolean {
  return TYPE_SET.has(fold(word).replace(/\.$/, ''));
}

/**
 * Best-effort split of a one-line address. Claude usually supplies the parts;
 * this covers regex hits, manual additions and anything it left out.
 *   "123, rue des Érables, app. 4, Laval" → civic 123, type rue, particle des, name Érables
 *   "456 Maple Street"                    → civic 456, name Maple, type Street
 */
export function parseAddress(text: string): AddressParts {
  const first = text.split(',').map((s) => s.trim());
  let line = first[0] ?? '';
  let civic: string | undefined;
  // "10-16", "180-182", "10-14-16", "14-3", "300-1250": the whole number, not its first part.
  const civicMatch = line.match(/^(\d+[A-Za-z]?(?:\s?[-–]\s?\d+[A-Za-z]?)*)(?![\p{L}\p{N}])[\s.;:]*(.*)$/u);
  if (civicMatch) {
    civic = civicMatch[1];
    line = civicMatch[2] ?? '';
    // "123, rue des Érables": the street is in the next comma segment.
    if (!line && first[1]) line = first[1];
  }
  const words = line.split(/\s+/).filter(Boolean);
  // "Sherbrooke Street West", "rue Notre-Dame Est": the direction isn't part of the name.
  if (words.length > 2 && DIRECTIONS.has(fold(words[words.length - 1]!).replace(/\.$/, ''))) words.pop();
  let streetType: string | undefined;
  let particle: string | undefined;
  if (words[0] && isType(words[0])) {
    streetType = words.shift();
  } else if (words.length > 1 && isType(words[words.length - 1]!)) {
    streetType = words.pop();
  }
  const rest = words.join(' ');
  for (const p of PARTICLES) {
    const re = new RegExp(`^(${p.replace("'", "['’]")})${p.endsWith("'") ? '' : '\\s+'}`, 'i');
    const m = rest.match(re);
    if (m) {
      particle = m[1];
      return clean({ civic, streetType, particle, streetName: rest.slice(m[0].length).trim() });
    }
  }
  return clean({ civic, streetType, streetName: rest || undefined });
}

const ABBREVIATIONS: Record<string, string[]> = {
  saint: ['st'],
  st: ['saint'],
  sainte: ['ste'],
  ste: ['sainte'],
  monseigneur: ['mgr'],
  mgr: ['monseigneur'],
};

/** A folded street name and its usual abbreviations: "saint louis" → also "st paul"; "mgr de laval" → "monseigneur de laval". */
export function streetNameVariants(folded: string): string[] {
  let out = [''];
  for (const w of folded.split(' ')) {
    const alts = [w, ...(ABBREVIATIONS[w] ?? [])];
    out = out.flatMap((o) => alts.map((a) => (o ? `${o} ${a}` : a)));
    if (out.length > 16) out = out.slice(0, 16);
  }
  return out;
}

/**
 * "MILLBROOK, ON", "Saint-Narcisse (Québec)": a place name with no number and
 * no street word. Address fakes keep the city, so a lone city stays as is.
 */
export function isLocality(text: string): boolean {
  return !/\d/.test(text) && !text.split(/[\s,()]+/).some((w) => w && isType(w));
}

const PROVINCES = new Set(
  [
    'qc', 'que', 'qué', 'québec', 'quebec', 'on', 'ont', 'ontario', 'nb', 'n.-b', 'nouveau-brunswick', 'new brunswick',
    'ns', 'n.-é', 'nouvelle-écosse', 'nova scotia', 'pe', 'pei', 'î.-p.-é', 'île-du-prince-édouard', 'prince edward island',
    'nl', 't.-n.-l', 'terre-neuve-et-labrador', 'newfoundland and labrador', 'mb', 'man', 'manitoba', 'sk', 'sask',
    'saskatchewan', 'ab', 'alta', 'alberta', 'bc', 'c.-b', 'colombie-britannique', 'british columbia', 'yt', 'yukon',
    'nt', 't.n.-o', 'territoires du nord-ouest', 'northwest territories', 'nu', 'nunavut', 'canada',
  ].map((p) => fold(p.replace(/\.+$/, ''))),
);

/**
 * A province or territory named alone ("QC", "Québec", "Ont."): never someone's, and addresses
 * keep theirs, so it is never detected, replaced or counted as left in a copy.
 */
export function isProvince(text: string): boolean {
  return PROVINCES.has(fold(text.trim().replace(/\.+$/, '')));
}

export function isEnglishAddress(a: AddressParts): boolean {
  return !!a.streetType && EN_STREET_TYPES.has(fold(a.streetType).replace(/\.$/, '')) && !a.particle;
}

/** "Assurances Desjardins inc." → { kind: "Assurances", core: "Desjardins", suffix: "inc." } */
export function splitOrg(text: string, kindWords: string[], suffixes: string[]): { kind?: string; core: string; suffix?: string } {
  let t = text.trim();
  let suffix: string | undefined;
  let kind: string | undefined;
  const words = t.split(/\s+/);
  const last = words[words.length - 1];
  if (words.length > 1 && last && suffixes.includes(fold(last).replace(/,$/, ''))) {
    suffix = words.pop();
    t = words.join(' ').replace(/,$/, '');
  }
  const ws = t.split(/\s+/);
  if (ws.length > 1 && kindWords.includes(fold(ws[0]!))) {
    kind = ws.shift();
    t = ws.join(' ');
  }
  return { kind, core: t, suffix };
}
