import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

const PEOPLE = [
  { Email: 'Jane.Doe@contoso.com', Type: 'Current', ID: 1 },
  { Email: 'John.Smith@contoso.com', Type: 'Alumni', ID: 2 },
];

function selectFlow(select: unknown): FlowIR {
  return {
    name: 'select-test',
    nodes: [
      { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'POST' } } as any,
      {
        id: 'act_1',
        name: 'Source',
        type: 'action',
        kind: 'compose',
        inputs: { value: PEOPLE },
      } as any,
      {
        id: 'act_2',
        name: 'Select',
        type: 'action',
        kind: 'select',
        inputs: { from: "@body('Source')", select },
      } as any,
    ],
  };
}

describe('select action', () => {
  it('evaluates a string (text-mode) map into an array of scalars', async () => {
    const result = await run(selectFlow("@toLower(item()?['Email'])"), {});
    assert.equal(result.status, 'Succeeded');
    const step = result.trace.find((t) => t.name === 'Select');
    assert.deepEqual(step?.outputs, ['jane.doe@contoso.com', 'john.smith@contoso.com']);
  });

  it('returns a literal string map unchanged per item', async () => {
    const result = await run(selectFlow('fixed'), {});
    const step = result.trace.find((t) => t.name === 'Select');
    assert.deepEqual(step?.outputs, ['fixed', 'fixed']);
  });

  it('evaluates an object map into an array of objects', async () => {
    const result = await run(
      selectFlow({ mail: "@item()?['Email']", kind: "@item()?['Type']", tag: 'user' }),
      {}
    );
    const step = result.trace.find((t) => t.name === 'Select');
    assert.deepEqual(step?.outputs, [
      { mail: 'Jane.Doe@contoso.com', kind: 'Current', tag: 'user' },
      { mail: 'John.Smith@contoso.com', kind: 'Alumni', tag: 'user' },
    ]);
  });
});
