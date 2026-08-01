import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR } from '@flowforger/ir';
import type { DslSourceMap } from '@flowforger/dsl-native';
import { DebugSession } from '../debug-session.js';
import { createInMemoryHost } from './test-host.js';

const emptySourceMap: DslSourceMap = {
  lineToNodeId: new Map(),
  nodeIdToLines: new Map() as DslSourceMap['nodeIdToLines'],
  breakpointableLines: new Set(),
};

/** trigger + ComposeA + foreach(2 items){ComposeInner} + ComposeB */
function makeFlow(): FlowIR {
  return {
    name: 'opts-test',
    nodes: [
      { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
      { id: 'act_a', name: 'ComposeA', type: 'action', kind: 'compose', inputs: { value: 'a' } } as any,
      {
        id: 'fe_1', name: 'ForEach_item', type: 'foreach', itemsExpression: "@createArray('x','y')",
        actions: [
          { id: 'act_inner', name: 'ComposeInner', type: 'action', kind: 'compose', inputs: { value: 'i' } } as any,
        ],
      } as any,
      { id: 'act_b', name: 'ComposeB', type: 'action', kind: 'compose', inputs: { value: 'b' } } as any,
    ],
  };
}

function runSession(
  ir: FlowIR,
  opts: {
    shouldPauseBefore?: (node: any) => boolean;
    suppressBreakpoints?: () => boolean;
    breakpoints?: string[];
    onNodeExecuted?: (node: any) => void;
    onPaused: (session: DebugSession, nodeId: string, reason: string) => void;
  },
): Promise<void> {
  return new Promise((resolve) => {
    const session: DebugSession = new DebugSession(
      { key: 'opts-test', ir, sourceMap: emptySourceMap, dslCode: null },
      createInMemoryHost(),
      {},
      {},
      {},
      false,
      {
        // Deferred via queueMicrotask: DebugSession calls onStopped synchronously,
        // then synchronously awaits waitForResume() on the next line. A resume()
        // issued in the very same tick (before that await runs) would arrive
        // before the resolver exists and be silently dropped, hanging the test.
        // Real callers (DAP/web) are inherently async here (wire round-trip); this
        // harness defers by one microtask to match that same-turn-after ordering.
        onStopped: (reason, nodeId) => queueMicrotask(() => opts.onPaused(session, nodeId, reason)),
        onOutput: () => {},
        onTerminated: () => resolve(),
        onNodeExecuted: (node) => opts.onNodeExecuted?.(node),
      },
      undefined,
      { shouldPauseBefore: opts.shouldPauseBefore, suppressBreakpoints: opts.suppressBreakpoints },
    );
    if (opts.breakpoints) {
      session.setBreakpointsForSource('opts-test', opts.breakpoints.map((nodeId) => ({ nodeId, line: 1 })));
    }
    void session.start();
  });
}

describe('DebugSessionOptions', () => {
  it('shouldPauseBefore pauses before a top-level node with reason step', async () => {
    const pauses: string[] = [];
    await runSession(makeFlow(), {
      shouldPauseBefore: (node) => node.name === 'ComposeB',
      onPaused: (session, nodeId, reason) => {
        pauses.push(`${nodeId}:${reason}`);
        session.resume('continue');
      },
    });
    assert.deepEqual(pauses, ['act_b:step']);
  });

  it('shouldPauseBefore pauses before a nested foreach child on a chosen iteration', async () => {
    let innerSeen = 0;
    const pausedAt: Array<{ nodeId: string; iteration: number | null }> = [];
    await runSession(makeFlow(), {
      // Pause before ComposeInner's 2nd execution (iteration index 1)
      shouldPauseBefore: (node) => node.name === 'ComposeInner' && innerSeen === 1,
      onNodeExecuted: (node) => {
        if (node.name === 'ComposeInner') innerSeen++;
      },
      onPaused: (session, nodeId) => {
        pausedAt.push({ nodeId, iteration: session.getIterationContext()?.iterationIndex ?? null });
        session.resume('continue');
      },
    });
    assert.equal(pausedAt.length, 1);
    assert.equal(pausedAt[0].nodeId, 'act_inner');
    assert.equal(pausedAt[0].iteration, 1);
  });

  it('suppressBreakpoints disables breakpoint pauses', async () => {
    const pauses: string[] = [];
    await runSession(makeFlow(), {
      breakpoints: ['act_a', 'act_b'],
      suppressBreakpoints: () => true,
      onPaused: (session, nodeId) => {
        pauses.push(nodeId);
        session.resume('continue');
      },
    });
    assert.deepEqual(pauses, []);
  });

  it('breakpoints still fire when suppressBreakpoints returns false', async () => {
    const pauses: string[] = [];
    await runSession(makeFlow(), {
      breakpoints: ['act_b'],
      suppressBreakpoints: () => false,
      onPaused: (session, nodeId, reason) => {
        pauses.push(`${nodeId}:${reason}`);
        session.resume('continue');
      },
    });
    assert.deepEqual(pauses, ['act_b:breakpoint']);
  });

  it('reports reason step (not breakpoint) when a breakpointed node is also a shouldPauseBefore target while suppressBreakpoints is true (top-level path)', async () => {
    const pauses: string[] = [];
    await runSession(makeFlow(), {
      breakpoints: ['act_b'],
      shouldPauseBefore: (node) => node.name === 'ComposeB',
      suppressBreakpoints: () => true,
      onPaused: (session, nodeId, reason) => {
        pauses.push(`${nodeId}:${reason}`);
        session.resume('continue');
      },
    });
    assert.deepEqual(pauses, ['act_b:step']);
  });
});

describe('onBeforeChildExecute reason under suppression (v1 review gap)', () => {
  it("reports 'step' when a suppressed breakpoint coincides with shouldPauseBefore on a loop child", async () => {
    const ir: FlowIR = {
      name: 'combo',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        {
          id: 'fe_1', name: 'ForEach_item', type: 'foreach', itemsExpression: "@createArray('a')",
          actions: [
            { id: 'act_in', name: 'Compose_in', type: 'action', kind: 'compose', inputs: { value: '@item()' } } as any,
          ],
        } as any,
      ],
    };
    const reasons: string[] = [];
    let pausedOnce = false;
    let session!: DebugSession;
    await new Promise<void>((resolve) => {
      session = new DebugSession(
        { key: ir.name, ir, sourceMap: emptySourceMap, dslCode: null },
        createInMemoryHost(),
        {},
        {},
        {},
        false,
        {
          onStopped: (reason) => queueMicrotask(() => {
            reasons.push(reason);
            session.resume('continue');
          }),
          onOutput: () => {},
          onTerminated: () => resolve(),
        },
        undefined,
        {
          shouldPauseBefore: (n) => {
            if (n.id === 'act_in' && !pausedOnce) {
              pausedOnce = true;
              return true;
            }
            return false;
          },
          suppressBreakpoints: () => true,
        },
      );
      session.setBreakpointsForSource(ir.name, [{ nodeId: 'act_in', line: 1 }]);
      queueMicrotask(() => void session.start());
    });
    assert.deepEqual(reasons, ['step'], "suppressed breakpoint must not claim the pause reason");
  });
});
