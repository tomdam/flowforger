/**
 * Golden tests for the AST-based expression parser/emitter.
 *
 * The expected outputs were verified byte-identical against the legacy
 * string-scanning implementation (118/118 rows) before that implementation
 * was deleted — this file is the surviving regression net. The final
 * describe block documents intentional divergences from legacy behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExpressionToTypeScript,
  parseStringValue,
  parseSwitchExpressionToTypeScript,
  parseItemsExpressionToTypeScript,
  type ParseExpressionOptions,
} from '../src/generator/expression-parser.js';

const OPTS: Record<string, ParseExpressionOptions> = {
  loop: { loopMap: new Map([['Apply_to_each', 'item1']]), currentLoopVar: 'item1' },
  empty: {},
  ml: { config: { multilineExpressions: 'preserve' } as any },
};

// [expression, optionsKey|null, expected code, expected success]
const rows: Array<[string, string | null, string, boolean]> = [
  // comparisons (incl. the as-any cross-type guard)
  [`@equals(1, 2)`, null, `((1 as any) === 2)`, true],
  [`@equals(body('X'), 1)`, null, `(ctx.body('X') === 1)`, true],
  [`@equals(variables('a'), 'x')`, null, `(ctx.variables('a') === 'x')`, true],
  [`@greater(body('X'), 5)`, null, `(ctx.body('X') > 5)`, true],
  [`@less(1, outputs('A'))`, null, `(1 < ctx.outputs('A'))`, true],
  [`@greaterOrEquals(body('X'), 5)`, null, `(ctx.body('X') >= 5)`, true],
  [`@lessOrEquals(body('X'), 5)`, null, `(ctx.body('X') <= 5)`, true],
  // logical
  [`@and(equals(1, 1), greater(2, 1))`, null, `((1 === 1) && ((2 as any) > 1))`, true],
  [`@and(true, false, true)`, null, `(true && false && true)`, true],
  [`@and(true)`, null, `ctx.and(true)`, true],
  [`@or(equals(variables('s'), 'a'), equals(variables('s'), 'b'))`, null, `((ctx.variables('s') === 'a') || (ctx.variables('s') === 'b'))`, true],
  [`@or(true)`, null, `ctx.or(true)`, true],
  [`@not(equals(1, 1))`, null, `!(1 === 1)`, true],
  [`@not(variables('flag'))`, null, `!(ctx.variables('flag'))`, true],
  // references
  [`@body('A')`, null, `ctx.body('A')`, true],
  [`@outputs('A')?['body/value']`, null, `ctx.outputs('A')?.['body/value']`, true],
  [`@actions('A').status`, null, `ctx.actions('A').status`, true],
  [`@triggerBody().x`, null, `ctx.triggerBody().x`, true],
  [`@triggerOutputs()?['headers']`, null, `ctx.triggerOutputs()?.['headers']`, true],
  [`@trigger()`, null, `ctx.trigger()`, true],
  [`@workflow().run`, null, `ctx.workflow().run`, true],
  [`@parameters('MyParam')`, null, `ctx.parameters('MyParam')`, true],
  [`@variables('MyVar')`, null, `ctx.variables('MyVar')`, true],
  [`@variables('My Var 2')`, null, `ctx.variables('My Var 2')`, true],
  [`@item().id`, 'empty', `ctx.item().id`, true],
  [`@item()?['id']`, 'loop', `item1?.['id']`, true],
  [`@items('Apply_to_each')?['id']`, 'loop', `item1?.['id']`, true],
  [`@items('Other_loop')?['id']`, 'loop', `ctx.items('Other_loop')?.['id']`, true],
  // property paths
  [`@body('A')?['x']?['y']`, null, `ctx.body('A')?.['x']?.['y']`, true],
  [`@body('A').x.y`, null, `ctx.body('A').x.y`, true],
  [`@body('A')['x'][0]`, null, `ctx.body('A')['x'][0]`, true],
  [`@variables('arr')[0]`, null, `ctx.variables('arr')[0]`, true],
  [`@body('A')?[item()?['k']]`, null, `ctx.body('A')?.[ctx.item()?.['k']]`, true],
  [`@variables('arr')[variables('i')]`, null, `ctx.variables('arr')[ctx.variables('i')]`, true],
  [`@body('A').['x']`, null, `ctx.body('A')['x']`, true],
  // strings (incl. quote-style fidelity and doubled-quote escapes)
  [`@concat('a', 'b')`, null, `ctx.concat('a', 'b')`, true],
  [`@concat("dq", 'sq')`, null, `ctx.concat("dq", 'sq')`, true],
  [`@concat('it''s')`, null, `ctx.concat('it\\'s')`, true],
  [`@substring('abc', 1, 2)`, null, `ctx.substring('abc', 1, 2)`, true],
  [`@replace(variables('s'), 'a', 'b')`, null, `ctx.variables('s').replace('a', 'b')`, true],
  [`@toLower(variables('s'))`, null, `ctx.variables('s').toLowerCase()`, true],
  [`@toUpper('a')`, null, `'a'.toUpperCase()`, true],
  [`@trim(variables('s'))`, null, `ctx.variables('s').trim()`, true],
  [`@split('a,b', ',')`, null, `'a,b'.split(',')`, true],
  [`@join(variables('arr'), ',')`, null, `ctx.variables('arr').join(',')`, true],
  [`@indexOf('ab', 'b')`, null, `'ab'.indexOf('b')`, true],
  [`@lastIndexOf('ab', 'b')`, null, `'ab'.lastIndexOf('b')`, true],
  [`@startsWith('ab', 'a')`, null, `'ab'.startsWith('a')`, true],
  [`@endsWith('ab', 'b')`, null, `'ab'.endsWith('b')`, true],
  [`@length(variables('s'))`, null, `ctx.variables('s').length`, true],
  // collections
  [`@first(variables('arr'))`, null, `ctx.first(ctx.variables('arr'))`, true],
  [`@last(variables('arr'))`, null, `ctx.last(ctx.variables('arr'))`, true],
  [`@skip(variables('arr'), 1)`, null, `ctx.skip(ctx.variables('arr'), 1)`, true],
  [`@take(variables('arr'), 2)`, null, `ctx.take(ctx.variables('arr'), 2)`, true],
  [`@createArray(1, 'a', true)`, null, `[1, 'a', true]`, true],
  [`@range(0, 5)`, null, `ctx.range(0, 5)`, true],
  [`@empty(variables('s'))`, null, `ctx.empty(ctx.variables('s'))`, true],
  [`@contains(variables('s'), 'a')`, null, `ctx.contains(ctx.variables('s'), 'a')`, true],
  // math (incl. raw number fidelity: 1.50 stays 1.50)
  [`@add(1, 2)`, null, `(1 + 2)`, true],
  [`@add(1.50, 2)`, null, `(1.50 + 2)`, true],
  [`@sub(3, 1)`, null, `(3 - 1)`, true],
  [`@mul(2, 3)`, null, `(2 * 3)`, true],
  [`@div(6, 2)`, null, `(6 / 2)`, true],
  [`@mod(5, 2)`, null, `(5 % 2)`, true],
  [`@abs(-3)`, null, `Math.abs(-3)`, true],
  [`@min(1, 2)`, null, `Math.min(1, 2)`, true],
  [`@max(1, 2)`, null, `Math.max(1, 2)`, true],
  [`@int('5')`, null, `ctx.int('5')`, true],
  [`@float('1.5')`, null, `ctx.float('1.5')`, true],
  [`@rand(1, 10)`, null, `ctx.rand(1, 10)`, true],
  // conditional
  [`@if(equals(1, 1), 'a', 'b')`, null, `((1 === 1) ? 'a' : 'b')`, true],
  [`@coalesce(variables('a'), 'd')`, null, `(ctx.variables('a') ?? 'd')`, true],
  [`@coalesce(variables('a'))`, null, `ctx.coalesce(ctx.variables('a'))`, true],
  // conversion / encoding
  [`@string(1)`, null, `ctx.string(1)`, true],
  [`@json('{}')`, null, `ctx.json('{}')`, true],
  [`@bool(1)`, null, `ctx.bool(1)`, true],
  [`@base64('x')`, null, `ctx.base64('x')`, true],
  [`@base64ToString('eA==')`, null, `ctx.base64ToString('eA==')`, true],
  [`@uriComponent('a b')`, null, `ctx.uriComponent('a b')`, true],
  [`@uriComponentToString('a%20b')`, null, `ctx.uriComponentToString('a%20b')`, true],
  [`@decodeUriComponent('a%20b')`, null, `ctx.decodeUriComponent('a%20b')`, true],
  [`@xml('<a/>')`, null, `ctx.xml('<a/>')`, true],
  [`@xpath(xml('<a/>'), '//a')`, null, `ctx.xpath(ctx.xml('<a/>'), '//a')`, true],
  // datetime + default passthrough
  [`@utcNow()`, null, `ctx.utcNow()`, true],
  [`@formatDateTime(utcNow(), 'yyyy')`, null, `ctx.formatDateTime(ctx.utcNow(), 'yyyy')`, true],
  [`@addDays(utcNow(), 1)`, null, `ctx.addDays(ctx.utcNow(), 1)`, true],
  [`@addToTime(utcNow(), 1, 'Day')`, null, `ctx.addToTime(ctx.utcNow(), 1, 'Day')`, true],
  [`@ticks(utcNow())`, null, `ctx.ticks(ctx.utcNow())`, true],
  [`@dayOfWeek(utcNow())`, null, `ctx.dayOfWeek(ctx.utcNow())`, true],
  [`@guid()`, null, `ctx.guid()`, true],
  [`@someUnknownFn('x', 1)`, null, `ctx.someUnknownFn('x', 1)`, true],
  // @-literal forms and escapes
  [`@true`, null, `ctx.atTrue()`, true],
  [`@false`, null, `ctx.atFalse()`, true],
  [`@null`, null, `ctx.null()`, true],
  [`@0`, null, `ctx.atNumber(0)`, true],
  [`@3.14`, null, `ctx.atNumber(3.14)`, true],
  [`@'text'`, null, `ctx.atString("text")`, true],
  [`@@escaped`, null, `"@escaped"`, true],
  [``, null, `true`, true],
  // whole-string @{...}
  [`@{body('A').x}`, null, `ctx.body('A').x`, true],
  // fidelity heuristics preserve verbatim
  [`@concat('a', 'b','c')`, null, 'ctx.eval(`@concat(\'a\', \'b\',\'c\')`)', true],
  [`@concat('a') `, null, 'ctx.eval(`@concat(\'a\') `)', true],
  [`@add(+1, 2)`, null, 'ctx.eval(`@add(+1, 2)`)', true],
  [`@concat('a',\n 'b')`, 'ml', 'ctx.eval(`@concat(\'a\',\n \'b\')`)', true],
];

const stringRows: Array<[string, string | null, string, boolean]> = [
  [`hello`, null, `"hello"`, true],
  [`Hi @{variables('n')}!`, null, '`Hi ${ctx.variables(\'n\')}!`', true],
  [`@{variables('n')}`, null, `ctx.braced(ctx.variables('n'))`, true],
  [`@variables('n')`, null, `ctx.variables('n')`, true],
  [`Cost $5 @{variables('n')}`, null, '`Cost \\$5 ${ctx.variables(\'n\')}`', true],
  ['back`tick @{variables(\'n\')}', null, '`back\\`tick ${ctx.variables(\'n\')}`', true],
  [`@{item()?['id']} suffix`, 'loop', '`${item1?.[\'id\']} suffix`', true],
  [`{"not": "template"}`, null, `"{\\"not\\": \\"template\\"}"`, true],
];

describe('expression parser golden outputs', () => {
  for (const [expr, optsKey, code, success] of rows) {
    it(`parse: ${JSON.stringify(expr)}`, () => {
      const r = parseExpressionToTypeScript(expr, optsKey ? OPTS[optsKey] : undefined);
      assert.deepEqual({ code: r.code, success: r.success }, { code, success });
    });
  }
  for (const [value, optsKey, code, success] of stringRows) {
    it(`parseStringValue: ${JSON.stringify(value)}`, () => {
      const r = parseStringValue(value, optsKey ? OPTS[optsKey] : undefined);
      assert.deepEqual({ code: r.code, success: r.success }, { code, success });
    });
  }

  it('parseSwitchExpressionToTypeScript multi-segment template', () => {
    const r = parseSwitchExpressionToTypeScript(`@{variables('a')}_@{variables('b')}`);
    assert.deepEqual(
      { code: r.code, success: r.success },
      { code: '`${ctx.variables(\'a\')}_${ctx.variables(\'b\')}`', success: true },
    );
  });

  it('parseItemsExpressionToTypeScript', () => {
    assert.equal(parseItemsExpressionToTypeScript(`[1,2,3]`).code, `[1,2,3]`);
    assert.equal(parseItemsExpressionToTypeScript(`@body('A')`).code, `ctx.body('A')`);
    assert.equal(parseItemsExpressionToTypeScript(``).code, `[]`);
  });
});

describe('intentional divergences from the deleted legacy implementation', () => {
  it('non-canonical casing guard preserves the @ prefix (legacy dropped it)', () => {
    assert.deepEqual(parseExpressionToTypeScript(`@Replace('a', 'b', 'c')`), {
      code: 'ctx.eval(`@Replace(\'a\', \'b\', \'c\')`)',
      success: true,
    });
    assert.deepEqual(parseExpressionToTypeScript(`@TOLOWER('x')`), {
      code: 'ctx.eval(`@TOLOWER(\'x\')`)',
      success: true,
    });
  });
  it('dangling comma preserved verbatim (legacy silently dropped the empty arg)', () => {
    const r = parseExpressionToTypeScript(`@concat('a',)`);
    assert.equal(r.code, "ctx.eval(`@concat('a',)`)");
    assert.equal(r.success, false);
  });
  it('redundant nested @ (older transformer output) parses to typed syntax', () => {
    // Real Dataverse flows contain nested '@' emitted by older FlowForger
    // versions — they must load as typed DSL, never as a ctx.eval fallback.
    assert.deepEqual(parseExpressionToTypeScript(`@and(@equals(1, 1), true)`), {
      code: '((1 === 1) && true)',
      success: true,
    });
    assert.deepEqual(
      parseExpressionToTypeScript(
        `@not(@equals(empty(first(body('Ablehnender_Schritt_Abrufen')?['value'])), true))`,
      ),
      {
        code: `!((ctx.empty(ctx.first(ctx.body('Ablehnender_Schritt_Abrufen')?.['value'])) as any) === true)`,
        success: true,
      },
    );
  });
  it('whitespace inside bracket keys normalizes (legacy copied it verbatim)', () => {
    assert.equal(parseExpressionToTypeScript(`@body('A')?[ 0 ]`).code, `ctx.body('A')?.[0]`);
  });
});
