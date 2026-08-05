import type { RunContext } from '../index.js';
import { DOMParser } from '@xmldom/xmldom';
import { XMLSerializer } from '@xmldom/xmldom';

// Cross-platform base64 encode/decode for UTF-8 strings. Node uses Buffer
// (fast); browsers use TextEncoder/TextDecoder + btoa/atob because Buffer
// does not exist there.
export function utf8ToBase64(s: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(s, 'utf-8').toString('base64');
  }
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToUtf8(b64: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(b64, 'base64').toString('utf-8');
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

export type BinaryValue = { '$content-type': string; '$content': string };

export function makeBinary(b64: string, contentType = 'application/octet-stream'): BinaryValue {
  return { '$content-type': contentType, '$content': b64 };
}

// 100-ns ticks at the Unix epoch (1970-01-01T00:00:00Z) since 0001-01-01.
export const TICKS_AT_EPOCH = 621355968000000000;

const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

// Shift a Date by an interval in PA-style time units (case-insensitive, optional 's').
export function shiftTime(date: Date, interval: number, unit: string): Date {
  let u = unit.toLowerCase();
  if (u.endsWith('s')) u = u.slice(0, -1);
  if (u === 'month') {
    const d = new Date(date);
    d.setUTCMonth(d.getUTCMonth() + interval);
    return d;
  }
  if (u === 'year') {
    const d = new Date(date);
    d.setUTCFullYear(d.getUTCFullYear() + interval);
    return d;
  }
  const ms = UNIT_MS[u];
  if (ms === undefined) return date;
  return new Date(date.getTime() + interval * ms);
}

// Subset of Windows time-zone IDs Power Automate uses, mapped to IANA names.
// Engine accepts either form. Add more entries here as needed.
const WIN_TO_IANA: Record<string, string> = {
  'UTC': 'UTC',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago',
  'Eastern Standard Time': 'America/New_York',
  'Atlantic Standard Time': 'America/Halifax',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central European Standard Time': 'Europe/Warsaw',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'E. Europe Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Helsinki',
  'GTB Standard Time': 'Europe/Athens',
  'Russian Standard Time': 'Europe/Moscow',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Singapore Standard Time': 'Asia/Singapore',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'AUS Central Standard Time': 'Australia/Darwin',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Egypt Standard Time': 'Africa/Cairo',
  'Israel Standard Time': 'Asia/Jerusalem',
};

export function resolveTz(tz: string): string {
  return WIN_TO_IANA[tz] ?? tz;
}

// UTC offset in ms for `tz` at the given UTC moment (DST-aware via Intl).
export function tzOffsetMs(utcDate: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(utcDate)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const hour = +parts.hour === 24 ? 0 : +parts.hour;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, +parts.minute, +parts.second);
  return asUtc - utcDate.getTime();
}

// Format a Date as ISO without trailing 'Z' — used by convertX functions whose
// result is no longer in UTC. Trims the ms to match `YYYY-MM-DDTHH:mm:ss`.
export function isoNoZone(d: Date): string {
  return d.toISOString().slice(0, 19);
}

// Parse a wall-clock timestamp as if it were UTC, so the wall-clock numbers
// (year/month/day/hour/min/sec) survive intact regardless of host timezone.
// Used by convertToUtc / convertTimeZone where the input is "wall clock in
// some source TZ" — JS would otherwise interpret naked ISO strings as host-local.
export function parseAsUtc(ts: string): Date {
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(ts)) return new Date(ts);
  return new Date(ts + 'Z');
}

// Silent error handler — xmldom logs warnings/errors to stderr by default,
// which pollutes engine output for normal expression evaluation. Callers can
// catch the actual parse failure via the returned doc.
const SILENT_XML_ERRORS = {
  warning: () => {},
  error: () => {},
  fatalError: () => {},
};

export function parseXml(input: string): Document {
  return new DOMParser({ errorHandler: SILENT_XML_ERRORS }).parseFromString(input, 'text/xml') as unknown as Document;
}

// Convert an XPath result node into the value PA returns: serialized XML for
// element nodes, raw value for attribute/text nodes. Primitives pass through
// unchanged (xpath functions like count()/string()/sum() return JS primitives).
export function serializeXPathResult(node: any): any {
  if (node === null || node === undefined) return node;
  if (typeof node !== 'object') return node;
  if (node.nodeType === undefined) return node;
  // 1=Element, 9=Document, 11=DocumentFragment → serialize as XML
  if (node.nodeType === 1 || node.nodeType === 9 || node.nodeType === 11) {
    return new XMLSerializer().serializeToString(node);
  }
  // 2=Attribute → return its value
  if (node.nodeType === 2) return node.value;
  // 3=Text, 4=CDATA, 8=Comment → return its data
  if (node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 8) return node.data;
  return String(node);
}

