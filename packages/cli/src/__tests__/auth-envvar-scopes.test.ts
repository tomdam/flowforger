import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequiredScopes, type AuthConfig } from '../auth.js';
import type { FlowIR } from '@flowforger/ir';

/**
 * A flow can use env vars without using any Dataverse connector (e.g. a
 * SharePoint flow whose site URL is an env var). Resolving those values needs
 * a Dataverse token, so `--auth` must request Dataverse scopes for it.
 */
const envVarOnlyFlow = {
  name: 'Test',
  parameters: {
    'Site URL (cr123_siteUrl)': {
      type: 'String',
      defaultValue: 'https://x',
      metadata: { schemaName: 'cr123_siteUrl' },
    },
  },
  nodes: [{ id: 'trg_1', name: 'manual', type: 'trigger', kind: 'http' }],
} as unknown as FlowIR;

describe('resolveRequiredScopes with env-var-backed parameters', () => {
  it('requests Dataverse scopes when the flow has env var parameters and a configured resource', async () => {
    const authConfig: AuthConfig = {
      clientId: 'c',
      tenantId: 't',
      resources: { dataverse: 'https://org.crm.dynamics.com' },
    };
    const scopes = await resolveRequiredScopes(envVarOnlyFlow, authConfig);
    const dataverse = scopes.get('https://org.crm.dynamics.com');
    assert.ok(dataverse && dataverse.length > 0, 'expected Dataverse scopes to be requested');
  });

  it('skips silently when no Dataverse resource is configured', async () => {
    const authConfig: AuthConfig = { clientId: 'c', tenantId: 't' };
    const scopes = await resolveRequiredScopes(envVarOnlyFlow, authConfig);
    assert.equal([...scopes.keys()].some((k) => k.includes('crm')), false);
  });

  it('requests no Dataverse scopes for a flow without env var parameters', async () => {
    const authConfig: AuthConfig = {
      clientId: 'c',
      tenantId: 't',
      resources: { dataverse: 'https://org.crm.dynamics.com' },
    };
    const flow = { name: 'x', nodes: [{ id: 'trg_1', name: 'manual', type: 'trigger', kind: 'http' }] } as unknown as FlowIR;
    const scopes = await resolveRequiredScopes(flow, authConfig);
    assert.equal(scopes.has('https://org.crm.dynamics.com'), false);
  });
});
