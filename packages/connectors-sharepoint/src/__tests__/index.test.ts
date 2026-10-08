import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SharePointConnector } from '../index.js';
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

const SITE = 'https://tenant.sharepoint.com/sites/test';
const LIST = '11111111-2222-3333-4444-555555555555';

let fetchCalls: Array<{ url: string; method: string }> = [];
/** URL substring → response body. First matching route wins. */
let routes: Array<{ match: string; body: unknown; status?: number }> = [];

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['content-type', 'application/json']]),
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('SharePointConnector choice expansion', () => {
  let connector: SharePointConnector;
  let ctx: RunContext;

  const choiceFieldsResponse = {
    value: [
      { InternalName: 'UserType', TypeAsString: 'Choice', Choices: ['Prospect', 'Current', 'Alumni'] },
      { InternalName: 'Tags', TypeAsString: 'MultiChoice', Choices: ['Red', 'Green', 'Blue'] },
    ],
  };

  beforeEach(() => {
    fetchCalls = [];
    routes = [];
    (globalThis as any).fetch = async (url: string, opts: any) => {
      fetchCalls.push({ url, method: opts?.method || 'GET' });
      const route = routes.find((r) => url.includes(r.match));
      if (!route) throw new Error(`No mocked route for ${url}`);
      return jsonResponse(route.body, route.status);
    };
    connector = new SharePointConnector({ token: 'test-token' });
    ctx = makeCtx();
  });

  it('wraps single-choice values as SPListExpandedReference', async () => {
    routes = [
      { match: '/fields?', body: choiceFieldsResponse },
      { match: '/items', body: { value: [{ Id: 1, Title: 'A', UserType: 'Current' }] } },
    ];

    const result: any = await connector.invoke('GetItems', { dataset: SITE, table: LIST }, ctx);

    assert.deepEqual(result.value[0].UserType, {
      '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference',
      Id: 1,
      Value: 'Current',
    });
    // Non-choice fields untouched
    assert.equal(result.value[0].Title, 'A');
  });

  it('wraps multi-choice arrays and uses Id -1 for fill-in values', async () => {
    routes = [
      { match: '/fields?', body: choiceFieldsResponse },
      { match: '/items', body: { value: [{ Id: 1, Tags: ['Blue', 'Custom'] }] } },
    ];

    const result: any = await connector.invoke('GetItems', { dataset: SITE, table: LIST }, ctx);

    assert.deepEqual(result.value[0].Tags, [
      { '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference', Id: 2, Value: 'Blue' },
      { '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference', Id: -1, Value: 'Custom' },
    ]);
  });

  // The cloud connector leaves null columns out of the item altogether.
  it('omits null choice values', async () => {
    routes = [
      { match: '/fields?', body: choiceFieldsResponse },
      { match: '/items', body: { value: [{ Id: 1, UserType: null }] } },
    ];

    const result: any = await connector.invoke('GetItems', { dataset: SITE, table: LIST }, ctx);
    assert.ok(!('UserType' in result.value[0]));
  });

  it('returns raw items when the fields metadata request fails', async () => {
    routes = [
      { match: '/fields?', body: { error: 'nope' }, status: 403 },
      { match: '/items', body: { value: [{ Id: 1, UserType: 'Current' }] } },
    ];

    const result: any = await connector.invoke('GetItems', { dataset: SITE, table: LIST }, ctx);
    assert.equal(result.value[0].UserType, 'Current');
  });

  it('caches field metadata per list across calls', async () => {
    routes = [
      { match: '/fields?', body: choiceFieldsResponse },
      { match: '/items', body: { value: [{ Id: 1, UserType: 'Alumni' }] } },
    ];

    await connector.invoke('GetItems', { dataset: SITE, table: LIST }, ctx);
    await connector.invoke('GetItems', { dataset: SITE, table: LIST }, ctx);

    const fieldsCalls = fetchCalls.filter((c) => c.url.includes('/fields?'));
    assert.equal(fieldsCalls.length, 1);
  });

  it('expands choice values on GetItem as well', async () => {
    routes = [
      { match: '/fields?', body: choiceFieldsResponse },
      { match: '/items(7)', body: { Id: 7, UserType: 'Prospect' } },
    ];

    const result: any = await connector.invoke('GetItem', { dataset: SITE, table: LIST, id: 7 }, ctx);
    assert.deepEqual(result.UserType, {
      '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference',
      Id: 0,
      Value: 'Prospect',
    });
  });
});

