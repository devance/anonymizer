import { parseAmount } from './amounts';
import { parseDateLoose } from './dates';
import { valueKey } from './keys';
import { fold } from './normalize';
import { isTitleOnly, parseAddress, parsePersonName, withoutTitles } from './parse';
import type { Detection, EntityAttrs, EntityType, EntityValue } from './types';

export interface Candidate {
  type: EntityType;
  real: EntityValue;
  key: string;
  attrs?: EntityAttrs;
  /** Every distinct way this value was written in the document. */
  surfaces: string[];
}

export interface KnownValue {
  type: EntityType;
  real: EntityValue;
}

const IDENTIFIERS: ReadonlySet<EntityType> = new Set(['id_number', 'bank_account', 'health_card', 'card_number', 'sin', 'postal_code']);

function trimText(type: EntityType, text: string): string {
  let t = text.trim().replace(/\s+/g, ' ');
  if (type !== 'email' && type !== 'amount') t = t.replace(/[.,;:]+$/, '');
  if (IDENTIFIERS.has(type)) t = identifierCore(type, t);
  return t;
}

/**
 * The number itself when a model reports it with its label or context:
 * "Lot 1 975 432, Cadastre of Québec" → "1 975 432", "NAS 046 454 286" →
 * "046 454 286". The label would otherwise be scrambled with the number.
 */
