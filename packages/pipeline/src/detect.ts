import { ENTITY_TYPES, birthDateContext, findMatches, fold, isTitleOnly, withoutTitles, foldWithMap, unfoldRange, type ClaudeUsage, type Detection, type Entity, type EntityType, type Suggestion } from '@anon/core';
import { CutOffError, estimateTokens, type ModelClient } from './model';

const DETECT_SYSTEM = `You find personal information in documents so it can be replaced with realistic fakes before the document is shared with other AI tools. Documents are mostly from Québec, in French or English: insurance policies, mortgage and bank documents, contracts, leases, tax forms, medical and legal letters.

Report every mention of:
- person: any named individual (clients, spouses, children, brokers, notaries, doctors, signatories). Report the full name as written ("Jean-François Tremblay") as one entry, with its first / middle / last fields filled. Report partial mentions ("M. Tremblay", "J.-F. Tremblay", "Jean") as additional entries with the same group as the full name. Fill gender (f, m, or x when unclear, using titles like M./Mme/Mr./Mrs. and the first name) and lang (fr or en, the language of the first name) on every person entry.
- organization: companies, insurers, banks, firms, employers, schools, clinics.
- address: street addresses. Split into civic number, street type (rue, avenue, boulevard, chemin, rang, street, road…), particle (de, du, des, de la, de l', d'), street name, unit, city, province. Report the address as one entry covering civic number to street name, plus city if written right after.
- postal_code, email, phone.
- sin (NAS / numéro d'assurance sociale / social insurance number), health_card (RAMQ / carte d'assurance maladie), card_number (credit/debit), bank_account (account, transit, institution numbers, IBAN).
- id_number: policy, contract, claim, file, loan, client, employee, licence, permit, passport, plate, VIN, cadastral lot, matricule, certificate, invoice or reference numbers of the people and businesses in the document, including the document's own file or policy number.
- dob: dates of birth, including the dates in a birth date column of a table (Naissance, DDN, Date of birth, DOB). date: other dates tied to a person (signature, hiring, death). amount: money amounts.
- other: anything else that identifies someone (usernames, URLs with names, signatures described in text).

Rules:
- Go through the whole document: headers, tables, lists, annexes and signature lines too. In a table, report every cell that holds a name, an address, an identifier or a date of birth, row by row.
- "text" must be copied exactly as it appears in the document, character for character, including accents and punctuation. Never normalize or correct it: keep OCR errors and the address punctuation as written.
- Use the same "group" (for example "p1", "a1") for every mention of the same real-world person, address or thing.
- Do not report generic roles ("l'assuré", "the client", "le notaire") without a name, or the names of laws, products, places used as general context (Québec, Montréal as a province or city on its own), or public institutions acting in their public role (Revenu Québec, Hydro-Québec as a utility name).
- When unsure whether something identifies a person, report it.`;

const SUGGEST_SYSTEM = `A document was anonymized by replacing real values with fakes, then an outside AI wrote a new document from it. Some mentions of the fakes in this new document no longer match them exactly: a name misspelled or inflected, an address translated or reformatted, a nickname, a partial name, a reworded organization name.

You get the new document and the list of fakes. Find spans in the document that refer to one of these fake values but are NOT written exactly like it. Skip spans that already match a fake exactly (ignoring case and accents). Skip generic roles ("l'assuré", "the client"). "text" must be copied exactly from the document. List each span once, even when it appears several times: every occurrence is found from it.`;

const DETECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entities'],
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'type', 'group'],
        properties: {
          text: { type: 'string' },
          type: { type: 'string', enum: [...ENTITY_TYPES] },
          group: { type: 'string' },
          first: { type: 'string' },
          middle: { type: 'string' },
          last: { type: 'string' },
          civic: { type: 'string' },
          street_type: { type: 'string' },
          particle: { type: 'string' },
          street_name: { type: 'string' },
          unit: { type: 'string' },
          city: { type: 'string' },
          province: { type: 'string' },
          gender: { type: 'string', enum: ['f', 'm', 'x'] },
          lang: { type: 'string', enum: ['fr', 'en'] },
        },
      },
    },
  },
} as const;

const SUGGEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['spans'],
  properties: {
    spans: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'fake_id'],
        properties: { text: { type: 'string' }, fake_id: { type: 'string' } },
      },
    },
  },
} as const;