describe('SharePointConnector lookup/person expansion', () => {
  let connector: SharePointConnector;
  let ctx: RunContext;

  const refFieldsResponse = {
    value: [
      { InternalName: 'UserType', TypeAsString: 'Choice', Choices: ['Prospect', 'Current', 'Alumni'] },
      { InternalName: 'Project', TypeAsString: 'Lookup', LookupField: 'Title' },
      { InternalName: 'Approvers', TypeAsString: 'UserMulti' },
      { InternalName: 'Author', TypeAsString: 'User' },
    ],
  };

  const janeRaw = { Id: 3, Title: 'Jane Doe', EMail: 'jane@contoso.com', Name: 'i:0#.f|membership|jane@contoso.com' };
  const janeExpanded = {
    '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedUser',
    Claims: 'i:0#.f|membership|jane@contoso.com',
    DisplayName: 'Jane Doe',
    Email: 'jane@contoso.com',
    Picture: `${SITE}/_layouts/15/UserPhoto.aspx?Size=L&AccountName=jane@contoso.com`,
    Department: null,
    JobTitle: null,
  };

  beforeEach(() => {
    fetchCalls = [];
    routes = [];
    (globalThis as any).fetch = async (url: string, opts: any) => {
      fetchCalls.push({ url, method: opts?.method || 'GET' });
      const route = routes.find((r) => url.includes(r.match));
      if (!route) throw new Error(`No mocked route for ${url}`);
      return jsonResponse(route.body, route.status);
    };
    connector = new SharePointConnector({ token: 'test-token' });
    ctx = makeCtx();
  });

  it('adds $expand/$select for lookup and person fields to the items query', async () => {
    routes = [
      { match: '/fields?', body: refFieldsResponse },
      { match: '/items', body: { value: [] } },
    ];

    await connector.invoke('GetItems', { dataset: SITE, table: LIST }, ctx);

    const itemsUrl = decodeURIComponent(fetchCalls.find((c) => c.url.includes('/items'))!.url);
    assert.ok(itemsUrl.includes('$expand=Project,Approvers,Author'));
    assert.ok(itemsUrl.includes('Project/Id,Project/Title'));
    assert.ok(itemsUrl.includes('Author/Id,Author/Title,Author/EMail,Author/Name'));
    assert.ok(itemsUrl.includes('$select=*,'));
  });

  it('wraps expanded lookup values as SPListExpandedReference with the target item Id', async () => {
    routes = [
      { match: '/fields?', body: refFieldsResponse },
      { match: '/items', body: { value: [{ Id: 1, Project: { Id: 12, Title: 'Apollo' } }] } },
    ];

    const result: any = await connector.invoke('GetItems', { dataset: SITE, table: LIST }, ctx);
    assert.deepEqual(result.value[0].Project, {
      '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference',
      Id: 12,
      Value: 'Apollo',
    });
  });

  it('wraps person values as SPListExpandedUser (single and multi)', async () => {
    routes = [
      { match: '/fields?', body: refFieldsResponse },
      { match: '/items', body: { value: [{ Id: 1, Author: janeRaw, Approvers: [janeRaw, { Id: 4, Title: 'No Mail', EMail: null, Name: 'i:0#.f|membership|nomail' }] }] } },
    ];

    const result: any = await connector.invoke('GetItems', { dataset: SITE, table: LIST }, ctx);
    assert.deepEqual(result.value[0].Author, janeExpanded);
    assert.equal(result.value[0].Approvers.length, 2);
    assert.deepEqual(result.value[0].Approvers[0], janeExpanded);
    assert.deepEqual(result.value[0].Approvers[1], {
      '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedUser',
      Claims: 'i:0#.f|membership|nomail',
      DisplayName: 'No Mail',
      Email: null,
      Picture: null,
      Department: null,
      JobTitle: null,
    });
  });

  it('only expands ref fields present in a user-supplied $select', async () => {
    routes = [
      { match: '/fields?', body: refFieldsResponse },
      { match: '/items', body: { value: [] } },
    ];

    await connector.invoke('GetItems', { dataset: SITE, table: LIST, $select: 'Title,Project' }, ctx);

    const itemsUrl = decodeURIComponent(fetchCalls.find((c) => c.url.includes('/items'))!.url);
    assert.ok(itemsUrl.includes('$expand=Project'));
    assert.ok(!itemsUrl.includes('Author/'));
    assert.ok(!itemsUrl.includes('Approvers'));
  });

  it('falls back to a raw query when every expanded query fails, still wrapping choices', async () => {
    routes = [
      { match: '/fields?', body: refFieldsResponse },
      // Every query that expands a ref field fails; the system-column query without refs does not.
      { match: 'Project', body: { error: 'lookup threshold exceeded' }, status: 400 },
      { match: 'Approvers', body: { error: 'lookup threshold exceeded' }, status: 400 },
      { match: 'Author', body: { error: 'lookup threshold exceeded' }, status: 400 },
      { match: '/items', body: { value: [{ Id: 1, UserType: 'Current', ProjectId: 12 }] } },
    ];

    const result: any = await connector.invoke('GetItems', { dataset: SITE, table: LIST }, ctx);

    // First items request is the expanded one (400), last is the raw fallback;
    // narrowing probes in between also fail since every $expand 400s here.
    const itemsCalls = fetchCalls.filter((c) => c.url.includes('/items'));
    assert.ok(itemsCalls[0].url.includes('$expand='));
    assert.ok(!itemsCalls[itemsCalls.length - 1].url.includes('$expand='));
    assert.deepEqual(result.value[0].UserType, {
      '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference',
      Id: 1,
      Value: 'Current',
    });
    // Raw lookup sibling untouched
    assert.equal(result.value[0].ProjectId, 12);

    // The empty verified set is cached: a second call expands no ref field
    // and does not retry the failing expansion or re-probe.
    const before = fetchCalls.length;
    await connector.invoke('GetItems', { dataset: SITE, table: LIST }, ctx);
    const newCalls = fetchCalls.slice(before);
    assert.equal(newCalls.length, 1);
    assert.ok(!/Project|Approvers|Author/.test(newCalls[0].url));
  });

  it('projects dependent lookup columns through the primary nav property', async () => {
    const fieldsWithDependents = {
      value: [
        { Id: 'f-langs', InternalName: 'Languages', TypeAsString: 'LookupMulti', LookupField: 'Details' },
        { Id: 'f-langs-title', InternalName: 'Languages_x003a_Title', TypeAsString: 'LookupMulti', LookupField: 'Title', IsDependentLookup: true, PrimaryFieldId: 'f-langs' },
        { Id: 'f-proj', InternalName: 'Project', TypeAsString: 'Lookup', LookupField: 'Title' },
        { Id: 'f-proj-phase', InternalName: 'Project_x003a_Phase', TypeAsString: 'Lookup', LookupField: 'Phase', IsDependentLookup: true, PrimaryFieldId: 'f-proj' },
        { Id: 'f-orphan', InternalName: 'Orphan_x003a_Title', TypeAsString: 'Lookup', LookupField: 'Title', IsDependentLookup: true, PrimaryFieldId: 'missing' },
      ],
    };
    routes = [
      { match: '/fields?', body: fieldsWithDependents },
      {
        match: '/items',
        body: {
          value: [{
            Id: 1,
            Languages: [{ Id: 3, Details: 'DE-C1', Title: 'German' }, { Id: 4, Details: 'EN-B2', Title: 'English' }],
            Project: { Id: 12, Title: 'Apollo', Phase: 'Beta' },
          }],
        },
      },
    ];

    const result: any = await connector.invoke('GetItems', { dataset: SITE, table: LIST }, ctx);

    // Dependent columns are never expanded by their own (invalid) nav name —
    // they ride on the primary's expansion, with their show field selected.
    const itemsUrl = decodeURIComponent(fetchCalls.find((c) => c.url.includes('/items'))!.url);
    assert.ok(itemsUrl.includes('$expand=Languages,Project'));
    assert.ok(!itemsUrl.includes('_x003a_'));
    assert.ok(itemsUrl.includes('Languages/Title'));
    assert.ok(itemsUrl.includes('Project/Phase'));

    assert.deepEqual(result.value[0].Project, {
      '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference',
      Id: 12,
      Value: 'Apollo',
    });
    assert.deepEqual(result.value[0].Project_x003a_Phase, {
      '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference',
      Id: 12,
      Value: 'Beta',
    });
    assert.deepEqual(result.value[0].Languages, [
      { '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference', Id: 3, Value: 'DE-C1' },
      { '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference', Id: 4, Value: 'EN-B2' },
    ]);
    assert.deepEqual(result.value[0].Languages_x003a_Title, [
      { '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference', Id: 3, Value: 'German' },
      { '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference', Id: 4, Value: 'English' },
    ]);
    // Orphaned dependent (unresolvable primary) is skipped entirely
    assert.equal(result.value[0].Orphan_x003a_Title, undefined);
  });

  it('recovers lookup expansion by isolating a failing ref field', async () => {
    const fieldsWithBadRef = {
      value: [
        { InternalName: 'UserType', TypeAsString: 'Choice', Choices: ['Prospect', 'Current', 'Alumni'] },
        { InternalName: 'Project', TypeAsString: 'Lookup', LookupField: 'Title' },
        { InternalName: 'BadRef', TypeAsString: 'Lookup', LookupField: 'Title' },
        { InternalName: 'Author', TypeAsString: 'User' },
      ],
    };
    routes = [
      { match: '/fields?', body: fieldsWithBadRef },
      // Any query expanding BadRef fails (e.g. target list not readable)
      { match: 'BadRef', body: { error: 'cannot expand' }, status: 400 },
      { match: '/items', body: { value: [{ Id: 1, UserType: 'Current', Project: { Id: 12, Title: 'Apollo' }, BadRefId: 9 }] } },
    ];

    const result: any = await connector.invoke('GetItems', { dataset: SITE, table: LIST }, ctx);

    // Lookup expansion survives for the good field...
    assert.deepEqual(result.value[0].Project, {
      '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference',
      Id: 12,
      Value: 'Apollo',
    });
    assert.deepEqual(result.value[0].UserType, {
      '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference',
      Id: 1,
      Value: 'Current',
    });
    // ...while the bad field stays raw
    assert.equal(result.value[0].BadRefId, 9);
    // The successful retry expands Project and Author but never BadRef
    const itemsCalls = fetchCalls.filter((c) => c.url.includes('/items'));
    const lastUrl = decodeURIComponent(itemsCalls[itemsCalls.length - 1].url);
    assert.ok(lastUrl.includes('Project'));
    assert.ok(lastUrl.includes('Author'));
    assert.ok(!lastUrl.includes('BadRef'));

    // Verified set is cached: the next call expands the good fields directly,
    // with no failing attempt and no probes.
    const before = fetchCalls.length;
    const second: any = await connector.invoke('GetItems', { dataset: SITE, table: LIST }, ctx);
    const newCalls = fetchCalls.slice(before);
    assert.equal(newCalls.length, 1);
    assert.ok(!newCalls[0].url.includes('BadRef'));
    assert.deepEqual(second.value[0].Project, {
      '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference',
      Id: 12,
      Value: 'Apollo',
    });
  });

  it('applies expansion to GetFileProperties', async () => {
    routes = [
      { match: '/fields?', body: refFieldsResponse },
      { match: '/items(7)', body: { Id: 7, Author: janeRaw, Project: { Id: 5, Title: 'Poseidon' } } },
    ];

    const result: any = await connector.invoke('GetFileProperties', { dataset: SITE, table: LIST, id: 7 }, ctx);
    assert.deepEqual(result.Author, janeExpanded);
    assert.deepEqual(result.Project, {
      '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference',
      Id: 5,
      Value: 'Poseidon',
    });
  });

  it('applies expansion to GetFilesPropertiesOnly; a library expands File for the drive ids only', async () => {
    routes = [
      { match: 'BaseType', body: { BaseType: 1 } },
      { match: '/fields?', body: refFieldsResponse },
      {
        match: '/items',
        body: { value: [{ Id: 1, Author: janeRaw, File: { VroomDriveID: 'b!drive', VroomItemID: '01ITEM' } }] },
      },
    ];

    const result: any = await connector.invoke('GetFilesPropertiesOnly', { dataset: SITE, table: LIST }, ctx);

    const itemsUrl = decodeURIComponent(fetchCalls.find((c) => c.url.includes('/items'))!.url);
    assert.ok(itemsUrl.includes('$expand=Project,Approvers,Author,ContentType,File'), itemsUrl);
    assert.ok(itemsUrl.includes('File/VroomDriveID'), itemsUrl);
    assert.ok(!itemsUrl.includes('Folder'), itemsUrl);
    assert.deepEqual(result.value[0].Author, janeExpanded);
    // The cloud returns no File/Folder objects.
    assert.ok(!('File' in result.value[0]));
  });
});

