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
const fails = (e: string) => assert.equal(tryEvaluate(e, ctx).ok, false, `expected failure for ${e}`);

describe('collection / object functions', () => {
  it('first / last on arrays and strings', () => {
    assert.deepEqual(ok(`@first(variables('Rows'))`), { id: 1, name: 'first' });
    assert.deepEqual(ok(`@last(variables('Rows'))`), { id: 2, name: 'second' });
    assert.equal(ok(`@first('abc')`), 'a');
    assert.equal(ok(`@last('abc')`), 'c');
    assert.equal(ok(`@first(json('[]'))`), undefined);
    // The cloud rejects anything but an array or a string.
    fails(`@first(5)`);
    fails(`@first(null)`);
    fails(`@last(5)`);
    fails(`@last(null)`);
  });
  it('skip / take', () => {
    assert.deepEqual(ok(`@skip(createArray(1, 2, 3), 1)`), [2, 3]);
    assert.deepEqual(ok(`@take(createArray(1, 2, 3), 2)`), [1, 2]);
    // Strings are collections of characters; objects and negative counts are rejected.
    assert.equal(ok(`@skip('notarray', 3)`), 'array');
    assert.equal(ok(`@take('notarray', 3)`), 'not');
    fails(`@skip(json('{"a":1}'), 1)`);
    fails(`@take(json('{"a":1}'), 1)`);
    fails(`@skip(createArray(1, 2), -1)`);
    fails(`@take(createArray(1, 2), -1)`);
  });
  it('union dedupes, intersection filters', () => {
    assert.deepEqual(ok(`@union(createArray(1, 2), createArray(2, 3))`), [1, 2, 3]);
    assert.deepEqual(ok(`@intersection(createArray(1, 2, 3), createArray(2, 3, 4))`), [2, 3]);
    fails(`@union(5, createArray(1))`); // mixed types fail in the cloud
  });
  it('createArray / range / array', () => {
    assert.deepEqual(ok(`@createArray('a', 1, true)`), ['a', 1, true]);
    assert.equal(tryEvaluate(`@createArray()`, ctx).ok, false);
    assert.deepEqual(ok(`@range(2, 3)`), [2, 3, 4]);
    assert.deepEqual(ok(`@array('x')`), ['x']);
  });
  it('json parses strings, passes through non-strings', () => {
    assert.equal(ok(`@json('{"a":1}').a`), 1);
    assert.deepEqual(ok(`@json(variables('Rows'))`), (ctx as any).variables.Rows);
  });
  it('sort without and with key', () => {
    assert.deepEqual(ok(`@sort(createArray(3, 1, 2))`), [1, 2, 3]);
    assert.deepEqual(ok(`@sort(variables('Rows'), 'name')`),
      [{ id: 1, name: 'first' }, { id: 2, name: 'second' }]);
    fails(`@sort('notarray')`);
  });
  it('sort does not mutate the source', () => {
    ok(`@sort(variables('Rows'), 'name')`);
    assert.equal((ctx as any).variables.Rows[0].id, 1);
  });
  it('reverse arrays only', () => {
    assert.deepEqual(ok(`@reverse(createArray(1, 2, 3))`), [3, 2, 1]);
    fails(`@reverse('abc')`);
    fails(`@reverse(5)`);
  });
  it('addProperty / setProperty / removeProperty return copies', () => {
    assert.deepEqual(ok(`@addProperty(json('{"a":1}'), 'b', 2)`), { a: 1, b: 2 });
    assert.deepEqual(ok(`@setProperty(json('{"a":1}'), 'a', 9)`), { a: 9 });
    assert.deepEqual(ok(`@removeProperty(json('{"a":1,"b":2}'), 'b')`), { a: 1 });
    const orig = (ctx as any).variables.obj;
    ok(`@setProperty(variables('obj'), 'x', 1)`);
    assert.equal('x' in orig, false); // original untouched
  });
  it('addProperty rejects existing key and non-objects (falls back, not ok)', () => {
    assert.equal(tryEvaluate(`@addProperty(json('{"a":1}'), 'a', 2)`, ctx).ok, false);
    assert.equal(tryEvaluate(`@addProperty(createArray(1), 'a', 2)`, ctx).ok, false);
  });
});
