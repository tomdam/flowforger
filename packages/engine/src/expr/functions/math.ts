/**
 * Numeric functions. Behaviour verified against the cloud (conformance/flows/expressions.ff.ts):
 * arguments must be numbers, div() of two integers is integer division, a zero divisor fails,
 * min()/max() take any number of values or one array. abs/ceil/floor/round don't exist there.
 */

import { register, eager, type ExprFn } from '../evaluator.js';
import { ExpressionError, isFloatArg, parseInvariantNumber, typeName } from '../values.js';

const ORDINAL = ['first', 'second'];

function requireNumber(fn: string, v: unknown, index: number): number {
  if (typeof v === 'number') return v;
  throw new ExpressionError(
    `The template language function '${fn}' expects its ${ORDINAL[index] ?? `#${index + 1}`} parameter to be an integer, a float or a decimal number. The provided value is of type '${typeName(v)}'. Please see https://aka.ms/logicexpressions#${fn} for usage details.`,
  );
}

function binary(fn: string, op: (a: number, b: number) => number): ExprFn {
  return eager(([a, b]) => op(requireNumber(fn, a, 0), requireNumber(fn, b, 1)));
}

register('add', binary('add', (a, b) => a + b));
register('sub', binary('sub', (a, b) => a - b));
register('mul', binary('mul', (a, b) => a * b));

/** div/mod: integer arithmetic when both sides are integers, and a zero divisor fails either way. */
function division(fn: 'div' | 'mod', op: (a: number, b: number, integral: boolean) => number): ExprFn {
  return (args, { ev }) => {
    const [a, b] = args.map(ev);
    const x = requireNumber(fn, a, 0);
    const y = requireNumber(fn, b, 1);
    if (y === 0) throw new ExpressionError(`Attempt to divide an integral or decimal value by zero in function '${fn}'.`);
    const integral = !isFloatArg(args[0], a) && !isFloatArg(args[1], b);
    return op(x, y, integral);
  };
}

register('div', division('div', (a, b, integral) => (integral ? Math.trunc(a / b) : a / b)));
register('mod', division('mod', (a, b) => a % b));

/** min/max take several numbers, or a single array of them. */
function extreme(fn: 'min' | 'max', pick: (...n: number[]) => number): ExprFn {
  return eager(vals => {
    const list = vals.length === 1 && Array.isArray(vals[0]) ? vals[0] : vals;
    return pick(...list.map((v: unknown, i: number) => requireNumber(fn, v, i)));
  });
}

register('min', extreme('min', Math.min));
register('max', extreme('max', Math.max));

// Inclusive of max (legacy: floor(random * (max - min + 1)) + min)
register('rand', eager(([minV, maxV]) => {
  const lo = Number(minV);
  const hi = Number(maxV);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}));

const notConvertible = (fn: string) =>
  new ExpressionError(
    `The template language function '${fn}' was invoked with a parameter that is not valid. The value cannot be converted to the target type.`,
  );

// int('1.5') and int(1.7) fail in the cloud; int(true) is 1.
register('int', eager(([v]) => {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v);
  throw notConvertible('int');
}));

// Invariant culture: '1,5' is 15 (a thousands separator), not 1.5.
function toFloat(fn: string) {
  return eager(([v]) => {
    const n = parseInvariantNumber(v);
    if (n === undefined) throw notConvertible(fn);
    return n;
  });
}

register('float', toFloat('float'));
register('decimal', toFloat('decimal'));
