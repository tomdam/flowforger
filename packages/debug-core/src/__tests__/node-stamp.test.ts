import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR } from '@flowforger/ir';
import type { DslSourceMap } from '@flowforger/dsl-native';
import { DebugSession } from '../debug-session.js';
import { ConnectorCallLog, wrapConnectorsForRecording } from '../replay.js';
import { createInMemoryHost } from './test-host.js';

const emptySourceMap: DslSourceMap = {
  lineToNodeId: new Map(),
  nodeIdToLines: new Map() as DslSourceMap['nodeIdToLines'],
  breakpointableLines: new Set(),
};

describe('current-executing-node stamping', () => {
  it('stamps recorded calls with the executing node name, including loop-body children', async () => {
    const ir: FlowIR = {
      name: 'stamp',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        { id: 'con_1', name: 'Get_items', type: 'connector', connector: 'sp', operation: 'GetItems', params: { list: 'A' } } as any,
        {
          id: 'fe_1', name: 'ForEach_item', type: 'foreach', itemsExpression: "@createArray('a','b')",
          actions: [
            { id: 'con_2', name: 'Tag_item', type: 'connector', connector: 'sp', operation: 'Tag', params: { v: '@item()' } } as any,
          ],
        } as any,
      ],
    };
    const log = new ConnectorCallLog();
    const fake = { invoke: async () => ({ ok: true }) } as any;
    let session!: DebugSession;
    const connectors = wrapConnectorsForRecording({ sp: fake }, log, () => session.getCurrentExecutingNodeName());

    await new Promise<void>((resolve) => {
      session = new DebugSession(
        { key: ir.name, ir, sourceMap: emptySourceMap, dslCode: null },
        createInMemoryHost(),
        connectors,
        {},
        {},
        false,
        {
          onStopped: () => queueMicrotask(() => session.resume('continue')),
          onOutput: () => {},
          onTerminated: () => resolve(),
        },
      );
      queueMicrotask(() => void session.start());
    });

    assert.deepEqual(
      log.calls.map((c) => c.nodeName),
      ['Get_items', 'Tag_item', 'Tag_item'],
    );
    assert.equal(session.getCurrentExecutingNodeName(), null, 'null after the run');
  });

  it('returns null while paused at an engine-hook pause (console calls stamp null)', async () => {
    const ir: FlowIR = {
      name: 'stamp-paused',
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
    let session!: DebugSession;
    const namesAtPause: Array<string | null> = [];
    await new Promise<void>((resolve) => {
      session = new DebugSession(
        { key: ir.name, ir, sourceMap: emptySourceMap, dslCode: null },
        createInMemoryHost(),
        {},
        {},
        {},
        false,
        {
          onStopped: () => queueMicrotask(() => {
            namesAtPause.push(session.getCurrentExecutingNodeName());
            session.resume('continue');
          }),
          onOutput: () => {},
          onTerminated: () => resolve(),
        },
      );
      session.setBreakpointsForSource(ir.name, [{ nodeId: 'act_in', line: 1 }]);
      queueMicrotask(() => void session.start());
    });
    assert.deepEqual(namesAtPause, [null], 'stamp must be null while paused');
  });
});
