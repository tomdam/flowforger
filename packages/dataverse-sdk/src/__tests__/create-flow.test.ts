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

function createdResponse(entityId: string): Response {
  return new Response(null, {
    status: 204,
    headers: { 'OData-EntityId': entityId },
  });
}

const NEW_ID = '11111111-2222-3333-4444-555555555555';
const ENTITY_ID = `https://org.crm.dynamics.com/api/data/v9.2/workflows(${NEW_ID})`;

function makeClient() {
  return new DataverseClient({ baseUrl: 'https://org.crm.dynamics.com', token: 'tok' });
}

describe('DataverseClient.createFlow', () => {
  beforeEach(() => stubFetch(() => createdResponse(ENTITY_ID)));
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('POSTs to /workflows and returns the new workflow id', async () => {
    const result = await makeClient().createFlow({ name: 'My Flow', clientdata: '{"x":1}' });

    assert.equal(result.workflowid, NEW_ID);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://org.crm.dynamics.com/api/data/v9.2/workflows');
    assert.equal(calls[0].init.method, 'POST');
  });

  it('sends the fields the platform requires for a modern cloud flow', async () => {
    await makeClient().createFlow({ name: 'My Flow', clientdata: '{"x":1}' });

    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.name, 'My Flow');
    assert.equal(body.clientdata, '{"x":1}');
    assert.equal(body.category, 5);
    assert.equal(body.type, 1);
    assert.equal(body.primaryentity, 'none');
    assert.equal(body.statecode, 0, 'new flows must be created as Draft');
  });

  it('omits description when not supplied and includes it when supplied', async () => {
    await makeClient().createFlow({ name: 'A', clientdata: '{}' });
    assert.ok(!('description' in JSON.parse(String(calls[0].init.body))));

    await makeClient().createFlow({ name: 'A', clientdata: '{}', description: 'hello' });
    assert.equal(JSON.parse(String(calls[1].init.body)).description, 'hello');
  });

  it('sends the solution header only when a solution is given', async () => {
    await makeClient().createFlow({ name: 'A', clientdata: '{}' });
    assert.ok(!('MSCRM.SolutionUniqueName' in (calls[0].init.headers as any)));

    await makeClient().createFlow({ name: 'A', clientdata: '{}' }, { solutionUniqueName: 'MySolution' });
    assert.equal((calls[1].init.headers as any)['MSCRM.SolutionUniqueName'], 'MySolution');
  });

  it('throws the standard Dataverse error when the POST fails', async () => {
    stubFetch(() => new Response('solution not found', { status: 400 }));

    await assert.rejects(
      () => makeClient().createFlow({ name: 'A', clientdata: '{}' }),
      /Dataverse 400: solution not found/,
    );
  });

  it('throws when the response carries no usable OData-EntityId', async () => {
    stubFetch(() => new Response(null, { status: 204 }));

    await assert.rejects(
      () => makeClient().createFlow({ name: 'A', clientdata: '{}' }),
      /returned no workflow id/,
    );
  });
});
