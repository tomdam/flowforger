import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR } from '@flowforger/ir';
import type { DslSourceMap } from '@flowforger/dsl-native';
import { DebugSession } from '../debug-session.js';
import { FastForwardController } from '../fast-forward.js';
import { ConnectorCallLog, wrapConnectorsForRecording, wrapConnectorsForReplay } from '../replay.js';
import { createInMemoryHost } from './test-host.js';
import type { BaseConnector } from '@flowforger/engine';

const emptySourceMap: DslSourceMap = {
  lineToNodeId: new Map(),
  nodeIdToLines: new Map() as DslSourceMap['nodeIdToLines'],
  breakpointableLines: new Set(),
};

describe('FastForwardController (unit)', () => {
  const node = (name: string) => ({ id: 'x', name, type: 'action' }) as any;

  it('pauses before the target at the right hit count, then deactivates', () => {
    let count = 0;
    const arrived: string[] = [];
    const c = new FastForwardController(
      { nodeName: 'Set_x', hitCount: 2 },
      { countOf: () => count, isRootFrame: () => true, onArrived: (r) => arrived.push(r) },
    );
    count = 0; assert.equal(c.shouldPauseBefore(node('Set_x')), false);
    count = 1; assert.equal(c.shouldPauseBefore(node('Set_x')), false);
    assert.equal(c.shouldPauseBefore(node('Other')), false);
    count = 2; assert.equal(c.shouldPauseBefore(node('Set_x')), true);
    assert.equal(c.active, false);
    assert.deepEqual(arrived, ['target']);
    // Inactive controller never pauses again
    assert.equal(c.shouldPauseBefore(node('Set_x')), false);
  });

  it('ignores target-name matches outside the root frame', () => {
    const c = new FastForwardController(
      { nodeName: 'Set_x', hitCount: 0 },
      { countOf: () => 0, isRootFrame: () => false },
    );
    assert.equal(c.shouldPauseBefore(node('Set_x')), false);
    assert.equal(c.active, true);
  });

  it('divergence pauses at the next consulted node', () => {
    const arrived: string[] = [];
    const c = new FastForwardController(
      { nodeName: 'Never', hitCount: 0 },
      { countOf: () => 0, isRootFrame: () => true, onArrived: (r) => arrived.push(r) },
    );
    c.noteDivergence();
    assert.equal(c.shouldPauseBefore(node('Anything')), true);
    assert.equal(c.active, false);
    assert.deepEqual(arrived, ['divergence']);
  });

  it('null target never pauses on names, only on divergence', () => {
    const c = new FastForwardController(null, { countOf: () => 0, isRootFrame: () => true });
    assert.equal(c.shouldPauseBefore(node('X')), false);
    c.noteDivergence();
    assert.equal(c.shouldPauseBefore(node('X')), true);
  });
});

class CountingConnector implements BaseConnector {
  invocations: Array<{ operation: string; inputs: any }> = [];
  constructor(private respond: (operation: string, inputs: any) => any) {}
  async invoke(operation: string, inputs: any): Promise<any> {
    this.invocations.push({ operation, inputs });
    return this.respond(operation, inputs);
  }
}

