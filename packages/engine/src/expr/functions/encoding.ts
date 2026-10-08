/**
 * Encoding, URI, binary, and XML functions.
 */

import * as xpathLib from 'xpath';
import { XMLSerializer } from '@xmldom/xmldom';
import { register, eager } from '../evaluator.js';
import { ExpressionError, isBinaryContent, isPlainObject, toText, typeName } from '../values.js';
import { utf8ToBase64, base64ToUtf8, makeBinary, parseXml, serializeXPathResult, parseDataUri } from '../helpers.js';

// Binary content in, measured by conformance/flows/binary.ff.ts: base64() and dataUri() encode
// its bytes, json()/xml()/string() read its text, base64ToString() and length() reject it
// (type 'Object').
const USAGE = (fn: string) => ` Please see https://aka.ms/logicexpressions#${fn} for usage details.`;
const invalidParameter = (fn: string, why: string) =>
  new ExpressionError(`The template language function '${fn}' was invoked with a parameter that is not valid. ${why}`);

register('base64', eager(([v]) => (isBinaryContent(v) ? v['$content'] : utf8ToBase64(String(v ?? '')))));
for (const fn of ['base64ToString', 'decodeBase64']) {
  register(fn, eager(([v]) => {
    if (v !== null && v !== undefined && typeof v !== 'string') {
      throw new ExpressionError(
        `The template language function '${fn}' expects its parameter to be a string. The provided value is of type '${typeName(v)}'.${USAGE(fn)}`,
      );
    }
    return base64ToUtf8(String(v ?? ''));
  }));
}

// Several arguments are joined as text first (conformance/flows/expr-errors.ff.ts: 'a b', 1, true, null → a%20b1True).
register(['uriComponent', 'encodeUriComponent'], eager((vals) => encodeURIComponent(vals.map(toText).join(''))));
// Like the cloud, '+' decodes to a space.
register(['uriComponentToString', 'decodeUriComponent'], eager(([v]) =>
  decodeURIComponent(String(v ?? '').replace(/\+/g, ' '))));

register('dataUri', eager(([v]) =>
  isBinaryContent(v)
    ? `data:${v['$content-type']};base64,${v['$content']}`
    : `data:text/plain;charset=utf-8;base64,${utf8ToBase64(String(v ?? ''))}`));

function requireDataUri(fn: string, v: unknown): ReturnType<typeof parseDataUri> {
  const s = String(v ?? '');
  if (!/^data:[^,]*,/i.test(s)) {
    throw new ExpressionError(
      `The template language function '${fn}' expects its parameter to be formatted as a valid data URI. The provided value '${s}' was not formatted correctly.${USAGE(fn)}`,
    );
  }
  return parseDataUri(s);
}

const dataUriText = (p: ReturnType<typeof parseDataUri>) =>
  p.isBase64 ? base64ToUtf8(p.content) : decodeURIComponent(p.content);

register('dataUriToString', eager(([v]) => dataUriText(requireDataUri('dataUriToString', v))));

