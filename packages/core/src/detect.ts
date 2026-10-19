import { findAmounts } from './amounts';
import { findDates, ocrDateFix } from './dates';
import type { Detection } from './types';

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return digits.length > 0 && sum % 10 === 0;
}

export function luhnCheckDigit(partial: string): string {
  for (let d = 0; d <= 9; d++) {
    if (luhnValid(partial + d)) return String(d);
  }
  return '0';
}

function before(text: string, at: number, width = 48): string {
  return text.slice(Math.max(0, at - width), at).toLowerCase();
}

const SIN_CONTEXT = /\b(nas|sin|n\.a\.s|assurance sociale|social insurance)\b/;
// \b before "né": "signé le 3 mai" is a signature date.
const DOB_CONTEXT = /(naissance|\bn[ée]e? le|\bn[ée]e? en|date of birth|\bdob\b|born|birth ?date|d\.d\.n|\bddn\b)/;

/**
 * "1180, rang Saint-Félix", "45 rue Notre-Dame Est": a civic number, a French
 * street type, then the official (hyphenated) name. Small models miss rural
 * ones in the detection benchmark; city and postal code are left to the model.
 */
const FR_STREET = new RegExp(
  String.raw`(?<![\p{L}\d.,-])\d{1,5}[A-Za-z]?(?:-\d{1,5})?,?[ \t]+` +
    String.raw`(?:rue|avenue|av\.|boulevard|boul\.|chemin|ch\.|route|rte|rang|mont[ée]e|c[ôo]te|croissant|terrasse|impasse|all[ée]e|promenade|place|carr[ée]|concession)` +
    String.raw`[ \t]+(?:(?:de la|des|du|de)[ \t]+|(?:de l|d|l)['’])?\p{Lu}[\p{L}\d'’.-]*(?<![.-])` +
    String.raw`(?:[ \t]+(?:Est|Ouest|Nord|Sud))?(?![\p{L}\d])`,
  'gu',
);

/** FR_STREET in capitals, as cheques and forms print it: "218 RANG SAINT-JOSEPH". */
const FR_STREET_CAPS = new RegExp(
  String.raw`(?<![\p{L}\d.,-])\d{1,5}[A-Z]?(?:-\d{1,5})?,?[ \t]+` +
    String.raw`(?:RUE|AVENUE|AV\.|BOULEVARD|BOUL\.|CHEMIN|CH\.|ROUTE|RTE|RANG|MONT[ÉE]E|C[ÔO]TE|CROISSANT|TERRASSE|IMPASSE|ALL[ÉE]E|PROMENADE|PLACE|CARR[ÉE]|CONCESSION)` +
    String.raw`[ \t]+(?:(?:DE LA|DES|DU|DE)[ \t]+|(?:DE L|D|L)['’])?\p{Lu}[\p{Lu}\d'’.-]*(?<![.-])` +
    String.raw`(?:[ \t]+(?:EST|OUEST|NORD|SUD))?(?![\p{L}\d])`,
  'gu',
);

const EN_SUFFIX = 'Street|St\\.|Avenue|Ave\\.?|Road|Rd\\.?|Boulevard|Blvd\\.?|Drive|Dr\\.|Crescent|Cres\\.?|Court|Ct\\.?|Lane|Ln\\.?|Way|Parkway|Pkwy\\.?|Place|Pl\\.|Terrace|Circle|Highway|Hwy\\.?|Trail|Line|Sideroad|Square|Gate|Grove|Heights|Row|Close|Path';
const EN_DIR = (words: string) => `(?:[ \\t]+(?:${words})\\.?)?`;

/**
 * "2217 Maple Grove Avenue", "4388 Sherbrooke Street West", "1186
 * Concession Road 7": a civic number, one to four capitalised words and a
 * street suffix. City and postal code are left to the other rules.
 */
const EN_STREET = new RegExp(
  String.raw`(?<![\p{L}\d.,-])\d{1,6}[A-Za-z]?(?:-\d{1,5})?,?[ \t]+(?:\p{Lu}[\p{L}'’.-]*[ \t]+){1,4}(?:${EN_SUFFIX})(?![\p{L}])${EN_DIR('North|South|East|West|N|S|E|W')}(?:[ \t]+\d{1,2}(?![\p{L}\d.,]))?`,
  'gu',
);
const EN_STREET_CAPS = new RegExp(
  String.raw`(?<![\p{L}\d.,-])\d{1,6}[A-Z]?(?:-\d{1,5})?,?[ \t]+(?:\p{Lu}[\p{Lu}'’.-]*[ \t]+){1,4}(?:${EN_SUFFIX.toUpperCase()})(?![\p{L}])${EN_DIR('NORTH|SOUTH|EAST|WEST|N|S|E|W')}(?:[ \t]+\d{1,2}(?![\p{L}\d.,]))?`,
  'gu',
);

