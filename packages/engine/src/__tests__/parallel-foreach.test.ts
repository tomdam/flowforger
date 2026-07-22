import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, executeNode, type RunContext, type RunOptions, type TraceEntry, type IterationTraceEntry, type BaseConnector } from '../index.js';
import type { FlowIR, Node, ForeachNode } from '@flowforger/ir';

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

/** Build a minimal flow with a manual trigger and one or more body nodes */
function makeFlow(name: string, bodyNodes: Node[]): FlowIR {
  return {
    name,
    nodes: [
      {
        id: 'trg_1',
        name: 'manual',
        type: 'trigger',
        kind: 'manual',
        inputs: {},
      } as any,
      ...bodyNodes,
    ],
  };
}

/** Build a parallel foreach node */
function makeParallelForeach(opts: {
  id?: string;
  name?: string;
  itemsExpression: string;
  actions: Node[];
  parallel?: boolean;
  repetitions?: number;
}): Node {
  const node: any = {
    id: opts.id ?? 'fe_1',
    name: opts.name ?? 'ParallelLoop',
    type: 'foreach',
    itemsExpression: opts.itemsExpression,
    actions: opts.actions,
  };
  if (opts.parallel !== undefined) {
    node.parallel = opts.parallel;
  }
  if (opts.repetitions !== undefined) {
    node.runtimeConfiguration = {
      concurrency: { repetitions: opts.repetitions },
    };
  }
  return node as Node;
}

