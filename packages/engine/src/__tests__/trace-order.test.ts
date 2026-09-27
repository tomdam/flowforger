import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, flattenTrace, type TraceEntry } from '../index.js';
import type { FlowIR, Node } from '@flowforger/ir';

// Scope/if/switch entries come before the actions they contain, which are
// nested under the block's `children` — the same way a loop's body is nested
// under `iterations`. These tests pin that shape at every depth.

const TRIGGER = { id: 'trg_1', name: 'manual', type: 'trigger', kind: 'manual', inputs: {} } as any;

function makeFlow(bodyNodes: Node[]): FlowIR {
  return { name: 'trace-order', nodes: [TRIGGER, ...bodyNodes] };
}

const compose = (id: string, name: string, value: any): Node =>
  ({ id, name, type: 'action', kind: 'compose', inputs: { value } }) as any;

/** The entry names as a tree: a name, or [name, childTree] for a block with children. */
function shape(entries: TraceEntry[]): any[] {
  return entries.map((e) => (e.children ? [e.name, shape(e.children)] : e.name));
}

describe('trace order: control blocks come before their body', () => {
  it('nests the branch that ran under an if, after the entries that preceded it', async () => {
    const result = await run(
      makeFlow([
        compose('act_1', 'Member', 'Alice'),
        {
          id: 'if_1',
          name: 'Check_Member',
          type: 'if',
          condition: "@equals(outputs('Member'), 'Alice')",
          actions: [compose('act_2', 'Note', 'Welcome back!')],
          elseActions: [compose('act_3', 'Note2', 'Welcome!')],
        } as any,
        compose('act_4', 'After', 'done'),
      ]),
    );

    assert.equal(result.status, 'Succeeded');
    assert.deepEqual(shape(result.trace), ['manual', 'Member', ['Check_Member', ['Note']], 'After']);
    const check = result.trace.find((t) => t.name === 'Check_Member')!;
    assert.deepEqual(check.outputs, { conditionResult: true, branchTaken: 'actions' });
  });

  it('nests the else branch when the condition is false', async () => {
    const result = await run(
      makeFlow([
        {
          id: 'if_1',
          name: 'Check',
          type: 'if',
          condition: '@equals(1, 2)',
          actions: [compose('act_1', 'Then', 1)],
          elseActions: [compose('act_2', 'Else', 2)],
        } as any,
      ]),
    );

    assert.deepEqual(shape(result.trace), ['manual', ['Check', ['Else']]]);
  });

  it('gives an if with no branch to run an empty children list', async () => {
    const result = await run(
      makeFlow([
        { id: 'if_1', name: 'Check', type: 'if', condition: '@equals(1, 2)', actions: [compose('act_1', 'Then', 1)] } as any,
      ]),
    );

    assert.deepEqual(result.trace[1].children, []);
  });

  it('nests a switch, including the skipped actions of the cases that did not match', async () => {
    const result = await run(
      makeFlow([
        {
          id: 'sw_1',
          name: 'Route',
          type: 'switch',
          expression: "@string('EU')",
          cases: [
            { name: 'CaseUS', value: 'US', actions: [compose('act_1', 'TaxUS', 0.08)] },
            { name: 'CaseEU', value: 'EU', actions: [compose('act_2', 'TaxEU', 0.2)] },
          ],
          defaultActions: [compose('act_3', 'TaxOther', 0.1)],
        } as any,
      ]),
    );

    assert.deepEqual(shape(result.trace), ['manual', ['Route', ['TaxEU', 'TaxUS', 'TaxOther']]]);
    const statuses = result.trace[1].children!.map((c) => c.status);
    assert.deepEqual(statuses, ['Succeeded', 'Skipped', 'Skipped']);
  });

  it('nests blocks inside blocks at every depth', async () => {
    const result = await run(
      makeFlow([
        {
          id: 'scp_1',
          name: 'Outer',
          type: 'scope',
          actions: [
            compose('act_1', 'First', 1),
            {
              id: 'if_1',
              name: 'Inner',
              type: 'if',
              condition: '@equals(1, 1)',
              actions: [{ id: 'scp_2', name: 'Deepest', type: 'scope', actions: [compose('act_2', 'Leaf', 2)] }],
            } as any,
            compose('act_3', 'Last', 3),
          ],
        } as any,
      ]),
    );

    assert.deepEqual(shape(result.trace), [
      'manual',
      ['Outer', ['First', ['Inner', [['Deepest', ['Leaf']]]], 'Last']],
    ]);
  });

  it('nests an if under its parent inside each sequential foreach iteration', async () => {
    const result = await run(
      makeFlow([
        {
          id: 'fe_1',
          name: 'Loop',
          type: 'foreach',
          itemsExpression: '@createArray(1, 2)',
          actions: [
            {
              id: 'if_1',
              name: 'IsOne',
              type: 'if',
              condition: "@equals(items('Loop'), 1)",
              actions: [compose('act_1', 'One', "@items('Loop')")],
            } as any,
          ],
        } as any,
      ]),
    );

    const iterations = result.trace.find((t) => t.name === 'Loop')!.iterations!;
    assert.deepEqual(iterations.map((it) => shape(it.actions)), [[['IsOne', ['One']]], [['IsOne', []]]]);
  });

  it('nests an if under its parent inside each parallel foreach iteration', async () => {
    const result = await run(
      makeFlow([
        {
          id: 'fe_1',
          name: 'Loop',
          type: 'foreach',
          parallel: true,
          itemsExpression: '@createArray(1, 2)',
          actions: [
            {
              id: 'if_1',
              name: 'IsOne',
              type: 'if',
              condition: "@equals(items('Loop'), 1)",
              actions: [compose('act_1', 'One', "@items('Loop')")],
            } as any,
          ],
        } as any,
      ]),
    );

    const iterations = result.trace.find((t) => t.name === 'Loop')!.iterations!;
    assert.deepEqual(iterations.map((it) => shape(it.actions)), [[['IsOne', ['One']]], [['IsOne', []]]]);
  });

  it('keeps the last top-level action as the last trace entry (the child-flow body source)', async () => {
    const result = await run(
      makeFlow([
        {
          id: 'scp_1',
          name: 'Wrap',
          type: 'scope',
          actions: [compose('act_1', 'Inner', 'x')],
        } as any,
      ]),
    );

    assert.equal(result.trace[result.trace.length - 1].name, 'Wrap');
  });

  it('still resolves runAfter against actions nested two blocks deep', async () => {
    const result = await run(
      makeFlow([
        {
          id: 'scp_1',
          name: 'Outer',
          type: 'scope',
          actions: [
            { id: 'scp_2', name: 'Mid', type: 'scope', actions: [compose('act_1', 'Deep', 1)] } as any,
            { ...(compose('act_2', 'UsesDeep', "@outputs('Deep')") as any), runAfter: { Mid: ['Succeeded'] } },
          ],
        } as any,
        { ...(compose('act_3', 'AfterOuter', 'ok') as any), runAfter: { Outer: ['Succeeded'] } },
      ]),
    );

    const flat = flattenTrace(result.trace);
    assert.equal(flat.find((t) => t.name === 'UsesDeep')?.outputs, 1);
    assert.equal(flat.find((t) => t.name === 'AfterOuter')?.status, 'Succeeded');
  });
});

describe('flattenTrace', () => {
  it('lists each block before its body and leaves loop bodies inside iterations', async () => {
    const result = await run(
      makeFlow([
        {
          id: 'scp_1',
          name: 'Outer',
          type: 'scope',
          actions: [
            { id: 'if_1', name: 'Check', type: 'if', condition: '@equals(1, 1)', actions: [compose('act_1', 'A', 1)] } as any,
            {
              id: 'fe_1',
              name: 'Loop',
              type: 'foreach',
              itemsExpression: '@createArray(1)',
              actions: [compose('act_2', 'InLoop', 1)],
            } as any,
          ],
        } as any,
        compose('act_3', 'B', 2),
      ]),
    );

    assert.deepEqual(flattenTrace(result.trace).map((t) => t.name), ['manual', 'Outer', 'Check', 'A', 'Loop', 'B']);
  });
});
