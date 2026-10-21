import { findAmounts, partOfAmount, renderAmount, type AmountHit } from './amounts';
import { ORG_KIND_WORDS, ORG_SUFFIXES, PARTICLES, STREET_TYPES } from './data/places';
import { findDates, parseDate, parseDateLoose, renderDate, type DateHit } from './dates';
import { withinEdits } from './fuzzy';
import { applyMentionLogs, mentionKeys } from './mentions';
import { alnumKey, digitsKey, escapeRegex, fold, foldWithMap, isWordChar, matchCase, matchNameCase, unfoldRange, type Folded } from './normalize';
import { isProvince, isTitleOnly, parseAddress, parsePersonName, splitOrg, streetNameVariants, withoutTitles } from './parse';
import {
  initialsNeedles,
  reshapeAlnum,
  reshapeDigits,
  substituteAddress,
  substituteOrg,
  substitutePerson,
} from './substitute';
import type { AddressParts, Direction, Entity, EntityValue, Match } from './types';

export interface MatchOptions {
  /**
   * Restoring across several projects: lone first and last names only count
   * for this one, since only full values are unique across projects.
   */
  preferProject?: string;
  /** Names in any case, as file names write them ("tremblay-jf.pdf"): a word in lowercase still counts. */
  anyCase?: boolean;
}

interface Cand extends Match {
  prio: number;
}

/** Kinds that identify their entity on their own. */
const STRONG = new Set(['full', 'surface', 'mention', 'initial', 'street', 'digits', 'alnum', 'email', 'date', 'amount', 'org']);
const PART_KINDS = new Set(['first', 'last', 'org_core']);

/**
 * Words a name piece can't be matched on alone, since they're everywhere in
 * the text: a person read as "Paul Gagnon le" would otherwise turn every "le"
 * into the fake surname.
 */
const COMMON_WORDS = new Set(
  (
    'le la les l de du des d un une et ou au aux a en par pour sur sous dans avec sans chez ce cet cette ces se sa son ses mon ma mes ' +
    'ton ta tes notre nos votre vos leur leurs il elle ils elles on nous vous qui que quoi dont ne pas plus est sont soit ete etre ' +
    'avoir ont fait lui y si mais car donc or ni the an of and or to in on at by for with from is are was be it its this that as ' +
    'van von der den di da del della dos das st ste ' +
    // A first name that is also a month ("May Chen", "April") would take the dates with it.
    'janvier fevrier mars avril mai juin juillet aout septembre octobre novembre decembre ' +
    'january february march april may june july august september october november december'
  ).split(' '),
);

const TITLE_BEFORE = /(?:^|[^\p{L}])(?:m|mme|mlle|me|mr|mrs|ms|dr|dre|monsieur|madame|mister|miss)\.?\s+$/iu;

