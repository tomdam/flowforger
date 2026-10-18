import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, type TraceEntry } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

/**
 * Inside a foreach the cloud's item() is the current item of the innermost loop, the same
 * value as items('<loop>'). The designer writes item() there, so flows parsed from a cloud
 * definition use it (`item().brk_mandantid` failed with "property cannot be selected").
 */

const trigger = { id: 'trg_1', name: 'manual', type: 'trigger', inputs: {} } as any;
const compose = (name: string, value: unknown) => ({ id: name, name, type: 'action', kind: 'compose', inputs: { value } }) as any;

function iterationOutputs(entry: TraceEntry | undefined, action: string): unknown[] {
  return (entry?.iterations ?? []).map((it) => it.actions.find((a) => a.name === action)?.outputs);
}

describe('item() inside a foreach', () => {
  it('is the current item, property paths included', async () => {
    const flow: FlowIR = {
      name: 'item-foreach',
      nodes: [
        trigger,
        {
          id: 'fe_1',
          name: 'Each',
          type: 'foreach',
          itemsExpression: "@json('[{\"id\":\"a\"},{\"id\":\"b\"}]')",
          actions: [compose('Id', '@item().id'), compose('Id_safe', "@item()?['id']")],
        } as any,
      ],
    };
    const result = await run(flow);
    assert.equal(result.status, 'Succeeded');
    const loop = result.trace.find((t) => t.name === 'Each');
    assert.deepEqual(iterationOutputs(loop, 'Id'), ['a', 'b']);
    assert.deepEqual(iterationOutputs(loop, 'Id_safe'), ['a', 'b']);
  });

  it('is the current item in a concurrent foreach', async () => {
    const flow: FlowIR = {
      name: 'item-foreach-parallel',
      nodes: [
        trigger,
        {
          id: 'fe_1',
          name: 'Each',
          type: 'foreach',
          itemsExpression: '@createArray(1, 2, 3)',
          runtimeConfiguration: { concurrency: { repetitions: 3 } },
          actions: [compose('Value', '@item()')],
        } as any,
      ],
    };
    const result = await run(flow);
    assert.equal(result.status, 'Succeeded');
    assert.deepEqual(iterationOutputs(result.trace.find((t) => t.name === 'Each'), 'Value'), [1, 2, 3]);
  });

  it('is the innermost loop\'s item in nested loops', async () => {
    const flow: FlowIR = {
      name: 'item-nested',
      nodes: [
        trigger,
        {
          id: 'fe_1',
          name: 'Outer',
          type: 'foreach',
          itemsExpression: "@createArray('x')",
          actions: [
            {
              id: 'fe_2',
              name: 'Inner',
              type: 'foreach',
              itemsExpression: '@createArray(1, 2)',
              actions: [compose('Inner_item', "@concat(items('Outer'), item())")],
            } as any,
            compose('After_inner', '@item()'),
          ],
        } as any,
      ],
    };
    const result = await run(flow);
    assert.equal(result.status, 'Succeeded');
    const outer = result.trace.find((t) => t.name === 'Outer');
    const inner = outer?.iterations?.[0].actions.find((a) => a.name === 'Inner');
    assert.deepEqual(iterationOutputs(inner, 'Inner_item'), ['x1', 'x2']);
    assert.deepEqual(iterationOutputs(outer, 'After_inner'), ['x']);
  });

  it('is the Select row inside a Select within a foreach', async () => {
    const flow: FlowIR = {
      name: 'item-select',
      nodes: [
        trigger,
        {
          id: 'fe_1',
          name: 'Each',
          type: 'foreach',
          itemsExpression: "@createArray('loop')",
          actions: [
            { id: 'sel', name: 'Pick', type: 'action', kind: 'select', inputs: { from: '@createArray(1, 2)', select: '@item()' } } as any,
            compose('After_select', '@item()'),
          ],
        } as any,
      ],
    };
    const result = await run(flow);
    assert.equal(result.status, 'Succeeded');
    const loop = result.trace.find((t) => t.name === 'Each');
    assert.deepEqual(iterationOutputs(loop, 'Pick'), [{ body: [1, 2] }]);
    assert.deepEqual(iterationOutputs(loop, 'After_select'), ['loop']);
  });

  it('stays null outside a loop', async () => {
    const flow: FlowIR = { name: 'item-outside', nodes: [trigger, compose('Outside', '@item()')] };
    const result = await run(flow);
    assert.equal(result.status, 'Succeeded');
    assert.equal(result.trace.find((t) => t.name === 'Outside')?.outputs, null);
  });
});
