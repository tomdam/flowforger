import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunParameterOverrides } from '../env-var-overrides.js';

const flow = {
  name: 'Test',
  parameters: {
    'Site URL (cr123_siteUrl)': {
      type: 'String',
      defaultValue: 'https://design-time-default',
      metadata: { schemaName: 'cr123_siteUrl' },
    },
    'Max Items (cr123_maxItems)': {
      type: 'String',
      defaultValue: '10',
      metadata: { schemaName: 'cr123_maxItems' },
    },
  },
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub Dataverse: definitions + values endpoints; counts calls. */
function stubDataverse(defs: unknown[], values: unknown[]): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    calls.push(u);
    const body = u.includes('environmentvariabledefinitions') ? { value: defs } : { value: values };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls };
}

const DEFS = [
  {
    environmentvariabledefinitionid: 'def-1',
    schemaname: 'cr123_siteUrl',
    displayname: 'Site URL',
    type: 100000000,
    defaultvalue: 'https://definition-default',
  },
  {
    environmentvariabledefinitionid: 'def-2',
    schemaname: 'cr123_maxItems',
    displayname: 'Max Items',
    type: 100000001,
    defaultvalue: '5',
  },
];
const VALUES = [
  {
    environmentvariablevalueid: 'v1',
    schemaname: 'cr123_siteUrl',
    value: 'https://actual',
    _environmentvariabledefinitionid_value: 'def-1',
  },
];

describe('resolveRunParameterOverrides', () => {
  it('returns the explicit overrides unchanged when no Dataverse connection is available', async () => {
    const explicit = { 'Site URL (cr123_siteUrl)': 'from-param' };
    const result = await resolveRunParameterOverrides({ ir: flow, explicitOverrides: explicit });
    assert.deepEqual(result, explicit);
  });

  it('resolves env vars from Dataverse and merges them under explicit --param overrides', async () => {
    stubDataverse(DEFS, VALUES);
    const result = await resolveRunParameterOverrides({
      ir: flow,
      dvUrl: 'https://org.crm.dynamics.com',
      dvToken: 'tok',
      explicitOverrides: { 'Max Items (cr123_maxItems)': 99 },
    });
    assert.deepEqual(result, {
      'Site URL (cr123_siteUrl)': 'https://actual', // env var value record
      'Max Items (cr123_maxItems)': 99, // explicit --param wins over env var's 5
    });
  });

  it('does not call Dataverse when the flow has no env-var-backed parameters', async () => {
    const { calls } = stubDataverse(DEFS, VALUES);
    const result = await resolveRunParameterOverrides({
      ir: { name: 'x', parameters: { p: { type: 'String' } } },
      dvUrl: 'https://org.crm.dynamics.com',
      dvToken: 'tok',
    });
    assert.equal(result, undefined);
    assert.equal(calls.length, 0);
  });

  it('logs and falls back to explicit overrides when the fetch fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const logs: string[] = [];
    const explicit = { 'Max Items (cr123_maxItems)': 99 };
    const result = await resolveRunParameterOverrides({
      ir: flow,
      dvUrl: 'https://org.crm.dynamics.com',
      dvToken: 'tok',
      explicitOverrides: explicit,
      log: (m) => logs.push(m),
    });
    assert.deepEqual(result, explicit);
    assert.ok(logs.some((l) => l.includes('network down')));
  });

  it('logs each resolved variable and warns about unresolved ones', async () => {
    stubDataverse([DEFS[0]], VALUES); // only siteUrl definition exists
    const logs: string[] = [];
    await resolveRunParameterOverrides({
      ir: flow,
      dvUrl: 'https://org.crm.dynamics.com',
      dvToken: 'tok',
      log: (m) => logs.push(m),
    });
    assert.ok(logs.some((l) => l.includes('cr123_siteUrl')));
    assert.ok(logs.some((l) => l.includes('cr123_maxItems')));
  });
});
