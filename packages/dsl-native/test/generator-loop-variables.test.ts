/**
 * Tests for nested foreach loop variable naming in the DSL generator.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseExpressionToTypeScript } from '../src/generator/expression-parser.js';
import type { ParseExpressionOptions } from '../src/generator/expression-parser.js';
import { generateNativeDslFromIR } from '../src/generator.js';
import type { FlowIR, ForeachNode, ActionNode } from '@flowforger/ir';

describe('parseExpressionToTypeScript with loopMap', () => {
  it('should resolve items(LoopName) to the loop variable', () => {
    const options: ParseExpressionOptions = {
      loopMap: new Map([['ForEach_employee', 'employee']]),
      currentLoopVar: 'employee',
    };
    const result = parseExpressionToTypeScript("@items('ForEach_employee')", options);
    assert.strictEqual(result.code, 'employee');
    assert.strictEqual(result.success, true);
  });

  it('should resolve items(LoopName) with property access', () => {
    const options: ParseExpressionOptions = {
      loopMap: new Map([['ForEach_employee', 'employee']]),
      currentLoopVar: 'employee',
    };
    const result = parseExpressionToTypeScript("@items('ForEach_employee')?['name']", options);
    assert.strictEqual(result.code, "employee?.['name']");
    assert.strictEqual(result.success, true);
  });

  it('should resolve items(LoopName) with dot property access', () => {
    const options: ParseExpressionOptions = {
      loopMap: new Map([['ForEach_employee', 'employee']]),
      currentLoopVar: 'employee',
    };
    const result = parseExpressionToTypeScript("@items('ForEach_employee').name", options);
    assert.strictEqual(result.code, 'employee.name');
    assert.strictEqual(result.success, true);
  });

  it('should resolve item() to the current loop variable', () => {
    const options: ParseExpressionOptions = {
      loopMap: new Map([['Apply_to_each', 'item']]),
      currentLoopVar: 'item',
    };
    const result = parseExpressionToTypeScript('@item()', options);
    assert.strictEqual(result.code, 'item');
    assert.strictEqual(result.success, true);
  });

  it('should resolve item() with property access', () => {
    const options: ParseExpressionOptions = {
      loopMap: new Map([['Apply_to_each', 'item']]),
      currentLoopVar: 'item',
    };
    const result = parseExpressionToTypeScript("@item()?['value']", options);
    assert.strictEqual(result.code, "item?.['value']");
    assert.strictEqual(result.success, true);
  });

  it('should resolve nested loop items() to correct variables', () => {
    const options: ParseExpressionOptions = {
      loopMap: new Map([
        ['ForEach_employee', 'employee'],
        ['ForEach_task', 'task'],
      ]),
      currentLoopVar: 'task',
    };
    const outerResult = parseExpressionToTypeScript("@items('ForEach_employee')", options);
    assert.strictEqual(outerResult.code, 'employee');

    const innerResult = parseExpressionToTypeScript("@items('ForEach_task')", options);
    assert.strictEqual(innerResult.code, 'task');
  });

  it('should fall back to ctx.items() when loop name not in map', () => {
    const options: ParseExpressionOptions = {
      loopMap: new Map([['ForEach_employee', 'employee']]),
      currentLoopVar: 'employee',
    };
    const result = parseExpressionToTypeScript("@items('UnknownLoop')", options);
    assert.strictEqual(result.code, "ctx.items('UnknownLoop')");
  });

  it('should fall back to ctx.item() when no currentLoopVar', () => {
    const options: ParseExpressionOptions = {};
    const result = parseExpressionToTypeScript('@item()', options);
    assert.strictEqual(result.code, 'ctx.item()');
  });

  it('should resolve items() inside nested function calls', () => {
    const options: ParseExpressionOptions = {
      loopMap: new Map([['ForEach_employee', 'employee']]),
      currentLoopVar: 'employee',
    };
    const result = parseExpressionToTypeScript("@concat(items('ForEach_employee')?['first'], ' ', items('ForEach_employee')?['last'])", options);
    assert.ok(result.success);
    assert.ok(result.code.includes('employee'));
    assert.ok(!result.code.includes("ctx.items('ForEach_employee')"));
  });
});

describe('generateNativeDslFromIR — foreach loop variable naming', () => {
  function makeForeachIR(foreachNodes: ForeachNode[]): FlowIR {
    return {
      name: 'TestFlow',
      nodes: [
        { id: 'trg_1', type: 'trigger' as const, name: 'manual', triggerType: 'http', inputs: { method: 'POST' } },
        ...foreachNodes,
      ],
    };
  }

  it('should derive variable name from ForEach_ prefix', () => {
    const ir = makeForeachIR([{
      id: 'fe_1', type: 'foreach', name: 'ForEach_employee',
      itemsExpression: "@body('GetEmployees')",
      actions: [{
        id: 'act_1', type: 'action', name: 'Compose', kind: 'compose',
        inputs: { value: "@items('ForEach_employee')?['name']" },
      } as ActionNode],
    }]);
    const dsl = generateNativeDslFromIR(ir);
    assert.ok(dsl.includes('for (const employee of'), `Expected 'for (const employee of' in:\n${dsl}`);
    assert.ok(dsl.includes("employee?.['name']"), `Expected employee?.['name'] in:\n${dsl}`);
    assert.ok(!dsl.includes("ctx.items('ForEach_employee')"), `Should not contain ctx.items in:\n${dsl}`);
  });

  it('should use "item" for Apply_to_each', () => {
    const ir = makeForeachIR([{
      id: 'fe_1', type: 'foreach', name: 'Apply_to_each',
      itemsExpression: "@body('GetItems')",
      actions: [],
    }]);
    const dsl = generateNativeDslFromIR(ir);
    assert.ok(dsl.includes('for (const item of'), `Expected 'for (const item of' in:\n${dsl}`);
  });

  it('should generate unique names for nested foreach loops', () => {
    const ir = makeForeachIR([{
      id: 'fe_1', type: 'foreach', name: 'ForEach_employee',
      itemsExpression: "@body('GetEmployees')",
      actions: [{
        id: 'fe_2', type: 'foreach', name: 'ForEach_task',
        itemsExpression: "@items('ForEach_employee')?['tasks']",
        actions: [{
          id: 'act_1', type: 'action', name: 'ComposeResult', kind: 'compose',
          inputs: { value: "@concat(items('ForEach_employee')?['name'], ' - ', items('ForEach_task')?['title'])" },
        } as ActionNode],
      } as ForeachNode],
    }]);
    const dsl = generateNativeDslFromIR(ir);
    assert.ok(dsl.includes('for (const employee of'), `Expected outer loop 'for (const employee of' in:\n${dsl}`);
    assert.ok(dsl.includes('for (const task of'), `Expected inner loop 'for (const task of' in:\n${dsl}`);
    assert.ok(dsl.includes("employee?.['tasks']"), `Expected employee?.['tasks'] in:\n${dsl}`);
    assert.ok(!dsl.includes("ctx.items('ForEach_employee')"), `Should not contain ctx.items('ForEach_employee') in:\n${dsl}`);
    assert.ok(!dsl.includes("ctx.items('ForEach_task')"), `Should not contain ctx.items('ForEach_task') in:\n${dsl}`);
  });

  it('should handle name collisions with numeric suffix', () => {
    const ir = makeForeachIR([
      {
        id: 'fe_1', type: 'foreach', name: 'ForEach_item',
        itemsExpression: "@body('GetList1')",
        actions: [],
      } as ForeachNode,
      {
        id: 'fe_2', type: 'foreach', name: 'ForEach_item_2',
        itemsExpression: "@body('GetList2')",
        actions: [],
      } as ForeachNode,
    ]);
    const dsl = generateNativeDslFromIR(ir);
    const matches = dsl.match(/for \(const (\w+) of/g) || [];
    assert.strictEqual(matches.length, 2, `Expected 2 foreach loops, got: ${matches}`);
    assert.notStrictEqual(matches[0], matches[1], `Loop variables should be unique: ${matches}`);
  });

  it('should camelCase custom loop names', () => {
    const ir = makeForeachIR([{
      id: 'fe_1', type: 'foreach', name: 'Loop_through_records',
      itemsExpression: "@body('GetRecords')",
      actions: [],
    }]);
    const dsl = generateNativeDslFromIR(ir);
    const match = dsl.match(/for \(const (\w+) of/);
    assert.ok(match, `Expected foreach loop in:\n${dsl}`);
    const varName = match![1];
    assert.ok(/^[a-z]/.test(varName), `Variable should start lowercase: ${varName}`);
  });

  it('should avoid shadowing declared variables', () => {
    const ir: FlowIR = {
      name: 'TestFlow',
      nodes: [
        { id: 'trg_1', type: 'trigger' as const, name: 'manual', triggerType: 'http', inputs: { method: 'POST' } },
        {
          id: 'act_0', type: 'action', name: 'Init_item', kind: 'initializevariable',
          inputs: { variableName: 'item', type: 'string', value: 'hello' },
        } as ActionNode,
        {
          id: 'fe_1', type: 'foreach', name: 'Apply_to_each',
          itemsExpression: "@body('GetItems')",
          actions: [],
        } as ForeachNode,
      ],
    };
    const dsl = generateNativeDslFromIR(ir);
    // The variable "item" is declared, so the loop should NOT use "item"
    const match = dsl.match(/for \(const (\w+) of/);
    assert.ok(match, `Expected foreach loop in:\n${dsl}`);
    assert.notStrictEqual(match![1], 'item', `Loop variable should not shadow declared variable "item", got: ${match![1]}`);
  });

  it('should restore loop context after foreach (no leak to siblings)', () => {
    const ir = makeForeachIR([
      {
        id: 'fe_1', type: 'foreach', name: 'ForEach_employee',
        itemsExpression: "@body('GetEmployees')",
        actions: [{
          id: 'act_1', type: 'action', name: 'ComposeInner', kind: 'compose',
          inputs: { value: "@items('ForEach_employee')?['name']" },
        } as ActionNode],
      } as ForeachNode,
      {
        id: 'act_2', type: 'action', name: 'ComposeAfter', kind: 'compose',
        inputs: { value: 'done' },
      } as ActionNode,
    ]);
    const dsl = generateNativeDslFromIR(ir);
    assert.ok(dsl.includes('for (const employee of'), `Expected foreach in:\n${dsl}`);
    assert.ok(dsl.includes('"done"'), `Expected compose after loop in:\n${dsl}`);
  });
});
