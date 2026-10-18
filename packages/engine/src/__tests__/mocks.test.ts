import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, flattenTrace, type BaseConnector, type RunContext } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

/**
 * `RunOptions.mocks` — the hook behind `flowforger run --mock <action>=<file.json>`: the named
 * action does not execute, its outputs are the given value, and the trace says it was mocked.
 */

class SpyConnector implements BaseConnector {
  readonly seen: Array<{ operation: string; inputs: any }> = [];
  async invoke(operation: string, inputs: any, _ctx: RunContext): Promise<any> {
    this.seen.push({ operation, inputs });
    return { statusCode: 200, body: { value: [{ Title: 'live' }] } };
  }
}

const TRIGGER = { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'POST' } } as any;
const compose = (name: string, value: any = 1) => ({ id: `act_${name}`, name, type: 'action', kind: 'compose', inputs: { value } });
const getItems = (name: string) => ({
  id: `con_${name}`, name, type: 'connector', connector: 'sharepoint', operation: 'GetItems',
  params: { dataset: "@outputs('Site')", table: 'list-guid' },
});

describe('RunOptions.mocks', () => {
  it('replaces a connector action with the mock, records its resolved inputs, and never calls the connector', async () => {
    const sharepoint = new SpyConnector();
    const flow: FlowIR = {
      name: 'f',
      nodes: [TRIGGER, compose('Site', 'https://contoso.sharepoint.com/sites/A'), getItems('Get_items'), compose('Count', "@length(body('Get_items')?['value'])")],
    } as any;
    const mock = { statusCode: 200, body: { value: [{ Title: 'a' }, { Title: 'b' }] } };
    const r = await run(flow, { connectors: { sharepoint }, mocks: { Get_items: mock } });

    assert.equal(r.status, 'Succeeded');
    assert.deepEqual(sharepoint.seen, [], 'the connector must not be invoked');
    const entry = r.trace.find((t) => t.name === 'Get_items')!;
    assert.equal(entry.status, 'Succeeded');
    assert.equal(entry.mocked, true);
    assert.deepEqual(entry.outputs, mock);
    assert.deepEqual(entry.inputs, { dataset: 'https://contoso.sharepoint.com/sites/A', table: 'list-guid' }, 'inputs are resolved like a real call');
    assert.equal(r.trace.find((t) => t.name === 'Count')!.outputs, 2, "later expressions read the mock through body('X')");
    assert.equal(r.trace.find((t) => t.name === 'Count')!.mocked, undefined);
  });

  it('works without a connector for the mocked action (no token needed)', async () => {
    const flow: FlowIR = { name: 'f', nodes: [TRIGGER, compose('Site', 'x'), getItems('Get_items')] } as any;
    const r = await run(flow, { mocks: { Get_items: { statusCode: 200, body: { value: [] } } } });
    assert.equal(r.status, 'Succeeded');
  });

  it('mocks a Compose and an action nested in a scope', async () => {
    const flow: FlowIR = {
      name: 'f',
      nodes: [
        TRIGGER,
        compose('A', 1),
        { id: 'scp_1', name: 'Work', type: 'scope', actions: [compose('Inner', "@add(outputs('A'), 1)")] },
        compose('Last', "@outputs('Inner')"),
      ],
    } as any;
    const r = await run(flow, { mocks: { A: 10, Inner: 'mocked-inner' } });
    const flat = flattenTrace(r.trace);
    assert.deepEqual(flat.map((t) => [t.name, t.status, t.mocked ?? false, t.outputs]), [
      ['manual', 'Succeeded', false, undefined],
      ['A', 'Succeeded', true, 10],
      ['Work', 'Succeeded', false, { scopeStatus: 'Succeeded' }],
      ['Inner', 'Succeeded', true, 'mocked-inner'],
      ['Last', 'Succeeded', false, 'mocked-inner'],
    ]);
  });

  it('a mock inside a loop applies on every iteration', async () => {
    const flow: FlowIR = {
      name: 'f',
      nodes: [
        TRIGGER,
        { id: 'fe_1', name: 'Each', type: 'foreach', itemsExpression: '@createArray(1, 2)', actions: [compose('Item', "@items('Each')")] },
      ],
    } as any;
    const r = await run(flow, { mocks: { Item: 'same' } });
    const loop = r.trace.find((t) => t.name === 'Each')!;
    assert.deepEqual(loop.iterations!.map((it) => it.actions.map((a) => [a.name, a.mocked, a.outputs])), [[['Item', true, 'same']], [['Item', true, 'same']]]);
  });

  it('onBeforeExecute stop wins over a mock for the same action', async () => {
    const flow: FlowIR = { name: 'f', nodes: [TRIGGER, compose('Site', 'x'), getItems('Get_items'), compose('After', 1)] } as any;
    const r = await run(flow, {
      mocks: { Get_items: { statusCode: 200, body: {} } },
      onBeforeExecute: (node) => (node.name === 'Get_items' ? 'stop' : 'continue'),
    });
    assert.equal(r.stopped, true);
    assert.equal(r.stoppedBefore?.name, 'Get_items');
  });

  it('a mocked block is replaced whole and nothing inside it runs', async () => {
    const flow: FlowIR = {
      name: 'f',
      nodes: [TRIGGER, { id: 'scp_1', name: 'Work', type: 'scope', actions: [compose('Inner', 1)] }, compose('Last', "@outputs('Work')")],
    } as any;
    const r = await run(flow, { mocks: { Work: { whole: true } } });
    const work = r.trace.find((t) => t.name === 'Work')!;
    assert.equal(work.mocked, true);
    assert.equal(work.children, undefined);
    assert.deepEqual(r.trace.find((t) => t.name === 'Last')!.outputs, { whole: true });
  });
});
