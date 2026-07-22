/**
 * Tests for the expression transformer
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { Project, SyntaxKind } from 'ts-morph';
import { transformExpression, createTransformContext, TransformContext } from '../src/transformer/expression-transformer.js';

function parseExpression(code: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('test.ts', `const x = ${code};`);
  const varDecl = sourceFile.getVariableDeclarations()[0];
  return varDecl.getInitializer()!;
}

describe('transformExpression', () => {
  let ctx: TransformContext;

  beforeEach(() => {
    ctx = createTransformContext();
  });

  describe('literals', () => {
    it('should transform string literals', () => {
      const expr = parseExpression("'hello'");
      assert.strictEqual(transformExpression(expr, ctx), "'hello'");
    });

    it('should transform numeric literals', () => {
      const expr = parseExpression('42');
      assert.strictEqual(transformExpression(expr, ctx), '42');
    });

    it('should transform boolean literals', () => {
      const exprTrue = parseExpression('true');
      assert.strictEqual(transformExpression(exprTrue, ctx), 'true');

      const exprFalse = parseExpression('false');
      assert.strictEqual(transformExpression(exprFalse, ctx), 'false');
    });
  });

  describe('ctx method calls', () => {
    it('should transform ctx.body() calls', () => {
      const expr = parseExpression("ctx.body('GetUser')");
      assert.strictEqual(transformExpression(expr, ctx), "body('GetUser')");
    });

    it('should transform ctx.body() with property access', () => {
      const expr = parseExpression("ctx.body('GetUser').name");
      assert.strictEqual(transformExpression(expr, ctx), "body('GetUser').name");
    });

    it('should transform ctx.triggerBody()', () => {
      const expr = parseExpression('ctx.triggerBody()');
      assert.strictEqual(transformExpression(expr, ctx), 'triggerBody()');
    });

    it('should transform ctx.variables()', () => {
      const expr = parseExpression("ctx.variables('counter')");
      assert.strictEqual(transformExpression(expr, ctx), "variables('counter')");
    });

    it('should transform ctx.item()', () => {
      const expr = parseExpression('ctx.item()');
      assert.strictEqual(transformExpression(expr, ctx), 'item()');
    });
  });

  describe('binary expressions', () => {
    it('should transform equality to @equals()', () => {
      ctx.trackedVariables.add('x');
      const expr = parseExpression("ctx.body('A').x === 'foo'");
      const result = transformExpression(expr, ctx);
      assert.ok(result.includes('@equals'));
      assert.ok(result.includes("body('A').x"));
      assert.ok(result.includes("'foo'"));
    });

    it('should transform inequality to @not(equals())', () => {
      const expr = parseExpression("ctx.body('A').x !== 'foo'");
      const result = transformExpression(expr, ctx);
      assert.ok(result.includes('@not'));
      assert.ok(result.includes('equals'));
    });

    it('should transform > to @greater()', () => {
      const expr = parseExpression("ctx.body('A').count > 10");
      const result = transformExpression(expr, ctx);
      assert.ok(result.includes('@greater'));
    });

    it('should transform < to @less()', () => {
      const expr = parseExpression("ctx.body('A').count < 10");
      const result = transformExpression(expr, ctx);
      assert.ok(result.includes('@less'));
    });

    it('should transform >= to @greaterOrEquals()', () => {
      const expr = parseExpression("ctx.body('A').count >= 10");
      const result = transformExpression(expr, ctx);
      assert.ok(result.includes('@greaterOrEquals'));
    });

    it('should transform <= to @lessOrEquals()', () => {
      const expr = parseExpression("ctx.body('A').count <= 10");
      const result = transformExpression(expr, ctx);
      assert.ok(result.includes('@lessOrEquals'));
    });

    it('should transform && to @and()', () => {
      const expr = parseExpression('true && false');
      const result = transformExpression(expr, ctx);
      assert.ok(result.includes('@and'));
    });

    it('should transform || to @or()', () => {
      const expr = parseExpression('true || false');
      const result = transformExpression(expr, ctx);
      assert.ok(result.includes('@or'));
    });

    it('should transform + with strings to @concat()', () => {
      const expr = parseExpression("'hello' + 'world'");
      const result = transformExpression(expr, ctx);
      assert.ok(result.includes('@concat'));
    });

    it('should transform + with numbers to @add()', () => {
      const expr = parseExpression('1 + 2');
      const result = transformExpression(expr, ctx);
      assert.ok(result.includes('@add'));
    });

    it('should transform - to @sub()', () => {
      const expr = parseExpression('10 - 5');
      const result = transformExpression(expr, ctx);
      assert.ok(result.includes('@sub'));
    });

    it('should transform * to @mul()', () => {
      const expr = parseExpression('3 * 4');
      const result = transformExpression(expr, ctx);
      assert.ok(result.includes('@mul'));
    });

    it('should transform / to @div()', () => {
      const expr = parseExpression('10 / 2');
      const result = transformExpression(expr, ctx);
      assert.ok(result.includes('@div'));
    });
  });

  describe('unary expressions', () => {
    it('should transform ! to @not()', () => {
      const expr = parseExpression('!true');
      const result = transformExpression(expr, ctx);
      assert.ok(result.includes('@not'));
    });
  });

  describe('property access', () => {
    it('should transform .length to @length()', () => {
      const expr = parseExpression("ctx.body('Items').length");
      const result = transformExpression(expr, ctx);
      assert.ok(result.includes('@length'));
    });
  });

  describe('loop variables', () => {
    it('should transform loop variable to @items()', () => {
      ctx.loopVariable = 'item';
      ctx.loopName = 'ForEach_item';

      const expr = parseExpression('item');
      const result = transformExpression(expr, ctx);
      assert.strictEqual(result, "items('ForEach_item')");
    });
  });

  describe('tracked variables', () => {
    it('should transform tracked variable to @variables()', () => {
      ctx.trackedVariables.add('counter');

      const expr = parseExpression('counter');
      const result = transformExpression(expr, ctx);
      assert.strictEqual(result, "variables('counter')");
    });
  });
});
