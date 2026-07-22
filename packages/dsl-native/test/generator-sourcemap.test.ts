/**
 * Tests for the DSL source map generator.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateNativeDslWithSourceMap } from '../src/generator-sourcemap.js';
import { generateNativeDslFromIR } from '../src/generator.js';
import type { FlowIR } from '@flowforger/ir';

describe('generateNativeDslWithSourceMap', () => {
  const simpleIR: FlowIR = {
    name: 'TestFlow',
    nodes: [
      {
        id: 'trg_1',
        name: 'manual_trigger',
        type: 'trigger',
        kind: 'http',
        inputs: { method: 'POST' },
      },
      {
        id: 'act_1',
        name: 'Compose_Result',
        type: 'action',
        kind: 'compose',
        inputs: { value: 'Hello World' },
      },
      {
        id: 'act_2',
        name: 'Send_Response',
        type: 'action',
        kind: 'response',
        inputs: { statusCode: 200, body: '@outputs(\'Compose_Result\')' },
      },
    ],
  };

  const scopeIR: FlowIR = {
    name: 'ScopeFlow',
    nodes: [
      {
        id: 'trg_1',
        name: 'manual_trigger',
        type: 'trigger',
        kind: 'http',
        inputs: { method: 'POST' },
      },
      {
        id: 'scp_1',
        name: 'My_Scope',
        type: 'scope',
        actions: [
          {
            id: 'act_1',
            name: 'Inner_Compose',
            type: 'action',
            kind: 'compose',
            inputs: { value: 42 },
          },
          {
            id: 'act_2',
            name: 'Inner_Response',
            type: 'action',
            kind: 'response',
            inputs: { statusCode: 200, body: 'OK' },
          },
        ],
      },
    ],
  };

  const ifIR: FlowIR = {
    name: 'IfFlow',
    nodes: [
      {
        id: 'trg_1',
        name: 'manual_trigger',
        type: 'trigger',
        kind: 'http',
        inputs: { method: 'POST' },
      },
      {
        id: 'if_1',
        name: 'Check_Value',
        type: 'if',
        condition: '@equals(1, 1)',
        actions: [
          {
            id: 'act_1',
            name: 'Then_Compose',
            type: 'action',
            kind: 'compose',
            inputs: { value: 'yes' },
          },
        ],
        elseActions: [
          {
            id: 'act_2',
            name: 'Else_Compose',
            type: 'action',
            kind: 'compose',
            inputs: { value: 'no' },
          },
        ],
      },
    ],
  };

  it('should return code and sourceMap', () => {
    const result = generateNativeDslWithSourceMap(simpleIR);
    assert.ok(typeof result.code === 'string');
    assert.ok(result.sourceMap instanceof Map);
    assert.ok(result.code.length > 0);
  });

  it('should produce the same code as generateNativeDslFromIR', () => {
    const result = generateNativeDslWithSourceMap(simpleIR);
    const plainCode = generateNativeDslFromIR(simpleIR);
    assert.strictEqual(result.code, plainCode);
  });

  it('should have source map entries for action nodes', () => {
    const result = generateNativeDslWithSourceMap(simpleIR);
    assert.ok(result.sourceMap.has('Compose_Result'), 'Should have entry for Compose_Result');
    assert.ok(result.sourceMap.has('Send_Response'), 'Should have entry for Send_Response');
  });

  it('should have source map entry for trigger node', () => {
    const result = generateNativeDslWithSourceMap(simpleIR);
    assert.ok(result.sourceMap.has('manual_trigger'), 'Should have entry for trigger');
  });

  it('should have valid line ranges', () => {
    const result = generateNativeDslWithSourceMap(simpleIR);
    const totalLines = result.code.split('\n').length;

    for (const [name, entry] of result.sourceMap) {
      assert.ok(entry.startLine >= 1, `${name}: startLine should be >= 1, got ${entry.startLine}`);
      assert.ok(entry.endLine >= entry.startLine, `${name}: endLine should be >= startLine, got ${entry.endLine} < ${entry.startLine}`);
      assert.ok(entry.endLine <= totalLines, `${name}: endLine should be <= ${totalLines}, got ${entry.endLine}`);
    }
  });

  it('should have source map entries for nested nodes inside scopes', () => {
    const result = generateNativeDslWithSourceMap(scopeIR);
    assert.ok(result.sourceMap.has('My_Scope'), 'Should have entry for scope node');
    assert.ok(result.sourceMap.has('Inner_Compose'), 'Should have entry for nested Inner_Compose');
    assert.ok(result.sourceMap.has('Inner_Response'), 'Should have entry for nested Inner_Response');
  });

  it('should have scope entry containing its inner nodes', () => {
    const result = generateNativeDslWithSourceMap(scopeIR);
    const scope = result.sourceMap.get('My_Scope')!;
    const inner = result.sourceMap.get('Inner_Compose')!;
    assert.ok(inner.startLine >= scope.startLine, 'Inner node should start at or after scope start');
    assert.ok(inner.endLine <= scope.endLine, 'Inner node should end at or before scope end');
  });

  it('should have source map entries for if node and nested actions', () => {
    const result = generateNativeDslWithSourceMap(ifIR);
    assert.ok(result.sourceMap.has('Check_Value'), 'Should have entry for if node');
    assert.ok(result.sourceMap.has('Then_Compose'), 'Should have entry for then branch action');
    assert.ok(result.sourceMap.has('Else_Compose'), 'Should have entry for else branch action');
  });

  it('should have non-overlapping entries for sibling actions', () => {
    const result = generateNativeDslWithSourceMap(simpleIR);
    const compose = result.sourceMap.get('Compose_Result')!;
    const response = result.sourceMap.get('Send_Response')!;
    assert.ok(
      compose.endLine < response.startLine,
      `Compose_Result (${compose.startLine}-${compose.endLine}) should end before Send_Response starts (${response.startLine})`
    );
  });

  it('should handle foreach nodes', () => {
    const foreachIR: FlowIR = {
      name: 'ForeachFlow',
      nodes: [
        {
          id: 'trg_1',
          name: 'manual_trigger',
          type: 'trigger',
          kind: 'http',
          inputs: { method: 'POST' },
        },
        {
          id: 'fe_1',
          name: 'Loop_Items',
          type: 'foreach',
          itemsExpression: "@triggerBody()?['items']",
          actions: [
            {
              id: 'act_1',
              name: 'Process_Item',
              type: 'action',
              kind: 'compose',
              inputs: { value: '@items()' },
            },
          ],
        },
      ],
    };

    const result = generateNativeDslWithSourceMap(foreachIR);
    assert.ok(result.sourceMap.has('Loop_Items'), 'Should have entry for foreach node');
    assert.ok(result.sourceMap.has('Process_Item'), 'Should have entry for nested action');

    const loop = result.sourceMap.get('Loop_Items')!;
    const inner = result.sourceMap.get('Process_Item')!;
    assert.ok(inner.startLine >= loop.startLine, 'Inner action should be within foreach range');
    assert.ok(inner.endLine <= loop.endLine, 'Inner action should be within foreach range');
  });

  it('should handle switch nodes', () => {
    const switchIR: FlowIR = {
      name: 'SwitchFlow',
      nodes: [
        {
          id: 'trg_1',
          name: 'manual_trigger',
          type: 'trigger',
          kind: 'http',
          inputs: { method: 'POST' },
        },
        {
          id: 'sw_1',
          name: 'Route_By_Status',
          type: 'switch',
          expression: "@triggerBody()?['status']",
          cases: [
            {
              name: 'Case_Active',
              value: 'active',
              actions: [
                {
                  id: 'act_1',
                  name: 'Handle_Active',
                  type: 'action',
                  kind: 'compose',
                  inputs: { value: 'active' },
                } as any,
              ],
            },
          ],
          defaultActions: [
            {
              id: 'act_2',
              name: 'Handle_Default',
              type: 'action',
              kind: 'compose',
              inputs: { value: 'default' },
            } as any,
          ],
        },
      ],
    };

    const result = generateNativeDslWithSourceMap(switchIR);
    assert.ok(result.sourceMap.has('Route_By_Status'), 'Should have entry for switch node');
    assert.ok(result.sourceMap.has('Handle_Active'), 'Should have entry for case action');
    assert.ok(result.sourceMap.has('Handle_Default'), 'Should have entry for default case action');
  });

  it('should handle recurrence trigger', () => {
    const recurrenceIR: FlowIR = {
      name: 'ScheduledFlow',
      nodes: [
        {
          id: 'trg_1',
          name: 'Recurrence',
          type: 'recurrence',
          inputs: { frequency: 'Day', interval: 1 },
        } as any,
        {
          id: 'act_1',
          name: 'Daily_Task',
          type: 'action',
          kind: 'compose',
          inputs: { value: 'done' },
        },
      ],
    };

    const result = generateNativeDslWithSourceMap(recurrenceIR);
    assert.ok(result.sourceMap.has('Recurrence'), 'Should have entry for recurrence trigger');
    assert.ok(result.sourceMap.has('Daily_Task'), 'Should have entry for action');
  });
});
