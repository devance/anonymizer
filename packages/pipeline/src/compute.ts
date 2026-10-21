import {
  amountShaped,
  applyMatches,
  aad,
  birthDateColumn,
  birthDateContext,
  detectRegex,
  findMatches,
  fakeWords,
  fold,
  fuzzyLeaks,
  idLabelBefore,
  importDataKey,
  parseDateLoose,
  isLocality,
  isProvince,
  isPublicOrg,
  lookupFirst,
  matchOptions,
  mentionsOf,
  partOfAmount,
  parsePersonName,
  mergeDetections,
  numericDate,
  openJson,
  rankProjects,
  replacementFor,
  unb64,
  type AnalyzeResult,
  type ClaudeUsage,
  type DetectorSpec,
  type Direction,
  type Detection,
  type Entity,
  type EntityAttrs,
  type EntityRow,
  type EntityType,
  type EntityValue,
  type Leak,
  type Match,
  type PrepareMeta,
  type ReviewMatch,
  type SealedReal,
  type Steps,
  type Suggestion,
} from '@anon/core';
import { detectEntities, suggestSpans } from './detect';
import * as eng from './engine';
import { DetectorOfflineError, type ModelClient } from './model';

export interface Deps {
  engine: eng.Engine;
  /** The engine's small detection model; left out where there's no engine (benchmarks of the big models). */
  ner?: (text: string) => Promise<eng.NerSpan[]>;
  /** The model for a request's detector setting; null when that engine isn't set up here. */
  model: (detector: DetectorSpec | undefined) => ModelClient | null;
}

export type LoadedEntity = Entity & { frozen: boolean };

/** Types whose value is a number; postal codes and Quebec health cards carry digits too. */
const NUMBERED: ReadonlySet<EntityType> = new Set(['sin', 'health_card', 'card_number', 'bank_account', 'id_number', 'postal_code']);

export async function keyOf(b64key: string): Promise<CryptoKey> {
  return importDataKey(unb64(b64key));
}

/** Decrypt entity rows; each row's real value is sealed with its own project's key. */
export async function loadEntities(rows: EntityRow[], keys: Record<string, CryptoKey>): Promise<LoadedEntity[]> {
  return Promise.all(
    rows.map(async (r) => {
      const key = keys[r.project_id];
      if (!key) throw new Error(`no key for project ${r.project_id}`);
      const sealed = await openJson<SealedReal>(key, r.real_enc, aad.entityReal(r.id));
      return {
        id: r.id,
        type: r.type,
        real: sealed.real,
        surfaces: sealed.surfaces,
        mentions: sealed.mentions,
        fake: JSON.parse(r.fake) as EntityValue,
        aliases: JSON.parse(r.aliases) as EntityValue[],
        attrs: JSON.parse(r.attrs) as EntityAttrs,
        enabled: r.enabled === 1,
        projectId: r.project_id,
        frozen: r.frozen_at !== null,
      };
    }),
  );
}

// ---- analyze ----

/**
 * The detection model's spans as detections. It calls many dates "date of
 * birth"; one only counts as one where the text says so ("né le", a
 * "Naissance" column), otherwise it's a plain date, off by default.
 */
const FEMALE_TITLE = /(?:\bmme|\bmadame|\bmlle|\bmrs|\bms|\bmiss)\.?\s*$/i;
const MALE_TITLE = /(?:\bm\.|\bmonsieur|\bmr\.?)\s*$/i;

export function nerDetections(text: string, spans: eng.NerSpan[]): Detection[] {
  const out: Detection[] = [];
  for (const s of spans) {
    let type = s.type;
    const value = text.slice(s.start, s.end);
    if (!value.trim()) continue;
    if (type === 'dob') {
      if (!parseDateLoose(value)) continue;
      if (!birthDateContext(text, s.start) && !birthDateColumn(text, s.start)) type = 'date';
    }
    // A social insurance number has nine digits; a longer reference the model called one is still a reference.
    if (type === 'sin' && value.replace(/\D/g, '').length !== 9) type = 'id_number';
    // "Info OACIQ" read as a person: a public body's name isn't anyone's, and its pieces would be swapped everywhere.
    if (type === 'person' && isPublicOrg(value)) continue;
    // The title in front gives the gender the fake should keep ("Mme Martin" stays a woman).
    const before = type === 'person' ? text.slice(Math.max(0, s.start - 12), s.start) : '';
    const gender = FEMALE_TITLE.test(before) ? 'f' : MALE_TITLE.test(before) ? 'm' : undefined;
    out.push({ type, start: s.start, end: s.end, text: value, source: 'ner', attrs: gender ? { gender } : undefined });
    // "Jacques" over "Poulin": the whole name, so each half is replaced wherever it stands.
    if (type === 'person' && s.last) {
      const first = value.trim();
      const last = text.slice(s.last[0], s.last[1]).trim();
      if (last) out.push({ type, text: `${first} ${last}`, person: { first, last }, source: 'ner' });
    }
  }
  return groupPeople(text, out);
}

