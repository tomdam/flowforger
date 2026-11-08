import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DataverseConnector } from '../index.js';
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

const BASE_URL = 'https://org.crm.dynamics.com';
const RECORD_ID = '11111111-2222-3333-4444-555555555555';

let fetchCalls: Array<{ url: string; method: string }> = [];

describe('DataverseConnector operation aliases', () => {
  let connector: DataverseConnector;
  let ctx: RunContext;

  beforeEach(() => {
    fetchCalls = [];
    (globalThis as any).fetch = async (url: string, opts: any) => {
      fetchCalls.push({ url, method: opts?.method || 'GET' });
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ accountid: RECORD_ID, name: 'A' }),
      };
    };
    connector = new DataverseConnector({ baseUrl: BASE_URL, token: 'test-token' });
    ctx = makeCtx();
  });

  // The typed DSL surface offers `RetrieveRecord`, the editor metadata `GetRow`;
  // both are the cloud's GetItem and must run locally.
  for (const alias of ['RetrieveRecord', 'GetRow']) {
    it(`${alias} reads one row like GetItem`, async () => {
      const row: any = await connector.invoke(alias, { entityName: 'accounts', recordId: RECORD_ID }, ctx);
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].method, 'GET');
      assert.match(fetchCalls[0].url, new RegExp(`/accounts\\(${RECORD_ID}\\)`));
      assert.equal(row.name, 'A');
    });
  }
});
