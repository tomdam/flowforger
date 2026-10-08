import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tryEvaluate } from '../expr/evaluator.js';
import '../expr/functions/index.js';
import { makeExprContext } from './expr-fixtures.js';

const ctx = makeExprContext();
const ok = (e: string) => {
  const r = tryEvaluate(e, ctx);
  assert.equal(r.ok, true, `expected ok for ${e}: ${(r as any).reason ?? ''}`);
  return (r as { ok: true; value: any }).value;
};
const fails = (e: string, message?: RegExp) => {
  const r = tryEvaluate(e, ctx);
  assert.equal(r.ok, false, `expected failure for ${e}`);
  if (message) assert.match(String(((r as any).error as Error)?.message), message);
};

describe('comparison / logical / conditional functions', () => {
  it('equals is type-strict and deep', () => {
    assert.equal(ok(`@equals(101, '101')`), false);
    assert.equal(ok(`@equals(1, 1.0)`), true);
    assert.equal(ok(`@equals(createArray(1, 2), createArray(1, 2))`), true);
    assert.equal(ok(`@equals(json('{"a":1}'), json('{"a":1}'))`), true);
    assert.equal(ok(`@equals('A', 'a')`), false);
    assert.equal(ok(`@equals(variables('count'), 5)`), true);
    assert.equal(ok(`@equals('a', 'b')`), false);
  });
  it('comparisons: numbers numerically, strings case-insensitively, mixed types throw', () => {
    assert.equal(ok(`@greater(10, 9)`), true);
    assert.equal(ok(`@greater(2, 1.5)`), true);
    assert.equal(ok(`@greater('b', 'a')`), true);
    assert.equal(ok(`@less('a', 'B')`), true);
    fails(`@greater('10', 9)`, /expects two parameter of matching types/);
    fails(`@greater(null, 1)`);
    assert.equal(ok(`@less(1, 2)`), true);
    assert.equal(ok(`@greaterOrEquals(2, 2)`), true);
    // ge/le are not cloud functions (conformance/flows/expr-errors.ff.ts).
    fails(`@ge(3, 2)`, /is not defined or not valid/);
    assert.equal(ok(`@lessOrEquals(2, 2)`), true);
    fails(`@le(1, 2)`, /is not defined or not valid/);
  });
  it('and/or short-circuit and are n-ary', () => {
    // json('not json') would throw — proves the arg is never evaluated
    assert.equal(ok(`@and(false, equals(json('not json'), 1))`), false);
    assert.equal(ok(`@or(true, equals(json('not json'), 1))`), true);
    assert.equal(ok(`@and(true, true, false)`), false);
    assert.equal(ok(`@or(false, false, true)`), true);
    assert.equal(ok(`@not(true)`), false);
  });
  it('and/or/not require booleans', () => {
    fails(`@and(true, 1)`, /expects all of its parameters to be booleans/);
    fails(`@or(false, 'true')`);
    fails(`@not(1)`, /expects its parameter to be a boolean/);
  });
  it('if evaluates only the taken branch', () => {
    assert.equal(ok(`@if(true, 'yes', json('not json'))`), 'yes');
    assert.equal(ok(`@if(equals(1, 2), 'a', 'b')`), 'b');
  });
  it('coalesce returns first non-null', () => {
    assert.equal(ok(`@coalesce(null, variables('missing'), 'x')`), 'x');
    assert.equal(ok(`@coalesce(null, null)`), null);
  });
  it('contains: string vs array', () => {
    assert.equal(ok(`@contains('hello', 'ell')`), true);
    assert.equal(ok(`@contains(variables('Rows'), variables('Rows')[0])`), true); // identity element
    fails(`@contains(5, 5)`, /dictionary \(object\), an array or a string/);
  });
  it('startsWith / endsWith ignore case and need a string', () => {
    assert.equal(ok(`@startsWith('hello', 'HE')`), true);
    assert.equal(ok(`@endsWith('hello', 'lo')`), true);
    fails(`@startsWith(variables('missing'), 'x')`, /of type string/);
  });
  it('empty', () => {
    assert.equal(ok(`@empty('')`), true);
    assert.equal(ok(`@empty(null)`), true);
    assert.equal(ok(`@empty(variables('missing'))`), true);
    assert.equal(ok(`@empty(variables('Rows'))`), false);
    assert.equal(ok(`@empty('x')`), false);
  });
  it('bool conversion', () => {
    assert.equal(ok(`@bool(true)`), true);
    assert.equal(ok(`@bool('TRUE')`), true);
    assert.equal(ok(`@bool('false')`), false);
    fails(`@bool('nope')`, /cannot be converted/);
    assert.equal(ok(`@bool(0)`), false);
    assert.equal(ok(`@bool(2)`), true);
  });
  it('isFloat / isInt', () => {
    assert.equal(ok(`@isFloat('1.5')`), true);
    assert.equal(ok(`@isFloat('15')`), true); // anything float() parses
    assert.equal(ok(`@isInt('15')`), true);
    assert.equal(ok(`@isInt('1.5')`), false);
    assert.equal(ok(`@isInt('abc')`), false);
  });
});
