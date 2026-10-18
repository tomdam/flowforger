import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR } from '@flowforger/ir';
import type { DslSourceMap } from '@flowforger/dsl-native';
import type { ExecuteNodeResult } from '@flowforger/engine';
import { DebugSession } from '../debug-session.js';
import type { DebugSessionOptions } from '../debug-session.js';
import { createInMemoryHost } from './test-host.js';

/**
 * Replaying a cloud run in the debugger: `DebugSessionOptions.mocks` (pins) reach the engine
 * for top-level and nested nodes, and `DebugSessionOptions.guard` (safe mode) pauses the session
 * before an external action with its resolved inputs, so the host can let it run live or stop.
 */

const emptySourceMap: DslSourceMap = {
  lineToNodeId: new Map(),
  nodeIdToLines: new Map() as DslSourceMap['nodeIdToLines'],
  breakpointableLines: new Set(),
};

const getItems = (id: string, name: string, table: string) => ({
  id, name, type: 'connector', connector: 'sharepoint', operation: 'GetItems', params: { dataset: 'https://x', table },
});

/** trigger + Get_top (connector) + foreach(2){ Get_inner (connector) } + Done (compose) */
function makeFlow(): FlowIR {
  return {
    name: 'mocks-test',
    nodes: [
      { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
      getItems('con_top', 'Get_top', 'top') as any,
      {
        id: 'fe_1', name: 'Each', type: 'foreach', itemsExpression: "@createArray('x','y')", runtimeConfiguration: { concurrency: { repetitions: 1 } },
        actions: [getItems('con_inner', 'Get_inner', 'inner') as any],
        runAfter: { Get_top: ['Succeeded'] },
      } as any,
      { id: 'act_done', name: 'Done', type: 'action', kind: 'compose', inputs: { value: "@body('Get_top')?['value']" }, runAfter: { Each: ['Succeeded'] } } as any,
    ],
  };
}

interface Executed { name: string; result: ExecuteNodeResult }

function runSession(
  ir: FlowIR,
  opts: DebugSessionOptions & {
    connectors?: Record<string, any>;
    onPaused: (session: DebugSession, nodeId: string, reason: string) => void;
  },
): Promise<{ executed: Executed[]; session: DebugSession }> {
  return new Promise((resolve) => {
    const executed: Executed[] = [];
    const session: DebugSession = new DebugSession(
      { key: 'mocks-test', ir, sourceMap: emptySourceMap, dslCode: null },
      createInMemoryHost(),
      opts.connectors ?? {},
      {},
      {},
      false,
      {
        onStopped: (reason, nodeId) => queueMicrotask(() => opts.onPaused(session, nodeId, reason)),
        onOutput: () => {},
        onTerminated: () => resolve({ executed, session }),
        onNodeExecuted: (node, result) => executed.push({ name: node.name, result }),
      },
      undefined,
      { mocks: opts.mocks, guard: opts.guard },
    );
    void session.start();
  });
}

describe('DebugSessionOptions.mocks', () => {
  it('a mock resolver stands in for top-level and nested nodes, per iteration, without a connector', async () => {
    const { executed, session } = await runSession(makeFlow(), {
      mocks: (node, ctx) => {
        if (node.name === 'Get_top') return { outputs: { statusCode: 200, body: { value: ['pinned'] } } };
        if (node.name === 'Get_inner') return { outputs: { statusCode: 200, body: { i: ctx.iterationStack?.[0]?.index } } };
        return undefined;
      },
      onPaused: (s) => s.resume('continue'),
    });
    assert.deepEqual(session.getRunOutcome(), { status: 'Succeeded' });
    const top = executed.find((e) => e.name === 'Get_top')!;
    assert.equal(top.result.mocked, true);
    assert.deepEqual(executed.filter((e) => e.name === 'Get_inner').map((e) => [e.result.mocked, e.result.outputs.body.i]), [[true, 0], [true, 1]]);
    assert.deepEqual(executed.find((e) => e.name === 'Done')!.result.outputs, ['pinned']);
  });

  it('a mocked failure is a real failure for the session outcome', async () => {
    const sharepoint = { async invoke() { return { value: [] }; } };
    const { session } = await runSession(makeFlow(), {
      connectors: { sharepoint },
      mocks: (node) => (node.name === 'Get_top' ? { status: 'Failed', code: 'NotFound', outputs: { statusCode: 404, body: {} } } : undefined),
      onPaused: (s) => s.resume('continue'),
    });
    assert.equal(session.getRunOutcome()?.status, 'Failed');
  });
});

describe('DebugSessionOptions.guard', () => {
  it("pauses before an external action with reason 'guard' and its resolved inputs; continue runs it live", async () => {
    const seen: string[] = [];
    const sharepoint = { async invoke(_op: string, inputs: any) { seen.push(inputs.table); return { value: ['live'] }; } };
    const pauses: Array<{ nodeId: string; reason: string; call: any }> = [];
    const { executed, session } = await runSession(makeFlow(), {
      connectors: { sharepoint },
      mocks: (node) => (node.name === 'Get_inner' ? { outputs: { statusCode: 200, body: {} } } : undefined),
      guard: (node) => (node.name === 'Get_top' ? 'pause' : 'continue'),
      onPaused: (s, nodeId, reason) => {
        pauses.push({ nodeId, reason, call: s.getPausedCall() });
        s.resume('continue');
      },
    });
    assert.deepEqual(pauses, [{ nodeId: 'con_top', reason: 'guard', call: { nodeId: 'con_top', name: 'Get_top', inputs: { dataset: 'https://x', table: 'top' }, iterationPath: [] } }]);
    assert.deepEqual(seen, ['top'], 'Get_top ran live after the resume; Get_inner was mocked');
    assert.equal(session.getPausedCall(), null);
    assert.equal(session.getRunOutcome()?.status, 'Succeeded');
    assert.equal(executed.find((e) => e.name === 'Get_top')!.result.mocked, undefined);
  });

  it('a guard pause inside a loop reports the iteration path', async () => {
    const paths: unknown[] = [];
    const sharepoint = { async invoke() { return { value: [] }; } };
    await runSession(makeFlow(), {
      connectors: { sharepoint },
      mocks: (node) => (node.name === 'Get_top' ? { outputs: { statusCode: 200, body: { value: [] } } } : undefined),
      guard: (node) => (node.name === 'Get_inner' ? 'pause' : 'continue'),
      onPaused: (s) => {
        paths.push(s.getPausedCall()?.iterationPath);
        s.resume('continue');
      },
    });
    assert.deepEqual(paths, [[{ scopeName: 'Each', itemIndex: 0 }], [{ scopeName: 'Each', itemIndex: 1 }]]);
  });

  it('stop at a guard pause ends the session before the action runs', async () => {
    const seen: string[] = [];
    const sharepoint = { async invoke(_op: string, inputs: any) { seen.push(inputs.table); return { value: [] }; } };
    const { executed, session } = await runSession(makeFlow(), {
      connectors: { sharepoint },
      guard: () => 'pause',
      onPaused: (s) => s.stop(),
    });
    assert.deepEqual(seen, []);
    assert.equal(executed.find((e) => e.name === 'Get_top'), undefined, 'nothing after the stop ran');
    assert.equal(session.getRunOutcome(), null, 'a stopped session has no outcome');
  });

  it('the guard is not consulted for a mocked action', async () => {
    const guarded: string[] = [];
    const { session } = await runSession(makeFlow(), {
      mocks: () => ({ outputs: { statusCode: 200, body: { value: [] } } }),
      guard: (node) => { guarded.push(node.name); return 'pause'; },
      onPaused: (s) => s.resume('continue'),
    });
    assert.deepEqual(guarded, []);
    assert.equal(session.getRunOutcome()?.status, 'Succeeded');
  });
});
