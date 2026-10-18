import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, flattenTrace, loopIndexes, type BaseConnector, type RunContext, type MockResolver } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

/**
 * `RunOptions.mocks` as a resolver — the hook behind replaying a cloud run: a function that
 * sees the node, its resolved inputs and the enclosing loops' indexes, and answers with a
 * `MockResult` (outputs and, for a recorded failure, status/code/error) or undefined to run live.
 */

class SpyConnector implements BaseConnector {
  readonly seen: Array<{ operation: string; inputs: any }> = [];
  async invoke(operation: string, inputs: any, _ctx: RunContext): Promise<any> {
    this.seen.push({ operation, inputs });
    return { value: [{ Title: 'live' }] };
  }
}

const TRIGGER = { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'POST' } } as any;
const compose = (name: string, value: any = 1) => ({ id: `act_${name}`, name, type: 'action', kind: 'compose', inputs: { value } });
const getItems = (name: string, extra: Record<string, unknown> = {}) => ({
  id: `con_${name}`, name, type: 'connector', connector: 'sharepoint', operation: 'GetItems',
  params: { dataset: 'https://contoso.sharepoint.com/sites/A', table: 'list-guid' },
  ...extra,
});

describe('RunOptions.mocks as a resolver', () => {
  it('is called with the node, its resolved inputs and the enclosing loop indexes, outermost first', async () => {
    const sharepoint = new SpyConnector();
    const flow: FlowIR = {
      name: 'f',
      nodes: [
        TRIGGER,
        {
          id: 'fe_outer', name: 'Outer', type: 'foreach', itemsExpression: '@createArray(10, 20)',
          actions: [
            { id: 'fe_inner', name: 'Inner', type: 'foreach', itemsExpression: '@createArray(1, 2)', actions: [getItems('Get')] },
          ],
        },
      ],
    } as any;
    const calls: Array<{ name: string; inputs: any; indexes: Array<{ scopeName: string; itemIndex: number }> }> = [];
    const resolver: MockResolver = (node, ctx, inputs) => {
      const indexes = loopIndexes(ctx);
      calls.push({ name: node.name, inputs, indexes });
      // Only the second item of the first outer iteration is pinned; everything else runs live.
      if (node.name === 'Get' && indexes[0].itemIndex === 0 && indexes[1].itemIndex === 1) {
        return { outputs: { statusCode: 200, body: { value: [{ Title: 'pinned' }] } } };
      }
      return undefined;
    };
    const r = await run(flow, { connectors: { sharepoint }, mocks: resolver });

    assert.equal(r.status, 'Succeeded');
    assert.equal(sharepoint.seen.length, 3, 'three of the four calls run live');
    const getCalls = calls.filter((c) => c.name === 'Get');
    assert.deepEqual(getCalls.map((c) => c.indexes), [
      [{ scopeName: 'Outer', itemIndex: 0 }, { scopeName: 'Inner', itemIndex: 0 }],
      [{ scopeName: 'Outer', itemIndex: 0 }, { scopeName: 'Inner', itemIndex: 1 }],
      [{ scopeName: 'Outer', itemIndex: 1 }, { scopeName: 'Inner', itemIndex: 0 }],
      [{ scopeName: 'Outer', itemIndex: 1 }, { scopeName: 'Inner', itemIndex: 1 }],
    ]);
    assert.deepEqual(getCalls[0].inputs, { dataset: 'https://contoso.sharepoint.com/sites/A', table: 'list-guid' }, 'a connector resolver sees the resolved inputs');
    const outer = r.trace.find((t) => t.name === 'Outer')!;
    const inner0 = outer.iterations![0].actions[0];
    assert.deepEqual(inner0.iterations!.map((it) => [it.actions[0].mocked ?? false, it.actions[0].outputs.body.value[0].Title]), [[false, 'live'], [true, 'pinned']]);
  });

  it('an until loop contributes its iteration index too', async () => {
    const flow: FlowIR = {
      name: 'f',
      nodes: [
        TRIGGER,
        { id: 'act_init', name: 'Init', type: 'action', kind: 'initializevariable', inputs: { variableName: 'n', type: 'integer', value: 0 } },
        {
          id: 'du_1', name: 'Until_three', type: 'dountil', condition: "@greaterOrEquals(variables('n'), 3)", limit: 10,
          actions: [
            { id: 'act_inc', name: 'Inc', type: 'action', kind: 'incrementvariable', inputs: { name: 'n', value: 1 } },
            compose('Note', "@variables('n')"),
          ],
        },
      ],
    } as any;
    const seen: Array<Array<{ scopeName: string; itemIndex: number }>> = [];
    const r = await run(flow, {
      mocks: (node, ctx) => {
        if (node.name !== 'Note') return undefined;
        seen.push(loopIndexes(ctx));
        return { outputs: `iteration ${loopIndexes(ctx)[0].itemIndex}` };
      },
    });
    assert.equal(r.status, 'Succeeded');
    assert.deepEqual(seen, [[{ scopeName: 'Until_three', itemIndex: 0 }], [{ scopeName: 'Until_three', itemIndex: 1 }], [{ scopeName: 'Until_three', itemIndex: 2 }]]);
    const until = r.trace.find((t) => t.name === 'Until_three')!;
    assert.deepEqual(until.iterations!.map((it) => it.actions[1].outputs), ['iteration 0', 'iteration 1', 'iteration 2']);
  });

  it('a mocked failure runs the catch path and reports the cloud code like a real failure', async () => {
    const flow: FlowIR = {
      name: 'f',
      nodes: [
        TRIGGER,
        { id: 'scp_try', name: 'Try', type: 'scope', actions: [getItems('Get_missing'), { ...compose('After_missing', 1), runAfter: { Get_missing: ['Succeeded'] } }] },
        {
          id: 'scp_catch', name: 'Catch', type: 'scope', runAfter: { Try: ['Failed'] },
          actions: [
            compose('Report', {
              tryStatus: "@actions('Try')?['status']",
              tryCode: "@actions('Try')?['code']",
              missingStatus: "@actions('Get_missing')?['status']",
              missingCode: "@actions('Get_missing')?['code']",
              missingBody: "@body('Get_missing')?['message']",
              missingStatusCode: "@outputs('Get_missing')?['statusCode']",
              afterStatus: "@actions('After_missing')?['status']",
            }),
          ],
        },
      ],
    } as any;
    const r = await run(flow, {
      mocks: (node) =>
        node.name === 'Get_missing'
          ? { status: 'Failed', code: 'NotFound', outputs: { statusCode: 404, body: { status: 404, message: 'Item Not Found' } } }
          : undefined,
    });
    assert.equal(r.status, 'Succeeded', 'the catch scope handles the failure');
    const flat = flattenTrace(r.trace);
    const get = flat.find((t) => t.name === 'Get_missing')!;
    assert.equal(get.status, 'Failed');
    assert.equal(get.mocked, true);
    assert.equal(flat.find((t) => t.name === 'After_missing')!.status, 'Skipped');
    assert.equal(flat.find((t) => t.name === 'Try')!.status, 'Failed');
    assert.equal(flat.find((t) => t.name === 'Catch')!.status, 'Succeeded');
    assert.deepEqual(flat.find((t) => t.name === 'Report')!.outputs, {
      tryStatus: 'Failed',
      tryCode: 'ActionFailed',
      missingStatus: 'Failed',
      missingCode: 'NotFound',
      missingBody: 'Item Not Found',
      missingStatusCode: 404,
      afterStatus: 'Skipped',
    });
  });

  it('an unhandled mocked failure fails the run, and a recorded error object is what actions() reports', async () => {
    const flow: FlowIR = {
      name: 'f',
      nodes: [
        TRIGGER,
        compose('Parse', 1),
        { ...compose('Next', 2), runAfter: { Parse: ['Succeeded'] } },
        { ...compose('Always', "@actions('Parse')?['error']"), runAfter: { Next: ['Succeeded', 'Failed', 'Skipped'] } },
      ],
    } as any;
    const r = await run(flow, {
      mocks: (node) =>
        node.name === 'Parse'
          ? { status: 'Failed', code: 'BadRequest', error: { code: 'InvalidTemplate', message: 'Unable to process template language expressions' } }
          : undefined,
    });
    assert.equal(r.status, 'Failed');
    assert.equal(r.trace.find((t) => t.name === 'Next')!.status, 'Skipped', 'a plain successor is skipped like after a real failure');
    assert.deepEqual(r.trace.find((t) => t.name === 'Always')!.outputs, { code: 'InvalidTemplate', message: 'Unable to process template language expressions' });
    assert.deepEqual(r.trace.find((t) => t.name === 'Parse')!.error, { code: 'InvalidTemplate', message: 'Unable to process template language expressions' });
  });

  it('a mocked HTTP action and a mocked child flow take the resolver result too', async () => {
    const flow: FlowIR = {
      name: 'f',
      nodes: [
        TRIGGER,
        { id: 'act_http', name: 'Call', type: 'action', kind: 'http', inputs: { method: 'GET', uri: 'https://example.invalid/x' } },
        { id: 'act_child', name: 'Child', type: 'action', kind: 'workflow', inputs: { workflowReferenceName: 'child-id', body: { a: 1 } }, runAfter: { Call: ['Succeeded'] } },
        { ...compose('Sum', "@add(outputs('Call')?['statusCode'], outputs('Child')?['statusCode'])"), runAfter: { Child: ['Succeeded'] } },
      ],
    } as any;
    const r = await run(flow, {
      connectors: { http: new SpyConnector() },
      mocks: (node, _ctx, inputs) => {
        if (node.name === 'Call') return { outputs: { statusCode: 200, headers: {}, body: inputs.uri } };
        if (node.name === 'Child') return { status: 'Failed', code: 'BadGateway', outputs: { statusCode: 502, body: { error: { code: 'NoResponse' } } } };
        return undefined;
      },
    });
    assert.equal(r.status, 'Failed');
    assert.deepEqual(r.trace.find((t) => t.name === 'Call')!.outputs, { statusCode: 200, headers: {}, body: 'https://example.invalid/x' });
    assert.equal(r.trace.find((t) => t.name === 'Child')!.status, 'Failed');
    assert.equal(r.trace.find((t) => t.name === 'Sum')!.status, 'Skipped');
  });

  it('the map form keeps working alongside', async () => {
    const flow: FlowIR = { name: 'f', nodes: [TRIGGER, compose('A', 1)] } as any;
    const r = await run(flow, { mocks: { A: 'map' } });
    assert.equal(r.trace.find((t) => t.name === 'A')!.outputs, 'map');
  });
});