interface RawEntity {
  text: string;
  type: EntityType;
  group: string;
  first?: string;
  middle?: string;
  last?: string;
  civic?: string;
  street_type?: string;
  particle?: string;
  street_name?: string;
  unit?: string;
  city?: string;
  province?: string;
  gender?: 'f' | 'm' | 'x';
  lang?: 'fr' | 'en';
}

/** A stretch of the document, by offsets, sent in one call. */
export interface Piece {
  start: number;
  end: number;
}

/** Split on paragraph breaks into pieces the model takes in one call. */
function chunk(text: string, size: number): Piece[] {
  if (text.length <= size) return [{ start: 0, end: text.length }];
  const parts: Piece[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const brk = text.lastIndexOf('\n\n', end);
      if (brk > start + size / 2) end = brk;
    }
    parts.push({ start, end });
    start = end;
  }
  return parts;
}

/**
 * Answer tokens to plan for per character of document. Gemma 4 26B wrote
 * 0.27 per character on the two 11 000-character files (tables, about 100
 * entries) and 1.0 to 1.8 on the dense one-page letters (an entry every 35
 * to 50 characters, about 30 to 60 tokens each). Planning at 1.0 keeps the
 * usual answer far under the limit; a denser part that still doesn't fit is
 * split again when it comes back cut off.
 */
export const ANSWER_TOKENS_PER_CHAR = 1;

/** Pieces shorter than this aren't split further: there is no answer to save by it. */
export const MIN_PIECE_CHARS = 400;

/** Rounds of splitting a cut-off piece in two: down to a sixteenth of a chunk. */
export const MAX_SPLIT_ROUNDS = 4;

/** Halves of a piece, cut at the paragraph, line or word break nearest its middle; null when it is too short. */
export function splitPiece(text: string, p: Piece): [Piece, Piece] | null {
  const len = p.end - p.start;
  if (len < MIN_PIECE_CHARS) return null;
  const mid = p.start + Math.floor(len / 2);
  const lo = p.start + Math.floor(len / 4);
  const hi = p.end - Math.floor(len / 4);
  let at = -1;
  for (const brk of ['\n\n', '\n', ' ']) {
    const before = text.lastIndexOf(brk, mid);
    const after = text.indexOf(brk, mid);
    const options = [before, after].filter((i) => i > lo && i < hi);
    if (options.length) {
      at = options.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0]! + brk.length;
      break;
    }
  }
  if (at < 0) at = mid;
  return [
    { start: p.start, end: at },
    { start: at, end: p.end },
  ];
}

/** Does this piece's call fit the model: prompt plus the planned answer within the window and the answer limit. */
function fits(model: ModelClient, system: string, user: string, chars: number): boolean {
  const answer = Math.ceil(chars * ANSWER_TOKENS_PER_CHAR);
  if (answer > model.maxAnswerTokens) return false;
  return model.contextTokens === undefined || estimateTokens(system) + estimateTokens(user) + answer <= model.contextTokens;
}

/**
 * Entries the model finished before its answer was cut off: every complete
 * object in the answer's first array ({"entities":[{…},{…},{"te…).
 */
export function completeEntries<T>(partial: string): T[] {
  const out: T[] = [];
  let depth = 0;
  let inArray = false;
  let inString = false;
  let escaped = false;
  let from = -1;
  for (let i = 0; i < partial.length; i++) {
    const c = partial[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '[' && depth === 1 && !inArray) {
      inArray = true;
      depth++;
    } else if (c === '{' || c === '[') {
      if (c === '{' && inArray && depth === 2) from = i;
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (c === '}' && inArray && depth === 2 && from >= 0) {
        try {
          out.push(JSON.parse(partial.slice(from, i + 1)) as T);
        } catch {
          // not an entry after all
        }
        from = -1;
      }
      if (inArray && depth < 2) break;
    }
  }
  return out;
}

export interface PieceResult<T> {
  piece: Piece;
  /** Unique per piece, for group keys. */
  id: number;
  data: T;
  usage: ClaudeUsage;
}

