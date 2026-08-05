import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseExpression, tryParseExpression, parseTemplate, parseTemplateStrict } from '@flowforger/expressions';
import type { ExprNode } from '@flowforger/expressions';

const call = (e: string) => parseExpression(e) as Extract<ExprNode, { kind: 'call' }>;
const sq = (value: string) => ({ kind: 'str', value, quote: "'" });

describe('parseExpression', () => {
  it('call with string arg', () => {
    assert.deepEqual(parseExpression(`@variables('x')`), {
      kind: 'call', name: 'variables', args: [sq('x')], path: [],
    });
  });
  it('leading @ optional', () => {
    assert.deepEqual(parseExpression(`variables('x')`), parseExpression(`@variables('x')`));
  });
  it('nested calls and multiple args', () => {
    assert.deepEqual(parseExpression(`@concat(toLower('A'), 'b', 1)`), {
      kind: 'call', name: 'concat', path: [],
      args: [
        { kind: 'call', name: 'toLower', args: [sq('A')], path: [] },
        sq('b'),
        { kind: 'num', value: 1, raw: '1' },
      ],
    });
  });
  it('trailing paths: optional bracket, plain bracket, numeric, dot', () => {
    assert.deepEqual(parseExpression(`@first(body('X')?['value'])['a'].b[0]`), {
      kind: 'call', name: 'first', path: [
        { kind: 'index', expr: sq('a'), optional: false },
        { kind: 'prop', name: 'b', optional: false },
        { kind: 'index', expr: { kind: 'num', value: 0, raw: '0' }, optional: false },
      ],
      args: [{
        kind: 'call', name: 'body', args: [sq('X')],
        path: [{ kind: 'index', expr: sq('value'), optional: true }],
      }],
    });
  });
  it('?.prop and .[ forms', () => {
    assert.deepEqual(call(`@item()?.name`).path,
      [{ kind: 'prop', name: 'name', optional: true }]);
    assert.deepEqual(call(`@item().['k']`).path,
      [{ kind: 'index', expr: sq('k'), optional: false }]);
  });
  it('dynamic index expression', () => {
    assert.deepEqual(call(`@variables('arr')[variables('i')]`).path, [{
      kind: 'index', optional: false,
      expr: { kind: 'call', name: 'variables', args: [sq('i')], path: [] },
    }]);
  });
  it('keywords case-insensitive; bare ident; literals', () => {
    assert.deepEqual(parseExpression('True'), { kind: 'bool', value: true });
    assert.deepEqual(parseExpression('null'), { kind: 'null' });
    assert.deepEqual(parseExpression('hello'), { kind: 'ident', name: 'hello' });
    assert.deepEqual(parseExpression(`'lit'`), sq('lit'));
    assert.deepEqual(parseExpression('@true'), { kind: 'bool', value: true });
  });
  it('tolerates redundant nested @ before calls (older transformer output)', () => {
    assert.deepEqual(
      parseExpression(`@not(@equals(1, 1))`),
      parseExpression(`@not(equals(1, 1))`),
    );
    assert.deepEqual(
      parseExpression(`@if(@true, 1, 2)`),
      parseExpression(`@if(true, 1, 2)`),
    );
  });
  it('rejects trailing junk, bare @ident, empty input', () => {
    assert.equal(tryParseExpression(`@concat('a') extra`), null);
    assert.equal(tryParseExpression('@variables'), null);
    assert.equal(tryParseExpression(''), null);
    assert.equal(tryParseExpression('@'), null);
  });
  it('accepts @-prefixed literal expressions, marking them with at: true', () => {
    // PA accepts @0 / @'' / @'text' as literal expressions; the at flag lets
    // re-emitting consumers preserve the @ prefix for round-trip fidelity.
    assert.deepEqual(parseExpression(`@equals(length(variables('x')), @0)`),
      {
        kind: 'call', name: 'equals', path: [],
        args: [
          { kind: 'call', name: 'length', path: [], args: [
            { kind: 'call', name: 'variables', args: [sq('x')], path: [] },
          ] },
          { kind: 'num', value: 0, raw: '0', at: true },
        ],
      });
    assert.deepEqual(call(`@equals(variables('x'), @'')`).args[1],
      { kind: 'str', value: '', quote: "'", at: true });
    assert.deepEqual(parseExpression(`@'Submitted'`),
      { kind: 'str', value: 'Submitted', quote: "'", at: true });
    assert.deepEqual(parseExpression(`@3.14`),
      { kind: 'num', value: 3.14, raw: '3.14', at: true });
  });
  it('empty arg list ok, dangling comma rejected', () => {
    assert.deepEqual(call('@utcNow()').args, []);
    assert.equal(tryParseExpression(`@concat('a',)`), null);
  });
});

describe('parseTemplate', () => {
  it('does not at-flag a bare literal segment (@{2026} round-trips without gaining @)', () => {
    // The scanner parses segments as '@' + raw; that prepended '@' is an
    // artifact and must not mark the literal as @-prefixed. @{@2026} (raw
    // itself starting with '@') keeps the flag.
    const bare = parseTemplate('x @{2026} y')[1];
    assert.equal(bare.kind, 'expr');
    assert.deepEqual((bare as any).node, { kind: 'num', value: 2026, raw: '2026' });
    const prefixed = parseTemplate('x @{@2026} y')[1];
    assert.equal(prefixed.kind, 'expr');
    assert.deepEqual((prefixed as any).node, { kind: 'num', value: 2026, raw: '2026', at: true });
  });
  it('splits text and expressions', () => {
    const parts = parseTemplate(`x eq '@{variables('id')}' end`);
    assert.equal(parts.length, 3);
    assert.deepEqual(parts[0], { kind: 'text', text: `x eq '` });
    assert.equal(parts[1].kind, 'expr');
    assert.deepEqual(parts[2], { kind: 'text', text: `' end` });
  });
  it('braces inside string literals do not terminate the segment', () => {
    const parts = parseTemplate(`v=@{json('{"a":1}')['a']}`);
    assert.equal(parts.length, 2);
    assert.equal(parts[1].kind, 'expr');
  });
  it('unparseable segment degrades to legacy raw form', () => {
    assert.deepEqual(parseTemplate(`a @{***} b`), [
      { kind: 'text', text: 'a ' }, { kind: 'text', text: '@***' }, { kind: 'text', text: ' b' },
    ]);
  });
  it('unterminated @{ treated as text', () => {
    assert.deepEqual(parseTemplate('a @{oops'), [{ kind: 'text', text: 'a @{oops' }]);
  });
  it('plain string yields single text part', () => {
    assert.deepEqual(parseTemplate('no exprs'), [{ kind: 'text', text: 'no exprs' }]);
  });
});

describe('parseTemplateStrict', () => {
  it('returns parts when all segments parse', () => {
    const parts = parseTemplateStrict(`a @{variables('x')} b`);
    assert.ok(parts && parts.length === 3);
  });
  it('returns null when any segment fails to parse', () => {
    assert.equal(parseTemplateStrict(`a @{***} b`), null);
  });
});
