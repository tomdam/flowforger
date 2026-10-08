import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { gunzipSync, inflateSync, inflateRawSync, brotliDecompressSync } from 'node:zlib';
import type { HttpTransport } from '@flowforger/connectors-http';

/** Sent when the action sets no User-Agent; the cloud sends `azure-logic-apps/1.0 (workflow …) microsoft-flow/1.0`. */
const USER_AGENT = 'flowforger/1.0 (local run)';

function decompress(body: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return gunzipSync(body);
    case 'deflate':
      try {
        return inflateSync(body);
      } catch {
        return inflateRawSync(body);
      }
    case 'br':
      return brotliDecompressSync(body);
    default:
      return body;
  }
}

/**
 * The HTTP action's transport under Node, which sends the request as the cloud does: no Accept
 * header unless the action sets one (fetch always adds `Accept: *\/*`), `Accept-Encoding:
 * gzip,deflate` (the body is decompressed, as .NET does), redirects not followed, and the
 * response header names as the server wrote them.
 */
export const nodeHttpTransport: HttpTransport = (req) =>
  new Promise((resolve, reject) => {
    const url = new URL(req.url);
    const send = url.protocol === 'http:' ? httpRequest : httpsRequest;
    const headers: Record<string, string> = { ...req.headers };
    const has = (name: string) => Object.keys(headers).some(k => k.toLowerCase() === name);
    if (!has('accept-encoding')) headers['Accept-Encoding'] = 'gzip,deflate';
    if (!has('user-agent')) headers['User-Agent'] = USER_AGENT;
    if (req.body && !has('content-length')) headers['Content-Length'] = String(req.body.length);
    const r = send(url, { method: req.method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        try {
          const raw = res.rawHeaders;
          const pairs: Array<[string, string]> = [];
          for (let i = 0; i < raw.length; i += 2) pairs.push([raw[i], raw[i + 1]]);
          const body = decompress(Buffer.concat(chunks), res.headers['content-encoding']);
          resolve({ status: res.statusCode ?? 0, headers: pairs, body: new Uint8Array(body) });
        } catch (err) {
          reject(err);
        }
      });
    });
    r.on('error', reject);
    if (req.body) r.write(req.body);
    r.end();
  });