/** Every word of the text, OCR debris inside included ("Math1eu", "Chcv·alier"), with a folded key. */
function wordTokens(text: string): Array<{ start: number; end: number; text: string; key: string }> {
  return [...text.matchAll(/[\p{L}\p{N}](?:[\p{L}\p{N}'’·-]*[\p{L}\p{N}])?/gu)].map((m) => ({
    start: m.index!,
    end: m.index! + m[0].length,
    text: m[0],
    key: fold(m[0]).replace(/[^a-z0-9-]/g, ''),
  }));
}

/** Words the text writes in lowercase, folded; emails and links aside, which spell names in lowercase. */
const lowercaseOf = (text: string, opts: MatchOptions) => (opts.anyCase ? new Set<string>() : lowercaseWords(text));

function lowercaseWords(text: string): Set<string> {
  const plain = text.replace(/\S+@\S+|https?:\/\/\S+|www\.\S+/g, ' ');
  return new Set([...plain.matchAll(/(?<![\p{L}\p{N}@.])\p{Ll}[\p{Ll}'’-]+/gu)].map((m) => fold(m[0])));
}

/**
 * A surname or first name may stand alone in the text ("Monsieur Tremblay")
 * unless it's a common word or a month. Short ones only capitalised, as a
 * name is ("Luc", "Cyr"); two letters ("Ng", "Wu", "Do") only after a title
 * ("Mr. Ng"), since alone they could be any word starting a sentence.
 */
function lonePartOk(part: string, surface: string, before: string, lowerWords: Set<string>): boolean {
  const k = fold(part);
  if (COMMON_WORDS.has(k)) return false;
  // The document writes it in lowercase elsewhere: an ordinary word here ("chevalier", "petit"), whatever the surname.
  if (lowerWords.has(k)) return false;
  const letters = k.replace(/[^a-z]/g, '').length;
  if (letters <= 2) return /^\p{Lu}/u.test(surface) && TITLE_BEFORE.test(before);
  if (letters === 3) return /^\p{Lu}/u.test(surface);
  return true;
}

const TYPES_ALT = [...new Set(STREET_TYPES)].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
const PART_ALT = [...PARTICLES].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
const BACK_CIVIC = (civic: string) =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}])(${escapeRegex(civic)})((?:[ ,']*(?:${TYPES_ALT}|${PART_ALT})\\.?(?![\\p{L}\\p{N}]))*)[ ,']*$`, 'du');
const BACK_TYPE = new RegExp(`(?:^|[^\\p{L}\\p{N}])(${TYPES_ALT})\\.?(?:[ ']+(?:${PART_ALT}))?[ ']*$`, 'du');
const FWD_TYPE = new RegExp(`^[ ,]*(?:${TYPES_ALT})\\.?(?![\\p{L}\\p{N}])`, 'u');
const DASH = /[‐-―−-]/;
const PARTICLE_WORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'the', 'of']);
const LONG_TYPES = [...new Set(STREET_TYPES)].filter((t) => t.length >= 3 && !t.includes(' '));

/** `chars` in the letter and digit slots of `surface`, its separators kept; null when the counts differ. */
function placeAlnum(surface: string, chars: string[]): string | null {
  const slots = [...surface];
  if (slots.filter((c) => /[\p{L}\p{N}]/u.test(c)).length !== chars.length) return null;
  let i = 0;
  return slots.map((c) => (/[\p{L}\p{N}]/u.test(c) ? chars[i++]! : c)).join('');
}

/** "91-97 rue de l'Arpent": civic number, street word, article and name. */
function streetLine(a: AddressParts): string {
  const particle = a.particle ? (/['’]$/.test(a.particle) ? a.particle : `${a.particle} `) : '';
  return `${[a.civic, a.streetType].filter(Boolean).join(' ')} ${particle}${a.streetName ?? ''}`.trim();
}

/**
 * What a scan leaves between a civic number's first digits and the street
 * name: OCR debris and one street word read a letter off ("-1'6~.roe",
 * ", chemfn dë /'"). A street word is required, so "page 10 Saint-Louis" isn't an address.
 */
function ocrStreetGap(gap: string): boolean {
  let type = false;
  for (const w of gap.split(/[^a-z]+/).filter(Boolean)) {
    if (PARTICLE_WORDS.has(w)) continue;
    if (!type && LONG_TYPES.some((t) => withinEdits(w, t, 1))) {
      type = true;
      continue;
    }
    return false;
  }
  return type;
}

function findFoldedIdx(f: Folded, needle: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!needle) return out;
  let from = 0;
  for (;;) {
    const at = f.text.indexOf(needle, from);
    if (at < 0) break;
    const end = at + needle.length;
    const okStart = !isWordChar(needle[0]) || !isWordChar(f.text[at - 1]);
    const okEnd = !isWordChar(needle[needle.length - 1]) || !isWordChar(f.text[end]);
    if (okStart && okEnd) out.push([at, end]);
    from = at + 1;
  }
  return out;
}

/** True when [start, end) is one half of a hyphenated word: "Jean" inside "Saint-Jean". */
function isCompoundPiece(text: string, start: number, end: number): boolean {
  const p = text[start - 1];
  const n = text[end];
  return (!!p && DASH.test(p) && isWordChar(text[start - 2])) || (!!n && DASH.test(n) && isWordChar(text[end + 1]));
}

interface CharView {
  chars: string;
  pos: number[];
}

function view(text: string, keep: RegExp, transform: (c: string) => string): CharView {
  let chars = '';
  const pos: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (!keep.test(c)) continue;
    for (const t of transform(c)) {
      chars += t;
      pos.push(i);
    }
  }
  return { chars, pos };
}

function sides(e: Entity, dir: Direction): Array<{ src: EntityValue; dst: EntityValue; surfaces: string[] }> {
  if (dir === 'anonymize') return [{ src: e.real, dst: e.fake, surfaces: e.surfaces ?? [] }];
  return [e.fake, ...(e.aliases ?? [])].map((src) => ({ src, dst: e.real, surfaces: [] }));
}

/**
 * Find every mention of the given entities in `text`. Anonymize looks for real
 * values and proposes fakes; restore does the reverse. The result is
 * non-overlapping and sorted by position.
 */
export function findMatches(text: string, entities: Entity[], dir: Direction, opts: MatchOptions = {}): Match[] {
  const f = foldWithMap(text);
  const lower = text.toLowerCase();
  let lowerWords: Set<string> | undefined;
  let tokens: Array<{ start: number; end: number; text: string; key: string }> | undefined;
  let alnum: CharView | undefined;
  let digits: CharView | undefined;
  let dates: DateHit[] | undefined;
  let amounts: AmountHit[] | undefined;
  const cands: Cand[] = [];
  // A province named alone is kept (isProvince), even when a value of an older project says otherwise.
  const active = entities.filter((e) => e.enabled && !isProvince(e.real.text));

  const push = (e: Entity, start: number, end: number, replacement: string, kind: string, prio: number) => {
    const surface = text.slice(start, end);
    if (replacement === surface) return;
    cands.push({ start, end, surface, replacement, entityId: e.id, type: e.type, kind, prio, confidence: 'high', projectId: e.projectId });
  };
  // The same mention repeats a lot in long documents; build each replacement once.
  const replCache = new Map<string, string>();
  const cached = (key: string, surface: string, make: () => string) => {
    const k = `${key}\u0000${surface}`;
    let r = replCache.get(k);
    if (r === undefined) {
      r = make();
      replCache.set(k, r);
    }
    return r;
  };

  // Lone names are only trustworthy when no other entity in the same project shares them.
  const nameOwners = new Map<string, Set<string>>();
  for (const e of active) {
    if (e.type !== 'person') continue;
    for (const { src } of sides(e, dir)) {
      const p = withoutTitles(src.person ?? parsePersonName(src.text));
      for (const [k, v] of [['last', p.last], ['first', p.first]] as const) {
        if (!v) continue;
        const key = `${e.projectId ?? ''}|${k}|${fold(v)}`;
        if (!nameOwners.has(key)) nameOwners.set(key, new Set());
        nameOwners.get(key)!.add(e.id);
      }
    }
  }

  for (const e of active) {
    // Restoring, a fake exactly as an output wrote it gets back what it replaced (see applyMentionLogs).
    // Several words ("M. Soucy", "3 juillet 1973") are searched for as such, ahead of the rebuilt
    // matches; one word is whatever the matcher finds there below.
    if (dir === 'restore') {
      for (const [key, real] of mentionKeys(e)) {
        if (!/[\s,]/.test(key.trim())) continue;
        for (const [fa, fb] of findFoldedIdx(f, fold(key))) {
          const [a, b] = unfoldRange(f, fa, fb);
          if (text.slice(a, b) === key) push(e, a, b, real, 'mention', 4);
        }
      }
    }
    for (const [sideIdx, { src, dst, surfaces }] of sides(e, dir).entries()) {
      const ck = `${e.id}:${sideIdx}`;
      switch (e.type) {
        case 'person': {
          // Values saved before titles were kept out ({ first: "Mme" }, a surface "Mme") still never match a lone title.
          const sp = withoutTitles(src.person ?? parsePersonName(src.text));
          const dp = withoutTitles(dst.person ?? parsePersonName(dst.text));
          const needles: Array<[string, string, number]> = [];
          if (sp.first && sp.last) {
            if (sp.middle) needles.push([`${sp.first} ${sp.middle} ${sp.last}`, 'full', 3]);
            // Restoring, a fake's first two names without the last ("Gaétan Benoît" for Gaétan Benoît Cyr) are still ours.
            if (sp.middle && dir === 'restore') needles.push([`${sp.first} ${sp.middle}`, 'full', 2], [`${sp.middle} ${sp.last}`, 'full', 2]);
            needles.push([`${sp.first} ${sp.last}`, 'full', 3], [`${sp.last}, ${sp.first}`, 'full', 3], [`${sp.last} ${sp.first}`, 'full', 3]);
            for (const ini of initialsNeedles(sp.first)) needles.push([`${ini} ${fold(sp.last)}`, 'initial', 3]);
          } else if (!sp.last) {
            needles.push([src.text, 'full', 3]);
          }
          for (const s of surfaces) needles.push([s, 'surface', 3]);
          if (sp.last) needles.push([sp.last, 'last', 2], [`${sp.last}s`, 'last', 2]);
          if (sp.first && fold(sp.first).length >= 3) needles.push([sp.first, 'first', 1]);
          // Each half of a compound surname alone: "M. Tremblay" for "Mathieu Tremblay-Chevalier" (→ the fake's matching half).
          const halves: Array<[string, string]> = [];
          const srcHalves = sp.last?.split('-') ?? [];
          if (srcHalves.length === 2 && dp.last) {
            const dstHalves = dp.last.split('-');
            srcHalves.forEach((h, i) => {
              if (fold(h).length >= 5) halves.push([h, dstHalves.length === 2 ? dstHalves[i]! : dp.last!]);
            });
          }
          for (const [h, repl] of halves) {
            for (const [fa, fb] of findFoldedIdx(f, fold(h))) {
              const [a, b] = unfoldRange(f, fa, fb);
              if (isCompoundPiece(text, a, b)) continue;
              const surface = text.slice(a, b);
              if (!lonePartOk(h, surface, text.slice(Math.max(0, a - 12), a), (lowerWords ??= lowercaseOf(text, opts)))) continue;
              push(e, a, b, matchCase(surface, repl), 'last', 2);
            }
          }
          // OCR misreads a letter or two in a scan: "Math1eu", "Tremolay", "Bolsvenu". Anonymizing, those count too.
          if (dir === 'anonymize') {
            tokens ??= wordTokens(text);
            lowerWords ??= lowercaseOf(text, opts);
            for (const [part, repl] of [
              [sp.last, dp.last],
              [sp.first, dp.first],
              ...halves,
            ] as Array<[string | undefined, string | undefined]>) {
              const k = part ? fold(part).replace(/[^a-z0-9-]/g, '') : '';
              if (k.length < 5) continue;
              const max = k.length >= 10 ? 2 : 1;
              if (!repl) continue;
              for (const t of tokens) {
                if (t.key === k || Math.abs(t.key.length - k.length) > max || lowerWords.has(t.key)) continue;
                if (max < 2 && t.key[0] !== k[0] && t.key[t.key.length - 1] !== k[k.length - 1]) continue;
                if (!/^\p{Lu}/u.test(t.text) || !withinEdits(t.key, k, max)) continue;
                push(e, t.start, t.end, matchCase(t.text, repl), 'fuzzy', 0);
              }
            }
          }
          for (const [needle, kind, prio] of needles) {
            if (isTitleOnly(needle)) continue;
            // One word on its own, whether a name piece or a surface the model reported alone.
            const lone = PART_KINDS.has(kind) || !/[\s,]/.test(needle.trim());
            for (const [fa, fb] of findFoldedIdx(f, fold(needle))) {
              const [a, b] = unfoldRange(f, fa, fb);
              // A lone word inside a hyphenated one is someone else's or a town's: "Paul" in Baie-Saint-Paul.
              if ((PART_KINDS.has(kind) || lone) && isCompoundPiece(text, a, b)) continue;
              const surface = text.slice(a, b);
              if (lone && !lonePartOk(needle, surface, text.slice(Math.max(0, a - 12), a), (lowerWords ??= lowercaseOf(text, opts)))) continue;
              push(e, a, b, cached(ck, surface, () => substitutePerson(surface, sp, dp, dst.text)), kind, prio);
            }
          }
          break;
        }

        case 'address': {
          const sa = src.address?.streetName ? src.address : { ...parseAddress(src.text), ...src.address };
          const da = dst.address?.streetName ? dst.address : { ...parseAddress(dst.text), ...dst.address };
          if (!sa.streetName) {
            for (const [fa, fb] of findFoldedIdx(f, fold(src.text))) {
              const [a, b] = unfoldRange(f, fa, fb);
              push(e, a, b, matchCase(text.slice(a, b), dst.text), 'full', 3);
            }
            break;
          }
          for (const [fa, fb] of streetNameVariants(fold(sa.streetName)).flatMap((v) => findFoldedIdx(f, v))) {
            const back = f.text.slice(Math.max(0, fa - 60), fa);
            const offset = fa - back.length;
            const fwd = f.text.slice(fb, fb + 24).match(FWD_TYPE);
            const end = fb + (fwd ? fwd[0].length : 0);
            let start = -1;
            let kind = 'street';
            const civic = sa.civic ? back.match(BACK_CIVIC(fold(sa.civic))) : null;
            if (civic?.indices?.[1]) {
              start = offset + civic.indices[1][0];
              kind = 'full';
            } else {
              const t = back.match(BACK_TYPE);
              if (t?.indices?.[1]) start = offset + t.indices[1][0];
              else if (fwd) start = fa;
            }
            const lead = sa.civic?.match(/^\d+/)?.[0];
            if (start < 0 && dir === 'anonymize' && lead) {
              const tail = back.slice(-24);
              const m = tail.match(new RegExp(`(?:^|[^\\p{L}\\p{N}])(${lead})(?!\\p{N})([^\\n]*)$`, 'du'));
              if (m?.indices?.[1] && ocrStreetGap(m[2]!)) {
                start = offset + back.length - tail.length + m.indices[1][0];
                kind = 'ocr';
              }
            }
            // Restoring, a fake street name alone is ours ("« Saint-Isidore »" in an AI's note): the real name comes back.
            if (start < 0 && dir === 'restore' && da.streetName && fold(sa.streetName).replace(/[^a-z]/g, '').length >= 6) {
              const [a, b] = unfoldRange(f, fa, fb);
              const surface = text.slice(a, b);
              if (/^\p{Lu}/u.test(surface) && !isCompoundPiece(text, a, b) && lonePartOk(sa.streetName, surface, '', (lowerWords ??= lowercaseOf(text, opts)))) {
                push(e, a, b, matchCase(surface, da.streetName), 'street-name', 1);
              }
            }
            if (start < 0) continue;
            const [a, b] = unfoldRange(f, start, end);
            const surface = text.slice(a, b);
            // A scan's garbled civic number can't be substituted in place: the fake's street line replaces it whole.
            const repl = kind === 'ocr' ? matchCase(surface, streetLine({ ...da, streetType: da.streetType ?? sa.streetType ?? 'rue' })) : cached(ck, surface, () => substituteAddress(surface, sa, da));
            push(e, a, b, repl, kind, kind === 'full' || kind === 'ocr' ? 3 : 2);
          }
          break;
        }

        case 'phone': {
          const needle = digitsKey(src.text).slice(-10);
          if (needle.length < 7) break;
          digits ??= view(text, /\d/, (c) => c);
          const dstDigits = digitsKey(dst.text).slice(-10);
          let from = 0;
          for (;;) {
            const k = digits.chars.indexOf(needle, from);
            if (k < 0) break;
            from = k + 1;
            let a = digits.pos[k]!;
            const b = digits.pos[k + needle.length - 1]! + 1;
            if (!/^[\d\s.\-()\u00ad\u2010-\u2015\u2212]*$/.test(text.slice(a, b))) continue;
            // Take in the "(" of "(450) 662-1934" so the whole number is one span.
            if (text[a - 1] === '(' && text.slice(a, b).includes(')')) a -= 1;
            if (k > 0) {
              const prev = digits.pos[k - 1]!;
              const gap = text.slice(prev + 1, a);
              // One separator continues a number; a line break, a column gap or a code like "G0A 1L7" before it doesn't.
              const contiguous = (gap === '' || /^[ \u00a0.\-()\u00ad\u2010-\u2015]{1,2}$/.test(gap)) && !/\p{L}/u.test(text[prev - 1] ?? '');
              // A leading "1" country code is fine; any other digit run means this is part of a longer number.
              const prevStandsAlone = k - 1 === 0 || !/^[\s.\-()]{0,2}$/.test(text.slice(digits.pos[k - 2]! + 1, prev));
              if (contiguous && !(text[prev] === '1' && prevStandsAlone)) continue;
            }
            const nextIdx = k + needle.length;
            if (nextIdx < digits.pos.length) {
              const gap = text.slice(b, digits.pos[nextIdx]!);
              if (gap === '' || /^[ \u00a0.\-\u00ad\u2010-\u2015]$/.test(gap)) continue;
            }
            if (partOfAmount(text, a, b)) continue;
            const repl = reshapeDigits(text.slice(a, b), dstDigits) ?? dst.text;
            push(e, a, b, repl, 'digits', 3);
          }
          break;
        }

        case 'email': {
          const needle = src.text.trim().toLowerCase();
          let from = 0;
          for (;;) {
            const at = lower.indexOf(needle, from);
            if (at < 0) break;
            from = at + 1;
            const end = at + needle.length;
            const before = text[at - 1];
            const after = text[end];
            if (before && /[A-Za-z0-9._%+-]/.test(before)) continue;
            if (after && (/[A-Za-z0-9_%+-]/.test(after) || (after === '.' && /[A-Za-z0-9]/.test(text[end + 1] ?? '')))) continue;
            push(e, at, end, matchCase(text.slice(at, end), dst.text.toLowerCase()), 'email', 3);
          }
          // Restoring, an AI may quote just the fake's mailbox ("jonathan.larue"): distinctive enough to put back alone.
          const [srcLocal = ''] = needle.split('@');
          const [dstLocal = ''] = dst.text.trim().toLowerCase().split('@');
          // Or the mailbox with its "@" and no domain ("gagnon@"): an address cut short.
          if (dir === 'restore' && srcLocal.length >= 3 && srcLocal !== dstLocal) {
            for (const m of lower.matchAll(new RegExp(`(?<![\\w.@-])${escapeRegex(srcLocal)}(?=@(?![\\w-]))`, 'g'))) {
              push(e, m.index!, m.index! + srcLocal.length, matchCase(text.slice(m.index!, m.index! + srcLocal.length), dstLocal), 'email', 2);
            }
          }
          if (dir === 'restore' && srcLocal.length >= 6 && /[._]/.test(srcLocal) && srcLocal !== dstLocal) {
            for (const m of lower.matchAll(new RegExp(`(?<![\\w.@-])${escapeRegex(srcLocal)}(?![\\w@-]|\\.\\w)`, 'g'))) {
              push(e, m.index!, m.index! + srcLocal.length, matchCase(text.slice(m.index!, m.index! + srcLocal.length), dstLocal), 'email', 2);
            }
            // And the name it read in it: "patrick.cloutier@…" made Claude write "Patrick Cloutier".
            const fakeName = srcLocal.match(/^([a-z]{2,})[._]([a-z]{2,})$/);
            const realName = dstLocal.match(/^([\p{L}]{2,})[._-]([\p{L}]{2,})$/u);
            if (fakeName && realName) {
              const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1);
              for (const [fa, fb] of findFoldedIdx(f, `${fakeName[1]} ${fakeName[2]}`)) {
                const [a, b] = unfoldRange(f, fa, fb);
                if (!/^\p{Lu}/u.test(text.slice(a, b))) continue;
                push(e, a, b, matchCase(text.slice(a, b), `${cap(realName[1]!)} ${cap(realName[2]!)}`), 'email-name', 1);
              }
            }
          }
          break;
        }

        case 'dob':
        case 'date': {
          const srcIso = src.iso ?? parseDateLoose(src.text)?.iso;
          const dstIso = dst.iso ?? parseDateLoose(dst.text)?.iso;
          if (srcIso) {
            dates ??= findDates(text);
            for (const h of dates) {
              const c = h.candidates.find((x) => x.iso === srcIso);
              if (c) push(e, h.start, h.end, dstIso ? renderDate(dstIso, c.format) : dst.text, 'date', 3);
            }
          }
          // Written so it doesn't read as a date (OCR'd "l5 janvier 1975"): find it as written.
          if (!parseDate(src.text)) {
            for (const needle of [src.text, ...surfaces]) {
              for (const [fa, fb] of findFoldedIdx(f, fold(needle))) {
                const [a, b] = unfoldRange(f, fa, fb);
                push(e, a, b, dst.text, 'surface', 3);
              }
            }
          }
          break;
        }

        case 'amount': {
          if (src.amount === undefined || dst.amount === undefined) break;
          amounts ??= findAmounts(text);
          for (const h of amounts) {
            if (Math.abs(h.value - src.amount) < 0.005) push(e, h.start, h.end, renderAmount(dst.amount, h.format), 'amount', 3);
          }
          break;
        }

        case 'organization': {
          const needles: Array<[string, string, number]> = [[src.text, 'org', 3], ...surfaces.map((s): [string, string, number] => [s, 'org', 3])];
          // The name without "Inc." or "Gestion": "Boisfranc" for "Boisfranc CO", as an AI shortens it.
          const core = splitOrg(src.text, ORG_KIND_WORDS, ORG_SUFFIXES).core;
          if (fold(core) !== fold(src.text) && fold(core).replace(/[^a-z]/g, '').length >= 5) needles.push([core, 'org-core', 1]);
          for (const [needle, kind, prio] of needles) {
            for (const [fa, fb] of findFoldedIdx(f, fold(needle))) {
              const [a, b] = unfoldRange(f, fa, fb);
              const surface = text.slice(a, b);
              if (kind === 'org-core' && (!/^\p{Lu}/u.test(surface) || isCompoundPiece(text, a, b) || !lonePartOk(core, surface, '', (lowerWords ??= lowercaseOf(text, opts))))) continue;
              push(e, a, b, cached(ck, surface, () => substituteOrg(surface, src.text, dst.text)), kind, prio);
            }
          }
          break;
        }

        default: {
          // Identifiers: compare letters and digits only, so "AB-123 456" matches "AB123456".
          const needle = alnumKey(src.text);
          // Punctuation the value itself has may sit inside the span ("Transit 04512, Institution 828").
          const own = new Set(src.text.replace(/[\p{L}\p{N}\s]/gu, ''));
          // A number alone ("4827") is never swapped inside an amount ("4827,35 $"): the AI needs amounts exact.
          const digitsOnly = !/\p{L}/u.test(src.text);
          // A handle sits after a "/" or "@" that would read as part of a longer identifier: matched as words.
          if (needle.length >= 4 && e.type !== 'other') {
            alnum ??= view(text, /[\p{L}\p{N}]/u, (c) => c.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase());
            const dstKey = alnumKey(dst.text);
            const dstChars = [...dst.text].filter((c) => /[\p{L}\p{N}]/u.test(c));
            let from = 0;
            for (;;) {
              const k = alnum.chars.indexOf(needle, from);
              if (k < 0) break;
              from = k + 1;
              const a = alnum.pos[k]!;
              const b = alnum.pos[k + needle.length - 1]! + 1;
              if (![...text.slice(a, b)].every((c) => /[\p{L}\p{N}\s\-./]/u.test(c) || own.has(c))) continue;
              // Restoring, a long fake is ours even when the AI glued more to it ("2285-77464-842"): fakes are unique.
              const glued = dir === 'restore' && needle.length >= 8 ? /^$/ : /^(?:|[-./])$/;
              if (k > 0) {
                const gap = text.slice(alnum.pos[k - 1]! + 1, a);
                if (glued.test(gap)) continue;
              }
              const nextIdx = k + needle.length;
              if (nextIdx < alnum.pos.length) {
                const gap = text.slice(b, alnum.pos[nextIdx]!);
                if (glued.test(gap)) continue;
              }
              if (digitsOnly && partOfAmount(text, a, b)) continue;
              // The value's own letters and case in the surface's separators ("3f2a9c10-…" stays lowercase where the fake had digits).
              const placed = placeAlnum(text.slice(a, b), dstChars);
              push(e, a, b, placed ? matchCase(text.slice(a, b), placed) : (reshapeAlnum(text.slice(a, b), dstKey) ?? dst.text), 'alnum', 3);
            }
            // Restoring, an AI shortens a long identifier to its first block ("session 70e16b20…"): ours too.
            const [srcHead = '', dstHead = ''] = [src.text, dst.text].map((t) => t.trim().split('-')[0]!);
            if (dir === 'restore' && src.text.includes('-') && srcHead.length >= 8 && /\p{L}/u.test(srcHead) && /\d/.test(srcHead)) {
              for (const m of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}-])${escapeRegex(srcHead)}(?![\\p{L}\\p{N}]|-[\\p{L}\\p{N}])`, 'giu'))) {
                push(e, m.index!, m.index! + m[0].length, matchCase(m[0], dstHead), 'alnum-head', 1);
              }
            }
          } else {
            for (const [fa, fb] of findFoldedIdx(f, fold(src.text))) {
              const [a, b] = unfoldRange(f, fa, fb);
              push(e, a, b, matchCase(text.slice(a, b), dst.text), 'full', 3);
            }
          }
        }
      }
    }
  }

  // Confidence for lone names.
  const strongEntities = new Set(cands.filter((c) => STRONG.has(c.kind)).map((c) => c.entityId));
  const byId = new Map(active.map((e) => [e.id, e]));
  const partsOf = new Map<string, { last?: string; first?: string }>();
  const kept: Cand[] = [];
  for (const c of cands) {
    if (c.kind === 'first' || c.kind === 'last') {
      if (opts.preferProject && c.projectId !== opts.preferProject) continue;
      let p = partsOf.get(c.entityId);
      if (!p) {
        const src = sides(byId.get(c.entityId)!, dir)[0]!.src;
        const pp = src.person ?? parsePersonName(src.text);
        p = { last: pp.last && fold(pp.last), first: pp.first && fold(pp.first) };
        partsOf.set(c.entityId, p);
      }
      const v = c.kind === 'last' ? p.last : p.first;
      const owners = nameOwners.get(`${c.projectId ?? ''}|${c.kind}|${v ?? ''}`);
      const unique = !owners || owners.size <= 1;
      if (!unique) c.confidence = 'low';
      else if (c.kind === 'first' && !strongEntities.has(c.entityId)) c.confidence = 'low';
    }
    kept.push(c);
  }

  const resolved = resolveOverlaps(kept, strongEntities);
  return dir === 'restore' ? applyMentionLogs(resolved, active) : resolved;
}

