import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequiredScopes, connectorsForExplicitTokens, type AuthConfig } from '../auth.js';
import type { FlowIR } from '@flowforger/ir';

const flow = {
  name: 'Test',
  nodes: [
    { id: 'trg_1', name: 'manual', type: 'trigger', kind: 'http' },
    { id: 'con_1', name: 'Sp', type: 'connector', connector: 'sharepoint', operation: 'GetItems', parameters: {} },
    { id: 'con_2', name: 'Dv', type: 'connector', connector: 'dataverse', operation: 'ListRecords', parameters: {} },
  ],
} as unknown as FlowIR;
const authConfig: AuthConfig = {
  clientId: 'c',
  tenantId: 't',
  resources: { dataverse: 'https://org.crm.dynamics.com' },
};

describe('resolveRequiredScopes skipConnectors', () => {
  it('rejects a missing sharepoint resource without skipConnectors', async () => {
    await assert.rejects(resolveRequiredScopes(flow, authConfig), /auth.resources.sharepoint is not configured/);
  });
  it('skips a connector whose token was passed explicitly', async () => {
    const scopes = await resolveRequiredScopes(flow, authConfig, { skipConnectors: new Set(['sharepoint']) });
    assert.ok(scopes.has('https://org.crm.dynamics.com'));
    assert.equal([...scopes.keys()].some((k) => k.includes('sharepoint')), false);
  });
});

describe('connectorsForExplicitTokens', () => {
  it('sp token', () => {
    assert.deepEqual(connectorsForExplicitTokens({ spToken: true }), new Set(['sharepoint']));
  });
  it('graph token', () => {
    const s = connectorsForExplicitTokens({ graphToken: true });
    assert.ok(s.has('office365') && s.has('teams') && !s.has('sharepoint'));
  });
  it('word token', () => {
    assert.deepEqual(connectorsForExplicitTokens({ wordToken: true }), new Set(['wordonline', 'wordonlinebusiness']));
  });
});
