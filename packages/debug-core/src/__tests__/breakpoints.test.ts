import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR } from '@flowforger/ir';
import type { DslSourceMap } from '@flowforger/dsl-native';
import { DebugSession } from '../debug-session.js';
import { createInMemoryHost } from './test-host.js';

const FILE = 'test-flow.ff.ts';

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
    const runner = new DebugSession(
      { key: FILE, ir: makeFlow(), sourceMap: makeSourceMap(), dslCode: null },
      createInMemoryHost(),
      {},                    // no connectors — compose actions don't need any
      {},
      {},
      false,
      harness.callbacks,
    );

    // Breakpoint on ComposeA set before launch (adapter sends full list)
    runner.setBreakpointsForSource(FILE, [{ nodeId: 'act_a', line: 10 }]);

    const firstStop = harness.nextStop();
    void runner.start();

    const stop1 = await firstStop;
    assert.equal(stop1.reason, 'breakpoint');
    assert.equal(stop1.nodeId, 'act_a');

    // While paused, user adds a breakpoint on ComposeB. VS Code sends the
    // FULL breakpoint list for the file, which the adapter forwards verbatim.
    runner.setBreakpointsForSource(FILE, [
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
    const runner = new DebugSession(
      { key: FILE, ir: makeFlow(), sourceMap: makeSourceMap(), dslCode: null },
      createInMemoryHost(),
      {},                    // no connectors — compose actions don't need any
      {},
      {},
      true, // stopOnEntry — pause at first action with NO breakpoints registered
      harness.callbacks,
    );

    const firstStop = harness.nextStop();
    void runner.start();

    const stop1 = await firstStop;
    assert.equal(stop1.nodeId, 'act_a');

    // File had no breakpoint entry at all when the loop captured the map
    runner.setBreakpointsForSource(FILE, [{ nodeId: 'act_c', line: 12 }]);

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

const CHILD_KEY = 'child-flow.ff.ts';

/** Root flow whose second statement calls a child flow. */
function makeParentFlow(): FlowIR {
  return {
    name: 'parent',
    nodes: [
      { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
      { id: 'act_call', name: 'Call_child', type: 'action', kind: 'workflow',
        inputs: { workflowReferenceName: CHILD_KEY, body: {} } } as any,
      { id: 'act_after', name: 'ComposeAfter', type: 'action', kind: 'compose', inputs: { value: 'after' } } as any,
    ],
  };
}

/** Child flow with two statements. Node ids deliberately collide with nothing. */
function makeChildFlow(): FlowIR {
  return {
    name: 'child',
    nodes: [
      { id: 'ctrg_1', name: 'childManual', type: 'trigger', inputs: { method: 'GET' } } as any,
      { id: 'cact_1', name: 'ChildComposeOne', type: 'action', kind: 'compose', inputs: { value: '1' } } as any,
      { id: 'cact_2', name: 'ChildComposeTwo', type: 'action', kind: 'compose', inputs: { value: '2' } } as any,
    ],
  };
}

describe('breakpoints registered for a child flow after its frame is pushed', () => {
  it('pauses inside the running child frame', async () => {
    const harness = createHarness();
    const child = {
      key: CHILD_KEY,
      ir: makeChildFlow(),
      sourceMap: null,
      dslCode: null,
    };
    const runner = new DebugSession(
      { key: FILE, ir: makeParentFlow(), sourceMap: makeSourceMap(), dslCode: null },
      createInMemoryHost({ [CHILD_KEY]: child }),
      {},
      {},
      {},
      true, // stopOnEntry
      harness.callbacks,
    );

    // Pause on entry (Call_child is the first executable statement).
    const firstStop = harness.nextStop();
    void runner.start();
    const stop1 = await firstStop;
    assert.equal(stop1.nodeId, 'act_call');

    // Step into the child: pauses at the child's first statement, which means
    // the child frame — and its live breakpoint map — already exist.
    const childStop = harness.nextStop();
    runner.setWantStepIn(true);
    runner.resume('step');
    const stop2 = await childStop;
    assert.equal(stop2.nodeId, 'cact_1');
    assert.equal(runner.getCallStackDepth(), 1, 'expected to be paused inside the child frame');

    // Register a breakpoint for the CHILD's source only now — after the frame
    // was pushed. This is the contract the web child-breakpoint feature rests
    // on: getBreakpointsForKey hands out a live map that the frame holds by
    // reference, so late additions are visible to the running child.
    runner.setBreakpointsForSource(CHILD_KEY, [{ nodeId: 'cact_2', line: 0 }]);

    const secondStop = harness.nextStop();
    runner.setWantStepIn(false);
    runner.resume('continue');

    const outcome = await Promise.race([
      secondStop.then((s) => ({ kind: 'stopped' as const, stop: s })),
      harness.untilTerminated().then(() => ({ kind: 'terminated' as const })),
    ]);

    assert.equal(
      outcome.kind,
      'stopped',
      'run finished without hitting the child breakpoint registered after the frame was pushed',
    );
    if (outcome.kind === 'stopped') {
      assert.equal(outcome.stop.reason, 'breakpoint');
      assert.equal(outcome.stop.nodeId, 'cact_2');
    }

    runner.resume('continue');
    await harness.untilTerminated();
  });
});
