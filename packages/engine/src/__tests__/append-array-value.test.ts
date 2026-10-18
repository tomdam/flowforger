import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../index.js';
import type { FlowIR, Node } from '@flowforger/ir';

// The cloud's "Append to array variable" refuses an array as the value (an array variable holds
// scalars and objects). Measured by conformance/flows/loops.ff.ts (Append_to_nested).

const TRIGGER = { id: 'trg_1', name: 'manual', type: 'trigger', kind: 'manual', inputs: {} } as any;
const flow = (nodes: Node[]): FlowIR => ({ name: 'append-array-value', nodes: [TRIGGER, ...nodes] });
const init = (name: string): Node =>
  ({ id: `act_init_${name}`, name: `Initialize_${name}`, type: 'action', kind: 'initializevariable', inputs: { variableName: name, type: 'Array', value: [] } }) as any;
const append = (id: string, name: string, value: any): Node =>
  ({ id, name: id, type: 'action', kind: 'appendtoarrayvariable', inputs: { name, value } }) as any;
const compose = (name: string, value: any, extra: object = {}): Node =>
  ({ id: `act_${name}`, name, type: 'action', kind: 'compose', inputs: { value }, ...extra }) as any;

describe('AppendToArrayVariable value types', () => {
  it('fails BadRequest when the value is an array, as the cloud does', async () => {
    const result = await run(
      flow([
        init('rows'),
        append('Append_bad', 'rows', "@createArray('a', 'b')"),
        compose('Probe', "@actions('Append_bad')", { runAfter: { Append_bad: ['Succeeded', 'Failed'] } }),
      ]),
      { input: {} },
    );
    // Probe runs after the failure, so the run itself is handled and succeeds, as in the cloud.
    assert.equal(result.status, 'Succeeded');
    const entry = result.trace.find((t) => t.name === 'Append_bad')!;
    assert.equal(entry.status, 'Failed');
    const record = result.trace.find((t) => t.name === 'Probe')!.outputs;
    assert.equal(record.status, 'Failed');
    assert.equal(record.code, 'BadRequest');
    assert.equal(record.error.code, 'BadRequest');
    assert.equal(
      record.error.message,
      "The variable 'rows' of type 'Array' cannot be initialized or updated with value of type 'Array'. The variable 'rows' only supports values of types 'Float, Integer, String, Boolean, Object'.",
    );
  });

  it('still appends scalars, objects and null', async () => {
    const result = await run(
      flow([
        init('rows'),
        append('Append_text', 'rows', 'x'),
        append('Append_number', 'rows', 1),
        append('Append_object', 'rows', { a: 1 }),
        append('Append_null', 'rows', null),
      ]),
      { input: {} },
    );
    assert.equal(result.status, 'Succeeded');
    const last = result.trace.find((t) => t.name === 'Append_null')!;
    assert.deepEqual(last.outputs, ['x', 1, { a: 1 }, null]);
  });
});
