import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../index.js';
import type { FlowIR, Node } from '@flowforger/ir';

// Increment/Decrement variable take any numeric expression as the value, not only a literal:
// `subtotal += body('X')?['lineTotal']` compiles to value "@body('X')?['lineTotal']". The engine
// used to ignore a non-number value and add 1.

const TRIGGER = { id: 'trg_1', name: 'manual', type: 'trigger', kind: 'manual', inputs: {} } as any;
const flow = (nodes: Node[]): FlowIR => ({ name: 'increment-expression', nodes: [TRIGGER, ...nodes] });
const init = (name: string, value: number): Node =>
  ({ id: `act_init_${name}`, name: `Initialize_${name}`, type: 'action', kind: 'initializevariable', inputs: { variableName: name, type: 'Float', value } }) as any;
const compose = (name: string, value: any, extra: object = {}): Node =>
  ({ id: `act_${name}`, name, type: 'action', kind: 'compose', inputs: { value }, ...extra }) as any;
const step = (kind: 'incrementvariable' | 'decrementvariable', id: string, name: string, value: any): Node =>
  ({ id, name: id, type: 'action', kind, inputs: { name, value } }) as any;

describe('IncrementVariable / DecrementVariable value', () => {
  it('adds the evaluated expression value', async () => {
    const result = await run(
      flow([
        init('total', 10),
        compose('Line', { lineTotal: 99.5 }),
        step('incrementvariable', 'Add_line', 'total', "@outputs('Line')?['lineTotal']"),
        step('decrementvariable', 'Discount', 'total', '@mul(2, 5)'),
      ]),
      { input: {} },
    );
    assert.equal(result.status, 'Succeeded');
    assert.equal(result.trace.find((t) => t.name === 'Add_line')!.outputs, 109.5);
    assert.equal(result.trace.find((t) => t.name === 'Discount')!.outputs, 99.5);
  });

  it('still adds a literal number', async () => {
    const result = await run(flow([init('n', 0), step('incrementvariable', 'Inc', 'n', 5)]), { input: {} });
    assert.equal(result.trace.find((t) => t.name === 'Inc')!.outputs, 5);
  });

  it('fails the action when the value is not a number', async () => {
    const result = await run(
      flow([
        init('n', 0),
        step('incrementvariable', 'Inc_text', 'n', "@concat('a', 'b')"),
        compose('Probe', "@actions('Inc_text')?['status']", { runAfter: { Inc_text: ['Succeeded', 'Failed'] } }),
      ]),
      { input: {} },
    );
    assert.equal(result.trace.find((t) => t.name === 'Inc_text')!.status, 'Failed');
    assert.equal(result.trace.find((t) => t.name === 'Probe')!.outputs, 'Failed');
  });
});
