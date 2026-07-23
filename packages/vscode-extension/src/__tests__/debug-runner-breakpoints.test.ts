import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import type { FlowIR } from '@flowforger/ir';
import type { DslSourceMap } from '@flowforger/dsl-native';
import { FlowForgerDebugRunner } from '../debug-runner.js';

const FILE = path.resolve(process.cwd(), 'test-flow.ff.ts');

function makeFlow(): FlowIR {
  return {
    name: 'bp-test',
    nodes: [
      { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
      { id: 'act_a', name: 'ComposeA', type: 'action', kind: 'compose', inputs: { value: 'a' } } as any,
      { id: 'act_b', name: 'ComposeB', type: 'action', kind: 'compose', inputs: { value: 'b' } } as any,
      { id: 'act_c', name: 'ComposeC', type: 'action', kind: 'compose', inputs: { value: 'c' } } as any,
    ],
  };
}

function makeSourceMap(): DslSourceMap {
  return {
    lineToNodeId: new Map([
      [10, 'act_a'],
      [11, 'act_b'],
      [12, 'act_c'],
    ]),
    nodeIdToLines: new Map([
      ['act_a', { startLine: 10, endLine: 10 }],
      ['act_b', { startLine: 11, endLine: 11 }],
      ['act_c', { startLine: 12, endLine: 12 }],
    ]) as DslSourceMap['nodeIdToLines'],
    breakpointableLines: new Set([10, 11, 12]),
  };
}

interface StopEvent {
  reason: string;
  nodeId: string;
}

/** Drives the runner and records stop/terminate events as awaitable promises. */
function createHarness() {
  const stops: StopEvent[] = [];
  let stopWaiters: Array<(s: StopEvent) => void> = [];
  let terminated = false;
  let terminatedWaiters: Array<() => void> = [];

  const callbacks = {
    onStopped: (reason: string, nodeId: string) => {
      const evt = { reason, nodeId };
      stops.push(evt);
      const waiters = stopWaiters;
      stopWaiters = [];
      for (const w of waiters) w(evt);
    },
    onOutput: () => {},
    onTerminated: () => {
      terminated = true;
      const waiters = terminatedWaiters;
      terminatedWaiters = [];
      for (const w of waiters) w();
    },
  };

  const nextStop = () =>
    new Promise<StopEvent>((resolve) => stopWaiters.push(resolve));
  const untilTerminated = () =>
    new Promise<void>((resolve) => {
      if (terminated) resolve();
      else terminatedWaiters.push(resolve);
    });

  return { callbacks, stops, nextStop, untilTerminated, isTerminated: () => terminated };
}

describe('debug runner breakpoints added mid-run', () => {
  it('hits a breakpoint added while paused at an earlier breakpoint', async () => {
    const harness = createHarness();
    const runner = new FlowForgerDebugRunner(
      makeFlow(),
      makeSourceMap(),
      FILE,
      {},
      {},
      false,
      {},
      harness.callbacks,
    );

    // Breakpoint on ComposeA set before launch (adapter sends full list)
    runner.setBreakpointsForFile(FILE, [{ nodeId: 'act_a', line: 10 }]);

    const firstStop = harness.nextStop();
    void runner.start();

    const stop1 = await firstStop;
    assert.equal(stop1.reason, 'breakpoint');
    assert.equal(stop1.nodeId, 'act_a');

    // While paused, user adds a breakpoint on ComposeB. VS Code sends the
    // FULL breakpoint list for the file, which the adapter forwards verbatim.
    runner.setBreakpointsForFile(FILE, [
      { nodeId: 'act_a', line: 10 },
      { nodeId: 'act_b', line: 11 },
    ]);

    const secondStop = harness.nextStop();
    runner.resume('continue');

    // Expect: execution pauses at ComposeB. Bug: flow runs to completion instead.
    const outcome = await Promise.race([
      secondStop.then((s) => ({ kind: 'stopped' as const, stop: s })),
      harness.untilTerminated().then(() => ({ kind: 'terminated' as const })),
    ]);

    assert.equal(
      outcome.kind,
      'stopped',
      'flow terminated without hitting the breakpoint added while paused',
    );
    if (outcome.kind === 'stopped') {
      assert.equal(outcome.stop.reason, 'breakpoint');
      assert.equal(outcome.stop.nodeId, 'act_b');
    }

    // Clean up: let the flow finish
    runner.resume('continue');
    await harness.untilTerminated();
  });

  it('hits a breakpoint added mid-run in a file that had none at launch', async () => {
    const harness = createHarness();
    const runner = new FlowForgerDebugRunner(
      makeFlow(),
      makeSourceMap(),
      FILE,
      {},
      {},
      true, // stopOnEntry — pause at first action with NO breakpoints registered
      {},
      harness.callbacks,
    );

    const firstStop = harness.nextStop();
    void runner.start();

    const stop1 = await firstStop;
    assert.equal(stop1.nodeId, 'act_a');

    // File had no breakpoint entry at all when the loop captured the map
    runner.setBreakpointsForFile(FILE, [{ nodeId: 'act_c', line: 12 }]);

    const secondStop = harness.nextStop();
    runner.resume('continue');

    const outcome = await Promise.race([
      secondStop.then((s) => ({ kind: 'stopped' as const, stop: s })),
      harness.untilTerminated().then(() => ({ kind: 'terminated' as const })),
    ]);

    assert.equal(
      outcome.kind,
      'stopped',
      'flow terminated without hitting the breakpoint added while paused',
    );
    if (outcome.kind === 'stopped') {
      assert.equal(outcome.stop.nodeId, 'act_c');
    }

    runner.resume('continue');
    await harness.untilTerminated();
  });
});
