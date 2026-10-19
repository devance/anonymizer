import { alnumKey, fold } from './normalize';
import { parseAddress, parsePersonName } from './parse';
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
 * Entities whose real value shows up, possibly misspelled by OCR, in `text`.
 * Words are compared token-window by token-window; identifiers are compared
 * on their letters and digits with one wrong character allowed.
 */
export function fuzzyLeaks(text: string, entities: Entity[]): string[] {
  const tokens = fold(text).split(/[^\p{L}\p{N}@.']+/u).filter(Boolean);
  const alnum = alnumKey(text);
  const hits: string[] = [];
  for (const e of entities) {
    if (!e.enabled) continue;
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
        if (n === 1 && Math.abs(t0.length - w.length) > max) continue;
        const win = n === 1 ? t0 : tokens.slice(i, i + n).join(' ');
        if (Math.abs(win.length - w.length) > max) continue;
        if (max < 2 && win[0] !== first && win[win.length - 1] !== last) continue;
        if (withinEdits(win, w, max)) found = true;
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
