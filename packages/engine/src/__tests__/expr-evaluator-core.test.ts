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

describe('tryEvaluate core', () => {
  it('literals', () => {
    assert.equal(ok(`'hi'`), 'hi');
    assert.equal(ok('42'), 42);
    assert.equal(ok('true'), true);
    assert.equal(ok('@true'), true);
    assert.equal(ok('null'), null);
    assert.equal(ok('hello'), 'hello'); // bare ident → its text
  });
  it('variables with case-insensitive lookup and paths', () => {
    assert.equal(ok(`@variables('count')`), 5);
    assert.equal(ok(`@variables('COUNT')`), 5);
    assert.equal(ok(`@variables('obj')['a'].b[2]`), 3);
    assert.equal(ok(`@variables('obj')?['missing']?['x']`), undefined);
    assert.equal(ok(`@variables('obj').missing.x`), undefined); // non-optional is safe too
  });
  it('slash convention in bracket keys', () => {
    assert.equal(ok(`@variables('obj')['a/b']`)[0], 1);
  });
  it('dynamic index', () => {
    assert.equal(ok(`@variables('Rows')[variables('idx')].name`), 'second');
  });
  it('concat + nesting', () => {
    assert.equal(ok(`@concat('a', variables('name'), 1)`), 'aWorld1');
  });
  it('@{...} whole-string stringification', () => {
    assert.equal(ok(`@{variables('count')}`), '5');
    assert.equal(ok(`@{variables('Rows')}`), JSON.stringify((ctx as any).variables['Rows']));
  });
  it('template strings', () => {
    assert.equal(ok(`id eq '@{variables('count')}'`), `id eq '5'`);
  });
  it('plain text without @ is not handled (falls back)', () => {
    assert.equal(tryEvaluate('no template here', ctx).ok, false);
  });
  it('unknown fn inside a template degrades to raw @ text', () => {
    assert.equal(ok(`x @{noSuchFn(1)} y`), 'x @noSuchFn(1) y');
    assert.equal(ok(`a @{variables('count')} b @{nope()} c`), 'a 5 b @nope() c');
  });
  it('unknown function and parse garbage are not ok', () => {
    assert.equal(tryEvaluate(`@noSuchFn('x')`, ctx).ok, false);
    assert.equal(tryEvaluate(`@concat(noSuchFn('x'))`, ctx).ok, false); // nested unknown
    assert.equal(tryEvaluate(`@concat('a'`, ctx).ok, false); // parse error
  });
});
