/**
 * .NET DateTime semantics for the date/time expression functions, as measured against the cloud
 * (conformance/flows/expressions.ff.ts).
 *
 * A value is a wall-clock moment (held as UTC epoch ms plus sub-millisecond ticks) and a kind:
 *   - 'utc'          input ended in Z            → printed with 'Z'
 *   - 'unspecified'  input had no zone           → printed with no suffix
 *   - 'offset'       input had ±hh:mm            → converted to UTC, printed with '+00:00'
 * The default output is the round-trip 'o' format with seven fraction digits.
 */

import { ExpressionError } from './values.js';

export type DateKind = 'utc' | 'unspecified' | 'offset';

export interface NetDate {
  /** Wall clock as epoch milliseconds read in UTC. */
  ms: number;
  /** Ticks (100 ns) below the millisecond, 0–9999. */
  sub: number;
  kind: DateKind;
}

const TICKS_PER_MS = 10_000;
export const TICKS_AT_EPOCH = 621355968000000000n;

// ---------------------------------------------------------------------------------------------
// Culture data

interface Culture {
  months: string[];
  monthsAbbr: string[];
  days: string[];
  daysAbbr: string[];
  am: string;
  pm: string;
  dateSep: string;
  timeSep: string;
  /** Standard format patterns: d D t T M Y. */
  patterns: Record<'d' | 'D' | 't' | 'T' | 'M' | 'Y', string>;
}

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const EN_US: Culture = {
  months: EN_MONTHS,
  monthsAbbr: EN_MONTHS.map((m) => m.slice(0, 3)),
  days: EN_DAYS,
  daysAbbr: EN_DAYS.map((d) => d.slice(0, 3)),
  am: 'AM',
  pm: 'PM',
  dateSep: '/',
  timeSep: ':',
  patterns: { d: 'M/d/yyyy', D: 'dddd, MMMM d, yyyy', t: 'h:mm tt', T: 'h:mm:ss tt', M: 'MMMM d', Y: 'MMMM yyyy' },
};

const CULTURES: Record<string, Culture> = {
  'en-us': EN_US,
  '': EN_US,
  'en-gb': {
    ...EN_US,
    patterns: { d: 'dd/MM/yyyy', D: 'dd MMMM yyyy', t: 'HH:mm', T: 'HH:mm:ss', M: 'd MMMM', Y: 'MMMM yyyy' },
  },
  'de-de': {
    months: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
    monthsAbbr: ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'],
    days: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
    daysAbbr: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
    am: 'AM',
    pm: 'PM',
    dateSep: '.',
    timeSep: ':',
    patterns: { d: 'dd.MM.yyyy', D: 'dddd, d. MMMM yyyy', t: 'HH:mm', T: 'HH:mm:ss', M: 'd. MMMM', Y: 'MMMM yyyy' },
  },
  'fr-fr': {
    months: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
    monthsAbbr: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
    days: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
    daysAbbr: ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'],
    am: 'AM',
    pm: 'PM',
    dateSep: '/',
    timeSep: ':',
    patterns: { d: 'dd/MM/yyyy', D: 'dddd d MMMM yyyy', t: 'HH:mm', T: 'HH:mm:ss', M: 'd MMMM', Y: 'MMMM yyyy' },
  },
};

const intlCache = new Map<string, Culture>();

/** Culture data: measured tables for common cultures, otherwise names from Intl on en-US patterns. */
export function culture(locale?: string): Culture {
  const key = String(locale ?? '').toLowerCase();
  const known = CULTURES[key];
  if (known) return known;
  const cached = intlCache.get(key);
  if (cached) return cached;
  let result = EN_US;
  try {
    const names = (opts: Intl.DateTimeFormatOptions, count: number, at: (i: number) => Date) =>
      Array.from({ length: count }, (_, i) => new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }).format(at(i)));
    const month = (i: number) => new Date(Date.UTC(2026, i, 1));
    const day = (i: number) => new Date(Date.UTC(2026, 2, 1 + i)); // 2026-03-01 is a Sunday
    result = {
      ...EN_US,
      months: names({ month: 'long' }, 12, month),
      monthsAbbr: names({ month: 'short' }, 12, month),
      days: names({ weekday: 'long' }, 7, day),
      daysAbbr: names({ weekday: 'short' }, 7, day),
    };
  } catch {
    // an unknown locale keeps en-US
  }
  intlCache.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Parsing

const ISO =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

