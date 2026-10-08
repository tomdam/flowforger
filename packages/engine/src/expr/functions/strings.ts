/**
 * String functions. Behaviour verified against the cloud (conformance/flows/expressions.ff.ts):
 * indexOf/lastIndexOf/nthIndexOf/startsWith/endsWith ignore case; replace/split/contains don't.
 */

import { register, eager } from '../evaluator.js';
import { formatNumberValue } from '../dotnet-number.js';
import { ExpressionError, lowerInvariant, toText, typeName, upperInvariant } from '../values.js';

const USAGE = (fn: string) => ` Please see https://aka.ms/logicexpressions#${fn} for usage details.`;

/** The argument as a string, or the cloud's type error when it isn't one. */
function requireString(fn: string, v: unknown): string {
  if (typeof v === 'string') return v;
  throw new ExpressionError(
    `The template language function '${fn}' expects its parameter to be a string. The provided value is of type '${typeName(v)}'.${USAGE(fn)}`,
  );
}

register('concat', eager(vals => vals.map(toText).join('')));

register('substring', eager(vals => {
  const s = String(vals[0] ?? '');
  const start = Number(vals[1]);
  if (!Number.isInteger(start) || start < 0 || start >= s.length) {
    throw new ExpressionError(
      `The template language function 'substring' parameter is out of range: 'start index' must be non-negative integer and should be less than the length of the string.${USAGE('substring')}`,
    );
  }
  if (vals.length < 3) return s.substring(start);
  const length = Number(vals[2]);
  if (!Number.isInteger(length) || length < 0 || start + length > s.length) {
    throw new ExpressionError(
      `The template language function 'substring' parameters are out of range: 'start index' and 'length' must be non-negative integers and their sum must be no larger than the length of the string.${USAGE('substring')}`,
    );
  }
  return s.substring(start, start + length);
}));

register('replace', eager(([str, old, newVal]) => String(str ?? '').split(String(old)).join(String(newVal ?? ''))));

register('toLower', eager(([v]) => lowerInvariant(requireString('toLower', v))));
register('toUpper', eager(([v]) => upperInvariant(requireString('toUpper', v))));
register('trim', eager(([v]) => String(v ?? '').trim()));

// An empty delimiter doesn't split.
register('split', eager(([str, delim]) => {
  const s = String(str ?? '');
  const d = String(delim ?? '');
  return d === '' ? [s] : s.split(d);
}));

register('join', eager(([arr, delim]) => {
  if (!Array.isArray(arr)) {
    throw new ExpressionError(
      `The template language function 'join' expects its first parameter to be an array. The provided value is of type '${typeName(arr)}'.${USAGE('join')}`,
    );
  }
  return arr.map(toText).join(String(delim ?? ','));
}));

// Per-character casing keeps indexes aligned with the original string.
const lower = (v: unknown) => lowerInvariant(String(v ?? ''));

register('indexOf', eager(([str, search]) => lower(str).indexOf(lower(search))));
register('lastIndexOf', eager(([str, search]) => lower(str).lastIndexOf(lower(search))));

register('nthIndexOf', eager(([tv, sv, nv]) => {
  const t = lower(tv);
  const s = lower(sv);
  const n = Number(nv);
  if (n < 1 || s === '') return -1;
  let idx = -1, count = 0, pos = 0;
  while (count < n) {
    idx = t.indexOf(s, pos);
    if (idx === -1) return -1;
    count++;
    pos = idx + 1;
  }
  return idx;
}));

// guid(format): D (default) 36 chars, N 32, B {…} and P (…) 38, lower-case like .NET.
register('guid', eager(([format]) => {
  const id = crypto.randomUUID();
  switch (String(format ?? 'D').toUpperCase()) {
    case 'N': return id.replace(/-/g, '');
    case 'B': return `{${id}}`;
    case 'P': return `(${id})`;
    default: return id;
  }
}));

register('string', eager(([v]) => toText(v)));

register('length', eager(([v]) => {
  if (Array.isArray(v) || typeof v === 'string') return v.length;
  throw new ExpressionError(
    `The template language function 'length' expects its parameter to be an array or a string. The provided value is of type '${typeName(v)}'.${USAGE('length')}`,
  );
}));

// slice works on strings only in the cloud.
register('slice', eager(vals => {
  const v = vals[0];
  if (typeof v !== 'string') {
    throw new ExpressionError(
      `The template language function 'slice' expects its first parameter to be of type string. The provided value is of type '${typeName(v)}'.${USAGE('slice')}`,
    );
  }
  const start = Number(vals[1]);
  const end = vals.length >= 3 ? Number(vals[2]) : undefined;
  return v.slice(start, end);
}));

register('chunk', eager(([v, sizeV]) => {
  const size = Number(sizeV);
  if (!(size >= 1)) {
    throw new ExpressionError(
      `The template language function 'chunk' expects chunk size to be a positive integer. The provided value is less than 1.${USAGE('chunk')}`,
    );
  }
  if (!Array.isArray(v) && typeof v !== 'string') return [];
  const out = [];
  for (let i = 0; i < v.length; i += size) out.push(v.slice(i, i + size));
  return out;
}));

register('formatNumber', eager(vals => {
  const value = Number(vals[0]);
  const format = vals.length >= 2 ? String(vals[1]) : 'G';
  const locale = vals.length >= 3 ? String(vals[2]) : 'en-US';
  return formatNumberValue(value, format, locale);
}));