const INITIAL = /^(\p{L}\.-?)+$/u;
const FIRST_LABEL = /(?:pr[ée]nom|first name|given name)s?\s*[:\-]?\s*$/i;
const LAST_LABEL = /(?:nom de famille|nom|last name|surname|family name)\s*[:\-]?\s*$/i;

/** The form label right before a span, across a line break: "Prénom\n\nLaurent". */
function labelBefore(text: string, at: number): string {
  return text.slice(Math.max(0, at - 40), at).replace(/\s*\n\s*/g, ' ');
}

/**
 * The model finds "Jean-François Tremblay", "M. Tremblay" and "J.-F. Tremblay"
 * separately; a big model would say they're one person. A mention with only
 * a surname, or initials and a surname, joins the full name it matches, so
 * the whole document gets one fake. Two full names sharing the surname
 * (Karim and Nadia Haddad): the titles' gender decides (or the first name's,
 * when the fakes' list knows it), else the nearest one before the mention.
 */
function groupPeople(text: string, dets: Detection[]): Detection[] {
  const people = dets.filter((d) => d.type === 'person');
  const parts = new Map(people.map((d) => [d, parsePersonName(d.text)] as const));
  const full = people.filter((d) => {
    const p = parts.get(d)!;
    return p.first && p.last && !INITIAL.test(p.first);
  });
  full.forEach((d, i) => (d.groupKey = `ner-p${i}`));
  // A form gives the name in two fields, "Nom de famille : Boisvenu" then "Prénom : Laurent": one person.
  const extra: Detection[] = [];
  const lone = people.filter((d) => !d.groupKey && !/\s/.test(d.text.trim()));
  for (const first of lone.filter((d) => FIRST_LABEL.test(labelBefore(text, d.start!)))) {
    const last = lone
      .filter((d) => d !== first && !d.groupKey && LAST_LABEL.test(labelBefore(text, d.start!)) && !FIRST_LABEL.test(labelBefore(text, d.start!)))
      .sort((a, b) => Math.abs(a.start! - first.start!) - Math.abs(b.start! - first.start!))[0];
    if (!last || Math.abs(last.start! - first.start!) > 300) continue;
    const key = `ner-form${extra.length}`;
    first.groupKey = last.groupKey = key;
    first.person = { first: first.text.trim() };
    last.person = { last: last.text.trim() };
    extra.push({ type: 'person', text: `${first.text.trim()} ${last.text.trim()}`, person: { first: first.text.trim(), last: last.text.trim() }, groupKey: key, source: 'ner' });
    full.push(extra[extra.length - 1]!);
    parts.set(extra[extra.length - 1]!, { first: first.text.trim(), last: last.text.trim() });
  }
  for (const d of people) {
    if (d.groupKey) continue;
    const p = parts.get(d)!;
    // A first name alone ("Laurent") joins the one full name that starts with it.
    if (!/\s/.test(d.text.trim()) && !INITIAL.test(d.text.trim())) {
      const byFirst = full.filter((f) => parts.get(f)!.first && fold(parts.get(f)!.first!) === fold(d.text.trim()));
      if (byFirst.length === 1) {
        d.groupKey = byFirst[0]!.groupKey;
        d.person = { first: d.text.trim() };
        continue;
      }
    }
    if (!p.last) continue;
    const initials = p.first && INITIAL.test(p.first) ? fold(p.first).replace(/[^a-z]/g, '') : '';
    const matches = full.filter((f) => {
      const q = parts.get(f)!;
      if (fold(q.last!) !== fold(p.last!)) return false;
      // "J.-F." has to fit "Jean-François".
      return !initials || fold(q.first!).split(/[^a-z]+/).filter(Boolean).map((w) => w[0]).join('') === initials;
    });
    const genderOf = (f: Detection) => f.attrs?.gender ?? lookupFirst(parts.get(f)!.first)?.gender;
    const fit = matches.filter((f) => !d.attrs?.gender || !genderOf(f) || genderOf(f) === d.attrs.gender);
    const pool = fit.length ? fit : matches;
    const before = pool.filter((f) => f.start! < d.start!);
    const pick = pool.length === 1 ? pool[0] : before[before.length - 1] ?? pool[0];
    if (pick) d.groupKey = pick.groupKey;
  }
  return [...dets, ...extra];
}

