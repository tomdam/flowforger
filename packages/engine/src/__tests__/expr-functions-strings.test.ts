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

describe('string functions', () => {
  it('substring 2-arg and 3-arg', () => {
    assert.equal(ok(`@substring('hello', 1, 3)`), 'ell');
    assert.equal(ok(`@substring('hello', 2)`), 'llo');
  });
  it('replace replaces all occurrences, regex-safe', () => {
    assert.equal(ok(`@replace('a.b.c', '.', '-')`), 'a-b-c');
    assert.equal(ok(`@replace('aaa', 'a', 'b')`), 'bbb');
  });
  it('case and trim', () => {
    assert.equal(ok(`@toLower('ABC')`), 'abc');
    assert.equal(ok(`@toUpper('abc')`), 'ABC');
    assert.equal(ok(`@trim('  x  ')`), 'x');
  });
  it('split / join', () => {
    assert.deepEqual(ok(`@split('a,b,c', ',')`), ['a', 'b', 'c']);
    assert.equal(ok(`@join(createArray('a', 'b'), '-')`), 'a-b');
    assert.equal(ok(`@join('notarray', '-')`), '');
  });
  it('indexOf / lastIndexOf / nthIndexOf', () => {
    assert.equal(ok(`@indexOf('banana', 'an')`), 1);
    assert.equal(ok(`@lastIndexOf('banana', 'an')`), 3);
    assert.equal(ok(`@nthIndexOf('banana', 'an', 2)`), 3);
    assert.equal(ok(`@nthIndexOf('banana', 'an', 5)`), -1);
    assert.equal(ok(`@nthIndexOf('banana', '', 1)`), -1);
  });
  it('guid shape', () => {
    assert.match(ok('@guid()'), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
  it('string(): JSON for non-strings, pass-through for strings', () => {
    assert.equal(ok(`@string(variables('Rows')[0])`), JSON.stringify({ id: 1, name: 'first' }));
    assert.equal(ok(`@string('s')`), 's');
    assert.equal(ok(`@string(5)`), '5');
  });
  it('length on string and array; 0 otherwise', () => {
    assert.equal(ok(`@length('abc')`), 3);
    assert.equal(ok(`@length(variables('Rows'))`), 2);
    assert.equal(ok(`@length(5)`), 0);
  });
  it('slice on string and array', () => {
    assert.equal(ok(`@slice('hello', 1, 3)`), 'el');
    assert.equal(ok(`@slice('hello', 2)`), 'llo');
    assert.deepEqual(ok(`@slice(variables('Rows'), 1)`), [{ id: 2, name: 'second' }]);
    assert.equal(ok(`@slice(5, 0)`), 5); // non-string/array passes through
  });
  it('chunk arrays; empty for bad input', () => {
    assert.deepEqual(ok(`@chunk(createArray(1, 2, 3), 2)`), [[1, 2], [3]]);
    assert.deepEqual(ok(`@chunk('notarray', 2)`), []);
    assert.deepEqual(ok(`@chunk(createArray(1), 0)`), []);
  });
  it('formatNumber', () => {
    assert.equal(ok(`@formatNumber(1234.5, 'N2', 'en-US')`), '1,234.50');
    assert.equal(ok(`@formatNumber(0.5, 'P0', 'en-US')`), '50%');
  });
});
