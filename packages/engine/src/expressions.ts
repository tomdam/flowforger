import type { RunContext } from './index.js';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import * as xpathLib from 'xpath';

// Cross-platform base64 encode/decode for UTF-8 strings. Node uses Buffer
// (fast); browsers use TextEncoder/TextDecoder + btoa/atob because Buffer
// does not exist there.
function utf8ToBase64(s: string): string {
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

function base64ToUtf8(b64: string): string {
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

type BinaryValue = { '$content-type': string; '$content': string };

function makeBinary(b64: string, contentType = 'application/octet-stream'): BinaryValue {
  return { '$content-type': contentType, '$content': b64 };
}

// 100-ns ticks at the Unix epoch (1970-01-01T00:00:00Z) since 0001-01-01.
const TICKS_AT_EPOCH = 621355968000000000;

const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

// Shift a Date by an interval in PA-style time units (case-insensitive, optional 's').
function shiftTime(date: Date, interval: number, unit: string): Date {
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

function resolveTz(tz: string): string {
  return WIN_TO_IANA[tz] ?? tz;
}

// UTC offset in ms for `tz` at the given UTC moment (DST-aware via Intl).
function tzOffsetMs(utcDate: Date, tz: string): number {
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
function isoNoZone(d: Date): string {
  return d.toISOString().slice(0, 19);
}

// Parse a wall-clock timestamp as if it were UTC, so the wall-clock numbers
// (year/month/day/hour/min/sec) survive intact regardless of host timezone.
// Used by convertToUtc / convertTimeZone where the input is "wall clock in
// some source TZ" — JS would otherwise interpret naked ISO strings as host-local.
function parseAsUtc(ts: string): Date {
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

function parseXml(input: string): Document {
  return new DOMParser({ errorHandler: SILENT_XML_ERRORS }).parseFromString(input, 'text/xml') as unknown as Document;
}

// Convert an XPath result node into the value PA returns: serialized XML for
// element nodes, raw value for attribute/text nodes. Primitives pass through
// unchanged (xpath functions like count()/string()/sum() return JS primitives).
function serializeXPathResult(node: any): any {
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

function parseDataUri(uri: string): { contentType: string; content: string; isBase64: boolean } {
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
 * Navigate through an object using a path that may contain dot notation and bracket notation
 * Examples: .body.name, ['body/name'], .body['field'], ?['optional/field']
 * Note: ['body/name'] is treated as nested path ['body']['name']
 */
export function navigatePath(obj: any, pathExpr: string): any {
  if (!pathExpr) return obj;

  let val = obj;
  let remaining = pathExpr;

  // Handle optional chaining operator ?
  const isOptional = remaining.startsWith('?');
  if (isOptional) {
    remaining = remaining.substring(1);
  }

  // Parse the path expression
  while (remaining.length > 0) {
    // Handle bracket notation with quotes ['key'] or ["key"]
    const bracketMatch = remaining.match(/^\[['"]([^'"]+)['"]\](.*)/);
    if (bracketMatch) {
      const key = bracketMatch[1];
      // If key contains slashes, treat as nested path (Power Automate convention)
      if (key.includes('/')) {
        const parts = key.split('/');
        for (const part of parts) {
          val = val?.[part];
          if (val === undefined || val === null) break;
        }
      } else {
        val = val?.[key];
      }
      remaining = bracketMatch[2];
      continue;
    }

    // Handle bracket notation with numeric index [0], [1], etc.
    const numericBracketMatch = remaining.match(/^\[(\d+)\](.*)/);
    if (numericBracketMatch) {
      const index = parseInt(numericBracketMatch[1], 10);
      val = val?.[index];
      remaining = numericBracketMatch[2];
      continue;
    }

    // Handle optional chaining mid-path ?['key'] or ?.key
    if (remaining.startsWith('?')) {
      remaining = remaining.substring(1); // strip the ?, let next handler pick it up
      continue;
    }

    // Handle dot followed by bracket notation .['key'] or .["key"]
    if (remaining.startsWith('.[')) {
      remaining = remaining.substring(1); // strip the dot, let bracket handler pick it up
      continue;
    }

    // Handle dot notation .key
    const dotMatch = remaining.match(/^\.([A-Za-z_][\w]*)(.*)/);
    if (dotMatch) {
      const key = dotMatch[1];
      val = val?.[key];
      remaining = dotMatch[2];
      continue;
    }

    // If we can't parse, break
    break;
  }

  return val;
}

/**
 * Split function arguments by comma (respecting nested calls and strings)
 */
function splitArgs(argsStr: string): [string, string] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];

    if (!inString && (ch === '"' || ch === "'")) {
      inString = true;
      stringChar = ch;
      current += ch;
      continue;
    }

    if (inString && ch === stringChar && argsStr[i - 1] !== '\\') {
      // Check for doubled-quote escape (Power Automate uses '' to escape quotes)
      if (argsStr[i + 1] === stringChar) {
        current += ch + argsStr[i + 1];
        i++; // skip the second quote
        continue;
      }
      inString = false;
      current += ch;
      continue;
    }

    if (inString) {
      current += ch;
      continue;
    }

    if (ch === '(') depth++;
    if (ch === ')') depth--;

    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current) parts.push(current.trim());

  return [parts[0] || '', parts[1] || ''];
}

/**
 * Split function arguments by comma (multiple args, respecting nested calls and strings)
 */
function splitMultiArgs(argsStr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];

    if (!inString && (ch === '"' || ch === "'")) {
      inString = true;
      stringChar = ch;
      current += ch;
      continue;
    }

    if (inString && ch === stringChar && argsStr[i - 1] !== '\\') {
      // Check for doubled-quote escape (Power Automate uses '' to escape quotes)
      if (argsStr[i + 1] === stringChar) {
        current += ch + argsStr[i + 1];
        i++; // skip the second quote
        continue;
      }
      inString = false;
      current += ch;
      continue;
    }

    if (inString) {
      current += ch;
      continue;
    }

    if (ch === '(') depth++;
    if (ch === ')') depth--;

    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current) parts.push(current.trim());

  return parts;
}

/**
 * Format a number using a .NET-style numeric format string and a locale.
 * Supports standard specifiers (C, N, F, D, P, E, G, X) and basic custom
 * patterns made of '0', '#', '.', and ',' (e.g., '0.00', '#,##0.00').
 */
function formatNumberValue(value: number, format: string, locale: string): string {
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
 * Resolve a value (which might be a string literal, number, or expression)
 */
function resolveValue(v: string, ctx: RunContext): any {
  const t = v.trim();
  if (!t) return undefined;
  if (t.startsWith('@')) return evalExpression(t, ctx);
  if (t.startsWith('"') || t.startsWith("'")) {
    const quote = t[0];
    const raw = t.endsWith(quote) ? t.slice(1, -1) : t.slice(1);
    // Unescape doubled quotes (Power Automate uses '' or "" to represent a literal quote)
    return raw.split(quote + quote).join(quote);
  }
  if (!isNaN(Number(t))) return Number(t);
  if (t.toLowerCase() === 'true') return true;
  if (t.toLowerCase() === 'false') return false;
  return t;
}

/**
 * Get action data with case-insensitive lookup (matching Logic Apps behavior).
 */
function getActionData(ctx: RunContext, actionName: string): any {
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

/**
 * Main expression evaluator
 * Handles all Logic Apps expression functions
 */
export function evalExpression(expression: string, ctx: RunContext): any {
  if (!expression) return undefined;
  // Normalize whitespace: collapse multiple spaces/newlines into single spaces
  // This handles multi-line expressions like those from Power Automate
  const e = String(expression).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Handle string interpolation syntax @{expression}
  // In Logic Apps, @{...} converts the result to a string
  // For objects/arrays, Power Automate uses JSON.stringify, not JavaScript's String()
  if (e.startsWith('@{') && e.endsWith('}')) {
    const innerExpr = e.slice(2, -1).trim();
    const result = evalExpression('@' + innerExpr, ctx);
    if (result === null || result === undefined) return result;
    // Use JSON.stringify for objects/arrays to match Power Automate behavior
    if (typeof result === 'object') return JSON.stringify(result);
    return String(result);
  }

  // Literal booleans
  if (e === 'true' || e === '@true') return true;
  if (e === 'false' || e === '@false') return false;

  // Literal null/undefined
  if (e === 'null' || e === '@null') return null;
  if (e === 'undefined' || e === '@undefined') return undefined;

  let m: RegExpMatchArray | null;

  // Action reference functions (with property paths) - case-insensitive
  m = e.match(/^@?actions\(['"](.+?)['"]\)((?:\.[A-Za-z_][\w]*)*)$/i);
  if (m) {
    const actionName = m[1];
    const actionData = getActionData(ctx, actionName);
    if (!actionData) return undefined;
    let val: any = {
      name: actionName,
      status: actionData.status,
      outputs: actionData.outputs,
      error: actionData.error
    };
    const path = m[2] || '';
    if (path) {
      for (const seg of path.split('.').filter(Boolean)) {
        val = val?.[seg];
      }
    }
    return val;
  }

  // actionBody() — alias for body() per Logic Apps reference
  m = e.match(/^@?actionBody\(['"](.+?)['"]\)(.*)$/i);
  if (m) {
    const actionName = m[1];
    const actionData = getActionData(ctx, actionName);
    let val: any = actionData?.outputs;
    if (val !== null && typeof val === 'object' && 'body' in val) {
      val = val.body;
    }
    const pathExpr = m[2] || '';
    if (pathExpr) val = navigatePath(val, pathExpr);
    return val;
  }

  // action() — current (or most recently entered) action's metadata. Combines
  // ctx.currentAction (live: name, startTime, inputs) with ctx.actions (live
  // status & outputs) so the record reflects the post-execution state when
  // referenced from an Until condition.
  m = e.match(/^@?action\(\s*\)((?:\.[A-Za-z_][\w]*)*)$/i);
  if (m) {
    const cur = ctx.currentAction;
    if (!cur) return undefined;
    const stored = ctx.actions.get(cur.name);
    const fullRecord: Record<string, any> = {
      name: cur.name,
      inputs: cur.inputs,
      startTime: cur.startTime,
      endTime: cur.endTime,
      status: stored?.status ?? cur.status,
      outputs: stored?.outputs ?? cur.outputs,
    };
    const pathExpr = m[1] || '';
    if (pathExpr) return navigatePath(fullRecord, pathExpr);
    return fullRecord;
  }

  // iterationIndexes('<loopName>') — index of the named enclosing loop.
  // Walks ctx.iterationStack from innermost outward.
  m = e.match(/^@?iterationIndexes\(['"](.+?)['"]\)$/i);
  if (m) {
    const loopName = m[1];
    const stack = ctx.iterationStack ?? [];
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].loopName === loopName) return stack[i].index;
    }
    // Fallback: legacy single iterationInfo (covers tests that set it manually).
    if (ctx.iterationInfo?.loopName === loopName) return ctx.iterationInfo.index;
    return undefined;
  }

  // listCallbackUrl() — returns the trigger's invocation URL. Pre-resolved by
  // the host (CLI/web) and stashed on ctx.callbackUrl. Returns '' when the
  // host could not (or did not need to) fetch it.
  m = e.match(/^@?listCallbackUrl\(\s*\)$/i);
  if (m) return ctx.callbackUrl ?? '';

  // result('<scopedActionName>') — array of child action results within a
  // scope/foreach/until. For loops, results from all iterations are concatenated.
  m = e.match(/^@?result\(['"](.+?)['"]\)((?:\.[A-Za-z_][\w]*)*)$/i);
  if (m) {
    const scopeName = m[1];
    const arr = ctx.scopeResults?.get(scopeName) ?? [];
    const pathExpr = m[2] || '';
    if (pathExpr) return navigatePath(arr, pathExpr);
    return arr;
  }

  // body() function - returns the body portion of an action's output (case-insensitive)
  // In Power Automate, body('ActionName') is shorthand for outputs('ActionName')?['body']
  // For actions that store output with { body: ... } structure, extract the body
  // For actions that store output directly (like Compose), return the output as-is
  m = e.match(/^@?body\(['"](.+?)['"]\)(.*)$/i);
  if (m) {
    const actionName = m[1];
    const actionData = getActionData(ctx, actionName);
    let val: any = actionData?.outputs;

    // If outputs has a 'body' property, extract it (Power Automate compatibility)
    // This handles HTTP actions, connector actions, etc. that return { statusCode, headers, body }
    if (val !== null && typeof val === 'object' && 'body' in val) {
      val = val.body;
    }
    // Otherwise, return outputs directly (for Compose, ParseJSON, etc.)

    const pathExpr = m[2] || '';
    if (pathExpr) {
      val = navigatePath(val, pathExpr);
    }
    return val;
  }

  // outputs() function - returns the full output structure of an action (case-insensitive)
  // In Power Automate, this includes statusCode, headers, body for HTTP actions
  m = e.match(/^@?outputs\(['"](.+?)['"]\)(.*)$/i);
  if (m) {
    const actionName = m[1];
    const actionData = getActionData(ctx, actionName);
    let val: any = actionData?.outputs;
    const pathExpr = m[2] || '';

    if (pathExpr) {
      val = navigatePath(val, pathExpr);
    }
    return val;
  }

  // item() function - used in loops (foreach) and data operations (select, filter)
  m = e.match(/^@?item\(\s*\)(.*)$/i);
  if (m) {
    let val: any = ctx.variables['item'];
    const pathExpr = m[1] || '';
    if (pathExpr) {
      val = navigatePath(val, pathExpr);
    }
    return val;
  }

  // Trigger reference functions (with property paths)
  m = e.match(/^@?trigger\(\s*\)((?:\.[A-Za-z_][\w]*)*)$/i);
  if (m) {
    // Extract body if present in triggerData (Power Automate compatibility)
    const triggerBody = (ctx.triggerData !== null && typeof ctx.triggerData === 'object' && 'body' in ctx.triggerData)
      ? ctx.triggerData.body
      : ctx.triggerData;

    let val: any = {
      outputs: ctx.triggerData,
      body: triggerBody
    };
    const path = m[1] || '';
    if (path) {
      for (const seg of path.split('.').filter(Boolean)) {
        val = val?.[seg];
      }
    }
    return val;
  }

  m = e.match(/^@?triggerBody\(\s*\)(.*)$/i);
  if (m) {
    let val: any = ctx.triggerData;

    // If triggerData has a 'body' property, extract it (Power Automate compatibility)
    // This handles HTTP triggers, connector triggers, etc. that return { statusCode, headers, body }
    // triggerBody() is shorthand for triggerOutputs()?['body']
    if (val !== null && typeof val === 'object' && 'body' in val) {
      val = val.body;
    }
    // Otherwise, return triggerData directly (for triggers that don't wrap in body)

    const pathExpr = m[1] || '';
    if (pathExpr) {
      val = navigatePath(val, pathExpr);
    }
    return val;
  }

  m = e.match(/^@?triggerOutputs\(\s*\)(.*)$/i);
  if (m) {
    let val: any = ctx.triggerData;
    const pathExpr = m[1] || '';
    if (pathExpr) {
      val = navigatePath(val, pathExpr);
    }
    return val;
  }

  // Workflow reference functions
  m = e.match(/^@?workflow\(\s*\)((?:\.[A-Za-z_][\w]*)*)$/i);
  if (m) {
    let val: any = {
      name: ctx.workflowName,
      id: 'local-run',
      run: {
        name: 'local-run',
        id: 'local-run'
      }
    };
    const path = m[1];
    if (path) {
      for (const seg of path.split('.').filter(Boolean)) {
        val = val?.[seg];
      }
    }
    return val;
  }

  // Parameters function - access workflow parameters
  m = e.match(/^@?parameters\(['"](.+?)['"]\)((?:\.[A-Za-z_][\w]*)*)$/i);
  if (m) {
    const paramName = m[1];
    let val: any = ctx.parameters?.[paramName];
    // If the parameter is an object with defaultValue (parameter definition), use the defaultValue
    if (val && typeof val === 'object' && 'defaultValue' in val) {
      val = val.defaultValue;
    }
    const path = m[2] || '';
    if (path) {
      for (const seg of path.split('.').filter(Boolean)) {
        val = val?.[seg];
      }
    }
    return val;
  }

  // Variables (case-insensitive to match Logic Apps behavior)
  m = e.match(/^@?variables\(['"](.+?)['"]\)$/i);
  if (m) {
    const varName = m[1];
    // Try exact match first (fast path)
    if (varName in ctx.variables) {
      return ctx.variables[varName];
    }
    // Fall back to case-insensitive search
    const lowerVarName = varName.toLowerCase();
    for (const key in ctx.variables) {
      if (key.toLowerCase() === lowerVarName) {
        return ctx.variables[key];
      }
    }
    return undefined;
  }

  // ForEach items() function - returns the current iteration item
  // In Logic Apps, items('loopName') returns the current item being processed in the loop
  // The engine stores this in ctx.variables[loopName] during foreach iteration
  m = e.match(/^@?items\(['"](.+?)['"]\)(.*)$/i);
  if (m) {
    const loopName = m[1];
    let val = ctx.variables[loopName];
    const pathExpr = m[2] || '';

    // Debug logging for troubleshooting
    if (val === undefined) {
      console.warn(`[items] Warning: No current item found for loop '${loopName}'. Available variables:`, Object.keys(ctx.variables));
    }

    if (pathExpr) {
      const beforeNav = val;
      val = navigatePath(val, pathExpr);
      if (val === undefined && beforeNav !== undefined) {
        console.warn(`[items] Warning: Property navigation failed for path '${pathExpr}' on item:`, beforeNav);
      }
    }
    return val;
  }

  // Comparison functions
  // Power Automate uses loose equality for equals() - numbers and their string representations are equal
  // e.g., equals(101, string(101)) returns true
  m = e.match(/^@?equals\((.*)\)$/i);
  if (m) {
    const [a,b]=splitArgs(m[1]);
    const aVal = evalExpression(a,ctx);
    const bVal = evalExpression(b,ctx);
    // Use loose equality (==) instead of strict (===) to handle type coercion like Power Automate
    // eslint-disable-next-line eqeqeq
    return aVal == bVal;
  }

  // Logical functions
  m = e.match(/^@?and\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[1]); return Boolean(evalExpression(a,ctx)) && Boolean(evalExpression(b,ctx)); }
  m = e.match(/^@?or\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[1]); return Boolean(evalExpression(a,ctx)) || Boolean(evalExpression(b,ctx)); }
  m = e.match(/^@?not\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); return !Boolean(evalExpression(a,ctx)); }

  // Numeric comparison
  m = e.match(/^@?greater\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[1]); return Number(evalExpression(a,ctx)) > Number(evalExpression(b,ctx)); }
  m = e.match(/^@?less\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[1]); return Number(evalExpression(a,ctx)) < Number(evalExpression(b,ctx)); }
  m = e.match(/^@?(greaterOrEquals|ge)\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[2]); return Number(evalExpression(a,ctx)) >= Number(evalExpression(b,ctx)); }
  m = e.match(/^@?(lessOrEquals|le)\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[2]); return Number(evalExpression(a,ctx)) <= Number(evalExpression(b,ctx)); }

  // String functions
  m = e.match(/^@?contains\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[1]); const c=evalExpression(a,ctx); const v=evalExpression(b,ctx); return typeof c==='string'? c.includes(String(v)) : Array.isArray(c)? c.includes(v) : false; }
  m = e.match(/^@?startsWith\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[1]); const s=String(evalExpression(a,ctx) ?? ''); const p=String(evalExpression(b,ctx) ?? ''); return s.startsWith(p); }
  m = e.match(/^@?endsWith\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[1]); const s=String(evalExpression(a,ctx) ?? ''); const p=String(evalExpression(b,ctx) ?? ''); return s.endsWith(p); }
  m = e.match(/^@?concat\((.*)\)$/i);
  if (m) { const args=splitMultiArgs(m[1]); return args.map(a => String(evalExpression(a,ctx) ?? '')).join(''); }
  m = e.match(/^@?substring\((.*)\)$/i);
  if (m) { const [str,start,len]=splitMultiArgs(m[1]); const s=String(evalExpression(str,ctx) ?? ''); const st=Number(evalExpression(start,ctx)); const l=len ? Number(evalExpression(len,ctx)) : undefined; return l !== undefined ? s.substring(st, st+l) : s.substring(st); }
  m = e.match(/^@?replace\((.*)\)$/i);
  if (m) { const [str,old,newVal]=splitMultiArgs(m[1]); const s=String(evalExpression(str,ctx) ?? ''); const o=String(evalExpression(old,ctx)); const n=String(evalExpression(newVal,ctx)); const escaped = o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return s.replace(new RegExp(escaped, 'g'), n); }
  m = e.match(/^@?toLower\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); return String(evalExpression(a,ctx) ?? '').toLowerCase(); }
  m = e.match(/^@?toUpper\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); return String(evalExpression(a,ctx) ?? '').toUpperCase(); }
  m = e.match(/^@?trim\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); return String(evalExpression(a,ctx) ?? '').trim(); }
  m = e.match(/^@?split\((.*)\)$/i);
  if (m) { const [str,delim]=splitArgs(m[1]); const s=String(evalExpression(str,ctx) ?? ''); const d=String(evalExpression(delim,ctx)); return s.split(d); }
  m = e.match(/^@?join\((.*)\)$/i);
  if (m) { const [arr,delim]=splitArgs(m[1]); const a=evalExpression(arr,ctx); const d=String(evalExpression(delim,ctx) ?? ','); return Array.isArray(a) ? a.join(d) : ''; }

  // Additional string functions
  m = e.match(/^@?indexOf\((.*)\)$/i);
  if (m) { const [str,search]=splitArgs(m[1]); const s=String(evalExpression(str,ctx) ?? ''); const srch=String(evalExpression(search,ctx)); return s.indexOf(srch); }
  m = e.match(/^@?lastIndexOf\((.*)\)$/i);
  if (m) { const [str,search]=splitArgs(m[1]); const s=String(evalExpression(str,ctx) ?? ''); const srch=String(evalExpression(search,ctx)); return s.lastIndexOf(srch); }
  m = e.match(/^@?guid\(\s*\)$/i);
  if (m) { return crypto.randomUUID(); }
  m = e.match(/^@?base64\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const s=String(evalExpression(a,ctx) ?? ''); return utf8ToBase64(s); }
  m = e.match(/^@?base64ToString\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const s=String(evalExpression(a,ctx) ?? ''); return base64ToUtf8(s); }
  m = e.match(/^@?uriComponent\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const s=String(evalExpression(a,ctx) ?? ''); return encodeURIComponent(s); }
  m = e.match(/^@?uriComponentToString\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const s=String(evalExpression(a,ctx) ?? ''); return decodeURIComponent(s); }
  m = e.match(/^@?decodeBase64\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const s=String(evalExpression(a,ctx) ?? ''); return base64ToUtf8(s); }
  m = e.match(/^@?decodeUriComponent\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const s=String(evalExpression(a,ctx) ?? ''); return decodeURIComponent(s); }
  m = e.match(/^@?encodeUriComponent\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const s=String(evalExpression(a,ctx) ?? ''); return encodeURIComponent(s); }
  m = e.match(/^@?xml\((.*)\)$/i);
  if (m) {
    const [a] = splitArgs(m[1]);
    const v = evalExpression(a, ctx);
    if (typeof v !== 'string') return JSON.stringify(v);
    // Parse & re-serialize so the output is canonical XML (matches PA: xml()
    // returns an XML node, which serializes deterministically). Falls back to
    // the original string if parsing fails so callers can still pipe it on.
    try {
      const doc = parseXml(v);
      return new XMLSerializer().serializeToString(doc);
    } catch {
      return v;
    }
  }
  m = e.match(/^@?xpath\((.*)\)$/i);
  if (m) {
    const [xArg, pArg] = splitArgs(m[1]);
    const xmlInput = evalExpression(xArg, ctx);
    const xpathExpr = String(evalExpression(pArg, ctx));
    if (typeof xmlInput !== 'string' || !xmlInput) return [];
    let doc: Document;
    try {
      doc = parseXml(xmlInput);
    } catch (err) {
      throw new Error(`xpath: failed to parse XML input: ${err instanceof Error ? err.message : String(err)}`);
    }
    let result: any;
    try {
      result = xpathLib.select(xpathExpr, doc as any);
    } catch (err) {
      throw new Error(`xpath: invalid XPath expression '${xpathExpr}': ${err instanceof Error ? err.message : String(err)}`);
    }
    // Node-set queries return an array; numeric/string/boolean queries
    // (count(), string(), sum(), etc.) return primitives directly.
    if (Array.isArray(result)) return result.map(serializeXPathResult);
    return result;
  }
  m = e.match(/^@?dataUri\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const s=String(evalExpression(a,ctx) ?? ''); return `data:text/plain;charset=utf-8;base64,${utf8ToBase64(s)}`; }
  m = e.match(/^@?dataUriToString\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const s=String(evalExpression(a,ctx) ?? ''); const p=parseDataUri(s); return p.isBase64 ? base64ToUtf8(p.content) : decodeURIComponent(p.content); }
  m = e.match(/^@?base64ToBinary\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const s=String(evalExpression(a,ctx) ?? ''); return makeBinary(s); }
  m = e.match(/^@?binary\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const v=evalExpression(a,ctx); const s=typeof v==='string' ? v : JSON.stringify(v); return makeBinary(utf8ToBase64(s)); }
  m = e.match(/^@?dataUriToBinary\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const s=String(evalExpression(a,ctx) ?? ''); const p=parseDataUri(s); const b64=p.isBase64 ? p.content : utf8ToBase64(decodeURIComponent(p.content)); return makeBinary(b64, p.contentType); }
  m = e.match(/^@?decodeDataUri\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const s=String(evalExpression(a,ctx) ?? ''); const p=parseDataUri(s); const b64=p.isBase64 ? p.content : utf8ToBase64(decodeURIComponent(p.content)); return makeBinary(b64, p.contentType); }
  m = e.match(/^@?uriComponentToBinary\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const s=String(evalExpression(a,ctx) ?? ''); return makeBinary(utf8ToBase64(decodeURIComponent(s))); }

  // Collection functions
  m = e.match(/^@?length\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const v=evalExpression(a,ctx); return Array.isArray(v) || typeof v==='string' ? (v as any).length : 0; }
  m = e.match(/^@?empty\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const v=evalExpression(a,ctx); return v===undefined || v===null || (typeof v==='string' && v.length===0) || (Array.isArray(v) && v.length===0); }
  m = e.match(/^@?first\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const v=evalExpression(a,ctx); return Array.isArray(v) && v.length > 0 ? v[0] : typeof v==='string' && v.length > 0 ? v[0] : undefined; }
  m = e.match(/^@?last\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const v=evalExpression(a,ctx); return Array.isArray(v) && v.length > 0 ? v[v.length-1] : typeof v==='string' && v.length > 0 ? v[v.length-1] : undefined; }
  m = e.match(/^@?skip\((.*)\)$/i);
  if (m) { const [arr,count]=splitArgs(m[1]); const a=evalExpression(arr,ctx); const c=Number(evalExpression(count,ctx)); return Array.isArray(a) ? a.slice(c) : []; }
  m = e.match(/^@?take\((.*)\)$/i);
  if (m) { const [arr,count]=splitArgs(m[1]); const a=evalExpression(arr,ctx); const c=Number(evalExpression(count,ctx)); return Array.isArray(a) ? a.slice(0, c) : []; }
  m = e.match(/^@?union\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[1]); const av=evalExpression(a,ctx); const bv=evalExpression(b,ctx); return Array.isArray(av) && Array.isArray(bv) ? [...new Set([...av, ...bv])] : []; }
  m = e.match(/^@?intersection\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[1]); const av=evalExpression(a,ctx); const bv=evalExpression(b,ctx); return Array.isArray(av) && Array.isArray(bv) ? av.filter(x => bv.includes(x)) : []; }

  // Additional collection functions
  m = e.match(/^@?createArray\((.*)\)$/i);
  if (m) { const args=splitMultiArgs(m[1]); return args.map(a => evalExpression(a,ctx)); }
  m = e.match(/^@?range\((.*)\)$/i);
  if (m) { const [start,count]=splitArgs(m[1]); const st=Number(evalExpression(start,ctx)); const ct=Number(evalExpression(count,ctx)); return Array.from({length: ct}, (_, i) => st + i); }

  // Math functions
  m = e.match(/^@?add\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[1]); return Number(evalExpression(a,ctx)) + Number(evalExpression(b,ctx)); }
  m = e.match(/^@?sub\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[1]); return Number(evalExpression(a,ctx)) - Number(evalExpression(b,ctx)); }
  m = e.match(/^@?mul\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[1]); return Number(evalExpression(a,ctx)) * Number(evalExpression(b,ctx)); }
  m = e.match(/^@?div\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[1]); return Number(evalExpression(a,ctx)) / Number(evalExpression(b,ctx)); }
  m = e.match(/^@?mod\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[1]); return Number(evalExpression(a,ctx)) % Number(evalExpression(b,ctx)); }
  m = e.match(/^@?min\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[1]); return Math.min(Number(evalExpression(a,ctx)), Number(evalExpression(b,ctx))); }
  m = e.match(/^@?max\((.*)\)$/i);
  if (m) { const [a,b]=splitArgs(m[1]); return Math.max(Number(evalExpression(a,ctx)), Number(evalExpression(b,ctx))); }
  m = e.match(/^@?rand\((.*)\)$/i);
  if (m) { const [min,max]=splitArgs(m[1]); const minV=Number(evalExpression(min,ctx)); const maxV=Number(evalExpression(max,ctx)); return Math.floor(Math.random() * (maxV - minV + 1)) + minV; }

  // Additional math functions
  m = e.match(/^@?int\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); return Math.trunc(Number(evalExpression(a,ctx))); }
  m = e.match(/^@?float\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); return parseFloat(String(evalExpression(a,ctx))); }
  m = e.match(/^@?abs\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); return Math.abs(Number(evalExpression(a,ctx))); }
  m = e.match(/^@?ceil\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); return Math.ceil(Number(evalExpression(a,ctx))); }
  m = e.match(/^@?floor\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); return Math.floor(Number(evalExpression(a,ctx))); }
  m = e.match(/^@?round\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); return Math.round(Number(evalExpression(a,ctx))); }

  // formatNumber - format a number using a .NET numeric format string and optional locale
  m = e.match(/^@?formatNumber\((.*)\)$/i);
  if (m) {
    const args = splitMultiArgs(m[1]);
    const value = Number(evalExpression(args[0], ctx));
    const format = args[1] ? String(evalExpression(args[1], ctx)) : 'G';
    const locale = args[2] ? String(evalExpression(args[2], ctx)) : 'en-US';
    return formatNumberValue(value, format, locale);
  }

  // Date/time functions
  m = e.match(/^@?utcNow\(\s*\)$/i);
  if (m) return ctx.now().toISOString();

  // parseDateTime - parse a string into a date/time
  // In Power Automate: parseDateTime(timestamp, locale?, format?)
  m = e.match(/^@?parseDateTime\((.*)\)$/i);
  if (m) {
    const args = splitMultiArgs(m[1]);
    const timestamp = evalExpression(args[0], ctx);
    const locale = args[1] ? String(evalExpression(args[1], ctx)) : undefined;
    // const format = args[2] ? String(evalExpression(args[2], ctx)) : undefined;

    if (timestamp === null || timestamp === undefined) return null;

    // Handle locale-specific date parsing
    // For 'de-DE' locale, dates might be in DD.MM.YYYY format
    let dateStr = String(timestamp);

    if (locale === 'de-DE' && /^\d{1,2}\.\d{1,2}\.\d{4}/.test(dateStr)) {
      // German format: DD.MM.YYYY -> convert to ISO
      const parts = dateStr.split('.');
      if (parts.length >= 3) {
        const day = parts[0].padStart(2, '0');
        const month = parts[1].padStart(2, '0');
        const yearPart = parts[2].split(/\s/)[0]; // Handle "DD.MM.YYYY HH:mm" format
        const timePart = dateStr.includes(' ') ? dateStr.split(' ').slice(1).join(' ') : '';
        dateStr = `${yearPart}-${month}-${day}${timePart ? 'T' + timePart : ''}`;
      }
    }

    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      // If parsing fails, try with locale-aware parsing
      try {
        const parsed = new Date(timestamp);
        if (!isNaN(parsed.getTime())) {
          return parsed.toISOString();
        }
      } catch {
        // Return null for invalid dates
      }
      return null;
    }
    return date.toISOString();
  }

  // formatDateTime - format a date/time string
  m = e.match(/^@?formatDateTime\((.*)\)$/i);
  if (m) {
    const args = splitMultiArgs(m[1]);
    const timestamp = evalExpression(args[0], ctx);
    const format = args[1] ? String(evalExpression(args[1], ctx)) : undefined;

    if (timestamp === null || timestamp === undefined) return '';

    const date = new Date(String(timestamp));
    if (isNaN(date.getTime())) return '';

    if (!format) return date.toISOString();

    // Basic format string support (Power Automate uses .NET format strings)
    let result = format;
    result = result.replace(/yyyy/g, String(date.getUTCFullYear()));
    result = result.replace(/yy/g, String(date.getUTCFullYear()).slice(-2));
    result = result.replace(/MM/g, String(date.getUTCMonth() + 1).padStart(2, '0'));
    result = result.replace(/M/g, String(date.getUTCMonth() + 1));
    result = result.replace(/dd/g, String(date.getUTCDate()).padStart(2, '0'));
    result = result.replace(/d/g, String(date.getUTCDate()));
    result = result.replace(/HH/g, String(date.getUTCHours()).padStart(2, '0'));
    result = result.replace(/H/g, String(date.getUTCHours()));
    result = result.replace(/mm/g, String(date.getUTCMinutes()).padStart(2, '0'));
    result = result.replace(/m/g, String(date.getUTCMinutes()));
    result = result.replace(/ss/g, String(date.getUTCSeconds()).padStart(2, '0'));
    result = result.replace(/s/g, String(date.getUTCSeconds()));
    return result;
  }

  // addDays - add days to a timestamp
  m = e.match(/^@?addDays\((.*)\)$/i);
  if (m) {
    const args = splitMultiArgs(m[1]);
    const timestamp = evalExpression(args[0], ctx);
    const days = Number(evalExpression(args[1], ctx));
    const format = args[2] ? String(evalExpression(args[2], ctx)) : undefined;

    if (timestamp === null || timestamp === undefined) return null;
    const date = new Date(String(timestamp));
    if (isNaN(date.getTime())) return null;

    date.setUTCDate(date.getUTCDate() + days);

    if (format) {
      // Use formatDateTime logic
      return evalExpression(`@formatDateTime('${date.toISOString()}', '${format}')`, ctx);
    }
    return date.toISOString();
  }

  // addHours - add hours to a timestamp
  m = e.match(/^@?addHours\((.*)\)$/i);
  if (m) {
    const args = splitMultiArgs(m[1]);
    const timestamp = evalExpression(args[0], ctx);
    const hours = Number(evalExpression(args[1], ctx));
    const format = args[2] ? String(evalExpression(args[2], ctx)) : undefined;

    if (timestamp === null || timestamp === undefined) return null;
    const date = new Date(String(timestamp));
    if (isNaN(date.getTime())) return null;

    date.setUTCHours(date.getUTCHours() + hours);

    if (format) {
      return evalExpression(`@formatDateTime('${date.toISOString()}', '${format}')`, ctx);
    }
    return date.toISOString();
  }

  // addMinutes - add minutes to a timestamp
  m = e.match(/^@?addMinutes\((.*)\)$/i);
  if (m) {
    const args = splitMultiArgs(m[1]);
    const timestamp = evalExpression(args[0], ctx);
    const minutes = Number(evalExpression(args[1], ctx));
    const format = args[2] ? String(evalExpression(args[2], ctx)) : undefined;

    if (timestamp === null || timestamp === undefined) return null;
    const date = new Date(String(timestamp));
    if (isNaN(date.getTime())) return null;

    date.setUTCMinutes(date.getUTCMinutes() + minutes);

    if (format) {
      return evalExpression(`@formatDateTime('${date.toISOString()}', '${format}')`, ctx);
    }
    return date.toISOString();
  }

  // addSeconds - add seconds to a timestamp
  m = e.match(/^@?addSeconds\((.*)\)$/i);
  if (m) {
    const args = splitMultiArgs(m[1]);
    const timestamp = evalExpression(args[0], ctx);
    const seconds = Number(evalExpression(args[1], ctx));
    const format = args[2] ? String(evalExpression(args[2], ctx)) : undefined;

    if (timestamp === null || timestamp === undefined) return null;
    const date = new Date(String(timestamp));
    if (isNaN(date.getTime())) return null;

    date.setUTCSeconds(date.getUTCSeconds() + seconds);

    if (format) {
      return evalExpression(`@formatDateTime('${date.toISOString()}', '${format}')`, ctx);
    }
    return date.toISOString();
  }

  // JSON functions
  m = e.match(/^@?json\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const s=evalExpression(a,ctx); return typeof s ==='string' ? JSON.parse(s) : s; }
  m = e.match(/^@?string\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const v=evalExpression(a,ctx); return typeof v==='string' ? v : JSON.stringify(v); }

  // Conditional functions
  m = e.match(/^@?if\((.*)\)$/i);
  if (m) { const [cond,trueVal,falseVal]=splitMultiArgs(m[1]); return evalExpression(cond,ctx) ? evalExpression(trueVal,ctx) : evalExpression(falseVal,ctx); }
  m = e.match(/^@?coalesce\((.*)\)$/i);
  if (m) { const args=splitMultiArgs(m[1]); for(const arg of args){ const v=evalExpression(arg,ctx); if(v!==null && v!==undefined) return v; } return undefined; }

  // Type conversion / inspection
  m = e.match(/^@?array\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); return [evalExpression(a,ctx)]; }
  m = e.match(/^@?bool\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const v=evalExpression(a,ctx);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.toLowerCase() === 'true';
    if (typeof v === 'number') return v !== 0;
    return Boolean(v);
  }
  m = e.match(/^@?decimal\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); return Number(evalExpression(a,ctx)); }
  m = e.match(/^@?isFloat\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const s=String(evalExpression(a,ctx) ?? '').trim();
    return /^-?\d+\.\d+$/.test(s) && !isNaN(Number(s));
  }
  m = e.match(/^@?isInt\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); const s=String(evalExpression(a,ctx) ?? '').trim();
    return /^-?\d+$/.test(s) && Number.isInteger(Number(s));
  }
  m = e.match(/^@?nthIndexOf\((.*)\)$/i);
  if (m) { const [tArg, sArg, nArg] = splitMultiArgs(m[1]);
    const t = String(evalExpression(tArg, ctx) ?? '');
    const s = String(evalExpression(sArg, ctx) ?? '');
    const n = Number(evalExpression(nArg, ctx));
    if (n < 1 || s === '') return -1;
    let idx = -1, count = 0, pos = 0;
    while (count < n) {
      idx = t.indexOf(s, pos);
      if (idx === -1) return -1;
      count++;
      pos = idx + 1;
    }
    return idx;
  }

  // Collection helpers
  m = e.match(/^@?chunk\((.*)\)$/i);
  if (m) { const [aArg, sArg] = splitArgs(m[1]);
    const arr = evalExpression(aArg, ctx);
    const size = Number(evalExpression(sArg, ctx));
    if (!Array.isArray(arr) || size <= 0) return [];
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }
  m = e.match(/^@?slice\((.*)\)$/i);
  if (m) { const args = splitMultiArgs(m[1]);
    const v = evalExpression(args[0], ctx);
    const start = Number(evalExpression(args[1], ctx));
    const end = args.length >= 3 ? Number(evalExpression(args[2], ctx)) : undefined;
    if (typeof v === 'string') return v.slice(start, end);
    if (Array.isArray(v)) return v.slice(start, end);
    return v;
  }
  m = e.match(/^@?sort\((.*)\)$/i);
  if (m) { const args = splitMultiArgs(m[1]);
    const arr = evalExpression(args[0], ctx);
    if (!Array.isArray(arr)) return arr;
    if (args.length >= 2) {
      const key = String(evalExpression(args[1], ctx));
      return [...arr].sort((a, b) => {
        const av = a?.[key], bv = b?.[key];
        if (av === bv) return 0;
        if (av === undefined || av === null) return -1;
        if (bv === undefined || bv === null) return 1;
        return av < bv ? -1 : 1;
      });
    }
    return [...arr].sort((a, b) => {
      if (a === b) return 0;
      return a < b ? -1 : 1;
    });
  }
  m = e.match(/^@?reverse\((.*)\)$/i);
  if (m) { const [a] = splitArgs(m[1]);
    const v = evalExpression(a, ctx);
    if (Array.isArray(v)) return [...v].reverse();
    if (typeof v === 'string') return v.split('').reverse().join('');
    return v;
  }

  // Object property functions
  m = e.match(/^@?addProperty\((.*)\)$/i);
  if (m) { const [oArg, nArg, vArg] = splitMultiArgs(m[1]);
    const o = evalExpression(oArg, ctx);
    const n = String(evalExpression(nArg, ctx));
    const v = evalExpression(vArg, ctx);
    if (typeof o !== 'object' || o === null || Array.isArray(o)) {
      throw new Error(`addProperty: first argument must be an object`);
    }
    if (n in o) {
      throw new Error(`addProperty: property '${n}' already exists; use setProperty() to update`);
    }
    return { ...o, [n]: v };
  }
  m = e.match(/^@?setProperty\((.*)\)$/i);
  if (m) { const [oArg, nArg, vArg] = splitMultiArgs(m[1]);
    const o = evalExpression(oArg, ctx);
    const n = String(evalExpression(nArg, ctx));
    const v = evalExpression(vArg, ctx);
    if (typeof o !== 'object' || o === null || Array.isArray(o)) {
      throw new Error(`setProperty: first argument must be an object`);
    }
    return { ...o, [n]: v };
  }
  m = e.match(/^@?removeProperty\((.*)\)$/i);
  if (m) { const [oArg, nArg] = splitArgs(m[1]);
    const o = evalExpression(oArg, ctx);
    const n = String(evalExpression(nArg, ctx));
    if (typeof o !== 'object' || o === null || Array.isArray(o)) {
      throw new Error(`removeProperty: first argument must be an object`);
    }
    const result = { ...o } as Record<string, any>;
    delete result[n];
    return result;
  }

  // Date/time — components & boundaries
  m = e.match(/^@?ticks\((.*)\)$/i);
  if (m) { const [a] = splitArgs(m[1]);
    const d = new Date(String(evalExpression(a, ctx) ?? ''));
    if (isNaN(d.getTime())) return 0;
    return TICKS_AT_EPOCH + d.getTime() * 10000;
  }
  m = e.match(/^@?dayOfMonth\((.*)\)$/i);
  if (m) { const [a] = splitArgs(m[1]);
    const d = new Date(String(evalExpression(a, ctx) ?? ''));
    return isNaN(d.getTime()) ? null : d.getUTCDate();
  }
  m = e.match(/^@?dayOfWeek\((.*)\)$/i);
  if (m) { const [a] = splitArgs(m[1]);
    const d = new Date(String(evalExpression(a, ctx) ?? ''));
    return isNaN(d.getTime()) ? null : d.getUTCDay();
  }
  m = e.match(/^@?dayOfYear\((.*)\)$/i);
  if (m) { const [a] = splitArgs(m[1]);
    const d = new Date(String(evalExpression(a, ctx) ?? ''));
    if (isNaN(d.getTime())) return null;
    const start = Date.UTC(d.getUTCFullYear(), 0, 1);
    return Math.floor((d.getTime() - start) / 86_400_000) + 1;
  }
  m = e.match(/^@?startOfDay\((.*)\)$/i);
  if (m) { const args = splitMultiArgs(m[1]);
    const d = new Date(String(evalExpression(args[0], ctx) ?? ''));
    if (isNaN(d.getTime())) return null;
    d.setUTCHours(0, 0, 0, 0);
    if (args.length >= 2) {
      const fmt = String(evalExpression(args[1], ctx));
      return evalExpression(`@formatDateTime('${d.toISOString()}', '${fmt}')`, ctx);
    }
    return d.toISOString();
  }
  m = e.match(/^@?startOfHour\((.*)\)$/i);
  if (m) { const args = splitMultiArgs(m[1]);
    const d = new Date(String(evalExpression(args[0], ctx) ?? ''));
    if (isNaN(d.getTime())) return null;
    d.setUTCMinutes(0, 0, 0);
    if (args.length >= 2) {
      const fmt = String(evalExpression(args[1], ctx));
      return evalExpression(`@formatDateTime('${d.toISOString()}', '${fmt}')`, ctx);
    }
    return d.toISOString();
  }
  m = e.match(/^@?startOfMonth\((.*)\)$/i);
  if (m) { const args = splitMultiArgs(m[1]);
    const d = new Date(String(evalExpression(args[0], ctx) ?? ''));
    if (isNaN(d.getTime())) return null;
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    if (args.length >= 2) {
      const fmt = String(evalExpression(args[1], ctx));
      return evalExpression(`@formatDateTime('${d.toISOString()}', '${fmt}')`, ctx);
    }
    return d.toISOString();
  }

  // Date/time — arithmetic
  m = e.match(/^@?addToTime\((.*)\)$/i);
  if (m) { const args = splitMultiArgs(m[1]);
    const d = new Date(String(evalExpression(args[0], ctx) ?? ''));
    if (isNaN(d.getTime())) return null;
    const interval = Number(evalExpression(args[1], ctx));
    const unit = String(evalExpression(args[2], ctx));
    const result = shiftTime(d, interval, unit);
    if (args.length >= 4) {
      const fmt = String(evalExpression(args[3], ctx));
      return evalExpression(`@formatDateTime('${result.toISOString()}', '${fmt}')`, ctx);
    }
    return result.toISOString();
  }
  m = e.match(/^@?subtractFromTime\((.*)\)$/i);
  if (m) { const args = splitMultiArgs(m[1]);
    const d = new Date(String(evalExpression(args[0], ctx) ?? ''));
    if (isNaN(d.getTime())) return null;
    const interval = Number(evalExpression(args[1], ctx));
    const unit = String(evalExpression(args[2], ctx));
    const result = shiftTime(d, -interval, unit);
    if (args.length >= 4) {
      const fmt = String(evalExpression(args[3], ctx));
      return evalExpression(`@formatDateTime('${result.toISOString()}', '${fmt}')`, ctx);
    }
    return result.toISOString();
  }
  m = e.match(/^@?getFutureTime\((.*)\)$/i);
  if (m) { const args = splitMultiArgs(m[1]);
    const interval = Number(evalExpression(args[0], ctx));
    const unit = String(evalExpression(args[1], ctx));
    const result = shiftTime(ctx.now(), interval, unit);
    if (args.length >= 3) {
      const fmt = String(evalExpression(args[2], ctx));
      return evalExpression(`@formatDateTime('${result.toISOString()}', '${fmt}')`, ctx);
    }
    return result.toISOString();
  }
  m = e.match(/^@?getPastTime\((.*)\)$/i);
  if (m) { const args = splitMultiArgs(m[1]);
    const interval = Number(evalExpression(args[0], ctx));
    const unit = String(evalExpression(args[1], ctx));
    const result = shiftTime(ctx.now(), -interval, unit);
    if (args.length >= 3) {
      const fmt = String(evalExpression(args[2], ctx));
      return evalExpression(`@formatDateTime('${result.toISOString()}', '${fmt}')`, ctx);
    }
    return result.toISOString();
  }
  m = e.match(/^@?dateDifference\((.*)\)$/i);
  if (m) { const [sArg, eArg] = splitArgs(m[1]);
    const start = new Date(String(evalExpression(sArg, ctx) ?? ''));
    const end = new Date(String(evalExpression(eArg, ctx) ?? ''));
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return '00:00:00';
    let diff = end.getTime() - start.getTime();
    const sign = diff < 0 ? '-' : '';
    diff = Math.abs(diff);
    const days = Math.floor(diff / 86_400_000); diff %= 86_400_000;
    const hours = Math.floor(diff / 3_600_000); diff %= 3_600_000;
    const minutes = Math.floor(diff / 60_000); diff %= 60_000;
    const seconds = Math.floor(diff / 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${sign}${days > 0 ? days + '.' : ''}${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  // Date/time — timezone conversion. Accepts both Windows ("Pacific Standard
  // Time") and IANA ("America/Los_Angeles") zone names.
  m = e.match(/^@?convertFromUtc\((.*)\)$/i);
  if (m) { const args = splitMultiArgs(m[1]);
    const utc = new Date(String(evalExpression(args[0], ctx) ?? ''));
    if (isNaN(utc.getTime())) return null;
    const tz = resolveTz(String(evalExpression(args[1], ctx) ?? ''));
    const local = new Date(utc.getTime() + tzOffsetMs(utc, tz));
    if (args.length >= 3) {
      const fmt = String(evalExpression(args[2], ctx));
      return evalExpression(`@formatDateTime('${local.toISOString()}', '${fmt}')`, ctx);
    }
    return isoNoZone(local);
  }
  m = e.match(/^@?convertToUtc\((.*)\)$/i);
  if (m) { const args = splitMultiArgs(m[1]);
    const local = parseAsUtc(String(evalExpression(args[0], ctx) ?? ''));
    if (isNaN(local.getTime())) return null;
    const tz = resolveTz(String(evalExpression(args[1], ctx) ?? ''));
    const utc = new Date(local.getTime() - tzOffsetMs(local, tz));
    if (args.length >= 3) {
      const fmt = String(evalExpression(args[2], ctx));
      return evalExpression(`@formatDateTime('${utc.toISOString()}', '${fmt}')`, ctx);
    }
    return utc.toISOString();
  }
  m = e.match(/^@?convertTimeZone\((.*)\)$/i);
  if (m) { const args = splitMultiArgs(m[1]);
    const local = parseAsUtc(String(evalExpression(args[0], ctx) ?? ''));
    if (isNaN(local.getTime())) return null;
    const srcTz = resolveTz(String(evalExpression(args[1], ctx) ?? ''));
    const destTz = resolveTz(String(evalExpression(args[2], ctx) ?? ''));
    const utc = new Date(local.getTime() - tzOffsetMs(local, srcTz));
    const dest = new Date(utc.getTime() + tzOffsetMs(utc, destTz));
    if (args.length >= 4) {
      const fmt = String(evalExpression(args[3], ctx));
      return evalExpression(`@formatDateTime('${dest.toISOString()}', '${fmt}')`, ctx);
    }
    return isoNoZone(dest);
  }

  // Form-data / multipart lookups. PA stores parsed form data either at
  // outputs.body (HTTP-shaped) or directly on outputs/triggerData.
  m = e.match(/^@?formDataValue\((.*)\)$/i);
  if (m) { const [aArg, kArg] = splitArgs(m[1]);
    const actionName = String(evalExpression(aArg, ctx) ?? '');
    const key = String(evalExpression(kArg, ctx) ?? '');
    const out = getActionData(ctx, actionName)?.outputs;
    const body = (out && typeof out === 'object' && 'body' in out) ? out.body : out;
    if (!body || typeof body !== 'object') return undefined;
    const v = (body as any)[key];
    if (Array.isArray(v)) {
      if (v.length > 1) throw new Error(`formDataValue: key '${key}' has multiple values; use formDataMultiValues()`);
      return v[0];
    }
    return v;
  }
  m = e.match(/^@?formDataMultiValues\((.*)\)$/i);
  if (m) { const [aArg, kArg] = splitArgs(m[1]);
    const actionName = String(evalExpression(aArg, ctx) ?? '');
    const key = String(evalExpression(kArg, ctx) ?? '');
    const out = getActionData(ctx, actionName)?.outputs;
    const body = (out && typeof out === 'object' && 'body' in out) ? out.body : out;
    if (!body || typeof body !== 'object') return [];
    const v = (body as any)[key];
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
  }
  m = e.match(/^@?multipartBody\((.*)\)$/i);
  if (m) { const [aArg, iArg] = splitArgs(m[1]);
    const actionName = String(evalExpression(aArg, ctx) ?? '');
    const idx = Number(evalExpression(iArg, ctx));
    const out = getActionData(ctx, actionName)?.outputs;
    const body = (out && typeof out === 'object' && 'body' in out) ? out.body : out;
    const parts = (body as any)?.$multipart ?? (body as any)?.parts;
    if (!Array.isArray(parts)) return undefined;
    const part = parts[idx];
    return part?.body ?? part?.content ?? part;
  }
  m = e.match(/^@?triggerFormDataValue\((.*)\)$/i);
  if (m) { const [kArg] = splitArgs(m[1]);
    const key = String(evalExpression(kArg, ctx) ?? '');
    const td = ctx.triggerData;
    const body = (td && typeof td === 'object' && 'body' in td) ? td.body : td;
    if (!body || typeof body !== 'object') return undefined;
    const v = (body as any)[key];
    if (Array.isArray(v)) {
      if (v.length > 1) throw new Error(`triggerFormDataValue: key '${key}' has multiple values; use triggerFormDataMultiValues()`);
      return v[0];
    }
    return v;
  }
  m = e.match(/^@?triggerFormDataMultiValues\((.*)\)$/i);
  if (m) { const [kArg] = splitArgs(m[1]);
    const key = String(evalExpression(kArg, ctx) ?? '');
    const td = ctx.triggerData;
    const body = (td && typeof td === 'object' && 'body' in td) ? td.body : td;
    if (!body || typeof body !== 'object') return [];
    const v = (body as any)[key];
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
  }
  m = e.match(/^@?triggerMultipartBody\((.*)\)$/i);
  if (m) { const [iArg] = splitArgs(m[1]);
    const idx = Number(evalExpression(iArg, ctx));
    const td = ctx.triggerData;
    const body = (td && typeof td === 'object' && 'body' in td) ? td.body : td;
    const parts = (body as any)?.$multipart ?? (body as any)?.parts;
    if (!Array.isArray(parts)) return undefined;
    const part = parts[idx];
    return part?.body ?? part?.content ?? part;
  }

  // URI parsing
  m = e.match(/^@?uriHost\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); try { return new URL(String(evalExpression(a,ctx))).hostname; } catch { return ''; } }
  m = e.match(/^@?uriPath\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); try { return new URL(String(evalExpression(a,ctx))).pathname; } catch { return ''; } }
  m = e.match(/^@?uriPathAndQuery\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); try { const u=new URL(String(evalExpression(a,ctx))); return u.pathname + u.search; } catch { return ''; } }
  m = e.match(/^@?uriPort\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); try {
    const u = new URL(String(evalExpression(a,ctx)));
    if (u.port) return Number(u.port);
    const defaults: Record<string, number> = { 'http:': 80, 'https:': 443, 'ftp:': 21, 'ftps:': 990, 'ws:': 80, 'wss:': 443 };
    return defaults[u.protocol] ?? 0;
  } catch { return 0; } }
  m = e.match(/^@?uriQuery\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); try { return new URL(String(evalExpression(a,ctx))).search; } catch { return ''; } }
  m = e.match(/^@?uriScheme\((.*)\)$/i);
  if (m) { const [a]=splitArgs(m[1]); try { return new URL(String(evalExpression(a,ctx))).protocol.replace(':', ''); } catch { return ''; } }

  // Handle literals without @ prefix
  if (!e.startsWith('@')) {
    // String literals with quotes
    if ((e.startsWith("'") && e.endsWith("'")) || (e.startsWith('"') && e.endsWith('"'))) {
      const quote = e[0];
      return e.slice(1, -1).split(quote + quote).join(quote);
    }
    // Numeric literals
    if (!isNaN(Number(e))) {
      return Number(e);
    }
    // Boolean literals
    if (e.toLowerCase() === 'true') return true;
    if (e.toLowerCase() === 'false') return false;
    // Return as-is for other cases
    return e;
  }

  // Fallback: return expression as-is (unsupported or literal)
  return e;
}

