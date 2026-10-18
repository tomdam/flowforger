import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunParameterOverrides, isSecretEnvVar } from '../env-var-overrides.js';

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

describe('secret redaction in the env var log', () => {
  const secretFlow = {
    name: 'Secrets',
    parameters: {
      'Function Key (cr123_DocxCleanupFunctionKey)': { type: 'String', metadata: { schemaName: 'cr123_DocxCleanupFunctionKey' } },
      'Vault Ref (cr123_vaultRef)': { type: 'String', metadata: { schemaName: 'cr123_vaultRef' } },
      'Site URL (cr123_siteUrl)': { type: 'String', metadata: { schemaName: 'cr123_siteUrl' } },
    },
  };
  const secretDefs = [
    { environmentvariabledefinitionid: 'd-key', schemaname: 'cr123_DocxCleanupFunctionKey', displayname: 'Function Key', type: 100000000, defaultvalue: 'abc123-FUNCTION-KEY' },
    { environmentvariabledefinitionid: 'd-vault', schemaname: 'cr123_vaultRef', displayname: 'Vault Ref', type: 100000005, defaultvalue: '/subscriptions/x/vaults/y/secrets/z' },
    { environmentvariabledefinitionid: 'd-site', schemaname: 'cr123_siteUrl', displayname: 'Site URL', type: 100000000, defaultvalue: 'https://contoso.sharepoint.com' },
  ];

  it('redacts values whose name or type marks them as secrets, but still returns them as overrides', async () => {
    stubDataverse(secretDefs, []);
    const logs: string[] = [];
    const result = await resolveRunParameterOverrides({
      ir: secretFlow,
      dvUrl: 'https://org.crm.dynamics.com',
      dvToken: 'tok',
      log: (m) => logs.push(m),
    });
    const joined = logs.join('\n');
    assert.doesNotMatch(joined, /abc123-FUNCTION-KEY/);
    assert.doesNotMatch(joined, /vaults\/y/);
    assert.match(joined, /cr123_DocxCleanupFunctionKey' = \[redacted\]/);
    assert.match(joined, /cr123_vaultRef' = \[redacted\]/);
    assert.match(joined, /cr123_siteUrl' = https:\/\/contoso\.sharepoint\.com/);
    assert.equal(result?.['Function Key (cr123_DocxCleanupFunctionKey)'], 'abc123-FUNCTION-KEY');
  });

  it('prints secrets when showSecrets is set (--verbose)', async () => {
    stubDataverse(secretDefs, []);
    const logs: string[] = [];
    await resolveRunParameterOverrides({
      ir: secretFlow,
      dvUrl: 'https://org.crm.dynamics.com',
      dvToken: 'tok',
      log: (m) => logs.push(m),
      showSecrets: true,
    });
    assert.match(logs.join('\n'), /abc123-FUNCTION-KEY/);
  });

  it('isSecretEnvVar matches by type and by name only', () => {
    assert.equal(isSecretEnvVar({ schemaName: 'cr_siteUrl', type: 100000000 }), false);
    assert.equal(isSecretEnvVar({ schemaName: 'cr_siteUrl', type: 100000005 }), true);
    assert.equal(isSecretEnvVar({ schemaName: 'cr_ApiToken', type: 100000000 }), true);
    assert.equal(isSecretEnvVar({ schemaName: 'cr_x', displayName: 'Client Secret', type: 100000000 }), true);
  });
});
