import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR } from '@flowforger/ir';
import { run, toTriggerOutputs } from '../index.js';

// Measured against the cloud by conformance/flows/trigger.ff.ts.

describe('toTriggerOutputs', () => {
  it('wraps a payload as { headers, body }', () => {
    assert.deepEqual(toTriggerOutputs({ text: 'a' }), { headers: { 'Content-Type': 'application/json' }, body: { text: 'a' } });
  });

  it('keeps a payload that is already an outputs object, adding headers when missing', () => {
    assert.deepEqual(toTriggerOutputs({ body: { id: 1 } }), { headers: { 'Content-Type': 'application/json' }, body: { id: 1 } });
    const shaped = { headers: { 'x-ms-user-email': 'a@b.c' }, body: { id: 1 }, queries: { q: '1' } };
    assert.deepEqual(toTriggerOutputs(shaped), shaped);
  });

  it('wraps a payload that merely has a body field among others (an email, say)', () => {
    const email = { subject: 'Hi', body: '<p>text</p>' };
    assert.deepEqual(toTriggerOutputs(email), { headers: { 'Content-Type': 'application/json' }, body: email });
  });

  it('leaves no payload as no trigger data', () => {
    assert.equal(toTriggerOutputs(undefined), undefined);
    assert.equal(toTriggerOutputs(null), null);
  });
});

describe('trigger expressions in a run', () => {
  const flow = {
    name: 'T',
    nodes: [
      { id: 'trg_1', type: 'trigger', name: 'manual', kind: 'http', inputs: { method: 'POST', schema: { type: 'object' } } },
      { id: 'act_1', type: 'action', name: 'Outputs', kind: 'compose', inputs: { value: "@triggerOutputs()" } },
      { id: 'act_2', type: 'action', name: 'Record', kind: 'compose', inputs: { value: '@trigger()' } },
      { id: 'act_3', type: 'action', name: 'Body', kind: 'compose', inputs: { value: "@triggerOutputs()?['body']?['text']" } },
      { id: 'act_4', type: 'action', name: 'NoBody', kind: 'compose', inputs: { value: "@trigger()['body']" } },
    ],
  } as unknown as FlowIR;

  it('triggerOutputs() is { headers, body } and trigger() the run record, without a body of its own', async () => {
    const r = await run(flow, { input: { text: 'Alpha' } });
    const out = (name: string) => r.trace.find((t) => t.name === name);
    assert.deepEqual(out('Outputs')!.outputs, { headers: { 'Content-Type': 'application/json' }, body: { text: 'Alpha' } });
    assert.equal(out('Body')!.outputs, 'Alpha');
    const record = out('Record')!.outputs as Record<string, unknown>;
    assert.deepEqual(Object.keys(record), [
      'name', 'inputs', 'outputs', 'startTime', 'endTime', 'trackingId', 'clientTrackingId', 'originHistoryName', 'status',
    ]);
    assert.equal(record.name, 'manual');
    assert.deepEqual(record.inputs, { method: 'POST', schema: { type: 'object' } });
    assert.equal(record.status, 'Succeeded');
    assert.equal(out('NoBody')!.status, 'Failed');
  });
});
