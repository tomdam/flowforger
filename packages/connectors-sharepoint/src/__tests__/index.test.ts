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

  it('leaves null choice values untouched', async () => {
    routes = [
      { match: '/fields?', body: choiceFieldsResponse },
      { match: '/items', body: { value: [{ Id: 1, UserType: null }] } },
    ];

    const result: any = await connector.invoke('GetItems', { dataset: SITE, table: LIST }, ctx);
    assert.equal(result.value[0].UserType, null);
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
    Picture: `${SITE}/_layouts/15/UserPhoto.aspx?Size=L&AccountName=jane%40contoso.com`,
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

  it('falls back to a raw query when the expanded query fails, still wrapping choices', async () => {
    routes = [
      { match: '/fields?', body: refFieldsResponse },
      { match: '$expand=', body: { error: 'lookup threshold exceeded' }, status: 400 },
      { match: '/items', body: { value: [{ Id: 1, UserType: 'Current', ProjectId: 12 }] } },
    ];

    const result: any = await connector.invoke('GetItems', { dataset: SITE, table: LIST }, ctx);

    // Two items requests: expanded (400) then raw
    assert.equal(fetchCalls.filter((c) => c.url.includes('/items')).length, 2);
    assert.deepEqual(result.value[0].UserType, {
      '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference',
      Id: 1,
      Value: 'Current',
    });
    // Raw lookup sibling untouched
    assert.equal(result.value[0].ProjectId, 12);
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

  it('applies expansion to GetFilesPropertiesOnly and keeps File/Folder expanded', async () => {
    routes = [
      { match: '/fields?', body: refFieldsResponse },
      { match: '/items', body: { value: [{ Id: 1, Author: janeRaw, File: { Name: 'a.docx' } }] } },
    ];

    const result: any = await connector.invoke('GetFilesPropertiesOnly', { dataset: SITE, table: LIST }, ctx);

    const itemsUrl = decodeURIComponent(fetchCalls.find((c) => c.url.includes('/items'))!.url);
    assert.ok(itemsUrl.includes('$expand=File,Folder,Project,Approvers,Author'));
    assert.ok(itemsUrl.includes('$select=*,File,Folder,'));
    assert.deepEqual(result.value[0].Author, janeExpanded);
    assert.deepEqual(result.value[0].File, { Name: 'a.docx' });
  });
});