/** trigger → connector GetItems → Compose_after → connector GetMore (never reached before pause) */
function recordedFlow(composeValue: string, getItemsList: string): FlowIR {
  return {
    name: 'ff-e2e',
    nodes: [
      { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
      { id: 'con_1', name: 'Get_items', type: 'connector', connector: 'sp', operation: 'GetItems', params: { list: getItemsList } } as any,
      { id: 'act_1', name: 'Compose_after', type: 'action', kind: 'compose', inputs: { value: composeValue } } as any,
      { id: 'con_2', name: 'Get_more', type: 'connector', connector: 'sp', operation: 'GetMore', params: { q: 1 } } as any,
    ],
  };
}

interface SessionRun {
  pausedAt: string[];
  executionCounts: Map<string, number>;
  done: Promise<void>;
  session: DebugSession;
}

function launchSession(opts: {
  ir: FlowIR;
  connectors: Record<string, BaseConnector>;
  breakpoints?: string[];
  sessionOptions?: import('../debug-session.js').DebugSessionOptions;
  onPaused: (run: SessionRun, nodeId: string) => void;
}): SessionRun {
  const run = {} as SessionRun;
  run.pausedAt = [];
  run.executionCounts = new Map();
  run.done = new Promise<void>((resolve) => {
    run.session = new DebugSession(
      { key: opts.ir.name, ir: opts.ir, sourceMap: emptySourceMap, dslCode: null },
      createInMemoryHost(),
      opts.connectors,
      {},
      {},
      false,
      {
        // Deferred via queueMicrotask: DebugSession calls onStopped synchronously
        // then synchronously awaits waitForResume() on the next line. A resume()
        // issued in the same tick (before that await runs) arrives before the
        // resolver exists and is silently dropped, hanging the run. See
        // session-options.test.ts for the same pattern.
        onStopped: (_reason, nodeId) => queueMicrotask(() => {
          run.pausedAt.push(nodeId);
          opts.onPaused(run, nodeId);
        }),
        onOutput: () => {},
        onTerminated: () => resolve(),
        onNodeExecuted: (node) => {
          run.executionCounts.set(node.name, (run.executionCounts.get(node.name) ?? 0) + 1);
        },
      },
      undefined,
      opts.sessionOptions,
    );
    if (opts.breakpoints) {
      run.session.setBreakpointsForSource(opts.ir.name, opts.breakpoints.map((nodeId) => ({ nodeId, line: 1 })));
    }
    // Deferred via queueMicrotask: several call sites construct the
    // FastForwardController AFTER calling launchSession() (the controller's
    // deps close over `run2`, which only exists once launchSession returns).
    // shouldPauseBefore is consulted synchronously on the very first
    // non-trigger node, before any await point inside the engine — so
    // starting the session in the same tick would read `controller` (or
    // `run2`) before the caller's synchronous assignment runs. Deferring by
    // one microtask lets the calling test finish its synchronous setup first.
    queueMicrotask(() => {
      void run.session.start();
    });
  });
  return run;
}

describe('fast-forward end-to-end', () => {
  it('replays the recorded connector call, pauses at the previous position, and lands with a changed pure action applied', async () => {
    const fake = new CountingConnector(() => [{ id: 1 }]);
    const recording = new ConnectorCallLog();

    // --- Original run: breakpoint on Compose_after (pause-before => it has NOT executed) ---
    const run1 = launchSession({
      ir: recordedFlow('old', 'ListA'),
      connectors: wrapConnectorsForRecording({ sp: fake }, recording),
      breakpoints: ['act_1'],
      onPaused: (run) => {
        // Simulate "apply": capture state and stop the old session.
        run.session.stop();
      },
    });
    await run1.done;

    assert.deepEqual(run1.pausedAt, ['act_1']);
    assert.equal(fake.invocations.length, 1, 'GetItems ran live once in the original run');
    assert.equal(recording.calls.length, 1);
    const targetHitCount = run1.executionCounts.get('Compose_after') ?? 0; // 0 — paused before it

    // --- Fast-forward run on "edited" IR (compose value changed — a pure edit) ---
    const newLog = new ConnectorCallLog();
    let controller!: FastForwardController;
    const run2 = launchSession({
      ir: recordedFlow('NEW', 'ListA'),
      connectors: wrapConnectorsForReplay({ sp: fake }, recording, newLog, {
        onDivergence: () => controller.noteDivergence(),
      }),
      sessionOptions: {
        shouldPauseBefore: (n) => controller.shouldPauseBefore(n),
        suppressBreakpoints: () => controller.active,
      },
      onPaused: (run, nodeId) => {
        if (nodeId === 'act_1' && !controller.active) {
          // Arrived. Continue to let the flow finish (Get_more goes live post-target).
          run.session.resume('continue');
        } else {
          run.session.resume('continue');
        }
      },
    });
    controller = new FastForwardController(
      { nodeName: 'Compose_after', hitCount: targetHitCount },
      { countOf: (n) => run2.executionCounts.get(n) ?? 0, isRootFrame: () => run2.session.getCallStackDepth() === 0 },
    );
    await run2.done;

    assert.deepEqual(run2.pausedAt, ['act_1'], 'paused exactly once, at the previous position');
    // GetItems must NOT have run live again; Get_more runs live once (it is past the pause point)
    assert.equal(fake.invocations.filter((i) => i.operation === 'GetItems').length, 1);
    assert.equal(fake.invocations.filter((i) => i.operation === 'GetMore').length, 1);
    assert.equal(run2.session.getContext().actions.get('Compose_after')?.outputs, 'NEW', 'edit applied');
    assert.equal(newLog.calls.length, 2, 'fast-forward run re-recorded both calls for a second apply');
  });

  it('pauses at the same foreach iteration', async () => {
    const flowWithLoop: FlowIR = {
      name: 'ff-loop',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        {
          id: 'fe_1', name: 'ForEach_item', type: 'foreach', itemsExpression: "@createArray('a','b','c')",
          actions: [
            { id: 'act_in', name: 'Compose_in', type: 'action', kind: 'compose', inputs: { value: "@item()" } } as any,
          ],
        } as any,
      ],
    };

    // Original run: break inside the loop, resume once, "apply" while paused before iteration 2 (index 1)
    let applied = false;
    let targetHitCount = 0;
    const run1 = launchSession({
      ir: flowWithLoop,
      connectors: {},
      breakpoints: ['act_in'],
      onPaused: (run) => {
        if (!applied && (run.executionCounts.get('Compose_in') ?? 0) === 1) {
          applied = true;
          targetHitCount = run.executionCounts.get('Compose_in') ?? 0; // 1
          run.session.stop();
        } else {
          run.session.resume('continue');
        }
      },
    });
    await run1.done;
    assert.equal(targetHitCount, 1);

    // Fast-forward: must pause before Compose_in's 2nd execution (iteration index 1)
    let controller!: FastForwardController;
    const iterationAtPause: Array<number | null> = [];
    const run2 = launchSession({
      ir: flowWithLoop,
      connectors: {},
      sessionOptions: {
        shouldPauseBefore: (n) => controller.shouldPauseBefore(n),
        suppressBreakpoints: () => controller.active,
      },
      onPaused: (run) => {
        iterationAtPause.push(run.session.getIterationContext()?.iterationIndex ?? null);
        run.session.resume('continue');
      },
    });
    controller = new FastForwardController(
      { nodeName: 'Compose_in', hitCount: targetHitCount },
      { countOf: (n) => run2.executionCounts.get(n) ?? 0, isRootFrame: () => run2.session.getCallStackDepth() === 0 },
    );
    await run2.done;

    assert.deepEqual(run2.pausedAt, ['act_in']);
    assert.deepEqual(iterationAtPause, [1], 'paused at iteration index 1 (the 2nd iteration)');
  });

  it('divergence: changed connector inputs execute live and pause at the next node', async () => {
    const fake = new CountingConnector(() => [{ id: 99 }]);
    const recording = new ConnectorCallLog();
    recording.record('sp', 'GetItems', { list: 'ListA' }, [{ id: 1 }]);

    let controller!: FastForwardController;
    const run = launchSession({
      ir: recordedFlow('v', 'ListB'), // edited: list changed A -> B upstream of the old pause point
      connectors: wrapConnectorsForReplay({ sp: fake }, recording, new ConnectorCallLog(), {
        onDivergence: () => controller.noteDivergence(),
      }),
      sessionOptions: {
        shouldPauseBefore: (n) => controller.shouldPauseBefore(n),
        suppressBreakpoints: () => controller.active,
      },
      onPaused: (r) => r.session.resume('continue'),
    });
    controller = new FastForwardController(
      { nodeName: 'Compose_after', hitCount: 0 },
      { countOf: (n) => run.executionCounts.get(n) ?? 0, isRootFrame: () => run.session.getCallStackDepth() === 0 },
    );
    await run.done;

    assert.equal(fake.invocations.length, 2, 'GetItems (diverged) and GetMore both ran live');
    // Divergence happened inside Get_items; the pause lands before the NEXT node (Compose_after),
    // which here coincides with the target — either way exactly one pause at act_1.
    assert.deepEqual(run.pausedAt, ['act_1']);
  });

  it('deleted target: runs to completion without pausing, controller stays active', async () => {
    const controllerDeps = { countOf: () => 0, isRootFrame: () => true };
    const controller = new FastForwardController({ nodeName: 'No_such_node', hitCount: 0 }, controllerDeps);
    // Pre-populate the log with entries matching this flow's actual connector
    // calls (recordedFlow('v', 'ListA') -> GetItems{list:'ListA'}, GetMore{q:1})
    // so replay hits both and no divergence fires. That means
    // controller.shouldPauseBefore is genuinely consulted for every real node
    // (Get_items, Compose_after, Get_more) and never matches 'No_such_node' —
    // making `pausedAt === []` and `active === true` real evidence the
    // controller works, not a vacuous pass from a short-circuited wiring.
    const fake = new CountingConnector(() => []);
    const recording = new ConnectorCallLog();
    recording.record('sp', 'GetItems', { list: 'ListA' }, [{ id: 1 }]);
    recording.record('sp', 'GetMore', { q: 1 }, [{ id: 2 }]);
    const run = launchSession({
      ir: recordedFlow('v', 'ListA'),
      connectors: wrapConnectorsForReplay(
        { sp: fake },
        recording,
        new ConnectorCallLog(),
        { onDivergence: () => controller.noteDivergence() },
      ),
      sessionOptions: {
        shouldPauseBefore: (n) => controller.shouldPauseBefore(n),
        suppressBreakpoints: () => controller.active,
      },
      onPaused: (r) => r.session.resume('continue'),
    });
    await run.done;
    assert.deepEqual(run.pausedAt, [], 'never paused');
    assert.equal(controller.active, true, 'host can detect target-not-reached at termination');
    assert.equal(fake.invocations.length, 0, 'both connector calls replayed from the log — no live invocation');
  });
});
