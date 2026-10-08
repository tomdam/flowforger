import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR, Node } from '@flowforger/ir';
import type { TraceEntry } from '@flowforger/engine';
import type { DslSourceMap } from '@flowforger/dsl-native';
import { DebugSession } from '../debug-session.js';
import { createInMemoryHost } from './test-host.js';

// The debugger's own top-level loop follows runAfter and Terminate exactly like run():
// a catch scope only runs when the try failed, nothing runs after a Terminate, and the
// session reports the run's status.

const FILE = 'run-after.ff.ts';
const emptySourceMap: DslSourceMap = {
  lineToNodeId: new Map(),
  nodeIdToLines: new Map() as DslSourceMap['nodeIdToLines'],
  breakpointableLines: new Set(),
};
const compose = (name: string, value: any, extra: object = {}): Node =>
  ({ id: `act_${name}`, name, type: 'action', kind: 'compose', inputs: { value }, ...extra }) as any;
const scope = (name: string, actions: Node[], extra: object = {}): Node =>
  ({ id: `scp_${name}`, name, type: 'scope', actions, ...extra }) as any;
const after = (name: string, ...statuses: string[]) => ({ runAfter: { [name]: statuses } });

/** Try / Catch / Finally, where Try fails when `failing` is set. */
function tryCatchFlow(failing: boolean): FlowIR {
  return {
    name: 'try-catch',
    nodes: [
      { id: 'trg_1', name: 'manual', type: 'trigger', inputs: {} } as any,
      scope('Try', [compose('Work', failing ? '@div(1, 0)' : 'ok')]),
      scope('Catch', [compose('Handle', 'handled')], after('Try', 'Failed')),
      scope('Finally', [compose('Cleanup', 'done')], after('Catch', 'Succeeded', 'Failed', 'Skipped')),
    ],
  };
}

function launch(ir: FlowIR, breakpoints: Array<{ nodeId: string; line: number }> = []) {
  const stops: string[] = [];
  const skipped: Array<{ name: string; entry: TraceEntry }> = [];
  const output: string[] = [];
  let onStop: ((nodeId: string) => void) | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const session = new DebugSession(
    { key: FILE, ir, sourceMap: emptySourceMap, dslCode: null },
    createInMemoryHost(),
    {},
    {},
    {},
    false,
    {
      // Deferred: onStopped fires before waitForResume() installs the resolver.
      onStopped: (_reason, nodeId) =>
        queueMicrotask(() => {
          stops.push(nodeId);
          onStop?.(nodeId);
        }),
      onOutput: (text) => output.push(text),
      onTerminated: () => resolveDone(),
      onNodeSkipped: (node, entry) => skipped.push({ name: node.name, entry }),
    },
  );
  session.setBreakpointsForSource(FILE, breakpoints);
  return {
    session,
    stops,
    skipped,
    output,
    done,
    /** Resolves at the next pause; wire it before starting/resuming. */
    nextStop: () => new Promise<string>((r) => (onStop = (id) => ((onStop = null), r(id)))),
  };
}

