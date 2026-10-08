import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, type BaseConnector, type TraceEntry } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

// Output shapes verified against real cloud runs (conformance/flows/*-errors, *-read).

const TRIGGER = { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'POST' } } as any;

const connectorNode = (name: string, operation: string) =>
  ({ id: `con_${name}`, name, type: 'connector', connector: 'svc', operation, params: {} }) as any;

const compose = (name: string, value: unknown, runAfter?: Record<string, string[]>) =>
  ({ id: `act_${name}`, name, type: 'action', kind: 'compose', inputs: { value }, ...(runAfter ? { runAfter } : {}) }) as any;

const entry = (trace: TraceEntry[], name: string) => trace.find((e) => e.name === name)!;

class HttpFailure extends Error {
  constructor(readonly status: number, readonly response: unknown) {
    super(`HTTP ${status}`);
  }
}

describe('connector action outputs (cloud shape)', () => {
  it('adds statusCode 200 next to body, or what successStatusCode() says', async () => {
    const svc: BaseConnector = {
      invoke: async () => ({ id: 1 }),
      successStatusCode: (op) => (op === 'Create' ? 201 : 200),
    };
    const flow: FlowIR = {
      name: 'status-codes',
      nodes: [TRIGGER, connectorNode('Read', 'Get'), connectorNode('Make', 'Create'), compose('Probe', "@outputs('Make')?['statusCode']")],
    };

    const result = await run(flow, { input: {}, connectors: { svc } });

    assert.deepEqual(entry(result.trace, 'Read').outputs, { statusCode: 200, body: { id: 1 } });
    assert.equal(entry(result.trace, 'Make').outputs.statusCode, 201);
    assert.equal(entry(result.trace, 'Probe').outputs, 201);
  });

  // conformance/flows/dv-upsert.ff.ts, dv-files.ff.ts
  it('takes a per-call status code from a ConnectorResponse, and can leave it out (206)', async () => {
    const svc: BaseConnector = {
      invoke: async (op) => {
        if (op === 'Upsert') return { $connectorResponse: true, statusCode: 201, body: { id: 1 } };
        if (op === 'Download') return { $connectorResponse: true, statusCode: 206, body: { $content: 'aGk=' }, omitStatusCode: true };
        return { $connectorResponse: true, statusCode: 204 };
      },
    };
    const flow: FlowIR = {
      name: 'per-call-status',
      nodes: [
        TRIGGER,
        connectorNode('Upsert', 'Upsert'),
        connectorNode('Download', 'Download'),
        connectorNode('Empty', 'Empty'),
        compose('Probe', { upsert: "@outputs('Upsert')?['statusCode']", code: "@actions('Download')?['code']", empty: "@body('Empty')" }),
      ],
    };

    const result = await run(flow, { input: {}, connectors: { svc } });

    assert.deepEqual(entry(result.trace, 'Upsert').outputs, { statusCode: 201, body: { id: 1 } });
    assert.deepEqual(entry(result.trace, 'Download').outputs, { body: { $content: 'aGk=' } });
    assert.deepEqual(entry(result.trace, 'Empty').outputs, { statusCode: 204 });
    assert.deepEqual(entry(result.trace, 'Probe').outputs, { upsert: 201, code: 'PartialContent', empty: null });
  });

  it('gives a failed call outputs with its HTTP status and error body, readable after Failed', async () => {
    const error = { error: { code: '0x80040217', message: 'Does Not Exist' } };
    const svc: BaseConnector = {
      invoke: async () => {
        throw new HttpFailure(404, error);
      },
    };
    const flow: FlowIR = {
      name: 'failure-outputs',
      nodes: [
        TRIGGER,
        connectorNode('Get_row', 'Get'),
        compose(
          'Catch',
          { statusCode: "@outputs('Get_row')?['statusCode']", message: "@body('Get_row')?['error']?['message']" },
          { Get_row: ['Failed'] },
        ),
      ],
    };

    const result = await run(flow, { input: {}, connectors: { svc } });

    assert.equal(entry(result.trace, 'Get_row').status, 'Failed');
    assert.deepEqual(entry(result.trace, 'Get_row').outputs, { statusCode: 404, body: error });
    assert.deepEqual(entry(result.trace, 'Catch').outputs, { statusCode: 404, message: 'Does Not Exist' });
  });

  it('lets a connector rewrite failure outputs with errorOutputs()', async () => {
    const svc: BaseConnector = {
      invoke: async () => {
        throw new HttpFailure(500, { raw: true });
      },
      errorOutputs: () => ({ statusCode: 400, body: { status: 400, message: 'rewritten' } }),
    };
    const flow: FlowIR = { name: 'rewrite', nodes: [TRIGGER, connectorNode('Get', 'Get')] };

    const result = await run(flow, { input: {}, connectors: { svc } });

    assert.deepEqual(entry(result.trace, 'Get').outputs, { statusCode: 400, body: { status: 400, message: 'rewritten' } });
  });

  it('leaves outputs unset when the failure never reached the service', async () => {
    const svc: BaseConnector = {
      invoke: async () => {
        throw new Error('requires recordId');
      },
    };
    const flow: FlowIR = { name: 'local-failure', nodes: [TRIGGER, connectorNode('Get', 'Get')] };

    const result = await run(flow, { input: {}, connectors: { svc } });

    assert.equal(entry(result.trace, 'Get').outputs, undefined);
  });
});

