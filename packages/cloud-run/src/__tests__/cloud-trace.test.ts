import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR } from '@flowforger/ir';
import { buildCloudTrace, type CloudRepetition } from '../index.js';

const trigger = { id: 'trg_1', type: 'trigger', name: 'manual', kind: 'http', inputs: {} };
const compose = (name: string) => ({ id: `act_${name}`, type: 'action', name, kind: 'compose', inputs: { value: 1 } });
const ir = (nodes: any[]): FlowIR => ({ name: 'F', nodes: [trigger, ...nodes] } as unknown as FlowIR);

describe('buildCloudTrace', () => {
  it('lists the trigger and top-level actions with the cloud record values', async () => {
    const trace = await buildCloudTrace(ir([compose('A'), compose('B')]), {
      trigger: { name: 'manual', status: 'Succeeded', outputs: { headers: {}, body: { id: 1 } } },
      actions: {
        A: { status: 'Succeeded', code: 'OK', inputs: 1, outputs: 1 },
        B: { status: 'Failed', code: 'BadRequest', error: { code: 'InvalidTemplate', message: 'boom' } },
      },
      repetitions: async () => [],
    });
    assert.deepEqual(trace, [
      { nodeId: 'trg_1', name: 'manual', status: 'Succeeded', trigger: true, outputs: { headers: {}, body: { id: 1 } } },
      { nodeId: 'act_A', name: 'A', status: 'Succeeded', code: 'OK', inputs: 1, outputs: 1 },
      { nodeId: 'act_B', name: 'B', status: 'Failed', code: 'BadRequest', error: { code: 'InvalidTemplate', message: 'boom' } },
    ]);
  });

  it('nests a scope and an if/else body under children, in definition order', async () => {
    const nodes = [
      { id: 'scp_1', type: 'scope', name: 'Try', actions: [compose('Inner')] },
      { id: 'if_1', type: 'if', name: 'Check', condition: '@true', actions: [compose('Then')], elseActions: [compose('Else')] },
    ];
    const trace = await buildCloudTrace(ir(nodes), {
      actions: {
        Try: { status: 'Succeeded' }, Inner: { status: 'Succeeded', outputs: 1 },
        Check: { status: 'Succeeded' }, Then: { status: 'Succeeded' }, Else: { status: 'Skipped', code: 'ActionBranchingConditionNotSatisfied' },
      },
      repetitions: async () => [],
    });
    assert.deepEqual(trace.slice(1).map((t) => [t.name, t.status, t.children?.map((c) => [c.name, c.status])]), [
      ['Try', 'Succeeded', [['Inner', 'Succeeded']]],
      ['Check', 'Succeeded', [['Then', 'Succeeded'], ['Else', 'Skipped']]],
    ]);
  });

  it('builds a loop from its children repetitions, grouped by item index, and fetches each action once', async () => {
    const loop = { id: 'fe_1', type: 'foreach', name: 'Each', itemsExpression: "@body('L')", actions: [compose('Title'), compose('Note')] };
    const rep = (name: string, i: number, status = 'Succeeded'): CloudRepetition => ({ status, outputs: `${name}-${i}`, indexes: [{ scopeName: 'Each', itemIndex: i }] });
    const calls: string[] = [];
    const trace = await buildCloudTrace(ir([loop]), {
      actions: { Each: { status: 'Failed', repetitionCount: 2 }, Title: { status: 'Succeeded', outputs: 'Title-1' }, Note: { status: 'Failed' } },
      repetitions: async (name) => {
        calls.push(name);
        return name === 'Title' ? [rep('Title', 1), rep('Title', 0)] : [rep('Note', 0), rep('Note', 1, 'Failed')];
      },
    });
    const each = trace[1];
    assert.equal(each.status, 'Failed');
    assert.deepEqual(each.iterations, [
      { index: 0, status: 'Succeeded', actions: [{ nodeId: 'act_Title', name: 'Title', status: 'Succeeded', outputs: 'Title-0' }, { nodeId: 'act_Note', name: 'Note', status: 'Succeeded', outputs: 'Note-0' }] },
      { index: 1, status: 'Failed', actions: [{ nodeId: 'act_Title', name: 'Title', status: 'Succeeded', outputs: 'Title-1' }, { nodeId: 'act_Note', name: 'Note', status: 'Failed', outputs: 'Note-1' }] },
    ]);
    assert.deepEqual(calls.sort(), ['Note', 'Title'], 'repetitions are fetched once per action');
  });

  it('handles a loop nested in a loop and a scope inside a loop', async () => {
    const inner = { id: 'fe_2', type: 'foreach', name: 'Inner', itemsExpression: '@createArray(1)', actions: [compose('Leaf')] };
    const outer = { id: 'fe_1', type: 'foreach', name: 'Outer', itemsExpression: '@createArray(1)', actions: [{ id: 'scp_1', type: 'scope', name: 'Wrap', actions: [inner] }] };
    const reps: Record<string, CloudRepetition[]> = {
      Wrap: [0, 1].map((o) => ({ status: 'Succeeded', indexes: [{ scopeName: 'Outer', itemIndex: o }] })),
      Inner: [0, 1].map((o) => ({ status: 'Succeeded', indexes: [{ scopeName: 'Outer', itemIndex: o }] })),
      Leaf: [
        { status: 'Succeeded', outputs: 'o0-i0', indexes: [{ scopeName: 'Outer', itemIndex: 0 }, { scopeName: 'Inner', itemIndex: 0 }] },
        { status: 'Succeeded', outputs: 'o1-i0', indexes: [{ scopeName: 'Outer', itemIndex: 1 }, { scopeName: 'Inner', itemIndex: 0 }] },
        { status: 'Succeeded', outputs: 'o1-i1', indexes: [{ scopeName: 'Outer', itemIndex: 1 }, { scopeName: 'Inner', itemIndex: 1 }] },
      ],
    };
    const trace = await buildCloudTrace(ir([outer]), { actions: { Outer: { status: 'Succeeded' } }, repetitions: async (n) => reps[n] ?? [] });
    const o = trace[1];
    assert.equal(o.iterations!.length, 2);
    const leaves = (i: number) => o.iterations![i].actions[0].children![0].iterations!.map((it) => it.actions[0].outputs);
    assert.deepEqual(leaves(0), ['o0-i0']);
    assert.deepEqual(leaves(1), ['o1-i0', 'o1-i1']);
  });

  it('an action the run never recorded is Skipped, a loop with no repetitions has no iterations', async () => {
    const loop = { id: 'fe_1', type: 'foreach', name: 'Each', itemsExpression: '@createArray()', actions: [compose('Title')] };
    const trace = await buildCloudTrace(ir([compose('A'), loop]), { actions: { Each: { status: 'Succeeded' } }, repetitions: async () => [] });
    assert.deepEqual(trace[1], { nodeId: 'act_A', name: 'A', status: 'Skipped' });
    assert.deepEqual(trace[2].iterations, []);
  });
});