// ---------------------------------------------------------------------------
// 1. Basic parallel execution
// ---------------------------------------------------------------------------
describe('parallel foreach: basic parallel execution', () => {
  it('should execute 5 items with repetitions: 5, all succeed, trace has 5 entries', async () => {
    const foreachNode = makeParallelForeach({
      itemsExpression: "@createArray('a', 'b', 'c', 'd', 'e')",
      parallel: true,
      repetitions: 5,
      actions: [
        {
          id: 'act_1',
          name: 'ComposeItem',
          type: 'action',
          kind: 'compose',
          inputs: { value: "@items('ParallelLoop')" },
        } as any,
      ],
    });

    const flow = makeFlow('parallel-basic', [foreachNode]);
    const result = await run(flow);

    assert.equal(result.status, 'Succeeded');

    const foreachTrace = result.trace.find((t) => t.name === 'ParallelLoop');
    assert.ok(foreachTrace, 'foreach trace entry should exist');
    assert.ok(foreachTrace.iterations, 'foreach should have iterations');
    assert.equal(foreachTrace.iterations.length, 5, 'should have 5 iterations');

    // Verify iterations are in index order with correct items
    const expectedItems = ['a', 'b', 'c', 'd', 'e'];
    for (let i = 0; i < 5; i++) {
      assert.equal(foreachTrace.iterations[i].index, i, `iteration ${i} index`);
      assert.equal(foreachTrace.iterations[i].item, expectedItems[i], `iteration ${i} item`);
      assert.equal(foreachTrace.iterations[i].status, 'Succeeded', `iteration ${i} status`);
      assert.ok(foreachTrace.iterations[i].actions.length > 0, `iteration ${i} actions`);
      assert.equal(foreachTrace.iterations[i].actions[0].outputs, expectedItems[i], `iteration ${i} compose output`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Sequential backward compat
// ---------------------------------------------------------------------------
describe('parallel foreach: sequential backward compat', () => {
  it('should run sequentially when parallel flag is absent', async () => {
    const foreachNode = makeParallelForeach({
      itemsExpression: "@createArray(10, 20, 30)",
      // no parallel flag
      actions: [
        {
          id: 'act_1',
          name: 'ComposeVal',
          type: 'action',
          kind: 'compose',
          inputs: { value: "@items('ParallelLoop')" },
        } as any,
      ],
    });

    const flow = makeFlow('sequential-compat', [foreachNode]);
    const result = await run(flow);

    assert.equal(result.status, 'Succeeded');

    const foreachTrace = result.trace.find((t) => t.name === 'ParallelLoop');
    assert.ok(foreachTrace);
    assert.ok(foreachTrace.iterations);
    assert.equal(foreachTrace.iterations.length, 3);

    assert.equal(foreachTrace.iterations[0].item, 10);
    assert.equal(foreachTrace.iterations[1].item, 20);
    assert.equal(foreachTrace.iterations[2].item, 30);

    for (const iter of foreachTrace.iterations) {
      assert.equal(iter.status, 'Succeeded');
    }
  });

  it('should run sequentially when parallel is explicitly false', async () => {
    const foreachNode = makeParallelForeach({
      itemsExpression: "@createArray(1, 2)",
      parallel: false,
      actions: [
        {
          id: 'act_1',
          name: 'ComposeVal',
          type: 'action',
          kind: 'compose',
          inputs: { value: "@items('ParallelLoop')" },
        } as any,
      ],
    });

    const flow = makeFlow('sequential-explicit', [foreachNode]);
    const result = await run(flow);

    assert.equal(result.status, 'Succeeded');
    const foreachTrace = result.trace.find((t) => t.name === 'ParallelLoop');
    assert.ok(foreachTrace?.iterations);
    assert.equal(foreachTrace.iterations.length, 2);
  });
});

// ---------------------------------------------------------------------------
// 3. Default concurrency (20)
// ---------------------------------------------------------------------------
describe('parallel foreach: default concurrency', () => {
  it('should complete 25 items with parallel: true but no repetitions specified', async () => {
    // Build array expression for 25 items
    const items = Array.from({ length: 25 }, (_, i) => i);
    const itemsExpr = `@createArray(${items.join(', ')})`;

    const foreachNode = makeParallelForeach({
      itemsExpression: itemsExpr,
      parallel: true,
      // no repetitions -> default 20
      actions: [
        {
          id: 'act_1',
          name: 'ComposeIdx',
          type: 'action',
          kind: 'compose',
          inputs: { value: "@items('ParallelLoop')" },
        } as any,
      ],
    });

    const flow = makeFlow('default-concurrency', [foreachNode]);
    const result = await run(flow);

    assert.equal(result.status, 'Succeeded');

    const foreachTrace = result.trace.find((t) => t.name === 'ParallelLoop');
    assert.ok(foreachTrace?.iterations);
    assert.equal(foreachTrace.iterations.length, 25, 'all 25 items should complete');

    for (let i = 0; i < 25; i++) {
      assert.equal(foreachTrace.iterations[i].index, i);
      assert.equal(foreachTrace.iterations[i].item, i);
      assert.equal(foreachTrace.iterations[i].status, 'Succeeded');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Cap at 50
// ---------------------------------------------------------------------------
describe('parallel foreach: cap at 50', () => {
  it('should work even when repetitions: 100 (capped at 50)', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const itemsExpr = `@createArray(${items.join(', ')})`;

    const foreachNode = makeParallelForeach({
      itemsExpression: itemsExpr,
      parallel: true,
      repetitions: 100, // exceeds cap of 50
      actions: [
        {
          id: 'act_1',
          name: 'ComposeItem',
          type: 'action',
          kind: 'compose',
          inputs: { value: "@items('ParallelLoop')" },
        } as any,
      ],
    });

    const flow = makeFlow('cap-test', [foreachNode]);
    const result = await run(flow);

    assert.equal(result.status, 'Succeeded');

    const foreachTrace = result.trace.find((t) => t.name === 'ParallelLoop');
    assert.ok(foreachTrace?.iterations);
    assert.equal(foreachTrace.iterations.length, 10, 'all 10 items should complete');

    for (let i = 0; i < 10; i++) {
      assert.equal(foreachTrace.iterations[i].status, 'Succeeded');
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Sequential fallback with repetitions: 1
// ---------------------------------------------------------------------------
describe('parallel foreach: sequential fallback with repetitions: 1', () => {
  it('should behave sequentially when parallel: true but repetitions: 1', async () => {
    const executionOrder: number[] = [];

    // We use a mock connector to track execution order via ctx.iterationInfo
    const mockConnector: BaseConnector = {
      async invoke(_operation: string, _inputs: any, ctx: RunContext) {
        const idx = ctx.iterationInfo?.index ?? -1;
        executionOrder.push(idx);
        // Small delay to make interleaving detectable if parallel
        await new Promise((r) => setTimeout(r, 10));
        return { result: idx };
      },
    };

    const foreachNode = makeParallelForeach({
      itemsExpression: '@createArray(0, 1, 2)',
      parallel: true,
      repetitions: 1, // sequential fallback
      actions: [
        {
          id: 'act_1',
          name: 'ConnectorCall',
          type: 'connector',
          connector: 'testConnector',
          operation: 'doWork',
          params: {},
        } as any,
      ],
    });

    const flow = makeFlow('seq-fallback', [foreachNode]);
    const result = await run(flow, { connectors: { testConnector: mockConnector } });

    assert.equal(result.status, 'Succeeded');

    const foreachTrace = result.trace.find((t) => t.name === 'ParallelLoop');
    assert.ok(foreachTrace?.iterations);
    assert.equal(foreachTrace.iterations.length, 3);

    // With repetitions: 1, execution must be strictly sequential: 0, 1, 2
    assert.deepEqual(executionOrder, [0, 1, 2], 'items should execute in order (sequential)');
  });
});

// ---------------------------------------------------------------------------
// 6. Error stops new iterations
// ---------------------------------------------------------------------------
describe('parallel foreach: error stops new iterations', () => {
  it('should fail overall, finish in-flight, skip remaining when an item fails', async () => {
    let invocationCount = 0;

    // Use a connector mock that reads ctx.iterationInfo for the current index
    const mockConnector: BaseConnector = {
      async invoke(_operation: string, _inputs: any, ctx: RunContext) {
        invocationCount++;
        const idx = ctx.iterationInfo?.index ?? -1;
        // Give a small delay so concurrency window matters
        await new Promise((r) => setTimeout(r, 20));
        if (idx === 2) {
          throw new Error('Simulated failure on item 2');
        }
        return { result: idx };
      },
    };

    // 6 items, concurrency 2 -> batches: [0,1], [2,3], [4,5]
    // Item 2 fails -> items 4,5 should be skipped
    const foreachNode = makeParallelForeach({
      itemsExpression: '@createArray(0, 1, 2, 3, 4, 5)',
      parallel: true,
      repetitions: 2,
      actions: [
        {
          id: 'act_1',
          name: 'ConnectorCall',
          type: 'connector',
          connector: 'testConnector',
          operation: 'doWork',
          params: {},
        } as any,
      ],
    });

    const flow = makeFlow('error-stop', [foreachNode]);
    const result = await run(flow, { connectors: { testConnector: mockConnector } });

    assert.equal(result.status, 'Failed', 'overall status should be Failed');

    const foreachTrace = result.trace.find((t) => t.name === 'ParallelLoop');
    assert.ok(foreachTrace?.iterations);

    // Item 2 should be Failed
    const failedIter = foreachTrace.iterations.find((it: IterationTraceEntry) => it.item === 2);
    assert.ok(failedIter, 'item 2 iteration should exist');
    assert.equal(failedIter.status, 'Failed', 'item 2 should be Failed');

    // Some items should be Skipped (at least items 4 and 5)
    const skippedIters = foreachTrace.iterations.filter((it: IterationTraceEntry) => it.status === 'Skipped');
    assert.ok(skippedIters.length > 0, 'some iterations should be Skipped');

    // Total iterations should cover all 6 items
    assert.equal(foreachTrace.iterations.length, 6, 'all 6 iteration slots should be present');
  });
});

// ---------------------------------------------------------------------------
// 7. Isolated action outputs
// ---------------------------------------------------------------------------
describe('parallel foreach: isolated action outputs', () => {
  it('should not cross-contaminate action outputs between parallel iterations', async () => {
    const foreachNode = makeParallelForeach({
      itemsExpression: "@createArray('alpha', 'beta', 'gamma')",
      parallel: true,
      repetitions: 3,
      actions: [
        {
          id: 'act_1',
          name: 'ComposeItem',
          type: 'action',
          kind: 'compose',
          inputs: { value: "@items('ParallelLoop')" },
        } as any,
      ],
    });

    const flow = makeFlow('isolated-outputs', [foreachNode]);
    const result = await run(flow);

    assert.equal(result.status, 'Succeeded');

    const foreachTrace = result.trace.find((t) => t.name === 'ParallelLoop');
    assert.ok(foreachTrace?.iterations);
    assert.equal(foreachTrace.iterations.length, 3);

    // Each iteration's compose should have its own item, not another iteration's
    assert.equal(foreachTrace.iterations[0].actions[0].outputs, 'alpha', 'iteration 0 should output alpha');
    assert.equal(foreachTrace.iterations[1].actions[0].outputs, 'beta', 'iteration 1 should output beta');
    assert.equal(foreachTrace.iterations[2].actions[0].outputs, 'gamma', 'iteration 2 should output gamma');
  });
});

// ---------------------------------------------------------------------------
// 8. Variable mutations
// ---------------------------------------------------------------------------
describe('parallel foreach: variable mutations', () => {
  it('should not crash when incrementing a variable in parallel foreach body', async () => {
    const foreachNode = makeParallelForeach({
      itemsExpression: '@createArray(1, 2, 3, 4, 5)',
      parallel: true,
      repetitions: 5,
      actions: [
        {
          id: 'act_inc',
          name: 'IncrementCounter',
          type: 'action',
          kind: 'incrementvariable',
          inputs: { name: 'counter', value: 1 },
        } as any,
      ],
    });

    const flow = makeFlow('var-mutations', [
      {
        id: 'act_init',
        name: 'InitCounter',
        type: 'action',
        kind: 'initializevariable',
        inputs: { variableName: 'counter', type: 'Integer', value: 0 },
      } as any,
      foreachNode,
    ]);

    const result = await run(flow);

    // Should succeed (or at least not crash) - variable mutations in parallel
    // are allowed but unsafe in Power Automate
    assert.equal(result.status, 'Succeeded', 'flow should succeed');

    const foreachTrace = result.trace.find((t) => t.name === 'ParallelLoop');
    assert.ok(foreachTrace?.iterations);
    assert.equal(foreachTrace.iterations.length, 5, 'all 5 iterations should exist');

    for (const iter of foreachTrace.iterations) {
      assert.equal(iter.status, 'Succeeded', `iteration ${iter.index} should succeed`);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Debug hooks with iterationInfo
// ---------------------------------------------------------------------------
describe('parallel foreach: debug hooks with iterationInfo', () => {
  it('should set ctx.iterationInfo in onBeforeChildExecute callbacks', async () => {
    const capturedInfos: Array<{ loopName: string; index: number; item?: any }> = [];

    const foreachNode = makeParallelForeach({
      itemsExpression: "@createArray('x', 'y', 'z')",
      parallel: true,
      repetitions: 3,
      actions: [
        {
          id: 'act_1',
          name: 'ComposeItem',
          type: 'action',
          kind: 'compose',
          inputs: { value: "@items('ParallelLoop')" },
        } as any,
      ],
    });

    const flow = makeFlow('debug-hooks', [foreachNode]);
    const options: RunOptions = {
      onBeforeChildExecute: async (_node: Node, ctx: RunContext) => {
        if (ctx.iterationInfo) {
          capturedInfos.push({ ...ctx.iterationInfo });
        }
        return 'continue';
      },
    };

    const result = await run(flow, options);
    assert.equal(result.status, 'Succeeded');

    // Should have captured iterationInfo for each child action in each iteration
    assert.ok(capturedInfos.length >= 3, `expected at least 3 captured infos, got ${capturedInfos.length}`);

    // Verify the captured infos contain the right loop name and items
    const items = capturedInfos.map((info) => info.item);
    assert.ok(items.includes('x'), 'should capture item x');
    assert.ok(items.includes('y'), 'should capture item y');
    assert.ok(items.includes('z'), 'should capture item z');

    for (const info of capturedInfos) {
      assert.equal(info.loopName, 'ParallelLoop', 'loopName should match');
      assert.ok(typeof info.index === 'number', 'index should be a number');
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Debug hook stop
// ---------------------------------------------------------------------------
describe('parallel foreach: debug hook stop', () => {
  it('should skip remaining iterations when hook returns stop on iteration 2', async () => {
    let hookCallCount = 0;

    const foreachNode = makeParallelForeach({
      itemsExpression: '@createArray(0, 1, 2, 3, 4)',
      parallel: true,
      repetitions: 1, // sequential so stop is deterministic
      actions: [
        {
          id: 'act_1',
          name: 'ComposeItem',
          type: 'action',
          kind: 'compose',
          inputs: { value: "@items('ParallelLoop')" },
        } as any,
      ],
    });

    const flow = makeFlow('debug-stop', [foreachNode]);
    const options: RunOptions = {
      onBeforeChildExecute: async (_node: Node, ctx: RunContext) => {
        hookCallCount++;
        // Stop when we reach iteration index 2
        if (ctx.iterationInfo && ctx.iterationInfo.index === 2) {
          return 'stop';
        }
        return 'continue';
      },
    };

    const result = await run(flow, options);

    // The overall foreach (or flow) should indicate failure/stop
    const foreachTrace = result.trace.find((t) => t.name === 'ParallelLoop');
    assert.ok(foreachTrace, 'foreach trace should exist');

    // Iterations 0 and 1 should have succeeded
    if (foreachTrace.iterations) {
      const succeededIters = foreachTrace.iterations.filter((it) => it.status === 'Succeeded');
      assert.ok(succeededIters.length >= 2, 'at least iterations 0 and 1 should succeed');

      // Iteration 2 should be Failed (stopped by hook) or the loop should have stopped
      // Items 3 and 4 should be Skipped if parallel implementation tracks them
      const iter2 = foreachTrace.iterations.find((it) => it.index === 2);
      if (iter2) {
        assert.equal(iter2.status, 'Failed', 'iteration 2 should be Failed (stopped by hook)');
      }
    }

    // The hook should not have been called for iterations after the stopped one's child action
    // (iterations 0, 1 each have 1 child + iteration 2 stopped = 3 calls max)
    assert.ok(hookCallCount <= 3, `hook called ${hookCallCount} times, expected <= 3`);
  });
});

// ---------------------------------------------------------------------------
// 11. Nested foreach: outer sequential, inner parallel
// ---------------------------------------------------------------------------
describe('parallel foreach: nested foreach', () => {
  it('should execute outer sequential, inner parallel correctly', async () => {
    const innerForeach = makeParallelForeach({
      id: 'fe_inner',
      name: 'InnerLoop',
      itemsExpression: '@createArray(1, 2, 3)',
      parallel: true,
      repetitions: 3,
      actions: [
        {
          id: 'act_inner',
          name: 'ComposeInner',
          type: 'action',
          kind: 'compose',
          inputs: { value: "@items('InnerLoop')" },
        } as any,
      ],
    });

    const outerForeach: Node = {
      id: 'fe_outer',
      name: 'OuterLoop',
      type: 'foreach',
      itemsExpression: "@createArray('A', 'B')",
      actions: [innerForeach],
    } as any;

    const flow = makeFlow('nested-foreach', [outerForeach]);
    const result = await run(flow);

    assert.equal(result.status, 'Succeeded');

    // Find outer foreach trace
    const outerTrace = result.trace.find((t) => t.name === 'OuterLoop');
    assert.ok(outerTrace, 'outer foreach trace should exist');
    assert.ok(outerTrace.iterations, 'outer foreach should have iterations');
    assert.equal(outerTrace.iterations.length, 2, 'outer loop should have 2 iterations');

    for (let outerIdx = 0; outerIdx < 2; outerIdx++) {
      const outerIter: IterationTraceEntry = outerTrace.iterations[outerIdx];
      assert.equal(outerIter.index, outerIdx);
      assert.equal(outerIter.status, 'Succeeded');

      // Inner foreach should be in the outer iteration's actions
      const innerTrace = outerIter.actions.find((a: TraceEntry) => a.name === 'InnerLoop');
      assert.ok(innerTrace, `inner foreach should exist in outer iteration ${outerIdx}`);
      assert.ok(innerTrace.iterations, `inner foreach should have iterations in outer iteration ${outerIdx}`);
      assert.equal(innerTrace.iterations.length, 3, `inner loop should have 3 iterations`);

      // Verify inner iterations
      for (let innerIdx = 0; innerIdx < 3; innerIdx++) {
        assert.equal(innerTrace.iterations[innerIdx].index, innerIdx);
        assert.equal(innerTrace.iterations[innerIdx].item, innerIdx + 1);
        assert.equal(innerTrace.iterations[innerIdx].status, 'Succeeded');
        // Each inner iteration should have the compose output matching the item
        assert.equal(
          innerTrace.iterations[innerIdx].actions[0].outputs,
          innerIdx + 1,
          `inner iteration ${innerIdx} compose output`,
        );
      }
    }

    // Inner items should NOT appear at top-level trace
    const topLevelInner = result.trace.find((t) => t.name === 'InnerLoop');
    assert.equal(topLevelInner, undefined, 'inner foreach should not be in top-level trace');
  });
});
