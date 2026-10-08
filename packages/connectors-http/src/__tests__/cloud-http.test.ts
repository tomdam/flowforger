/**
 * The HTTP action's request and response shaping, as measured against the cloud by
 * conformance/flows/http.ff.ts (the echo flow reported what the cloud sent).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHttpRequest, buildUrl, shapeHeaders, shapeResponse, transportError, HttpActionError } from '../cloud-http.js';
import { HttpConnector } from '../index.js';

const text = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : undefined);
const bytes = (s: string) => new TextEncoder().encode(s);

describe('buildHttpRequest', () => {
  it('sends a string body as text/plain and any other value as JSON', () => {
    const s = buildHttpRequest({ method: 'POST', uri: 'https://x/a', body: 'plain' });
    assert.equal(s.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.equal(text(s.body), 'plain');
    for (const body of [{ a: 1, n: null }, [1, 'a'], 42, true]) {
      const r = buildHttpRequest({ method: 'POST', uri: 'https://x/a', body });
      assert.equal(r.headers['Content-Type'], 'application/json; charset=utf-8');
      assert.equal(text(r.body), JSON.stringify(body));
    }
  });

  it('sends no body and no Content-Type without a body, and no Accept header', () => {
    const r = buildHttpRequest({ method: 'POST', uri: 'https://x/a' });
    assert.equal(r.body, undefined);
    assert.deepEqual(r.headers, {});
  });

  it('keeps a Content-Type the action sets, whatever the body', () => {
    const r = buildHttpRequest({ method: 'POST', uri: 'https://x/a', headers: { 'content-type': 'application/json' }, body: '{"k":1}' });
    assert.deepEqual(r.headers, { 'content-type': 'application/json' });
    assert.equal(text(r.body), '{"k":1}');
    const custom = buildHttpRequest({ method: 'POST', uri: 'https://x/a', headers: { 'Content-Type': 'application/x-custom' }, body: { k: 1 } });
    assert.equal(text(custom.body), '{"k":1}');
  });

  it('sends binary content as its bytes with its own type', () => {
    const r = buildHttpRequest({ method: 'POST', uri: 'https://x/a', body: { '$content-type': 'application/octet-stream', $content: 'aGk=' } });
    assert.equal(r.headers['Content-Type'], 'application/octet-stream');
    assert.equal(text(r.body), 'hi');
  });

  it('turns cookie and Basic/Raw authentication into headers', () => {
    const r = buildHttpRequest({
      method: 'POST',
      uri: 'https://x/a',
      cookie: 'session=abc; theme=dark',
      authentication: { type: 'Basic', username: 'user', password: 'p@ss:word' },
    });
    assert.equal(r.headers.Cookie, 'session=abc; theme=dark');
    assert.equal(r.headers.Authorization, `Basic ${Buffer.from('user:p@ss:word').toString('base64')}`);
    const raw = buildHttpRequest({ method: 'GET', uri: 'https://x/a', authentication: { type: 'Raw', value: 'Bearer abc' } });
    assert.equal(raw.headers.Authorization, 'Bearer abc');
  });

  it('refuses authentication kinds that only the cloud can perform', () => {
    assert.throws(
      () => buildHttpRequest({ method: 'GET', uri: 'https://x', authentication: { type: 'ManagedServiceIdentity' } }),
      (e: any) => e instanceof HttpActionError && /not supported in local runs/.test(e.message),
    );
  });
});

describe('buildUrl', () => {
  it('replaces the query string of the uri with queries', () => {
    assert.equal(buildUrl('https://x/p?api-version=1&sig=s', { a: '1' }), 'https://x/p?a=1');
  });

  it('encodes keys and values, and leaves the uri alone without queries', () => {
    assert.equal(buildUrl('https://x/p', { b: 'x y&z=1', c: 'äö', d: 'a/b?c#d+e' }), 'https://x/p?b=x%20y%26z%3D1&c=%C3%A4%C3%B6&d=a%2Fb%3Fc%23d%2Be');
    assert.equal(buildUrl('https://x/p?a=1', undefined), 'https://x/p?a=1');
    assert.equal(buildUrl('https://x/p?a=1', {}), 'https://x/p?a=1');
  });
});

describe('shapeResponse', () => {
  const res = (status: number, headers: Array<[string, string]>, body = '') => ({ status, headers, body: bytes(body) });

  it('parses JSON types, including +json and a JSON string', () => {
    assert.deepEqual(shapeResponse(res(200, [['content-type', 'application/json; charset=utf-8']], '[1,2]')).body, [1, 2]);
    assert.deepEqual(shapeResponse(res(200, [['content-type', 'application/problem+json']], '{"title":"x"}')).body, { title: 'x' });
    assert.equal(shapeResponse(res(200, [['content-type', 'application/json']], '"s"')).body, 's');
  });

  it('reads text/* as a string and every other type as binary content (XML too)', () => {
    assert.equal(shapeResponse(res(200, [['content-type', 'text/csv']], 'a,b\r\n1,2')).body, 'a,b\r\n1,2');
    assert.deepEqual(shapeResponse(res(200, [['content-type', 'application/xml']], '<a/>')).body, {
      '$content-type': 'application/xml',
      '$content': Buffer.from('<a/>').toString('base64'),
    });
  });

  it('leaves body out for an empty response and reports Content-Length 0', () => {
    const out = shapeResponse(res(204, []));
    assert.equal('body' in out, false);
    assert.equal(out.headers['Content-Length'], '0');
  });

  it("fails on JSON that does not parse, with Newtonsoft's message", () => {
    assert.throws(
      () => shapeResponse(res(200, [['content-type', 'application/json']], 'not json')),
      (e: any) =>
        e instanceof HttpActionError &&
        e.code === 'BadRequest' &&
        e.message ===
          "Http request failed: the content was not a valid JSON. Error while parsing JSON: 'Unexpected character encountered while parsing value: n. Path '', line 0, position 0.'",
    );
  });

  it('keeps error statuses as outputs (the engine fails the action)', () => {
    const out = shapeResponse(res(404, [['content-type', 'text/plain']], 'nope'));
    assert.equal(out.statusCode, 404);
    assert.equal(out.body, 'nope');
  });
});

describe('shapeHeaders', () => {
  it(".NET's casing for known headers, the server's for others, Cache-Control in .NET's order", () => {
    const h = shapeHeaders(
      [['content-type', 'text/plain'], ['server-timing', 'x'], ['x-ms-request-id', 'r'], ['cache-control', 'no-cache, no-store'], ['content-length', '99']],
      4,
    );
    assert.deepEqual(h, {
      'Content-Type': 'text/plain',
      'Server-Timing': 'x',
      'x-ms-request-id': 'r',
      'Cache-Control': 'no-store, no-cache',
      'Content-Length': '4',
    });
  });
});

describe('transportError', () => {
  it('reports an unresolvable host as the cloud does', () => {
    const err = transportError(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND', hostname: 'h.invalid' }), 'https://h.invalid/x');
    assert.deepEqual(err.cloudError, {
      code: 'UnresolvableHostName',
      message: "The provided host name 'h.invalid' could not be resolved.",
      messageTemplate: "The provided host name '{0}' could not be resolved.",
    });
  });
});

describe('HttpConnector', () => {
  it('sends through its transport and resolves error statuses instead of throwing', async () => {
    let sent: any;
    const conn = new HttpConnector({
      transport: async (req) => {
        sent = req;
        return { status: 500, headers: [['content-type', 'application/json']], body: bytes('{"e":1}') };
      },
    });
    const out = await conn.invoke('request', { method: 'POST', url: 'https://x/a', queries: { q: '1' }, body: { a: 1 } }, { log: () => {} } as any);
    assert.equal(sent.url, 'https://x/a?q=1');
    assert.deepEqual(out, { statusCode: 500, headers: { 'Content-Type': 'application/json', 'Content-Length': '7' }, body: { e: 1 } });
  });
});
