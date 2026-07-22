import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, executeNode, type RunContext, type TraceEntry, type IterationTraceEntry } from '../index.js';
import type { FlowIR, Node } from '@flowforger/ir';

function makeContext(variables: Record<string, any> = {}): RunContext {
  return {
    variables: { ...variables },
    actions: new Map(),
    triggerData: {},
    workflowName: 'test',
    parameters: {},
    now: () => new Date('2026-01-01T00:00:00Z'),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: () => {},
    secrets: () => undefined,
    connector: () => {
      throw new Error('no connector');
    },
  };
}

describe('foreach iteration tracking via run()', () => {
  it('should track iterations with correct index, item, status, and actions', async () => {
    const flow: FlowIR = {
      name: 'foreach-test',
      nodes: [
        {
          id: 'trg_1',
          name: 'manual',
          type: 'trigger',
          inputs: { method: 'GET' },
        } as any,
        {
          id: 'fe_1',
          name: 'ForEachItem',
          type: 'foreach',
          itemsExpression: "@createArray('a', 'b', 'c')",
          actions: [
            {
              id: 'act_1',
              name: 'ComposeItem',
              type: 'action',
              kind: 'compose',
              inputs: { value: "@items('ForEachItem')" },
            } as any,
          ],
        } as any,
      ],
    };

    const result = await run(flow);

    assert.equal(result.status, 'Succeeded');

    // Find the foreach trace entry
    const foreachTrace = result.trace.find((t) => t.name === 'ForEachItem');
    assert.ok(foreachTrace, 'foreach trace entry should exist');
    assert.ok(foreachTrace.iterations, 'foreach should have iterations');
    assert.equal(foreachTrace.iterations.length, 3, 'should have 3 iterations');

    // Verify each iteration
    assert.equal(foreachTrace.iterations[0].index, 0);
    assert.equal(foreachTrace.iterations[0].item, 'a');
    assert.equal(foreachTrace.iterations[0].status, 'Succeeded');
    assert.ok(foreachTrace.iterations[0].actions.length > 0, 'iteration 0 should have actions');
    assert.equal(foreachTrace.iterations[0].actions[0].outputs, 'a');

    assert.equal(foreachTrace.iterations[1].index, 1);
    assert.equal(foreachTrace.iterations[1].item, 'b');
    assert.equal(foreachTrace.iterations[1].status, 'Succeeded');
    assert.equal(foreachTrace.iterations[1].actions[0].outputs, 'b');

    assert.equal(foreachTrace.iterations[2].index, 2);
    assert.equal(foreachTrace.iterations[2].item, 'c');
    assert.equal(foreachTrace.iterations[2].status, 'Succeeded');
    assert.equal(foreachTrace.iterations[2].actions[0].outputs, 'c');

    // Child action trace entries should NOT appear at top-level trace
    const topLevelCompose = result.trace.find((t) => t.name === 'ComposeItem');
    assert.equal(topLevelCompose, undefined, 'child compose should not be in top-level trace');
  });
});

describe('foreach iteration tracking via executeNode()', () => {
  it('should return iterations on the result', async () => {
    const foreachNode: Node = {
      id: 'fe_1',
      name: 'ForEachNum',
      type: 'foreach',
      itemsExpression: '@createArray(1, 2)',
      actions: [
        {
          id: 'act_1',
          name: 'ComposeNum',
          type: 'action',
          kind: 'compose',
          inputs: { value: "@items('ForEachNum')" },
        } as any,
      ],
    } as any;

    const ctx = makeContext();
    const result = await executeNode(foreachNode, ctx);

    assert.equal(result.status, 'Succeeded');
    assert.ok(result.iterations, 'should have iterations');
    assert.equal(result.iterations.length, 2, 'should have 2 iterations');

    assert.equal(result.iterations[0].index, 0);
    assert.equal(result.iterations[0].item, 1);
    assert.equal(result.iterations[0].status, 'Succeeded');
    assert.equal(result.iterations[0].actions.length, 1);
    assert.equal(result.iterations[0].actions[0].name, 'ComposeNum');
    assert.equal(result.iterations[0].actions[0].outputs, 1);

    assert.equal(result.iterations[1].index, 1);
    assert.equal(result.iterations[1].item, 2);
    assert.equal(result.iterations[1].status, 'Succeeded');
    assert.equal(result.iterations[1].actions[0].outputs, 2);
  });
});

describe('dountil iteration tracking via run()', () => {
  it('should track iterations with conditionResult', async () => {
    const flow: FlowIR = {
      name: 'dountil-test',
      nodes: [
        {
          id: 'trg_1',
          name: 'manual',
          type: 'trigger',
          inputs: { method: 'GET' },
        } as any,
        {
          id: 'act_init',
          name: 'InitCounter',
          type: 'action',
          kind: 'initializevariable',
          inputs: { variableName: 'counter', type: 'Integer', value: 0 },
        } as any,
        {
          id: 'du_1',
          name: 'LoopUntilDone',
          type: 'dountil',
          condition: "@greaterOrEquals(variables('counter'), 3)",
          limit: 10,
          actions: [
            {
              id: 'act_inc',
              name: 'IncrementCounter',
              type: 'action',
              kind: 'incrementvariable',
              inputs: { name: 'counter', value: 1 },
            } as any,
          ],
        } as any,
      ],
    };

    const result = await run(flow);

    assert.equal(result.status, 'Succeeded');

    // Find the dountil trace entry
    const doUntilTrace = result.trace.find((t) => t.name === 'LoopUntilDone');
    assert.ok(doUntilTrace, 'dountil trace entry should exist');
    assert.ok(doUntilTrace.iterations, 'dountil should have iterations');
    assert.equal(doUntilTrace.iterations.length, 3, 'should have 3 iterations');

    // First two iterations: condition is false (counter < 3)
    assert.equal(doUntilTrace.iterations[0].conditionResult, false);
    assert.equal(doUntilTrace.iterations[0].status, 'Succeeded');
    assert.ok(doUntilTrace.iterations[0].actions.length > 0, 'iteration 0 should have actions');

    assert.equal(doUntilTrace.iterations[1].conditionResult, false);
    assert.equal(doUntilTrace.iterations[1].status, 'Succeeded');

    // Last iteration: condition is true (counter >= 3)
    assert.equal(doUntilTrace.iterations[2].conditionResult, true);
    assert.equal(doUntilTrace.iterations[2].status, 'Succeeded');
  });
});