/**
 * Pick the non-overlapping set of candidates with the most weight (length ×
 * priority), rather than greedily taking the longest. In "Luc Gagnier, Luc
 * Gagnier" the greedy choice is the bogus "Gagnier, Luc" in the middle; the
 * weighted choice is the two full names. A run of spaces counts as one, or
 * "Lamy      Olivier" across two signature columns would outweigh both names.
 */
function resolveOverlaps(cands: Cand[], strong: Set<string>): Match[] {
  const weight = (c: Cand) =>
    c.surface.replace(/\s+/g, ' ').length * c.prio + (c.confidence === 'high' ? 0.5 : 0) + (strong.has(c.entityId) ? 0.25 : 0);
  const sorted = [...cands].sort((x, y) => x.end - y.end || weight(y) - weight(x));
  const n = sorted.length;
  const best: number[] = new Array(n + 1).fill(0);
  const take: boolean[] = new Array(n).fill(false);
  const prev: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const c = sorted[i]!;
    // Last candidate ending at or before this one starts (1-based index into best).
    let lo = 0;
    let hi = i;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.end <= c.start) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo;
    const withIt = weight(c) + best[lo]!;
    if (withIt > best[i]!) {
      best[i + 1] = withIt;
      take[i] = true;
    } else {
      best[i + 1] = best[i]!;
    }
  }
  const kept: Cand[] = [];
  for (let i = n - 1; i >= 0; ) {
    if (take[i]) {
      kept.push(sorted[i]!);
      i = prev[i]! - 1;
    } else {
      i--;
    }
  }
  return kept
    .sort((a, b) => a.start - b.start)
    .map(({ prio: _prio, ...m }) => m);
}

