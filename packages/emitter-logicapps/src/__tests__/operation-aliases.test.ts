import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emitLogicAppsJson, type EmitterConfig } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const API_PREFIX = '/providers/Microsoft.PowerApps/apis/';

/** Emit a one-action flow and return the whole clientdata object. */
function emitFlow(connector: string, operation: string, params: Record<string, unknown> = {}, config?: EmitterConfig) {
  const flow: FlowIR = {
    name: 'TestFlow',
    nodes: [
      { id: 'trg_1', type: 'trigger', kind: 'manual', name: 'manual', inputs: {} },
      { id: 'con_1', type: 'connector', name: 'TheAction', connector, operation, params },
    ],
  } as unknown as FlowIR;
  return emitLogicAppsJson(flow, config) as any;
}

/** Emit a one-action flow and return that action's `inputs` block. */
function emitAction(connector: string, operation: string, params: Record<string, unknown> = {}, config?: EmitterConfig) {
  return emitFlow(connector, operation, params, config).properties.definition.actions.TheAction.inputs;
}

function assertMapping(connector: string, cases: Array<[alias: string, cloudId: string]>) {
  for (const [alias, cloudId] of cases) {
    it(`emits ${connector} ${alias} as ${cloudId}`, () => {
      assert.equal(emitAction(connector, alias).host.operationId, cloudId);
    });
  }
}

function assertIdentity(connector: string, cloudIds: string[]) {
  for (const id of cloudIds) {
    it(`leaves ${connector} ${id} untouched (round-trip of a pulled flow)`, () => {
      assert.equal(emitAction(connector, id).host.operationId, id);
    });
  }
}

/* ------------------------------------------------------------------ */
/*  operationId mapping per connector                                  */
/* ------------------------------------------------------------------ */

describe('Dataverse operationId emission', () => {
  assertMapping('dataverse', [
    ['ListRows', 'ListRecords'],
    ['listRows', 'ListRecords'],
    ['CreateRow', 'CreateRecord'],
    ['UpdateRow', 'UpdateOnlyRecord'],
    ['UpsertRow', 'UpdateRecord'],
    ['UpsertRecord', 'UpdateRecord'],
    ['DeleteRow', 'DeleteRecord'],
    ['RetrieveRow', 'GetItem'],
    ['RetrieveRecord', 'GetItem'],
    ['GetRecord', 'GetItem'],
    ['GetRow', 'GetItem'],
    ['GetItemById', 'GetItem'],
    ['AssociateRecords', 'AssociateEntities'],
    ['DisassociateRecords', 'DisassociateEntities'],
    ['GetFileContent', 'GetEntityFileImageFieldContent'],
    ['UploadFileContent', 'UpdateEntityFileImageFieldContent'],
    ['ExecuteBatch', 'ExecuteChangeset'],
    ['RelevanceSearch', 'GetRelevantRows'],
  ]);
  assertIdentity('dataverse', [
    'ListRecords', 'GetItem', 'CreateRecord', 'UpdateRecord', 'UpdateOnlyRecord', 'DeleteRecord',
    'AssociateEntities', 'DisassociateEntities', 'PerformBoundAction', 'PerformUnboundAction',
    'GetEntityFileImageFieldContent', 'UpdateEntityFileImageFieldContent', 'ExecuteChangeset', 'GetRelevantRows',
  ]);
});

describe('SharePoint operationId emission (local-only names)', () => {
  assertMapping('sharepoint', [
    ['DiscardCheckOut', 'DiscardFileCheckOut'],
    ['ExtractFolder', 'ExtractFolderV2'],
    ['GetListViews', 'GetTableViews'],
    ['SetContentApprovalStatus', 'SetApprovalStatus'],
    ['ResolvePerson', 'SearchForUser'],
  ]);
  assertIdentity('sharepoint', [
    'DiscardFileCheckOut', 'ExtractFolderV2', 'CheckOutFile', 'CheckInFile', 'GetAttachmentContent',
    'DeleteAttachment', 'GetTableViews', 'SetApprovalStatus', 'SearchForUser', 'GetItemChanges',
    'CreateSharingLink', 'GrantAccess',
  ]);
});

