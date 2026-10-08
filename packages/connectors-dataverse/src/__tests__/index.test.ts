import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DataverseConnector } from '../index.js';
import type { RunContext } from '@flowforger/engine';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeCtx(): RunContext {
  return {
    variables: {},
    actions: new Map(),
    now: () => new Date(),
    sleep: async () => {},
    log: () => {},
    secrets: () => undefined,
    connector: () => {
      throw new Error('not needed');
    },
  } as unknown as RunContext;
}

const BASE_URL = 'https://org.crm.dynamics.com';
const RECORD_ID = '11111111-2222-3333-4444-555555555555';

let fetchCalls: Array<{ url: string; method: string }> = [];

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['content-type', 'application/json']]),
    text: async () => JSON.stringify(body),
  };
}

/** The decoded query string of the last fetch — URLSearchParams percent-encodes `$`. */
function lastQuery(): string {
  const url = fetchCalls[fetchCalls.length - 1]?.url ?? '';
  const q = url.split('?')[1] ?? '';
  return decodeURIComponent(q.replace(/\+/g, ' '));
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('DataverseConnector OData query options', () => {
  let connector: DataverseConnector;
  let ctx: RunContext;

  beforeEach(() => {
    fetchCalls = [];
    (globalThis as any).fetch = async (url: string, opts: any) => {
      fetchCalls.push({ url, method: opts?.method || 'GET' });
      return jsonResponse({ value: [] });
    };
    connector = new DataverseConnector({ baseUrl: BASE_URL, token: 'test-token' });
    ctx = makeCtx();
  });

  it('ListRecords forwards $expand', async () => {
    await connector.invoke(
      'ListRecords',
      { entityName: 'accounts', $expand: 'primarycontactid($select=fullname,emailaddress1)' },
      ctx
    );

    assert.match(lastQuery(), /\$expand=primarycontactid\(\$select=fullname,emailaddress1\)/);
  });

  it('ListRecords forwards $orderby', async () => {
    await connector.invoke('ListRecords', { entityName: 'accounts', $orderby: 'name asc' }, ctx);

    assert.match(lastQuery(), /\$orderby=name asc/);
  });

  it('ListRecords forwards $skiptoken, $count and fetchXml', async () => {
    await connector.invoke(
      'ListRecords',
      { entityName: 'accounts', $skiptoken: 'tok123', $count: true, fetchXml: '<fetch/>' },
      ctx
    );

    const query = lastQuery();
    assert.match(query, /\$skiptoken=tok123/);
    assert.match(query, /\$count=true/);
    assert.match(query, /fetchXml=<fetch\/>/);
  });

  it('ListRecords still forwards $select, $filter and $top', async () => {
    await connector.invoke(
      'ListRecords',
      { entityName: 'accounts', $select: 'name', $filter: 'statecode eq 0', $top: 5 },
      ctx
    );

    const query = lastQuery();
    assert.match(query, /\$select=name/);
    assert.match(query, /\$filter=statecode eq 0/);
    assert.match(query, /\$top=5/);
  });

  it('ListRecords sends no query options when none are provided', async () => {
    await connector.invoke('ListRecords', { entityName: 'accounts' }, ctx);

    assert.equal(fetchCalls[0].url, `${BASE_URL}/api/data/v9.2/accounts`);
  });

  it('ListRecords accepts unprefixed aliases (expand, orderby)', async () => {
    await connector.invoke(
      'ListRecords',
      { entityName: 'accounts', expand: 'primarycontactid', orderby: 'name desc' },
      ctx
    );

    const query = lastQuery();
    assert.match(query, /\$expand=primarycontactid/);
    assert.match(query, /\$orderby=name desc/);
  });

  it('sends a null or empty OData option as an empty value, as the cloud connector does', async () => {
    // Dataverse answers these with a 400 ("The value for OData query '$filter' cannot be empty.").
    await connector.invoke('ListRecords', { entityName: 'accounts', $select: 'name', $filter: null, $top: '' }, ctx);
    const query = lastQuery();
    assert.match(query, /(^|&)\$filter=(&|$)/);
    assert.match(query, /(^|&)\$top=(&|$)/);
    assert.match(query, /\$select=name/);

    await connector.invoke('GetItem', { entityName: 'accounts', recordId: RECORD_ID, $select: null }, ctx);
    assert.match(lastQuery(), /^\$select=$/);
  });

  it('GetItem forwards $expand alongside $select', async () => {
    await connector.invoke(
      'GetItem',
      { entityName: 'accounts', recordId: RECORD_ID, $select: 'name', $expand: 'primarycontactid' },
      ctx
    );

    const query = lastQuery();
    assert.match(query, /\$select=name/);
    assert.match(query, /\$expand=primarycontactid/);
  });
});

// Shapes verified against real cloud runs (conformance/flows/dv-read, dv-write).
describe('DataverseConnector cloud parity', () => {
  let connector: DataverseConnector;
  let ctx: RunContext;
  let requests: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }>;
  let respond: (url: string, method: string) => { body: unknown; status?: number };

  beforeEach(() => {
    requests = [];
    respond = () => ({ body: {} });
    (globalThis as any).fetch = async (url: string, opts: any) => {
      const method = opts?.method || 'GET';
      requests.push({ url, method, headers: opts?.headers ?? {}, body: opts?.body });
      const r = respond(url, method);
      if (r.status === 204) return { ok: true, status: 204, headers: new Map(), text: async () => '' };
      return jsonResponse(r.body, r.status);
    };
    connector = new DataverseConnector({ baseUrl: BASE_URL, token: 'test-token' });
    ctx = makeCtx();
  });

  // conformance/flows/dv-read.ff.ts, dv-expand.ff.ts
  it('leaves null columns out of listed and retrieved rows, but not out of expanded rows', async () => {
    respond = () => ({
      body: {
        value: [
          {
            name: 'A',
            fft_status: null,
            fft_Account: { name: 'C', telephone1: null },
            fft_items: [{ fft_name: 'E-3', fft_status: null }],
            'fft_items@odata.nextLink': `${BASE_URL}/api/data/v9.2/accounts(${RECORD_ID})/fft_items?$select=fft_name`,
          },
          { name: 'B', fft_Account: null },
        ],
      },
    });
    const list: any = await connector.invoke('ListRecords', { entityName: 'accounts' }, ctx);
    assert.deepEqual(list.value, [
      {
        name: 'A',
        fft_Account: { name: 'C', telephone1: null },
        fft_items: [{ fft_name: 'E-3', fft_status: null }],
        // the cloud connector calls v9.1, and its links say so
        'fft_items@odata.nextLink': `${BASE_URL}/api/data/v9.1/accounts(${RECORD_ID})/fft_items?$select=fft_name`,
      },
      { name: 'B' },
    ]);

    respond = () => ({ body: { name: 'A', description: null } });
    const row: any = await connector.invoke('GetItem', { entityName: 'accounts', recordId: RECORD_ID }, ctx);
    assert.deepEqual(row, { name: 'A' });
  });

  it('asks for annotations but not full metadata (no @odata.id/editLink/type)', async () => {
    respond = () => ({ body: { value: [] } });
    await connector.invoke('ListRecords', { entityName: 'accounts' }, ctx);
    const headers = requests[0].headers;
    assert.equal(headers.Prefer, 'odata.include-annotations="*"');
    assert.ok(!String(headers.Accept ?? '').includes('metadata=full'));
  });

  it('answers CreateRecord, UpdateRecord and UpdateOnlyRecord with the annotated row', async () => {
    respond = () => ({ body: { accountid: RECORD_ID, name: 'A', fax: null } });
    const created: any = await connector.invoke('CreateRecord', { entityName: 'accounts', 'item/name': 'A' }, ctx);
    const upserted: any = await connector.invoke('UpdateRecord', { entityName: 'accounts', recordId: RECORD_ID, 'item/name': 'A' }, ctx);
    const updated: any = await connector.invoke('UpdateOnlyRecord', { entityName: 'accounts', recordId: RECORD_ID, 'item/name': 'A' }, ctx);
    assert.deepEqual(created, { accountid: RECORD_ID, name: 'A' });
    assert.deepEqual(upserted, { $connectorResponse: true, statusCode: 200, body: { accountid: RECORD_ID, name: 'A' } });
    assert.deepEqual(updated, { accountid: RECORD_ID, name: 'A' });
    for (const r of requests) {
      assert.equal(r.headers.Prefer, 'return=representation,odata.include-annotations="*"', `${r.method} ${r.url}`);
    }
  });

  // conformance/flows/dv-upsert.ff.ts
  it('upserts with UpdateRecord (no If-Match) and updates only with UpdateOnlyRecord (If-Match: *)', async () => {
    respond = () => ({ body: { accountid: RECORD_ID, name: 'A', fax: null }, status: 201 });
    const created: any = await connector.invoke('UpdateRecord', { entityName: 'accounts', recordId: RECORD_ID, 'item/name': 'A' }, ctx);
    // A created row keeps its null columns (measured); 201 is reported per call.
    assert.deepEqual(created, { $connectorResponse: true, statusCode: 201, body: { accountid: RECORD_ID, name: 'A', fax: null } });
    assert.equal(requests[0].headers['If-Match'], undefined);

    await connector.invoke('UpdateOnlyRecord', { entityName: 'accounts', recordId: RECORD_ID, 'item/name': 'A' }, ctx);
    assert.equal(requests[1].headers['If-Match'], '*');
  });

  // conformance/flows/dv-relate.ff.ts
  it('relates and unrelates with the cloud parameters, rebasing v9.1 row URLs', async () => {
    respond = () => ({ body: null, status: 204 });
    const related = await connector.invoke('AssociateEntities', {
      entityName: 'fft_items',
      recordId: RECORD_ID,
      associationEntityRelationship: 'fft_item_account',
      'item/@odata.id': `${BASE_URL}/api/data/v9.1/accounts(${RECORD_ID})`,
    }, ctx);
    assert.equal(related, undefined);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, `${BASE_URL}/api/data/v9.2/fft_items(${RECORD_ID})/fft_item_account/$ref`);
    assert.deepEqual(JSON.parse(String(requests[0].body)), { '@odata.id': `${BASE_URL}/api/data/v9.2/accounts(${RECORD_ID})` });

    await connector.invoke('DisassociateEntities', {
      entityName: 'fft_items',
      recordId: RECORD_ID,
      associationEntityRelationship: 'fft_item_account',
      $id: `${BASE_URL}/api/data/v9.1/accounts(${RECORD_ID})`,
    }, ctx);
    assert.equal(requests[1].method, 'DELETE');
    assert.equal(
      requests[1].url,
      `${BASE_URL}/api/data/v9.2/fft_items(${RECORD_ID})/fft_item_account/$ref?$id=${encodeURIComponent(`${BASE_URL}/api/data/v9.2/accounts(${RECORD_ID})`)}`,
    );
    assert.equal(connector.successStatusCode('AssociateEntities'), 204);
    assert.equal(connector.successStatusCode('DisassociateEntities'), 204);
  });

  // conformance/flows/dv-actions.ff.ts
  it('calls actions by the name as given, with no body when there are no parameters', async () => {
    respond = () => ({ body: { '@odata.context': 'ctx', Echo: null } });
    const echo = await connector.invoke('PerformUnboundAction', { actionName: 'fft_Echo', 'item/Text': 'hi' }, ctx);
    assert.deepEqual(echo, { $connectorResponse: true, statusCode: 200, body: { '@odata.context': 'ctx' } });
    assert.equal(requests[0].url, `${BASE_URL}/api/data/v9.2/fft_Echo`);
    assert.deepEqual(JSON.parse(String(requests[0].body)), { Text: 'hi' });

    respond = () => ({ body: null, status: 204 });
    const ping = await connector.invoke('PerformBoundAction', {
      entityName: 'fft_items',
      recordId: RECORD_ID,
      actionName: 'Microsoft.Dynamics.CRM.fft_Ping',
    }, ctx);
    assert.deepEqual(ping, { $connectorResponse: true, statusCode: 204 });
    assert.equal(requests[1].url, `${BASE_URL}/api/data/v9.2/fft_items(${RECORD_ID})/Microsoft.Dynamics.CRM.fft_Ping`);
    assert.equal(requests[1].body, undefined);
  });

  // conformance/flows/dv-files.ff.ts
  it('downloads a file with the cloud Range header, 206 recorded without a status code', async () => {
    (globalThis as any).fetch = async (url: string, opts: any) => {
      requests.push({ url, method: opts?.method || 'GET', headers: opts?.headers ?? {} });
      return { ok: true, status: 206, headers: new Map(), arrayBuffer: async () => new TextEncoder().encode('hi').buffer };
    };
    const file = await connector.invoke('GetEntityFileImageFieldContent', {
      entityName: 'fft_items',
      recordId: RECORD_ID,
      fileImageFieldName: 'fft_document',
    }, ctx);
    assert.deepEqual(file, {
      $connectorResponse: true,
      statusCode: 206,
      body: { '$content-type': 'application/octet-stream', '$content': 'aGk=' },
      omitStatusCode: true,
    });
    assert.equal(requests[0].headers.Range, 'bytes=0-4194303');
  });

  it('uploads text as its UTF-8 bytes and binary content decoded', async () => {
    const bodies: Uint8Array[] = [];
    (globalThis as any).fetch = async (url: string, opts: any) => {
      requests.push({ url, method: opts?.method, headers: opts?.headers ?? {} });
      bodies.push(new Uint8Array(opts.body));
      return { ok: true, status: 204, headers: new Map(), text: async () => '' };
    };
    const base = { entityName: 'fft_items', recordId: RECORD_ID, fileImageFieldName: 'fft_document' };
    await connector.invoke('UpdateEntityFileImageFieldContent', { ...base, item: 'hi', 'x-ms-file-name': 'a.txt' }, ctx);
    await connector.invoke('UpdateEntityFileImageFieldContent', { ...base, item: { '$content-type': 'image/png', '$content': 'aGk=' } }, ctx);
    assert.deepEqual([...bodies[0]], [104, 105]);
    assert.deepEqual([...bodies[1]], [104, 105]);
    assert.equal(requests[0].headers['x-ms-file-name'], 'a.txt');
    assert.equal(requests[1].headers['x-ms-file-name'], 'Untitled');
    assert.equal(connector.successStatusCode('UpdateEntityFileImageFieldContent'), 204);
  });

  it('returns no body from DeleteRecord', async () => {
    respond = () => ({ body: null, status: 204 });
    const result = await connector.invoke('DeleteRecord', { entityName: 'accounts', recordId: RECORD_ID }, ctx);
    assert.equal(result, undefined);
  });

  it('reports the cloud status codes: 201 create, 204 delete, 200 otherwise', () => {
    assert.equal(connector.successStatusCode('CreateRecord'), 201);
    assert.equal(connector.successStatusCode('DeleteRecord'), 204);
    assert.equal(connector.successStatusCode('UpdateRecord'), 200);
    assert.equal(connector.successStatusCode('ListRecords'), 200);
  });
});
