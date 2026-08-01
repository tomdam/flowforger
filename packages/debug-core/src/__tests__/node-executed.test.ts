import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR } from '@flowforger/ir';
import type { DslSourceMap } from '@flowforger/dsl-native';
import { DebugSession } from '../debug-session.js';
import { createInMemoryHost } from './test-host.js';

function makeFlow(): FlowIR {
  return {
    name: 'exec-test',
    nodes: [
      { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
      { id: 'act_a', name: 'ComposeA', type: 'action', kind: 'compose', inputs: { value: 'a' } } as any,
      {
        id: 'if_1',
        name: 'Check',
        type: 'if',
        condition: '@equals(1, 1)',
        actions: [
          { id: 'act_then', name: 'ComposeThen', type: 'action', kind: 'compose', inputs: { value: 't' } } as any,
        ],
        elseActions: [
          { id: 'act_else', name: 'ComposeElse', type: 'action', kind: 'compose', inputs: { value: 'e' } } as any,
        ],
      } as any,
    ],
  };
}

const emptySourceMap: DslSourceMap = {
  lineToNodeId: new Map(),
  nodeIdToLines: new Map() as DslSourceMap['nodeIdToLines'],
  breakpointableLines: new Set(),
};

describe('onNodeExecuted callback', () => {
  it('fires for every executed node (incl. taken if-branch children) with results, not for skipped ones', async () => {
    const executed: Array<{ id: string; status: string; frameKey: string }> = [];
    let terminated: () => void;
    const done = new Promise<void>((res) => (terminated = res));

    const runner = new DebugSession(
      { key: 'exec-test.ff.ts', ir: makeFlow(), sourceMap: emptySourceMap, dslCode: null },
      createInMemoryHost(),
      {},
      {},
      {},
      false,
      {
        onStopped: () => {},
        onOutput: () => {},
        onTerminated: () => terminated(),
        onNodeExecuted: (node, result, frameKey) => {
          executed.push({ id: node.id, status: result.status, frameKey });
        },
      },
    );

    await runner.start();
    await done;

    const ids = executed.map((e) => e.id);
    assert.ok(ids.includes('act_a'), 'top-level action missing');
    assert.ok(ids.includes('if_1'), 'if node missing');
    assert.ok(ids.includes('act_then'), 'taken-branch child missing');
    assert.ok(!ids.includes('act_else'), 'skipped branch must not fire onNodeExecuted');
    assert.ok(executed.every((e) => e.frameKey === 'exec-test.ff.ts'));
    assert.ok(executed.every((e) => e.status === 'Succeeded'));
  });
});
