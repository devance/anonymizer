/**
 * Finds dates written the ways French and English Québec documents write them
 * and re-renders a different date in the same style, so "le 1er mars 1984"
 * becomes "le 17 juin 1984" and "March 1, 1984" becomes "June 17, 1984".
 */

type Lang = 'fr' | 'en';

interface MonthName {
  month: number;
  lang: Lang;
  form: 'full' | 'abbr';
}

const FR_FULL = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const FR_ABBR = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];
const EN_FULL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const EN_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const MONTHS = new Map<string, MonthName>();
function addMonths(names: string[], lang: Lang, form: 'full' | 'abbr') {
  names.forEach((n, i) => {
    const plain = n.normalize('NFD').replace(/\p{M}/gu, '');
    for (const v of new Set([n, plain])) {
      if (!MONTHS.has(v)) MONTHS.set(v, { month: i + 1, lang, form });
    }
  });
}
addMonths(FR_FULL, 'fr', 'full');
addMonths(EN_FULL, 'en', 'full');
addMonths(FR_ABBR, 'fr', 'abbr');
addMonths(EN_ABBR, 'en', 'abbr');
MONTHS.set('fév', { month: 2, lang: 'fr', form: 'abbr' });
MONTHS.set('fev', { month: 2, lang: 'fr', form: 'abbr' });

// Longest first so "septembre" wins over "sept".
const MONTH_ALT = [...MONTHS.keys()].sort((a, b) => b.length - a.length).join('|');

export interface DateFormat {
  kind: 'ymd' | 'dmy' | 'mdy' | 'd_month_y' | 'month_d_y';
  sep?: string;
  padDay?: boolean;
  padMonth?: boolean;
  monthLang?: Lang;
  monthForm?: 'full' | 'abbr';
  monthCase?: 'lower' | 'title' | 'upper';
  abbrDot?: boolean;
  /** Which ordinal suffix the original used: French "1er" or English "1st". */
  ordinal?: 'fr' | 'en';
  comma?: boolean;
}