describe('SharePointConnector cloud operationId aliases', () => {
  let connector: SharePointConnector;
  let ctx: RunContext;

  beforeEach(() => {
    fetchCalls = [];
    routes = [];
    (globalThis as any).fetch = async (url: string, opts: any) => {
      fetchCalls.push({ url, method: opts?.method || 'GET' });
      const route = routes.find((r) => url.includes(r.match));
      if (!route) throw new Error(`No mocked route for ${url}`);
      return jsonResponse(route.body, route.status);
    };
    connector = new SharePointConnector({ token: 'test-token' });
    ctx = makeCtx();
  });

  /** Cloud operationId → a URL fragment only the right handler produces. */
  const cases: Array<{ op: string; inputs: Record<string, unknown>; expectUrl: string }> = [
    // "Get files (properties only)" — the maker-portal id for GetFilesPropertiesOnly.
    { op: 'GetFileItems', inputs: { dataset: SITE, table: LIST }, expectUrl: `lists(guid'${LIST}')/items` },
    // "Get file properties" — single item, so the id must reach the itemId slot.
    { op: 'GetFileItem', inputs: { dataset: SITE, table: LIST, id: 7 }, expectUrl: `lists(guid'${LIST}')/items(7)` },
    // "Get attachments" — id must normalize to itemId, not fileId.
    {
      op: 'GetItemAttachments',
      inputs: { dataset: SITE, table: LIST, id: 3 },
      expectUrl: `lists(guid'${LIST}')/items(3)/AttachmentFiles`,
    },
    // "Stop sharing" — the maker-portal id for StopSharing; addressed via
    // GetFileById, so id must normalize to itemId here too, not fileId.
    {
      op: 'UnshareItem',
      inputs: { dataset: SITE, id: 5 },
      expectUrl: `GetFileById('5')/ListItemAllFields/UnshareLink`,
    },
    // Check in/out address the library item (table + id), as the cloud does (sp-checkout.ff.ts).
    {
      op: 'DiscardFileCheckOut',
      inputs: { dataset: SITE, table: LIST, id: 4 },
      expectUrl: `lists(guid'${LIST}')/items(4)/File/UndoCheckOut()`,
    },
    {
      op: 'CheckInFile',
      inputs: { dataset: SITE, table: LIST, id: 4, 'parameter/comment': 'done', 'parameter/checkinType': 0 },
      expectUrl: `lists(guid'${LIST}')/items(4)/File/CheckIn(comment=@c,checkintype=0)?@c='done'`,
    },
  ];

  for (const { op, inputs, expectUrl } of cases) {
    it(`dispatches ${op} to its local handler`, async () => {
      routes = [
        { match: '/fields?', body: { value: [] } },
        { match: '/', body: { value: [], Id: 1 } },
      ];

      await connector.invoke(op, inputs, ctx);

      const urls = fetchCalls.map((c) => decodeURIComponent(c.url));
      assert.ok(
        urls.some((u) => u.includes(expectUrl)),
        `${op} never hit ${expectUrl}; called:\n${urls.join('\n')}`,
      );
    });
  }

  it('reports the name the caller used for a genuinely unknown operation', async () => {
    await assert.rejects(
      () => connector.invoke('NotARealOperation', { dataset: SITE, table: LIST }, ctx),
      /unknown operation 'NotARealOperation'/,
    );
  });
});

// Shapes verified against real cloud runs (conformance/flows/sp-attachments, sp-folders).
describe('SharePointConnector attachments and folders (cloud shapes)', () => {
  let connector: SharePointConnector;
  let ctx: RunContext;

  beforeEach(() => {
    fetchCalls = [];
    routes = [];
    (globalThis as any).fetch = async (url: string, opts: any) => {
      fetchCalls.push({ url, method: opts?.method || 'GET' });
      const route = routes.find((r) => url.includes(r.match));
      if (!route) throw new Error(`No mocked route for ${url}`);
      return jsonResponse(route.body, route.status);
    };
    connector = new SharePointConnector({ token: 'test-token' });
    ctx = makeCtx();
  });

  it('adds an attachment through AddUsingPath and answers with SPListItemAttachment', async () => {
    routes = [
      {
        match: 'AddUsingPath',
        body: { FileName: 'w pixel.png', ServerRelativeUrl: '/sites/test/Lists/My Items/Attachments/9/w pixel.png' },
      },
    ];
    const added = await connector.invoke(
      'CreateAttachment',
      { dataset: SITE, table: LIST, itemId: 9, displayName: 'w pixel.png', body: 'x' },
      ctx,
    );
    assert.ok(fetchCalls[0].url.endsWith(`/Items(9)/AttachmentFiles/AddUsingPath(decodedUrl=@f)?@f='w+pixel.png'`));
    assert.deepEqual(added, {
      Id: '%252fLists%252fMy%2bItems%252fAttachments%252f9%252fw%2bpixel.png',
      AbsoluteUri: 'https://tenant.sharepoint.com/sites/test/Lists/My Items/Attachments/9/w pixel.png',
      DisplayName: 'w pixel.png',
      '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListItemAttachment',
    });
  });

  it('reports an Add attachment failure like an HTTP request: { status, message, source, errors }', async () => {
    routes = [
      {
        match: 'AddUsingPath',
        status: 400,
        body: { 'odata.error': { code: '-2130575257, Microsoft.SharePoint.SPException', message: { value: 'The specified name is already in use.' } } },
      },
    ];
    const err = await connector.invoke('CreateAttachment', { dataset: SITE, table: LIST, itemId: 9, displayName: 'a.txt', body: 'x' }, ctx).catch((e) => e);
    const outputs = connector.errorOutputs('CreateAttachment', err) as any;
    assert.equal(outputs.statusCode, 400);
    assert.equal(outputs.body.message, 'The specified name is already in use.');
    assert.deepEqual(outputs.body.errors, ['-2130575257', 'Microsoft.SharePoint.SPException']);
    assert.ok(outputs.body.source.endsWith(`AddUsingPath(decodedUrl=@f)?@f='a.txt'`));
  });

  it('fails a copy with "fail on conflict" with the cloud message when the name is taken', async () => {
    routes = [
      { match: 'GetFileByServerRelativeUrl(\'/sites/test/Docs/a.txt\')?$select=Name', body: { Name: 'a.txt', ServerRelativeUrl: '/sites/test/Docs/a.txt' } },
      { match: 'Exists', body: { Exists: true } },
    ];
    const err: any = await connector
      .invoke('CopyFileAsync', {
        dataset: SITE,
        'parameters/sourceFileId': '%252fDocs%252fa.txt',
        'parameters/destinationFolderPath': '/Target',
        'parameters/nameConflictBehavior': 0,
      }, ctx)
      .catch((e) => e);
    assert.equal(err.status, 400);
    assert.equal(err.message, "A file or folder with the name 'a.txt' already exists at the destination.");
    assert.ok(!fetchCalls.some((c) => c.url.includes('MoveCopyUtil')));
  });
});