/**
 * Sends the text to the model piece by piece, with pieces sized so prompt and
 * answer fit (`fits`), at most `model.maxParallel` calls at once. A piece
 * whose answer comes back cut off is split in two and asked again, in rounds
 * (a bounded loop: no recursion, see CLAUDE.md). A piece that still doesn't
 * fit after MAX_SPLIT_ROUNDS keeps the entries it finished and is reported in
 * `incomplete`, so the caller can warn: nothing is dropped silently.
 */
export async function runPieces<T>(
  model: ModelClient,
  text: string,
  system: string,
  schema: Record<string, unknown>,
  userFor: (piece: Piece, id: number) => string,
  salvage: (partial: string) => T,
  onProgress?: (done: number, total: number) => void,
): Promise<{ results: Array<PieceResult<T>>; incomplete?: string; splits: number }> {
  let nextId = 0;
  // Plan: split until every piece fits. Each split halves a piece, so this ends; the cap is a guard.
  let todo = chunk(text, model.maxChunkChars);
  for (let guard = 0; guard < 64; guard++) {
    let split = false;
    const next: Piece[] = [];
    for (const p of todo) {
      const halves = fits(model, system, userFor(p, 0), p.end - p.start) ? null : splitPiece(text, p);
      if (halves) {
        next.push(...halves);
        split = true;
      } else next.push(p);
    }
    todo = next;
    if (!split) break;
  }
  const results: Array<PieceResult<T>> = [];
  const failures: string[] = [];
  let splits = 0;
  // Tokens of the cut-off calls, counted with the first result.
  let wasted: ClaudeUsage = { input_tokens: 0, output_tokens: 0 };
  let done = 0;
  let total = todo.length;
  onProgress?.(0, total);
  for (let round = 0; todo.length > 0; round++) {
    const again: Piece[] = [];
    await mapLimit(todo, model.maxParallel ?? todo.length, async (piece) => {
      const id = nextId++;
      try {
        const r = await model.structured<T>(system, userFor(piece, id), schema);
        results.push({ piece, id, data: r.data, usage: r.usage });
      } catch (err) {
        if (!(err instanceof CutOffError)) throw err;
        if (err.usage) wasted = addUsage(wasted, err.usage);
        const halves = round < MAX_SPLIT_ROUNDS ? splitPiece(text, piece) : null;
        if (halves) {
          again.push(...halves);
          splits++;
          total += 2;
        } else {
          // Keep what it finished, and say so.
          results.push({ piece, id, data: salvage(err.partial), usage: { input_tokens: 0, output_tokens: 0 } });
          failures.push(err.message);
        }
      }
      onProgress?.(++done, total);
    });
    todo = again;
  }
  results.sort((a, b) => a.piece.start - b.piece.start || a.id - b.id);
  if (results[0]) results[0].usage = addUsage(results[0].usage, wasted);
  return {
    results,
    splits,
    incomplete: failures.length ? `${failures.length} part(s) still cut off after splitting: ${failures[0]}` : undefined,
  };
}

/** fn over items, at most `limit` at a time, results in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

function addUsage(a: ClaudeUsage, b: ClaudeUsage): ClaudeUsage {
  return { input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens };
}

// OCR mixes these up; a model asked for verbatim text sometimes fixes them anyway.
const OCR_LOOKALIKE: Record<string, string> = { l: '1', i: '1', o: '0' };

/** Letters and digits of folded text, OCR look-alikes merged, with each one's index in the folded text. */
function loose(folded: string): { text: string; at: number[] } {
  let text = '';
  const at: number[] = [];
  for (let i = 0; i < folded.length; i++) {
    const c = folded[i]!;
    if (!/[\p{L}\p{N}]/u.test(c)) continue;
    text += OCR_LOOKALIKE[c] ?? c;
    at.push(i);
  }
  return { text, at };
}

/**
 * Locates spans the model reported in one text. It's asked for verbatim text,
 * but it may still straighten an apostrophe, fix an OCR typo ("Apri1") or
 * reformat an address ("Laval (Québec)" → "Laval, Québec"), so fall back to a
 * folded match, then to letters and digits only.
 */
