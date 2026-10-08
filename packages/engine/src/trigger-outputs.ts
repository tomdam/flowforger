import type { FlowIR } from '@flowforger/ir';
import { LOCAL_RUN_NAME } from './action-status.js';

/**
 * The trigger of a run, as the cloud reports it through trigger() (conformance/flows/trigger.ff.ts).
 * Its outputs are the run's trigger data (RunContext.triggerData).
 */
export interface TriggerRunInfo {
  name: string;
  inputs?: unknown;
  startTime: string;
  trackingId: string;
  /** The Request trigger's kind as the cloud writes it ('Button', 'Http', ...), for a manual/HTTP trigger. */
  kind?: string;
}

/** Keys of a trigger's outputs object. A payload with only these keys is already in that shape. */
const OUTPUT_KEYS = new Set(['headers', 'body', 'queries', 'statusCode', 'relativePathParameters']);

/**
 * The trigger's outputs for a payload a host passes in (`--in`, a child-flow call, the debugger):
 * `{ headers, body }`, as in the cloud, where triggerOutputs() has both and triggerBody() is the
 * body. A payload that is already an outputs object (a `body` plus only headers/queries/...) is
 * kept, with headers added when missing. No payload means no trigger data.
 */
export function toTriggerOutputs(payload: unknown): unknown {
  if (payload === undefined || payload === null) return payload;
  if (
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    'body' in payload &&
    Object.keys(payload).every((k) => OUTPUT_KEYS.has(k))
  ) {
    const p = payload as Record<string, unknown>;
    return p.headers === undefined ? { headers: jsonHeaders(), ...p } : p;
  }
  return { headers: jsonHeaders(), body: payload };
}

/**
 * The trigger's outputs for a raw HTTP request, as the cloud's Request trigger stores it
 * (conformance/flows/formdata-*.ff.ts): JSON is parsed; a form post becomes binary content with
 * its fields in `$formdata: [{ key, value }]`; multipart data becomes binary content with its
 * parts in `$multipart: [{ headers, body }]` — a text/* part's body as a string, any other part
 * as binary content — and other text as a string, anything else as binary content.
 */
export function requestTriggerOutputs(contentType: string, bytes: Uint8Array): { headers: Record<string, string>; body: unknown } {
  return { headers: { 'Content-Type': contentType }, body: requestBody(contentType, bytes) };
}

function requestBody(contentType: string, bytes: Uint8Array): unknown {
  const type = contentType.split(';')[0].trim().toLowerCase();
  const text = () => new TextDecoder('utf-8').decode(bytes);
  if (type === 'application/json' || type.endsWith('+json')) {
    try {
      return JSON.parse(text());
    } catch {
      return text();
    }
  }
  const content = { '$content-type': contentType, '$content': bytesToBase64(bytes) };
  if (type === 'application/x-www-form-urlencoded') return { ...content, '$formdata': parseFormUrlEncoded(text()) };
  if (type.startsWith('multipart/')) return { ...content, '$multipart': parseMultipart(contentType, bytes) };
  if (type.startsWith('text/')) return text();
  return content;
}

const decodeFormComponent = (s: string) => decodeURIComponent(s.replace(/\+/g, ' '));

function parseFormUrlEncoded(text: string): Array<{ key: string; value: string }> {
  return text
    .split('&')
    .filter((pair) => pair !== '')
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq < 0
        ? { key: decodeFormComponent(pair), value: '' }
        : { key: decodeFormComponent(pair.slice(0, eq)), value: decodeFormComponent(pair.slice(eq + 1)) };
    });
}

/** The parts of a multipart body, each with its headers (plus Content-Length) and body. */
export function parseMultipart(contentType: string, bytes: Uint8Array): Array<{ headers: Record<string, string>; body: unknown }> {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!boundary) return [];
  const delimiter = new TextEncoder().encode(`--${boundary[1] ?? boundary[2]}`);
  const parts: Array<{ headers: Record<string, string>; body: unknown }> = [];
  let at = indexOf(bytes, delimiter, 0);
  while (at >= 0) {
    let start = at + delimiter.length;
    if (bytes[start] === 0x2d && bytes[start + 1] === 0x2d) break; // closing "--boundary--"
    if (bytes[start] === 0x0d && bytes[start + 1] === 0x0a) start += 2;
    const next = indexOf(bytes, delimiter, start);
    if (next < 0) break;
    let end = next;
    if (bytes[end - 2] === 0x0d && bytes[end - 1] === 0x0a) end -= 2;
    parts.push(multipartPart(bytes.subarray(start, end)));
    at = next;
  }
  return parts;
}

function multipartPart(part: Uint8Array): { headers: Record<string, string>; body: unknown } {
  const split = indexOf(part, CRLF_CRLF, 0);
  const head = split < 0 ? '' : new TextDecoder('utf-8').decode(part.subarray(0, split));
  const body = split < 0 ? part : part.subarray(split + CRLF_CRLF.length);
  const headers: Record<string, string> = {};
  for (const line of head.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  headers['Content-Length'] = String(body.length);
  const type = headers['Content-Type'];
  return {
    headers,
    body: type?.toLowerCase().startsWith('text/')
      ? new TextDecoder('utf-8').decode(body)
      : { '$content-type': type ?? 'application/octet-stream', '$content': bytesToBase64(body) },
  };
}

const CRLF_CRLF = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A JSON request's headers. The cloud adds gateway headers too, which a local run has no use for. */
function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' };
}

/** The flow's trigger for trigger(): its name and inputs (the Request schema, ...). */
export function triggerRunInfo(flow: FlowIR, now: Date): TriggerRunInfo | undefined {
  const node = flow.nodes.find((n) => n.type === 'trigger' || n.type === 'recurrence') as
    | { name: string; kind?: string; inputs?: { triggerKind?: string } }
    | undefined;
  if (!node) return undefined;
  // The emitter writes a manual trigger as kind Button and an HTTP trigger as kind Http, unless the IR names one.
  const kind =
    node.kind === 'manual' ? node.inputs?.triggerKind ?? 'Button' : node.kind === 'http' ? node.inputs?.triggerKind ?? 'Http' : undefined;
  return {
    name: node.name,
    inputs: node.inputs,
    startTime: now.toISOString(),
    trackingId: crypto.randomUUID(),
    ...(kind ? { kind } : {}),
  };
}

/**
 * trigger(): the trigger's run record, `{ name, inputs, outputs, startTime, endTime, trackingId,
 * clientTrackingId, originHistoryName, status }` as in the cloud.
 */
export function triggerRecord(info: TriggerRunInfo | undefined, outputs: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (info) {
    out.name = info.name;
    if (info.inputs !== undefined) out.inputs = info.inputs;
  }
  if (outputs !== undefined) out.outputs = outputs;
  if (info) {
    out.startTime = info.startTime;
    out.endTime = info.startTime;
    out.trackingId = info.trackingId;
    out.clientTrackingId = LOCAL_RUN_NAME;
    out.originHistoryName = LOCAL_RUN_NAME;
  }
  out.status = 'Succeeded';
  return out;
}
