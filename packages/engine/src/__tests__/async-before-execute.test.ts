import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, type BaseConnector, type RunContext } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

/**
 * `RunOptions.onBeforeExecute` may answer asynchronously: a debugger pauses inside it (showing
 * the resolved inputs of an external call) before deciding to continue or stop.
 */

class SpyConnector implements BaseConnector {
  readonly seen: string[] = [];
  async invoke(_op: string, inputs: any, _ctx: RunContext): Promise<any> {
    this.seen.push(inputs.table);
    return { value: [] };
  }
}

const TRIGGER = { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'POST' } } as any;
const getItems = (name: string, table: string) => ({
  id: `con_${name}`, name, type: 'connector', connector: 'sharepoint', operation: 'GetItems', params: { dataset: 'https://x', table },
});
const http = { id: 'act_http', name: 'Call', type: 'action', kind: 'http', inputs: { method: 'GET', uri: 'https://example.invalid' }, runAfter: { First: ['Succeeded'] } };

describe('RunOptions.onBeforeExecute (async)', () => {
  it('awaits the hook: a stop decided after a pause ends the run before the action, with its inputs', async () => {
    const sharepoint = new SpyConnector();
    const flow: FlowIR = { name: 'f', nodes: [TRIGGER, getItems('First', 'a'), { ...getItems('Second', 'b'), runAfter: { First: ['Succeeded'] } }] } as any;
    const order: string[] = [];
    const r = await run(flow, {
      connectors: { sharepoint },
      onBeforeExecute: async (node) => {
        order.push(`hook ${node.name}`);
        await new Promise((res) => setTimeout(res, 5));
        return node.name === 'Second' ? 'stop' : 'continue';
      },
    });
    assert.equal(r.stopped, true);
    assert.deepEqual(r.stoppedBefore, { nodeId: 'con_Second', name: 'Second', inputs: { dataset: 'https://x', table: 'b' } });
    assert.deepEqual(sharepoint.seen, ['a']);
    assert.deepEqual(order, ['hook First', 'hook Second']);
  });

  it('awaits the hook for an HTTP action too', async () => {
    const http_ = { async invoke() { return { statusCode: 200, headers: {}, body: 'x' }; } };
    const flow: FlowIR = { name: 'f', nodes: [TRIGGER, getItems('First', 'a'), http] } as any;
    const r = await run(flow, {
      connectors: { http: http_, sharepoint: new SpyConnector() },
      onBeforeExecute: async (node) => (node.name === 'Call' ? 'stop' : 'continue'),
    });
    assert.equal(r.stopped, true);
    assert.equal(r.stoppedBefore?.name, 'Call');
    assert.equal(r.stoppedBefore?.inputs?.uri, 'https://example.invalid');
  });
});