export function parseDataUri(uri: string): { contentType: string; content: string; isBase64: boolean } {
  const match = uri.match(/^data:([^,]*?)(;base64)?,(.*)$/);
  if (!match) {
    return { contentType: 'text/plain;charset=utf-8', content: '', isBase64: false };
  }
  return {
    contentType: match[1] || 'text/plain;charset=utf-8',
    content: match[3] || '',
    isBase64: !!match[2],
  };
}

/**
 * Format a number using a .NET-style numeric format string and a locale.
 * Supports standard specifiers (C, N, F, D, P, E, G, X) and basic custom
 * patterns made of '0', '#', '.', and ',' (e.g., '0.00', '#,##0.00').
 */
export function formatNumberValue(value: number, format: string, locale: string): string {
  if (!isFinite(value)) return String(value);

  const standard = format.match(/^([CNFDPEGXcnfdpegx])(\d*)$/);
  if (standard) {
    const specifier = standard[1].toUpperCase();
    const precision = standard[2] === '' ? undefined : Number(standard[2]);

    try {
      switch (specifier) {
        case 'C': {
          const fractionDigits = precision ?? 2;
          const currency = currencyForLocale(locale);
          return new Intl.NumberFormat(locale, {
            style: 'currency',
            currency,
            minimumFractionDigits: fractionDigits,
            maximumFractionDigits: fractionDigits,
          }).format(value);
        }
        case 'N': {
          const fractionDigits = precision ?? 2;
          return new Intl.NumberFormat(locale, {
            useGrouping: true,
            minimumFractionDigits: fractionDigits,
            maximumFractionDigits: fractionDigits,
          }).format(value);
        }
        case 'F': {
          const fractionDigits = precision ?? 2;
          return new Intl.NumberFormat(locale, {
            useGrouping: false,
            minimumFractionDigits: fractionDigits,
            maximumFractionDigits: fractionDigits,
          }).format(value);
        }
        case 'D': {
          const minDigits = precision ?? 1;
          const intVal = Math.trunc(value);
          const sign = intVal < 0 ? '-' : '';
          return sign + Math.abs(intVal).toString().padStart(minDigits, '0');
        }
        case 'P': {
          const fractionDigits = precision ?? 2;
          return new Intl.NumberFormat(locale, {
            style: 'percent',
            minimumFractionDigits: fractionDigits,
            maximumFractionDigits: fractionDigits,
          }).format(value);
        }
        case 'E': {
          const fractionDigits = precision ?? 6;
          return value.toExponential(fractionDigits).replace('e', 'E');
        }
        case 'G': {
          if (precision !== undefined) {
            return value.toPrecision(precision);
          }
          return String(value);
        }
        case 'X': {
          const intVal = Math.trunc(value);
          let hex = (intVal >>> 0).toString(16).toUpperCase();
          if (precision !== undefined) hex = hex.padStart(precision, '0');
          return hex;
        }
      }
    } catch {
      // fall through to custom format handling
    }
  }

  // Custom format string: count fractional digits from '0'/'#' after the decimal,
  // detect grouping from a ',' before the decimal.
  const decIdx = format.indexOf('.');
  const intPart = decIdx >= 0 ? format.slice(0, decIdx) : format;
  const fracPart = decIdx >= 0 ? format.slice(decIdx + 1) : '';
  const minFrac = (fracPart.match(/0/g) || []).length;
  const maxFrac = (fracPart.match(/[0#]/g) || []).length;
  const useGrouping = intPart.includes(',');

  try {
    return new Intl.NumberFormat(locale, {
      useGrouping,
      minimumFractionDigits: minFrac,
      maximumFractionDigits: Math.max(minFrac, maxFrac),
    }).format(value);
  } catch {
    return String(value);
  }
}

/**
 * Best-effort currency code for a locale, matching .NET's RegionInfo.ISOCurrencySymbol behavior.
 * Falls back to USD when the locale has no clear region.
 */
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
 * Get action data with case-insensitive lookup (matching Logic Apps behavior).
 */
export function getActionData(ctx: RunContext, actionName: string): any {
  // Try exact match first (fast path)
  if (ctx.actions.has(actionName)) {
    return ctx.actions.get(actionName);
  }
  // Fall back to case-insensitive search
  const lowerActionName = actionName.toLowerCase();
  for (const [key, value] of ctx.actions.entries()) {
    if (key.toLowerCase() === lowerActionName) {
      return value;
    }
  }
  return undefined;
}
