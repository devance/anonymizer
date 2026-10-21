import { alnumKey, fold } from './normalize';
import { isProvince, parseAddress, parsePersonName } from './parse';
import type { Entity } from './types';

/** Edit distance, giving up once it exceeds `max`. */
export function withinEdits(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length]! <= max;
}

function allowedEdits(len: number): number {
  return len >= 10 ? 2 : len >= 5 ? 1 : 0;
}

/**
 * The parts of a real value worth looking for in OCR output, where exact
 * matching fails on a single misread letter: full names, surnames, street
 * names, and identifiers of six characters or more.
 */
export function leakNeedles(e: Entity): { words: string[]; ids: string[] } {
  const words: string[] = [];
  const ids: string[] = [];
  const v = e.real;
  if (e.type === 'person') {
    const p = v.person ?? parsePersonName(v.text);
    if (p.first && p.last) words.push(`${p.first} ${p.last}`);
    if (p.last && fold(p.last).length >= 4) words.push(p.last);
  } else if (e.type === 'address') {
    const a = { ...parseAddress(v.text), ...v.address };
    if (a.streetName && fold(a.streetName).length >= 4) words.push(a.streetName);
  } else if (e.type === 'organization' || e.type === 'email' || e.type === 'other') {
    if (fold(v.text).length >= 5) words.push(v.text);
  } else if (e.type !== 'date' && e.type !== 'dob' && e.type !== 'amount') {
    const k = alnumKey(v.text);
    if (k.length >= 6) ids.push(k);
  }
  return { words: words.map(fold), ids };
}

/**
 * The project's fakes as the leak checks read words: each fake folded whole,
 * word by word, and each half of a compound. A word that is exactly one of
 * them is that fake, though a real value is an edit or two away: the check
 * allows those edits for OCR misreads, and fakes are drawn before every real
 * value is known ("Denise", one tenant's fake, next to "Denis", the seller
 * found in a later document).
 */
export function fakeWords(entities: Entity[]): Set<string> {
  const out = new Set<string>();
  for (const e of entities) {
    const folded = fold(e.fake.text);
    const parts = folded.split(/[^\p{L}\p{N}@.']+/u).filter(Boolean);
    if (parts.length > 0) out.add(parts.join(' '));
    for (const w of [...parts, ...folded.split(/\s+/)]) if (w) out.add(w);
  }
  return out;
}

/**
 * Entities whose real value shows up, possibly misspelled by OCR, in `text`.
 * Words are compared token-window by token-window; identifiers are compared
 * on their letters and digits with one wrong character allowed. A window that
 * is exactly a fake of the project is that fake (fakeWords), a number too:
 * "450 555-0186", drawn for one tenant, before a real "450 555-0187" turned
 * up in a later lease.
 */
/**
 * The text's words, folded, each marked when it is a piece of a hyphenated compound: a lone
 * name never matches one ("Paul" in Baie-Saint-Paul, a town kept on purpose, or in Jean-Paul).
 * A hyphen at a line break ("Tremb-" then "lay") joins nothing.
 */
function tokenize(text: string): { tokens: string[]; pieces: boolean[] } {
  const tokens: string[] = [];
  const pieces: boolean[] = [];
  const word = /[\p{L}\p{N}]/u;
  for (const m of text.matchAll(/[\p{L}\p{N}@.']+/gu)) {
    const a = m.index;
    const b = a + m[0].length;
    const t = fold(m[0]);
    if (!t) continue;
    tokens.push(t);
    pieces.push((text[a - 1] === '-' && word.test(text[a - 2] ?? '')) || (text[b] === '-' && word.test(text[b + 1] ?? '')));
  }
  return { tokens, pieces };
}

export function fuzzyLeaks(text: string, entities: Entity[]): string[] {
  const { tokens, pieces } = tokenize(text);
  const alnum = alnumKey(text);
  const fakes = fakeWords(entities);
  const fakeIds = new Set(entities.map((e) => alnumKey(e.fake.text)).filter((k) => k.length >= 6));
  const hits: string[] = [];
  for (const e of entities) {
    if (!e.enabled || isProvince(e.real.text)) continue;
    const { words, ids } = leakNeedles(e);
    let found = false;
    for (const w of words) {
      const n = w.split(/[^\p{L}\p{N}@.']+/u).filter(Boolean).length || 1;
      const max = allowedEdits(w.length);
      const first = w[0];
      const last = w[w.length - 1];
      for (let i = 0; i + n <= tokens.length && !found; i++) {
        // Cheap filters first: with one edit, the first or the last letter survives.
        const t0 = tokens[i]!;
        if (n === 1 && (pieces[i] || Math.abs(t0.length - w.length) > max)) continue;
        const win = n === 1 ? t0 : tokens.slice(i, i + n).join(' ');
        if (Math.abs(win.length - w.length) > max) continue;
        if (max < 2 && win[0] !== first && win[win.length - 1] !== last) continue;
        if (withinEdits(win, w, max) && (win === w || !fakes.has(win))) found = true;
      }
      if (found) break;
    }
    for (const id of ids) {
      if (found) break;
      if (alnum.includes(id)) {
        found = true;
        break;
      }
      for (let i = 0; i + id.length <= alnum.length; i++) {
        let diff = 0;
        for (let j = 0; j < id.length && diff <= 1; j++) if (alnum[i + j] !== id[j]) diff++;
        if (diff === 1 && fakeIds.has(alnum.slice(i, i + id.length))) continue;
        if (diff <= 1) {
          found = true;
          break;
        }
      }
    }
    if (found) hits.push(e.id);
  }
  return hits;
}