function fromParts(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, frac = '', zone?: string): NetDate | undefined {
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo - 1) || h > 23 || mi > 59 || s > 59) return undefined;
  const ticks = Number((frac + '0000000').slice(0, 7));
  let ms = Date.UTC(y, mo - 1, d, h, mi, s) + Math.floor(ticks / TICKS_PER_MS);
  const sub = ticks % TICKS_PER_MS;
  if (!zone) return { ms, sub, kind: 'unspecified' };
  if (zone.toUpperCase() === 'Z') return { ms, sub, kind: 'utc' };
  const m = zone.match(/([+-])(\d{2}):?(\d{2})/)!;
  ms -= (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
  return { ms, sub, kind: 'offset' };
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** Culture-style date[ time] without a format: M/d/yyyy (en-US), d.M.yyyy (de-DE), d/M/yyyy (others). */
function parseCultureDate(s: string, c: Culture): NetDate | undefined {
  const sep = c.dateSep === '.' ? '\\.' : '/';
  const m = s.match(
    new RegExp(`^(\\d{1,4})${sep}(\\d{1,2})${sep}(\\d{1,4})(?:[ T](\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*(AM|PM)?)?$`, 'i'),
  );
  if (!m) return undefined;
  const [p1, p2, p3] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // yyyy/M/d anywhere; otherwise M/d/yyyy in en-US and d/M/yyyy elsewhere.
  const [y, mo, d] = m[1].length === 4 ? [p1, p2, p3] : c === EN_US ? [p3, p1, p2] : [p3, p2, p1];
  let h = m[4] ? Number(m[4]) : 0;
  if (m[7]) h = (h % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0);
  return fromParts(y < 100 ? 2000 + y : y, mo, d, h, m[5] ? Number(m[5]) : 0, m[6] ? Number(m[6]) : 0);
}

/** Parses a timestamp the way the date functions accept it; undefined when it isn't one. */
export function parseNetDate(value: unknown, locale?: string, format?: string): NetDate | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (format) return parseExact(s, format, culture(locale));
  const iso = s.match(ISO);
  if (iso) {
    return fromParts(+iso[1], +iso[2], +iso[3], iso[4] ? +iso[4] : 0, iso[5] ? +iso[5] : 0, iso[6] ? +iso[6] : 0, iso[7] ?? '', iso[8]);
  }
  const c = culture(locale);
  const local = parseCultureDate(s, c);
  if (local) return local;
  // Last resort: month names and the like, read as wall clock ("5 March 2026", "Thu, 05 Mar 2026 14:07:09 GMT").
  const zoned = /(Z|GMT|UTC|[+-]\d{2}:?\d{2})$/i.test(s);
  const t = Date.parse(zoned ? s : `${s} UTC`);
  if (Number.isNaN(t)) return undefined;
  return { ms: t, sub: 0, kind: zoned ? 'utc' : 'unspecified' };
}

/** parseNetDate, or the cloud's error for the function. */
export function requireDate(fn: string, value: unknown, locale?: string, format?: string): NetDate {
  const d = parseNetDate(value, locale, format);
  if (d) return d;
  throw new ExpressionError(
    `In function '${fn}', the value provided for date time string '${value}' was not valid. The datetime string must match ISO 8601 format.`,
  );
}

