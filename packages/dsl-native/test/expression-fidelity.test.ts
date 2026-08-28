/**
 * Tests for generator.expressionFidelity ('strict' | 'relaxed').
 *
 * 'strict' (default) preserves expressions verbatim via ctx.eval() whenever
 * regeneration would change cosmetic details — irregular comma spacing,
 * trailing whitespace, non-canonical function-name casing — guaranteeing
 * byte-for-byte round-trip parity with the source JSON.
 *
 * 'relaxed' generates native DSL for those expressions anyway, normalizing
 * the cosmetics. Semantically identical; textual parity is not guaranteed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExpressionToTypeScript,
  parseStringValue,
  type ParseExpressionOptions,
} from '../src/generator/expression-parser.js';
import { getGeneratorConfig } from '@flowforger/ir';

const STRICT: ParseExpressionOptions = {};
const RELAXED: ParseExpressionOptions = { config: { expressionFidelity: 'relaxed' } };

describe('expressionFidelity default', () => {
  it('defaults to strict', () => {
    assert.equal(getGeneratorConfig().expressionFidelity, 'strict');
  });
});

describe('irregular comma spacing', () => {
  // Mixed spacing: none inside replace(...), a space after the top-level concat comma.
  const expr = `@{concat(replace(variables('a'),variables('b'),''), '/Rechnungen')}`;

  it('strict preserves verbatim via ctx.braced(ctx.eval(...))', () => {
    const r = parseStringValue(expr, STRICT);
    assert.equal(r.code, 'ctx.braced(ctx.eval(`@{concat(replace(variables(\'a\'),variables(\'b\'),\'\'), \'/Rechnungen\')}`))');
    assert.equal(r.success, true);
  });

  it('relaxed generates native DSL (still ctx.braced for the @{...} form)', () => {
    const r = parseStringValue(expr, RELAXED);
    assert.equal(r.code, `ctx.braced(ctx.concat(ctx.variables('a').replace(ctx.variables('b'), ''), '/Rechnungen'))`);
    assert.equal(r.success, true);
  });

  it('relaxed generates native DSL for the bare @expr form too', () => {
    const bare = `@concat(replace(variables('a'),variables('b'),''), '/x')`;
    assert.equal(parseExpressionToTypeScript(bare, STRICT).code, 'ctx.eval(`@concat(replace(variables(\'a\'),variables(\'b\'),\'\'), \'/x\')`)');
    assert.equal(parseExpressionToTypeScript(bare, RELAXED).code, `ctx.concat(ctx.variables('a').replace(ctx.variables('b'), ''), '/x')`);
  });
});

describe('trailing whitespace', () => {
  const expr = `@concat('a', 'b') `;

  it('strict preserves verbatim', () => {
    assert.equal(parseExpressionToTypeScript(expr, STRICT).code, 'ctx.eval(`@concat(\'a\', \'b\') `)');
  });

  it('relaxed trims and generates native DSL', () => {
    assert.equal(parseExpressionToTypeScript(expr, RELAXED).code, `ctx.concat('a', 'b')`);
  });
});

describe('non-canonical function-name casing', () => {
  it('strict preserves verbatim', () => {
    assert.equal(parseExpressionToTypeScript(`@TOLOWER(variables('x'))`, STRICT).code, 'ctx.eval(`@TOLOWER(variables(\'x\'))`)');
    assert.equal(parseExpressionToTypeScript(`@Replace(variables('a'),'b','c')`, STRICT).code, 'ctx.eval(`@Replace(variables(\'a\'),\'b\',\'c\')`)');
  });

  it('relaxed normalizes to canonical native DSL', () => {
    assert.equal(parseExpressionToTypeScript(`@TOLOWER(variables('x'))`, RELAXED).code, `ctx.variables('x').toLowerCase()`);
    assert.equal(parseExpressionToTypeScript(`@Replace(variables('a'),'b','c')`, RELAXED).code, `ctx.variables('a').replace('b', 'c')`);
  });
});

describe('guards that stay active in relaxed mode', () => {
  it('explicit +<number> is preserved intentionally (AST cannot represent it)', () => {
    for (const opts of [STRICT, RELAXED]) {
      const r = parseExpressionToTypeScript(`@add(1, +5)`, opts);
      assert.equal(r.code, 'ctx.eval(`@add(1, +5)`)');
      assert.equal(r.success, true);
    }
  });

  it('multiline preservation is governed by multilineExpressions, not expressionFidelity', () => {
    const expr = `@concat('a',\r\n'b')`;
    const r = parseExpressionToTypeScript(expr, {
      config: { expressionFidelity: 'relaxed', multilineExpressions: 'preserve' },
    });
    assert.match(r.code, /^ctx\.eval\(/);
    assert.equal(r.success, true);
  });

  it('genuinely unparseable expressions still fall back to ctx.eval with success:false', () => {
    const r = parseExpressionToTypeScript(`@concat('unterminated`, RELAXED);
    assert.match(r.code, /^ctx\.eval\(/);
    assert.equal(r.success, false);
  });
});

describe('regular expressions are unaffected by the setting', () => {
  it('canonical input produces identical output in both modes', () => {
    const expr = `@concat(variables('a'), '/x')`;
    const strict = parseExpressionToTypeScript(expr, STRICT);
    const relaxed = parseExpressionToTypeScript(expr, RELAXED);
    assert.equal(strict.code, relaxed.code);
    assert.equal(strict.code, `ctx.concat(ctx.variables('a'), '/x')`);
  });
});
