/**
 * Value semantics of the Logic Apps expression language, as measured against the cloud
 * (conformance/flows/expressions.ff.ts): how values become text, how they compare, how
 * property selection works, and the type names its error messages use.
 */

import type { ExprNode } from '@flowforger/expressions';
import { base64ToUtf8 } from './helpers.js';

/** An error the cloud raises while evaluating an expression (fails the action). */
export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

/** The type name the cloud's error messages use for a value. */
export function typeName(v: unknown): string {
  if (v === null || v === undefined) return 'Null';
  if (typeof v === 'string') return 'String';
  if (typeof v === 'boolean') return 'Boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'Integer' : 'Float';
  if (Array.isArray(v)) return 'Array';
  return 'Object';
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A number as .NET writes it (shortest round-trip digits): fixed notation unless the decimal
 * exponent is below -4 or above 16, then `1E+21` / `1E-06` (two-digit minimum exponent).
 */
export function numberText(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? 'Infinity' : n < 0 ? '-Infinity' : 'NaN';
  if (Number.isSafeInteger(n)) return String(n);
  const [mantissa, exp] = n.toExponential().split('e');
  const e = Number(exp);
  if (e > -5 && e < 17) {
    // JS switches to exponent form only outside 1e-7..1e21, so format fixed by hand.
    const digits = mantissa.replace('-', '').replace('.', '');
    const sign = n < 0 ? '-' : '';
    if (e < 0) return `${sign}0.${'0'.repeat(-e - 1)}${digits}`;
    if (digits.length <= e + 1) return sign + digits + '0'.repeat(e + 1 - digits.length);
    return `${sign}${digits.slice(0, e + 1)}.${digits.slice(e + 1)}`;
  }
  return `${mantissa.toUpperCase()}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
}

/**
 * A value as text, the way string(), concat(), join() and `@{...}` interpolation write it:
 * null → '', booleans → True/False, numbers as .NET writes them, objects/arrays as JSON.
 */
export function toText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return numberText(v);
  // Binary content ({ $content-type, $content }) reads as its UTF-8 text (conformance/flows/sp-http.ff.ts).
  if (isBinaryContent(v)) return base64ToUtf8(v['$content']);
  return JSON.stringify(v);
}

/** Keys binary content may carry besides its type and content: a parsed form post's fields or parts. */
const CONTENT_EXTRAS = new Set(['$content-type', '$content', '$formdata', '$multipart']);

/**
 * Binary content: `{ $content-type, $content }` (base64), as base64ToBinary(), a file download or
 * a form post (which also carries `$formdata` / `$multipart`, conformance/flows/formdata-*.ff.ts).
 */
export function isBinaryContent(v: unknown): v is { '$content-type': string; '$content': string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return typeof (v as any)['$content'] === 'string' && typeof (v as any)['$content-type'] === 'string' &&
    Object.keys(v).every((k) => CONTENT_EXTRAS.has(k));
}

/** equals(): same type and value; arrays element-wise, objects key-wise (keys are case-sensitive). */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEquals(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    if (ak.length !== Object.keys(b).length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEquals(a[k], b[k]));
  }
  return false;
}

/** The key of `obj` that `name` selects: exact match first, then case-insensitive (as the cloud does). */
export function findKey(obj: Record<string, unknown>, name: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(obj, name)) return name;
  const lower = name.toLowerCase();
  return Object.keys(obj).find((k) => k.toLowerCase() === lower);
}

/** OrdinalIgnoreCase comparison of two strings: negative, zero or positive. */
export function compareIgnoreCase(a: string, b: string): number {
  const x = a.toUpperCase();
  const y = b.toUpperCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Upper/lower-case each character on its own, like .NET's invariant casing (ß stays ß). */
export function upperInvariant(s: string): string {
  let out = '';
  for (const ch of s) {
    const u = ch.toUpperCase();
    out += [...u].length === 1 ? u : ch;
  }
  return out;
}

export function lowerInvariant(s: string): string {
  let out = '';
  for (const ch of s) {
    const l = ch.toLowerCase();
    out += [...l].length === 1 ? l : ch;
  }
  return out;
}

const FLOAT_RESULT_FNS = new Set(['add', 'sub', 'mul', 'div', 'mod', 'min', 'max']);

/**
 * Whether an argument is a float in the cloud's typing, which JS numbers can't tell apart
 * (7 and 7.0 are the same number). A non-integral value is a float; an integral one is a float
 * when it comes from a literal written with a '.' or exponent, from float()/decimal(), or from
 * arithmetic over such values. div() uses this to decide between integer and float division.
 */
export function isFloatArg(node: ExprNode, value: unknown): boolean {
  if (typeof value === 'number' && !Number.isInteger(value)) return true;
  return isStaticFloat(node);
}

function isStaticFloat(node: ExprNode): boolean {
  if (node.kind === 'num') return /[.eE]/.test(node.raw);
  if (node.kind !== 'call' || node.path.length > 0) return false;
  const name = node.name.toLowerCase();
  if (name === 'float' || name === 'decimal') return true;
  if (FLOAT_RESULT_FNS.has(name)) return node.args.some(isStaticFloat);
  return false;
}

/**
 * The invariant-culture number parse float()/decimal()/isFloat() use: optional sign, digits with
 * thousands commas ('1,5' is 15), optional fraction and exponent. undefined when not a number.
 */
export function parseInvariantNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!/^[+-]?(?:\d[\d,]*)?(?:\.\d*)?(?:[eE][+-]?\d+)?$/.test(s) || !/\d/.test(s.split(/[eE]/)[0])) return undefined;
  const n = Number(s.replace(/,/g, ''));
  return Number.isNaN(n) ? undefined : n;
}