/** Parses with an explicit .NET custom format ('dd/MM/yyyy HH:mm'). */
function parseExact(s: string, format: string, c: Culture): NetDate | undefined {
  const fields: string[] = [];
  let re = '';
  for (const tok of tokenize(format)) {
    if (tok.literal !== undefined) {
      re += escapeRe(tok.literal);
      continue;
    }
    const { ch, n } = tok;
    const group = (pattern: string, field: string) => {
      fields.push(field);
      re += `(${pattern})`;
    };
    if (ch === 'y') group(n <= 2 ? '\\d{1,2}' : '\\d{4}', 'y');
    else if (ch === 'M') group(n >= 3 ? '[^\\s\\d,.]+\\.?' : '\\d{1,2}', n >= 3 ? 'Mname' : 'M');
    else if (ch === 'd') group(n >= 3 ? '[^\\s\\d,.]+\\.?' : '\\d{1,2}', n >= 3 ? 'skip' : 'd');
    else if (ch === 'H' || ch === 'h') group('\\d{1,2}', ch);
    else if (ch === 'm') group('\\d{1,2}', 'm');
    else if (ch === 's') group('\\d{1,2}', 's');
    else if (ch === 'f' || ch === 'F') group(`\\d{1,${n}}`, 'f');
    else if (ch === 't') group('[AaPp][Mm]?', 't');
    else if (ch === 'K' || ch === 'z') group('Z|[+-]\\d{1,2}(?::?\\d{2})?', 'zone');
    else if (ch === ':') re += escapeRe(c.timeSep);
    else if (ch === '/') re += escapeRe(c.dateSep);
    else re += escapeRe(ch.repeat(n));
  }
  const m = s.match(new RegExp(`^${re}$`, 'i'));
  if (!m) return undefined;
  const v: Record<string, string> = {};
  fields.forEach((f, i) => (v[f] = m[i + 1]));
  let month = v.M ? Number(v.M) : 1;
  if (v.Mname) {
    const name = v.Mname.toLowerCase();
    const idx = [c.months, c.monthsAbbr].map((list) => list.findIndex((x) => x.toLowerCase() === name)).find((i) => i >= 0);
    if (idx === undefined) return undefined;
    month = idx + 1;
  }
  let year = v.y ? Number(v.y) : 1;
  if (v.y && v.y.length <= 2) year += 2000;
  let hour = v.H ? Number(v.H) : v.h ? Number(v.h) % 12 : 0;
  if (v.t && /^p/i.test(v.t)) hour += 12;
  const zone = v.zone ? (/^z$/i.test(v.zone) ? 'Z' : v.zone.replace(/^([+-])(\d)(?!\d)/, '$10$2').padEnd(6, ':00')) : undefined;
  return fromParts(year, month, v.d ? Number(v.d) : 1, hour, v.m ? Number(v.m) : 0, v.s ? Number(v.s) : 0, v.f ?? '', zone);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------------------------
// Formatting

type Token = { literal: string; ch?: undefined; n?: undefined } | { literal?: undefined; ch: string; n: number };

/** Splits a .NET custom format into specifier runs and literals ('quoted', "quoted", \x). */
function tokenize(format: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < format.length; ) {
    const ch = format[i];
    if (ch === "'" || ch === '"') {
      const end = format.indexOf(ch, i + 1);
      const stop = end < 0 ? format.length : end;
      tokens.push({ literal: format.slice(i + 1, stop) });
      i = stop + 1;
      continue;
    }
    if (ch === '\\') {
      tokens.push({ literal: format[i + 1] ?? '' });
      i += 2;
      continue;
    }
    if (ch === '%') {
      i++;
      continue;
    }
    if ('dfFghHKmMstyz:/'.includes(ch)) {
      let n = 1;
      while (format[i + n] === ch) n++;
      tokens.push({ ch, n });
      i += n;
      continue;
    }
    tokens.push({ literal: ch });
    i++;
  }
  return tokens;
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

function suffix(kind: DateKind): string {
  return kind === 'utc' ? 'Z' : kind === 'offset' ? '+00:00' : '';
}

const ROUND_TRIP = "yyyy'-'MM'-'dd'T'HH':'mm':'ss'.'fffffffK";

/** Resolves a one-letter standard format to its custom pattern, or undefined when it isn't one. */
function standardPattern(f: string, c: Culture): string | undefined {
  const p = c.patterns;
  switch (f) {
    case 'd': return p.d;
    case 'D': return p.D;
    case 'f': return `${p.D} ${p.t}`;
    case 'F': return `${p.D} ${p.T}`;
    case 'g': return `${p.d} ${p.t}`;
    case 'G': return `${p.d} ${p.T}`;
    case 'm': case 'M': return p.M;
    case 't': return p.t;
    case 'T': return p.T;
    case 'y': case 'Y': return p.Y;
    case 'U': return `${p.D} ${p.T}`;
    default: return undefined;
  }
}

/** Formats like DateTime.ToString(format, culture); no format gives the round-trip 'o' form. */
export function formatNetDate(d: NetDate, format?: string, locale?: string): string {
  let c = culture(locale);
  let pattern = format || 'o';
  if (pattern.length === 1) {
    if (pattern === 'o' || pattern === 'O') pattern = ROUND_TRIP;
    else if (pattern === 'r' || pattern === 'R') {
      pattern = "ddd, dd MMM yyyy HH':'mm':'ss 'GMT'";
      c = EN_US;
    } else if (pattern === 's') pattern = "yyyy'-'MM'-'dd'T'HH':'mm':'ss";
    else if (pattern === 'u') pattern = "yyyy'-'MM'-'dd HH':'mm':'ss'Z'";
    else {
      const std = standardPattern(pattern, c);
      if (!std) throw new ExpressionError(`The provided date time format '${format}' is not valid.`);
      pattern = std;
    }
  }

  const t = new Date(d.ms);
  const year = t.getUTCFullYear();
  const month = t.getUTCMonth();
  const day = t.getUTCDate();
  const hour = t.getUTCHours();
  const fraction = pad(t.getUTCMilliseconds() * TICKS_PER_MS + d.sub, 7);

  let out = '';
  for (const tok of tokenize(pattern)) {
    if (tok.literal !== undefined) {
      out += tok.literal;
      continue;
    }
    const { ch, n } = tok;
    switch (ch) {
      case 'd':
        out += n === 1 ? day : n === 2 ? pad(day, 2) : n === 3 ? c.daysAbbr[t.getUTCDay()] : c.days[t.getUTCDay()];
        break;
      case 'f':
        out += fraction.slice(0, Math.min(n, 7));
        break;
      case 'F': {
        const digits = fraction.slice(0, Math.min(n, 7)).replace(/0+$/, '');
        // An all-zero F fraction drops the '.' before it too.
        if (!digits && out.endsWith('.')) out = out.slice(0, -1);
        out += digits;
        break;
      }
      case 'g':
        out += 'A.D.';
        break;
      case 'h':
        out += n === 1 ? (hour % 12 || 12) : pad(hour % 12 || 12, 2);
        break;
      case 'H':
        out += n === 1 ? hour : pad(hour, 2);
        break;
      case 'K':
        out += suffix(d.kind);
        break;
      case 'm':
        out += n === 1 ? t.getUTCMinutes() : pad(t.getUTCMinutes(), 2);
        break;
      case 'M':
        out += n === 1 ? month + 1 : n === 2 ? pad(month + 1, 2) : n === 3 ? c.monthsAbbr[month] : c.months[month];
        break;
      case 's':
        out += n === 1 ? t.getUTCSeconds() : pad(t.getUTCSeconds(), 2);
        break;
      case 't': {
        const designator = hour < 12 ? c.am : c.pm;
        out += n === 1 ? designator.slice(0, 1) : designator;
        break;
      }
      case 'y':
        out += n === 1 ? year % 100 : n === 2 ? pad(year % 100, 2) : pad(year, n);
        break;
      case 'z':
        // Every value is held in UTC, so the offset is always zero.
        out += n === 1 ? '+0' : n === 2 ? '+00' : '+00:00';
        break;
      case ':':
        out += c.timeSep.repeat(n);
        break;
      case '/':
        out += c.dateSep.repeat(n);
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Arithmetic

const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

/** Shifts by an interval of Second/Minute/Hour/Day/Week/Month/Year; months clamp to the month's end. */
export function shiftNetDate(d: NetDate, interval: number, unit: string): NetDate {
  let u = unit.toLowerCase();
  if (u.endsWith('s')) u = u.slice(0, -1);
  if (u === 'month' || u === 'year') {
    const t = new Date(d.ms);
    const months = t.getUTCFullYear() * 12 + t.getUTCMonth() + interval * (u === 'year' ? 12 : 1);
    const year = Math.floor(months / 12);
    const month = months - year * 12;
    const day = Math.min(t.getUTCDate(), daysInMonth(year, month));
    const ms = Date.UTC(year, month, day, t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds(), t.getUTCMilliseconds());
    return { ...d, ms };
  }
  const step = UNIT_MS[u];
  if (step === undefined) throw new ExpressionError(`The time unit '${unit}' is not valid.`);
  return { ...d, ms: d.ms + interval * step };
}

export function netTicks(d: NetDate): number {
  return Number(TICKS_AT_EPOCH + BigInt(d.ms) * BigInt(TICKS_PER_MS) + BigInt(d.sub));
}

/** A TimeSpan as .NET prints it: [-][d.]hh:mm:ss[.fffffff]. */
export function timeSpanText(ticks: bigint): string {
  const sign = ticks < 0n ? '-' : '';
  let t = ticks < 0n ? -ticks : ticks;
  const TPS = 10_000_000n;
  const fraction = t % TPS;
  t /= TPS;
  const seconds = t % 60n;
  t /= 60n;
  const minutes = t % 60n;
  t /= 60n;
  const hours = t % 24n;
  const days = t / 24n;
  const p2 = (n: bigint) => n.toString().padStart(2, '0');
  return (
    `${sign}${days > 0n ? `${days}.` : ''}${p2(hours)}:${p2(minutes)}:${p2(seconds)}` +
    (fraction > 0n ? `.${fraction.toString().padStart(7, '0')}` : '')
  );
}

export function totalTicks(d: NetDate): bigint {
  return BigInt(d.ms) * BigInt(TICKS_PER_MS) + BigInt(d.sub);
}