export interface DateHit {
  start: number;
  end: number;
  text: string;
  /** Usually one; two when a numeric date like 03/04/1990 could be either order. */
  candidates: Array<{ iso: string; format: DateFormat }>;
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Numeric dates are padded unless one part visibly isn't ("3/4/1990"). */
function numericPad(a: string, b: string): boolean {
  return a.startsWith('0') || b.startsWith('0') || (a.length === 2 && b.length === 2);
}

function ordStyle(ord: string | undefined): DateFormat['ordinal'] {
  if (!ord) return undefined;
  return ord.toLowerCase() === 'er' ? 'fr' : 'en';
}

function caseOf(s: string): 'lower' | 'title' | 'upper' {
  if (s === s.toUpperCase() && s.length > 1) return 'upper';
  if (s[0] === s[0]!.toUpperCase()) return 'title';
  return 'lower';
}

export function findDates(text: string): DateHit[] {
  const hits: DateHit[] = [];
  const taken: Array<[number, number]> = [];
  const push = (h: DateHit) => {
    if (h.candidates.length === 0) return;
    if (taken.some(([a, b]) => h.start < b && h.end > a)) return;
    taken.push([h.start, h.end]);
    hits.push(h);
  };

  // 1984-03-01, 1984/03/01
  for (const m of text.matchAll(/(?<![\d])(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?![\d])/g)) {
    const [, y, sep, mo, d] = m;
    const v = iso(+y!, +mo!, +d!);
    push({
      start: m.index!,
      end: m.index! + m[0].length,
      text: m[0],
      candidates: v ? [{ iso: v, format: { kind: 'ymd', sep, padMonth: numericPad(mo!, d!), padDay: numericPad(mo!, d!) } }] : [],
    });
  }

  // 01/03/1984 (day first in Québec, month first in US-style forms; ambiguous when both ≤ 12)
  for (const m of text.matchAll(/(?<![\d])(\d{1,2})([-/.])(\d{1,2})\2(\d{4})(?![\d])/g)) {
    const [, a, sep, b, y] = m;
    const candidates: DateHit['candidates'] = [];
    const dmy = iso(+y!, +b!, +a!);
    const mdy = iso(+y!, +a!, +b!);
    const pad = numericPad(a!, b!);
    if (dmy) candidates.push({ iso: dmy, format: { kind: 'dmy', sep, padDay: pad, padMonth: pad } });
    if (mdy && mdy !== dmy) candidates.push({ iso: mdy, format: { kind: 'mdy', sep, padMonth: pad, padDay: pad } });
    push({ start: m.index!, end: m.index! + m[0].length, text: m[0], candidates });
  }

  // 1er mars 1984, 15 March 1984
  const dmyText = new RegExp(`(?<![\\p{L}\\d])(\\d{1,2})(er|st|nd|rd|th)?\\s+(${MONTH_ALT})(\\.?)\\s+(\\d{4})(?![\\d])`, 'giu');
  for (const m of text.matchAll(dmyText)) {
    const [, d, ord, mon, dot, y] = m;
    const info = MONTHS.get(mon!.toLowerCase());
    if (!info) continue;
    const v = iso(+y!, info.month, +d!);
    push({
      start: m.index!,
      end: m.index! + m[0].length,
      text: m[0],
      candidates: v
        ? [{ iso: v, format: { kind: 'd_month_y', monthLang: info.lang, monthForm: info.form, monthCase: caseOf(mon!), abbrDot: !!dot, ordinal: ordStyle(ord), padDay: d!.startsWith('0') } }]
        : [],
    });
  }

  // March 1, 1984, Mar. 1st 1984
  const mdyText = new RegExp(`(?<![\\p{L}])(${MONTH_ALT})(\\.?)\\s+(\\d{1,2})(st|nd|rd|th)?(,?)\\s+(\\d{4})(?![\\d])`, 'giu');
  for (const m of text.matchAll(mdyText)) {
    const [, mon, dot, d, ord, comma, y] = m;
    const info = MONTHS.get(mon!.toLowerCase());
    if (!info) continue;
    const v = iso(+y!, info.month, +d!);
    push({
      start: m.index!,
      end: m.index! + m[0].length,
      text: m[0],
      candidates: v
        ? [{ iso: v, format: { kind: 'month_d_y', monthLang: info.lang, monthForm: info.form, monthCase: caseOf(mon!), abbrDot: !!dot, ordinal: ordStyle(ord), comma: !!comma, padDay: d!.startsWith('0') } }]
        : [],
    });
  }

  return hits.sort((a, b) => a.start - b.start);
}

function monthName(month: number, f: DateFormat): string {
  const lang = f.monthLang ?? 'fr';
  const list = lang === 'fr' ? (f.monthForm === 'abbr' ? FR_ABBR : FR_FULL) : f.monthForm === 'abbr' ? EN_ABBR : EN_FULL;
  let name = list[month - 1]!;
  // "mai", "juin", "mars", "août" have no shorter form, so they never take a dot.
  const hasDot = f.abbrDot && f.monthForm === 'abbr' && name !== (lang === 'fr' ? FR_FULL : EN_FULL)[month - 1];
  if (f.monthCase === 'upper') name = name.toUpperCase();
  else if (f.monthCase === 'title') name = name[0]!.toUpperCase() + name.slice(1);
  return hasDot ? `${name}.` : name;
}

function enOrdinal(d: number): string {
  if (d % 100 >= 11 && d % 100 <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][d % 10] ?? 'th';
}

export function renderDate(isoDate: string, f: DateFormat): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const dd = f.padDay ? String(d).padStart(2, '0') : String(d);
  const mm = f.padMonth ? String(m).padStart(2, '0') : String(m);
  switch (f.kind) {
    case 'ymd':
      return `${y}${f.sep}${mm}${f.sep}${dd}`;
    case 'dmy':
      return `${dd}${f.sep}${mm}${f.sep}${y}`;
    case 'mdy':
      return `${mm}${f.sep}${dd}${f.sep}${y}`;
    case 'd_month_y': {
      const ord = f.ordinal === 'fr' ? (d === 1 ? 'er' : '') : f.ordinal === 'en' ? enOrdinal(d) : '';
      return `${dd}${ord} ${monthName(m, f)} ${y}`;
    }
    case 'month_d_y': {
      const ord = f.ordinal === 'fr' ? (d === 1 ? 'er' : '') : f.ordinal === 'en' ? enOrdinal(d) : '';
      return `${monthName(m, f)} ${dd}${ord}${f.comma ? ',' : ''} ${y}`;
    }
  }
}

/** Parse a single date string (an entity's text) to ISO, preferring day-first. */
/**
 * A date written as a bare number: "2018-05" (year and month), "20240331",
 * a fiscal year "2022-2023". Shaped like a reference number, but an AI needs
 * it exact; it's one only after a label ("dossier 2021-06").
 */
export function numericDate(value: string): boolean {
  const t = value.trim();
  const ym = t.match(/^((?:19|20)\d\d)[-/.](\d\d)$/);
  if (ym && +ym[2]! >= 1 && +ym[2]! <= 12) return true;
  const fy = t.match(/^((?:19|20)\d\d)[-/]((?:19|20)?\d\d)$/);
  if (fy && (+fy[1]! + 1) % (fy[2]!.length === 2 ? 100 : 10000) === +fy[2]!) return true;
  const ymd = t.match(/^((?:19|20)\d\d)(\d\d)(\d\d)$/);
  return !!ymd && iso(+ymd[1]!, +ymd[2]!, +ymd[3]!) !== null;
}

export function parseDate(text: string): { iso: string; format: DateFormat } | null {
  const hit = findDates(text)[0];
  return hit?.candidates[0] ?? null;
}

/** OCR look-alikes in a date read as what they stand for: "l5" → "15", "3O" → "30", "Apri1" → "April". */
export function ocrDateFix(text: string): string {
  return text
    .replace(/(?<=\d)[lI|]|[lI|](?=\d)/g, '1')
    .replace(/(?<=\d)[oO]|[oO](?=\d)/g, '0')
    .replace(/(?<=\p{L})1(?![\p{N}])/gu, 'l');
}

/** parseDate that also reads OCR'd dates ("né le l5 janvier 1975"). */
export function parseDateLoose(text: string): { iso: string; format: DateFormat } | null {
  return parseDate(text) ?? parseDate(ocrDateFix(text));
}
