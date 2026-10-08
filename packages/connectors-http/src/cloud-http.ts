/**
 * The HTTP action as the cloud runs it (measured by conformance/flows/http.ff.ts): how the
 * request is built from the action's inputs, and how the response becomes its outputs.
 *
 * Request: `queries` replace the query string of `uri`; a string body is sent as
 * `text/plain; charset=utf-8`, binary content (`{ $content-type, $content }`) as its bytes with
 * its own type, any other body as JSON (`application/json; charset=utf-8`), unless the action
 * sets Content-Type; `cookie` becomes the Cookie header; Basic and Raw authentication become the
 * Authorization header. No Accept header is added.
 *
 * Response: `{ statusCode, headers, body }`. JSON types (`application/json`, `*+json`) are
 * parsed, `text/*` is a string, any other type is binary content; an empty body leaves `body`
 * out. Header names that .NET knows are written its way (`Content-Type`), others as received.
 */

/** One request, ready for a transport. */
export interface HttpTransportRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

/** What a transport hands back: the status, the headers in wire order, the raw body bytes. */
export interface HttpTransportResponse {
  status: number;
  headers: Array<[string, string]>;
  body: Uint8Array;
}

/**
 * Sends one request without following redirects. Throws for failures that never produced a
 * response; a DNS failure should carry `code: 'ENOTFOUND'` and `hostname` (as Node's do).
 */
export type HttpTransport = (req: HttpTransportRequest) => Promise<HttpTransportResponse>;

/** The outputs of an HTTP action that got a response. */
export interface HttpOutputs {
  statusCode: number;
  headers: Record<string, string>;
  body?: unknown;
}

/** A failure the cloud reports with its own code and error record (no outputs). */
export class HttpActionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly messageTemplate: string,
  ) {
    super(message);
    this.name = 'HttpActionError';
  }

  get cloudError() {
    return { code: this.code, message: this.message, messageTemplate: this.messageTemplate };
  }
}

const encoder = new TextEncoder();

function isBinaryContent(v: unknown): v is { '$content-type'?: string; $content: string } {
  return !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as any).$content === 'string';
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function headerString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

