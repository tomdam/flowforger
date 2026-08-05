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

describe('comparison / logical / conditional functions', () => {
  it('equals is loose', () => {
    assert.equal(ok(`@equals(101, '101')`), true);
    assert.equal(ok(`@equals(variables('count'), 5)`), true);
    assert.equal(ok(`@equals('a', 'b')`), false);
  });
  it('numeric comparisons coerce', () => {
    assert.equal(ok(`@greater('10', 9)`), true);
    assert.equal(ok(`@less(1, 2)`), true);
    assert.equal(ok(`@greaterOrEquals(2, 2)`), true);
    assert.equal(ok(`@ge(3, 2)`), true);
    assert.equal(ok(`@lessOrEquals(2, 2)`), true);
    assert.equal(ok(`@le(1, 2)`), true);
  });
  it('and/or short-circuit and are n-ary', () => {
    // json('not json') would throw — proves the arg is never evaluated
    assert.equal(ok(`@and(false, equals(json('not json'), 1))`), false);
    assert.equal(ok(`@or(true, equals(json('not json'), 1))`), true);
    assert.equal(ok(`@and(true, true, false)`), false);
    assert.equal(ok(`@or(false, false, true)`), true);
    assert.equal(ok(`@not(true)`), false);
  });
  it('if evaluates only the taken branch', () => {
    assert.equal(ok(`@if(true, 'yes', json('not json'))`), 'yes');
    assert.equal(ok(`@if(equals(1, 2), 'a', 'b')`), 'b');
  });
  it('coalesce returns first non-null', () => {
    assert.equal(ok(`@coalesce(null, variables('missing'), 'x')`), 'x');
    assert.equal(ok(`@coalesce(null, null)`), undefined);
  });
  it('contains: string vs array', () => {
    assert.equal(ok(`@contains('hello', 'ell')`), true);
    assert.equal(ok(`@contains(variables('Rows'), variables('Rows')[0])`), true); // identity element
    assert.equal(ok(`@contains(5, 5)`), false); // neither string nor array
  });
  it('startsWith / endsWith null-safe', () => {
    assert.equal(ok(`@startsWith('hello', 'he')`), true);
    assert.equal(ok(`@endsWith('hello', 'lo')`), true);
    assert.equal(ok(`@startsWith(variables('missing'), 'x')`), false);
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
    assert.equal(ok(`@bool('nope')`), false);
    assert.equal(ok(`@bool(0)`), false);
    assert.equal(ok(`@bool(2)`), true);
  });
  it('isFloat / isInt', () => {
    assert.equal(ok(`@isFloat('1.5')`), true);
    assert.equal(ok(`@isFloat('15')`), false);
    assert.equal(ok(`@isInt('15')`), true);
    assert.equal(ok(`@isInt('1.5')`), false);
    assert.equal(ok(`@isInt('abc')`), false);
  });
});
