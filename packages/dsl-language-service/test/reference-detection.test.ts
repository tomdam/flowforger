/**
 * Tests for string reference detection in DSL code.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { detectStringReference } from '../src/providers/reference-detection.js';

describe('detectStringReference', () => {
  describe('variable references (read-side)', () => {
    it('should detect ctx.variables() with single quotes', () => {
      const line = "  const val = ctx.variables('counter');";
      const col = line.indexOf('counter');
      const result = detectStringReference(line, col);
      assert.deepStrictEqual(result, {
        type: 'variable',
        name: 'counter',
        nameStart: col,
        nameEnd: col + 'counter'.length,
      });
    });

    it('should detect ctx.variables() with double quotes', () => {
      const line = '  const val = ctx.variables("counter");';
      const col = line.indexOf('counter');
      const result = detectStringReference(line, col);
      assert.deepStrictEqual(result, {
        type: 'variable',
        name: 'counter',
        nameStart: col,
        nameEnd: col + 'counter'.length,
      });
    });

    it('should detect bare variables() without ctx prefix', () => {
      const line = "  const val = variables('counter');";
      const col = line.indexOf('counter');
      const result = detectStringReference(line, col);
      assert.deepStrictEqual(result, {
        type: 'variable',
        name: 'counter',
        nameStart: col,
        nameEnd: col + 'counter'.length,
      });
    });

    it('should return null when cursor is outside the string', () => {
      const line = "  const val = ctx.variables('counter');";
      const result = detectStringReference(line, 5); // cursor on 'val'
      assert.strictEqual(result, null);
    });
  });

  describe('variable references (write-side)', () => {
    it('should detect ctx.setVariable()', () => {
      const line = "  ctx.setVariable('counter', newVal);";
      const col = line.indexOf('counter');
      const result = detectStringReference(line, col);
      assert.deepStrictEqual(result, {
        type: 'variable',
        name: 'counter',
        nameStart: col,
        nameEnd: col + 'counter'.length,
      });
    });

    it('should detect ctx.appendToArrayVariable()', () => {
      const line = "  ctx.appendToArrayVariable('items', newItem);";
      const col = line.indexOf('items');
      const result = detectStringReference(line, col);
      assert.deepStrictEqual(result, {
        type: 'variable',
        name: 'items',
        nameStart: col,
        nameEnd: col + 'items'.length,
      });
    });

    it('should detect ctx.appendToStringVariable()', () => {
      const line = "  ctx.appendToStringVariable('log', entry);";
      const col = line.indexOf('log');
      const result = detectStringReference(line, col);
      assert.deepStrictEqual(result, {
        type: 'variable',
        name: 'log',
        nameStart: col,
        nameEnd: col + 'log'.length,
      });
    });
  });

  describe('action references', () => {
    it('should detect ctx.body()', () => {
      const line = "  const data = ctx.body('GetItems');";
      const col = line.indexOf('GetItems');
      const result = detectStringReference(line, col);
      assert.deepStrictEqual(result, {
        type: 'action',
        name: 'GetItems',
        nameStart: col,
        nameEnd: col + 'GetItems'.length,
      });
    });

    it('should detect ctx.outputs()', () => {
      const line = "  const data = ctx.outputs('SendEmail');";
      const col = line.indexOf('SendEmail');
      const result = detectStringReference(line, col);
      assert.deepStrictEqual(result, {
        type: 'action',
        name: 'SendEmail',
        nameStart: col,
        nameEnd: col + 'SendEmail'.length,
      });
    });

    it('should detect ctx.actions()', () => {
      const line = "  const ref = ctx.actions('ParseData');";
      const col = line.indexOf('ParseData');
      const result = detectStringReference(line, col);
      assert.deepStrictEqual(result, {
        type: 'action',
        name: 'ParseData',
        nameStart: col,
        nameEnd: col + 'ParseData'.length,
      });
    });

    it('should detect bare body() without ctx prefix', () => {
      const line = "  const data = body('GetItems');";
      const col = line.indexOf('GetItems');
      const result = detectStringReference(line, col);
      assert.deepStrictEqual(result, {
        type: 'action',
        name: 'GetItems',
        nameStart: col,
        nameEnd: col + 'GetItems'.length,
      });
    });
  });

  describe('@runAfter references', () => {
    it('should detect bare action name in @runAfter', () => {
      const line = '  /** @action CatchBlock @type scope @runAfter TryBlock: Failed */';
      const col = line.indexOf('TryBlock');
      const result = detectStringReference(line, col);
      assert.deepStrictEqual(result, {
        type: 'action',
        name: 'TryBlock',
        nameStart: col,
        nameEnd: col + 'TryBlock'.length,
      });
    });

    it('should detect quoted action name in @runAfter', () => {
      const line = '  /** @runAfter "Get:Items:Action": Succeeded */';
      const col = line.indexOf('Get:Items:Action');
      const result = detectStringReference(line, col);
      assert.deepStrictEqual(result, {
        type: 'action',
        name: 'Get:Items:Action',
        nameStart: col,
        nameEnd: col + 'Get:Items:Action'.length,
      });
    });

    it('should detect @runAfter with multiple statuses', () => {
      const line = '  /** @action Finally @type scope @runAfter TryBlock: Succeeded, Failed, Skipped */';
      const col = line.indexOf('TryBlock');
      const result = detectStringReference(line, col);
      assert.ok(result);
      assert.strictEqual(result.name, 'TryBlock');
      assert.strictEqual(result.type, 'action');
    });

    it('should return null when cursor is on status, not action name', () => {
      const line = '  /** @runAfter TryBlock: Failed */';
      const col = line.indexOf('Failed');
      assert.strictEqual(detectStringReference(line, col), null);
    });
  });

  describe('parameter references', () => {
    it('should detect ctx.parameters()', () => {
      const line = "  const url = ctx.parameters('siteUrl');";
      const col = line.indexOf('siteUrl');
      const result = detectStringReference(line, col);
      assert.deepStrictEqual(result, {
        type: 'parameter',
        name: 'siteUrl',
        nameStart: col,
        nameEnd: col + 'siteUrl'.length,
      });
    });

    it('should detect bare parameters()', () => {
      const line = "  const url = parameters('siteUrl');";
      const col = line.indexOf('siteUrl');
      const result = detectStringReference(line, col);
      assert.deepStrictEqual(result, {
        type: 'parameter',
        name: 'siteUrl',
        nameStart: col,
        nameEnd: col + 'siteUrl'.length,
      });
    });
  });

  describe('loop references', () => {
    it('should detect ctx.items()', () => {
      const line = "  const item = ctx.items('Loop_1');";
      const col = line.indexOf('Loop_1');
      const result = detectStringReference(line, col);
      assert.deepStrictEqual(result, {
        type: 'loop',
        name: 'Loop_1',
        nameStart: col,
        nameEnd: col + 'Loop_1'.length,
      });
    });

    it('should detect bare items()', () => {
      const line = "  const item = items('Loop_1');";
      const col = line.indexOf('Loop_1');
      const result = detectStringReference(line, col);
      assert.deepStrictEqual(result, {
        type: 'loop',
        name: 'Loop_1',
        nameStart: col,
        nameEnd: col + 'Loop_1'.length,
      });
    });
  });

  describe('edge cases', () => {
    it('should return null for empty line', () => {
      assert.strictEqual(detectStringReference('', 0), null);
    });

    it('should return null for unrelated code', () => {
      const line = '  const x = 42;';
      assert.strictEqual(detectStringReference(line, 5), null);
    });

    it('should return null when cursor is on the function name, not inside string', () => {
      const line = "  const val = ctx.variables('counter');";
      const col = line.indexOf('variables');
      assert.strictEqual(detectStringReference(line, col), null);
    });

    it('should handle cursor at start of name', () => {
      const line = "  ctx.body('GetItems');";
      const col = line.indexOf('GetItems');
      const result = detectStringReference(line, col);
      assert.ok(result);
      assert.strictEqual(result.name, 'GetItems');
    });

    it('should handle cursor at end of name', () => {
      const line = "  ctx.body('GetItems');";
      const col = line.indexOf('GetItems') + 'GetItems'.length - 1;
      const result = detectStringReference(line, col);
      assert.ok(result);
      assert.strictEqual(result.name, 'GetItems');
    });

    it('should return null when cursor is on closing quote', () => {
      const line = "  ctx.body('GetItems');";
      const col = line.indexOf('GetItems') + 'GetItems'.length; // on the closing quote
      assert.strictEqual(detectStringReference(line, col), null);
    });

    it('should handle names with spaces', () => {
      const line = "  ctx.body('Get Items From List');";
      const col = line.indexOf('Get Items');
      const result = detectStringReference(line, col);
      assert.ok(result);
      assert.strictEqual(result.name, 'Get Items From List');
    });

    it('should handle multiple references on same line — picks correct one', () => {
      const line = "  if (ctx.body('A').value === ctx.body('B').value) {";
      const colA = line.indexOf("'A'") + 1;
      const resultA = detectStringReference(line, colA);
      assert.ok(resultA);
      assert.strictEqual(resultA.name, 'A');

      const colB = line.indexOf("'B'") + 1;
      const resultB = detectStringReference(line, colB);
      assert.ok(resultB);
      assert.strictEqual(resultB.name, 'B');
    });
  });
});