describe('readZipEntries', () => {
  it('reads stored entries, including those in folders', async () => {
    const { readZipEntries } = await import('../zip.js');
    // The two-entry archive sp-folders.ff.ts extracts: a.txt and dir/b.txt.
    const zip = Uint8Array.from(
      atob(
        'UEsDBAoAAAAAAAAAAACzL55LCgAAAAoAAAAFAAAAYS50eHR6aXAgZmlsZSBhUEsDBAoAAAAAAAAAAAAJfpfSCgAAAAoAAAAJAAAAZGlyL2IudHh0emlwIGZpbGUgYlBLAQIUAAoAAAAAAAAAAACzL55LCgAAAAoAAAAFAAAAAAAAAAAAAAAAAAAAAABhLnR4dFBLAQIUAAoAAAAAAAAAAAAJfpfSCgAAAAoAAAAJAAAAAAAAAAAAAAAAAC0AAABkaXIvYi50eHRQSwUGAAAAAAIAAgBqAAAAXgAAAAAA',
      ),
      (c) => c.charCodeAt(0),
    );
    const entries = await readZipEntries(zip);
    assert.deepEqual(
      entries.map((e) => [e.name, new TextDecoder().decode(e.data)]),
      [['a.txt', 'zip file a'], ['dir/b.txt', 'zip file b']],
    );
  });

  it('rejects something that is not a zip', async () => {
    const { readZipEntries } = await import('../zip.js');
    await assert.rejects(() => readZipEntries(new TextEncoder().encode('not a zip at all, just text')), /not a \.zip/);
  });
});

describe('SharePointConnector cloud item/* payloads', () => {
  let connector: SharePointConnector;
  let ctx: RunContext;

  beforeEach(() => {
    fetchCalls = [];
    routes = [];
    (globalThis as any).fetch = async (url: string, opts: any) => {
      fetchCalls.push({ url, method: opts?.method || 'GET' });
      const route = routes.find((r) => url.includes(r.match));
      if (!route) throw new Error(`No mocked route for ${url}`);
      return jsonResponse(route.body, route.status);
    };
    connector = new SharePointConnector({ token: 'test-token' });
    ctx = makeCtx();
  });

  it('accepts item/* column values on PatchFileItem', async () => {
    routes = [{ match: '/', body: { ID: 9, Title: 'New title' } }];

    // Exactly the shape the maker portal emits for "Update file properties".
    const result: any = await connector.invoke(
      'PatchFileItem',
      { dataset: SITE, table: LIST, id: 9, 'item/Title': 'New title', 'item/Status': 'Approved' },
      ctx,
    );

    // Like the cloud, it answers with the item (re-read after the MERGE).
    assert.equal(result.ID, 9);
    const call = fetchCalls.find((c) => c.url.includes('items(9)'));
    assert.ok(call, `never patched items(9); called: ${fetchCalls.map((c) => c.url).join(', ')}`);
  });

  // `item: invoice` / `item: body('X')` is an expression, not an object literal, so the
  // transformer cannot flatten it into item/* keys: the evaluated object arrives nested.
  it('sends the fields of a nested item object on PostItem (not an empty item)', async () => {
    const bodies: Array<{ url: string; body: any }> = [];
    (globalThis as any).fetch = async (url: string, opts: any) => {
      if (opts?.body) bodies.push({ url, body: JSON.parse(opts.body) });
      return jsonResponse({ ListItemEntityTypeFullName: 'SP.Data.InvoicesListItem', Id: 1 });
    };

    await connector.invoke(
      'PostItem',
      { dataset: SITE, table: LIST, item: { Title: 'INV-1041', Amount: 320, Status: 'Open' } },
      ctx,
    );

    const post = bodies.find((b) => b.url.endsWith('/items'));
    assert.ok(post, 'never posted to /items');
    assert.equal(post.body.Title, 'INV-1041');
    assert.equal(post.body.Amount, 320);
    assert.equal(post.body.Status, 'Open');
  });

  it('lets item/* keys win over the same field in a nested item object', async () => {
    const bodies: Array<{ url: string; body: any }> = [];
    (globalThis as any).fetch = async (url: string, opts: any) => {
      if (opts?.body) bodies.push({ url, body: JSON.parse(opts.body) });
      return jsonResponse({ ListItemEntityTypeFullName: 'SP.Data.InvoicesListItem' });
    };

    await connector.invoke(
      'PatchItem',
      { dataset: SITE, table: LIST, id: 4, item: { Status: 'Open', Title: 'kept' }, 'item/Status': 'Escalated' },
      ctx,
    );

    const patch = bodies.find((b) => b.url.includes('items(4)'));
    assert.ok(patch, 'never patched items(4)');
    assert.equal(patch.body.Status, 'Escalated');
    assert.equal(patch.body.Title, 'kept');
  });
});

