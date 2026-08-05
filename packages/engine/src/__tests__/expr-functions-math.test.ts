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

describe('math functions', () => {
  it('arithmetic coerces to Number', () => {
    assert.equal(ok(`@add(1, 2)`), 3);
    assert.equal(ok(`@add('1', '2')`), 3);
    assert.equal(ok(`@sub(5, 3)`), 2);
    assert.equal(ok(`@mul(4, 3)`), 12);
    assert.equal(ok(`@div(10, 4)`), 2.5); // plain JS division (legacy)
    assert.equal(ok(`@mod(10, 3)`), 1);
  });
  it('min / max (2-arg legacy form)', () => {
    assert.equal(ok(`@min(3, 5)`), 3);
    assert.equal(ok(`@max(3, 5)`), 5);
  });
  it('rand is an integer in [min, max] inclusive', () => {
    for (let i = 0; i < 20; i++) {
      const v = ok(`@rand(1, 3)`);
      assert.ok(Number.isInteger(v) && v >= 1 && v <= 3, `rand out of range: ${v}`);
    }
  });
  it('int truncates, float parses', () => {
    assert.equal(ok(`@int('42')`), 42);
    assert.equal(ok(`@int(2.9)`), 2);
    assert.equal(ok(`@int(-2.9)`), -2); // trunc, not floor
    assert.equal(ok(`@float('1.5')`), 1.5);
  });
  it('abs / ceil / floor / round', () => {
    assert.equal(ok(`@abs(-3)`), 3);
    assert.equal(ok(`@ceil(1.1)`), 2);
    assert.equal(ok(`@floor(1.9)`), 1);
    assert.equal(ok(`@round(1.5)`), 2);
  });
  it('decimal converts to number', () => {
    assert.equal(ok(`@decimal('1.5')`), 1.5);
    assert.equal(ok(`@decimal(2)`), 2);
  });
});
