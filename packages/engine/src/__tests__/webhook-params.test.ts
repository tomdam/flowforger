import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, type BaseConnector, type RunContext } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

/**
 * A `connectorwebhook` action (`ctx.connectorWebhook()`, e.g. Approvals) resolves the
 * expressions in its parameters before the connector is invoked, exactly like a plain
 * connector action does, and records those resolved inputs on its trace entry.
 */

class SpyConnector implements BaseConnector {
  readonly seen: Array<{ operation: string; inputs: any }> = [];
  async invoke(operation: string, inputs: any, _ctx: RunContext): Promise<any> {
    this.seen.push({ operation, inputs });
    return { outcome: 'Approve' };
  }
}

const TRIGGER = { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'POST' } } as any;
const compose = (name: string, value: any) => ({ id: `act_${name}`, name, type: 'action', kind: 'compose', inputs: { value } });
const webhook = (name: string) => ({
  id: `con_${name}`, name, type: 'connectorwebhook', connector: 'approvals', operation: 'StartAndWaitForAnApproval',
  params: {
    approvalType: 'Basic',
    'WebhookApprovalCreationInput/title': "@concat('Approve ', outputs('Subject'))",
    'WebhookApprovalCreationInput/assignedTo': "@outputs('Approver')",
    'WebhookApprovalCreationInput/details': "@outputs('Missing')?['nothing']",
  },
});

describe('connectorwebhook parameters', () => {
  it('evaluates expressions before invoking the connector and records the resolved inputs', async () => {
    const approvals = new SpyConnector();
    const flow: FlowIR = {
      name: 'f',
      nodes: [TRIGGER, compose('Subject', 'Invoice 4711'), compose('Approver', 'boss@contoso.com'), compose('Missing', {}), webhook('Wait')],
    } as any;
    const r = await run(flow, { connectors: { approvals } });

    assert.equal(r.status, 'Succeeded');
    assert.equal(approvals.seen.length, 1);
    const expected = {
      approvalType: 'Basic',
      'WebhookApprovalCreationInput/title': 'Approve Invoice 4711',
      'WebhookApprovalCreationInput/assignedTo': 'boss@contoso.com',
      // Like the cloud, a parameter whose expression finds nothing is sent as null, not dropped.
      'WebhookApprovalCreationInput/details': null,
    };
    assert.deepEqual(approvals.seen[0].inputs, expected, 'the connector receives resolved values, not expression text');
    const entry = r.trace.find((t) => t.name === 'Wait')!;
    assert.deepEqual(entry.inputs, expected, 'the trace carries the resolved inputs');
    assert.deepEqual(entry.outputs, { body: { outcome: 'Approve' } });
  });

  it('records the resolved inputs on the simulated run too (no connector provided)', async () => {
    const flow: FlowIR = { name: 'f', nodes: [TRIGGER, compose('Subject', 'x'), compose('Approver', 'y'), compose('Missing', {}), webhook('Wait')] } as any;
    const r = await run(flow, {});
    assert.equal(r.status, 'Succeeded');
    const entry = r.trace.find((t) => t.name === 'Wait')!;
    assert.equal(entry.inputs?.['WebhookApprovalCreationInput/title'], 'Approve x');
    assert.equal(entry.outputs?.body?.simulated, true);
  });

  it('a mock still replaces the webhook action and its inputs are still resolved', async () => {
    const approvals = new SpyConnector();
    const flow: FlowIR = { name: 'f', nodes: [TRIGGER, compose('Subject', 'x'), compose('Approver', 'y'), compose('Missing', {}), webhook('Wait')] } as any;
    const mock = { body: { outcome: 'Reject' } };
    const r = await run(flow, { connectors: { approvals }, mocks: { Wait: mock } });
    assert.equal(r.status, 'Succeeded');
    assert.deepEqual(approvals.seen, []);
    const entry = r.trace.find((t) => t.name === 'Wait')!;
    assert.equal(entry.mocked, true);
    assert.deepEqual(entry.outputs, mock);
    assert.equal(entry.inputs?.['WebhookApprovalCreationInput/title'], 'Approve x');
  });

  it('--stop-before on a webhook action stops with the resolved inputs', async () => {
    const approvals = new SpyConnector();
    const flow: FlowIR = { name: 'f', nodes: [TRIGGER, compose('Subject', 'x'), compose('Approver', 'y'), compose('Missing', {}), webhook('Wait')] } as any;
    const r = await run(flow, { connectors: { approvals }, onBeforeExecute: (node) => (node.name === 'Wait' ? 'stop' : 'continue') });
    assert.equal(r.stopped, true);
    assert.equal(r.stoppedBefore?.name, 'Wait');
    assert.equal(r.stoppedBefore?.inputs?.['WebhookApprovalCreationInput/title'], 'Approve x');
    assert.deepEqual(approvals.seen, []);
  });
});
