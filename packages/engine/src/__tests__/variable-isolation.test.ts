import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, type TraceEntry } from '../index.js';
import type { FlowIR, Node } from '@flowforger/ir';

// Variables are the only state the engine mutates in place (AppendToArrayVariable
// pushes). These tests pin that a stored variable never shares structure with the
// flow IR, with another action's outputs, or with an earlier trace entry.

function makeFlow(bodyNodes: Node[]): FlowIR {
  return {
    name: 'variable-isolation',
    nodes: [
      { id: 'trg_1', name: 'manual', type: 'trigger', kind: 'manual', inputs: {} } as any,
      ...bodyNodes,
    ],
  };
}

const init = (name: string, value: any): Node =>
  ({ id: `act_init_${name}`, name: `Initialize_${name}`, type: 'action', kind: 'initializevariable', inputs: { variableName: name, type: 'Array', value } }) as any;

const append = (id: string, name: string, value: any): Node =>
  ({ id, name: `Append_${id}`, type: 'action', kind: 'appendtoarrayvariable', inputs: { name, value } }) as any;

function flatten(trace: TraceEntry[]): TraceEntry[] {
  return trace.flatMap((t) => [t, ...(t.iterations ?? []).flatMap((it) => flatten(it.actions))]);
}

const outputsOf = (trace: TraceEntry[], name: string) => flatten(trace).filter((t) => t.name === name).map((t) => t.outputs);

describe('variable isolation', () => {
  it('does not mutate the IR initializer, so a second run of the same flow starts clean', async () => {
    const flow = makeFlow([
      init('list', []),
      {
        id: 'fe_1',
        name: 'ForEach',
        type: 'foreach',
        itemsExpression: "@createArray('a', 'b', 'c')",
        actions: [append('app_1', 'list', "@items('ForEach')")],
      } as any,
      { id: 'act_out', name: 'Result', type: 'action', kind: 'compose', inputs: { value: "@variables('list')" } } as any,
    ]);

    const first = await run(flow);
    const second = await run(flow);

    assert.deepEqual((flow.nodes[1] as any).inputs.value, [], 'IR literal must stay empty');
    assert.deepEqual(outputsOf(first.trace, 'Result'), [['a', 'b', 'c']]);
    assert.deepEqual(outputsOf(second.trace, 'Result'), [['a', 'b', 'c']], 'second run must not see leftovers');
  });

  it('records each step with the value it had at that step', async () => {
    const flow = makeFlow([
      init('list', []),
      append('app_1', 'list', 'a'),
      append('app_2', 'list', 'b'),
      append('app_3', 'list', 'c'),
    ]);

    const result = await run(flow);

    assert.deepEqual(outputsOf(result.trace, 'Initialize_list'), [[]]);
    assert.deepEqual(outputsOf(result.trace, 'Append_app_1'), [['a']]);
    assert.deepEqual(outputsOf(result.trace, 'Append_app_2'), [['a', 'b']]);
    assert.deepEqual(outputsOf(result.trace, 'Append_app_3'), [['a', 'b', 'c']]);
  });

  it('records per-iteration values for appends inside a loop', async () => {
    const flow = makeFlow([
      init('list', []),
      {
        id: 'fe_1',
        name: 'ForEach',
        type: 'foreach',
        itemsExpression: "@createArray('a', 'b', 'c')",
        actions: [append('app_1', 'list', "@items('ForEach')")],
      } as any,
    ]);

    const result = await run(flow);

    assert.deepEqual(outputsOf(result.trace, 'Append_app_1'), [['a'], ['a', 'b'], ['a', 'b', 'c']]);
  });

  it("does not grow another action's outputs when a variable is initialized from them", async () => {
    const flow = makeFlow([
      { id: 'act_team', name: 'Team', type: 'action', kind: 'compose', inputs: { value: { members: ['x'] } } } as any,
      init('members', "@outputs('Team')?['members']"),
      append('app_1', 'members', 'y'),
      { id: 'act_after', name: 'TeamAfter', type: 'action', kind: 'compose', inputs: { value: "@outputs('Team')" } } as any,
      { id: 'act_var', name: 'MembersAfter', type: 'action', kind: 'compose', inputs: { value: "@variables('members')" } } as any,
    ]);

    const result = await run(flow);

    assert.deepEqual(outputsOf(result.trace, 'TeamAfter'), [{ members: ['x'] }], 'Team outputs must be untouched');
    assert.deepEqual(outputsOf(result.trace, 'MembersAfter'), [['x', 'y']]);
  });

  it('does not mutate a SetVariable literal either', async () => {
    const flow = makeFlow([
      init('list', []),
      { id: 'act_set', name: 'Set_list', type: 'action', kind: 'setvariable', inputs: { name: 'list', value: ['seed'] } } as any,
      append('app_1', 'list', 'more'),
    ]);

    await run(flow);
    const second = await run(flow);

    assert.deepEqual((flow.nodes[2] as any).inputs.value, ['seed']);
    assert.deepEqual(outputsOf(second.trace, 'Append_app_1'), [['seed', 'more']]);
  });
});