describe('dountil iteration tracking via executeNode()', () => {
  it('should return iterations on the result with conditionResult', async () => {
    const doUntilNode: Node = {
      id: 'du_1',
      name: 'LoopUntilDone',
      type: 'dountil',
      condition: "@greaterOrEquals(variables('counter'), 3)",
      limit: 10,
      actions: [
        {
          id: 'act_inc',
          name: 'IncrementCounter',
          type: 'action',
          kind: 'incrementvariable',
          inputs: { name: 'counter', value: 1 },
        } as any,
      ],
    } as any;

    const ctx = makeContext({ counter: 0 });
    const result = await executeNode(doUntilNode, ctx);

    assert.equal(result.status, 'Succeeded');
    assert.ok(result.iterations, 'should have iterations');
    assert.equal(result.iterations.length, 3, 'should have 3 iterations');

    // First two: condition false
    assert.equal(result.iterations[0].conditionResult, false);
    assert.equal(result.iterations[0].status, 'Succeeded');
    assert.equal(result.iterations[0].actions.length, 1);
    assert.equal(result.iterations[0].actions[0].name, 'IncrementCounter');

    assert.equal(result.iterations[1].conditionResult, false);
    assert.equal(result.iterations[1].status, 'Succeeded');

    // Last: condition true
    assert.equal(result.iterations[2].conditionResult, true);
    assert.equal(result.iterations[2].status, 'Succeeded');
  });
});

describe('nested foreach iteration tracking via run()', () => {
  it('should track outer and inner iterations correctly', async () => {
    const flow: FlowIR = {
      name: 'nested-foreach-test',
      nodes: [
        {
          id: 'trg_1',
          name: 'manual',
          type: 'trigger',
          inputs: { method: 'GET' },
        } as any,
        {
          id: 'fe_outer',
          name: 'OuterLoop',
          type: 'foreach',
          itemsExpression: "@createArray('x', 'y')",
          actions: [
            {
              id: 'fe_inner',
              name: 'InnerLoop',
              type: 'foreach',
              itemsExpression: '@createArray(1, 2)',
              actions: [
                {
                  id: 'act_compose',
                  name: 'ComposeInner',
                  type: 'action',
                  kind: 'compose',
                  inputs: { value: "@items('InnerLoop')" },
                } as any,
              ],
            } as any,
          ],
        } as any,
      ],
    };

    const result = await run(flow);

    assert.equal(result.status, 'Succeeded');

    // Find the outer foreach trace entry
    const outerTrace = result.trace.find((t) => t.name === 'OuterLoop');
    assert.ok(outerTrace, 'outer foreach trace entry should exist');
    assert.ok(outerTrace.iterations, 'outer foreach should have iterations');
    assert.equal(outerTrace.iterations.length, 2, 'outer loop should have 2 iterations');

    // Each outer iteration should contain the inner foreach trace entry
    for (let outerIdx = 0; outerIdx < 2; outerIdx++) {
      const outerIter: IterationTraceEntry = outerTrace.iterations![outerIdx];
      assert.equal(outerIter.index, outerIdx);
      assert.equal(outerIter.status, 'Succeeded');

      // The inner foreach trace entry should be in the outer iteration's actions
      const innerTrace = outerIter.actions.find((a) => a.name === 'InnerLoop');
      assert.ok(innerTrace, `inner foreach trace should exist in outer iteration ${outerIdx}`);
      assert.ok(innerTrace.iterations, `inner foreach should have iterations in outer iteration ${outerIdx}`);
      assert.equal(innerTrace.iterations.length, 2, `inner loop should have 2 iterations in outer iteration ${outerIdx}`);

      // Verify inner iterations
      assert.equal(innerTrace.iterations[0].index, 0);
      assert.equal(innerTrace.iterations[0].item, 1);
      assert.equal(innerTrace.iterations[0].status, 'Succeeded');

      assert.equal(innerTrace.iterations[1].index, 1);
      assert.equal(innerTrace.iterations[1].item, 2);
      assert.equal(innerTrace.iterations[1].status, 'Succeeded');
    }

    // Inner compose should NOT appear at top-level trace
    const topLevelCompose = result.trace.find((t) => t.name === 'ComposeInner');
    assert.equal(topLevelCompose, undefined, 'inner compose should not be in top-level trace');

    // Inner foreach should NOT appear at top-level trace
    const topLevelInner = result.trace.find((t) => t.name === 'InnerLoop');
    assert.equal(topLevelInner, undefined, 'inner foreach should not be in top-level trace');
  });
});
