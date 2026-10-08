/**
 * The HTTP action and "Run a Child Flow" as the cloud runs them (conformance/flows/http.ff.ts,
 * child-flow.ff.ts): which answers fail the action, retries, the 202 polling pattern, the
 * inputs record, and what a parent gets from its child's Response.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR } from '@flowforger/ir';
import { run, type BaseConnector } from '../index.js';
import { executeHttpAction, retryDelayMs, httpInputsRecord } from '../http-action.js';

const TRIGGER = { id: 'trg', name: 'manual', type: 'trigger', kind: 'http' } as any;

/** An http connector answering from a list of outputs (or errors), recording what it was asked. */
function scripted(answers: any[]) {
  const calls: any[] = [];
  const conn: BaseConnector = {
    async invoke(_op, inputs) {
      calls.push(inputs);
      const a = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return { conn, calls };
}

function fakeCtx() {
  const slept: number[] = [];
  return {
    slept,
    ctx: {
      variables: {},
      actions: new Map(),
      iterationStack: [],
      now: () => new Date('2026-10-01T00:00:00Z'),
      sleep: async (ms: number) => void slept.push(ms),
      log: () => {},
      secrets: () => undefined,
      connector: () => undefined as any,
    } as any,
  };
}

const httpNode = (extra: any = {}) =>
  ({ id: 'a', name: 'Call', type: 'action', kind: 'http', inputs: { method: 'GET', url: 'https://x/a' }, ...extra }) as any;

describe('HTTP action', () => {
  it('fails on status >= 400 with the response as outputs and the status name as code', async () => {
    const { conn } = scripted([{ statusCode: 404, headers: {}, body: 'nope' }]);
    const flow: FlowIR = {
      name: 'f',
      nodes: [
        TRIGGER,
        httpNode(),
        {
          id: 'p',
          name: 'Probe',
          type: 'action',
          kind: 'compose',
          runAfter: { Call: ['Failed'] },
          inputs: { value: { code: "@actions('Call')?['code']", error: "@actions('Call')?['error']", body: "@body('Call')" } },
        } as any,
      ],
    };
    const result = await run(flow, { connectors: { http: conn } });
    const call = result.trace.find(t => t.name === 'Call')!;
    assert.equal(call.status, 'Failed');
    assert.deepEqual(call.outputs, { statusCode: 404, headers: {}, body: 'nope' });
    assert.deepEqual(result.trace.find(t => t.name === 'Probe')!.outputs, { code: 'NotFound', error: null, body: 'nope' });
  });

  it('reports a status .NET Framework has no name for as the number', async () => {
    const { conn } = scripted([{ statusCode: 429, headers: {} }]);
    const flow: FlowIR = {
      name: 'f',
      nodes: [
        TRIGGER,
        httpNode({ retryPolicy: { type: 'none' } }),
        { id: 'p', name: 'Probe', type: 'action', kind: 'compose', runAfter: { Call: ['Failed'] }, inputs: { value: "@actions('Call')?['code']" } } as any,
      ],
    };
    const result = await run(flow, { connectors: { http: conn } });
    assert.equal(result.trace.find(t => t.name === 'Probe')!.outputs, '429');
  });

  it('retries 408/429/5xx under the default policy, 4 times, honouring Retry-After', async () => {
    const { conn, calls } = scripted([
      { statusCode: 503, headers: { 'Retry-After': '2' } },
      { statusCode: 503, headers: {} },
      { statusCode: 200, headers: {}, body: 'ok' },
    ]);
    const { ctx, slept } = fakeCtx();
    const r = await executeHttpAction(httpNode(), ctx, conn);
    assert.equal(r.status, 'Succeeded');
    assert.equal(calls.length, 3);
    assert.deepEqual(slept, [2000, 15_000]);

    const always = scripted([{ statusCode: 500, headers: {} }]);
    const f = fakeCtx();
    const failed = await executeHttpAction(httpNode(), f.ctx, always.conn);
    assert.equal(failed.status, 'Failed');
    assert.equal(always.calls.length, 5);
    assert.deepEqual(f.slept, [7_500, 15_000, 30_000, 45_000]);
  });

  it('does not retry other 4xx answers, nor anything under retryPolicy none', async () => {
    for (const [node, answer] of [
      [httpNode(), { statusCode: 400, headers: {} }],
      [httpNode({ retryPolicy: { type: 'none' } }), { statusCode: 503, headers: {} }],
    ] as const) {
      const { conn, calls } = scripted([answer]);
      const { ctx } = fakeCtx();
      assert.equal((await executeHttpAction(node, ctx, conn)).status, 'Failed');
      assert.equal(calls.length, 1);
    }
  });

  it('computes fixed and exponential intervals from ISO durations', () => {
    assert.equal(retryDelayMs({ type: 'fixed', count: 2, interval: 'PT10S' }, 1, undefined), 10_000);
    assert.equal(retryDelayMs({ type: 'fixed', count: 2, interval: 'PT10S' }, 3, undefined), undefined);
    assert.equal(retryDelayMs({ type: 'exponential', count: 3, interval: 'PT1S', minimumInterval: 'PT2S' }, 1, undefined), 2_000);
    assert.equal(retryDelayMs({ type: 'exponential', count: 3, interval: 'PT1S' }, 3, undefined), 5_000);
  });

  it('polls the Location of a 202 with GET until the answer is not 202', async () => {
    const { conn, calls } = scripted([
      { statusCode: 202, headers: { Location: 'https://x/status', 'Retry-After': '1' } },
      { statusCode: 202, headers: { Location: 'https://x/status' } },
      { statusCode: 200, headers: {}, body: 'done' },
    ]);
    const { ctx, slept } = fakeCtx();
    const r = await executeHttpAction(httpNode(), ctx, conn);
    assert.equal(r.status, 'Succeeded');
    assert.equal(r.outputs.body, 'done');
    assert.deepEqual(calls.slice(1).map(c => [c.method, c.uri]), [['GET', 'https://x/status'], ['GET', 'https://x/status']]);
    assert.deepEqual(slept, [1000, 10_000]);

    const noPoll = scripted([{ statusCode: 202, headers: { Location: 'https://x/status' } }]);
    const r2 = await executeHttpAction(httpNode({ operationOptions: 'DisableAsyncPattern' }), fakeCtx().ctx, noPoll.conn);
    assert.equal(r2.outputs.statusCode, 202);
    assert.equal(noPoll.calls.length, 1);
  });

  it('fails without outputs, with the cloud error, when no response came back', async () => {
    const err = Object.assign(new Error("The provided host name 'h' could not be resolved."), {
      name: 'HttpActionError',
      code: 'UnresolvableHostName',
      cloudError: { code: 'UnresolvableHostName', message: "The provided host name 'h' could not be resolved." },
    });
    const { conn } = scripted([err]);
    const r = await executeHttpAction(httpNode({ retryPolicy: { type: 'none' } }), fakeCtx().ctx, conn);
    assert.equal(r.status, 'Failed');
    assert.equal(r.outputs, undefined);
    assert.equal(r.code, 'UnresolvableHostName');
  });

  it('records inputs as the cloud does: uri, sanitized secrets, capitalized policy type', () => {
    assert.deepEqual(
      httpInputsRecord(
        { method: 'POST', url: 'https://x', authentication: { type: 'Basic', username: 'u', password: 'p' } },
        { type: 'none' },
      ),
      {
        uri: 'https://x',
        method: 'POST',
        retryPolicy: { type: 'None' },
        authentication: { type: 'Basic', username: 'u', password: '*sanitized*' },
      },
    );
  });
});

describe('Run a Child Flow', () => {
  const child = (...actions: any[]): FlowIR => ({ name: 'Child', nodes: [TRIGGER, ...actions] });
  const respond = (inputs: any, name = 'Respond') => ({ id: name, name, type: 'action', kind: 'response', inputs }) as any;
  const parent: FlowIR = {
    name: 'Parent',
    childFlows: { Child: { workflowId: '11111111-2222-3333-4444-555555555555' } },
    nodes: [
      TRIGGER,
      { id: 'c', name: 'Call', type: 'action', kind: 'workflow', retryPolicy: { type: 'none' }, inputs: { workflowReferenceName: 'Child', body: { n: 21 } } } as any,
      {
        id: 'p',
        name: 'Probe',
        type: 'action',
        kind: 'compose',
        runAfter: { Call: ['Succeeded', 'Failed'] },
        inputs: { value: { code: "@actions('Call')?['code']", status: "@outputs('Call')?['statusCode']", body: "@body('Call')" } },
      } as any,
    ],
  };
  const runWith = (c: FlowIR) => run(parent, { loadChildFlow: async () => c });
  const probe = (r: any) => r.trace.find((t: any) => t.name === 'Probe').outputs;

  it("gives the parent the child's response, with the workflowId in the inputs record", async () => {
    const r = await runWith(child(respond({ statusCode: 200, body: { doubled: "@mul(triggerBody()?['n'], 2)" } })));
    assert.deepEqual(probe(r), { code: 'OK', status: 200, body: { doubled: 42 } });
    const call = r.trace.find(t => t.name === 'Call')!;
    assert.deepEqual(call.inputs, {
      host: { workflowReferenceName: '11111111-2222-3333-4444-555555555555' },
      retryPolicy: { type: 'None' },
      body: { n: 21 },
    });
    assert.equal((call.outputs as any).headers['Content-Type'], 'application/json; charset=utf-8');
  });

  it('fails with 502 NoResponse when the child ends without responding, even successfully', async () => {
    const r = await runWith(child({ id: 'x', name: 'Done', type: 'action', kind: 'compose', inputs: { value: 1 } }));
    const p = probe(r);
    assert.equal(p.code, 'BadGateway');
    assert.equal(p.status, 502);
    assert.equal(p.body.error.code, 'NoResponse');
    assert.match(p.body.error.message, /^The server did not receive a response from an upstream server\. Request tracking id '\d{29}CU\d{2}'\.$/);
  });

  it('fails with the status name when the child answers >= 400, evaluating status and headers', async () => {
    const r = await runWith(
      child(respond({ statusCode: "@add(399, 1)", headers: "@json('{\"X-Kind\":\"bad\"}')", body: { error: 'bad' } })),
    );
    const call = r.trace.find(t => t.name === 'Call')!;
    assert.equal(call.status, 'Failed');
    assert.equal((call.outputs as any).headers['X-Kind'], 'bad');
    assert.deepEqual(probe(r), { code: 'BadRequest', status: 400, body: { error: 'bad' } });
  });

  it('succeeds when the child responds and then fails', async () => {
    const r = await runWith(
      child(respond({ statusCode: 200, body: { early: true } }), {
        id: 'f',
        name: 'Fail',
        type: 'action',
        kind: 'compose',
        runAfter: { Respond: ['Succeeded'] },
        inputs: { value: '@div(1, 0)' },
      }),
    );
    assert.deepEqual(probe(r), { code: 'OK', status: 200, body: { early: true } });
  });
});