describe('expressions that find nothing evaluate to null', () => {
  it('keeps a Compose key whose expression finds nothing, as null', async () => {
    const svc: BaseConnector = { invoke: async () => ({ Title: 'Alpha' }) };
    const flow: FlowIR = {
      name: 'compose-null',
      nodes: [
        TRIGGER,
        connectorNode('Get', 'Get'),
        compose('Probe', { title: "@body('Get')?['Title']", owner: "@body('Get')?['Owner']?['Email']" }),
      ],
    };

    const result = await run(flow, { input: {}, connectors: { svc } });

    assert.deepEqual(entry(result.trace, 'Probe').outputs, { title: 'Alpha', owner: null });
  });

  it('appends nothing to a string variable for a null value', async () => {
    const flow: FlowIR = {
      name: 'append-null',
      nodes: [
        TRIGGER,
        { id: 'a1', name: 'Init', type: 'action', kind: 'initializevariable', inputs: { variableName: 's', type: 'string', value: 'x' } } as any,
        { id: 'a2', name: 'Append', type: 'action', kind: 'appendtostringvariable', inputs: { name: 's', value: "@triggerBody()?['missing']" } } as any,
        compose('Result', "@variables('s')"),
      ],
    };

    const result = await run(flow, { input: {} });

    assert.equal(entry(result.trace, 'Result').outputs, 'x');
  });
});

describe('pagination policy', () => {
  const pageOf = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ n: from + i }));
  const paged: BaseConnector = {
    invoke: async () => ({ '@odata.context': 'ctx', value: pageOf(1, 100), '@odata.nextLink': 'p2' }),
    nextPage: async (_op, _inputs, link) =>
      link === 'p2' ? { value: pageOf(101, 100), '@odata.nextLink': 'p3' } : { value: pageOf(201, 50) },
  };
  const flowWith = (runtimeConfiguration?: object): FlowIR => ({
    name: 'paging',
    nodes: [TRIGGER, { ...connectorNode('Get', 'GetItems'), ...(runtimeConfiguration ? { runtimeConfiguration } : {}) }],
  });

  it('follows nextLink until the threshold, keeping whole pages, and returns { value } alone', async () => {
    const result = await run(flowWith({ paginationPolicy: { minimumItemCount: 150 } }), { input: {}, connectors: { svc: paged } });
    const body = entry(result.trace, 'Get').outputs.body;
    assert.deepEqual(Object.keys(body), ['value']);
    assert.equal(body.value.length, 200); // the cloud does not cut the second page
  });

  it('stops when the pages run out', async () => {
    const result = await run(flowWith({ paginationPolicy: { minimumItemCount: 5000 } }), { input: {}, connectors: { svc: paged } });
    assert.equal(entry(result.trace, 'Get').outputs.body.value.length, 250);
  });

  it('leaves the first page untouched without a policy', async () => {
    const result = await run(flowWith(), { input: {}, connectors: { svc: paged } });
    const body = entry(result.trace, 'Get').outputs.body;
    assert.equal(body.value.length, 100);
    assert.equal(body['@odata.nextLink'], 'p2');
  });
});

