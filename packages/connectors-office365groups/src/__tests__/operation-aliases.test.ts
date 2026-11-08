import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Office365GroupsConnector } from '../index.js';
import type { RunContext } from '@flowforger/engine';

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

let fetchCalls: Array<{ url: string; method: string; body?: any }> = [];

describe('Office365GroupsConnector cloud operation ids', () => {
  let connector: Office365GroupsConnector;
  let ctx: RunContext;

  beforeEach(() => {
    fetchCalls = [];
    (globalThis as any).fetch = async (url: string, opts: any) => {
      fetchCalls.push({ url, method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : undefined });
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ value: [] }),
        text: async () => '{"value":[]}',
      };
    };
    connector = new Office365GroupsConnector({ token: 'test-token' });
    ctx = makeCtx();
  });

  // "Send an HTTP request V2" is the cloud id a pulled flow carries (HttpRequest is deprecated there).
  it('HttpRequestV2 sends the Graph request like HttpRequest', async () => {
    await connector.invoke('HttpRequestV2', { Uri: 'https://graph.microsoft.com/v1.0/groups', Method: 'GET' }, ctx);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].method, 'GET');
    assert.ok(fetchCalls[0].url.endsWith('/groups'), fetchCalls[0].url);
  });
});
