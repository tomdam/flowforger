import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR } from '@flowforger/ir';
import type { DslSourceMap } from '@flowforger/dsl-native';
import { DebugSession } from '../debug-session.js';
import { createInMemoryHost } from './test-host.js';

function makeFlow(): FlowIR {
  return {
    name: 'iter-test',
    nodes: [
      { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
      {
        id: 'fe_1',
        name: 'For_each',
        type: 'foreach',
        itemsExpression: "@createArray('x','y')",
        actions: [
          { id: 'act_in', name: 'ComposeInner', type: 'action', kind: 'compose', inputs: { value: '@item()' } } as any,
        ],
      } as any,
      { id: 'act_after', name: 'ComposeAfter', type: 'action', kind: 'compose', inputs: { value: 'done' } } as any,
    ],
  };
}

function makeSourceMap(): DslSourceMap {
  return {
    lineToNodeId: new Map([[10, 'fe_1'], [11, 'act_in'], [13, 'act_after']]),
    nodeIdToLines: new Map([
      ['fe_1', { startLine: 10, endLine: 12 }],
      ['act_in', { startLine: 11, endLine: 11 }],
      ['act_after', { startLine: 13, endLine: 13 }],
    ]) as DslSourceMap['nodeIdToLines'],
    breakpointableLines: new Set([10, 11, 13]),
  };
}

function createHarness() {
  const stops: Array<{ reason: string; nodeId: string }> = [];
  let stopWaiters: Array<(s: { reason: string; nodeId: string }) => void> = [];
  let terminatedWaiters: Array<() => void> = [];
  let terminated = false;
  return {
    stops,
    callbacks: {
      onStopped: (reason: string, nodeId: string) => {
        const evt = { reason, nodeId };
        stops.push(evt);
        const w = stopWaiters;
        stopWaiters = [];
        for (const r of w) r(evt);
      },
      onOutput: () => {},
      onTerminated: () => {
        terminated = true;
        const w = terminatedWaiters;
        terminatedWaiters = [];
        for (const r of w) r();
      },
    },
    nextStop: () => new Promise<{ reason: string; nodeId: string }>((res) => stopWaiters.push(res)),
    untilTerminated: () => new Promise<void>((res) => (terminated ? res() : terminatedWaiters.push(res))),
  };
}

describe('iteration context tracking', () => {
  it('reports loop node, name, and index while paused inside foreach iterations, null outside', async () => {
    const harness = createHarness();
    const runner = new DebugSession(
      { key: 'iter-test.ff.ts', ir: makeFlow(), sourceMap: makeSourceMap(), dslCode: null },
      createInMemoryHost(),
      {},
      {},
      {},
      false,
      harness.callbacks,
    );
    // Breakpoint inside the loop body
    runner.setBreakpointsForSource('iter-test.ff.ts', [{ nodeId: 'act_in', line: 11 }]);

    const stop1 = harness.nextStop();
    void runner.start();

    // First iteration (index 0)
    const s1 = await Promise.race([
      stop1.then((s) => ({ kind: 'stopped' as const, stop: s })),
      harness.untilTerminated().then(() => ({ kind: 'terminated' as const })),
    ]);
    assert.equal(s1.kind, 'stopped', 'flow terminated before hitting first breakpoint');
    if (s1.kind === 'stopped') {
      assert.equal(s1.stop.nodeId, 'act_in');
      const iter1 = runner.getIterationContext();
      assert.ok(iter1, 'no iteration context on first iteration pause');
      assert.equal(iter1!.parentNodeId, 'fe_1');
      assert.equal(iter1!.parentNodeName, 'For_each');
      assert.equal(iter1!.iterationIndex, 0);
    }

    // Second iteration (index 1)
    const stop2 = harness.nextStop();
    runner.resume('continue');
    const s2 = await Promise.race([
      stop2.then((s) => ({ kind: 'stopped' as const, stop: s })),
      harness.untilTerminated().then(() => ({ kind: 'terminated' as const })),
    ]);
    assert.equal(s2.kind, 'stopped', 'flow terminated before hitting second breakpoint');
    if (s2.kind === 'stopped') {
      assert.equal(s2.stop.nodeId, 'act_in');
      assert.equal(runner.getIterationContext()!.iterationIndex, 1);
    }

    // After the loop: stepping pauses on ComposeAfter with NO iteration context
    const stop3 = harness.nextStop();
    runner.resume('step');
    const s3 = await Promise.race([
      stop3.then((s) => ({ kind: 'stopped' as const, stop: s })),
      harness.untilTerminated().then(() => ({ kind: 'terminated' as const })),
    ]);
    assert.equal(s3.kind, 'stopped', 'flow terminated before stepping to ComposeAfter');
    if (s3.kind === 'stopped') {
      assert.equal(s3.stop.nodeId, 'act_after');
      assert.equal(runner.getIterationContext(), null);
    }

    runner.resume('continue');
    await harness.untilTerminated();
  });
});
