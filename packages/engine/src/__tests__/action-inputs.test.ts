import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, type BaseConnector, type RunContext } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

/**
 * Records its invocations and grabs the live RunContext. `run()` does not
 * return its context, but the same object is handed to every connector call
 * and mutated in place, so holding the reference lets a test read
 * `ctx.actions` — the exact map the debug Action Outputs pane renders — after
 * the run finishes.
 */
class SpyConnector implements BaseConnector {
  readonly seen: Array<{ operation: string; inputs: any }> = [];
  ctx: RunContext | null = null;
  constructor(private readonly respond: (operation: string, inputs: any) => any = () => ({ ok: true })) {}
  async invoke(operation: string, inputs: any, ctx: RunContext): Promise<any> {
    this.seen.push({ operation, inputs });
    this.ctx = ctx;
    return this.respond(operation, inputs);
  }
}

class FailingConnector implements BaseConnector {
  ctx: RunContext | null = null;
  async invoke(_operation: string, _inputs: any, ctx: RunContext): Promise<any> {
    this.ctx = ctx;
    throw new Error('boom');
  }
}

const TRIGGER = { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'POST' } } as any;

describe('resolved action inputs', () => {
  it('records a connector action\'s post-evaluation params on ctx.actions', async () => {
    const dataverse = new SpyConnector(() => ({ accountid: 'a-1' }));
    const flow: FlowIR = {
      name: 'connector-inputs',
      nodes: [
        TRIGGER,
        {
          id: 'act_1',
          name: 'Init_city',
          type: 'action',
          kind: 'initializevariable',
          inputs: { variableName: 'city', value: 'Berlin' },
        } as any,
        {
          id: 'con_1',
          name: 'Create_account',
          type: 'connector',
          connector: 'dataverse',
          operation: 'CreateRecord',
          params: { entityName: 'accounts', item: { name: 'Contoso', address1_city: "@variables('city')" } },
        } as any,
      ],
    };

    await run(flow, { input: {}, connectors: { dataverse } });

    const expected = { entityName: 'accounts', item: { name: 'Contoso', address1_city: 'Berlin' } };
    // What the connector actually received...
    assert.deepEqual(dataverse.seen[0].inputs, expected);
    // ...is what the pane will show.
    assert.deepEqual(dataverse.ctx!.actions.get('Create_account')?.inputs, expected);
  });

  it('stamps ctx.currentAction.inputs so action().inputs resolves', async () => {
    const dataverse = new SpyConnector();
    const flow: FlowIR = {
      name: 'current-action-inputs',
      nodes: [
        TRIGGER,
        {
          id: 'con_1',
          name: 'Create_account',
          type: 'connector',
          connector: 'dataverse',
          operation: 'CreateRecord',
          params: { entityName: 'accounts' },
        } as any,
      ],
    };

    await run(flow, { input: {}, connectors: { dataverse } });
    assert.deepEqual(dataverse.ctx!.currentAction?.inputs, { entityName: 'accounts' });
  });

  it('exposes connector inputs via the run trace', async () => {
    const dataverse = new SpyConnector();
    const flow: FlowIR = {
      name: 'connector-trace',
      nodes: [
        TRIGGER,
        {
          id: 'con_1',
          name: 'Create_account',
          type: 'connector',
          connector: 'dataverse',
          operation: 'CreateRecord',
          params: { entityName: 'accounts', item: { name: "@triggerBody()?['company']" } },
        } as any,
      ],
    };

    const result = await run(flow, { input: { company: 'Fabrikam' }, connectors: { dataverse } });
    const entry = result.trace.find((t) => t.name === 'Create_account');
    assert.deepEqual(entry?.inputs, { entityName: 'accounts', item: { name: 'Fabrikam' } });
  });

  it('records inputs for an HTTP action', async () => {
    const http = new SpyConnector(() => ({ statusCode: 200, headers: {}, body: { ok: true } }));
    const flow: FlowIR = {
      name: 'http-inputs',
      nodes: [
        TRIGGER,
        {
          id: 'act_1',
          name: 'Call_api',
          type: 'action',
          kind: 'http',
          inputs: { method: 'POST', uri: 'https://example.com/api', body: { id: "@triggerBody()?['id']" } },
        } as any,
      ],
    };

    const result = await run(flow, { input: { id: 42 }, connectors: { http } });
    const entry = result.trace.find((t) => t.name === 'Call_api');
    assert.deepEqual(entry?.inputs, {
      method: 'POST',
      uri: 'https://example.com/api',
      body: { id: 42 },
    });
    assert.deepEqual(http.ctx!.actions.get('Call_api')?.inputs, entry?.inputs);
  });

  it('records inputs even when the connector call fails', async () => {
    const dataverse = new FailingConnector();
    const flow: FlowIR = {
      name: 'connector-failure',
      nodes: [
        TRIGGER,
        {
          id: 'con_1',
          name: 'Create_account',
          type: 'connector',
          connector: 'dataverse',
          operation: 'CreateRecord',
          params: { entityName: 'accounts', item: { name: 'Contoso' } },
        } as any,
      ],
    };

    const result = await run(flow, { input: {}, connectors: { dataverse } });
    assert.equal(result.status, 'Failed');
    const expected = { entityName: 'accounts', item: { name: 'Contoso' } };
    const entry = result.trace.find((t) => t.name === 'Create_account');
    assert.deepEqual(entry?.inputs, expected);
    assert.deepEqual(dataverse.ctx!.actions.get('Create_account')?.inputs, expected);
  });

  it('records inputs for a connector action nested in a scope', async () => {
    const dataverse = new SpyConnector();
    const flow: FlowIR = {
      name: 'nested-inputs',
      nodes: [
        TRIGGER,
        {
          id: 'scp_1',
          name: 'Try',
          type: 'scope',
          actions: [
            {
              id: 'con_1',
              name: 'Create_account',
              type: 'connector',
              connector: 'dataverse',
              operation: 'CreateRecord',
              params: { entityName: 'accounts' },
            } as any,
          ],
        } as any,
      ],
    };

    const result = await run(flow, { input: {}, connectors: { dataverse } });
    // Scope children are recorded by runChildNodes, a different code path than
    // the top-level loop, so it gets its own assertion.
    assert.deepEqual(dataverse.ctx!.actions.get('Create_account')?.inputs, { entityName: 'accounts' });
    const entry = result.trace.find((t) => t.name === 'Create_account');
    assert.deepEqual(entry?.inputs, { entityName: 'accounts' });
  });

  it('records the resolved body for a child-flow call', async () => {
    const child: FlowIR = {
      name: 'Child',
      nodes: [
        { id: 'trg_c', name: 'manual', type: 'trigger', inputs: { method: 'POST' } } as any,
        { id: 'act_c', name: 'Echo', type: 'action', kind: 'compose', inputs: { value: 'done' } } as any,
      ],
    };
    const flow: FlowIR = {
      name: 'parent',
      nodes: [
        TRIGGER,
        {
          id: 'act_1',
          name: 'Call_child',
          type: 'action',
          kind: 'workflow',
          inputs: { workflowReferenceName: 'child-guid', body: { name: "@triggerBody()?['name']" } },
        } as any,
      ],
    };

    const result = await run(flow, {
      input: { name: 'Jane' },
      loadChildFlow: async () => child,
    });
    const entry = result.trace.find((t) => t.name === 'Call_child');
    assert.deepEqual(entry?.inputs, {
      workflowReferenceName: 'child-guid',
      body: { name: 'Jane' },
    });
  });

  it('leaves inputs unset for kinds whose resolved input is already the output', async () => {
    const flow: FlowIR = {
      name: 'no-inputs',
      nodes: [
        TRIGGER,
        { id: 'act_1', name: 'Init_n', type: 'action', kind: 'initializevariable', inputs: { variableName: 'n', value: 1 } } as any,
        { id: 'act_2', name: 'Compose_greeting', type: 'action', kind: 'compose', inputs: { value: 'hello' } } as any,
      ],
    };

    const result = await run(flow, { input: {} });
    for (const name of ['Init_n', 'Compose_greeting']) {
      const entry = result.trace.find((t) => t.name === name);
      assert.ok(entry, `expected a trace entry for ${name}`);
      assert.ok(!('inputs' in entry), `${name} should not carry an inputs key`);
    }
  });
});
