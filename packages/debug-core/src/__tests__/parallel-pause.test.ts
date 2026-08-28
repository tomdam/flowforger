import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR } from '@flowforger/ir';
import { DebugSession } from '../debug-session.js';
import { createInMemoryHost } from './test-host.js';

const KEY = 'parallel-pause-test';

/**
 * A foreach with concurrency: up to two iteration lanes execute at once, so
 * two lanes can reach a loop-body breakpoint concurrently. Regression flow for
 * the stranded-resolver hang: waitForResume holds a single resolver, and a
 * second concurrent pause used to overwrite the first lane's resolver — that
 * lane then never resolved, runWithConcurrency never completed, and the
 * session could neither stop nor finish (web UI stuck on "Running…").
 */
function makeParallelLoopFlow(): FlowIR {
  return {
    name: KEY,
    nodes: [
      { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
      {
        id: 'fe_1',
        name: 'For_each',
        type: 'foreach',
        itemsExpression: '@createArray(1,2,3,4)',
        runtimeConfiguration: { concurrency: { repetitions: 2 } },
        actions: [
          { id: 'act_inner', name: 'ComposeInner', type: 'action', kind: 'compose', inputs: { value: 'x' } } as any,
        ],
      } as any,
      { id: 'act_after', name: 'ComposeAfter', type: 'action', kind: 'compose', inputs: { value: 'done' } } as any,
    ],
  };
}

interface StopEvent {
  reason: string;
  nodeId: string;
}

/**
 * Records stop/terminate events as awaitable promises, and asserts pauses are
 * serialized: a second onStopped before the previous pause was resumed means
 * the single resumeResolver slot was clobbered (the pre-fix bug).
 */
function createHarness() {
  const stops: StopEvent[] = [];
  let stopWaiters: Array<(s: StopEvent) => void> = [];
  let terminated = false;
  let terminatedWaiters: Array<() => void> = [];
  let pauseOutstanding = false;

  const callbacks = {
    onStopped: (reason: string, nodeId: string) => {
      assert.equal(
        pauseOutstanding,
        false,
        'a second pause was raised before the previous one was resumed (resolver clobbered)',
      );
      pauseOutstanding = true;
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

  const nextStop = () => new Promise<StopEvent>((resolve) => stopWaiters.push(resolve));
  const untilTerminated = () =>
    new Promise<void>((resolve) => {
      if (terminated) resolve();
      else terminatedWaiters.push(resolve);
    });
  const noteResumed = () => {
    pauseOutstanding = false;
  };

  return { callbacks, stops, nextStop, untilTerminated, noteResumed, isTerminated: () => terminated };
}

const tick = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

function raceTermination(harness: ReturnType<typeof createHarness>, ms = 3000): Promise<'terminated' | 'timeout'> {
  return Promise.race([
    harness.untilTerminated().then(() => 'terminated' as const),
    tick(ms).then(() => 'timeout' as const),
  ]);
}

describe('parallel foreach pauses', () => {
  it('stop() at a breakpoint inside a parallel foreach terminates the session', async () => {
    const harness = createHarness();
    const session = new DebugSession(
      { key: KEY, ir: makeParallelLoopFlow(), sourceMap: null, dslCode: null },
      createInMemoryHost(),
      {},
      {},
      {},
      false,
      harness.callbacks,
    );
    session.setBreakpointsForSource(KEY, [{ nodeId: 'act_inner', line: 5 }]);

    const firstStop = harness.nextStop();
    void session.start();
    const stop1 = await firstStop;
    assert.equal(stop1.reason, 'breakpoint');
    assert.equal(stop1.nodeId, 'act_inner');

    // Give the second lane time to reach the breakpoint too (it must queue on
    // the pause gate, not raise a second pause — the harness asserts that).
    await tick(50);

    harness.noteResumed();
    session.stop();

    const outcome = await raceTermination(harness);
    assert.equal(outcome, 'terminated', 'session hung after stop() at a parallel-loop breakpoint');
  });

  it('continue drives every lane through its breakpoint hit, one pause at a time', async () => {
    const harness = createHarness();
    const session = new DebugSession(
      { key: KEY, ir: makeParallelLoopFlow(), sourceMap: null, dslCode: null },
      createInMemoryHost(),
      {},
      {},
      {},
      false,
      harness.callbacks,
    );
    session.setBreakpointsForSource(KEY, [{ nodeId: 'act_inner', line: 5 }]);

    let nextStop = harness.nextStop();
    void session.start();

    // Resume through every pause until the run completes; guard against the
    // pre-fix hang where a stranded lane keeps the session alive forever.
    const deadline = tick(5000).then(() => 'deadline' as const);
    for (;;) {
      const outcome = await Promise.race([
        nextStop.then((s) => ({ kind: 'stopped' as const, stop: s })),
        harness.untilTerminated().then(() => ({ kind: 'terminated' as const })),
        deadline.then(() => ({ kind: 'deadline' as const })),
      ]);
      if (outcome.kind === 'deadline') {
        assert.fail('session neither paused nor terminated (stranded lane)');
      }
      if (outcome.kind === 'terminated') break;
      assert.equal(outcome.stop.reason, 'breakpoint');
      assert.equal(outcome.stop.nodeId, 'act_inner');
      nextStop = harness.nextStop();
      harness.noteResumed();
      session.resume('continue');
    }

    // One breakpoint pause per iteration — no lane lost, none doubled.
    assert.equal(harness.stops.length, 4);
  });
});