/** `uri` with its query string replaced by `queries` (the cloud drops the original one). */
export function buildUrl(uri: string, queries: unknown): string {
  if (!queries || typeof queries !== 'object' || Object.keys(queries).length === 0) return uri;
  const hash = uri.indexOf('#');
  const fragment = hash >= 0 ? uri.slice(hash) : '';
  const base = (hash >= 0 ? uri.slice(0, hash) : uri).split('?')[0];
  const query = Object.entries(queries as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(headerString(v))}`)
    .join('&');
  return `${base}?${query}${fragment}`;
}

function base64Utf8(text: string): string {
  return bytesToBase64(encoder.encode(text));
}

/** The Authorization header for the action's `authentication`, or an error for kinds that need the cloud. */
function authorizationHeader(auth: any): string | undefined {
  if (!auth || typeof auth !== 'object') return undefined;
  const type = String(auth.type ?? '').toLowerCase();
  if (type === 'basic') return `Basic ${base64Utf8(`${auth.username ?? ''}:${auth.password ?? ''}`)}`;
  if (type === 'raw') return headerString(auth.value);
  if (type === 'none' || type === '') return undefined;
  throw new HttpActionError(
    'AuthenticationNotSupportedLocally',
    `Authentication type '${auth.type}' is not supported in local runs. Use Raw authentication or an Authorization header with a token instead.`,
    "Authentication type '{0}' is not supported in local runs. Use Raw authentication or an Authorization header with a token instead.",
  );
}

/** The request the cloud sends for an HTTP action's (evaluated) inputs. */
export function buildHttpRequest(inputs: any): HttpTransportRequest {
  const method = String(inputs.method || 'GET').toUpperCase();
  const uri = inputs.uri ?? inputs.url;
  if (!uri) throw new Error('HTTP action: uri missing');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(inputs.headers ?? {})) headers[k] = headerString(v);
  if (inputs.cookie !== undefined && inputs.cookie !== null && findHeader(headers, 'Cookie') === undefined) {
    headers.Cookie = headerString(inputs.cookie);
  }
  const authorization = authorizationHeader(inputs.authentication);
  if (authorization !== undefined) headers.Authorization = authorization;

  let body: Uint8Array | undefined;
  let defaultType: string | undefined;
  const value = inputs.body;
  if (value === undefined || value === null) {
    body = undefined;
  } else if (isBinaryContent(value)) {
    body = base64ToBytes(value.$content);
    defaultType = value['$content-type'];
  } else if (value instanceof Uint8Array) {
    body = value;
  } else if (typeof value === 'string') {
    body = encoder.encode(value);
    defaultType = 'text/plain; charset=utf-8';
  } else {
    body = encoder.encode(JSON.stringify(value));
    defaultType = 'application/json; charset=utf-8';
  }
  if (defaultType && findHeader(headers, 'Content-Type') === undefined) headers['Content-Type'] = defaultType;
  return { method, url: buildUrl(String(uri), inputs.queries), headers, body };
}

/** .NET's known header names: the cloud writes these its way whatever casing the server used. */
const KNOWN_HEADERS = [
  'Accept', 'Accept-Charset', 'Accept-Encoding', 'Accept-Language', 'Accept-Patch', 'Accept-Ranges',
  'Access-Control-Allow-Credentials', 'Access-Control-Allow-Headers', 'Access-Control-Allow-Methods',
  'Access-Control-Allow-Origin', 'Access-Control-Expose-Headers', 'Access-Control-Max-Age', 'Age', 'Allow',
  'Alt-Svc', 'Alt-Used', 'Authorization', 'Cache-Control', 'Connection', 'Content-Disposition',
  'Content-Encoding', 'Content-Language', 'Content-Length', 'Content-Location', 'Content-MD5',
  'Content-Range', 'Content-Security-Policy', 'Content-Type', 'Cookie', 'Cookie2', 'Date', 'ETag', 'Expect',
  'Expect-CT', 'Expires', 'From', 'Host', 'If-Match', 'If-Modified-Since', 'If-None-Match', 'If-Range',
  'If-Unmodified-Since', 'Keep-Alive', 'Last-Modified', 'Link', 'Location', 'Max-Forwards', 'Origin', 'P3P',
  'Pragma', 'Proxy-Authenticate', 'Proxy-Authorization', 'Proxy-Connection', 'Proxy-Support',
  'Public-Key-Pins', 'Range', 'Referer', 'Referrer-Policy', 'Refresh', 'Retry-After', 'Sec-WebSocket-Accept',
  'Sec-WebSocket-Extensions', 'Sec-WebSocket-Key', 'Sec-WebSocket-Protocol', 'Sec-WebSocket-Version',
  'Server', 'Server-Timing', 'Set-Cookie', 'Set-Cookie2', 'Strict-Transport-Security', 'TE', 'TSV', 'Trailer',
  'Transfer-Encoding', 'Upgrade', 'Upgrade-Insecure-Requests', 'User-Agent', 'Vary', 'Via',
  'WWW-Authenticate', 'Warning', 'X-AspNet-Version', 'X-Cache', 'X-Content-Duration',
  'X-Content-Type-Options', 'X-Frame-Options', 'X-MSEdge-Ref', 'X-Powered-By', 'X-Request-ID',
  'X-UA-Compatible', 'X-XSS-Protection',
];
const KNOWN_BY_LOWER = new Map(KNOWN_HEADERS.map(h => [h.toLowerCase(), h]));

/** The order .NET's CacheControlHeaderValue writes its directives in. */
const CACHE_CONTROL_ORDER = [
  'no-store', 'no-transform', 'only-if-cached', 'public', 'must-revalidate', 'proxy-revalidate',
  'no-cache', 'max-age', 's-maxage', 'max-stale', 'min-fresh', 'private',
];

/** Cache-Control as .NET parses and writes it back ('no-cache, no-store' → 'no-store, no-cache'). */
function normalizeCacheControl(value: string): string {
  const directives = value.split(',').map(d => d.trim()).filter(Boolean);
  const rank = (d: string) => {
    const i = CACHE_CONTROL_ORDER.indexOf(d.split('=')[0].trim().toLowerCase());
    return i < 0 ? CACHE_CONTROL_ORDER.length : i;
  };
  return directives
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i)
    .map(x => x.d)
    .join(', ');
}

/**
 * Response headers as the cloud records them: repeated headers joined with ',', Cache-Control
 * rewritten in .NET's order, and Content-Length the length of the body as read (.NET reports
 * it for every response, also a chunked one or a 204).
 */
export function shapeHeaders(raw: Array<[string, string]>, bodyLength?: number): Record<string, string> {
  const out: Record<string, string> = {};
  const byLower = new Map<string, string>();
  for (const [name, value] of raw) {
    const lower = name.toLowerCase();
    if (lower === 'content-length' && bodyLength !== undefined) continue;
    const key = byLower.get(lower) ?? KNOWN_BY_LOWER.get(lower) ?? name;
    byLower.set(lower, key);
    out[key] = key in out ? `${out[key]},${value}` : value;
  }
  if (out['Cache-Control'] !== undefined) out['Cache-Control'] = normalizeCacheControl(out['Cache-Control']);
  if (bodyLength !== undefined) out['Content-Length'] = String(bodyLength);
  return out;
}

function mediaType(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

function charsetOf(contentType: string | undefined): string {
  const m = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '');
  return m ? m[1].trim() : 'utf-8';
}

function decodeText(bytes: Uint8Array, contentType: string | undefined): string {
  let text: string;
  try {
    text = new TextDecoder(charsetOf(contentType)).decode(bytes);
  } catch {
    text = new TextDecoder('utf-8').decode(bytes);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const JSON_ERROR_TEMPLATE = "Http request failed: the content was not a valid JSON. Error while parsing JSON: '{0}'";

/** Newtonsoft's message for JSON that fails at its first character, the usual case (HTML, plain text). */
function jsonParseMessage(text: string, err: unknown): string {
  const first = text.trimStart()[0];
  if (first !== undefined && !'{["-0123456789tfn'.includes(first)) {
    return `Unexpected character encountered while parsing value: ${first}. Path '', line 0, position 0.`;
  }
  if (first === 'n' && !/^\s*null\s*$/.test(text)) {
    return `Unexpected character encountered while parsing value: n. Path '', line 0, position 0.`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** The action's outputs for a response; throws HttpActionError when a JSON body does not parse. */
export function shapeResponse(res: HttpTransportResponse): HttpOutputs {
  const headers = shapeHeaders(res.headers, res.body.length);
  const outputs: HttpOutputs = { statusCode: res.status, headers };
  if (res.body.length === 0) return outputs;
  const contentType = findHeader(headers, 'Content-Type');
  const type = mediaType(contentType);
  if (type === 'application/json' || type.endsWith('+json')) {
    const text = decodeText(res.body, contentType);
    try {
      outputs.body = JSON.parse(text);
    } catch (err) {
      const detail = jsonParseMessage(text, err);
      throw new HttpActionError('BadRequest', JSON_ERROR_TEMPLATE.replace('{0}', detail), JSON_ERROR_TEMPLATE);
    }
  } else if (type.startsWith('text/') || type === '') {
    outputs.body = decodeText(res.body, contentType);
  } else {
    outputs.body = { '$content-type': contentType, '$content': bytesToBase64(res.body) };
  }
  return outputs;
}

/** The cloud's error for a request that got no response (DNS failure, refused connection, ...). */
export function transportError(err: any, url: string): HttpActionError {
  const cause = err?.cause ?? err;
  const code = cause?.code ?? err?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    let host = cause?.hostname;
    try {
      host ??= new URL(url).hostname;
    } catch {
      /* keep undefined */
    }
    const template = "The provided host name '{0}' could not be resolved.";
    return new HttpActionError('UnresolvableHostName', template.replace('{0}', String(host)), template);
  }
  const message = `Http request failed: ${cause?.message ?? err?.message ?? String(err)}`;
  return new HttpActionError('BadRequest', message, message);
}

/** The default transport: fetch (browsers, and Node when no raw transport is given). */
export const fetchTransport: HttpTransport = async (req) => {
  const noBody = req.method === 'GET' || req.method === 'HEAD';
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: noBody ? undefined : (req.body as any),
    redirect: 'manual',
  });
  const headers: Array<[string, string]> = [];
  res.headers.forEach((v, k) => headers.push([k, v]));
  return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
};
