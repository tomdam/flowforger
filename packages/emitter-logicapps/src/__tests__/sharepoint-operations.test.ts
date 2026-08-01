import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emitLogicAppsJson } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const SITE = 'https://contoso.sharepoint.com/sites/MySite';
const LIST = '11111111-2222-3333-4444-555555555555';

/** Emit a one-action flow and return that action's `inputs` block. */
function emitAction(operation: string, params: Record<string, unknown>) {
  const flow: FlowIR = {
    name: 'TestFlow',
    nodes: [
      { id: 'trg_1', type: 'trigger', kind: 'manual', name: 'manual', inputs: {} },
      {
        id: 'con_1',
        type: 'connector',
        name: 'TheAction',
        connector: 'sharepoint',
        operation,
        params,
      },
    ],
  } as unknown as FlowIR;

  const json: any = emitLogicAppsJson(flow);
  return json.properties.definition.actions.TheAction.inputs;
}

/* ------------------------------------------------------------------ */
/*  operationId mapping                                                */
/* ------------------------------------------------------------------ */

describe('SharePoint operationId emission', () => {
  const idCases: Array<[dslOperation: string, paOperationId: string]> = [
    ['GetFilesPropertiesOnly', 'GetFileItems'],
    ['GetFileProperties', 'GetFileItem'],
    ['UpdateFileProperties', 'PatchFileItem'],
    ['AddAttachment', 'CreateAttachment'],
    ['GetAttachments', 'GetItemAttachments'],
    ['StopSharing', 'UnshareItem'],
    ['SendHttpRequest', 'HttpRequest'],
    ['GetLists', 'GetAllTables'],
    ['GetAllListsAndLibraries', 'GetAllTables'],
    ['CopyFile', 'CopyFileAsync'],
    ['MoveFile', 'MoveFileAsync'],
    ['CopyFolder', 'CopyFolderAsync'],
    ['MoveFolder', 'MoveFolderAsync'],
    // Pre-existing mappings must not regress.
    ['CreateItem', 'PostItem'],
    ['GetItemById', 'GetItem'],
    ['UpdateItem', 'PatchItem'],
  ];

  for (const [dslOperation, paOperationId] of idCases) {
    it(`emits ${dslOperation} as ${paOperationId}`, () => {
      const inputs = emitAction(dslOperation, { dataset: SITE });
      assert.equal(inputs.host.operationId, paOperationId);
    });
  }

  it('leaves an operation authored with its cloud id untouched', () => {
    const inputs = emitAction('GetFileItems', { dataset: SITE, table: LIST });
    assert.equal(inputs.host.operationId, 'GetFileItems');
  });
});

/* ------------------------------------------------------------------ */
/*  parameter renaming                                                 */
/* ------------------------------------------------------------------ */