const EXCEL_ALIASES: Array<[string, string]> = [
  ['ListRows', 'GetItems'],
  ['GetRows', 'GetItems'],
  ['GetRow', 'GetItem'],
  ['AddRow', 'AddRowV2'],
  ['UpdateRow', 'PatchItem'],
  ['DeleteRow', 'DeleteItem'],
  ['GetWorksheets', 'GetAllWorksheets'],
  ['AddKeyColumn', 'CreateIdColumn'],
  ['RunScript', 'RunScriptProd'],
  ['RunScriptFromLibrary', 'RunScriptProdV2'],
];
const EXCEL_CLOUD_IDS = [
  'GetItems', 'GetItem', 'AddRowV2', 'PatchItem', 'DeleteItem', 'GetTables', 'CreateTable',
  'CreateWorksheet', 'GetAllWorksheets', 'CreateIdColumn', 'RunScriptProd', 'RunScriptProdV2',
];

describe('Excel Online (Business) operationId emission', () => {
  // The DSL property is `ctx.connectors.excelonline`; a pulled flow carries `excelonlinebusiness`.
  for (const connector of ['excelonline', 'excelonlinebusiness']) {
    assertMapping(connector, EXCEL_ALIASES);
    assertIdentity(connector, EXCEL_CLOUD_IDS);
  }

  it('still flattens `item` for the aliased connector name', () => {
    const p = emitAction('excelonline', 'UpdateRow', { source: 'me', item: { Name: 'x' } }).parameters;
    assert.equal(p['item/Name'], 'x');
    assert.ok(!('item' in p));
  });
});

describe('Word Online (Business) operationId emission', () => {
  for (const connector of ['wordonline', 'wordonlinebusiness']) {
    assertMapping(connector, [
      ['PopulateWordTemplate', 'CreateFileItem'],
      ['PopulateAWordTemplate', 'CreateFileItem'],
      ['ConvertToPdf', 'GetFilePDF'],
      ['ConvertWordDocumentToPdf', 'GetFilePDF'],
    ]);
    assertIdentity(connector, ['CreateFileItem', 'GetFilePDF']);
  }
});

describe('Office 365 Groups operationId emission', () => {
  assertMapping('office365groups', [
    ['HttpRequest', 'HttpRequestV2'],
    ['CreateGroupEvent', 'CreateCalendarEventV2'],
    ['UpdateGroupEvent', 'UpdateCalendarEvent'],
    ['DeleteGroupEvent', 'CalendarDeleteItem_V2'],
  ]);
  // AddMemberToGroup IS the cloud id (learn.microsoft.com/connectors/office365groups);
  // `AddUserToGroup` belongs to the Azure AD connector.
  assertIdentity('office365groups', [
    'HttpRequestV2', 'AddMemberToGroup', 'RemoveMemberFromGroup', 'ListGroupMembers', 'ListGroups',
    'CreateCalendarEventV2', 'UpdateCalendarEvent', 'CalendarDeleteItem_V2',
  ]);
});

/* ------------------------------------------------------------------ */
/*  connector-name canonicalisation                                     */
/* ------------------------------------------------------------------ */

const NAME_ALIASES: Array<[alias: string, canonical: string]> = [
  ['excelonline', 'excelonlinebusiness'],
  ['wordonline', 'wordonlinebusiness'],
  ['onedrive', 'onedriveforbusiness'],
];

