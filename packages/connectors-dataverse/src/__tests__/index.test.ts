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