function locator(text: string): (needle: string) => Array<[number, number]> {
  let f: ReturnType<typeof foldWithMap> | undefined;
  let lt: ReturnType<typeof loose> | undefined;
  return (needle) => {
    const out: Array<[number, number]> = [];
    let at = needle ? text.indexOf(needle) : -1;
    while (at >= 0) {
      out.push([at, at + needle.length]);
      at = text.indexOf(needle, at + 1);
    }
    if (out.length > 0) return out;
    f ??= foldWithMap(text);
    const n = fold(needle);
    let fa = n ? f.text.indexOf(n) : -1;
    while (fa >= 0) {
      out.push(unfoldRange(f, fa, fa + n.length));
      fa = f.text.indexOf(n, fa + 1);
    }
    if (out.length > 0) return out;
    const ln = loose(n).text;
    // Short values matched this loosely would land on unrelated text.
    if (ln.length < 6) return out;
    lt ??= loose(f.text);
    let la = lt.text.indexOf(ln);
    while (la >= 0) {
      out.push(unfoldRange(f, lt.at[la]!, lt.at[la + ln.length - 1]! + 1));
      la = lt.text.indexOf(ln, la + 1);
    }
    return out;
  };
}

/** The parts the model gave, without titles it put in them ({ first: "Mme" }); undefined when none are left. */
function personParts(e: RawEntity): Detection['person'] {
  const p = withoutTitles({ first: e.first, middle: e.middle, last: e.last });
  return p.first || p.last ? p : undefined;
}

/**
 * Some models report a name only in pieces ("Jean-François", "Tremblay")
 * even when asked for the full name. When a group has no entry with both
 * parts and the pieces sit next to each other in the text, add that span as
 * the full name, so the person gets one fake instead of two half-names.
 */
export function joinNameParts(text: string, dets: Detection[]): Detection[] {
  const groups = new Map<string, Detection[]>();
  for (const d of dets) if (d.type === 'person' && d.groupKey) groups.set(d.groupKey, [...(groups.get(d.groupKey) ?? []), d]);
  const out = [...dets];
  for (const group of groups.values()) {
    if (group.some((d) => d.person?.first && d.person.last)) continue;
    const firsts = [...new Set(group.flatMap((d) => (d.person?.first && !d.person.last ? [d.person.first] : [])))];
    const lasts = [...new Set(group.flatMap((d) => (d.person?.last && !d.person.first ? [d.person.last] : [])))];
    for (const first of firsts) {
      for (const last of lasts) {
        const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        const m = new RegExp(`${esc(first)}\\s+(?:[\\p{Lu}][\\p{L}.'-]*\\s+)?${esc(last)}`, 'u').exec(text);
        if (m) out.push({ ...group[0]!, text: m[0], person: { first, last } });
      }
    }
  }
  return out;
}

/**
 * Known dates and amounts aren't listed: the rules find them anyway, they
 * aren't replaced by default, and with them listed Gemma 4 26B looped on one
 * date of the mortgage file ("2026-08-27" 478 times, to its limit) in 2 of 2
 * runs of a project seeded like the live one, and 0 of 2 without them.
 */
const UNHINTED = new Set<EntityType>(['date', 'amount']);

/**
 * Known values of the project that appear in this piece, one line per type
 * ("- person: A | B"). Only those in the piece: the others are no help to the
 * model there and only lengthen the prompt (a project's 140 values cost
 * about 1100 tokens listed one per line).
 */
export function hintsFor(piece: string, hints: Entity[]): string {
  hints = hints.filter((h) => !UNHINTED.has(h.type));
  if (hints.length === 0) return '';
  const seen = new Set(findMatches(piece, hints.map((h) => ({ ...h, enabled: true })), 'anonymize').map((m) => m.entityId));
  const byType = new Map<EntityType, string[]>();
  for (const h of hints) {
    if (!seen.has(h.id)) continue;
    const list = byType.get(h.type) ?? [];
    if (!list.includes(h.real.text)) list.push(h.real.text);
    byType.set(h.type, list);
  }
  if (byType.size === 0) return '';
  const lines = [...byType].map(([type, values]) => `- ${type}: ${values.map((v) => v.replace(/\s+/g, ' ')).join(' | ')}`);
  return `\n\nAlready known in this document (report their mentions too):\n${lines.join('\n')}`;
}

export interface DetectResult {
  detections: Detection[];
  usage: ClaudeUsage;
  /** Set when a part's answer was still cut off after splitting: its finished entries are kept, the rest of it may be missed. */
  incomplete?: string;
  /** Cut-off parts that were split and asked again. */
  splits: number;
}