/**
 * Regex, known values and the model. A local model that's offline throws
 * DetectorOfflineError (the document waits); any other model failure keeps
 * the regex results and reports the error so the user can retry.
 */
export async function analyze(
  deps: Deps,
  text: string,
  existing: Entity[],
  useModel: boolean,
  detector?: DetectorSpec,
  onProgress?: (done: number, total: number) => void,
): Promise<AnalyzeResult> {
  // The small model first: about 0.1 s per 1,000 characters, and enough on its own with the rules.
  let found: Detection[] = [];
  let nerError: string | undefined;
  if (deps.ner) {
    try {
      found = nerDetections(text, await deps.ner(text));
    } catch (err) {
      nerError = err instanceof Error ? err.message : String(err);
    }
  }
  // Values already known in this project that appear here go to the model as hints (they're in the text anyway).
  const seen = new Set(findMatches(text, existing.map((e) => ({ ...e, enabled: true })), 'anonymize').map((m) => m.entityId));
  const hints = existing.filter((e) => seen.has(e.id));
  const model = deps.model(detector);
  let modelDetections: Awaited<ReturnType<typeof detectEntities>>['detections'] = [];
  let claudeError: string | undefined;
  let usage: ClaudeUsage | undefined;
  let modelSplits: number | undefined;
  if (!model) claudeError = deps.ner ? undefined : 'no detection model is configured';
  else if (useModel) {
    try {
      const r = await detectEntities(model, text, hints, onProgress);
      modelDetections = r.detections;
      if (r.splits) modelSplits = r.splits;
      // Still cut off after splitting: its finished entries are kept, but the user is told.
      if (r.incomplete) {
        claudeError = r.incomplete;
        console.error(`detection incomplete (${model.name}): ${r.incomplete}`);
      }
      // Local tokens are free; only Claude counts toward the monthly cap.
      if (!model.local) usage = r.usage;
    } catch (err) {
      if (err instanceof DetectorOfflineError) throw err;
      claudeError = err instanceof Error ? err.message : String(err);
      console.error(`detection failed (${model.name}): ${claudeError}`);
    }
  }
  // Models also report lone city names as addresses; full addresses keep their city, so these do too.
  // A province alone ("QC") is never someone's, whatever type the model gave it.
  modelDetections = modelDetections.filter((d) => (d.type !== 'address' || !isLocality(d.text)) && !isProvince(d.text));
  // A label typed as a number ("RAMQ", "NAS") would turn every mention of that word into gibberish.
  modelDetections = modelDetections.filter((d) => !NUMBERED.has(d.type) || /\d/.test(d.text));
  // Amounts, rates and dates stay exact for the AI: digits against decimals, a "$" or a "%" are never an
  // identifier ("7,3318 12,750" in a rate table), nor is "2018-05" unless a label says so ("dossier 2021-06").
  const numbersOk = (d: Detection) => {
    // Letters make it a code, never an amount: "G0A 2S4 $" is an OCR'd line, not a price.
    if ((!NUMBERED.has(d.type) && d.type !== 'phone') || /\p{L}/u.test(d.text)) return true;
    if (amountShaped(d.text) || (d.start !== undefined && partOfAmount(text, d.start, d.end!))) return false;
    return !numericDate(d.text) || (d.start !== undefined && idLabelBefore(text, d.start));
  };
  const candidates = mergeDetections(
    [...detectRegex(text), ...found, ...modelDetections].filter(numbersOk),
    existing.map((e) => ({ type: e.type, real: e.real })),
  );
  return { candidates, nerError, claudeError, usage, ...(modelSplits ? { modelSplits } : {}) };
}

