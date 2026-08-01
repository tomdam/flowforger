import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR, Node } from '@flowforger/ir';
import {
  buildNodeIndex,
  findNodeByName,
  remapBreakpointsByName,
  computeFastForwardTarget,
  rewindExecutionCounts,
  evaluateRewindPreconditions,
} from '../driver-helpers.js';

const oldIr: FlowIR = {
  name: 'f',
  nodes: [
    { id: 'trg_1', name: 'manual', type: 'trigger' } as any,
    { id: 'act_1', name: 'Initialize_x', type: 'action', kind: 'initializevariable', inputs: {} } as any,
    {
      id: 'if_1', name: 'Condition', type: 'if', condition: '@true',
      actions: [{ id: 'act_2', name: 'Set_x', type: 'action', kind: 'setvariable', inputs: {} } as any],
      elseActions: [{ id: 'act_3', name: 'Compose', type: 'action', kind: 'compose', inputs: {} } as any],
    } as any,
    {
      id: 'fe_1', name: 'ForEach_item', type: 'foreach', source: '@x',
      actions: [{ id: 'act_4', name: 'Append_to_out', type: 'action', kind: 'appendtoarrayvariable', inputs: {} } as any],
    } as any,
  ],
};

// Recompiled IR: same names, all-new IDs; Compose deleted
const newIr: FlowIR = {
  name: 'f',
  nodes: [
    { id: 'trg_9', name: 'manual', type: 'trigger' } as any,
    { id: 'act_90', name: 'Initialize_x', type: 'action', kind: 'initializevariable', inputs: {} } as any,
    {
      id: 'if_9', name: 'Condition', type: 'if', condition: '@true',
      actions: [{ id: 'act_91', name: 'Set_x', type: 'action', kind: 'setvariable', inputs: {} } as any],
      elseActions: [],
    } as any,
    {
      id: 'fe_9', name: 'ForEach_item', type: 'foreach', source: '@x',
      actions: [{ id: 'act_94', name: 'Append_to_out', type: 'action', kind: 'appendtoarrayvariable', inputs: {} } as any],
    } as any,
  ],
};

describe('buildNodeIndex', () => {
  it('indexes nodes at every nesting level by id', () => {
    const index = buildNodeIndex(oldIr.nodes);
    assert.equal(index.get('act_2')?.name, 'Set_x');
    assert.equal(index.get('act_3')?.name, 'Compose');
    assert.equal(index.get('act_4')?.name, 'Append_to_out');
    assert.equal(index.size, 7);
  });
});

describe('findNodeByName', () => {
  it('finds nested nodes (if-branch and foreach body)', () => {
    assert.equal(findNodeByName(newIr.nodes, 'Set_x')?.id, 'act_91');
    assert.equal(findNodeByName(newIr.nodes, 'Append_to_out')?.id, 'act_94');
    assert.equal(findNodeByName(newIr.nodes, 'Nope'), null);
  });
});

describe('remapBreakpointsByName', () => {
  it('maps old node IDs to new node IDs via names and drops vanished nodes', () => {
    const remapped = remapBreakpointsByName(new Set(['act_2', 'act_3', 'act_4']), buildNodeIndex(oldIr.nodes), newIr);
    assert.deepEqual(remapped, new Set(['act_91', 'act_94'])); // act_3 (Compose) was deleted
  });
});

describe('computeFastForwardTarget', () => {
  it('builds a target with the recorded hit count', () => {
    assert.deepEqual(
      computeFastForwardTarget('Append_to_out', newIr, new Map([['Append_to_out', 3]])),
      { nodeName: 'Append_to_out', hitCount: 3 },
    );
  });
  it('defaults hit count to 0 for a never-executed node', () => {
    assert.deepEqual(computeFastForwardTarget('Set_x', newIr, new Map()), { nodeName: 'Set_x', hitCount: 0 });
  });
  it('returns null when the node no longer exists or name is null', () => {
    assert.equal(computeFastForwardTarget('Compose', newIr, new Map()), null);
    assert.equal(computeFastForwardTarget(null, newIr, new Map()), null);
  });
});

const jumpIr: FlowIR = {
  name: 'j',
  nodes: [
    { id: 'trg_1', name: 'manual', type: 'trigger' } as any,
    { id: 'act_a', name: 'Compose_a', type: 'action', kind: 'compose', inputs: {} } as any,
    { id: 'act_x', name: 'Compose_x', type: 'action', kind: 'compose', inputs: {} } as any,
    { id: 'act_b', name: 'Compose_b', type: 'action', kind: 'compose', inputs: {} } as any,
    {
      id: 'fe_1', name: 'ForEach_item', type: 'foreach', source: '@x',
      actions: [{ id: 'act_in', name: 'Compose_in', type: 'action', kind: 'compose', inputs: {} } as any],
    } as any,
  ],
};

describe('rewindExecutionCounts', () => {
  it('deletes counts for the continuation set and leaves unrelated nodes alone', () => {
    const counts = new Map([['Compose_a', 1], ['Compose_x', 1], ['Compose_b', 1]]);
    rewindExecutionCounts(['act_x', 'act_b'], buildNodeIndex(jumpIr.nodes), counts);
    assert.equal(counts.get('Compose_x'), undefined);
    assert.equal(counts.get('Compose_b'), undefined);
    assert.equal(counts.get('Compose_a'), 1);
  });

  it('deletes loop-body counts when the foreach node itself re-runs', () => {
    const counts = new Map([['ForEach_item', 1], ['Compose_in', 2], ['Compose_a', 1]]);
    rewindExecutionCounts(['fe_1'], buildNodeIndex(jumpIr.nodes), counts);
    assert.equal(counts.get('ForEach_item'), undefined);
    assert.equal(counts.get('Compose_in'), undefined);
    assert.equal(counts.get('Compose_a'), 1);
  });

  it('is a no-op for an unknown node id', () => {
    const counts = new Map([['Compose_a', 1]]);
    rewindExecutionCounts(['act_nope'], buildNodeIndex(jumpIr.nodes), counts);
    assert.deepEqual(counts, new Map([['Compose_a', 1]]));
  });
});

describe('evaluateRewindPreconditions', () => {
  const index = buildNodeIndex(jumpIr.nodes);
  it('accepts an already-executed plain action and targets its most recent hit', () => {
    assert.deepEqual(
      evaluateRewindPreconditions({ node: index.get('act_x'), executionCount: 3, inPlaceError: 'x' }),
      { ok: true, nodeName: 'Compose_x', hitCount: 2 },
    );
  });
  it('passes through the in-place error when the node is unknown', () => {
    assert.deepEqual(
      evaluateRewindPreconditions({ node: undefined, executionCount: 0, inPlaceError: 'original reason' }),
      { ok: false, error: 'original reason' },
    );
  });
  it('rejects triggers', () => {
    const r = evaluateRewindPreconditions({ node: index.get('trg_1'), executionCount: 1, inPlaceError: 'x' });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /trigger/);
  });
  it('rejects control-flow containers', () => {
    const r = evaluateRewindPreconditions({ node: index.get('fe_1'), executionCount: 1, inPlaceError: 'x' });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /control-flow block/);
  });
  it('rejects never-executed targets (forward jumps)', () => {
    const r = evaluateRewindPreconditions({ node: index.get('act_b'), executionCount: 0, inPlaceError: 'x' });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /has not executed yet/);
  });
});
