/**
 * Comparison, logical, conditional, and type-predicate functions.
 *
 * if/and/or/coalesce are LAZY — they receive AST nodes and only evaluate the args they need;
 * the cloud short-circuits them too (`if(true, 'ok', int('abc'))` is 'ok'). Behaviour verified
 * against the cloud (conformance/flows/expressions.ff.ts): equals() is type-strict and deep,
 * strings compare ignoring case, and/or/not insist on booleans.
 */

import { register, eager, type ExprFn } from '../evaluator.js';
import { ExpressionError, compareIgnoreCase, deepEquals, findKey, isPlainObject, lowerInvariant, parseInvariantNumber, typeName } from '../values.js';

// With more than two arguments, true when every one equals the first (conformance/flows/expr-errors.ff.ts).
register('equals', eager(([first, ...rest]) => rest.every((v) => deepEquals(first, v))));

/** greater/less/…: numbers numerically, strings ignoring case, anything else fails. */
function comparison(fn: string, test: (order: number) => boolean): ExprFn {
  return eager(([a, b]) => {
    if (typeof a === 'number' && typeof b === 'number') return test(a < b ? -1 : a > b ? 1 : 0);
    if (typeof a === 'string' && typeof b === 'string') return test(compareIgnoreCase(a, b));
    const types = [a, b].map(typeName);
    if ((typeof a === 'number' || typeof a === 'string') && (typeof b === 'number' || typeof b === 'string')) {
      throw new ExpressionError(
        `The template language function '${fn}' expects two parameter of matching types. The function was invoked with values of type '${types[0]}' and '${types[1]}' that do not match.`,
      );
    }
    const invalid = [a, b].filter((v) => typeof v !== 'number' && typeof v !== 'string').map(typeName);
    throw new ExpressionError(
      `The template language function '${fn}' expects all of its parameters to be either integer or decimal numbers. Found invalid parameter types: '${invalid.join("', '")}'.`,
    );
  });
}

register('greater', comparison('greater', (o) => o > 0));
register('less', comparison('less', (o) => o < 0));
register('greaterOrEquals', comparison('greaterOrEquals', (o) => o >= 0));
register('lessOrEquals', comparison('lessOrEquals', (o) => o <= 0));

/** and/or: every argument evaluated so far must be a boolean; stop at the deciding one. */
function logical(fn: 'and' | 'or', decisive: boolean): ExprFn {
  return (args, { ev }) => {
    for (const a of args) {
      const v = ev(a);
      if (typeof v !== 'boolean') {
        throw new ExpressionError(
          `The template language function '${fn}' expects all of its parameters to be booleans. Found invalid parameter types: '${typeName(v)}'.`,
        );
      }
      if (v === decisive) return decisive;
    }
    return !decisive;
  };
}

register('and', logical('and', false));
register('or', logical('or', true));

register('not', eager(([v]) => {
  if (typeof v !== 'boolean') {
    throw new ExpressionError(
      `The template language function 'not' expects its parameter to be a boolean. The provided value is of type '${typeName(v)}'. Please see https://aka.ms/logicexpressions#not for usage details.`,
    );
  }
  return !v;
}));

register('if', (args, { ev }) => {
  const condition = ev(args[0]);
  if (typeof condition !== 'boolean') {
    throw new ExpressionError(
      `The template language function 'if' expects its first parameter to be of type boolean. The provided value is of type '${typeName(condition)}'. Please see https://aka.ms/logicexpressions#if for usage details.`,
    );
  }
  return condition ? ev(args[1]) : ev(args[2]);
});

register('coalesce', (args, { ev }) => {
  for (const a of args) {
    const v = ev(a);
    if (v !== null && v !== undefined) return v;
  }
  return null;
});

// Strings: case-sensitive substring. Arrays: an equal element. Objects: a key, ignoring case.
register('contains', eager(([c, v]) => {
  if (typeof c === 'string') return c.includes(String(v));
  if (Array.isArray(c)) return c.some((x) => deepEquals(x, v));
  if (isPlainObject(c)) return findKey(c, String(v)) !== undefined;
  throw new ExpressionError(
    `The template language function 'contains' expects its first argument 'collection' to be a dictionary (object), an array or a string. The provided value is of type '${typeName(c)}'.`,
  );
}));

function requireText(fn: string, v: unknown): string {
  if (typeof v === 'string') return v;
  throw new ExpressionError(
    `The template language function '${fn}' expects its first parameter to be of type string. The provided value is of type '${typeName(v)}'. Please see https://aka.ms/logicexpressions#${fn.toLowerCase()} for usage details.`,
  );
}

register('startsWith', eager(([s, p]) => lowerInvariant(requireText('startsWith', s)).startsWith(lowerInvariant(String(p ?? '')))));
register('endsWith', eager(([s, p]) => lowerInvariant(requireText('endsWith', s)).endsWith(lowerInvariant(String(p ?? '')))));

register('empty', eager(([v]) => {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string' || Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  throw new ExpressionError(
    `The template language function 'empty' expects its parameter to be an object, an array or a string. The provided value is of type '${typeName(v)}'. Please see https://aka.ms/logicexpressions#empty for usage details.`,
  );
}));

// bool('true'/'false') in any case, numbers by zero; any other text fails.
register('bool', eager(([v]) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true';
  throw new ExpressionError(
    "The template language function 'bool' was invoked with a parameter that is not valid. The value cannot be converted to the target type.",
  );
}));

// isFloat('10') is true: anything float() accepts.
register('isFloat', eager(([v]) => parseInvariantNumber(v) !== undefined));

register('isInt', eager(([v]) => (typeof v === 'number' ? Number.isInteger(v) : /^\s*[+-]?\d+\s*$/.test(String(v ?? '')))));
