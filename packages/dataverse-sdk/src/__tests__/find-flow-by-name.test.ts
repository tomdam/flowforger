import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DataverseClient } from '../index.js';

interface CapturedCall {
  url: string;
  init: RequestInit;
}

const realFetch = globalThis.fetch;
let calls: CapturedCall[] = [];

/** Install a fetch stub that returns the given Response for every call. */
function stubFetch(makeResponse: () => Response) {
  calls = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init: init ?? {} });
    return makeResponse();
  }) as typeof fetch;
}

function listResponse(values: any[]): Response {
  return new Response(JSON.stringify({ value: values }), { status: 200 });
}

function makeClient() {
  return new DataverseClient({ baseUrl: 'https://org.crm.dynamics.com', token: 'tok' });
}

describe('DataverseClient.findFlowByName / getFlowByName', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('URL-encodes a name containing "&" and "+" so the query is not corrupted', async () => {
    stubFetch(() => listResponse([{ workflowid: 'a' }]));

    await makeClient().findFlowByName('Sales & Marketing / A+B Report');

    const url = calls[0].url;
    assert.ok(!url.includes('Sales & Marketing'), 'raw "&" must not appear unescaped in the query string');
    assert.ok(!url.includes('A+B Report'), 'raw "+" must not appear unescaped (it would decode to a space)');
    assert.ok(url.includes(encodeURIComponent('Sales & Marketing / A+B Report')));
  });

  it('escapes an embedded single quote before encoding', async () => {
    stubFetch(() => listResponse([]));

    await makeClient().findFlowByName("O'Brien's Flow");

    const url = calls[0].url;
    // '' is the OData escape for a literal quote; it must survive encoding untouched
    // (encodeURIComponent does not escape the ' character) and the raw name must not appear.
    assert.ok(url.includes("O''Brien''s Flow") || url.includes(encodeURIComponent("O''Brien''s Flow")));
  });

  it('requests $top=2 so a duplicate name can be detected', async () => {
    stubFetch(() => listResponse([{ workflowid: 'a' }]));
    await makeClient().findFlowByName('My Flow');
    assert.ok(calls[0].url.includes('$top=2'));
  });

  it('reports ambiguous:true and returns the first match when two flows share a name', async () => {
    stubFetch(() => listResponse([{ workflowid: 'a' }, { workflowid: 'b' }]));

    const { match, ambiguous } = await makeClient().findFlowByName('My Flow');

    assert.equal(ambiguous, true);
    assert.equal(match?.workflowid, 'a');
  });

  it('reports ambiguous:false with a single match', async () => {
    stubFetch(() => listResponse([{ workflowid: 'a' }]));

    const { match, ambiguous } = await makeClient().findFlowByName('My Flow');

    assert.equal(ambiguous, false);
    assert.equal(match?.workflowid, 'a');
  });

  it('reports match:null and ambiguous:false when nothing matches', async () => {
    stubFetch(() => listResponse([]));

    const { match, ambiguous } = await makeClient().findFlowByName('Nonexistent');

    assert.equal(match, null);
    assert.equal(ambiguous, false);
  });

  it('getFlowByName still returns a single flow object (used by pull)', async () => {
    stubFetch(() => listResponse([{ workflowid: 'a', name: 'My Flow' }]));

    const flow = await makeClient().getFlowByName('My Flow');

    assert.equal(flow?.workflowid, 'a');
  });

  it('getFlowByName returns null on a miss', async () => {
    stubFetch(() => listResponse([]));

    const flow = await makeClient().getFlowByName('Nonexistent');

    assert.equal(flow, null);
  });
});

describe('DataverseClient.getSolutionByUniqueName', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('URL-encodes the unique name filter value', async () => {
    stubFetch(() => new Response(JSON.stringify({ value: [{ solutionid: 's1' }] }), { status: 200 }));

    await makeClient().getSolutionByUniqueName('My & Solution');

    const url = calls[0].url;
    assert.ok(!url.includes('My & Solution'));
    assert.ok(url.includes(encodeURIComponent('My & Solution')));
  });
});
