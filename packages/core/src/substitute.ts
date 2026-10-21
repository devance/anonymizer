import { ORG_KIND_WORDS, ORG_SUFFIXES } from './data/places';
import { escapeRegex, findFolded, fold, foldWithMap, matchCase, matchNameCase } from './normalize';
import { splitOrg, streetNameVariants } from './parse';
import type { AddressParts, PersonParts } from './types';

interface Hit {
  a: number;
  b: number;
  repl: string;
}

function applyHits(surface: string, hits: Hit[]): string {
  const kept: Hit[] = [];
  for (const h of [...hits].sort((x, y) => y.b - y.a - (x.b - x.a))) {
    if (!kept.some((k) => h.a < k.b && h.b > k.a)) kept.push(h);
  }
  kept.sort((x, y) => x.a - y.a);
  let out = '';
  let at = 0;
  for (const h of kept) {
    out += surface.slice(at, h.a) + h.repl;
    at = h.b;
  }
  return out + surface.slice(at);
}

function initialLetters(name: string): string[] {
  return fold(name)
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0]!);
}

/** Folded spellings of a name's initials: "Jean-Pierre" → ["j. p.", "j.p."]. */
export function initialsNeedles(name: string): string[] {
  const letters = initialLetters(name);
  // A lone "M." is far more often "Monsieur" than an initial, so it never counts as one.
  if (letters.length === 0 || (letters.length === 1 && letters[0] === 'm')) return [];
  return [...new Set([letters.map((l) => `${l}.`).join(' '), letters.map((l) => `${l}.`).join('')])];
}

/**
 * Rewrite a person mention piece by piece, so whatever shape the mention has
 * survives: "TREMBLAY, Jean" → "GAGNON, Luc", "J.-P. Tremblay" → "L.-M. Gagnon",
 * "the Tremblays" → "the Gagnons".
 */
export function substitutePerson(surface: string, src: PersonParts, dst: PersonParts, dstText: string): string {
  const f = foldWithMap(surface);
  const hits: Hit[] = [];
  const pairs: Array<[string, string]> = [];
  for (const k of ['last', 'first', 'middle'] as const) {
    const s = src[k];
    const d = dst[k];
    if (s && d) pairs.push([fold(s), d]);
  }
  if (src.last && dst.last) pairs.push([`${fold(src.last)}s`, `${dst.last}s`]);
  for (const [needle, repl] of pairs) {
    for (const [a, b] of findFolded(f, needle)) hits.push({ a, b, repl: matchNameCase(surface.slice(a, b), repl) });
  }
  for (const k of ['first', 'middle'] as const) {
    const s = src[k];
    const d = dst[k];
    if (!s || !d) continue;
    const dl = initialLetters(d).map((l) => l.toUpperCase());
    for (const needle of initialsNeedles(s)) {
      for (const [a, b] of findFolded(f, needle)) {
        const orig = surface.slice(a, b);
        const joiner = orig.includes('-') ? '-' : /\.\s/.test(orig) ? ' ' : '';
        hits.push({ a, b, repl: dl.map((l) => `${l}.`).join(joiner) });
      }
    }
  }
  if (hits.length === 0) return matchNameCase(surface, dstText);
  return applyHits(surface, hits);
}

/**
 * Swap the civic number and street name of an address mention and leave the
 * rest (street type, punctuation, language) alone, so a translated
 * "123 Bouleaux Street" restores to "456 Érables Street".
 */
export function substituteAddress(surface: string, src: AddressParts, dst: AddressParts): string {
  const f = foldWithMap(surface);
  const hits: Hit[] = [];
  if (src.civic && dst.civic) {
    for (const m of surface.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(src.civic)}(?![\\p{L}\\p{N}])`, 'giu'))) {
      hits.push({ a: m.index!, b: m.index! + m[0].length, repl: dst.civic });
    }
  }
  if (src.streetName && dst.streetName) {
    for (const [a, b] of streetNameVariants(fold(src.streetName)).flatMap((v) => findFolded(f, v))) {
      hits.push({ a, b, repl: matchCase(surface.slice(a, b), dst.streetName) });
      // The article in front only changes if the fake needs a different one.
      if (src.particle && dst.particle && fold(src.particle) !== fold(dst.particle)) {
        const p = fold(src.particle);
        for (const [pa, pb] of findFolded(f, p)) {
          if (pb <= a && a - pb <= 1) hits.push({ a: pa, b: pb, repl: matchCase(surface.slice(pa, pb), dst.particle) });
        }
      }
    }
  }
  if (hits.length === 0) return surface;
  return applyHits(surface, hits);
}

export function substituteOrg(surface: string, srcText: string, dstText: string): string {
  const s = splitOrg(srcText, ORG_KIND_WORDS, ORG_SUFFIXES);
  const d = splitOrg(dstText, ORG_KIND_WORDS, ORG_SUFFIXES);
  const f = foldWithMap(surface);
  const hits = findFolded(f, fold(s.core)).map(([a, b]) => ({ a, b, repl: matchCase(surface.slice(a, b), d.core) }));
  if (hits.length === 0) return matchCase(surface, dstText);
  return applyHits(surface, hits);
}

/**
 * Put `key`'s letters and digits into `surface`'s shape: "AB-123 456" with
 * key "QX987321" → "QX-987 321". Null when the counts don't line up.
 */
export function reshapeAlnum(surface: string, key: string): string | null {
  const count = [...surface].filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
  if (count !== key.length) return null;
  let i = 0;
  let out = '';
  for (const c of surface) {
    if (/[\p{L}\p{N}]/u.test(c)) {
      const k = key[i++]!;
      out += c === c.toLowerCase() && c !== c.toUpperCase() ? k.toLowerCase() : k;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Put `digits` into the last digit positions of `surface`, keeping anything
 * ahead of them (a "+1" country code) and every separator.
 */
export function reshapeDigits(surface: string, digits: string): string | null {
  const total = surface.replace(/\D/g, '').length;
  if (digits.length > total) return null;
  let skip = total - digits.length;
  let i = 0;
  let out = '';
  for (const c of surface) {
    if (/\d/.test(c)) {
      if (skip > 0) {
        skip--;
        out += c;
      } else {
        out += digits[i++];
      }
    } else {
      out += c;
    }
  }
  return out;
}
