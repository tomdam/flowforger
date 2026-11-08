import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ExcelOnlineConnector } from '../index.js';
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

let fetchCalls: Array<{ url: string; method: string }> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = (async (input: string | URL | Request, opts?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, method: (opts?.method as string) || 'GET' });
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      text: async () => JSON.stringify({ value: [] }),
      json: async () => ({ value: [] }),
    } as unknown as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('ExcelOnlineConnector operation names', () => {
  // The typed DSL surface offers `GetRows`; the cloud id is GetItems and the
  // editor metadata name is ListRows. All three must list the table's rows.
  for (const name of ['GetRows', 'ListRows', 'GetItems']) {
    it(`${name} lists the rows of a table`, async () => {
      const connector = new ExcelOnlineConnector({ token: 't' });
      const out: any = await connector.invoke(name, { location: 'me', fileId: 'wb1', tableName: 'Table1' }, makeCtx());
      assert.ok(
        fetchCalls.some((c) => c.method === 'GET' && c.url.includes('/tables/Table1/rows')),
        JSON.stringify(fetchCalls)
      );
      assert.ok(out && typeof out === 'object');
    });
  }
});