// ---- review ----

/**
 * Matches for the review screen. Recomputed from the text and the project's
 * entities every time, so an edited fake or a newly added value shows up
 * immediately; only the reviewer's overrides are stored.
 */
export function computeMatches(
  text: string,
  entities: Entity[],
  restore: boolean,
  projectId: string,
  overrides: Record<string, boolean>,
  suggestions: Suggestion[] = [],
): ReviewMatch[] {
  const found = findMatches(text, entities, restore ? 'restore' : 'anonymize', matchOptions(restore, projectId));
  const matches: ReviewMatch[] = found.map((m) => {
    const key = `${m.start}:${m.end}`;
    // Anonymizing, every hit is on by default: a missed real value is worse than an extra swap.
    const def = restore ? m.confidence === 'high' : true;
    return { ...m, key, checked: overrides[key] ?? def };
  });
  if (restore) {
    for (const s of suggestions) {
      if (matches.some((m) => s.start < m.end && s.end > m.start)) continue;
      const e = entities.find((x) => x.id === s.entityId);
      if (!e) continue;
      const surface = text.slice(s.start, s.end);
      const key = `${s.start}:${s.end}`;
      matches.push({
        start: s.start,
        end: s.end,
        surface,
        replacement: replacementFor(e, surface, 'restore'),
        entityId: e.id,
        type: e.type,
        kind: 'suggested',
        confidence: 'low',
        key,
        checked: overrides[key] ?? false,
        suggested: true,
      });
    }
    matches.sort((a, b) => a.start - b.start);
  }
  return matches;
}

// ---- files ----

export interface Prepared extends PrepareMeta {
  text: string;
  fields: eng.Field[];
  work?: Uint8Array<ArrayBuffer>;
}

/**
 * A PDF, Word file or photo → text the matcher can work on. Photos become
 * PDFs, scans get a text layer, password-protected PDFs get a decrypted
 * working copy; the original upload is kept untouched either way.
 */
export async function prepare(engine: eng.Engine, bytes: Uint8Array<ArrayBuffer>, mime: string, password?: string): Promise<Prepared> {
  let work: Uint8Array<ArrayBuffer> | undefined;
  let workMime: string | undefined;
  let ocr: Prepared['ocr'] = 'none';
  let pages: number | null = null;
  if (eng.IMAGE_MIMES.has(mime)) {
    work = await engine.ocr(bytes, mime, false, undefined, 1);
    workMime = eng.PDF;
    ocr = 'image';
    pages = 1;
  } else if (mime === eng.PDF) {
    const info = await engine.inspect(bytes, mime, password);
    pages = info.pages;
    ocr = info.ocr;
    // /ocr also hands back a decrypted copy when given a password.
    if (info.ocr !== 'none' || password) {
      work = await engine.ocr(bytes, mime, info.ocr === 'garbled', password, info.pages ?? undefined);
      workMime = eng.PDF;
    }
  }
  const ex = await engine.extract(work ?? bytes, workMime ?? mime);
  return { text: ex.text, sha256: ex.sha256, fields: ex.fields, work, workMime, hasWork: !!work, ocr, pages };
}

/**
 * Real values the matcher finds in an output. Its OCR allowance ("fuzzy": a
 * name an edit away) doesn't count a word that is exactly a fake of the
 * project (fakeWords): "Denise", one tenant's fake, isn't "Denis", the seller.
 */
export function realMentions(text: string, entities: Entity[]): Match[] {
  const fakes = fakeWords(entities);
  return findMatches(text, entities.filter((e) => e.enabled), 'anonymize').filter((m) => !(m.kind === 'fuzzy' && fakes.has(fold(m.surface))));
}

/**
 * Search everything readable in an output (text layer, out-of-flow fields,
 * metadata, barcode contents, and the OCR of the rendered pages) for the
 * project's real values.
 */
