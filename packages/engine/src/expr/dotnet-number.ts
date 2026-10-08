/**
 * formatNumber(): .NET numeric format strings, as measured against the cloud
 * (conformance/flows/expressions.ff.ts).
 *
 * Rounding works on the value's 17 significant digits (12.345 → 12.345000000000001 → 12.35,
 * 1.005 → 1.0049999999999999 → 1.00). Standard formats (N, F, C, P) round half to even
 * (2.5 → 2, 0.125 → 0.12); custom formats ('0.00') round half away from zero (0.125 → 0.13).
 */

import { numberText } from './values.js';

type Rounding = 'even' | 'away';

interface NumberCulture {
  group: string;
  decimal: string;
  currency: (amount: string) => string;
  percent: (amount: string) => string;
}

const CULTURES: Record<string, NumberCulture> = {
  'en-us': { group: ',', decimal: '.', currency: (a) => `$${a}`, percent: (a) => `${a}%` },
  'en-gb': { group: ',', decimal: '.', currency: (a) => `£${a}`, percent: (a) => `${a}%` },
  'de-de': { group: '.', decimal: ',', currency: (a) => `${a} €`, percent: (a) => `${a} %` },
  'fr-fr': { group: ' ', decimal: ',', currency: (a) => `${a} €`, percent: (a) => `${a} %` },
};

const intlCache = new Map<string, NumberCulture>();

/** Separators for a locale: measured tables, otherwise Intl with Windows-style spaces. */
function numberCulture(locale: string): NumberCulture {
  const key = locale.toLowerCase();
  const known = CULTURES[key];
  if (known) return known;
  const cached = intlCache.get(key);
  if (cached) return cached;
  let result = CULTURES['en-us'];
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1234567.5);
    const part = (type: string) => parts.find((p) => p.type === type)?.value;
    // ICU's narrow no-break space is a no-break space in .NET's data.
    const group = (part('group') ?? ',').replace(/ /g, ' ');
    const decimal = part('decimal') ?? '.';
    const currencyCode = currencyForLocale(locale);
    result = {
      group,
      decimal,
      currency: (amount) => {
        const sample = new Intl.NumberFormat(locale, { style: 'currency', currency: currencyCode }).formatToParts(1);
        const symbol = sample.find((p) => p.type === 'currency')?.value ?? currencyCode;
        const symbolFirst = sample.findIndex((p) => p.type === 'currency') < sample.findIndex((p) => p.type === 'integer');
        return symbolFirst ? `${symbol}${amount}` : `${amount} ${symbol}`;
      },
      percent: (amount) => `${amount}%`,
    };
  } catch {
    // an unknown locale keeps en-US
  }
  intlCache.set(key, result);
  return result;
}

function currencyForLocale(locale: string): string {
  const map: Record<string, string> = {
    US: 'USD', GB: 'GBP', DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR',
    AT: 'EUR', BE: 'EUR', IE: 'EUR', PT: 'EUR', FI: 'EUR', GR: 'EUR',
    JP: 'JPY', CN: 'CNY', IN: 'INR', CA: 'CAD', AU: 'AUD', CH: 'CHF',
    SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF',
    RU: 'RUB', BR: 'BRL', MX: 'MXN', KR: 'KRW', TR: 'TRY', ZA: 'ZAR',
  };
  const region = locale.split(/[-_]/)[1]?.toUpperCase();
  return (region && map[region]) || 'USD';
}

/**
 * |value| rounded to `frac` fraction digits, as { int, frac } digit strings, working from the
 * value's 17 significant digits.
 */
function roundAbs(value: number, frac: number, mode: Rounding, shift = 0): { int: string; frac: string } {
  const [mantissa, exp] = Math.abs(value).toExponential(16).split('e');
  const digits = BigInt(mantissa.replace('.', ''));
  // value × 10^shift × 10^frac = digits × 10^k. Percentages shift the digits rather than
  // multiplying the double (0.005 → 0.50000000000000001% → 1%).
  const k = Number(exp) - 16 + frac + shift;
  let scaled: bigint;
  if (k >= 0) {
    scaled = digits * 10n ** BigInt(k);
  } else {
    const divisor = 10n ** BigInt(-k);
    scaled = digits / divisor;
    const twice = (digits % divisor) * 2n;
    if (twice > divisor || (twice === divisor && (mode === 'away' || scaled % 2n === 1n))) scaled += 1n;
  }
  const text = scaled.toString().padStart(frac + 1, '0');
  return { int: text.slice(0, text.length - frac), frac: text.slice(text.length - frac) };
}