/**
 * Recursively evaluate expressions in parameter values
 */
/**
 * Evaluate template strings with @{...} expressions
 * Example: "brk_versicherungsperiodeid eq '@{triggerOutputs()?['body/id']}'"
 */
function evaluateTemplateString(str: string, ctx: RunContext): string {
  // Replace all @{...} expressions in the string
  return str.replace(/@\{([^}]+)\}/g, (match, expr) => {
    try {
      // Evaluate the expression inside the @{...}
      const result = evalExpression('@' + expr, ctx);
      // Convert to string (handle null/undefined)
      if (result === null || result === undefined) return '';
      if (typeof result === 'object') return JSON.stringify(result);
      return String(result);
    } catch (error) {
      // If evaluation fails, return the original expression
      console.warn(`Failed to evaluate template expression: ${match}`, error);
      return match;
    }
  });
}

export function evaluateParams(params: any, ctx: RunContext): any {
  if (params === null || params === undefined) return params;

  // If it's a string, check for expressions
  if (typeof params === 'string') {
    const trimmed = params.trim();

    // If it starts with @ (but not @{), evaluate as full expression
    if (trimmed.startsWith('@') && !trimmed.startsWith('@{')) {
      return evalExpression(params, ctx);
    }

    // If it contains @{...} template expressions, evaluate those
    if (params.includes('@{')) {
      return evaluateTemplateString(params, ctx);
    }

    // Otherwise return as-is
    return params;
  }

  // If it's an array, evaluate each element
  if (Array.isArray(params)) {
    return params.map(item => evaluateParams(item, ctx));
  }

  // If it's an object, evaluate each property
  if (typeof params === 'object') {
    const result: any = {};
    for (const key in params) {
      result[key] = evaluateParams(params[key], ctx);
    }
    return result;
  }

  // For other types (numbers, booleans, etc.), return as-is
  return params;
}