describe('connector-name canonicalisation', () => {
  for (const [alias, canonical] of NAME_ALIASES) {
    it(`emits ${alias} as shared_${canonical} in apiId, connectionName and connectionReferences`, () => {
      const json = emitFlow(alias, 'Whatever');
      const host = json.properties.definition.actions.TheAction.inputs.host;
      assert.equal(host.apiId, `${API_PREFIX}shared_${canonical}`);
      assert.equal(host.connectionName, `shared_${canonical}`);
      const refs = json.properties.connectionReferences;
      assert.deepEqual(Object.keys(refs), [`shared_${canonical}`]);
      assert.equal(refs[`shared_${canonical}`].api.name, `shared_${canonical}`);
    });

    it(`emits ${canonical} the same way as ${alias}`, () => {
      const a = emitFlow(alias, 'Whatever');
      const b = emitFlow(canonical, 'Whatever');
      assert.deepEqual(a.properties.definition.actions.TheAction.inputs.host, b.properties.definition.actions.TheAction.inputs.host);
      assert.deepEqual(Object.keys(a.properties.connectionReferences), Object.keys(b.properties.connectionReferences));
    });
  }

  it('a flow using both spellings gets one connection reference', () => {
    const flow: FlowIR = {
      name: 'TestFlow',
      nodes: [
        { id: 'trg_1', type: 'trigger', kind: 'manual', name: 'manual', inputs: {} },
        { id: 'con_1', type: 'connector', name: 'A', connector: 'excelonline', operation: 'GetRows', params: {} },
        { id: 'con_2', type: 'connector', name: 'B', connector: 'excelonlinebusiness', operation: 'GetItems', params: {} },
      ],
    } as unknown as FlowIR;
    const json = emitLogicAppsJson(flow) as any;
    assert.deepEqual(Object.keys(json.properties.connectionReferences), ['shared_excelonlinebusiness']);
    assert.equal(json.properties.definition.actions.A.inputs.host.connectionName, 'shared_excelonlinebusiness');
    assert.equal(json.properties.definition.actions.B.inputs.host.connectionName, 'shared_excelonlinebusiness');
  });

  it('canonicalises a connector trigger too', () => {
    const flow: FlowIR = {
      name: 'TestFlow',
      nodes: [
        {
          id: 'trg_1', type: 'trigger', kind: 'connector', name: 'When_a_file_is_created',
          inputs: { connector: 'onedrive', operation: 'OnNewFile', params: {} },
        },
        { id: 'act_1', type: 'action', name: 'Compose', kind: 'compose', inputs: 1 },
      ],
    } as unknown as FlowIR;
    const json = emitLogicAppsJson(flow) as any;
    const host = json.properties.definition.triggers.When_a_file_is_created.inputs.host;
    assert.equal(host.apiId, `${API_PREFIX}shared_onedriveforbusiness`);
    assert.equal(host.connectionName, 'shared_onedriveforbusiness');
    assert.deepEqual(Object.keys(json.properties.connectionReferences), ['shared_onedriveforbusiness']);
  });
});

/* ------------------------------------------------------------------ */
/*  config lookup under either key                                     */
/* ------------------------------------------------------------------ */

describe('config.connections lookup under alias or canonical key', () => {
  // `flowforger init` writes the DSL property name as the key.
  const aliasKeyed: EmitterConfig = {
    connections: {
      excelonline: {
        referenceName: 'shared_excelonlinebusiness_2',
        apiId: `${API_PREFIX}shared_excelonlinebusiness`,
        connectionReferenceLogicalName: 'ff_excel',
      },
    },
  };
  const canonicalKeyed: EmitterConfig = {
    connections: {
      excelonlinebusiness: {
        referenceName: 'shared_excelonlinebusiness_2',
        apiId: `${API_PREFIX}shared_excelonlinebusiness`,
        connectionReferenceLogicalName: 'ff_excel',
      },
    },
  };

  for (const [label, config] of [['alias-keyed', aliasKeyed], ['canonical-keyed', canonicalKeyed]] as const) {
    for (const connector of ['excelonline', 'excelonlinebusiness']) {
      it(`${label} config applies to a flow authored with ${connector}`, () => {
        const json = emitFlow(connector, 'GetItems', {}, config);
        const host = json.properties.definition.actions.TheAction.inputs.host;
        assert.equal(host.connectionName, 'shared_excelonlinebusiness_2');
        assert.equal(host.apiId, `${API_PREFIX}shared_excelonlinebusiness`);
        const refs = json.properties.connectionReferences;
        assert.deepEqual(Object.keys(refs), ['shared_excelonlinebusiness_2']);
        assert.equal(refs.shared_excelonlinebusiness_2.connection.connectionReferenceLogicalName, 'ff_excel');
        // Phase 2 of buildConnectionReferences names the API after the config entry's referenceName
        // (pre-existing behaviour); what matters here is that it is the business connector.
        assert.match(refs.shared_excelonlinebusiness_2.api.name, /^shared_excelonlinebusiness/);
      });
    }
  }

  it('a config entry for another connector is not emitted for the alias flow', () => {
    const config: EmitterConfig = {
      connections: {
        sharepoint: { referenceName: 'shared_sharepointonline', apiId: `${API_PREFIX}shared_sharepointonline` },
      },
    };
    const json = emitFlow('wordonline', 'CreateFileItem', {}, config);
    assert.deepEqual(Object.keys(json.properties.connectionReferences), ['shared_wordonlinebusiness']);
  });
});
