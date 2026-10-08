/**
 * "Create CSV table" / "Create HTML table" (the Table action), as the cloud writes them
 * (conformance/flows/tables.ff.ts):
 * - automatic columns are every key of every row, in order of first appearance;
 * - cells are written as string() writes them (True/False, null as nothing, objects as JSON);
 * - CSV: CRLF after every line, a field quoted only when it holds `"`, `,`, CR or LF;
 * - HTML: headers and cells encoded like .NET's WebUtility.HtmlEncode;
 * - custom columns always give the header row; automatic columns over no rows give "" (CSV)
 *   or `<table><tbody></tbody></table>` (HTML).
 */
import { isPlainObject, toText, typeName } from './expr/values.js';

/** A Table action's input the cloud rejects (code BadRequest), with its message template. */
export class TableInputError extends Error {
  constructor(message: string, public messageTemplate: string = message) {
    super(message);
    this.name = 'TableInputError';
  }
}

export type TableFormat = 'CSV' | 'HTML';

/**
 * The table text. `columns` are already-evaluated headers with a `cell(item)` per column (the
 * value expression, evaluated with item() bound to the row); without columns the rows' keys are used.
 */
export function createTable(
  format: TableFormat,
  from: unknown,
  columns?: Array<{ header: unknown; cell: (item: unknown) => unknown }>,
): string {
  if (!Array.isArray(from)) {
    throw new TableInputError(
      `The 'from' property value in the 'table' action inputs is of type '${typeName(from)}'. The value must be of type 'Array'.`,
      "The '{0}' property value in the 'table' action inputs is of type '{1}'. The value must be of type '{2}'.",
    );
  }
  let headers: string[];
  let rows: string[][];
  if (columns) {
    headers = columns.map((c) => toText(c.header));
    rows = from.map((item) => columns.map((c) => toText(c.cell(item))));
  } else {
    if (!from.every(isPlainObject)) {
      throw new TableInputError(
        "The property 'columns' must be specified unless the 'from' property value is an array of objects.",
      );
    }
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const row of from as Record<string, unknown>[]) {
      for (const k of Object.keys(row)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
    }
    headers = keys;
    rows = (from as Record<string, unknown>[]).map((row) => keys.map((k) => toText(row[k])));
  }
  return format === 'CSV' ? csv(headers, rows) : html(headers, rows);
}

function csv(headers: string[], rows: string[][]): string {
  if (headers.length === 0) return '';
  return [headers, ...rows].map((line) => line.map(csvField).join(',') + '\r\n').join('');
}

function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function html(headers: string[], rows: string[][]): string {
  if (headers.length === 0) return '<table><tbody></tbody></table>';
  const head = headers.map((h) => `<th>${htmlEncode(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${htmlEncode(c)}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * .NET's WebUtility.HtmlEncode: `<>&"'` as entities, U+00A0..U+00FF and characters outside the
 * BMP as numeric references, everything else (€, line breaks) as is.
 */
export function htmlEncode(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    switch (ch) {
      case '<': out += '&lt;'; break;
      case '>': out += '&gt;'; break;
      case '&': out += '&amp;'; break;
      case '"': out += '&quot;'; break;
      case "'": out += '&#39;'; break;
      default:
        out += (cp >= 0xa0 && cp <= 0xff) || cp > 0xffff ? `&#${cp};` : ch;
    }
  }
  return out;
}
