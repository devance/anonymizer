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