/**
 * Pieces sized for the model (runPieces) run `model.maxParallel` at a time
 * (all at once when unset); onProgress counts finished calls, and the total
 * grows when a cut-off piece is split.
 */
export async function detectEntities(
  model: ModelClient,
  text: string,
  hints: Entity[],
  onProgress?: (done: number, total: number) => void,
): Promise<DetectResult> {
  const run = await runPieces<{ entities: RawEntity[] }>(
    model,
    text,
    DETECT_SYSTEM,
    DETECT_SCHEMA,
    (p, id) => {
      const part = text.slice(p.start, p.end);
      return `<document part="${id + 1}">\n${part}\n</document>${hintsFor(part, hints)}`;
    },
    (partial) => ({ entities: completeEntries<RawEntity>(partial) }),
    onProgress,
  );
  const out: Detection[] = [];
  let usage: ClaudeUsage = { input_tokens: 0, output_tokens: 0 };
  const locate = locator(text);
  for (const r of run.results) {
    usage = addUsage(usage, r.usage);
    for (const e of r.data.entities ?? []) {
      if (!ENTITY_TYPES.includes(e.type) || typeof e.text !== 'string' || !e.text.trim()) continue;
      // Gemma reports "Mme" alone ("(cellulaire, Mme)") in the group of the woman it means: a title is no one's name.
      if (e.type === 'person' && isTitleOnly(e.text)) continue;
      const located = locate(e.text);
      // A value that isn't in the document is a model mistake, not something to replace.
      if (!located[0]) continue;
      const surface = text.slice(located[0][0], located[0][1]);
      out.push({
        text: surface,
        // "born on April 12, 1966" reported as a plain date: dates of birth are replaced by default, other dates aren't.
        type: e.type === 'date' && birthDateContext(text, located[0][0]) ? 'dob' : e.type,
        groupKey: `c${r.id}:${e.group}`,
        person: e.type === 'person' ? personParts(e) : undefined,
        address:
          e.type === 'address'
            ? { civic: e.civic, streetType: e.street_type, particle: e.particle, streetName: e.street_name, unit: e.unit, city: e.city, province: e.province }
            : undefined,
        attrs: e.gender || e.lang ? { gender: e.gender, lang: e.lang } : undefined,
        source: 'claude',
      });
    }
  }
  return { detections: joinNameParts(text, out), usage, incomplete: run.incomplete, splits: run.splits };
}

/**
 * Restore helper. The model only ever sees fakes here: the outside document
 * and the project's fake values. Long documents go in pieces like detection,
 * each with the whole list (a mention can be of any fake).
 */
export async function suggestSpans(
  model: ModelClient,
  text: string,
  entities: Entity[],
): Promise<{ suggestions: Suggestion[]; usage: ClaudeUsage; incomplete?: string }> {
  const enabled = entities.filter((e) => e.enabled);
  if (enabled.length === 0) return { suggestions: [], usage: { input_tokens: 0, output_tokens: 0 } };
  const list = enabled.map((e) => `- id ${e.id} (${e.type}): ${[e.fake.text, ...(e.aliases ?? []).map((a) => a.text)].join(' | ')}`).join('\n');
  type Spans = { spans: Array<{ text: string; fake_id: string }> };
  const run = await runPieces<Spans>(
    model,
    text,
    SUGGEST_SYSTEM,
    SUGGEST_SCHEMA,
    (p) => `<fakes>\n${list}\n</fakes>\n\n<document>\n${text.slice(p.start, p.end)}\n</document>`,
    (partial) => ({ spans: completeEntries<Spans['spans'][number]>(partial) }),
  );
  const ids = new Set(enabled.map((e) => e.id));
  const out: Suggestion[] = [];
  const keys = new Set<string>();
  let usage: ClaudeUsage = { input_tokens: 0, output_tokens: 0 };
  const locate = locator(text);
  for (const r of run.results) {
    usage = addUsage(usage, r.usage);
    for (const s of r.data.spans ?? []) {
      if (!ids.has(s.fake_id) || typeof s.text !== 'string') continue;
      for (const [start, end] of locate(s.text)) {
        const key = `${start}:${end}:${s.fake_id}`;
        if (keys.has(key)) continue;
        keys.add(key);
        out.push({ start, end, entityId: s.fake_id });
      }
    }
  }
  return { suggestions: out, usage, incomplete: run.incomplete };
}