/** A date at `at` reads as a date of birth ("né le", "born on", "DOB:"), in the same sentence. */
export function birthDateContext(text: string, at: number): boolean {
  const window = before(text, at, 40);
  const ends = [...window.matchAll(/[.;!?]\s+(?=\S)/g)].filter((m) => /\p{Lu}/u.test(text[at - window.length + m.index! + m[0].length] ?? ''));
  const last = ends[ends.length - 1];
  return DOB_CONTEXT.test(last ? window.slice(last.index! + last[0].length) : window);
}

/**
 * Structured identifiers a regex can catch reliably. Claude covers names,
 * addresses and anything contextual; these run locally so the obvious cases
 * never depend on the model.
 */
export function detectRegex(text: string): Detection[] {
  const out: Detection[] = [];
  const add = (type: Detection['type'], start: number, end: number) =>
    out.push({ type, start, end, text: text.slice(start, end), source: 'regex' });

  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
    add('email', m.index!, m.index! + m[0].length);
  }

  for (const m of text.matchAll(/(?<![\d\w])(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?[2-9]\d{2}[\s.-]?\d{4}(?![\d])/g)) {
    add('phone', m.index!, m.index! + m[0].length);
  }

  for (const m of text.matchAll(/(?<![\p{L}\d])[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d(?![\p{L}\d])/giu)) {
    add('postal_code', m.index!, m.index! + m[0].length);
  }

  for (const m of text.matchAll(/(?<![\d])(\d{3})([ -]?)(\d{3})\2(\d{3})(?![\d])/g)) {
    const digits = m[1]! + m[3]! + m[4]!;
    const formatted = m[2] !== '';
    // Labelled "NAS" / "SIN": replaced even when the check digit is off (a typo or an OCR misread).
    if (SIN_CONTEXT.test(before(text, m.index!)) || (luhnValid(digits) && formatted)) {
      add('sin', m.index!, m.index! + m[0].length);
    }
  }

  for (const m of text.matchAll(/(?<![\d])[3-6](?:[ -]?\d){12,18}(?![\d])/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      add('card_number', m.index!, m.index! + m[0].length);
    }
  }

  for (const m of text.matchAll(/(?<![\p{L}\d])[A-Z]{4} ?\d{4} ?\d{4}(?![\p{L}\d])/gu)) {
    add('health_card', m.index!, m.index! + m[0].length);
  }

  for (const m of text.matchAll(/(?<![\p{L}\d])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?(?![\p{L}\d])/gu)) {
    add('bank_account', m.index!, m.index! + m[0].length);
  }

  // OCR look-alikes are swapped one character for one, so offsets still point into `text`.
  const dates = [...findDates(text), ...findDates(ocrDateFix(text))];
  for (const d of dates) {
    if (birthDateContext(text, d.start) || birthDateColumn(text, d.start)) add('dob', d.start, d.end);
  }

  for (const re of [FR_STREET, FR_STREET_CAPS, EN_STREET, EN_STREET_CAPS]) {
    for (const m of text.matchAll(re)) add('address', m.index!, m.index! + m[0].length);
  }

  const found = dedupeOverlaps(out);
  return dedupeOverlaps([...found, ...detectIdentifiers(text, [...found, ...dates, ...findAmounts(text)])]);
}

/** Splits a table row into cells: runs of 2+ spaces, tabs or pipes. */
function cells(line: string): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  for (const m of line.matchAll(/[^\t|]+?(?=\s{2,}|\t|\||$)/g)) {
    const text = m[0].trim();
    if (text) out.push({ start: m.index! + m[0].indexOf(text), end: m.index! + m[0].indexOf(text) + text.length, text });
  }
  return out;
}

/**
 * A date in a table column headed "Naissance", "Date of birth", "DDN"…: the
 * header is a line above it in the same block, and the date sits under it.
 */