// Shapes verified against real cloud runs (conformance/flows/sp-read, sp-write).
describe('SharePointConnector cloud parity (designer writes, item layout)', () => {
  let connector: SharePointConnector;
  let ctx: RunContext;
  let requests: Array<{ url: string; method: string; body?: any }>;

  const fields = {
    value: [
      { InternalName: 'Status', TypeAsString: 'Choice', Choices: ['Open', 'Closed'] },
      { InternalName: 'Tags', TypeAsString: 'MultiChoice', Choices: ['Red', 'Green', 'Blue'] },
      { InternalName: 'Category', TypeAsString: 'Lookup', LookupField: 'Title' },
      { InternalName: 'Related', TypeAsString: 'LookupMulti', LookupField: 'Title' },
      { InternalName: 'Owner', TypeAsString: 'User' },
      { InternalName: 'Reviewers', TypeAsString: 'UserMulti' },
      { InternalName: 'Author', TypeAsString: 'User' },
      { InternalName: 'DueDate', TypeAsString: 'DateTime', DisplayFormat: 0 },
      { InternalName: 'DueTime', TypeAsString: 'DateTime', DisplayFormat: 1 },
      { InternalName: 'Link', TypeAsString: 'URL' },
    ],
  };
  const jane = { Id: 7, Title: 'Jane Doe', EMail: 'jane@contoso.com', Name: 'i:0#.f|membership|jane@contoso.com' };
  // A REST item as SharePoint returns it for the connector's expanded query.
  const restItem = {
    FileSystemObjectType: 0,
    Id: 1,
    ServerRedirectedEmbedUri: null,
    ContentTypeId: '0x0100AB',
    Title: 'Alpha',
    Status: 'Closed',
    Tags: null,
    Amount: null,
    DueDate: '2026-03-15T07:00:00Z',
    DueTime: '2026-03-15T14:30:00Z',
    Link: { Description: 'Docs', Url: 'https://example.com/a' },
    OwnerId: 7,
    OwnerStringId: '7',
    CategoryId: 2,
    RelatedId: [],
    ID: 1,
    Modified: '2026-03-01T00:00:00Z',
    AuthorId: 7,
    OData__UIVersionString: '2.0',
    Attachments: false,
    GUID: 'abc',
    FileRef: '/sites/test/Lists/My Items/1_.000',
    FileLeafRef: '1_.000',
    FileDirRef: '/sites/test/Lists/My Items',
    FSObjType: '0',
    owshiddenversion: 3,
    ContentType: { Id: { StringValue: '0x0100AB' }, Name: 'Item' },
    Owner: jane,
    Category: { Id: 2, Title: 'Software' },
    Author: jane,
  };

  beforeEach(() => {
    requests = [];
    (globalThis as any).fetch = async (url: string, opts: any) => {
      const body = opts?.body ? JSON.parse(opts.body) : undefined;
      requests.push({ url, method: opts?.method || 'GET', body });
      if (url.includes('/fields?')) return jsonResponse(fields);
      if (url.includes('/ensureuser')) return jsonResponse({ Id: 7 });
      if (url.includes('utcToLocalTime')) return jsonResponse({ value: '2026-03-15T00:00:00' });
      if (url.includes('/items(1)') || url.includes('/items?')) return jsonResponse(url.includes('/items?') ? { value: [{ ...restItem }] } : { ...restItem });
      if (url.endsWith('/items')) return jsonResponse({ Id: 1 }, 201);
      return jsonResponse({ ok: true }, 204);
    };
    connector = new SharePointConnector({ token: 'test-token' });
    ctx = makeCtx();
  });

  it('translates the designer field format into a REST item body on PostItem', async () => {
    await connector.invoke(
      'PostItem',
      {
        dataset: SITE,
        table: LIST,
        'item/Title': 'W',
        'item/Status/Value': 'Open',
        'item/Tags': [{ Value: 'Red' }, { Value: 'Green' }],
        'item/Category/Id': '2',
        'item/Related': [{ Id: 1 }],
        'item/Owner/Claims': 'i:0#.f|membership|jane@contoso.com',
        'item/Reviewers': [{ Claims: 'i:0#.f|membership|jane@contoso.com' }],
      },
      ctx,
    );

    const post = requests.find((r) => r.method === 'POST' && r.url.endsWith('/items'));
    assert.deepEqual(post?.body, {
      Title: 'W',
      Status: 'Open',
      Tags: ['Red', 'Green'],
      CategoryId: 2,
      RelatedId: [1],
      OwnerId: 7,
      ReviewersId: [7],
    });
    // One ensureuser call for the same claims, then cached.
    assert.equal(requests.filter((r) => r.url.includes('/ensureuser')).length, 1);
  });

  it('clears a plain column set to null but leaves a choice/lookup/person sub-value of null alone', async () => {
    // Verified in the cloud (conformance/flows/null-params.ff.ts).
    await connector.invoke(
      'PatchItem',
      {
        dataset: SITE,
        table: LIST,
        id: 1,
        'item/Title': 'W',
        'item/Amount': null,
        'item/Status/Value': null,
        'item/Category/Id': null,
        'item/Owner/Claims': null,
      },
      ctx,
    );

    const merge = requests.find((r) => r.method === 'POST' && r.url.endsWith('/items(1)'));
    assert.deepEqual(merge?.body, { Title: 'W', Amount: null });
    assert.equal(requests.filter((r) => r.url.includes('/ensureuser')).length, 0);
  });

  it('answers PostItem and PatchItem with the item in cloud shape', async () => {
    const created: any = await connector.invoke('PostItem', { dataset: SITE, table: LIST, 'item/Title': 'W' }, ctx);
    const patched: any = await connector.invoke('PatchItem', { dataset: SITE, table: LIST, id: 1, 'item/Title': 'W2' }, ctx);
    assert.equal(created.ItemInternalId, '1');
    assert.equal(patched['@odata.etag'], '"3"');
  });

  it('lays an item out the way the cloud connector returns it', async () => {
    const item: any = await connector.invoke('GetItem', { dataset: SITE, table: LIST, id: 1 }, ctx);

    assert.deepEqual(Object.keys(item), [
      '@odata.etag', 'ItemInternalId', 'ID', 'Title', 'Status', 'Status#Id',
      'Tags', 'Tags@odata.type', 'Tags#Id', 'Tags#Id@odata.type',
      'DueDate', 'DueTime', 'Link', 'Owner', 'Owner#Claims', 'Category', 'Category#Id',
      'Related', 'Related@odata.type', 'Related#Id', 'Related#Id@odata.type',
      'Modified', 'Author', 'Author#Claims',
      'Reviewers', 'Reviewers@odata.type', 'Reviewers#Claims', 'Reviewers#Claims@odata.type',
      '{Identifier}', '{IsFolder}', '{Link}', '{Name}', '{FilenameWithExtension}', '{Path}', '{FullPath}',
      '{ContentType}', '{ContentType}#Id', '{HasAttachments}', '{VersionNumber}',
    ]);
    assert.equal(item['@odata.etag'], '"3"');
    assert.equal(item.Status['#Id'], undefined);
    assert.equal(item['Status#Id'], 1);
    assert.deepEqual(item.Tags, []);
    assert.equal(item.DueDate, '2026-03-15'); // date-only → site-local calendar date
    assert.equal(item.DueTime, '2026-03-15T14:30:00Z'); // date+time stays UTC
    assert.equal(item.Link, 'https://example.com/a');
    assert.equal(item['Owner#Claims'], 'i:0#.f|membership|jane@contoso.com');
    assert.equal(item['Category#Id'], 2);
    assert.equal(item['{Identifier}'], 'Lists%252fMy%2bItems%252f1_.000');
    assert.equal(item['{Path}'], 'Lists/My Items/');
    assert.equal(item['{FullPath}'], 'Lists/My Items/1_.000');
    assert.equal(item['{Name}'], 'Alpha');
    assert.equal(
      item['{Link}'],
      `${SITE}/_layouts/15/listform.aspx?PageType=4&ListId=11111111%2D2222%2D3333%2D4444%2D555555555555&ID=1&ContentTypeID=0x0100AB`,
    );
    assert.deepEqual(item['{ContentType}'], {
      '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedContentType',
      Id: '0x0100AB',
      Name: 'Item',
    });
    assert.equal(item['{VersionNumber}'], '2.0');
  });

  it('queries the system columns behind the synthetic fields', async () => {
    await connector.invoke('GetItems', { dataset: SITE, table: LIST }, ctx);
    const url = decodeURIComponent(requests.find((r) => r.url.includes('/items?'))!.url);
    for (const col of ['FileRef', 'FileLeafRef', 'FileDirRef', 'FSObjType', 'owshiddenversion', 'ContentType/Id']) {
      assert.ok(url.includes(col), `${col} not selected: ${url}`);
    }
    assert.ok(/\$expand=[^&]*ContentType/.test(url), url);
  });

  it('renames the paging link to @odata.nextLink', async () => {
    (globalThis as any).fetch = async (url: string) =>
      jsonResponse(url.includes('/fields?') ? fields : { value: [], 'odata.nextLink': 'https://next' });
    const result: any = await connector.invoke('GetItems', { dataset: SITE, table: LIST, $top: 1 }, ctx);
    assert.equal(result['@odata.nextLink'], 'https://next');
    assert.ok(!('odata.nextLink' in result));
  });

  it('returns no body from DeleteItem', async () => {
    const result = await connector.invoke('DeleteItem', { dataset: SITE, table: LIST, id: 1 }, ctx);
    assert.equal(result, undefined);
  });

  it('reports 201 for an item create (cloud id or local name) and 200 otherwise', () => {
    assert.equal(connector.successStatusCode('PostItem'), 201);
    assert.equal(connector.successStatusCode('CreateItem'), 201);
    assert.equal(connector.successStatusCode('GetItems'), 200);
    assert.equal(connector.successStatusCode('DeleteItem'), 200);
  });

  it('rewrites REST errors into the cloud connector\'s { status, message } outputs', () => {
    const restError = (status: number, code: string, value: string) =>
      Object.assign(new Error('x'), { status, response: { 'odata.error': { code, message: { lang: 'en-US', value } } } });

    assert.deepEqual(
      connector.errorOutputs('GetItem', restError(404, '-2130575338, System.ArgumentException', 'Item does not exist. It may have been deleted by another user.')),
      { statusCode: 404, body: { status: 404, message: 'Item Not Found' } },
    );
    assert.deepEqual(
      connector.errorOutputs('GetItems', restError(404, '-1, System.ArgumentException', 'List does not exist.\n\nThe page you selected contains a list that does not exist.')),
      { statusCode: 404, body: { status: 404, message: 'List not found' } },
    );
    assert.deepEqual(
      connector.errorOutputs('GetItems', restError(500, '-2146232832, Microsoft.SharePoint.SPException', "Column 'Nope' does not exist. It may have been deleted by another user.")),
      { statusCode: 400, body: { status: 400, message: "Column 'Nope' does not exist. It may have been deleted by another user." } },
    );
    assert.equal(connector.errorOutputs('GetItems', new Error('requires siteUrl')), undefined);
  });
});