describe('data operations (cloud shapes)', () => {
  const items = [{ title: 'Alpha', status: 'Open' }, { title: 'B, "quoted"', status: null }];
  const flow: FlowIR = {
    name: 'data-ops',
    nodes: [
      TRIGGER,
      compose('Items', items),
      { id: 'a1', name: 'Select_titles', type: 'action', kind: 'select', inputs: { from: "@outputs('Items')", select: { t: "@item()?['title']" } } } as any,
      { id: 'a2', name: 'Filter_open', type: 'action', kind: 'filterarray', inputs: { from: "@outputs('Items')", where: "@equals(item()?['status'], 'Open')" } } as any,
      { id: 'a3', name: 'Join_items', type: 'action', kind: 'join', inputs: { from: "@outputs('Items')", joinWith: '; ' } } as any,
      { id: 'a4', name: 'Csv', type: 'action', kind: 'createcsvtable', inputs: { from: "@outputs('Items')" } } as any,
      { id: 'a5', name: 'Parse', type: 'action', kind: 'parsejson', inputs: { from: '{"a":1}', schema: {} } } as any,
      compose('Probe', {
        selected: "@body('Select_titles')",
        filtered: "@length(body('Filter_open'))",
        parsedA: "@body('Parse')?['a']",
        hasA: "@contains(body('Parse'), 'a')",
        hasB: "@contains(body('Parse'), 'b')",
      }),
    ],
  };

  it('wraps Select/Filter/Join/CSV/Parse JSON results in { body }', async () => {
    const result = await run(flow, { input: {} });
    assert.deepEqual(entry(result.trace, 'Select_titles').outputs, { body: [{ t: 'Alpha' }, { t: 'B, "quoted"' }] });
    assert.deepEqual(entry(result.trace, 'Parse').outputs, { body: { a: 1 } });
    assert.deepEqual(entry(result.trace, 'Probe').outputs, {
      selected: [{ t: 'Alpha' }, { t: 'B, "quoted"' }],
      filtered: 1,
      parsedA: 1,
      hasA: true, // contains() on an object checks for the key
      hasB: false,
    });
  });

  it('joins objects as JSON text', async () => {
    const result = await run(flow, { input: {} });
    assert.equal(
      entry(result.trace, 'Join_items').outputs.body,
      '{"title":"Alpha","status":"Open"}; {"title":"B, \\"quoted\\"","status":null}',
    );
  });

  it('writes CSV with CRLF, quoting only the cells that need it', async () => {
    const result = await run(flow, { input: {} });
    assert.equal(entry(result.trace, 'Csv').outputs.body, 'title,status\r\nAlpha,Open\r\n"B, ""quoted""",\r\n');
  });
});

describe('HTTP-shaped responses (conformance/flows/sp-http.ff.ts)', () => {
  it('body() of a response without content is null, and binary content reads as its text', async () => {
    // The SharePoint HttpRequest result is already { statusCode, headers, body? } and used as the outputs.
    const sharepoint: BaseConnector = {
      invoke: async (_op, inputs) =>
        inputs.uri === 'merge'
          ? { statusCode: 204, headers: {} }
          : { statusCode: 200, headers: {}, body: { '$content-type': 'application/octet-stream', '$content': btoa('Hello notes\n') } },
    };
    const http = (name: string, uri: string) =>
      ({ id: `con_${name}`, name, type: 'connector', connector: 'sharepoint', operation: 'HttpRequest', params: { uri } }) as any;
    const flow: FlowIR = {
      name: 'http-shapes',
      nodes: [
        TRIGGER,
        http('Update', 'merge'),
        http('File', 'file'),
        compose('Probe', {
          updateBody: "@body('Update')",
          fileText: "@string(body('File'))",
          fileInterpolated: "[@{body('File')}]",
        }),
      ],
    };

    const result = await run(flow, { input: {}, connectors: { sharepoint } });

    assert.deepEqual(entry(result.trace, 'Probe').outputs, {
      updateBody: null,
      fileText: 'Hello notes\n',
      fileInterpolated: '[Hello notes\n]',
    });
  });
});