function group(int: string, separator: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

function fixed(value: number, frac: number, c: NumberCulture, grouping: boolean, shift = 0): string {
  const r = roundAbs(value, frac, 'even', shift);
  const isZero = /^0*$/.test(r.int + r.frac);
  const body = (grouping ? group(r.int, c.group) : r.int) + (frac > 0 ? c.decimal + r.frac : '');
  return (value < 0 && !isZero ? '-' : '') + body;
}

export function formatNumberValue(value: number, format: string, locale: string): string {
  if (!Number.isFinite(value)) return numberText(value);
  const c = numberCulture(locale);
  const standard = format.match(/^([CNFDPEGXcnfdpegx])(\d*)$/);
  if (!standard) return formatCustom(value, format, c);

  const specifier = standard[1].toUpperCase();
  const precision = standard[2] === '' ? undefined : Number(standard[2]);
  switch (specifier) {
    case 'N':
      return fixed(value, precision ?? 2, c, true);
    case 'F':
      return fixed(value, precision ?? 2, c, false);
    case 'C': {
      const amount = fixed(Math.abs(value), precision ?? 2, c, true);
      const text = c.currency(amount);
      return value < 0 && /[1-9]/.test(amount) ? `-${text}` : text;
    }
    case 'P': {
      const amount = fixed(Math.abs(value), precision ?? 2, c, true, 2);
      const text = c.percent(amount);
      return value < 0 && /[1-9]/.test(amount) ? `-${text}` : text;
    }
    case 'D': {
      const intVal = Math.trunc(value);
      const sign = intVal < 0 ? '-' : '';
      return sign + Math.abs(intVal).toString().padStart(precision ?? 1, '0');
    }
    case 'E': {
      // Three-digit minimum exponent: 1.23E+003.
      const [m, e] = value.toExponential(precision ?? 6).split('e');
      const exp = Number(e);
      return `${m.replace('.', c.decimal)}${standard[1] === 'e' ? 'e' : 'E'}${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(3, '0')}`;
    }
    case 'G':
      return (precision ? numberText(Number(value.toPrecision(precision))) : numberText(value)).replace('.', c.decimal);
    case 'X': {
      let hex = (Math.trunc(value) >>> 0).toString(16);
      if (standard[1] === 'X') hex = hex.toUpperCase();
      return precision !== undefined ? hex.padStart(precision, '0') : hex;
    }
  }
  return numberText(value);
}

/** Splits on unquoted ';' into up to three sections: positive; negative; zero. */
function sections(format: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < format.length; i++) {
    const ch = format[i];
    if (quote) {
      if (ch === quote) quote = '';
      current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === '\\') {
      current += ch + (format[i + 1] ?? '');
      i++;
    } else if (ch === ';') {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/** A custom numeric format such as '0.00', '#,##0.#', '000', '0.0%', '0;(0);zero'. */
function formatCustom(value: number, format: string, c: NumberCulture): string {
  const parts = sections(format);
  const render = (section: string, v: number) => renderSection(section, v, c);
  if (parts.length === 1) {
    const text = render(parts[0], Math.abs(value));
    return value < 0 && /[1-9]/.test(text) ? `-${text}` : text;
  }
  const positive = parts[0];
  const negative = parts[1] || parts[0];
  const zero = parts[2];
  const abs = Math.abs(value);
  const rounded = render(positive, abs);
  if (zero !== undefined && !/[1-9]/.test(rounded)) return render(zero, 0);
  if (value < 0) return parts[1] ? render(negative, abs) : `-${render(negative, abs)}`;
  return rounded;
}

function renderSection(section: string, value: number, c: NumberCulture): string {
  // Literal pieces, and the placeholder run between the first and last digit placeholder.
  const chars: Array<{ ch: string; literal: boolean }> = [];
  for (let i = 0; i < section.length; i++) {
    const ch = section[i];
    if (ch === "'" || ch === '"') {
      const end = section.indexOf(ch, i + 1);
      const stop = end < 0 ? section.length : end;
      for (const x of section.slice(i + 1, stop)) chars.push({ ch: x, literal: true });
      i = stop;
    } else if (ch === '\\') {
      chars.push({ ch: section[i + 1] ?? '', literal: true });
      i++;
    } else {
      chars.push({ ch, literal: false });
    }
  }
  const isPlaceholder = (x: { ch: string; literal: boolean }) => !x.literal && (x.ch === '0' || x.ch === '#');
  const first = chars.findIndex(isPlaceholder);
  if (first < 0) return chars.map((x) => x.ch).join('');
  let last = chars.length - 1;
  while (!isPlaceholder(chars[last])) last--;

  const run = chars.slice(first, last + 1).filter((x) => !x.literal).map((x) => x.ch).join('');
  const percent = chars.some((x) => !x.literal && x.ch === '%');
  const dot = run.indexOf('.');
  const intPattern = dot < 0 ? run : run.slice(0, dot);
  const fracPattern = dot < 0 ? '' : run.slice(dot + 1);
  const minInt = intPattern.includes('0') ? intPattern.length - intPattern.indexOf('0') - (intPattern.slice(intPattern.indexOf('0')).match(/,/g)?.length ?? 0) : 0;
  const minFrac = fracPattern.lastIndexOf('0') + 1;
  const maxFrac = (fracPattern.match(/[0#]/g) ?? []).length;
  const grouping = /[0#],[0#]/.test(intPattern);

  const r = roundAbs(value, maxFrac, 'away', percent ? 2 : 0);
  let int = r.int.replace(/^0+/, '').padStart(minInt, '0');
  if (grouping) int = group(int, c.group);
  let frac = r.frac;
  while (frac.length > minFrac && frac.endsWith('0')) frac = frac.slice(0, -1);
  const number = int + (frac ? c.decimal + frac : '');

  const text = (list: typeof chars) => list.map((x) => x.ch).join('');
  return text(chars.slice(0, first)) + number + text(chars.slice(last + 1));
}
