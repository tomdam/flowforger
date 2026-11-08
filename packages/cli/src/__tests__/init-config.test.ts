import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateConfig } from '../init.js';

describe('init generateConfig', () => {
  const file = generateConfig({
    clientId: 'client',
    tenantId: 'tenant',
    dataverseUrl: 'https://org.crm.dynamics.com',
    sharepointUrl: 'https://contoso.sharepoint.com',
    connectionRefs: new Map([['excelonlinebusiness', { logicalName: 'cr_excel', displayName: 'Excel' }]]),
  });
  const connections = file.global.connections as Record<string, any>;

  it('keys the Office file connectors by the connector names pull writes into IR', () => {
    assert.equal(connections.excelonlinebusiness?.referenceName, 'shared_excelonlinebusiness');
    assert.equal(connections.wordonlinebusiness?.referenceName, 'shared_wordonlinebusiness');
    assert.equal(connections.onedriveforbusiness?.referenceName, 'shared_onedriveforbusiness');
    assert.equal('excelonline' in connections, false);
    assert.equal('wordonline' in connections, false);
  });

  it('binds a discovered connection reference under the same key', () => {
    assert.equal(connections.excelonlinebusiness.connectionReferenceLogicalName, 'cr_excel');
  });

  it('writes only emitter keys the emitter reads', () => {
    assert.deepEqual(file.global.emitter, { includeMetadata: false });
  });
});