describe('SharePoint parameter emission', () => {
  it('renames listId to table and drops the DSL key', () => {
    const p = emitAction('GetItems', { dataset: SITE, listId: LIST }).parameters;
    assert.equal(p.table, LIST);
    assert.ok(!('listId' in p), 'listId must not survive into the emitted parameters');
  });

  it('renames siteUrl to dataset', () => {
    const p = emitAction('GetItems', { siteUrl: SITE, table: LIST }).parameters;
    assert.equal(p.dataset, SITE);
    assert.ok(!('siteUrl' in p));
  });

  it('prefixes OData options with $ on list reads', () => {
    const p = emitAction('GetItems', {
      dataset: SITE,
      table: LIST,
      filter: "Title eq 'x'",
      orderby: 'Modified desc',
      top: 5,
    }).parameters;
    assert.deepEqual(p, {
      dataset: SITE,
      table: LIST,
      $filter: "Title eq 'x'",
      $orderby: 'Modified desc',
      $top: 5,
    });
  });

  it('prefixes OData options on GetFilesPropertiesOnly and keeps folderPath flat', () => {
    const p = emitAction('GetFilesPropertiesOnly', {
      dataset: SITE,
      listId: LIST,
      folderPath: '/Shared Documents/Reports',
      top: 100,
    }).parameters;
    assert.deepEqual(p, {
      dataset: SITE,
      table: LIST,
      folderPath: '/Shared Documents/Reports',
      $top: 100,
    });
  });

  it('renames itemId to id on item-addressed operations', () => {
    for (const op of ['GetFileProperties', 'UpdateFileProperties', 'StopSharing', 'GetItemChanges']) {
      const p = emitAction(op, { dataset: SITE, listId: LIST, itemId: 42 }).parameters;
      assert.equal(p.id, 42, `${op} should address the item via id`);
      assert.ok(!('itemId' in p), `${op} should not keep itemId`);
    }
  });

  it('keeps itemId on the attachment operations and renames the payload pair', () => {
    const get = emitAction('GetAttachments', { dataset: SITE, listId: LIST, itemId: 42 }).parameters;
    assert.deepEqual(get, { dataset: SITE, table: LIST, itemId: 42 });

    const add = emitAction('AddAttachment', {
      dataset: SITE,
      listId: LIST,
      itemId: 42,
      fileName: 'report.pdf',
      content: 'BASE64',
    }).parameters;
    assert.deepEqual(add, {
      dataset: SITE,
      table: LIST,
      itemId: 42,
      displayName: 'report.pdf',
      body: 'BASE64',
    });
  });

  it('moves file-transfer parameters under the parameters/ prefix', () => {
    const p = emitAction('CopyFile', {
      dataset: SITE,
      id: 'FILE-ID',
      destSiteUrl: SITE,
      destFolderPath: '/Archive',
    }).parameters;
    assert.deepEqual(p, {
      dataset: SITE,
      'parameters/sourceFileId': 'FILE-ID',
      'parameters/destinationDataset': SITE,
      'parameters/destinationFolderPath': '/Archive',
    });
  });

  it('uses sourceFolderId — not sourceFileId — for folder transfers', () => {
    const p = emitAction('CopyFolder', {
      dataset: SITE,
      folderId: 'FOLDER-ID',
      destSiteUrl: SITE,
      destFolderPath: '/Archive',
    }).parameters;
    assert.equal(p['parameters/sourceFolderId'], 'FOLDER-ID');
    assert.ok(!('parameters/sourceFileId' in p));
  });

  it('moves SendHttpRequest parameters under the parameters/ prefix', () => {
    const p = emitAction('SendHttpRequest', {
      dataset: SITE,
      method: 'POST',
      uri: '/_api/web/lists',
      headers: { Accept: 'application/json' },
      body: { Title: 'x' },
    }).parameters;
    assert.deepEqual(p, {
      dataset: SITE,
      'parameters/method': 'POST',
      'parameters/uri': '/_api/web/lists',
      'parameters/headers': { Accept: 'application/json' },
      'parameters/body': { Title: 'x' },
    });
  });

  it('uses the singular parameter/ prefix for GrantAccess', () => {
    const p = emitAction('GrantAccess', {
      dataset: SITE,
      listId: LIST,
      itemId: 7,
      recipients: 'a@contoso.com',
      roleValue: 'view',
      sendEmail: true,
    }).parameters;
    assert.deepEqual(p, {
      dataset: SITE,
      table: LIST,
      id: 7,
      'parameter/recipients': 'a@contoso.com',
      'parameter/roleValue': 'view',
      'parameter/sendEmail': true,
    });
  });

  it('nests CreateSharingLink permission options', () => {
    const p = emitAction('CreateSharingLink', {
      dataset: SITE,
      listId: LIST,
      itemId: 7,
      linkType: 'view',
      scope: 'anonymous',
    }).parameters;
    assert.equal(p['permission/type'], 'view');
    assert.equal(p['permission/scope'], 'anonymous');
    assert.equal(p.id, 7);
  });

  it('nests CreateNewFolder path', () => {
    const p = emitAction('CreateNewFolder', { dataset: SITE, listId: LIST, folderPath: '/New' }).parameters;
    assert.equal(p['parameters/path'], '/New');
    assert.ok(!('folderPath' in p));
  });

  it('still flattens fields into item/* on PatchFileItem', () => {
    const p = emitAction('UpdateFileProperties', {
      dataset: SITE,
      listId: LIST,
      itemId: 9,
      fields: { Title: 'New title', Status: 'Approved' },
    }).parameters;
    assert.deepEqual(p, {
      dataset: SITE,
      table: LIST,
      id: 9,
      'item/Title': 'New title',
      'item/Status': 'Approved',
    });
  });

  it('lets an explicitly-supplied cloud key win over the alias', () => {
    const p = emitAction('GetItems', { dataset: SITE, table: LIST, listId: 'IGNORED' }).parameters;
    assert.equal(p.table, LIST);
    assert.ok(!('listId' in p));
  });

  it('produces identical output whether authored with the DSL or cloud id', () => {
    const viaDsl = emitAction('GetFilesPropertiesOnly', { dataset: SITE, listId: LIST, top: 10 });
    const viaCloud = emitAction('GetFileItems', { dataset: SITE, listId: LIST, top: 10 });
    assert.deepEqual(viaCloud, viaDsl);
  });
});