describe('debug session: runAfter at the top level', () => {
  it('skips the catch scope, and what is inside it, when the try succeeded', async () => {
    const run = launch(tryCatchFlow(false));
    void run.session.start();
    await run.done;

    const ctx = run.session.getRootContext();
    assert.equal(ctx.actions.get('Catch')?.status, 'Skipped');
    assert.equal(ctx.actions.get('Catch')?.cloudError?.code, 'ActionConditionFailed');
    assert.equal(ctx.actions.get('Handle')?.status, 'Skipped');
    assert.equal(ctx.actions.get('Cleanup')?.status, 'Succeeded');
    assert.deepEqual(run.skipped.map((s) => s.name), ['Catch']);
    assert.deepEqual(run.skipped[0].entry.children?.map((c) => [c.name, c.status]), [['Handle', 'Skipped']]);
    assert.ok(run.output.some((l) => l.startsWith("Skipped: Catch — The execution of template action 'Catch' is skipped")));
    assert.deepEqual(run.session.getRunOutcome(), { status: 'Succeeded' });
  });

  it('runs the catch scope when the try failed, and the handled failure leaves the run Succeeded', async () => {
    const run = launch(tryCatchFlow(true));
    void run.session.start();
    await run.done;

    const ctx = run.session.getRootContext();
    assert.equal(ctx.actions.get('Try')?.status, 'Failed');
    assert.equal(ctx.actions.get('Handle')?.status, 'Succeeded');
    assert.equal(ctx.actions.get('Cleanup')?.status, 'Succeeded');
    assert.deepEqual(run.skipped, []);
    assert.deepEqual(run.session.getRunOutcome(), { status: 'Succeeded' });
  });

  it('reports an uncaught failure as a Failed run', async () => {
    const run = launch({
      name: 'uncaught',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: {} } as any,
        compose('Bad', '@div(1, 0)'),
        compose('Next', 'never', after('Bad', 'Succeeded')),
      ],
    });
    void run.session.start();
    await run.done;

    assert.equal(run.session.getRootContext().actions.get('Next')?.status, 'Skipped');
    assert.equal(run.session.getRunOutcome()?.status, 'Failed');
    assert.ok(run.output.includes('Flow execution completed: Failed'));
  });

  it('does not stop at a breakpoint on a skipped node', async () => {
    const run = launch(tryCatchFlow(false), [{ nodeId: 'scp_Catch', line: 5 }]);
    void run.session.start();
    await run.done;
    assert.deepEqual(run.stops, []);
  });

  it('runs the node Set Next Statement moved to, even when its runAfter is not met', async () => {
    const run = launch(tryCatchFlow(false), [{ nodeId: 'scp_Finally', line: 7 }]);
    const atFinally = run.nextStop();
    void run.session.start();
    assert.equal(await atFinally, 'scp_Finally');

    const atCatch = run.nextStop();
    assert.equal(run.session.jumpTo('scp_Catch').ok, true);
    assert.equal(await atCatch, 'scp_Catch'); // jump-then-pause
    const finallyAgain = run.nextStop();
    run.session.resume('continue');
    assert.equal(await finallyAgain, 'scp_Finally'); // the breakpoint, after Catch ran
    run.session.resume('continue');
    await run.done;

    const ctx = run.session.getRootContext();
    assert.equal(ctx.actions.get('Handle')?.status, 'Succeeded');
    assert.equal(ctx.actions.get('Cleanup')?.status, 'Succeeded');
  });
});

describe('debug session: Terminate', () => {
  it('ends the run with the Terminate status, skipping everything after it', async () => {
    const run = launch(
      {
        name: 'terminate',
        nodes: [
          { id: 'trg_1', name: 'manual', type: 'trigger', inputs: {} } as any,
          scope('Work', [
            compose('Before', 1),
            { id: 'act_stop', name: 'Stop', type: 'action', kind: 'terminate', inputs: { runStatus: 'Failed', runError: { code: 'E1', message: 'bad input' } } } as any,
            compose('InnerAfter', 2),
          ]),
          compose('OuterAfter', 3),
        ],
      },
      [{ nodeId: 'act_OuterAfter', line: 9 }],
    );
    void run.session.start();
    await run.done;

    const ctx = run.session.getRootContext();
    assert.equal(ctx.actions.get('Stop')?.status, 'Succeeded');
    assert.equal(ctx.actions.get('Work')?.status, 'Cancelled');
    assert.equal(ctx.actions.get('InnerAfter')?.status, 'Skipped');
    assert.equal(ctx.actions.get('OuterAfter')?.status, 'Skipped');
    assert.equal(ctx.actions.get('OuterAfter')?.code, 'Terminated');
    assert.deepEqual(run.stops, []); // the breakpoint after the Terminate is never reached
    assert.deepEqual(run.skipped.map((s) => s.name), ['OuterAfter']);
    assert.deepEqual(run.session.getRunOutcome(), { status: 'Failed', error: { code: 'E1', message: 'bad input' } });
    assert.ok(run.output.includes('Flow execution completed: Failed — bad input'));
  });
});