export function birthDateColumn(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const row = cells(text.slice(lineStart, (text.indexOf('\n', at) + 1 || text.length + 1) - 1));
  const col = at - lineStart;
  const idx = row.findIndex((c) => col >= c.start && col < c.end);
  if (row.length < 3 || idx < 0) return false;
  let end = lineStart - 1;
  for (let n = 0; n < 40 && end > 0; n++) {
    const start = text.lastIndexOf('\n', end - 1) + 1;
    const line = text.slice(start, end);
    if (!line.trim()) return false;
    const head = cells(line);
    if (head.length >= 3) {
      const byIndex = head.length === row.length ? head[idx] : undefined;
      const byPlace = head.find((h) => h.start <= col + 6 && h.end >= col - 2);
      for (const h of [byIndex, byPlace]) if (h && DOB_CONTEXT.test(h.text.toLowerCase())) return true;
    }
    end = start - 1;
  }
  return false;
}

/** Words that announce a reference number: "Police no", "Account number:", "matricule". */
const ID_LABEL =
  /(?:\bn[oº°]\.?|\bnum[ée]ro|\bnumber|#|\bpolice|\bpolicy|\bcontrat|\bcontract|\bdossier|\bfile|\bclient|\bcompte|\baccount|\bfolio|\bmatricule|\bemploy[ée]e?|\bpermis|\blicen[cs]e|\bcertificat|\bcertificate|\br[ée]clamation|\bclaim|\br[ée]f[ée]rence|\bref\.?|\bpr[êe]t|\bloan|\bmembre|\bmember|\blot|\bcadastre|\bplaque|\bplate|\bimmatriculation|\bpasseport|\bpassport|\bvin|\bs[ée]rie|\bserial)\s*:?\s*$/i;

/**
 * Reference numbers: policy, account, licence, VIN, file numbers… Anything
 * shaped like one (letters with 4+ digits, hyphenated digit groups, 6+
 * digits in a row, or a number right after a label like "matricule"),
 * except dates, amounts and what the other rules already took.
 */
function detectIdentifiers(text: string, taken: Array<{ start?: number; end?: number }>): Detection[] {
  const out: Detection[] = [];
  const free = (s: number, e: number) => !taken.some((t) => s < t.end! && e > t.start!) && !out.some((t) => s < t.end! && e > t.start!);
  const digits = (s: string) => s.replace(/\D/g, '').length;
  const add = (s: number, e: number) => {
    if (free(s, e)) out.push({ type: 'id_number', start: s, end: e, text: text.slice(s, e), source: 'regex' });
  };
  // HAB-48210937, CA-FL-2026-550914, 1FUJHHDR8NLNA2849, G3205-041186-04, 7731-0094-26, 0418827
  for (const m of text.matchAll(/(?<![\p{L}\d.,/-])[A-Z0-9]+(?:[-/][A-Z0-9]+)*(?![\p{L}\d]|[.,/-][\p{L}\d])/gu)) {
    const t = m[0];
    const d = digits(t);
    const letters = /[A-Z]/.test(t);
    const shaped = letters ? d >= 4 && t.length >= 6 : /[-/]/.test(t) ? d >= 6 : d >= 6;
    // "14h30", "2x4", "COVID-19": short and common, not references.
    if (shaped && !/^\d{1,2}[hH]\d{2}$/.test(t)) add(m.index!, m.index! + t.length);
  }
  // AY 74215 (plate), and "lot 5 912 448" (cadastre, written like a number)
  for (const m of text.matchAll(/(?<![\p{L}\d])[A-Z]{2,3} \d{5}(?![\p{L}\d])/gu)) add(m.index!, m.index! + m[0].length);
  // After a label, anything with 3+ digits: "matricule 118842", "numéro d'employé U-2207", "lot 5 912 448".
  for (const m of text.matchAll(/(?<![\p{L}\d])[A-Z0-9]*\d[A-Z0-9]*(?:(?:[-/]| (?=\d{3}(?!\d)))[A-Z0-9]+)*(?![\p{L}\d])/gu)) {
    if (digits(m[0]) >= 3 && ID_LABEL.test(text.slice(Math.max(0, m.index! - 30), m.index!).replace(/[’']/g, ' '))) add(m.index!, m.index! + m[0].length);
  }
  return out;
}

/** Keep the longer of two overlapping detections; a card number beats the phone found inside it. */
export function dedupeOverlaps(ds: Detection[]): Detection[] {
  const sorted = [...ds].sort((a, b) => b.end! - b.start! - (a.end! - a.start!));
  const kept: Detection[] = [];
  for (const d of sorted) {
    if (!kept.some((k) => d.start! < k.end! && d.end! > k.start!)) kept.push(d);
  }
  return kept.sort((a, b) => a.start! - b.start!);
}
