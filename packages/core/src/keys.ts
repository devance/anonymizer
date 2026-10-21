import { ORG_KIND_WORDS, ORG_SUFFIXES } from './data/places';
import { alnumKey, digitsKey, fold } from './normalize';
import { parseAddress, parsePersonName, splitOrg } from './parse';
import type { EntityType, EntityValue } from './types';

/**
 * The identity of a value: two mentions with the same key are the same thing.
 * Hashed (HMAC) on the server so real values can be looked up without being
 * stored in the clear.
 */
export function valueKey(type: EntityType, v: EntityValue): string {
  switch (type) {
    case 'person': {
      const p = v.person;
      if (p?.last) return fold([p.first, p.last].filter(Boolean).join(' '));
      return fold(v.text);
    }
    case 'address': {
      const a = v.address;
      if (a?.civic && a.streetName) return `${a.civic.toLowerCase()}|${fold(a.streetName)}`;
      return fold(v.text);
    }
    case 'phone':
      return digitsKey(v.text).slice(-10);
    case 'email':
      return v.text.trim().toLowerCase();
    case 'dob':
    case 'date':
      return v.iso ?? fold(v.text);
    case 'amount':
      return v.amount !== undefined ? v.amount.toFixed(2) : fold(v.text);
    case 'organization':
      return fold(splitOrg(v.text, ORG_KIND_WORDS, ORG_SUFFIXES).core);
    case 'postal_code':
    case 'sin':
    case 'health_card':
    case 'card_number':
    case 'bank_account':
    case 'id_number':
      return alnumKey(v.text);
    default:
      return fold(v.text);
  }
}

/**
 * Pieces of a value that a fake must never reuse within the same project: if a
 * real family is named Gagnon, no fake anywhere in that project may contain
 * "Gagnon", or restoring it would be ambiguous.
 */
export function valueParts(type: EntityType, v: EntityValue): string[] {
  const out: string[] = [];
  if (type === 'person' && v.person) {
    for (const p of [v.person.first, v.person.middle, v.person.last]) {
      if (p) out.push(fold(p), ...fold(p).split(' ').filter((w) => w.length > 2));
    }
  } else if (type === 'address') {
    const a = { ...parseAddress(v.text), ...v.address };
    if (a.streetName) out.push(fold(a.streetName));
    // Civic numbers too: a fake address never shows another real address's number.
    out.push(...(a.civic?.match(/\d+/g) ?? []));
  } else if (type === 'organization') {
    out.push(fold(splitOrg(v.text, ORG_KIND_WORDS, ORG_SUFFIXES).core));
  }
  return [...new Set(out)];
}

const INITIALS = /^(\p{L}\.\s?-?)+$/u;

/**
 * Every key by which the matcher could find this value in a text, so a fake
 * and a real value of the same project can be checked for sharing one: words
 * of names, street names and company names (the pieces of valueParts, without
 * initials, which are never matched alone), and the numbers, dates, amounts
 * and addresses the matcher compares as such. Keys are prefixed by how they
 * compare, so a phone and an account number with the same digits do collide
 * and a date and an amount never do.
 */
export function collisionKeys(type: EntityType, v: EntityValue): string[] {
  const value = type === 'person' && !v.person ? { ...v, person: parsePersonName(v.text) } : v;
  const out = valueParts(type, value).filter((p) => p.length >= 2 && !INITIALS.test(p));
  switch (type) {
    case 'person':
    case 'organization':
      break;
    case 'address':
      if (v.address?.civic && v.address.streetName) out.push(`addr:${valueKey(type, v)}`);
      break;
    case 'phone': {
      const d = digitsKey(v.text).slice(-10);
      if (d.length >= 7) out.push(`id:${d}`);
      break;
    }
    case 'email':
      out.push(`email:${valueKey(type, v)}`);
      break;
    case 'dob':
    case 'date':
      out.push(v.iso ? `date:${v.iso}` : `text:${fold(v.text)}`);
      break;
    case 'amount':
      if (v.amount !== undefined) out.push(`amount:${v.amount.toFixed(2)}`);
      break;
    default: {
      // Identifiers are compared on their letters and digits from four on (findMatches), shorter ones as written.
      const k = alnumKey(v.text);
      out.push(k.length >= 4 ? `id:${k}` : `text:${fold(v.text)}`);
    }
  }
  return [...new Set(out)];
}