// Shapes verified against real cloud runs (conformance/flows/sp-library, sp-files-write, paging).
describe('SharePointConnector cloud parity (document libraries)', () => {
  let connector: SharePointConnector;
  let ctx: RunContext;
  let requests: Array<{ url: string; method: string }>;
  let respond: (url: string, method: string) => unknown;

  const notes = {
    Name: 'notes.txt',
    ServerRelativeUrl: '/sites/test/Docs/notes.txt',
    TimeLastModified: '2026-09-28T22:14:33Z',
    Length: '19',
    ETag: '"{0486A88A-70F9-4FE1-BB21-7828CC0C90A9},2"',
    ListItemAllFields: { Id: 1 },
  };
  const libraryItem = (over: Record<string, unknown>) => ({
    Id: 1,
    ID: 1,
    Title: null,
    FileRef: '/sites/test/Docs/notes.txt',
    FileLeafRef: 'notes.txt',
    FileDirRef: '/sites/test/Docs',
    FSObjType: '0',
    owshiddenversion: 2,
    UniqueId: '0486a88a-70f9-4fe1-bb21-7828cc0c90a9',
    CheckoutUserId: null,
    OData__DisplayName: '',
    OData__UIVersionString: '1.0',
    ContentType: { Id: { StringValue: '0x0101' }, Name: 'Document' },
    ...over,
  });

  beforeEach(() => {
    requests = [];
    respond = () => ({});
    (globalThis as any).fetch = async (url: string, opts: any) => {
      const method = opts?.method || 'GET';
      requests.push({ url: decodeURIComponent(url), method });
      if (url.includes('BaseType')) return jsonResponse({ BaseType: 1 });
      if (url.includes('/fields?')) return jsonResponse({ value: [] });
      return jsonResponse(respond(decodeURIComponent(url), method));
    };
    connector = new SharePointConnector({ token: 'test-token' });
    ctx = makeCtx();
  });

  it('answers GetFileMetadata with the cloud BlobMetadata', async () => {
    respond = () => notes;
    const meta: any = await connector.invoke('GetFileMetadata', { dataset: SITE, id: '%252fDocs%252fnotes.txt' }, ctx);
    assert.deepEqual(meta, {
      ItemId: 1,
      Id: '%252fDocs%252fnotes.txt',
      Name: 'notes.txt',
      DisplayName: 'notes.txt',
      Path: '/Docs/notes.txt',
      LastModified: '2026-09-28T22:14:33Z',
      Size: 19,
      MediaType: 'text/plain',
      IsFolder: false,
      ETag: '"{0486A88A-70F9-4FE1-BB21-7828CC0C90A9},2"',
      FileLocator: `dataset=${btoa(SITE)},id=${btoa('%252fDocs%252fnotes.txt')}`,
    });
  });

  it('lists a folder addressed by its identifier: subfolders, then files, ItemId 0', async () => {
    respond = (url) =>
      url.includes('/Folders')
        ? { value: [{ Name: 'Sub', ServerRelativeUrl: '/sites/test/Docs/Folder A/Sub', TimeLastModified: 't1' }] }
        : { value: [{ ...notes, ServerRelativeUrl: '/sites/test/Docs/Folder A/notes.txt' }] };
    const entries: any = await connector.invoke('ListFolder', { dataset: SITE, id: '%252fDocs%252fFolder%2bA' }, ctx);
    assert.ok(requests.some((r) => r.url.includes("GetFolderByServerRelativeUrl('/sites/test/Docs/Folder A')/Folders")));
    assert.deepEqual(
      entries.map((e: any) => [e.Id, e.IsFolder, e.ItemId, 'MediaType' in e]),
      [
        ['%252fDocs%252fFolder%2bA%252fSub', true, 0, false],
        ['%252fDocs%252fFolder%2bA%252fnotes.txt', false, 0, true],
      ],
    );
  });

  it('answers CreateFile and UpdateFile with BlobMetadata, DeleteFile with no body', async () => {
    respond = (url, method) => (method === 'POST' && url.includes('/Files/add') ? { UniqueId: 'u-1' } : notes);
    const created: any = await connector.invoke('CreateFile', { dataset: SITE, folderPath: '/Docs', name: 'notes.txt', body: 'x' }, ctx);
    assert.equal(created.Id, '%252fDocs%252fnotes.txt');
    assert.equal(created.ItemId, 1);
    assert.ok(requests.some((r) => r.url.includes("GetFileById('u-1')")));
    const updated: any = await connector.invoke('UpdateFile', { dataset: SITE, id: created.Id, body: 'y' }, ctx);
    assert.equal(updated.Path, '/Docs/notes.txt');
    assert.equal(await connector.invoke('DeleteFile', { dataset: SITE, id: created.Id }, ctx), undefined);
  });

  it('gives library items the cloud synthetic fields', async () => {
    respond = () => ({
      value: [
        // A folder before any file: its drive ids come from what the files teach.
        libraryItem({ Id: 4, ID: 4, FileRef: '/sites/test/Docs/Folder A', FileLeafRef: 'Folder A', FSObjType: '1', UniqueId: '783897fe-9955-4abc-acf1-0d4365fffc1f' }),
        libraryItem({ File: { VroomDriveID: 'b!drive', VroomItemID: '01OBY4LTEKVCDAJ6LQ4FH3WILYFDGAZEFJ' } }),
        libraryItem({ Id: 6, ID: 6, FileRef: '/sites/test/Docs/data.csv', FileLeafRef: 'data.csv', CheckoutUserId: 7, UniqueId: 'bfc2b148-b9d5-4563-96c9-9790793f9091' }),
      ],
    });
    const result: any = await connector.invoke('GetFileItems', { dataset: SITE, table: LIST }, ctx);
    const [folder, file, csv] = result.value;

    assert.equal(file['{Name}'], 'notes');
    assert.equal(file['{FilenameWithExtension}'], 'notes.txt');
    assert.equal(file['{Link}'], 'https://tenant.sharepoint.com/sites/test/Docs/notes.txt');
    assert.equal(csv['{Link}'], 'https://tenant.sharepoint.com/sites/test/Docs/data.csv?d=wbfc2b148b9d5456396c99790793f9091');
    assert.equal(file['{IsCheckedOut}'], false);
    assert.equal(csv['{IsCheckedOut}'], true);
    assert.deepEqual(file['{Thumbnail}'], { Full: null, Large: null, Medium: null, Small: null });
    assert.equal(file['{DriveId}'], 'b!drive');
    assert.equal(file['{DriveItemId}'], '01OBY4LTEKVCDAJ6LQ4FH3WILYFDGAZEFJ');
    assert.equal(folder['{DriveId}'], 'b!drive');
    assert.equal(folder['{DriveItemId}'], '01OBY4LTH6S44HQVMZXRFKZ4ININS777A7'); // verified against the cloud
    assert.equal(folder['{Name}'], 'Folder A');
    assert.equal(file.OData__DisplayName, '');
    for (const item of result.value) assert.ok(!('File' in item) && !('UniqueId' in item) && !('CheckoutUserId' in item));
  });

  it('shapes a continuation page like the first (nextPage)', async () => {
    respond = () => ({ value: [libraryItem({})], 'odata.nextLink': 'https://next/2' });
    const page: any = await connector.nextPage('GetFileItems', { dataset: SITE, table: LIST }, 'https://next/1', ctx);
    assert.equal(page.value[0]['{Name}'], 'notes');
    assert.equal(page['@odata.nextLink'], 'https://next/2');
    assert.ok(requests.some((r) => r.url === 'https://next/1'));
  });
});