export function applyMatches(text: string, matches: Match[]): string {
  let out = '';
  let at = 0;
  for (const m of [...matches].sort((a, b) => a.start - b.start)) {
    if (m.start < at) continue;
    out += text.slice(at, m.start) + m.replacement;
    at = m.end;
  }
  return out + text.slice(at);
}

/** Which project an outside document most likely came from, by strong hits per project. */
export function rankProjects(matches: Match[]): Array<{ projectId: string; hits: number }> {
  const counts = new Map<string, number>();
  for (const m of matches) {
    if (!m.projectId || !STRONG.has(m.kind)) continue;
    counts.set(m.projectId, (counts.get(m.projectId) ?? 0) + 1);
  }
  return [...counts.entries()].map(([projectId, hits]) => ({ projectId, hits })).sort((a, b) => b.hits - a.hits);
}

/**
 * The replacement for a span that refers to `e` but wasn't found by the
 * matcher (a Claude suggestion, a manual selection): swap whichever parts of
 * the value it contains, or fall back to the whole value.
 */
export function replacementFor(e: Entity, surface: string, dir: Direction): string {
  const src = dir === 'anonymize' ? e.real : e.fake;
  const dst = dir === 'anonymize' ? e.fake : e.real;
  switch (e.type) {
    case 'person': {
      const sp = withoutTitles(src.person ?? parsePersonName(src.text));
      const dp = withoutTitles(dst.person ?? parsePersonName(dst.text));
      const out = substitutePerson(surface, sp, dp, dst.text);
      // A misspelled single name ("Simmard" for "Simard") maps to the part it's closest to, not the whole name.
      if (out === matchNameCase(surface, dst.text) && !/\s/.test(surface.trim())) {
        const f = fold(surface);
        for (const k of ['last', 'first'] as const) {
          const s = sp[k];
          const d = dp[k];
          if (s && d && withinEdits(f, fold(s), 2)) return matchNameCase(surface, d);
        }
      }
      return out;
    }
    case 'address': {
      const sa = { ...parseAddress(src.text), ...src.address };
      const da = { ...parseAddress(dst.text), ...dst.address };
      const out = substituteAddress(surface, sa, da);
      return out === surface ? dst.text : out;
    }
    case 'organization':
      return substituteOrg(surface, src.text, dst.text);
    case 'phone':
      return reshapeDigits(surface, digitsKey(dst.text).slice(-10)) ?? dst.text;
    default:
      return reshapeAlnum(surface, alnumKey(dst.text)) ?? matchCase(surface, dst.text);
  }
}
