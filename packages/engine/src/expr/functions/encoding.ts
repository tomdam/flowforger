/**
 * Encoding, URI, binary, and XML functions.
 */

import * as xpathLib from 'xpath';
import { XMLSerializer } from '@xmldom/xmldom';
import { register, eager } from '../evaluator.js';
import { utf8ToBase64, base64ToUtf8, makeBinary, parseXml, serializeXPathResult, parseDataUri } from '../helpers.js';

register('base64', eager(([v]) => utf8ToBase64(String(v ?? ''))));
register(['base64ToString', 'decodeBase64'], eager(([v]) => base64ToUtf8(String(v ?? ''))));

register(['uriComponent', 'encodeUriComponent'], eager(([v]) => encodeURIComponent(String(v ?? ''))));
register(['uriComponentToString', 'decodeUriComponent'], eager(([v]) => decodeURIComponent(String(v ?? ''))));

register('dataUri', eager(([v]) =>
  `data:text/plain;charset=utf-8;base64,${utf8ToBase64(String(v ?? ''))}`));

register('dataUriToString', eager(([v]) => {
  const p = parseDataUri(String(v ?? ''));
  return p.isBase64 ? base64ToUtf8(p.content) : decodeURIComponent(p.content);
}));

register('base64ToBinary', eager(([v]) => makeBinary(String(v ?? ''))));

register('binary', eager(([v]) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return makeBinary(utf8ToBase64(s));
}));

register(['dataUriToBinary', 'decodeDataUri'], eager(([v]) => {
  const p = parseDataUri(String(v ?? ''));
  const b64 = p.isBase64 ? p.content : utf8ToBase64(decodeURIComponent(p.content));
  return makeBinary(b64, p.contentType);
}));

register('uriComponentToBinary', eager(([v]) =>
  makeBinary(utf8ToBase64(decodeURIComponent(String(v ?? ''))))));

register('xml', eager(([v]) => {
  if (typeof v !== 'string') return JSON.stringify(v);
  // Parse & re-serialize so the output is canonical XML (matches PA: xml()
  // returns an XML node, which serializes deterministically). Falls back to
  // the original string if parsing fails so callers can still pipe it on.
  try {
    const doc = parseXml(v);
    return new XMLSerializer().serializeToString(doc);
  } catch {
    return v;
  }
}));

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
  if (Array.isArray(result)) return result.map(serializeXPathResult);
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
