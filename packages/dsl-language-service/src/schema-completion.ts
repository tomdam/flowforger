/**
 * Schema-aware completion contracts and string-position detection for
 * connector calls (Dataverse tables/columns, SharePoint sites/lists/fields).
 *
 * Environment-agnostic by design: the SchemaProvider interface carries no
 * fetching — hosts (web app, VS Code extension) inject implementations.
 * Detection is scanner-based like the rest of this package (works on
 * incomplete code, which is exactly when completions fire).
 */

export interface TableSuggestion {
  /** Logical name (Dataverse) or list GUID (SharePoint) — what gets inserted. */
  name: string;
  displayName?: string;
  description?: string;
}

export interface ColumnSuggestion {
  /** Attribute logical name (Dataverse) or field internal name (SharePoint). */
  name: string;
  displayName?: string;
  type?: string;
  required?: boolean;
  /** SharePoint ReadOnlyField — readable (SELECT/$select) but never writable (item:/DML). */
  readOnly?: boolean;
}

export type TableRef =
  | { connector: 'dataverse'; entityName: string }
  | { connector: 'sharepoint'; siteUrl: string; list: string };

export interface SchemaProvider {
  listTables(): Promise<TableSuggestion[]>;
  listColumns(ref: TableRef): Promise<ColumnSuggestion[]>;
}

/** How a sibling param value was expressed in the source. */
export type SchemaValueRef =
  | { kind: 'literal'; value: string }
  | { kind: 'parameter'; name: string };

export type SchemaCompletionType =
  | 'dataverse-entity'
  | 'dataverse-column'
  | 'sharepoint-site'
  | 'sharepoint-list'
  | 'sharepoint-column';

export interface SchemaCompletionContext {
  type: SchemaCompletionType;
  /**
   * 'value': whole string value (entityName/dataset/table).
   * 'odataToken': comma/space-separated token inside $select/$orderby/$filter.
   * 'objectKey': key position inside item: { ... }.
   */
  position: 'value' | 'objectKey' | 'odataToken';
  /** Sibling entityName (dataverse column contexts). undefined = unresolvable. */
  entityName?: SchemaValueRef;
  /** Sibling dataset (sharepoint list/column contexts). */
  siteUrl?: SchemaValueRef;
  /** Sibling table (sharepoint column contexts). */
  list?: SchemaValueRef;
}

const CALL_RE = /ctx\.connectors\.(dataverse|sharepoint)\.(\w+)\s*\(/g;
const ODATA_COLUMN_KEYS = new Set(['$select', '$orderby', '$filter']);

interface EnclosingCall {
  connector: 'dataverse' | 'sharepoint';
  /** Offset of the call's opening paren. */
  openParen: number;
  /** Offset just past the call's closing paren, or text.length if unclosed. */
  end: number;
}

/**
 * Find the innermost ctx.connectors.<connector>.<Op>( call whose parens are
 * still open at `cursor`. Returns null when the cursor is not inside one.
 */
function findEnclosingCall(text: string, cursor: number): EnclosingCall | null {
  CALL_RE.lastIndex = 0;
  let found: EnclosingCall | null = null;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(text)) !== null) {
    const openParen = m.index + m[0].length - 1;
    if (openParen >= cursor) break;
    const end = findCallEnd(text, openParen);
    if (end === -1 || end > cursor) {
      found = {
        connector: m[1] as 'dataverse' | 'sharepoint',
        openParen,
        end: end === -1 ? text.length : end,
      };
    }
  }
  return found;
}

/** Offset just past the matching ')' of the paren at `openParen`, or -1 if unclosed. */
function findCallEnd(text: string, openParen: number): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = openParen; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Is `offset` inside a string literal, scanning from `from`? Returns the quote char or null. */
function stringStateAt(text: string, from: number, offset: number): string | null {
  let inString: string | null = null;
  for (let i = from; i < offset; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') inString = ch;
  }
  return inString;
}

