/**
 * Collection / object functions. Behaviour verified against the cloud
 * (conformance/flows/expressions.ff.ts): take/skip work on strings, union/intersection on
 * objects too and compare elements by value, property edits match keys ignoring case.
 */

import { register, eager, type ExprFn } from '../evaluator.js';
import { ExpressionError, deepEquals, findKey, isBinaryContent, isPlainObject, toText, typeName } from '../values.js';

const USAGE = (fn: string) => ` Please see https://aka.ms/logicexpressions#${fn} for usage details.`;

register('json', eager(([v]) => {
  // Binary content parses as its text (conformance/flows/binary.ff.ts).
  const s = isBinaryContent(v) ? toText(v) : v;
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch (err) {
    throw new ExpressionError(
      `The template language function 'json' parameter is not valid. The provided value '${s}' cannot be parsed: '${err instanceof Error ? err.message : String(err)}'.${USAGE('json')}`,
    );
  }
}));

// The cloud rejects createArray() with no arguments rather than returning [].
register('createArray', eager(vals => {
  if (vals.length === 0) {
    throw new ExpressionError(
      "The template language function 'createArray' expects a comma separated list of parameters. The function was invoked with no parameters.",
    );
  }
  return vals;
}));

register('array', eager(([v]) => [v]));

function firstOrLast(fn: 'first' | 'last'): ExprFn {
  return eager(([v]) => {
    if (!Array.isArray(v) && typeof v !== 'string') {
      throw new ExpressionError(
        `The template language function '${fn}' expects its parameter be an array or a string. The provided value is of type '${typeName(v)}'.${USAGE(fn)}`,
      );
    }
    if (v.length === 0) return undefined;
    return fn === 'first' ? v[0] : v[v.length - 1];
  });
}

register('first', firstOrLast('first'));
register('last', firstOrLast('last'));

function skipOrTake(fn: 'skip' | 'take'): ExprFn {
  return eager(([v, countV]) => {
    if (!Array.isArray(v) && typeof v !== 'string') {
      throw new ExpressionError(
        `The template language function '${fn}' expects its first parameter 'collection' to be an array or a string. The provided value is of type '${typeName(v)}'.${USAGE(fn)}`,
      );
    }
    const count = Number(countV);
    if (!Number.isInteger(count) || count < 0) {
      throw new ExpressionError(
        `The template language function '${fn}' parameters are out of range: 'count' must be a positive integer. The provided value is '${countV}'.${USAGE(fn)}`,
      );
    }
    return fn === 'skip' ? v.slice(count) : v.slice(0, count);
  });
}

register('skip', skipOrTake('skip'));
register('take', skipOrTake('take'));

/** Distinct by value, first occurrence wins. */
function distinct(items: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const x of items) if (!out.some((y) => deepEquals(x, y))) out.push(x);
  return out;
}

function sameKind(fn: string, vals: unknown[]): 'object' | 'array' {
  if (vals.length > 0 && vals.every(isPlainObject)) return 'object';
  if (vals.every(Array.isArray)) return 'array';
  throw new ExpressionError(
    `Template language function '${fn}' expects parameters of same type, but found '${[...new Set(vals.map(typeName))].join(',')}' distinct types.`,
  );
}

// Arrays: distinct values of all of them. Objects: the properties of all, later ones winning.
register('union', eager(vals =>
  sameKind('union', vals) === 'object' ? Object.assign({}, ...vals) : distinct(vals.flat())));

// Arrays: the values of the first found in all others. Objects: properties equal in all.
register('intersection', eager(vals => {
  const [head, ...rest] = vals;
  if (sameKind('intersection', vals) === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(head)) {
      if (rest.every((o) => Object.prototype.hasOwnProperty.call(o, k) && deepEquals(o[k], v))) out[k] = v;
    }
    return out;
  }
  return distinct((head as unknown[]).filter((x) => rest.every((arr) => (arr as unknown[]).some((y) => deepEquals(x, y)))));
}));

register('range', eager(([start, count]) => {
  const st = Number(start);
  const ct = Number(count);
  return Array.from({ length: ct }, (_, i) => st + i);
}));

const requireArray = (fn: string, v: unknown): any[] => {
  if (Array.isArray(v)) return v;
  throw new ExpressionError(
    `The template language function '${fn}' expects its first parameter to be of type array. The provided value is of type '${typeName(v)}'.${USAGE(fn)}`,
  );
};

register('sort', eager(vals => {
  const arr = requireArray('sort', vals[0]);
  if (vals.length >= 2) {
    const key = String(vals[1]);
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
}));

register('reverse', eager(([v]) => [...requireArray('reverse', v)].reverse()));

function requireObject(fn: string, o: unknown): Record<string, unknown> {
  if (isPlainObject(o)) return o;
  throw new ExpressionError(`The template language function '${fn}' expects its first parameter to be an object. The provided value is of type '${typeName(o)}'.`);
}

// Property names match ignoring case: setProperty(o, 'A', …) replaces an existing 'a'.
register('addProperty', eager(([o, nv, v]) => {
  const obj = requireObject('addProperty', o);
  const n = String(nv);
  if (findKey(obj, n) !== undefined) {
    throw new ExpressionError(
      `The template language function 'addProperty' expects the property to not exist in the object. Unable to add property '${n}' to '${JSON.stringify(obj, null, 2)}' as it already exists.`,
    );
  }
  return { ...obj, [n]: v };
}));

register('setProperty', eager(([o, nv, v]) => {
  const obj = requireObject('setProperty', o);
  const n = String(nv);
  return { ...obj, [findKey(obj, n) ?? n]: v };
}));

register('removeProperty', eager(([o, nv]) => {
  const result = { ...requireObject('removeProperty', o) };
  const key = findKey(result, String(nv));
  if (key !== undefined) delete result[key];
  return result;
}));
