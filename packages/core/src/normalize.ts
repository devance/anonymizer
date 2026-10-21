/**
 * Bump when fold() changes. Stored next to every HMAC so lookups made with an
 * older normalization can be found and recomputed instead of silently missing.
 */
export const NORM_VERSION = 1;

const APOSTROPHES = /[‘’ʼ`´′]/g;
// U+00AD too: PDFs (ours included) can draw a hyphen with the soft-hyphen code.
const DASHES = /[\u00ad‐‑‒–—―−-]/;
const EXPANSIONS: Record<string, string> = { œ: 'oe', æ: 'ae', ß: 'ss' };

export interface Folded {
  text: string;
  /** starts[i] is the index in the original string of folded char i. */
  starts: number[];
  /** ends[i] is the exclusive end index in the original string of folded char i. */
  ends: number[];
}

const foldCache = new Map<string, string>();

function foldChar(ch: string): string {
  let f = foldCache.get(ch);
  if (f === undefined) {
    const lower = ch.toLowerCase();
    f = EXPANSIONS[lower] ?? lower.normalize('NFD').replace(/\p{M}/gu, '').replace(APOSTROPHES, "'");
    foldCache.set(ch, f);
  }
  return f;
}

function isSpaceOrDash(code: number, ch: string): boolean {
  if (code < 128) return code === 32 || (code >= 9 && code <= 13) || code === 45;
  return /\s/u.test(ch) || DASHES.test(ch);
}

/**
 * Lowercase, strip accents, unify apostrophes, treat hyphens as spaces and
 * collapse whitespace (including line breaks), keeping a map back to the
 * original offsets. "Marie-Ève" and "MARIE EVE" fold to the same string, and a
 * name broken across two lines still matches.
 */
export function foldWithMap(input: string): Folded {
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let lastWasSpace = true;
  for (let i = 0; i < input.length; ) {
    const code = input.charCodeAt(i);
    // Surrogate pairs stay together.
    const len = code >= 0xd800 && code <= 0xdbff && i + 1 < input.length ? 2 : 1;
    const ch = len === 1 ? input[i]! : input.slice(i, i + 2);
    if (isSpaceOrDash(code, ch)) {
      if (!lastWasSpace) {
        out.push(' ');
        starts.push(i);
        ends.push(i + len);
        lastWasSpace = true;
      } else if (ends.length > 0) {
        // Widen the existing space so a run of whitespace maps back as one span.
        ends[ends.length - 1] = i + len;
      }
    } else if (code < 128 && code !== 96) {
      // ASCII: just lowercase. (96 is the backtick, folded to an apostrophe below.)
      out.push(code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : ch);
      starts.push(i);
      ends.push(i + len);
      lastWasSpace = false;
    } else {
      const f = foldChar(ch);
      for (const c of f) {
        out.push(c);
        starts.push(i);
        ends.push(i + len);
      }
      lastWasSpace = false;
    }
    i += len;
  }
  return { text: out.join(''), starts, ends };
}

export function fold(input: string): string {
  return foldWithMap(input).text.trim();
}

/** Map a [a, b) range in folded text back to the original string. */
export function unfoldRange(f: Folded, a: number, b: number): [number, number] {
  return [f.starts[a]!, f.ends[b - 1]!];
}

export function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Uppercase letters + digits only, for identifiers whose separators vary. */
export function alnumKey(s: string): string {
  return fold(s).replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
}

export function digitsKey(s: string): string {
  return s.replace(/\D/g, '');
}

/**
 * Give a replacement the casing of what it replaces: "TREMBLAY" → "GAGNON",
 * "tremblay" → "gagnon", anything mixed keeps the replacement's own casing.
 */
export function matchCase(surface: string, replacement: string): string {
  const letters = surface.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2) return replacement;
  if (letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
    return replacement.toUpperCase();
  }
  if (letters === letters.toLowerCase() && letters !== letters.toUpperCase()) {
    return replacement.toLowerCase();
  }
  return replacement;
}

/**
 * matchCase for names, which a document may store in capitals ("MARGARET
 * KOWALCZYK" in a list) and write capitalised elsewhere: a capitalised mention
 * gets a name in capitals back capitalised ("Margaret"), so restoring follows
 * the mention and not the first way the name was seen.
 */
export function matchNameCase(surface: string, replacement: string): string {
  const out = matchCase(surface, replacement);
  if (out !== replacement) return out;
  const letters = surface.replace(/[^\p{L}]/gu, '');
  const repl = replacement.replace(/[^\p{L}]/gu, '');
  const capitalised = letters.length >= 2 && /^\p{Lu}/u.test(letters) && /\p{Ll}/u.test(letters);
  const capitals = repl.length >= 2 && repl === repl.toUpperCase() && repl !== repl.toLowerCase();
  if (!capitalised || !capitals) return replacement;
  return replacement.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_, before: string, c: string) => before + c.toUpperCase());
}

/**
 * Find every occurrence of a folded needle in folded text on word boundaries.
 * Returns ranges in the original string.
 */
export function findFolded(f: Folded, needle: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!needle) return out;
  let from = 0;
  for (;;) {
    const at = f.text.indexOf(needle, from);
    if (at < 0) break;
    const end = at + needle.length;
    const before = f.text[at - 1];
    const after = f.text[end];
    const needleStartsWord = isWordChar(needle[0]);
    const needleEndsWord = isWordChar(needle[needle.length - 1]);
    if ((!needleStartsWord || !isWordChar(before)) && (!needleEndsWord || !isWordChar(after))) {
      out.push(unfoldRange(f, at, end));
    }
    from = at + 1;
  }
  return out;
}
