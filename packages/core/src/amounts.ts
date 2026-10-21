/**
 * Dollar amounts in either convention: "1 234,56 $" (French) or "$1,234.56"
 * (English). Amounts are opt-in, since an AI usually needs them to be right.
 */

export interface AmountFormat {
  symbolFirst: boolean;
  /** Space between number and symbol, preserved byte-for-byte (often a no-break space). */
  gap: string;
  thousands: string;
  decimal: string | null;
  decimals: number;
}

export interface AmountHit {
  start: number;
  end: number;
  text: string;
  value: number;
  format: AmountFormat;
}

const NUM = String.raw`\d{1,3}(?:[ ,.  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;

function parseNumber(raw: string): { value: number; thousands: string; decimal: string | null; decimals: number } {
  const m = raw.match(/^(.*?)([.,])(\d{1,2})$/);
  if (m) {
    const intPart = m[1]!;
    const sepMatch = intPart.match(/[ ,.  ]/);
    return {
      value: Number(intPart.replace(/[^\d]/g, '') + '.' + m[3]),
      thousands: sepMatch ? sepMatch[0] : '',
      decimal: m[2]!,
      decimals: m[3]!.length,
    };
  }
  const sepMatch = raw.match(/[ ,.  ]/);
  return { value: Number(raw.replace(/[^\d]/g, '')), thousands: sepMatch ? sepMatch[0] : '', decimal: null, decimals: 0 };
}

export function findAmounts(text: string): AmountHit[] {
  const hits: AmountHit[] = [];
  const re = new RegExp(String.raw`\$([   ]?)(${NUM})(?!\d)|(?<![\d.,])(${NUM})([   ]?)\$`, 'g');
  for (const m of text.matchAll(re)) {
    const symbolFirst = m[2] !== undefined;
    const raw = (symbolFirst ? m[2] : m[3])!;
    const p = parseNumber(raw);
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      text: m[0],
      value: p.value,
      format: { symbolFirst, gap: (symbolFirst ? m[1] : m[4]) ?? '', thousands: p.thousands, decimal: p.decimal, decimals: p.decimals },
    });
  }
  return hits;
}

export function renderAmount(value: number, f: AmountFormat): string {
  const fixed = value.toFixed(f.decimals);
  const [int, frac] = fixed.split('.') as [string, string | undefined];
  const grouped = f.thousands ? int.replace(/\B(?=(\d{3})+(?!\d))/g, f.thousands) : int;
  const num = frac !== undefined && f.decimal ? `${grouped}${f.decimal}${frac}` : grouped;
  return f.symbolFirst ? `$${f.gap}${num}` : `${num}${f.gap}$`;
}

export function parseAmount(text: string): AmountHit | null {
  return findAmounts(text)[0] ?? null;
}

const GAP = '[   ]';

/**
 * Digits at [start, end) that belong to an amount, a rate or a decimal
 * number: "4827" in "4827,35 $", "3318 12" in "7,3318 12,750", "750" in
 * "750 $". An identifier never sits there, and an AI needs these numbers
 * exact, so detection and matching leave them alone.
 */
export function partOfAmount(text: string, start: number, end: number): boolean {
  const span = text.slice(start, end);
  const head = span.match(/^\d+/)?.[0];
  const tail = span.match(/\d+$/)?.[0];
  const before = text.slice(Math.max(0, start - 3), start);
  const after = text.slice(end, end + 8);
  // The decimals of "7,3318". A long run after a comma is a list ("123456,4185550101"), not decimals.
  if (head && head.length <= 4 && /\d[.,]$/.test(before)) return true;
  // The whole part of "4827,35": one to four decimals, then no more digits.
  if (tail && tail.length <= 7 && /^[.,]\d{1,4}(?!\d)/.test(after)) return true;
  return new RegExp(`\\$${GAP}?$`).test(before) || new RegExp(`^${GAP}?[$%]`).test(after);
}

/** A value written as an amount or a rate ("12,750", "50,000", "4 827,35 $"), whatever type a model gave it. */
export function amountShaped(value: string): boolean {
  const t = value.trim();
  if (t.replace(/\D/g, '').length > 12) return false;
  return (
    new RegExp(`^\\d{1,3}(?:${GAP}\\d{3})*[.,]\\d{1,4}$`).test(t) ||
    /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(t) ||
    /^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(t) ||
    new RegExp(`^\\$${GAP}?\\d|\\d${GAP}?[$%]$`).test(t)
  );
}