describe('SharePointConnector file identifiers', () => {
  let connector: SharePointConnector;
  let ctx: RunContext;

  beforeEach(() => {
    fetchCalls = [];
    routes = [{ match: '/', body: { Name: 'a.xml', ServerRelativeUrl: '/sites/test/Lib/a.xml' } }];
    (globalThis as any).fetch = async (url: string, opts: any) => {
      fetchCalls.push({ url, method: opts?.method || 'GET' });
      const route = routes.find((r) => url.includes(r.match));
      if (!route) throw new Error(`No mocked route for ${url}`);
      return jsonResponse(route.body, route.status);
    };
    connector = new SharePointConnector({ token: 'test-token' });
    ctx = makeCtx();
  });

  const lastUrl = () => decodeURIComponent(fetchCalls[fetchCalls.length - 1].url);
  /** Some request addressed this resource (query string ignored). */
  const called = (suffix: string) => fetchCalls.some((c) => decodeURIComponent(c.url).split('?')[0].endsWith(suffix));
  const calls = () => fetchCalls.map((c) => decodeURIComponent(c.url)).join(', ');

  it('addresses a trigger {Identifier} (double-encoded site-relative path) by server-relative URL', async () => {
    // Exactly what "When a file is created" hands out: library name, then
    // '/' as %252f — GetFileById would reject this with "Guid should contain 32 digits".
    const id = 'InkassoNeu%252f20260914_060059_Spk_Muensterland_Ost_2026-09-14_C53_DE14400501500034508333_EUR_26-00155.xml';
    await connector.invoke('GetFileContent', { dataset: SITE, id, inferContentType: true }, ctx);
    assert.ok(
      lastUrl().endsWith(
        `/_api/web/GetFileByServerRelativeUrl('/sites/test/InkassoNeu/20260914_060059_Spk_Muensterland_Ost_2026-09-14_C53_DE14400501500034508333_EUR_26-00155.xml')/$value`,
      ),
      lastUrl(),
    );
  });

  it('decodes %2b as a space and keeps a server-relative identifier as-is', async () => {
    // "Create file" returns ids like this: leading %252f, site path included, spaces as %2b.
    const id = '%252fsites%252ftest%252fShared%2bDocuments%252fMy%2bReport.docx';
    await connector.invoke('GetFileMetadata', { dataset: SITE, id }, ctx);
    assert.ok(called(`/_api/web/GetFileByServerRelativeUrl('/sites/test/Shared Documents/My Report.docx')`), calls());
  });

  it('keeps a literal + in a file name (arrives as %252b)', async () => {
    await connector.invoke('GetFileMetadata', { dataset: SITE, id: 'Lib%252fa%252bb.txt' }, ctx);
    assert.ok(called(`GetFileByServerRelativeUrl('/sites/test/Lib/a+b.txt')`), calls());
  });

  it('still uses GetFileById for a real GUID (with or without braces)', async () => {
    await connector.invoke('GetFileContent', { dataset: SITE, id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, ctx);
    assert.ok(lastUrl().endsWith(`GetFileById('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')/$value`), lastUrl());
    await connector.invoke('DeleteFile', { dataset: SITE, id: '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}' }, ctx);
    assert.ok(lastUrl().endsWith(`GetFileById('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')`), lastUrl());
  });

  it('applies the resolver to the other file-id operations', async () => {
    const id = 'Lib%252fdoc.docx';
    await connector.invoke('CheckOutFile', { dataset: SITE, id }, ctx);
    assert.ok(lastUrl().endsWith(`GetFileByServerRelativeUrl('/sites/test/Lib/doc.docx')/CheckOut()`), lastUrl());
    await connector.invoke('UpdateFile', { dataset: SITE, id, body: 'hello' }, ctx);
    assert.ok(called(`GetFileByServerRelativeUrl('/sites/test/Lib/doc.docx')/$value`), calls());
  });
});

describe('SharePointConnector GetFilesPropertiesOnly folder scoping', () => {
  let connector: SharePointConnector;
  let ctx: RunContext;
  let calls: Array<{ url: string; method: string; body?: any }> = [];

  const fieldsResponse = {
    value: [{ InternalName: 'Author', TypeAsString: 'User', LookupField: 'Title' }],
  };
  const janeRaw = { Id: 3, Title: 'Jane Doe', EMail: 'jane@contoso.com', Name: 'i:0#.f|membership|jane@contoso.com' };

  beforeEach(() => {
    calls = [];
    routes = [];
    (globalThis as any).fetch = async (url: string, opts: any) => {
      calls.push({ url, method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : undefined });
      const route = routes.find((r) => url.includes(r.match));
      if (!route) throw new Error(`No mocked route for ${url}`);
      return jsonResponse(route.body, route.status);
    };
    connector = new SharePointConnector({ token: 'test-token' });
    ctx = makeCtx();
  });

  it('posts a folder-scoped GetItems instead of a FileDirRef $filter', async () => {
    routes = [
      { match: '/fields?', body: fieldsResponse },
      { match: '/GetItems', body: { value: [{ Id: 1 }, { Id: 2 }] } },
      { match: '/items?', body: { value: [{ Id: 1, ID: 1, Author: janeRaw, AuthorId: 3 }, { Id: 2, ID: 2 }] } },
    ];

    const result: any = await connector.invoke(
      'GetFilesPropertiesOnly',
      { dataset: SITE, table: LIST, 'parameters/folderPath': '/sites/test/Shared Documents/Projects' },
      ctx
    );

    const call = calls.find((c) => c.url.includes('/GetItems'));
    assert.ok(call, `no GetItems call; called: ${calls.map((c) => c.url).join(', ')}`);
    assert.equal(call.method, 'POST');
    assert.ok(call.url.startsWith(`${SITE}/_api/web/lists(guid'${LIST}')/GetItems?`));
    const decoded = decodeURIComponent(call.url);
    // CAML GetItems rejects $expand, so it only finds the ids...
    assert.ok(decoded.includes('$select=Id'), decoded);
    assert.ok(!decoded.includes('$expand'), decoded);
    assert.ok(!decoded.includes('FileDirRef eq'), decoded);
    assert.equal(call.body.query.FolderServerRelativeUrl, '/sites/test/Shared Documents/Projects');
    assert.equal(call.body.query.ViewXml, "<View Scope='RecursiveAll'><RowLimit>5000</RowLimit></View>");
    // ...and the items are read like GetItems reads them, by ID (indexed: threshold-safe).
    const read = calls.find((c) => c.url.includes('/items?'));
    assert.ok(read, 'items were not read by ID');
    const readUrl = decodeURIComponent(read.url);
    assert.ok(readUrl.includes('$filter=ID eq 1 or ID eq 2'), readUrl);
    assert.ok(readUrl.includes('Author'), readUrl);
    assert.equal(result.value[0].Author.Email, 'jane@contoso.com');
  });

  it('prefixes a site-relative folder path with the site server-relative path', async () => {
    routes = [
      { match: '/fields?', body: fieldsResponse },
      { match: '/GetItems', body: { value: [] } },
    ];
    await connector.invoke(
      'GetFilesPropertiesOnly',
      { dataset: SITE, table: LIST, 'parameters/folderPath': 'Shared Documents/Projects' },
      ctx
    );
    const call = calls.find((c) => c.url.includes('/GetItems'))!;
    assert.equal(call.body.query.FolderServerRelativeUrl, '/sites/test/Shared Documents/Projects');
  });

  it('includeNestedItems=false scopes the view to direct children only', async () => {
    routes = [
      { match: '/fields?', body: fieldsResponse },
      { match: '/GetItems', body: { value: [] } },
    ];
    await connector.invoke(
      'GetFilesPropertiesOnly',
      {
        dataset: SITE,
        table: LIST,
        'parameters/folderPath': '/sites/test/Shared Documents/Projects',
        'parameters/includeNestedItems': false,
      },
      ctx
    );
    const call = calls.find((c) => c.url.includes('/GetItems'))!;
    assert.equal(call.body.query.ViewXml, '<View><RowLimit>5000</RowLimit></View>');
  });

  it('keeps the FileDirRef $filter GET when an OData filter is also given', async () => {
    routes = [
      { match: '/fields?', body: fieldsResponse },
      { match: '/items', body: { value: [] } },
    ];
    await connector.invoke(
      'GetFilesPropertiesOnly',
      {
        dataset: SITE,
        table: LIST,
        'parameters/folderPath': '/sites/test/Shared Documents/Projects',
        'parameters/$filter': "Title eq 'x'",
      },
      ctx
    );
    assert.ok(!calls.some((c) => c.url.includes('/GetItems')));
    const call = calls.find((c) => c.url.includes('/items'))!;
    assert.equal(call.method, 'GET');
    assert.ok(decodeURIComponent(call.url).includes("FileDirRef eq '/sites/test/Shared Documents/Projects'"));
  });
});

describe('SharePointConnector file content (cloud body shape)', () => {
  let connector: SharePointConnector;
  let ctx: RunContext;

  /** Serve every URL as raw bytes with the given content-type header, like SharePoint's $value endpoint. */
  function serveBytes(contentType: string, text = '<a/>') {
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('$select=Name')) return jsonResponse({ Name: 'by-guid.pdf' });
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', contentType]]),
        text: async () => text,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
      };
    };
  }

  beforeEach(() => {
    connector = new SharePointConnector({ token: 'test-token' });
    ctx = makeCtx();
  });

  it('returns an .xml file as its text, like the cloud run does, even when SharePoint serves octet-stream', async () => {
    serveBytes('application/octet-stream', '<?xml version="1.0"?><root>ä</root>');
    const result = await connector.invoke(
      'GetFileContent',
      { dataset: SITE, id: 'InkassoNeu%252f20260914_Spk.xml', inferContentType: true },
      ctx,
    );
    assert.equal(result, '<?xml version="1.0"?><root>ä</root>');
  });

  it('returns the base64 envelope with the cloud $content-type key when inferContentType is false', async () => {
    serveBytes('text/xml', '<a/>');
    const result = await connector.invoke(
      'GetFileContent',
      { dataset: SITE, id: 'Lib%252fa.xml', inferContentType: false },
      ctx,
    );
    assert.deepEqual(result, { '$content-type': 'application/octet-stream', $content: btoa('<a/>') });
  });

  it('parses a .json file into an object', async () => {
    serveBytes('application/octet-stream', '{"a":1}');
    const result = await connector.invoke('GetFileContent', { dataset: SITE, id: 'Lib%252fcfg.json' }, ctx);
    assert.deepEqual(result, { a: 1 });
  });

  it('looks up the name for a GUID id and returns a binary type as the envelope', async () => {
    serveBytes('application/octet-stream', '%PDF');
    const result: any = await connector.invoke(
      'GetFileContent',
      { dataset: SITE, id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      ctx,
    );
    assert.deepEqual(result, { '$content-type': 'application/pdf', $content: btoa('%PDF') });
  });

  it('applies the same rules to GetFileContentByPath and attachments', async () => {
    serveBytes('application/octet-stream', 'hello');
    const byPath: any = await connector.invoke(
      'GetFileContentByPath',
      { dataset: SITE, path: '/Shared Documents/Report Q3.docx' },
      ctx,
    );
    assert.equal(byPath['$content-type'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(byPath.$content, btoa('hello'));
    const att = await connector.invoke(
      'GetAttachmentContent',
      { dataset: SITE, table: LIST, id: 4, attachmentId: 'notes.txt' },
      ctx,
    );
    assert.equal(att, 'hello');
  });

  it('falls back to an application/octet-stream envelope for an unknown extension', async () => {
    serveBytes('application/octet-stream', 'xyz');
    const result = await connector.invoke('GetFileContent', { dataset: SITE, id: 'Lib%252fdata.weird' }, ctx);
    assert.deepEqual(result, { '$content-type': 'application/octet-stream', $content: btoa('xyz') });
  });
});

describe('SharePointConnector HttpRequest (cloud response shape)', () => {
  // Measured against the cloud by conformance/flows/sp-http.ff.ts.
  let connector: SharePointConnector;
  let ctx: RunContext;
  let sent: { url: string; headers: Record<string, string> } | undefined;

  function serve(status: number, contentType: string, text: string, extraHeaders: Array<[string, string]> = []) {
    (globalThis as any).fetch = async (url: string, init: any) => {
      sent = { url, headers: init.headers };
      return {
        ok: status < 400,
        status,
        headers: new Map([...(contentType ? [['content-type', contentType] as [string, string]] : []), ...extraHeaders]),
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
      };
    };
  }
  const request = (params: Record<string, unknown>) =>
    connector.invoke('HttpRequest', { dataset: SITE, 'parameters/method': 'GET', ...params }, ctx) as Promise<any>;

  beforeEach(() => {
    connector = new SharePointConnector({ token: 'test-token' });
    ctx = makeCtx();
    sent = undefined;
  });

  it('asks for OData verbose by default and drops top-level nulls only', async () => {
    serve(200, 'application/json;odata=verbose;charset=utf-8', JSON.stringify({ Title: 'x', Notes: null, d: { Amount: null } }));
    const r = await request({ 'parameters/uri': '_api/web' });
    assert.equal(sent!.headers.Accept, 'application/json;odata=verbose');
    assert.deepEqual(r.body, { Title: 'x', d: { Amount: null } });
    assert.equal(r.headers['content-type'], 'application/json; odata=verbose; charset=utf-8');
  });

  it('returns other content as the base64 envelope, and no body for an empty response', async () => {
    serve(200, 'application/octet-stream', 'Hello notes\n');
    const file = await request({ 'parameters/uri': "_api/web/GetFileByServerRelativeUrl('/a.txt')/$value" });
    assert.deepEqual(file.body, { '$content-type': 'application/octet-stream', $content: btoa('Hello notes\n') });

    serve(204, '', '');
    const merged = await request({ 'parameters/method': 'POST', 'parameters/uri': '_api/web/lists/items(1)' });
    assert.equal(merged.statusCode, 204);
    assert.equal('body' in merged, false);
  });

  it("fails with the cloud's { status, message, source, errors } body", async () => {
    serve(404, 'application/json;odata=verbose', JSON.stringify({
      error: { code: '-1, System.ArgumentException', message: { lang: 'en-US', value: "List 'Nope' does not exist." } },
    }), [['sprequestguid', 'svc-1']]);
    const err = await request({ 'parameters/uri': "_api/web/lists/getbytitle('No Such')" }).catch((e) => e);
    const out = connector.errorOutputs('HttpRequest', err) as any;
    assert.equal(out.statusCode, 404);
    assert.equal(out.body.status, 404);
    assert.match(out.body.message, /^List 'Nope' does not exist\.\r\nclientRequestId: [0-9a-f-]{36}\r\nserviceRequestId: svc-1$/);
    assert.equal(out.body.source, `${SITE}/_api/web/lists/getbytitle('No%20Such')`);
    assert.deepEqual(out.body.errors, ['-1', 'System.ArgumentException']);
  });
});
