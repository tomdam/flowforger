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

describe('math functions', () => {
  it('arithmetic requires numbers', () => {
    assert.equal(ok(`@add(1, 2)`), 3);
    assert.equal(ok(`@add(1, 2.5)`), 3.5);
    assert.equal(ok(`@sub(5, 3)`), 2);
    assert.equal(ok(`@mul(4, 3)`), 12);
    assert.equal(ok(`@mod(10, 3)`), 1);
    fails(`@add('1', '2')`, /'add' expects its first parameter to be an integer, a float or a decimal number/);
    fails(`@add(null, 1)`);
  });
  it('div: integer division for ints, float division otherwise; by zero throws', () => {
    assert.equal(ok(`@div(10, 4)`), 2);
    assert.equal(ok(`@div(-7, 2)`), -3);
    assert.equal(ok(`@div(7.0, 2)`), 3.5);
    assert.equal(ok(`@div(7, 2.0)`), 3.5);
    assert.equal(ok(`@div(float('7'), 2)`), 3.5);
    fails(`@div(1, 0)`, /divide an integral or decimal value by zero in function 'div'/);
    fails(`@mod(1, 0)`, /divide an integral or decimal value by zero in function 'mod'/);
  });
  it('min / max: variadic or one array', () => {
    assert.equal(ok(`@min(3, 5)`), 3);
    assert.equal(ok(`@max(3, 5)`), 5);
    assert.equal(ok(`@max(1, 2.5, 2)`), 2.5);
    assert.equal(ok(`@min(createArray(4, 2, 9))`), 2);
  });
  it('rand is an integer in [min, max] inclusive', () => {
    for (let i = 0; i < 20; i++) {
      const v = ok(`@rand(1, 3)`);
      assert.ok(Number.isInteger(v) && v >= 1 && v <= 3, `rand out of range: ${v}`);
    }
  });
  it('int parses integers only, float parses invariant culture', () => {
    assert.equal(ok(`@int('42')`), 42);
    assert.equal(ok(`@int(true)`), 1);
    fails(`@int(2.9)`, /'int' was invoked with a parameter that is not valid/);
    fails(`@int(-2.9)`);
    fails(`@int('1.5')`);
    assert.equal(ok(`@float('1.5')`), 1.5);
    assert.equal(ok(`@float('1,5')`), 15); // comma is the invariant thousands separator
    fails(`@float('abc')`);
    fails(`@float(null)`);
  });
  it('abs / ceil / floor / round are not cloud functions', () => {
    for (const fn of ['abs', 'ceil', 'floor', 'round']) {
      fails(`@${fn}(-1.5)`, new RegExp(`The template function '${fn}' is not defined or not valid`));
    }
  });
  it('decimal converts to number', () => {
    assert.equal(ok(`@decimal('1.5')`), 1.5);
    assert.equal(ok(`@decimal(2)`), 2);
    fails(`@decimal('abc')`);
  });
});