function identifierCore(type: EntityType, text: string): string {
  // A Quebec health card starts with four letters of the holder's name: part of the number, not a label.
  const qc = type === 'health_card' ? /(?<![\p{L}\d])[A-Z]{4}[ -]?\d{4}[ -]?\d{4}(?![\p{L}\d])/iu.exec(text) : null;
  if (qc) return qc[0];
  const digits = (s: string) => s.replace(/\D/g, '').length;
  // Several numbers in one value stay together; a segment with no number is context.
  const numbered = text.split(/[,;]\s+/).filter((p) => digits(p) > 0);
  const words = (numbered.length === 1 ? numbered[0]! : text).split(' ');
  while (words.length > 1 && digits(words[0]!) === 0) words.shift();
  while (words.length > 1 && digits(words[words.length - 1]!) === 0) words.pop();
  const core = words.join(' ').replace(/^[#:.\s]+|[.,;:]+$/g, '');
  return core.replace(/[^\p{L}\p{N}]/gu, '').length >= 4 ? core : text;
}

export function toValue(d: Pick<Detection, 'type' | 'text' | 'person' | 'address'>): EntityValue {
  const text = trimText(d.type, d.text);
  switch (d.type) {
    case 'person': {
      const parsed = parsePersonName(text);
      const given = withoutTitles(d.person ?? {});
      return { text, person: given.last || given.first ? given : parsed };
    }
    case 'address': {
      // Only the parts the model copied from the text: "Sherbrooke West" for "Sherbrooke Street West" can't be replaced.
      const given = stripEmpty(d.address ?? {});
      const ft = fold(text);
      for (const k of ['civic', 'streetType', 'particle', 'streetName'] as const) if (given[k] && !ft.includes(fold(given[k]))) delete given[k];
      return { text, address: { ...parseAddress(text), ...given } };
    }
    case 'dob':
    case 'date':
      return { text, iso: parseDateLoose(text)?.iso };
    case 'amount':
      return { text, amount: parseAmount(text)?.value };
    default:
      return { text };
  }
}

function stripEmpty<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Two full first names that differ ("Dennis", "Denny"); an initial ("D.", "J.-F.") fits any. */
function otherFirstName(a: EntityValue, b: EntityValue): boolean {
  const fa = a.person?.first;
  const fb = b.person?.first;
  const initial = (s: string) => /^(\p{L}\.-?)+$/u.test(s);
  if (!fa || !fb || initial(fa) || initial(fb)) return false;
  return fold(fa) !== fold(fb);
}

function completeness(v: EntityValue): number {
  const p = v.person;
  if (p) return (p.first ? 2 : 0) + (p.last ? 2 : 0) + (p.middle ? 1 : 0) + v.text.length / 1000;
  const a = v.address;
  if (a) return (a.civic ? 2 : 0) + (a.streetName ? 2 : 0) + v.text.length / 1000;
  return v.text.length / 1000;
}

/**
 * Collapse detections from regex, Claude and known-entity matching into one
 * candidate per real-world value. "Jean Tremblay", "J. Tremblay" and
 * "M. Tremblay" in the same document become one person with three surfaces.
 */
export function mergeDetections(dets: Detection[], known: KnownValue[] = []): Candidate[] {
  const groups = new Map<string, Candidate>();
  const alias = new Map<string, string>();
  const resolve = (k: string) => {
    let cur = k;
    while (alias.has(cur)) cur = alias.get(cur)!;
    return cur;
  };

  const add = (gk: string, d: Detection) => {
    const value = toValue(d);
    if (!value.text) return;
    const existing = groups.get(resolve(gk));
    if (!existing) {
      groups.set(gk, { type: d.type, real: value, key: valueKey(d.type, value), attrs: d.attrs, surfaces: [value.text] });
      return;
    }
    if (!existing.surfaces.includes(value.text)) existing.surfaces.push(value.text);
    if (completeness(value) > completeness(existing.real)) {
      existing.real = value;
      existing.key = valueKey(d.type, value);
    }
    existing.attrs = { ...d.attrs, ...existing.attrs };
  };

  for (const d of dets) {
    // "Mme" alone (a model gives it the group of the woman the sentence is about) is no one's name.
    if (d.type === 'person' && isTitleOnly(d.text)) continue;
    const value = toValue(d);
    const byValue = `${d.type}|${valueKey(d.type, value)}`;
    const byGroup = d.groupKey ? `${d.type}|g|${d.groupKey}` : undefined;
    const group = byGroup && groups.has(resolve(byGroup)) ? resolve(byGroup) : undefined;
    // "Denny Kowalczyk" in the group of "Dennis Kowalczyk" would keep "Denny": it gets its own fake.
    const inGroup = group !== undefined && !otherFirstName(groups.get(group)!.real, value);
    const target = inGroup ? group : groups.has(resolve(byValue)) ? resolve(byValue) : group === undefined ? (byGroup ?? byValue) : byValue;
    add(target, d);
    if (byGroup && target !== byGroup && !groups.has(resolve(byGroup))) alias.set(byGroup, target);
    if (target !== byValue && !groups.has(byValue)) alias.set(byValue, target);
  }

  // Merge groups that ended up with the same key.
  const byKey = new Map<string, Candidate>();
  for (const c of groups.values()) {
    const k = `${c.type}|${c.key}`;
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, c);
    else for (const s of c.surfaces) if (!prev.surfaces.includes(s)) prev.surfaces.push(s);
  }

  // A lone surname ("M. Tremblay") belongs to the one full person who carries it, if there's exactly one.
  const out: Candidate[] = [];
  const people = [...byKey.values()].filter((c) => c.type === 'person' && c.real.person?.first && c.real.person.last);
  const knownPeople = known.filter((k) => k.type === 'person' && k.real.person?.first && k.real.person.last);
  for (const c of byKey.values()) {
    const p = c.real.person;
    if (c.type === 'person' && p && !p.first && p.last) {
      const owners = [
        ...people.filter((o) => fold(o.real.person!.last!) === fold(p.last!)),
        ...knownPeople
          .filter((o) => fold(o.real.person!.last!) === fold(p.last!))
          .map((o) => ({ type: o.type, real: o.real, key: valueKey(o.type, o.real), surfaces: [] as string[] })),
      ];
      const distinct = new Map(owners.map((o) => [o.key, o]));
      if (distinct.size === 1) {
        const owner = [...distinct.values()][0]!;
        const inOut = people.find((x) => x.key === owner.key);
        if (inOut) {
          for (const s of c.surfaces) if (!inOut.surfaces.includes(s)) inOut.surfaces.push(s);
          continue;
        }
        out.push({ ...owner, surfaces: c.surfaces, attrs: c.attrs });
        continue;
      }
    }
    out.push(c);
  }
  return out;
}
