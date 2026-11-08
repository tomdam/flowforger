import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OneDriveConnector } from '../index.js';
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

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes as any).toString('base64');

let fetchCalls: Array<{ url: string; method: string; body?: unknown }> = [];
/** What the next GET answers: bytes plus the Content-Type header (null = no header). */
let download: { bytes: Uint8Array; contentType: string | null } = { bytes: PDF_BYTES, contentType: 'application/pdf' };

const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  download = { bytes: PDF_BYTES, contentType: 'application/pdf' };
  globalThis.fetch = (async (input: string | URL | Request, opts?: RequestInit) => {
    const url = String(input);
    const method = (opts?.method as string) || 'GET';
    fetchCalls.push({ url, method, body: opts?.body });
    if (method === 'GET') {
      const bytes = download.bytes;
      const ct = download.contentType;
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? ct : null) },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        text: async () => Buffer.from(bytes).toString('utf8'),
      } as unknown as Response;
    }
    // Uploads answer with a DriveItem.
    const item = { id: 'item1', name: 'out.bin', size: 5, eTag: '"1"', file: { mimeType: 'application/octet-stream' } };
    return {
      ok: true,
      status: 201,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify(item),
      json: async () => item,
    } as unknown as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('OneDriveConnector file content output shape', () => {
  // The cloud connector hands the next action binary content in the Logic Apps
  // envelope `{ "$content-type": "<mime>", "$content": "<base64>" }`, text/* as
  // the text and JSON parsed — the same rule as SharePoint's "Get file content".
  for (const op of ['GetFileContent', 'ConvertFile']) {
    it(`${op} returns binary content as the cloud envelope`, async () => {
      const connector = new OneDriveConnector({ token: 't' });
      const out = await connector.invoke(op, { id: 'file1', format: 'pdf' }, makeCtx());
      assert.deepEqual(out, { '$content-type': 'application/pdf', $content: b64(PDF_BYTES) });
    });
  }

  for (const op of ['GetFileContentByPath', 'ConvertFileByPath']) {
    it(`${op} returns binary content as the cloud envelope`, async () => {
      const connector = new OneDriveConnector({ token: 't' });
      const out = await connector.invoke(op, { path: '/Docs/a.docx', format: 'pdf' }, makeCtx());
      assert.deepEqual(out, { '$content-type': 'application/pdf', $content: b64(PDF_BYTES) });
    });
  }

  it('returns text/* content as text', async () => {
    download = { bytes: new TextEncoder().encode('hello, world'), contentType: 'text/plain; charset=utf-8' };
    const connector = new OneDriveConnector({ token: 't' });
    const out = await connector.invoke('GetFileContent', { id: 'file1' }, makeCtx());
    assert.equal(out, 'hello, world');
  });

  it('returns application/json content parsed', async () => {
    download = { bytes: new TextEncoder().encode('{"a":1}'), contentType: 'application/json' };
    const connector = new OneDriveConnector({ token: 't' });
    const out = await connector.invoke('GetFileContent', { id: 'file1' }, makeCtx());
    assert.deepEqual(out, { a: 1 });
  });

  it('falls back to application/octet-stream when the response names no content type', async () => {
    download = { bytes: PDF_BYTES, contentType: null };
    const connector = new OneDriveConnector({ token: 't' });
    const out = await connector.invoke('GetFileContent', { id: 'file1' }, makeCtx());
    assert.deepEqual(out, { '$content-type': 'application/octet-stream', $content: b64(PDF_BYTES) });
  });
});

describe('OneDriveConnector file content input', () => {
  it('CreateFile uploads the bytes of a cloud envelope body', async () => {
    const connector = new OneDriveConnector({ token: 't' });
    await connector.invoke(
      'CreateFile',
      { folderPath: '/Out', name: 'out.bin', body: { '$content-type': 'application/pdf', $content: b64(PDF_BYTES) } },
      makeCtx()
    );
    const put = fetchCalls.find((c) => c.method === 'PUT');
    assert.ok(put, 'expected a PUT');
    assert.deepEqual(Buffer.from(put!.body as Uint8Array), Buffer.from(PDF_BYTES));
  });

  it('UpdateFile uploads the bytes of a cloud envelope body', async () => {
    const connector = new OneDriveConnector({ token: 't' });
    await connector.invoke(
      'UpdateFile',
      { id: 'item1', body: { '$content-type': 'application/pdf', $content: b64(PDF_BYTES) } },
      makeCtx()
    );
    const put = fetchCalls.find((c) => c.method === 'PUT');
    assert.ok(put, 'expected a PUT');
    assert.deepEqual(Buffer.from(put!.body as Uint8Array), Buffer.from(PDF_BYTES));
  });
});