export function findLeaks(result: eng.CheckResult, entities: Entity[]): { leaks: Leak[]; codePages: number[] } {
  const enabled = entities.filter((e) => e.enabled);
  const counts = new Map<string, Leak>();
  const add = (e: { id: string; type: string }, where: string) => {
    const prev = counts.get(e.id);
    if (prev) prev.hits++;
    else counts.set(e.id, { entityId: e.id, type: e.type, hits: 1, where });
  };
  const exact = (text: string, where: string) => {
    for (const m of realMentions(text, entities)) add({ id: m.entityId, type: m.type }, where);
  };
  exact(result.text, 'text');
  for (const f of result.fields) exact(f.text, 'links/fields');
  for (const v of Object.values(result.metadata ?? {})) exact(v, 'metadata');
  for (const codes of Object.values(result.codes)) for (const c of codes) exact(c, 'barcode');
  for (const page of result.raster) {
    for (const id of fuzzyLeaks(page, enabled)) {
      const e = enabled.find((x) => x.id === id)!;
      if (!counts.has(id)) add(e, 'page image');
    }
  }
  return { leaks: [...counts.values()], codePages: Object.keys(result.codes).map(Number) };
}

/** Words of the expected output missing from the actual one: a redaction that took a neighbour with it. */
export function layoutDrift(expected: string, actual: string): number {
  const words = (s: string) => fold(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  const have = new Map<string, number>();
  for (const w of words(actual)) have.set(w, (have.get(w) ?? 0) + 1);
  let missing = 0;
  for (const w of words(expected)) {
    const n = have.get(w) ?? 0;
    if (n > 0) have.set(w, n - 1);
    else missing++;
  }
  return missing;
}

/** A filename's stem with _ - . read as spaces: same length, so offsets found in it apply to the original. */
function filenameWords(name: string): { stem: string; ext: string; spaced: string; joiner: string } {
  const ext = /\.[a-z0-9]{1,5}$/i.exec(name)?.[0] ?? '';
  const stem = name.slice(0, name.length - ext.length);
  // Underscores and dots separate words; a hyphen may be inside a name (Jean-François), so it comes last.
  const joiner = stem.includes(' ') ? ' ' : (['_', '.', '-', '‐', '‑'].find((c) => stem.includes(c)) ?? ' ');
  return { stem, ext, spaced: stem.replace(/[_.\-‐‑]/g, ' '), joiner };
}

/**
 * Filenames carry names too, joined by anything: "Tremblay_assurance.pdf",
 * "Demande-financement-Tremblay.pdf", "JF.Tremblay.2024.pdf". In running text
 * a name glued to a hyphen isn't matched ("Saint-Jean" is not Jean), so here
 * the separators read as spaces; replacements keep the name's own separator.
 */
export function swapFilename(name: string, entities: Entity[], dir: Direction): string {
  const { stem, ext, spaced, joiner } = filenameWords(name);
  const matches = findMatches(spaced, entities, dir, { anyCase: true });
  return applyMatches(stem, joiner === ' ' ? matches : matches.map((m) => ({ ...m, replacement: m.replacement.replace(/ /g, joiner) }))) + ext;
}

/** Real values still in an output's filename. */
export function filenameLeaks(name: string, entities: Entity[]): Leak[] {
  const counts = new Map<string, Leak>();
  for (const m of findMatches(filenameWords(name).spaced, entities.filter((e) => e.enabled), 'anonymize', { anyCase: true })) {
    const prev = counts.get(m.entityId);
    if (prev) prev.hits++;
    else counts.set(m.entityId, { entityId: m.entityId, type: m.type, hits: 1, where: 'filename' });
  }
  return [...counts.values()];
}

// ---- render ----

export interface Rendered {
  file: Uint8Array<ArrayBuffer>;
  outText: string;
  outMime: string;
  outName: string;
  verify: NonNullable<Steps['verify']>;
  entityHits: Record<string, number>;
  /** Anonymizing: what the output wrote per entity, fake surface → the real surfaces it replaced (see MentionLog). */
  mentions: Record<string, Record<string, string[]>>;
}

export async function render(
  deps: Deps,
  args: {
    text: string;
    entities: LoadedEntity[];
    restore: boolean;
    projectId: string;
    overrides: Record<string, boolean>;
    steps: Steps;
    mime: string;
    filename: string;
    /** The working copy for files (or the original when there's none). */
    file?: Uint8Array<ArrayBuffer>;
    workMime?: string;
    fields?: eng.Field[];
  },
): Promise<Rendered> {
  const { text, entities, restore } = args;
  const dir: Direction = restore ? 'restore' : 'anonymize';
  const opts = matchOptions(restore, args.projectId);
  const checked = computeMatches(text, entities, restore, args.projectId, args.overrides, args.steps.suggest?.items).filter((m) => m.checked);
  const outText = applyMatches(text, checked);
  const entityHits: Record<string, number> = {};
  for (const m of checked) entityHits[m.entityId] = (entityHits[m.entityId] ?? 0) + 1;

  let file: Uint8Array<ArrayBuffer>;
  let outMime = args.mime;
  let verify: NonNullable<Steps['verify']> = { leaks: [] };
  if (!eng.isEngineMime(args.mime)) {
    file = new TextEncoder().encode(outText) as Uint8Array<ArrayBuffer>;
    if (!restore) {
      // Anything real still in the output: values the reviewer unchecked, or new ones.
      const counts = new Map<string, Leak>();
      for (const l of realMentions(outText, entities)) {
        const prev = counts.get(l.entityId);
        if (prev) prev.hits++;
        else counts.set(l.entityId, { entityId: l.entityId, type: l.type, hits: 1 });
      }
      verify = { leaks: [...counts.values()] };
    }
  } else {
    if (!args.file || !args.steps.extract) throw new Error('document was never extracted');
    const workMime = args.workMime ?? args.mime;
    const fields = (args.fields ?? []).flatMap((f) => {
      const m = findMatches(f.text, entities, dir, opts);
      return m.length > 0 ? [{ id: f.id, text: applyMatches(f.text, m) }] : [];
    });
    const out = await deps.engine.rewrite(args.file, workMime, {
      sha256: args.steps.extract.sha256,
      replacements: checked.map((m) => ({ start: m.start, end: m.end, text: m.replacement })),
      fields,
    });
    file = out.file;
    outMime = workMime;
    verify = { leaks: [], report: out.report };
    if (!restore) {
      const result = await deps.engine.check(out.file, workMime);
      const { leaks, codePages } = findLeaks(result, entities);
      verify = { leaks, report: out.report, codePages, missingWords: layoutDrift(outText, result.text) };
    }
  }

  let outName = swapFilename(args.filename, entities, dir);
  // Photos come back as PDFs.
  if (outMime !== args.mime) outName = outName.replace(/\.[^.]+$/, '') + '.pdf';
  // The name leaves with the file: anything real left in it is a leak like any other.
  if (!restore) verify = { ...verify, leaks: [...verify.leaks, ...filenameLeaks(outName, entities)] };
  const mentions = restore ? {} : Object.fromEntries(mentionsOf(checked));
  return { file, outText, outMime, outName, verify, entityHits, mentions };
}

// ---- route (restore) ----

export class NoKnownFakesError extends Error {}

export async function route(
  deps: Deps,
  args: { text: string; entities: LoadedEntity[]; projectId?: string; suggest: boolean; detector?: DetectorSpec },
): Promise<{ projectId: string; ranking: Array<{ projectId: string; hits: number }>; steps: Steps; usage?: ClaudeUsage }> {
  const ranking = rankProjects(findMatches(args.text, args.entities, 'restore'));
  const projectId = args.projectId ?? ranking[0]?.projectId;
  if (!projectId) throw new NoKnownFakesError('None of your projects’ fake values appear in this text');
  const steps: Steps = { route: { ranking } };
  let usage: ClaudeUsage | undefined;
  if (args.suggest) {
    const projectEntities = args.entities.filter((e) => e.projectId === projectId);
    const model = deps.model(args.detector);
    if (!model) steps.suggest = { items: [], error: 'no detection model is configured' };
    else {
      try {
        const exact = findMatches(args.text, projectEntities, 'restore', { preferProject: projectId });
        const r = await suggestSpans(model, args.text, projectEntities);
        if (!model.local) usage = r.usage;
        steps.suggest = { items: r.suggestions.filter((s) => !exact.some((m) => s.start < m.end && s.end > m.start)), ...(r.incomplete ? { error: r.incomplete } : {}) };
      } catch (err) {
        // Suggestions are optional: an offline PC just means none this time.
        steps.suggest = { items: [], error: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  return { projectId, ranking, steps, usage };
}
