import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, type BaseConnector, type RunContext, type RunOptions } from '../index.js';
import type { FlowIR, Node } from '@flowforger/ir';

/**
 * `onBeforeExecute` — the hook behind `flowforger run --stop-before <action>`: the run ends
 * before the named node executes, with the trace so far and, for connector / HTTP / child-flow
 * actions, the payload the call would have been made with.
 */

class SpyConnector implements BaseConnector {
  readonly seen: Array<{ operation: string; inputs: any }> = [];
  async invoke(operation: string, inputs: any, _ctx: RunContext): Promise<any> {
    this.seen.push({ operation, inputs });
    return { ok: true };
  }
}

const TRIGGER = { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'POST' } } as any;
const compose = (name: string, value: any = 1) => ({ id: `act_${name}`, name, type: 'action', kind: 'compose', inputs: { value } });
const stopBefore = (name: string): RunOptions['onBeforeExecute'] => (node: Node) => (node.name === name ? 'stop' : 'continue');

describe('onBeforeExecute / stop before an action', () => {
  it('ends the run before a top-level node, keeping the trace so far', async () => {
    const flow: FlowIR = { name: 'f', nodes: [TRIGGER, compose('A'), compose('B'), compose('C')] } as any;
    const r = await run(flow, { onBeforeExecute: stopBefore('B') });
    assert.equal(r.status, 'Cancelled');
    assert.equal(r.stopped, true);
    assert.deepEqual(r.stoppedBefore, { nodeId: 'act_B', name: 'B' });
    assert.deepEqual(r.trace.map((t) => [t.name, t.status]), [['manual', 'Succeeded'], ['A', 'Succeeded'], ['B', 'Cancelled']]);
  });

  it('hands a connector action its resolved inputs and never invokes the connector', async () => {
    const dataverse = new SpyConnector();
    const flow: FlowIR = {
      name: 'f',
      nodes: [
        TRIGGER,
        compose('Id', 'abc-123'),
        {
          id: 'scp_1', name: 'Work', type: 'scope',
          actions: [
            compose('Inside', 2),
            { id: 'con_1', name: 'Update', type: 'connector', connector: 'dataverse', operation: 'UpdateRecord',
              params: { entityName: 'contacts', recordId: "@outputs('Id')", item: { name: "@concat('x', outputs('Inside'))" } } },
            compose('After', 3),
          ],
        },
        compose('Last', 4),
      ],
    } as any;
    const seen: Array<{ name: string; inputs: any }> = [];
    const r = await run(flow, {
      connectors: { dataverse },
      onBeforeExecute: (node, _ctx, inputs) => {
        seen.push({ name: node.name, inputs });
        return node.name === 'Update' ? 'stop' : 'continue';
      },
    });
    assert.equal(r.status, 'Cancelled');
    assert.deepEqual(r.stoppedBefore, {
      nodeId: 'con_1', name: 'Update',
      inputs: { entityName: 'contacts', recordId: 'abc-123', item: { name: 'x2' } },
    });
    assert.equal(dataverse.seen.length, 0, 'the connector was not called');
    // non-connector nodes get the hook without inputs; the connector gets it once, with inputs
    assert.deepEqual(seen.map((s) => s.name), ['Id', 'Work', 'Inside', 'Update']);
    assert.equal(seen[0].inputs, undefined);
    const work = r.trace.find((t) => t.name === 'Work')!;
    assert.equal(work.status, 'Cancelled');
    assert.deepEqual(work.children!.map((t) => [t.name, t.status]), [['Inside', 'Succeeded'], ['Update', 'Cancelled']]);
    assert.equal(r.trace.some((t) => t.name === 'Last'), false, 'nothing after the stop runs');
  });

  it('stops inside a foreach iteration and reports the iterations run so far', async () => {
    const flow: FlowIR = {
      name: 'f',
      nodes: [
        TRIGGER,
        { id: 'fe_1', name: 'Each', type: 'foreach', itemsExpression: '@createArray(1, 2, 3)',
          runtimeConfiguration: { concurrency: { repetitions: 1 } },
          actions: [compose('Item', "@items('Each')"), compose('Twice', "@mul(items('Each'), 2)")] },
        compose('Done'),
      ],
    } as any;
    let calls = 0;
    const r = await run(flow, {
      onBeforeExecute: (node) => (node.name === 'Twice' && ++calls === 2 ? 'stop' : 'continue'),
    });
    assert.equal(r.status, 'Cancelled');
    const each = r.trace.find((t) => t.name === 'Each')!;
    assert.equal(each.status, 'Cancelled');
    assert.equal(each.iterations!.length, 2);
    assert.deepEqual(each.iterations![1].actions.map((t) => [t.name, t.status]), [['Item', 'Succeeded'], ['Twice', 'Cancelled']]);
    assert.equal(r.trace.some((t) => t.name === 'Done'), false);
  });

  it('a hook that always continues changes nothing', async () => {
    const flow: FlowIR = { name: 'f', nodes: [TRIGGER, compose('A'), compose('B')] } as any;
    const r = await run(flow, { onBeforeExecute: () => 'continue' });
    assert.equal(r.status, 'Succeeded');
    assert.equal(r.stopped, undefined);
    assert.deepEqual(r.trace.map((t) => t.status), ['Succeeded', 'Succeeded', 'Succeeded']);
  });
});