// decodeDataUri reads the URI as content of its media type, charset us-ascii unless it names one:
// text comes back as a string, JSON parsed, anything else as binary content of that type.
register('decodeDataUri', eager(([v]) => {
  const p = requireDataUri('decodeDataUri', v);
  const type = p.contentType.split(';')[0].trim().toLowerCase();
  if (type.startsWith('text/')) return dataUriText(p);
  if (type === 'application/json' || type.endsWith('+json')) {
    const text = dataUriText(p);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  const contentType = /;\s*charset=/i.test(p.contentType) ? p.contentType : `${p.contentType};charset=us-ascii`;
  return makeBinary(p.isBase64 ? p.content : utf8ToBase64(decodeURIComponent(p.content)), contentType);
}));

/** What Convert.FromBase64String accepts: whitespace ignored, whole 4-character groups, at most two '='. */
const isBase64 = (s: string) => /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0;

register('base64ToBinary', eager(([v]) => {
  const s = String(v ?? '').replace(/\s+/g, '');
  if (!isBase64(s)) throw invalidParameter('base64ToBinary', 'The value cannot be decoded from base64 representation.');
  return makeBinary(s);
}));

register('binary', eager(([v]) => {
  if (v === null || v === undefined) throw invalidParameter('binary', 'The value cannot be converted to the target type.');
  return makeBinary(utf8ToBase64(toText(v)));
}));

register('dataUriToBinary', eager(([v]) => {
  const p = requireDataUri('dataUriToBinary', v);
  const b64 = p.isBase64 ? p.content : utf8ToBase64(decodeURIComponent(p.content));
  return makeBinary(b64, p.contentType);
}));

register('uriComponentToBinary', eager(([v]) =>
  makeBinary(utf8ToBase64(decodeURIComponent(String(v ?? ''))))));

// xml(object) converts JSON to XML the way the cloud does: one root property, '@name' keys
// become attributes, '#text' the element text, arrays repeated elements.
register('xml', eager(([input]) => {
  const v = isBinaryContent(input) ? toText(input) : input;
  if (typeof v !== 'string') return jsonToXml(v);
  // Parse & re-serialize so the output is canonical XML (matches PA: xml()
  // returns an XML node, which serializes deterministically). Falls back to
  // the original string if parsing fails so callers can still pipe it on.
  const doc = parseXml(v);
  if (!doc?.documentElement) {
    throw new ExpressionError(
      "The template language function 'xml' parameter is not valid. The provided value cannot be converted to XML: 'Data at the root level is invalid. Line 1, position 1.'.",
    );
  }
  return new XMLSerializer().serializeToString(doc);
}));

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function jsonToXml(v: unknown): string {
  if (!isPlainObject(v)) throw new ExpressionError("The template language function 'xml' expects an object with a single root property.");
  const roots = Object.keys(v).filter((k) => !k.startsWith('?'));
  if (roots.length !== 1) {
    throw new ExpressionError("The template language function 'xml' expects an object with a single root property.");
  }
  return element(roots[0], v[roots[0]]);
}

function element(name: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => element(name, item)).join('');
  if (value === null || value === undefined) return `<${name} />`;
  if (!isPlainObject(value)) return `<${name}>${escapeXml(xmlText(value))}</${name}>`;
  let attrs = '';
  let body = '';
  for (const [k, child] of Object.entries(value)) {
    if (k.startsWith('@')) attrs += ` ${k.slice(1)}="${escapeXml(xmlText(child))}"`;
    else if (k === '#text') body += escapeXml(xmlText(child));
    else body += element(k, child);
  }
  return body ? `<${name}${attrs}>${body}</${name}>` : `<${name}${attrs} />`;
}

// JSON values inside XML keep their JSON spelling (true, not True).
const xmlText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

register('xpath', eager(([xmlInput, pv]) => {
  const xpathExpr = String(pv);
  if (typeof xmlInput !== 'string' || !xmlInput) return [];
  let doc: Document;
  try {
    doc = parseXml(xmlInput);
  } catch (err) {
    throw new Error(`xpath: failed to parse XML input: ${err instanceof Error ? err.message : String(err)}`);
  }
  let result: any;
  try {
    result = xpathLib.select(xpathExpr, doc as any);
  } catch (err) {
    throw new Error(`xpath: invalid XPath expression '${xpathExpr}': ${err instanceof Error ? err.message : String(err)}`);
  }
  // Node-set queries return an array; numeric/string/boolean queries
  // (count(), string(), sum(), etc.) return primitives directly.
  // Element nodes come back as XML binary content, text/attribute nodes as strings.
  if (Array.isArray(result)) {
    return result.map((node: any) => {
      const value = serializeXPathResult(node);
      return node?.nodeType === 1 ? makeBinary(utf8ToBase64(value), 'application/xml;charset=utf-8') : value;
    });
  }
  return result;
}));

register('uriHost', eager(([v]) => {
  try { return new URL(String(v)).hostname; } catch { return ''; }
}));
register('uriPath', eager(([v]) => {
  try { return new URL(String(v)).pathname; } catch { return ''; }
}));
register('uriPathAndQuery', eager(([v]) => {
  try { const u = new URL(String(v)); return u.pathname + u.search; } catch { return ''; }
}));
register('uriPort', eager(([v]) => {
  try {
    const u = new URL(String(v));
    if (u.port) return Number(u.port);
    const defaults: Record<string, number> = { 'http:': 80, 'https:': 443, 'ftp:': 21, 'ftps:': 990, 'ws:': 80, 'wss:': 443 };
    return defaults[u.protocol] ?? 0;
  } catch { return 0; }
}));
register('uriQuery', eager(([v]) => {
  try { return new URL(String(v)).search; } catch { return ''; }
}));
register('uriScheme', eager(([v]) => {
  try { return new URL(String(v)).protocol.replace(':', ''); } catch { return ''; }
}));