/**
 * Extract a named sibling param from the call's full text (both sides of the
 * cursor). Matches string literals and ctx.parameters('X') references only.
 */
function extractSibling(callText: string, key: string): SchemaValueRef | undefined {
  const escaped = key.replace(/\$/g, '\\$');
  const re = new RegExp(
    `[{,]\\s*(?:'${escaped}'|"${escaped}"|${escaped})\\s*:\\s*` +
      `(?:'([^']*)'|"([^"]*)"|ctx\\.parameters(?:<[^>]+>)?\\(\\s*['"]([^'"]+)['"]\\s*\\))`
  );
  const m = re.exec(callText);
  if (!m) return undefined;
  if (m[1] !== undefined) return { kind: 'literal', value: m[1] };
  if (m[2] !== undefined) return { kind: 'literal', value: m[2] };
  return { kind: 'parameter', name: m[3] };
}

/**
 * Detect whether `cursor` sits at a top-level key position inside the call's
 * `item: { ... }` object. "Top-level" = brace depth exactly 1 relative to the
 * item object's opening brace.
 */
function isItemKeyPosition(callText: string, cursorInCall: number): boolean {
  const itemMatch = /[{,]\s*item\s*:\s*\{/.exec(callText.slice(0, cursorInCall));
  if (!itemMatch) return false;
  const itemBrace = itemMatch.index + itemMatch[0].length - 1;
  let depth = 0;
  let inString: string | null = null;
  for (let i = itemBrace; i < cursorInCall; i++) {
    const ch = callText[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  if (depth !== 1 || inString) return false;
  // Key position: after { or , (a partial identifier being typed is fine).
  const tail = callText.slice(itemBrace + 1, cursorInCall);
  return /(?:^|[,{])\s*[\w$]*$/.test(tail);
}

export function analyzeSchemaCompletionContext(
  statementText: string,
  cursorOffset: number
): SchemaCompletionContext | null {
  const call = findEnclosingCall(statementText, cursorOffset);
  if (!call) return null;

  const callText = statementText.slice(call.openParen, call.end);
  const cursorInCall = cursorOffset - call.openParen;
  const beforeInCall = callText.slice(0, cursorInCall);

  const siblings = {
    entityName: extractSibling(callText, 'entityName'),
    siteUrl: extractSibling(callText, 'dataset'),
    list: extractSibling(callText, 'table'),
  };

  const inString = stringStateAt(statementText, call.openParen, cursorOffset);
  if (inString === "'" || inString === '"') {
    // Which property does this string belong to?
    const keyMatch = /(?:'([\w$]+)'|"([\w$]+)"|([\w$]+))\s*:\s*['"][^'"]*$/.exec(beforeInCall);
    if (!keyMatch) return null; // e.g. the action-name first argument
    const key = keyMatch[1] ?? keyMatch[2] ?? keyMatch[3];

    if (call.connector === 'dataverse') {
      if (key === 'entityName') return { type: 'dataverse-entity', position: 'value' };
      if (ODATA_COLUMN_KEYS.has(key)) {
        return { type: 'dataverse-column', position: 'odataToken', entityName: siblings.entityName };
      }
      return null;
    }
    // sharepoint
    if (key === 'dataset') return { type: 'sharepoint-site', position: 'value' };
    if (key === 'table') return { type: 'sharepoint-list', position: 'value', siteUrl: siblings.siteUrl };
    if (ODATA_COLUMN_KEYS.has(key)) {
      return {
        type: 'sharepoint-column',
        position: 'odataToken',
        siteUrl: siblings.siteUrl,
        list: siblings.list,
      };
    }
    return null;
  }
  if (inString === '`') return null; // template literals: out of scope

  if (isItemKeyPosition(callText, cursorInCall)) {
    if (call.connector === 'dataverse') {
      return { type: 'dataverse-column', position: 'objectKey', entityName: siblings.entityName };
    }
    return {
      type: 'sharepoint-column',
      position: 'objectKey',
      siteUrl: siblings.siteUrl,
      list: siblings.list,
    };
  }

  return null;
}
