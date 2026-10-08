/**
 * SharePoint Connector for FlowForger
 *
 * Implements SharePoint REST API operations using SharePoint-specific tokens.
 * Requires a SharePoint access token with resource https://tenant.sharepoint.com
 */

import type { BaseConnector, RunContext } from '@flowforger/engine';
import { extractItemFields, HttpError, buildODataQuery, parseStringList } from '@flowforger/connectors-shared';
import { readZipEntries } from './zip.js';

export interface SharePointConnectorOptions {
  token: string; // SharePoint access token with resource https://tenant.sharepoint.com
}

// SharePoint REST API headers
const SP_HEADERS = {
  Accept: 'application/json;odata=nometadata',
};

// Re-export HttpError for consumers
export { HttpError };

/**
 * Extension → MIME type, mirroring the .NET/IIS MimeMapping table the cloud
 * SharePoint connector uses when "Infer Content Type" is on (hence `text/xml`
 * rather than `application/xml`, and `application/vnd.ms-excel` for .csv).
 * Unknown extensions fall back to application/octet-stream, as in the cloud.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  xml: 'text/xml',
  xsl: 'text/xml',
  xslt: 'text/xml',
  json: 'application/json',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'application/vnd.ms-excel',
  htm: 'text/html',
  html: 'text/html',
  css: 'text/css',
  js: 'application/x-javascript',
  pdf: 'application/pdf',
  rtf: 'application/rtf',
  doc: 'application/msword',
  dot: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  docm: 'application/vnd.ms-word.document.macroEnabled.12',
  dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  msg: 'application/vnd.ms-outlook',
  eml: 'message/rfc822',
  zip: 'application/zip', // measured (sp-folders.ff.ts BlobMetadata), unlike .NET's x-zip-compressed
  gz: 'application/x-gzip',
  '7z': 'application/x-7z-compressed',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
};

/** Content type the cloud connector reports for a file when inferContentType is on. */
export function inferFileContentType(fileName: string | undefined): string {
  const ext = fileName?.split('.').pop()?.toLowerCase();
  return (ext && fileName?.includes('.') && MIME_BY_EXTENSION[ext]) || 'application/octet-stream';
}

/** Base64 envelope Logic Apps uses for non-text bodies (note the cloud key is `$content-type`). */
export type FileContentEnvelope = { '$content-type': string; $content: string };

/** What "Get file content" hands the next action: parsed JSON, plain text, or the base64 envelope. */
export type FileContentResult = string | unknown | FileContentEnvelope;

/**
 * Shape downloaded bytes the way Logic Apps content handling does for the
 * given content type: `application/json` is parsed (falls back to text if it
 * is not valid JSON), `text/*` is the UTF-8 text, and everything else stays
 * the base64 envelope. This is why an .xml file shows up as XML source in a
 * Power Automate run (its inferred type is `text/xml`), while a .pdf shows up
 * as `{ "$content-type": "application/pdf", "$content": "..." }`.
 */
export function toCloudFileContent(base64: string, contentType: string): FileContentResult {
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  const isJson = mediaType === 'application/json';
  if (!isJson && !mediaType.startsWith('text/')) {
    return { '$content-type': contentType, $content: base64 };
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const text = new TextDecoder('utf-8').decode(bytes);
  if (!isJson) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Power Automate cloud operationId → the name this connector implements.
 *
 * Flows authored in the maker portal (and DSL reverse-engineered from their
 * clientdata.json) carry the cloud operationIds, which differ from the friendlier
 * names FlowForger exposes. Both spellings must execute locally so a flow pulled
 * from Dataverse can be debugged without rewriting its action names.
 */
const OPERATION_ALIASES: Record<string, string> = {
  GetFileItems: 'GetFilesPropertiesOnly', // Get files (properties only)
  GetFileItem: 'GetFileProperties', // Get file properties
  PatchFileItem: 'UpdateFileProperties', // Update file properties
  CreateAttachment: 'AddAttachment', // Add attachment
  GetItemAttachments: 'GetAttachments', // Get attachments
  CopyFileAsync: 'CopyFile',
  MoveFileAsync: 'MoveFile',
  CopyFolderAsync: 'CopyFolder',
  MoveFolderAsync: 'MoveFolder',
  UnshareItem: 'StopSharing', // Stop sharing (unshare a link)
  DiscardFileCheckOut: 'DiscardCheckOut', // Discard check out
  ExtractFolderV2: 'ExtractFolder', // Extract folder
};

type LogFunction = (entry: Record<string, unknown>) => void;

/** Cloud connector wrapper for choice/lookup values in item outputs. */
interface SPListExpandedReference {
  '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference';
  Id: number;
  Value: string | null;
}

/** Cloud connector wrapper for person/group values in item outputs. */
interface SPListExpandedUser {
  '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedUser';
  Claims: string | null;
  DisplayName: string | null;
  Email: string | null;
  Picture: string | null;
  Department: string | null;
  JobTitle: string | null;
}

type ExpandableFieldKind = 'choice' | 'lookup' | 'user';

interface ExpandableFieldInfo {
  internalName: string;
  kind: ExpandableFieldKind;
  multi: boolean;
  /** choice fields: the defined choices, for best-effort Id resolution */
  choices: string[];
  /** lookup fields: internal name of the display column on the target list */
  lookupField: string;
  /**
   * Dependent (projected) lookup columns only: internal name of the primary
   * lookup field. Dependent columns (e.g. `Project_x003a_Phase`) are not
   * expandable nav properties themselves — `$expand` on them 400s — so their
   * value is projected through the primary's nav property instead
   * (`$expand=Project&$select=Project/Phase`).
   */
  primaryName?: string;
}

// SharePoint field TypeAsString → cloud-shape expansion kind
const FIELD_KIND_MAP: Record<string, { kind: ExpandableFieldKind; multi: boolean }> = {
  Choice: { kind: 'choice', multi: false },
  MultiChoice: { kind: 'choice', multi: true },
  Lookup: { kind: 'lookup', multi: false },
  LookupMulti: { kind: 'lookup', multi: true },
  User: { kind: 'user', multi: false },
  UserMulti: { kind: 'user', multi: true },
};

/** The cloud names the paging link `@odata.nextLink` (JSON light's is `odata.nextLink`). */
function withCloudNextLink<T extends object>(body: T): T {
  const b = body as Record<string, unknown>;
  if (!('odata.nextLink' in b)) return body;
  const { 'odata.nextLink': next, ...rest } = b;
  return { ...rest, '@odata.nextLink': next } as T;
}

/** Columns a `$select=*` item query leaves out that the cloud's synthetic `{...}` fields and `@odata.etag` derive from. */
const ITEM_SYSTEM_SELECTS = ['FileRef', 'FileLeafRef', 'FileDirRef', 'FSObjType', 'owshiddenversion', 'ContentType/Id', 'ContentType/Name'];

/** Library items only: what `{IsCheckedOut}`, `{DriveId}`, `{DriveItemId}` and a file's `{Link}` derive from. */
const LIBRARY_SYSTEM_SELECTS = ['UniqueId', 'CheckoutUserId', 'OData__DisplayName', 'File/VroomDriveID', 'File/VroomItemID'];

/** Office files, whose cloud `{Link}` opens them in the browser (`?d=w<UniqueId>`); verified for .csv. */
const OFFICE_EXTENSIONS = new Set([
  'doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'xltm', 'csv',
  'ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'ppsm', 'pot', 'potx', 'potm', 'odt', 'ods', 'odp',
]);

/** Raw REST item properties the cloud connector does not return. */
const ITEM_DROP_KEYS = new Set([
  'Id', 'ID', 'FileSystemObjectType', 'ServerRedirectedEmbedUri', 'ServerRedirectedEmbedUrl', 'ContentTypeId',
  'OData__ColorTag', 'ComplianceAssetId', 'GUID', 'Attachments', 'OData__UIVersionString',
  'FileRef', 'FileLeafRef', 'FileDirRef', 'FSObjType', 'owshiddenversion', 'ContentType',
  'UniqueId', 'CheckoutUserId',
]);

const SP_TYPE = '#Microsoft.Azure.Connectors.SharePoint';

/**
 * Fold the designer's slashed field keys into objects: `{ 'Status/Value': 'Open' }` →
 * `{ Status: { Value: 'Open' } }`. The `item/` prefix is already stripped by then.
 */
function nestSlashedKeys(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const slash = key.indexOf('/');
    if (slash < 0) {
      out[key] = value;
      continue;
    }
    const head = key.slice(0, slash);
    const existing = out[head];
    const target = existing && typeof existing === 'object' && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {};
    target[key.slice(slash + 1)] = value;
    out[head] = target;
  }
  return out;
}

/**
 * The cloud connector's file/folder identifier for a site-relative path: each segment with
 * spaces as '+' and percent-encoded (lower-case hex), segments joined by an encoded '%2f'
 * ("Lists/My Items/1_.000" → "Lists%252fMy%2bItems%252f1_.000"). A leading '/' yields a
 * leading '%252f', as in blob metadata ids.
 */
function encodeFileIdentifier(path: string): string {
  return path
    .split('/')
    .map((s) => encodeURIComponent(s.replace(/ /g, '+')).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()))
    .join('%252f');
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes: Uint8Array): string {
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += BASE32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

// Byte helpers use Uint8Array, not Buffer: the connector also runs in the browser.
function base32Decode(text: string): Uint8Array {
  let bits = '';
  for (const ch of text) bits += BASE32.indexOf(ch).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Uint8Array.from(bytes);
}

/** A GUID's 16 bytes in .NET order (first three groups little-endian). */
function dotNetGuidBytes(guid: string): Uint8Array {
  const hex = guid.replace(/[{}-]/g, '');
  const b = Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  return Uint8Array.from([b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], ...b.subarray(8)]);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** UTF-8 → base64 (btoa exists in browsers and Node 16+). */
function utf8Base64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A choice value as the designer sends it (`{ Value }` or plain text) → the text REST expects. */
function choiceText(v: unknown): unknown {
  return v && typeof v === 'object' && 'Value' in v ? (v as { Value: unknown }).Value : v;
}

/** `{ Value: null }`, `{ Id: null }`, `{ Claims: null }`: a designer sub-field whose expression found nothing. */
function isAllNullObject(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const values = Object.values(v);
  return values.length > 0 && values.every((x) => x === null || x === undefined);
}

/** A lookup value as the designer sends it (`{ Id }`, `{ Id: '2' }` or a number) → the numeric id. */
function lookupId(v: unknown): unknown {
  const raw = v && typeof v === 'object' && 'Id' in v ? (v as { Id: unknown }).Id : v;
  return typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
}

// Cross-platform base64 decoder: returns a Uint8Array of the decoded bytes.
// Node uses Buffer (fast); browsers use atob (Buffer does not exist there).
function base64ToUint8(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(base64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export class SharePointConnector implements BaseConnector {
  private token: string;

  constructor(opts: SharePointConnectorOptions) {
    this.token = opts.token;
  }

  // ============= HTTP Helper Methods =============

  private async spRequest<T = unknown>(
    method: string,
    url: string,
    log?: LogFunction,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
      rawBody?: boolean;
      /** Read a successful response as bytes → { $content (base64), $contentType } whatever its content-type header says. */
      binary?: boolean;
    }
  ): Promise<T> {
    log?.({ type: 'sp.request', method, url });

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      ...SP_HEADERS,
      ...options?.headers,
    };

    if (options?.body && !options?.rawBody && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json;odata=nometadata';
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (options?.body !== undefined) {
      fetchOptions.body = options?.rawBody
        ? (options.body as BodyInit)
        : JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);

    // Handle no-content responses (204)
    if (response.status === 204) {
      return { ok: true, status: response.status } as T;
    }

    const contentType = response.headers.get('content-type') || '';
    let data: unknown;

    const readAsBinary = (options?.binary && response.ok)
      || contentType.includes('application/octet-stream')
      || contentType.includes('image/');

    if (readAsBinary) {
      // Return binary content as base64 (browser-compatible, no Node.js Buffer dependency)
      const arrayBuffer = await response.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      data = {
        $content: btoa(binary),
        $contentType: contentType,
      };
    } else if (contentType.includes('application/json')) {
      const text = await response.text();
      data = text ? JSON.parse(text) : null;
    } else {
      data = await response.text();
    }

    if (!response.ok) {
      const errorMsg = typeof data === 'object' && data
        ? JSON.stringify(data)
        : String(data);
      throw new HttpError(`SharePoint ${method} failed: ${response.status} - ${errorMsg}`, response.status, data);
    }

    log?.({ type: 'sp.response', status: response.status });
    return data as T;
  }

  private async spGet<T = unknown>(url: string, log?: LogFunction, headers?: Record<string, string>): Promise<T> {
    return this.spRequest<T>('GET', url, log, { headers });
  }

  private async spPost<T = unknown>(url: string, log?: LogFunction, options?: { body?: unknown; headers?: Record<string, string>; rawBody?: boolean }): Promise<T> {
    return this.spRequest<T>('POST', url, log, options);
  }

  private async spDelete<T = unknown>(url: string, log?: LogFunction): Promise<T> {
    return this.spRequest<T>('DELETE', url, log);
  }

  // ============= Main Invoke =============

  async invoke(rawOperation: string, inputs: unknown, ctx: RunContext): Promise<unknown> {
    // Resolve cloud operationIds to the local name before normalization *and*
    // dispatch, so per-operation input mapping sees the canonical name too.
    const operation = OPERATION_ALIASES[rawOperation] ?? rawOperation;
    ctx.log?.({ type: 'sp.invoke', operation, rawOperation, rawInputs: inputs });

    const normalizedInputs = this.normalizeInputs(operation, inputs as Record<string, unknown>);
    ctx.log?.({ type: 'sp.normalized', normalizedInputs });

    switch (operation) {
      case 'getItems':
      case 'GetItems':
        return this.getItems(normalizedInputs, ctx);
      case 'GetItem':
      case 'GetItemById':
        return this.getItemById(normalizedInputs, ctx);
      case 'PostItem':
      case 'CreateItem':
        return this.createItem(normalizedInputs, ctx);
      case 'PatchItem':
      case 'UpdateItem':
        return this.updateItem(normalizedInputs, ctx);
      case 'DeleteItem':
        return this.deleteItem(normalizedInputs, ctx);
      case 'CreateNewFolder':
        return this.createFolder(normalizedInputs, ctx);
      case 'CreateFile':
        return this.createFile(normalizedInputs, ctx);
      case 'GetFileContent':
        return this.getFileContent(normalizedInputs, ctx);
      case 'GetFileContentByPath':
        return this.getFileContentByPath(normalizedInputs, ctx);
      case 'UpdateFile':
        return this.updateFile(normalizedInputs, ctx);
      case 'DeleteFile':
        return this.deleteFile(normalizedInputs, ctx);
      case 'CopyFile':
        return this.copyFile(normalizedInputs, ctx);
      case 'MoveFile':
        return this.moveFile(normalizedInputs, ctx);
      case 'GetFileMetadata':
        return this.getFileMetadata(normalizedInputs, ctx);
      case 'GetFileMetadataByPath':
        return this.getFileMetadataByPath(normalizedInputs, ctx);
      case 'GetFileProperties':
        return this.getFileProperties(normalizedInputs, ctx);
      case 'UpdateFileProperties':
        return this.updateFileProperties(normalizedInputs, ctx);
      case 'GetFilesPropertiesOnly':
        return this.getFilesPropertiesOnly(normalizedInputs, ctx);
      case 'GetItemChanges':
        return this.getItemChanges(normalizedInputs, ctx);
      case 'AddAttachment':
        return this.addAttachment(normalizedInputs, ctx);
      case 'GetAttachments':
        return this.getAttachments(normalizedInputs, ctx);
      case 'GetAttachmentContent':
        return this.getAttachmentContent(normalizedInputs, ctx);
      case 'DeleteAttachment':
        return this.deleteAttachment(normalizedInputs, ctx);
      case 'CheckOutFile':
        return this.checkOutFile(normalizedInputs, ctx);
      case 'CheckInFile':
        return this.checkInFile(normalizedInputs, ctx);
      case 'DiscardCheckOut':
        return this.discardCheckOut(normalizedInputs, ctx);
      case 'ListFolder':
        return this.listFolder(normalizedInputs, ctx);
      case 'ListRootFolder':
        return this.listRootFolder(normalizedInputs, ctx);
      case 'GetFolderMetadata':
        return this.getFolderMetadata(normalizedInputs, ctx);
      case 'GetFolderMetadataByPath':
        return this.getFolderMetadataByPath(normalizedInputs, ctx);
      case 'CopyFolder':
        return this.copyFolder(normalizedInputs, ctx);
      case 'MoveFolder':
        return this.moveFolder(normalizedInputs, ctx);
      case 'ExtractFolder':
        return this.extractFolder(normalizedInputs, ctx);
      case 'CreateSharingLink':
        return this.createSharingLink(normalizedInputs, ctx);
      case 'GrantAccess':
        return this.grantAccess(normalizedInputs, ctx);
      case 'StopSharing':
        return this.stopSharing(normalizedInputs, ctx);
      case 'SetContentApprovalStatus':
        return this.setContentApprovalStatus(normalizedInputs, ctx);
      case 'GetContentApprovalStatus':
        return this.getContentApprovalStatus(normalizedInputs, ctx);
      case 'GetLists':
      case 'GetAllListsAndLibraries':
      case 'GetAllTables':
        return this.getLists(normalizedInputs, ctx);
      case 'GetListViews':
        return this.getListViews(normalizedInputs, ctx);
      case 'ResolvePerson':
        return this.resolvePerson(normalizedInputs, ctx);
      case 'SendHttpRequest':
      case 'HttpRequest':
        return this.sendHttpRequest(normalizedInputs, ctx);
      default:
        throw new Error(`SharePointConnector: unknown operation '${rawOperation}'`);
    }
  }

  /**
   * A GetItems/GetFileItems continuation page (the engine follows these for a pagination
   * policy). The link repeats the first query's $select/$expand; shaping uses the same refs.
   */
  async nextPage(operation: string, inputs: Record<string, unknown>, nextLink: string, ctx: RunContext): Promise<unknown> {
    const op = OPERATION_ALIASES[operation] ?? operation;
    const normalized = this.normalizeInputs(op, inputs);
    const siteUrl = this.normalizeSiteUrl(normalized.siteUrl);
    const listId = this.normalizeValue(normalized.listId);
    const body = await this.spGet<{ value?: unknown[] }>(nextLink, ctx.log);
    if (Array.isArray(body?.value)) {
      const aug = await this.resolveRefExpansion(siteUrl, listId, normalized.select as string | undefined, normalized.expand as string | undefined, ctx);
      await this.applyCloudShape(siteUrl, listId, body.value, ctx, aug.refNames);
    }
    return withCloudNextLink(body);
  }

  successStatusCode(operation: string): number {
    const op = OPERATION_ALIASES[operation] ?? operation;
    return op === 'PostItem' || op === 'CreateItem' ? 201 : 200;
  }

  /**
   * The cloud reports SharePoint failures as `{ status, message }` rather than the REST
   * `odata.error` object, and rewrites some of them (seen in conformance runs):
   * a missing item → 404 "Item Not Found", a missing list → 404 "List not found",
   * a query naming an unknown column → 400 (REST answers 500). The cloud also appends
   * "\r\nclientRequestId: ...\r\nserviceRequestId: ..." to the message, which has no local equivalent.
   */
  errorOutputs(operation: string, err: unknown): { statusCode: number; body: unknown } | undefined {
    const e = err as { status?: number; message?: string; response?: unknown };
    if (typeof e.status !== 'number') return undefined;
    // Add attachment fails like a passed-through REST call: { status, message, source, errors }.
    const op = OPERATION_ALIASES[operation] ?? operation;
    if (op === 'HttpRequest' || op === 'SendHttpRequest' || op === 'AddAttachment') return httpRequestErrorOutputs(e);
    const odata = (e.response as { 'odata.error'?: { code?: string; message?: { value?: string } } } | undefined)?.['odata.error'];
    let status = e.status;
    let message = odata?.message?.value ?? e.message ?? '';
    if (status === 404 && odata?.code?.startsWith('-2130575338,')) message = 'Item Not Found';
    else if (status === 404 && /^List does not exist\b/.test(message)) message = 'List not found';
    else if (status === 500 && /^Column '.*' does not exist\b/.test(message)) status = 400;
    // Check in / discard of a file that is not checked out: SharePoint's 423 Locked becomes 400.
    else if (status === 423 && (op === 'CheckInFile' || op === 'DiscardCheckOut' || op === 'CheckOutFile')) status = 400;
    else if (status === 404 && op === 'GetAttachmentContent') message = 'File not found';
    return { statusCode: status, body: { status, message } };
  }

  // ============= Input Normalization =============

  private normalizeInputs(operation: string, inputs: Record<string, unknown>): Record<string, unknown> {
    const normalized = { ...inputs };

    // Normalize site/list identifiers
    if (inputs.dataset && !inputs.siteUrl) normalized.siteUrl = inputs.dataset;
    if (inputs.table && !inputs.listId) normalized.listId = inputs.table;

    // For folder creation
    if (operation === 'CreateNewFolder' && inputs['parameters/path']) {
      normalized.folderPath = inputs['parameters/path'];
    }

    // Map 'id' to the appropriate internal name based on operation
    const listItemOps = ['GetItem', 'GetItemById', 'UpdateItem', 'PatchItem', 'DeleteItem',
      'GetFileProperties', 'UpdateFileProperties', 'PatchFileItem',
      'AddAttachment', 'GetAttachments', 'GetAttachmentContent', 'DeleteAttachment',
      'GetItemChanges', 'SetContentApprovalStatus', 'GetContentApprovalStatus',
      // StopSharing (cloud: UnshareItem) addresses the item via GetFileById,
      // but like the other item-addressed ops above, the cloud parameter is
      // 'id' and must land in itemId, not fileId.
      'StopSharing'];
    // The cloud's check in/out operations address the file by its library item (`table` + `id`);
    // without a table, `id` is a file identifier (the local form).
    const checkOps = ['CheckOutFile', 'CheckInFile', 'DiscardCheckOut'];
    if (inputs.id && !inputs.itemId && (listItemOps.includes(operation) || (checkOps.includes(operation) && inputs.table))) {
      normalized.itemId = inputs.id;
    } else if (inputs.id && !inputs.fileId) {
      normalized.fileId = inputs.id;
    }
    if (inputs['parameter/comment'] != null) normalized.comment = inputs['parameter/comment'];
    if (inputs['parameter/checkinType'] != null) normalized.checkInType = inputs['parameter/checkinType'];
    if (operation === 'AddAttachment' && inputs.displayName && !inputs.fileName) normalized.fileName = inputs.displayName;
    if (inputs['parameters/folderPath']) normalized.folderPath = inputs['parameters/folderPath'];
    if (inputs['parameters/name']) normalized.fileName = inputs['parameters/name'];
    if (inputs.name && !inputs.fileName) normalized.fileName = inputs.name;
    if (inputs.body && !inputs.content) normalized.content = inputs.body;

    // Normalize OData query params: $filter → filter, $orderby → orderby, etc.
    if (inputs['$filter'] && !inputs.filter) normalized.filter = inputs['$filter'];
    if (inputs['$orderby'] && !inputs.orderby) normalized.orderby = inputs['$orderby'];
    if (inputs['$top'] && !inputs.top) normalized.top = inputs['$top'];
    if (inputs['$select'] && !inputs.select) normalized.select = inputs['$select'];
    if (inputs['$expand'] && !inputs.expand) normalized.expand = inputs['$expand'];
    if (inputs['$skip'] && !inputs.skip) normalized.skip = inputs['$skip'];

    // For GetFilesPropertiesOnly
    if (operation === 'GetFilesPropertiesOnly') {
      if (inputs['parameters/dataset']) normalized.libraryId = inputs['parameters/dataset'];
      if (inputs['parameters/$filter']) normalized.filter = inputs['parameters/$filter'];
      if (inputs['parameters/$orderby']) normalized.orderby = inputs['parameters/$orderby'];
      if (inputs['parameters/$top']) normalized.top = inputs['parameters/$top'];
      if (inputs['parameters/$skip']) normalized.skip = inputs['parameters/$skip'];
      if (inputs['parameters/folderPath']) normalized.folderPath = inputs['parameters/folderPath'];
      if (inputs['parameters/includeNestedItems'] != null) normalized.includeNestedItems = inputs['parameters/includeNestedItems'];
    }

    // For create/update operations, transform item/* to fields object.
    // UpdateFileProperties is here because the cloud's PatchFileItem carries its
    // column values as item/* keys exactly like PatchItem does.
    // A whole `item` object also counts: the transformer flattens an object literal into
    // item/* keys, but an expression (`item: invoice`, `item: body('X')`) evaluates to a
    // nested object, which would otherwise be dropped and create/patch an empty item.
    if (['PostItem', 'CreateItem', 'PatchItem', 'UpdateItem', 'UpdateFileProperties'].includes(operation)) {
      const existingFields = (inputs.fields || {}) as Record<string, unknown>;
      const nestedItem =
        inputs.item && typeof inputs.item === 'object' && !Array.isArray(inputs.item)
          ? (inputs.item as Record<string, unknown>)
          : {};
      const itemFields = extractItemFields(inputs);
      normalized.fields = { ...existingFields, ...nestedItem, ...itemFields };
    }

    // For SendHttpRequest
    if (operation === 'SendHttpRequest' || operation === 'HttpRequest') {
      if (inputs['parameters/method']) normalized.method = inputs['parameters/method'];
      if (inputs['parameters/uri']) normalized.uri = inputs['parameters/uri'];
      if (inputs['parameters/headers']) normalized.headers = inputs['parameters/headers'];
      if (inputs['parameters/body']) normalized.body = inputs['parameters/body'];
    }

    // For CopyFile / MoveFile / CopyFolder / MoveFolder
    if (['CopyFile', 'MoveFile', 'CopyFolder', 'MoveFolder'].includes(operation)) {
      if (inputs['parameters/sourceFileId']) normalized.fileId = inputs['parameters/sourceFileId'];
      if (inputs['parameters/sourceFolderId']) normalized.folderId = inputs['parameters/sourceFolderId'];
      if (inputs['parameters/destinationDataset']) normalized.destSiteUrl = inputs['parameters/destinationDataset'];
      if (inputs['parameters/destinationFolderPath']) normalized.destFolderPath = inputs['parameters/destinationFolderPath'];
      if (inputs['parameters/nameConflictBehavior'] != null) normalized.nameConflictBehavior = inputs['parameters/nameConflictBehavior'];
    }

    return normalized;
  }

  /**
   * Resolve file content that may be base64-encoded from another connector
   * (e.g., OneDrive ConvertFile returns a base64 string, Word Online returns
   * { content: "<base64>" } or { $content: "<base64>" }).
   * Returns a Uint8Array for binary upload, or the original value if it's
   * already a string or binary buffer. Node's Buffer is a subclass of
   * Uint8Array, so the instanceof check below also covers Buffer inputs.
   */
  private resolveFileContent(body: unknown): unknown {
    if (body == null) return body;
    if (typeof body === 'string') {
      // Likely a base64 string from another connector — decode to bytes
      if (/^[A-Za-z0-9+/=]+$/.test(body) && body.length > 100) {
        return base64ToUint8(body);
      }
      return body;
    }
    if (body instanceof Uint8Array) return body;
    if (typeof body === 'object') {
      const obj = body as Record<string, unknown>;
      const b64 = obj['$content'] || obj['content'];
      if (typeof b64 === 'string') {
        return base64ToUint8(b64);
      }
    }
    return body;
  }

  private normalizeSiteUrl(siteUrl: unknown): string {
    if (typeof siteUrl === 'object' && siteUrl !== null) {
      const obj = siteUrl as Record<string, unknown>;
      return String(obj.value || siteUrl).replace(/\/$/, '');
    }
    return String(siteUrl).replace(/\/$/, '');
  }

  /**
   * Encode a SharePoint path for use in REST API URLs.
   * Unlike encodeURIComponent, this preserves forward slashes and single quotes
   * while encoding spaces and other special characters.
   */
  private encodeSharePointPath(path: string): string {
    return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
  }

  /**
   * Convert a site-relative path to a server-relative path.
   * Power Automate passes site-relative paths (e.g. "/Shared Documents/file.pdf")
   * but the SharePoint REST API's GetFileByServerRelativeUrl expects server-relative
   * paths (e.g. "/sites/mysite/Shared Documents/file.pdf").
   */
  private toServerRelativePath(siteUrl: string, path: string): string {
    try {
      const parsed = new URL(siteUrl);
      const sitePath = parsed.pathname.replace(/\/$/, '');
      // If the path already starts with the site path, it's already server-relative
      if (sitePath && path.startsWith(sitePath)) {
        return path;
      }
      // Prepend the site path to make it server-relative
      return sitePath + (path.startsWith('/') ? '' : '/') + path;
    } catch {
      // If URL parsing fails, return path as-is
      return path;
    }
  }

  private normalizeValue(value: unknown): string {
    if (typeof value === 'object' && value !== null) {
      const obj = value as Record<string, unknown>;
      return String(obj.value || value);
    }
    return String(value);
  }

  /**
   * Resolve the REST resource segment for a file addressed by the cloud
   * connector's `id` parameter. Power Automate's file identifiers are not
   * GUIDs: triggers ({Identifier}) and actions such as "Create file" hand out
   * a double URL-encoded site-relative path (`/` → `%252f`, space → `%2b`,
   * e.g. `Shared%2bDocuments%252fInvoices%252fa.xml`), which `GetFileById`
   * rejects with "Guid should contain 32 digits with 4 dashes". A real GUID
   * (the file's UniqueId) still goes through `GetFileById`; anything else is
   * decoded and addressed via `GetFileByServerRelativeUrl`.
   */
  private fileResource(siteUrl: string, fileId: string): string {
    if (/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i.test(fileId)) {
      return `GetFileById('${fileId.replace(/[{}]/g, '')}')`;
    }
    const path = this.decodeFileIdentifier(fileId);
    const serverRelativePath = this.toServerRelativePath(siteUrl, path);
    return `GetFileByServerRelativeUrl('${this.encodeSharePointPath(serverRelativePath)}')`;
  }

  /** Like fileResource, for folders (ListFolder, GetFolderMetadata). */
  private folderResource(siteUrl: string, folderId: string): string {
    if (/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i.test(folderId)) {
      return `GetFolderById('${folderId.replace(/[{}]/g, '')}')`;
    }
    const serverRelativePath = this.toServerRelativePath(siteUrl, this.decodeFileIdentifier(folderId));
    return `GetFolderByServerRelativeUrl('${this.encodeSharePointPath(serverRelativePath)}')`;
  }

  /** The REST properties blob metadata is built from, for a file or folder resource. */
  private async fetchBlobSource(siteUrl: string, resource: string, isFolder: boolean, ctx: RunContext): Promise<Record<string, unknown>> {
    const select = isFolder
      ? 'Name,ServerRelativeUrl,TimeLastModified,ListItemAllFields/Id'
      : 'Name,ServerRelativeUrl,TimeLastModified,Length,ETag,ListItemAllFields/Id';
    return this.spGet(`${siteUrl}/_api/web/${resource}?$select=${select}&$expand=ListItemAllFields`, ctx.log);
  }

  /**
   * The cloud connector's BlobMetadata for a file or folder (what GetFileMetadata,
   * GetFolderMetadata, ListFolder, CreateFile and UpdateFile return):
   * { ItemId, Id, Name, DisplayName, Path, LastModified, Size, MediaType, IsFolder, ETag, FileLocator }
   * with Id the identifier of the site-relative Path; folders have no MediaType/ETag/FileLocator.
   */
  private toBlobMetadata(siteUrl: string, raw: Record<string, unknown>, isFolder: boolean, itemId?: number): Record<string, unknown> {
    const sitePath = new URL(siteUrl).pathname.replace(/\/+$/, '');
    const serverRelative = String(raw.ServerRelativeUrl ?? '');
    const path = sitePath && serverRelative.startsWith(`${sitePath}/`) ? serverRelative.slice(sitePath.length) : serverRelative;
    const id = encodeFileIdentifier(path);
    const name = String(raw.Name ?? path.split('/').pop() ?? '');
    const listItem = raw.ListItemAllFields as { Id?: number; ID?: number } | undefined;
    const out: Record<string, unknown> = {
      ItemId: itemId ?? listItem?.Id ?? listItem?.ID ?? 0,
      Id: id,
      Name: name,
      DisplayName: name,
      Path: path,
      LastModified: raw.TimeLastModified,
      Size: isFolder ? 0 : Number(raw.Length ?? 0),
    };
    if (!isFolder) out.MediaType = inferFileContentType(name);
    out.IsFolder = isFolder;
    if (!isFolder) {
      out.ETag = raw.ETag;
      out.FileLocator = `dataset=${utf8Base64(siteUrl)},id=${utf8Base64(id)}`;
    }
    return out;
  }

  /**
   * Decode a Power Automate SharePoint file identifier into a plain path.
   * The cloud connector encodes the path twice and represents spaces as `+`
   * after the first decode, so: decode once, turn `+` into a space, decode
   * again (a literal `+` in a name arrives as `%252b` and survives).
   * A plain, already-decoded path (e.g. "Shared Documents/a.xml") passes
   * through unchanged.
   */
  private decodeFileIdentifier(id: string): string {
    const safeDecode = (s: string) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    };
    const once = safeDecode(id).replace(/\+/g, ' ');
    return safeDecode(once);
  }

  // ============= List Item Type Helper =============

  private async getListItemType(siteUrl: string, listId: string, ctx: RunContext): Promise<string> {
    const url = `${siteUrl}/_api/web/lists(guid'${listId}')?$select=ListItemEntityTypeFullName`;
    const data = await this.spGet<{ ListItemEntityTypeFullName: string }>(url, ctx.log);
    return data.ListItemEntityTypeFullName;
  }

  // ============= Cloud-Shape Field Expansion =============
  //
  // The cloud Power Automate SharePoint connector does not return raw REST
  // payloads for list items:
  //   - choice columns come back as SPListExpandedReference objects
  //     ({ "@odata.type": ..., "Id": <choice index, -1 for fill-in>, "Value": "..." })
  //     where raw REST returns a plain string
  //   - lookup columns come back as SPListExpandedReference with the target
  //     item's real Id, where raw REST returns only a sibling `<Field>Id`
  //   - person/group columns (incl. Author/Editor) come back as
  //     SPListExpandedUser ({ Claims, DisplayName, Email, ... }), where raw
  //     REST also returns only `<Field>Id`
  // To keep local runs faithful to what a deployed flow sees (expressions like
  // item()?['Field']?['Value'] or ?['Editor']?['Email']), we fetch the list's
  // field metadata (cached per list), $expand lookup/person fields on the
  // items query, and wrap the results in the cloud shapes. If the expanded
  // query fails (e.g. lookup column threshold), we retry raw and still apply
  // the choice wrapping. Person Department/JobTitle would need per-user
  // profile calls, so they are returned as null (best-effort parity).

  private fieldMetadataCache = new Map<string, ExpandableFieldInfo[]>();

  /**
   * Per-list set of lookup/person internal names verified to expand cleanly.
   * Populated by narrowRefExpansion after an expanded query fails, so later
   * queries on the same list skip the known-bad fields instead of re-failing.
   */
  private verifiedRefFieldsCache = new Map<string, Set<string>>();

  private async getExpandableFields(siteUrl: string, listId: string, log?: LogFunction): Promise<ExpandableFieldInfo[]> {
    const cacheKey = `${siteUrl}|${listId}`;
    const cached = this.fieldMetadataCache.get(cacheKey);
    if (cached) return cached;

    const typeFilter = [...Object.keys(FIELD_KIND_MAP), 'DateTime', 'URL'].map((t) => `TypeAsString eq '${t}'`).join(' or ');
    const filter = encodeURIComponent(`(${typeFilter}) and Hidden eq false`);
    const url = `${siteUrl}/_api/web/lists(guid'${listId}')/fields?$filter=${filter}`;
    const data = await this.spGet<{ value?: Array<Record<string, unknown>> }>(url, log);

    const byId = new Map<string, Record<string, unknown>>();
    for (const f of data.value ?? []) {
      if (typeof f.Id === 'string') byId.set(f.Id, f);
    }

    const fields: ExpandableFieldInfo[] = [];
    const scalar = { dateOnly: new Set<string>(), url: new Set<string>() };
    for (const f of data.value ?? []) {
      if (typeof f.InternalName === 'string') {
        // DisplayFormat 0 = "Date Only" (the cloud returns those as a yyyy-MM-dd site-local date)
        if (f.TypeAsString === 'DateTime' && (f.DisplayFormat === 0 || f.DisplayFormat === 'DateOnly')) scalar.dateOnly.add(f.InternalName);
        if (f.TypeAsString === 'URL') scalar.url.add(f.InternalName);
      }
      const mapping = FIELD_KIND_MAP[String(f.TypeAsString)];
      if (!mapping || typeof f.InternalName !== 'string') continue;
      let primaryName: string | undefined;
      if (f.IsDependentLookup === true) {
        // Projected column — resolve the primary lookup it projects through.
        // Without a resolvable primary the value cannot be materialized (the
        // dependent name itself is not expandable), so skip the field.
        const primary = typeof f.PrimaryFieldId === 'string' ? byId.get(f.PrimaryFieldId) : undefined;
        if (!primary || typeof primary.InternalName !== 'string') continue;
        primaryName = primary.InternalName;
      }
      const rawChoices = f.Choices as string[] | { results?: string[] } | undefined;
      fields.push({
        internalName: f.InternalName,
        kind: mapping.kind,
        multi: mapping.multi,
        choices: Array.isArray(rawChoices) ? rawChoices : rawChoices?.results ?? [],
        lookupField: typeof f.LookupField === 'string' && f.LookupField ? f.LookupField : 'Title',
        primaryName,
      });
    }
    this.fieldMetadataCache.set(cacheKey, fields);
    this.scalarFieldCache.set(cacheKey, scalar);
    return fields;
  }

  /** Date-only and hyperlink columns of a list (filled by getExpandableFields' metadata fetch). */
  private scalarFieldCache = new Map<string, { dateOnly: Set<string>; url: Set<string> }>();

  private libraryCache = new Map<string, boolean>();

  /** Whether the list is a document library (BaseType 1); cached, false when it cannot be read. */
  private async isLibrary(siteUrl: string, listId: string, log?: LogFunction): Promise<boolean> {
    const key = `${siteUrl}|${listId}`;
    const cached = this.libraryCache.get(key);
    if (cached !== undefined) return cached;
    let library = false;
    try {
      const data = await this.spGet<{ BaseType?: number }>(`${siteUrl}/_api/web/lists(guid'${listId}')?$select=BaseType`, log);
      library = data?.BaseType === 1;
    } catch {
      // unknown: treat as a list
    }
    this.libraryCache.set(key, library);
    return library;
  }

  /**
   * Compute the $select/$expand needed to materialize lookup/person values on
   * an items query. Respects a user-supplied $select (only expands ref fields
   * the user selected) and merges with a user-supplied $expand. Metadata
   * failures degrade to a passthrough of the user's own query options.
   */
  private async resolveRefExpansion(
    siteUrl: string,
    listId: string,
    userSelect: string | undefined,
    userExpand: string | undefined,
    ctx: RunContext,
  ): Promise<{ select?: string; expand?: string; augmented: boolean; refNames: string[] }> {
    const passthrough = { select: userSelect, expand: userExpand, augmented: false, refNames: [] as string[] };

    let refFields: ExpandableFieldInfo[];
    try {
      refFields = (await this.getExpandableFields(siteUrl, listId, ctx.log)).filter((f) => f.kind !== 'choice');
    } catch (err) {
      ctx.log?.({ type: 'sp.field-metadata-skipped', error: err instanceof Error ? err.message : String(err) });
      return passthrough;
    }

    const verified = this.verifiedRefFieldsCache.get(`${siteUrl}|${listId}`);
    if (verified) refFields = refFields.filter((f) => verified.has(f.internalName));
    if (userSelect) {
      const selected = new Set(userSelect.split(',').map((s) => s.trim().split('/')[0]));
      refFields = refFields.filter((f) => selected.has(f.internalName));
    }
    // With no $select of the caller's, the query still needs the system columns the
    // cloud's {Identifier}/{Path}/... fields are derived from, refs or not.
    if (refFields.length === 0 && userSelect) return passthrough;

    return this.buildRefQuery(refFields, userSelect, userExpand, await this.isLibrary(siteUrl, listId, ctx.log));
  }

  /** The nav property a ref field is materialized through (its own name, or the primary lookup's for dependent columns). */
  private refFieldNav(f: ExpandableFieldInfo): string {
    return f.primaryName ?? f.internalName;
  }

  /** Nav-property selects a ref field needs on an expanded query. */
  private refFieldSelects(f: ExpandableFieldInfo): string[] {
    const nav = this.refFieldNav(f);
    return f.kind === 'user'
      ? [`${nav}/Id`, `${nav}/Title`, `${nav}/EMail`, `${nav}/Name`]
      : [`${nav}/Id`, `${nav}/${f.lookupField}`];
  }

  private buildRefQuery(
    refFields: ExpandableFieldInfo[],
    userSelect: string | undefined,
    userExpand: string | undefined,
    library = false,
  ): { select: string; expand: string; augmented: true; refNames: string[] } {
    const userExpandParts = userExpand ? userExpand.split(',').map((s) => s.trim()) : [];
    // With no user $select, '*' covers scalar fields but not expanded
    // navigations — keep the user's own expansions selected as whole entities.
    const selectParts = userSelect
      ? [userSelect]
      : ['*', ...userExpandParts, ...ITEM_SYSTEM_SELECTS, ...(library ? LIBRARY_SYSTEM_SELECTS : [])];
    const expandParts = [...userExpandParts];
    for (const f of refFields) {
      const nav = this.refFieldNav(f);
      if (!expandParts.includes(nav)) expandParts.push(nav);
      for (const s of this.refFieldSelects(f)) {
        if (!selectParts.includes(s)) selectParts.push(s);
      }
    }
    if (!userSelect) {
      expandParts.push('ContentType');
      if (library && !expandParts.includes('File')) expandParts.push('File');
    }
    return {
      select: selectParts.join(','),
      expand: expandParts.join(','),
      augmented: true,
      refNames: refFields.map((f) => f.internalName),
    };
  }

  /**
   * After an expanded items query fails, find which ref fields actually expand
   * by probing subsets with cheap `$top=1` queries (binary split, so one bad
   * field among N costs ~log N probes). A field can fail individually (e.g. a
   * dependent lookup or a target list the user cannot read) or only in
   * combination (lookup column threshold) — both are handled. The verified set
   * is cached per list, so subsequent queries go straight to the good subset.
   * Returns a rebuilt query over the surviving fields, or null when narrowing
   * cannot help (nothing survives, or the failure is unrelated to ref fields).
   */
  private async narrowRefExpansion(
    siteUrl: string,
    listId: string,
    userSelect: string | undefined,
    userExpand: string | undefined,
    ctx: RunContext,
  ): Promise<{ select: string; expand: string; augmented: true; refNames: string[] } | null> {
    let allRef: ExpandableFieldInfo[];
    try {
      allRef = (await this.getExpandableFields(siteUrl, listId, ctx.log)).filter((f) => f.kind !== 'choice');
    } catch {
      return null;
    }
    if (allRef.length === 0) return null;

    const probe = async (subset: ExpandableFieldInfo[]): Promise<boolean> => {
      if (subset.length === 0) return true;
      const select = [...new Set(['Id', ...subset.flatMap((f) => this.refFieldSelects(f))])].join(',');
      const expand = [...new Set(subset.map((f) => this.refFieldNav(f)))].join(',');
      const qs = buildODataQuery({ top: 1, select, expand });
      try {
        await this.spGet(`${siteUrl}/_api/web/lists(guid'${listId}')/items?${qs}`, ctx.log);
        return true;
      } catch {
        return false;
      }
    };

    // Binary split: keep groups that probe clean, isolate single bad fields.
    const good: ExpandableFieldInfo[] = [];
    const stack: ExpandableFieldInfo[][] = [allRef];
    while (stack.length) {
      const group = stack.pop()!;
      if (await probe(group)) {
        good.push(...group);
        continue;
      }
      if (group.length === 1) {
        ctx.log?.({ type: 'sp.ref-expansion-field-skipped', field: group[0].internalName });
        continue;
      }
      const mid = Math.ceil(group.length / 2);
      stack.push(group.slice(mid), group.slice(0, mid));
    }

    // The full set probed clean, so ref expansion is not what failed — retrying
    // the same query would fail again; let the caller fall back to raw.
    if (good.length === allRef.length) return null;

    // Individually-good fields can still fail together (lookup column
    // threshold) — trim from the end until the combined probe passes.
    let subset = good;
    while (subset.length && !(await probe(subset))) {
      ctx.log?.({ type: 'sp.ref-expansion-field-skipped', field: subset[subset.length - 1].internalName, reason: 'combined query failed' });
      subset = subset.slice(0, -1);
    }

    this.verifiedRefFieldsCache.set(`${siteUrl}|${listId}`, new Set(subset.map((f) => f.internalName)));
    ctx.log?.({
      type: 'sp.ref-expansion-narrowed',
      kept: subset.map((f) => f.internalName),
      skipped: allRef.filter((f) => !subset.includes(f)).map((f) => f.internalName),
    });

    let refFields = subset;
    if (userSelect) {
      const selected = new Set(userSelect.split(',').map((s) => s.trim().split('/')[0]));
      refFields = refFields.filter((f) => selected.has(f.internalName));
    }
    if (refFields.length === 0) return null;
    return this.buildRefQuery(refFields, userSelect, userExpand, await this.isLibrary(siteUrl, listId, ctx.log));
  }

  private toExpandedReference(id: number, value: string | null): SPListExpandedReference {
    return {
      '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedReference',
      Id: id,
      Value: value,
    };
  }

  private toExpandedUser(siteUrl: string, o: Record<string, unknown>): SPListExpandedUser {
    const email = typeof o.EMail === 'string' && o.EMail ? o.EMail : null;
    return {
      '@odata.type': '#Microsoft.Azure.Connectors.SharePoint.SPListExpandedUser',
      Claims: typeof o.Name === 'string' ? o.Name : null,
      DisplayName: typeof o.Title === 'string' ? o.Title : null,
      Email: email,
      // The cloud leaves the address unencoded (AccountName=user@contoso.com).
      Picture: email ? `${siteUrl}/_layouts/15/UserPhoto.aspx?Size=L&AccountName=${email}` : null,
      Department: null,
      JobTitle: null,
    };
  }

  /** Wrap expandable column values in `item` (in place) to match the cloud connector's output shape. */
  private expandItemFieldValues(siteUrl: string, item: Record<string, unknown>, fields: ExpandableFieldInfo[]): void {
    // Dependent (projected) lookup columns read their value from the primary
    // lookup's expanded object — process them first, while the primary is
    // still the raw nav object (wrapping it below drops the projected props).
    for (const field of fields) {
      if (!field.primaryName) continue;
      const rawPrimary = item[field.primaryName];
      if (rawPrimary == null || typeof rawPrimary !== 'object') continue;
      const project = (v: unknown): unknown => {
        if (!v || typeof v !== 'object') return v;
        const o = v as Record<string, unknown>;
        if ('@odata.type' in o) return o; // primary already wrapped — nothing to project from
        return this.toExpandedReference(typeof o.Id === 'number' ? o.Id : -1, (o[field.lookupField] as string) ?? null);
      };
      const values = Array.isArray(rawPrimary) ? rawPrimary : (rawPrimary as { results?: unknown[] }).results;
      item[field.internalName] = Array.isArray(values) ? values.map(project) : project(rawPrimary);
    }

    for (const field of fields) {
      if (field.primaryName) continue; // projected above
      const raw = item[field.internalName];
      if (raw == null) continue;

      if (field.kind === 'choice') {
        if (field.multi) {
          // nometadata returns a plain array; verbose payloads use { results: [...] }
          const values = Array.isArray(raw) ? raw : (raw as { results?: unknown[] })?.results;
          if (Array.isArray(values)) {
            item[field.internalName] = values.map((v) =>
              typeof v === 'string' ? this.toExpandedReference(field.choices.indexOf(v), v) : v
            );
          }
        } else if (typeof raw === 'string') {
          item[field.internalName] = this.toExpandedReference(field.choices.indexOf(raw), raw);
        }
        continue;
      }

      // lookup/user: only present as objects when the query expanded them
      const wrap = (v: unknown): unknown => {
        if (!v || typeof v !== 'object') return v;
        const o = v as Record<string, unknown>;
        return field.kind === 'user'
          ? this.toExpandedUser(siteUrl, o)
          : this.toExpandedReference(typeof o.Id === 'number' ? o.Id : -1, (o[field.lookupField] as string) ?? null);
      };

      if (field.multi) {
        const values = Array.isArray(raw) ? raw : (raw as { results?: unknown[] })?.results;
        if (Array.isArray(values)) item[field.internalName] = values.map(wrap);
      } else if (typeof raw === 'object') {
        item[field.internalName] = wrap(raw);
      }
    }
  }

  /**
   * Apply cloud-connector output shaping to one or more list items.
   * Choice columns are always wrapped; lookup/person columns only when listed
   * in `refNames` (i.e. this connector expanded them — user-initiated $expand
   * results are left untouched). Metadata failures are non-fatal: items are
   * returned in raw REST shape.
   */
  private async applyCloudShape(siteUrl: string, listId: string, items: unknown[], ctx: RunContext, refNames: string[]): Promise<void> {
    try {
      const allFields = await this.getExpandableFields(siteUrl, listId, ctx.log);
      const fields = allFields.filter((f) => f.kind === 'choice' || refNames.includes(f.internalName));
      const scalar = this.scalarFieldCache.get(`${siteUrl}|${listId}`) ?? { dateOnly: new Set<string>(), url: new Set<string>() };
      const library = await this.isLibrary(siteUrl, listId, ctx.log);
      if (library) {
        // Learn the drive ids from the files first: a folder listed before any file needs them too.
        for (const item of items) {
          const file = (item as { File?: { VroomDriveID?: unknown; VroomItemID?: unknown } } | null)?.File;
          if (file) this.driveIds(siteUrl, listId, file, undefined);
        }
        await this.learnDriveInfo(siteUrl, listId, ctx);
      }
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        this.expandItemFieldValues(siteUrl, o, fields);
        const shaped = await this.toCloudItem(siteUrl, listId, o, fields, scalar, library, ctx);
        // In place: callers hold references to these objects.
        for (const k of Object.keys(o)) delete o[k];
        Object.assign(o, shaped);
      }
    } catch (err) {
      ctx.log?.({ type: 'sp.cloud-shape-skipped', error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Lay an (already ref-wrapped) REST item out the way the cloud connector returns it:
   * `@odata.etag`, `ItemInternalId` and `ID` first; each ref column followed by its
   * `#Id`/`#Claims` sibling(s) and, when multi-valued, `@odata.type` annotations; empty
   * multi-value columns as `[]`; null columns omitted; date-only columns as the site-local
   * date; hyperlinks as their URL; then the synthetic `{Identifier}`, `{Path}`, ... fields.
   * An expanded ref column takes the position of its raw `<Field>Id` key, which is where
   * the cloud puts it (e.g. Author/Editor right after Created).
   */
  private async toCloudItem(
    siteUrl: string,
    listId: string,
    item: Record<string, unknown>,
    fields: ExpandableFieldInfo[],
    scalar: { dateOnly: Set<string>; url: Set<string> },
    library: boolean,
    ctx: RunContext,
  ): Promise<Record<string, unknown>> {
    const byName = new Map(fields.filter((f) => !f.primaryName).map((f) => [f.internalName, f]));
    // Ref columns in `fields` were expanded by the query (an empty multi-value one comes back
    // with no key at all); their raw <Field>Id / <Field>StringId keys are dropped.
    const idKeyToField = new Map<string, ExpandableFieldInfo>();
    for (const f of byName.values()) {
      if (f.kind !== 'choice') idKeyToField.set(`${f.internalName}Id`, f);
    }
    const out: Record<string, unknown> = {};
    const emitted = new Set<string>();

    const id = item.ID ?? item.Id;
    if (item.owshiddenversion != null) out['@odata.etag'] = `"${item.owshiddenversion}"`;
    if (id != null) {
      out.ItemInternalId = String(id);
      out.ID = id;
    }

    const emit = async (name: string, value: unknown) => {
      emitted.add(name);
      const f = byName.get(name);
      if (f?.multi) {
        const arr = Array.isArray(value) ? value : [];
        out[name] = arr;
        if (f.kind === 'user') {
          out[`${name}@odata.type`] = `#Collection(${SP_TYPE.slice(1)}.SPListExpandedUser)`;
          out[`${name}#Claims`] = arr.map((u) => (u as SPListExpandedUser)?.Claims ?? null);
          out[`${name}#Claims@odata.type`] = '#Collection(String)';
        } else {
          out[`${name}@odata.type`] = `#Collection(${SP_TYPE.slice(1)}.SPListExpandedReference)`;
          out[`${name}#Id`] = arr.map((r) => (r as SPListExpandedReference)?.Id ?? null);
          out[`${name}#Id@odata.type`] = '#Collection(Int64)';
        }
        return;
      }
      if (value === null || value === undefined) return;
      if (f && typeof value === 'object') {
        out[name] = value;
        if (f.kind === 'user') out[`${name}#Claims`] = (value as SPListExpandedUser).Claims;
        else out[`${name}#Id`] = (value as SPListExpandedReference).Id;
        return;
      }
      if (scalar.dateOnly.has(name) && typeof value === 'string') {
        out[name] = await this.siteLocalDate(siteUrl, value, ctx);
        return;
      }
      if (scalar.url.has(name) && typeof value === 'object') {
        out[name] = (value as { Url?: unknown }).Url ?? null;
        return;
      }
      out[name] = value;
    };

    for (const [key, value] of Object.entries(item)) {
      // Before the drop list: CheckoutUserId is dropped, but places CheckoutUser (a checked-out file's).
      const ref = idKeyToField.get(key);
      if (ref) {
        if (!emitted.has(ref.internalName)) await emit(ref.internalName, item[ref.internalName]);
        continue;
      }
      // A library's File was expanded by the connector only for the drive ids.
      if (ITEM_DROP_KEYS.has(key) || key.startsWith('odata.') || emitted.has(key) || (library && key === 'File')) continue;
      if (key.endsWith('StringId') && idKeyToField.has(key.replace(/StringId$/, 'Id'))) continue;
      // An expanded ref whose <Field>Id key comes later is emitted there.
      if (byName.get(key)?.kind !== 'choice' && byName.has(key) && `${key}Id` in item) continue;
      await emit(key, value);
    }
    for (const f of byName.values()) {
      if (f.multi && !emitted.has(f.internalName)) {
        await emit(f.internalName, []);
      }
    }

    Object.assign(out, this.syntheticItemFields(siteUrl, listId, item, id, library));
    return out;
  }

  /** The cloud connector's `{Identifier}`, `{Link}`, `{Path}`, ... fields, when the system columns were queried. */
  private syntheticItemFields(
    siteUrl: string,
    listId: string,
    item: Record<string, unknown>,
    id: unknown,
    library: boolean,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const fileRef = item.FileRef;
    const leaf = typeof item.FileLeafRef === 'string' ? item.FileLeafRef : '';
    if (typeof fileRef === 'string') {
      const site = new URL(siteUrl);
      const sitePath = site.pathname.replace(/\/+$/, '');
      const rel = (p: string) => (p.startsWith(`${sitePath}/`) ? p.slice(sitePath.length + 1) : p.replace(/^\//, ''));
      const fullPath = rel(fileRef);
      const isFolder = String(item.FSObjType) === '1';
      const isListItem = /^\d+_\.000$/.test(leaf);
      const ct = item.ContentType as { Id?: unknown; Name?: unknown } | undefined;
      const ctId = typeof ct?.Id === 'object' && ct.Id ? (ct.Id as { StringValue?: unknown }).StringValue : ct?.Id;
      const title = (item.Title as string | null | undefined) ?? null;
      const baseName = isFolder ? leaf : leaf.replace(/\.[^.]*$/, '');
      // Each path segment: spaces → '+', percent-encoded (lower-case hex), segments joined by an encoded '%2f'.
      const uniqueId = typeof item.UniqueId === 'string' ? item.UniqueId : undefined;
      const extension = leaf.includes('.') ? (leaf.split('.').pop() ?? '').toLowerCase() : '';
      out['{Identifier}'] = encodeFileIdentifier(fullPath);
      out['{IsFolder}'] = isFolder;
      if (library) out['{Thumbnail}'] = { Full: null, Large: null, Medium: null, Small: null };
      out['{Link}'] = isListItem
        ? `${siteUrl}/_layouts/15/listform.aspx?PageType=4&ListId=${listId.replace(/[{}]/g, '').toLowerCase().replace(/-/g, '%2D')}&ID=${id}` +
          (ctId ? `&ContentTypeID=${ctId}` : '')
        : `${site.origin}${encodeURI(fileRef)}` +
          (!isFolder && uniqueId && OFFICE_EXTENSIONS.has(extension) ? `?d=w${uniqueId.replace(/[{}-]/g, '').toLowerCase()}` : '');
      out['{Name}'] = isListItem ? title : baseName;
      out['{FilenameWithExtension}'] = isListItem ? title : leaf;
      out['{Path}'] = typeof item.FileDirRef === 'string' ? `${rel(item.FileDirRef)}/` : null;
      out['{FullPath}'] = fullPath;
      if (ct && ctId) {
        out['{ContentType}'] = { '@odata.type': `${SP_TYPE}.SPListExpandedContentType`, Id: ctId, Name: ct.Name ?? null };
        out['{ContentType}#Id'] = ctId;
      }
      if (library) {
        if ('CheckoutUserId' in item) out['{IsCheckedOut}'] = item.CheckoutUserId != null;
        const drive = this.driveIds(siteUrl, listId, item.File as { VroomDriveID?: unknown; VroomItemID?: unknown } | undefined, uniqueId);
        if (drive.driveId) out['{DriveId}'] = drive.driveId;
        if (drive.driveItemId) out['{DriveItemId}'] = drive.driveItemId;
      }
    }
    if (typeof item.Attachments === 'boolean') out['{HasAttachments}'] = item.Attachments;
    if (typeof item.OData__UIVersionString === 'string') out['{VersionNumber}'] = item.OData__UIVersionString;
    return out;
  }

  /** Per library: its drive id and the 4-byte prefix of its drive item ids (both learned from files). */
  private driveInfo = new Map<string, { driveId?: string; itemPrefix?: Uint8Array }>();
  /** Libraries whose drive ids were already asked of the v2.0 API (asked once, even when it fails). */
  private driveInfoAsked = new Set<string>();

  /**
   * When no file has taught a library's drive ids yet (e.g. only folders so far), ask SharePoint's
   * own v2.0 (Graph-shaped) API with the same token: the library's drive id, and the drive item id
   * prefix from its root folder's id.
   */
  private async learnDriveInfo(siteUrl: string, listId: string, ctx: RunContext): Promise<void> {
    const key = `${siteUrl}|${listId}`;
    const info = this.driveInfo.get(key) ?? {};
    if ((info.driveId && info.itemPrefix) || this.driveInfoAsked.has(key)) return;
    this.driveInfoAsked.add(key);
    try {
      const drive = `${siteUrl}/_api/v2.0/sites/root/lists/${listId.replace(/[{}]/g, '')}/drive`;
      const [d, root] = await Promise.all([
        this.spGet<{ id?: unknown }>(`${drive}?$select=id`, ctx.log),
        this.spGet<{ id?: unknown }>(`${drive}/root?$select=id`, ctx.log),
      ]);
      if (!info.driveId && typeof d?.id === 'string') info.driveId = d.id;
      if (!info.itemPrefix && typeof root?.id === 'string' && root.id.startsWith('01')) {
        info.itemPrefix = base32Decode(root.id.slice(2)).subarray(0, 4);
      }
      this.driveInfo.set(key, info);
    } catch (err) {
      ctx.log?.({ type: 'sp.drive-info-skipped', error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * The cloud's `{DriveId}`/`{DriveItemId}` (Microsoft Graph ids). A file carries both
   * (File/VroomDriveID, File/VroomItemID); a folder has no File, so its ids are rebuilt from
   * what the library's files taught: the drive id is shared, and a drive item id is
   * "01" + base32(4-byte drive prefix + the item's UniqueId in .NET byte order).
   */
  private driveIds(
    siteUrl: string,
    listId: string,
    file: { VroomDriveID?: unknown; VroomItemID?: unknown } | undefined,
    uniqueId: string | undefined,
  ): { driveId?: string; driveItemId?: string } {
    const key = `${siteUrl}|${listId}`;
    const info = this.driveInfo.get(key) ?? {};
    if (typeof file?.VroomDriveID === 'string') info.driveId = file.VroomDriveID;
    if (typeof file?.VroomItemID === 'string' && file.VroomItemID.startsWith('01')) {
      info.itemPrefix = base32Decode(file.VroomItemID.slice(2)).subarray(0, 4);
    }
    this.driveInfo.set(key, info);
    if (typeof file?.VroomItemID === 'string') return { driveId: info.driveId, driveItemId: file.VroomItemID };
    const driveItemId =
      info.itemPrefix && uniqueId ? `01${base32Encode(concatBytes(info.itemPrefix, dotNetGuidBytes(uniqueId)))}` : undefined;
    return { driveId: info.driveId, driveItemId };
  }

  private siteLocalDates = new Map<string, string>();

  /** A date-only column's stored UTC instant → the site-local calendar date (yyyy-MM-dd), as the cloud returns it. */
  private async siteLocalDate(siteUrl: string, utc: string, ctx: RunContext): Promise<string> {
    const key = `${siteUrl}|${utc}`;
    const cached = this.siteLocalDates.get(key);
    if (cached) return cached;
    let local = utc.slice(0, 10);
    try {
      const res = await this.spGet<{ value?: string }>(
        `${siteUrl}/_api/web/RegionalSettings/TimeZone/utcToLocalTime(@date)?@date='${encodeURIComponent(utc)}'`,
        ctx.log,
      );
      if (typeof res?.value === 'string') local = res.value.slice(0, 10);
    } catch (err) {
      ctx.log?.({ type: 'sp.local-date-skipped', error: err instanceof Error ? err.message : String(err) });
    }
    this.siteLocalDates.set(key, local);
    return local;
  }

  // ============= List Item Operations =============

  private async getItems(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    if (!siteUrl || !listId) throw new Error('getItems requires siteUrl (dataset) and listId (table)');

    const baseQuery = {
      filter: inputs.filter as string,
      top: inputs.top as number,
      skip: inputs.skip as number | undefined,
      orderby: inputs.orderby as string,
      select: inputs.select as string | undefined,
      expand: inputs.expand as string | undefined,
    };
    const aug = await this.resolveRefExpansion(siteUrl, listId, baseQuery.select, baseQuery.expand, ctx);
    const makeUrl = (select?: string, expand?: string) => {
      const qs = buildODataQuery({ ...baseQuery, select, expand });
      return `${siteUrl}/_api/web/lists(guid'${listId}')/items${qs ? '?' + qs : ''}`;
    };

    let body: { value: unknown[] } | undefined;
    let refNames = aug.refNames;
    try {
      body = await this.spGet<{ value: unknown[] }>(makeUrl(aug.select, aug.expand), ctx.log);
    } catch (err) {
      if (!aug.augmented) throw err;
      // Expanded queries can fail (a dependent lookup, a lookup the caller
      // cannot read, or the lookup column threshold). Isolate the bad fields
      // and retry with the ones that work, before giving up on expansion.
      ctx.log?.({ type: 'sp.ref-expansion-fallback', error: err instanceof Error ? err.message : String(err) });
      const narrowed = await this.narrowRefExpansion(siteUrl, listId, baseQuery.select, baseQuery.expand, ctx);
      if (narrowed) {
        try {
          body = await this.spGet<{ value: unknown[] }>(makeUrl(narrowed.select, narrowed.expand), ctx.log);
          refNames = narrowed.refNames;
        } catch {
          body = undefined;
        }
      }
      if (!body) {
        body = await this.spGet<{ value: unknown[] }>(makeUrl(baseQuery.select, baseQuery.expand), ctx.log);
        refNames = [];
      }
    }
    ctx.log?.({ type: 'sp.response', itemCount: body.value?.length });
    if (Array.isArray(body.value)) {
      await this.applyCloudShape(siteUrl, listId, body.value, ctx, refNames);
    }
    return withCloudNextLink(body);
  }

  private async getItemById(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);
    if (!siteUrl || !listId || !itemId) throw new Error('getItemById requires siteUrl, listId and itemId');

    return this.getSingleItemCloudShape(siteUrl, listId, itemId, ctx);
  }

  /** Fetch a single list item with cloud-connector output shaping (shared by GetItem and GetFileProperties). */
  private async getSingleItemCloudShape(siteUrl: string, listId: string, itemId: string, ctx: RunContext): Promise<unknown> {
    const baseUrl = `${siteUrl}/_api/web/lists(guid'${listId}')/items(${itemId})`;
    const aug = await this.resolveRefExpansion(siteUrl, listId, undefined, undefined, ctx);

    let item: unknown;
    let refNames = aug.refNames;
    if (aug.augmented) {
      try {
        const qs = buildODataQuery({ select: aug.select, expand: aug.expand });
        item = await this.spGet(`${baseUrl}?${qs}`, ctx.log);
      } catch (err) {
        ctx.log?.({ type: 'sp.ref-expansion-fallback', error: err instanceof Error ? err.message : String(err) });
        const narrowed = await this.narrowRefExpansion(siteUrl, listId, undefined, undefined, ctx);
        if (narrowed) {
          try {
            const qs = buildODataQuery({ select: narrowed.select, expand: narrowed.expand });
            item = await this.spGet(`${baseUrl}?${qs}`, ctx.log);
            refNames = narrowed.refNames;
          } catch {
            item = undefined;
          }
        }
        if (item === undefined) {
          item = await this.spGet(baseUrl, ctx.log);
          refNames = [];
        }
      }
    } else {
      item = await this.spGet(baseUrl, ctx.log);
    }

    if (item && typeof item === 'object') {
      await this.applyCloudShape(siteUrl, listId, [item], ctx, refNames);
    }
    return item;
  }

  // Like the cloud connector, create and update answer with the item as GetItem would
  // return it (cloud shape), not the raw REST response.
  private async createItem(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const fields = inputs.fields as Record<string, unknown>;

    if (!siteUrl || !listId || !fields) {
      throw new Error(`createItem requires siteUrl, listId and fields. Got: ${JSON.stringify({ siteUrl: !!siteUrl, listId: !!listId, fields: !!fields })}`);
    }

    const url = `${siteUrl}/_api/web/lists(guid'${listId}')/items`;
    const created = await this.spPost<Record<string, unknown>>(url, ctx.log, {
      body: await this.toRestFields(siteUrl, listId, fields, ctx),
    });
    const id = created?.Id ?? created?.ID;
    return id === undefined ? created : this.getSingleItemCloudShape(siteUrl, listId, String(id), ctx);
  }

  private async updateItem(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);
    const fields = inputs.fields as Record<string, unknown>;

    if (!siteUrl || !listId || !itemId || !fields) {
      throw new Error('updateItem requires siteUrl, listId, itemId and fields');
    }

    const url = `${siteUrl}/_api/web/lists(guid'${listId}')/items(${itemId})`;

    await this.spPost(url, ctx.log, {
      body: await this.toRestFields(siteUrl, listId, fields, ctx),
      headers: { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' },
    });

    return this.getSingleItemCloudShape(siteUrl, listId, itemId, ctx);
  }

  private ensuredUsers = new Map<string, number>();

  /** SharePoint user id for a claims string / login / email, via web/ensureuser (cached per site). */
  private async ensureUserId(siteUrl: string, logonName: string, ctx: RunContext): Promise<number> {
    const key = `${siteUrl}|${logonName.toLowerCase()}`;
    const cached = this.ensuredUsers.get(key);
    if (cached !== undefined) return cached;
    const user = await this.spPost<{ Id: number }>(`${siteUrl}/_api/web/ensureuser`, ctx.log, { body: { logonName } });
    this.ensuredUsers.set(key, user.Id);
    return user.Id;
  }

  /**
   * Translate cloud-connector field values (what the Power Automate designer emits for
   * PostItem/PatchItem) into a SharePoint REST item body:
   *   item/Status/Value: 'Open'        → Status: 'Open'
   *   item/Tags: [{ Value: 'Red' }]    → Tags: ['Red']
   *   item/Category/Id: 2              → CategoryId: 2
   *   item/Owner/Claims: 'i:0#.f|...'  → OwnerId: <ensureuser id>
   *   item/Reviewers: [{ Claims }]     → ReviewersId: [ids]
   * Field kinds come from the list's (cached) field metadata. Values already in REST form
   * pass through, as do fields the metadata does not describe.
   */
  private async toRestFields(
    siteUrl: string,
    listId: string,
    fields: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<Record<string, unknown>> {
    const nested = nestSlashedKeys(fields);
    let meta: ExpandableFieldInfo[] = [];
    try {
      meta = await this.getExpandableFields(siteUrl, listId, ctx.log);
    } catch (err) {
      ctx.log?.({ type: 'sp.field-metadata-skipped', error: err instanceof Error ? err.message : String(err) });
    }
    const byName = new Map(meta.map((f) => [f.internalName, f]));

    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(nested)) {
      const field = byName.get(name);
      if (!field || field.primaryName) {
        out[name] = value;
        continue;
      }
      // `item/Status/Value`, `item/Category/Id` or `item/Owner/Claims` set to null leaves the
      // field unchanged in the cloud (a plain column set to null is cleared, above).
      if (isAllNullObject(value)) continue;
      const values = field.multi ? (Array.isArray(value) ? value : value == null ? [] : [value]) : undefined;

      if (field.kind === 'choice') {
        out[name] = values ? values.map(choiceText) : choiceText(value);
      } else if (field.kind === 'lookup') {
        out[`${name}Id`] = values ? values.map(lookupId) : value == null ? null : lookupId(value);
      } else {
        const toId = (v: unknown) => this.userId(siteUrl, v, ctx);
        out[`${name}Id`] = values ? await Promise.all(values.map(toId)) : value == null ? null : await toId(value);
      }
    }
    return out;
  }

  private async userId(siteUrl: string, v: unknown, ctx: RunContext): Promise<unknown> {
    if (typeof v === 'number') return v;
    const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
    if (o && typeof o.Id === 'number') return o.Id;
    const logon = o ? (o.Claims ?? o.Email ?? o.EMail) : v;
    if (typeof logon !== 'string' || !logon) return null;
    return this.ensureUserId(siteUrl, logon, ctx);
  }

  // The cloud's DeleteItem has no body.
  private async deleteItem(inputs: Record<string, unknown>, ctx: RunContext): Promise<undefined> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);

    if (!siteUrl || !listId || !itemId) throw new Error('deleteItem requires siteUrl, listId and itemId');

    const url = `${siteUrl}/_api/web/lists(guid'${listId}')/items(${itemId})`;
    await this.spPost(url, ctx.log, {
      headers: { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' },
    });
    return undefined;
  }

  // ============= Folder Operations =============

  /** Create every missing folder along a server-relative path below the site (the library root must exist). */
  private async ensureFolderPath(siteUrl: string, serverRelativePath: string, ctx: RunContext): Promise<void> {
    if (await this.pathExists(siteUrl, serverRelativePath, 'Folder', ctx)) return;
    const sitePath = new URL(siteUrl).pathname.replace(/\/+$/, '');
    const below = serverRelativePath.startsWith(`${sitePath}/`) ? serverRelativePath.slice(sitePath.length) : serverRelativePath;
    let current = sitePath;
    for (const segment of below.split('/').filter(Boolean)) {
      current = `${current}/${segment}`;
      if (await this.pathExists(siteUrl, current, 'Folder', ctx)) continue;
      await this.spPost(`${siteUrl}/_api/web/folders/add('${this.encodeSharePointPath(current).replace(/'/g, "''")}')`, ctx.log);
    }
  }

  /**
   * Create new folder: `path` is relative to the library root and may name several levels
   * ("A/B/C"), which are all created. Answers with the folder's library item in the GetFileItem
   * shape, as the cloud does.
   */
  private async createFolder(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const folderPath = inputs.folderPath == null ? '' : String(inputs.folderPath).replace(/^\/+|\/+$/g, '');

    if (!siteUrl || !listId || !folderPath) {
      throw new Error(`createFolder requires siteUrl, listId and folderPath`);
    }

    const listInfoUrl = `${siteUrl}/_api/web/lists(guid'${listId}')?$select=RootFolder/ServerRelativeUrl&$expand=RootFolder`;
    const listInfo = await this.spGet<{ RootFolder: { ServerRelativeUrl: string } }>(listInfoUrl, ctx.log);
    // Each missing level is created as a folder item whose Title is its name, in one call (the
    // cloud's folders have that Title, still at version 1).
    let fullPath = listInfo.RootFolder.ServerRelativeUrl;
    for (const name of folderPath.split('/').filter(Boolean)) {
      const parent = fullPath;
      fullPath = `${parent}/${name}`;
      if (await this.pathExists(siteUrl, fullPath, 'Folder', ctx)) continue;
      const created = await this.spPost<{ value?: Array<{ HasException?: boolean; ErrorMessage?: string }> }>(
        `${siteUrl}/_api/web/lists(guid'${listId}')/AddValidateUpdateItemUsingPath`,
        ctx.log,
        {
          body: {
            listItemCreateInfo: { FolderPath: { DecodedUrl: parent }, UnderlyingObjectType: 1, LeafName: { DecodedUrl: name } },
            formValues: [{ FieldName: 'Title', FieldValue: name }],
            bNewDocumentUpdate: false,
          },
        },
      );
      const failed = created.value?.find((v) => v.HasException);
      if (failed) throw new HttpError(failed.ErrorMessage ?? `Could not create folder '${fullPath}'`, 400, { 'odata.error': { message: { value: failed.ErrorMessage } } });
    }

    const item = await this.spGet<{ Id?: number; ID?: number }>(
      `${siteUrl}/_api/web/GetFolderByServerRelativeUrl('${this.encodeSharePointPath(fullPath)}')/ListItemAllFields?$select=Id`,
      ctx.log,
    );
    return this.getSingleItemCloudShape(siteUrl, listId, String(item.Id ?? item.ID), ctx);
  }

  /** The cloud's `id` for a folder lands in folderId, or in fileId (normalizeInputs' generic mapping). */
  private folderIdInput(inputs: Record<string, unknown>): string | undefined {
    const raw = inputs.folderId ?? inputs.fileId;
    return raw === undefined || raw === null || raw === '' ? undefined : this.normalizeValue(raw);
  }

  /** A folder's subfolders, then its files, as BlobMetadata (ItemId 0, as the cloud reports them). */
  private async listFolderContents(siteUrl: string, resource: string, ctx: RunContext): Promise<unknown[]> {
    const [folders, files] = await Promise.all([
      this.spGet<{ value?: Array<Record<string, unknown>> }>(
        `${siteUrl}/_api/web/${resource}/Folders?$select=Name,ServerRelativeUrl,TimeLastModified`,
        ctx.log,
      ),
      this.spGet<{ value?: Array<Record<string, unknown>> }>(
        `${siteUrl}/_api/web/${resource}/Files?$select=Name,ServerRelativeUrl,TimeLastModified,Length,ETag`,
        ctx.log,
      ),
    ]);
    return [
      ...(folders.value ?? []).map((f) => this.toBlobMetadata(siteUrl, f, true, 0)),
      ...(files.value ?? []).map((f) => this.toBlobMetadata(siteUrl, f, false, 0)),
    ];
  }

  private async listFolder(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown[]> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const folderId = this.folderIdInput(inputs);

    if (!siteUrl || !folderId) throw new Error('listFolder requires siteUrl and folderId');
    return this.listFolderContents(siteUrl, this.folderResource(siteUrl, folderId), ctx);
  }

  private async listRootFolder(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown[]> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    if (!siteUrl) throw new Error('listRootFolder requires siteUrl');

    // The cloud's ListRootFolder lists the site's root folder; a folderPath (a local extension) narrows it.
    const folderPath = inputs.folderPath ? String(inputs.folderPath) : '';
    const serverRelativePath = this.toServerRelativePath(siteUrl, folderPath || '/');
    const resource = `GetFolderByServerRelativeUrl('${this.encodeSharePointPath(serverRelativePath.replace(/\/+$/, '') || '/')}')`;
    return this.listFolderContents(siteUrl, resource, ctx);
  }

  private async getFolderMetadata(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const folderId = this.folderIdInput(inputs);

    if (!siteUrl || !folderId) throw new Error('getFolderMetadata requires siteUrl and folderId');
    const raw = await this.fetchBlobSource(siteUrl, this.folderResource(siteUrl, folderId), true, ctx);
    return this.toBlobMetadata(siteUrl, raw, true);
  }

  private async getFolderMetadataByPath(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const path = String(inputs.path);

    if (!siteUrl || !path) throw new Error('getFolderMetadataByPath requires siteUrl and path');
    const serverRelativePath = this.toServerRelativePath(siteUrl, path);
    const resource = `GetFolderByServerRelativeUrl('${this.encodeSharePointPath(serverRelativePath)}')`;
    return this.toBlobMetadata(siteUrl, await this.fetchBlobSource(siteUrl, resource, true, ctx), true);
  }

  private copyFolder(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    return this.transfer('Folder', 'Copy', inputs, ctx);
  }

  private moveFolder(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    return this.transfer('Folder', 'Move', inputs, ctx);
  }

  /** Whether a file or folder exists at a server-relative path (a missing file is a 404, a missing folder Exists: false). */
  private async pathExists(siteUrl: string, serverRelativePath: string, kind: 'File' | 'Folder', ctx: RunContext): Promise<boolean> {
    try {
      const data = await this.spGet<{ Exists?: boolean }>(
        `${siteUrl}/_api/web/Get${kind}ByServerRelativeUrl('${this.encodeSharePointPath(serverRelativePath)}')?$select=Exists`,
        ctx.log,
      );
      return data?.Exists !== false;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 500)) return false;
      throw err;
    }
  }

  /**
   * Copy or move a file or folder (the cloud's CopyFileAsync, MoveFileAsync, CopyFolderAsync,
   * MoveFolderAsync) through SP.MoveCopyUtil, which also works across sites. nameConflictBehavior:
   * 0 = fail (SharePoint's "A file or folder with the name '…' already exists at the destination."),
   * 1 = replace (the existing one is recycled first), 2 = keep both (the copy takes the first free
   * "name1.ext", "name2.ext", … as SharePoint names it). Answers with the destination's BlobMetadata.
   */
  private async transfer(kind: 'File' | 'Folder', mode: 'Copy' | 'Move', inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const sourceId = kind === 'File' ? (inputs.fileId == null ? undefined : this.normalizeValue(inputs.fileId)) : this.folderIdInput(inputs);
    const destSiteUrl = inputs.destSiteUrl ? this.normalizeSiteUrl(inputs.destSiteUrl) : siteUrl;
    const behavior = Number(inputs.nameConflictBehavior ?? 1);
    if (!siteUrl || !sourceId || inputs.destFolderPath == null) {
      throw new Error(`${mode}${kind} requires dataset, the source ${kind.toLowerCase()} id and destinationFolderPath`);
    }

    const isFolder = kind === 'Folder';
    const resource = isFolder ? this.folderResource(siteUrl, sourceId) : this.fileResource(siteUrl, sourceId);
    const source = (await this.fetchBlobSource(siteUrl, resource, isFolder, ctx)) as { Name: string; ServerRelativeUrl: string };
    const destFolder = this.toServerRelativePath(destSiteUrl, String(inputs.destFolderPath)).replace(/\/+$/, '');

    let name = source.Name;
    if (await this.pathExists(destSiteUrl, `${destFolder}/${name}`, kind, ctx)) {
      if (behavior === 0) {
        // The cloud's message (MoveCopyUtil's own is "The destination file already exists.").
        throw new HttpError(`A file or folder with the name '${name}' already exists at the destination.`, 400);
      }
      if (behavior === 2) {
        const dot = isFolder ? -1 : name.lastIndexOf('.');
        const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
        let n = 1;
        while (await this.pathExists(destSiteUrl, `${destFolder}/${stem}${n}${ext}`, kind, ctx)) n++;
        name = `${stem}${n}${ext}`;
      } else {
        await this.spPost(`${destSiteUrl}/_api/web/Get${kind}ByServerRelativeUrl('${this.encodeSharePointPath(`${destFolder}/${name}`)}')/recycle()`, ctx.log);
      }
    }

    const destPath = `${destFolder}/${name}`;
    await this.spPost(`${siteUrl}/_api/SP.MoveCopyUtil.${mode}${kind}`, ctx.log, {
      body: {
        srcUrl: `${new URL(siteUrl).origin}${source.ServerRelativeUrl}`,
        destUrl: `${new URL(destSiteUrl).origin}${destPath}`,
        options: { KeepBoth: false, ResetAuthorAndCreatedOnCopy: false, ShouldBypassSharedLocks: true },
      },
    });
    const destResource = `Get${kind}ByServerRelativeUrl('${this.encodeSharePointPath(destPath)}')`;
    return this.toBlobMetadata(destSiteUrl, await this.fetchBlobSource(destSiteUrl, destResource, isFolder, ctx), isFolder);
  }

  /**
   * Extract folder (the cloud's ExtractFolderV2): unpacks a .zip from the site into the destination
   * folder, creating the folders it needs. SharePoint REST has no extract call, so the archive is read
   * here (stored and deflated entries). Answers like the cloud: the archive's top-level entries as
   * BlobMetadata without ItemId, folders first (with LastModified 0001-01-01T00:00:00), then files.
   */
  private async extractFolder(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown[]> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const source = inputs.source == null ? '' : String(inputs.source);
    const destination = inputs.destination == null ? '' : String(inputs.destination);
    const overwrite = inputs.overwrite === true || String(inputs.overwrite).toLowerCase() === 'true';
    if (!siteUrl || !source || !destination) throw new Error('extractFolder requires dataset, source and destination');

    const sourcePath = this.toServerRelativePath(siteUrl, this.decodeFileIdentifier(source));
    const zip = await this.spRequest<{ $content: string }>(
      'GET',
      `${siteUrl}/_api/web/GetFileByServerRelativeUrl('${this.encodeSharePointPath(sourcePath)}')/$value`,
      ctx.log,
      { headers: { Accept: 'application/octet-stream' }, binary: true },
    );
    const entries = await readZipEntries(base64ToUint8(zip.$content));

    const destRoot = this.toServerRelativePath(siteUrl, destination).replace(/\/+$/, '');
    await this.ensureFolderPath(siteUrl, destRoot, ctx);
    const topFolders: string[] = [];
    const topFiles: string[] = [];
    for (const entry of entries) {
      const parts = entry.name.split('/').filter(Boolean);
      if (parts.length === 0) continue;
      const isDir = entry.name.endsWith('/');
      if (parts.length > 1 || isDir) {
        if (!topFolders.includes(parts[0])) topFolders.push(parts[0]);
      } else {
        topFiles.push(parts[0]);
      }
      const folder = [destRoot, ...parts.slice(0, isDir ? parts.length : -1)].join('/');
      await this.ensureFolderPath(siteUrl, folder, ctx);
      if (isDir) continue;
      const fileName = parts[parts.length - 1];
      await this.spPost(
        `${siteUrl}/_api/web/GetFolderByServerRelativeUrl('${this.encodeSharePointPath(folder)}')/Files/add(url='${encodeURIComponent(fileName.replace(/'/g, "''"))}',overwrite=${overwrite})`,
        ctx.log,
        { body: entry.data, rawBody: true, headers: { 'Content-Type': 'application/octet-stream' } },
      );
    }

    const result: unknown[] = [];
    for (const name of topFolders) {
      const meta = this.toBlobMetadata(siteUrl, { Name: name, ServerRelativeUrl: `${destRoot}/${name}` }, true);
      delete meta.ItemId;
      result.push({ ...meta, LastModified: '0001-01-01T00:00:00' });
    }
    for (const name of topFiles) {
      const resource = `GetFileByServerRelativeUrl('${this.encodeSharePointPath(`${destRoot}/${name}`)}')`;
      const meta = this.toBlobMetadata(siteUrl, await this.fetchBlobSource(siteUrl, resource, false, ctx), false);
      delete meta.ItemId;
      result.push(meta);
    }
    return result;
  }

  // ============= File Operations =============

  private async createFile(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const folderPath = String(inputs.folderPath);
    const fileName = String(inputs.fileName);
    const rawContent = inputs.content;

    if (!siteUrl || !folderPath || !fileName || rawContent == null) {
      throw new Error('createFile requires siteUrl, folderPath, fileName and content');
    }

    const content = this.resolveFileContent(rawContent);
    const serverRelativePath = this.toServerRelativePath(siteUrl, folderPath);
    const url = `${siteUrl}/_api/web/GetFolderByServerRelativeUrl('${this.encodeSharePointPath(serverRelativePath)}')/Files/add(url='${encodeURIComponent(fileName)}',overwrite=true)`;
    const created = await this.spPost<{ UniqueId?: string; ServerRelativeUrl?: string }>(url, ctx.log, {
      body: content,
      rawBody: true,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    // The cloud answers with the file's BlobMetadata, which needs its list item id too.
    const resource = created?.UniqueId
      ? `GetFileById('${created.UniqueId}')`
      : `GetFileByServerRelativeUrl('${this.encodeSharePointPath(`${serverRelativePath}/${fileName}`)}')`;
    return this.toBlobMetadata(siteUrl, await this.fetchBlobSource(siteUrl, resource, false, ctx), false);
  }

  private async getFileContent(inputs: Record<string, unknown>, ctx: RunContext): Promise<FileContentResult> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const fileId = this.normalizeValue(inputs.fileId);

    if (!siteUrl || !fileId) throw new Error('getFileContent requires siteUrl and fileId');

    const resource = this.fileResource(siteUrl, fileId);
    let fileName = this.fileNameFromId(fileId);
    if (fileName === undefined && this.wantsInferredContentType(inputs)) {
      // A GUID id carries no name; one metadata call gets the extension.
      const meta = await this.spGet<{ Name?: string }>(`${siteUrl}/_api/web/${resource}?$select=Name`, ctx.log);
      fileName = meta?.Name;
    }
    return this.downloadFile(`${siteUrl}/_api/web/${resource}/$value`, fileName, inputs, ctx);
  }

  private async getFileContentByPath(inputs: Record<string, unknown>, ctx: RunContext): Promise<FileContentResult> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const path = String(inputs.path);

    if (!siteUrl || !path) throw new Error('getFileContentByPath requires siteUrl and path');

    const serverRelativePath = this.toServerRelativePath(siteUrl, path);
    const url = `${siteUrl}/_api/web/GetFileByServerRelativeUrl('${this.encodeSharePointPath(serverRelativePath)}')/$value`;
    return this.downloadFile(url, path.split('/').pop(), inputs, ctx);
  }

  /**
   * Download a file the way the cloud connector reports it. The content type
   * is inferred from the file extension (e.g. `text/xml` for .xml) unless
   * `inferContentType` is false, in which case it is `application/octet-stream`
   * — SharePoint's own `$value` content-type header is ignored either way.
   * The body then follows Logic Apps content handling for that type:
   * `application/json` is parsed, `text/*` is the decoded text, and anything
   * else is the base64 envelope `{ "$content-type", "$content" }`.
   */
  private async downloadFile(
    url: string,
    fileName: string | undefined,
    inputs: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<FileContentResult> {
    const result = await this.spRequest<{ $content: string }>('GET', url, ctx.log, {
      headers: { Accept: 'application/octet-stream' },
      binary: true,
    });
    const contentType = this.wantsInferredContentType(inputs) ? inferFileContentType(fileName) : 'application/octet-stream';
    return toCloudFileContent(result.$content, contentType);
  }

  /** The cloud default for inferContentType is true; only an explicit false turns it off. */
  private wantsInferredContentType(inputs: Record<string, unknown>): boolean {
    const v = inputs.inferContentType;
    return !(v === false || (typeof v === 'string' && v.toLowerCase() === 'false'));
  }

  /** File name from a Power Automate path identifier; undefined for a GUID id. */
  private fileNameFromId(fileId: string): string | undefined {
    if (/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i.test(fileId)) return undefined;
    return this.decodeFileIdentifier(fileId).split('/').pop();
  }

  private async updateFile(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const fileId = this.normalizeValue(inputs.fileId);
    const rawContent = inputs.content;

    if (!siteUrl || !fileId || rawContent == null) {
      throw new Error('updateFile requires siteUrl, fileId and content');
    }

    const content = this.resolveFileContent(rawContent);
    const resource = this.fileResource(siteUrl, fileId);
    await this.spPost(`${siteUrl}/_api/web/${resource}/$value`, ctx.log, {
      body: content,
      rawBody: true,
      headers: { 'X-HTTP-Method': 'PUT', 'Content-Type': 'application/octet-stream' },
    });
    return this.toBlobMetadata(siteUrl, await this.fetchBlobSource(siteUrl, resource, false, ctx), false);
  }

  // The cloud's DeleteFile has no body.
  private async deleteFile(inputs: Record<string, unknown>, ctx: RunContext): Promise<undefined> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const fileId = this.normalizeValue(inputs.fileId);

    if (!siteUrl || !fileId) throw new Error('deleteFile requires siteUrl and fileId');

    const url = `${siteUrl}/_api/web/${this.fileResource(siteUrl, fileId)}`;
    await this.spPost(url, ctx.log, {
      headers: { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' },
    });
    return undefined;
  }

  private copyFile(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    return this.transfer('File', 'Copy', inputs, ctx);
  }

  private moveFile(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    return this.transfer('File', 'Move', inputs, ctx);
  }

  private async getFileMetadata(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const fileId = this.normalizeValue(inputs.fileId);

    if (!siteUrl || !fileId) throw new Error('getFileMetadata requires siteUrl and fileId');
    return this.toBlobMetadata(siteUrl, await this.fetchBlobSource(siteUrl, this.fileResource(siteUrl, fileId), false, ctx), false);
  }

  private async getFileMetadataByPath(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const path = String(inputs.path);

    if (!siteUrl || !path) throw new Error('getFileMetadataByPath requires siteUrl and path');
    const serverRelativePath = this.toServerRelativePath(siteUrl, path);
    const resource = `GetFileByServerRelativeUrl('${this.encodeSharePointPath(serverRelativePath)}')`;
    return this.toBlobMetadata(siteUrl, await this.fetchBlobSource(siteUrl, resource, false, ctx), false);
  }

  private async getFileProperties(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);

    if (!siteUrl || !listId || !itemId) {
      throw new Error('getFileProperties requires siteUrl, listId and itemId');
    }

    return this.getSingleItemCloudShape(siteUrl, listId, itemId, ctx);
  }

  // Like PatchItem: designer field format in, the item as GetFileItem returns it out.
  private async updateFileProperties(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);
    const fields = inputs.fields as Record<string, unknown>;

    if (!siteUrl || !listId || !itemId || !fields) {
      throw new Error('updateFileProperties requires siteUrl, listId, itemId and fields');
    }

    const url = `${siteUrl}/_api/web/lists(guid'${listId}')/items(${itemId})`;

    await this.spPost(url, ctx.log, {
      body: await this.toRestFields(siteUrl, listId, fields, ctx),
      headers: { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' },
    });
    return this.getSingleItemCloudShape(siteUrl, listId, itemId, ctx);
  }

  private async getFilesPropertiesOnly(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);

    if (!siteUrl || !listId) throw new Error('getFilesPropertiesOnly requires siteUrl and listId');

    const folderPath = inputs.folderPath ? String(inputs.folderPath) : null;
    const filter = inputs.filter as string | undefined;

    // Folder scoping. A `FileDirRef eq` $filter is not indexable, so on a library
    // over the 5,000-item list view threshold SharePoint rejects it outright. The
    // threshold-safe form is a CAML GetItems scoped with FolderServerRelativeUrl:
    // SharePoint then evaluates only that folder's items. GetItems takes $select/
    // $expand on the URL but ignores $filter/$orderby/$top/$skip, so the scoped
    // POST is used only when none of those OData inputs is set; otherwise the
    // original items GET (folder as $filter) is kept so no existing input is lost.
    const folderScoped = !!folderPath && !filter && !inputs.orderby && !inputs.top && !inputs.skip;
    if (folderScoped) {
      // Cloud "Include Nested Items" defaults to true: the whole subtree. A bare
      // <View> (no Scope) returns the folder's direct children, files and subfolders.
      const nested = inputs.includeNestedItems !== false && inputs.includeNestedItems !== 'false';
      const query = {
        ViewXml: `<View${nested ? " Scope='RecursiveAll'" : ''}><RowLimit>5000</RowLimit></View>`,
        FolderServerRelativeUrl: this.toServerRelativeFolderPath(siteUrl, folderPath),
      };
      // CAML GetItems rejects $expand ("The $expand query is not valid for field 'Author'"),
      // so it only finds the folder's items; they are then read like GetItems reads them,
      // filtered by ID (the primary key is indexed, so this stays threshold-safe).
      const found = await this.spPost<{ value?: Array<{ Id?: number; ID?: number }> }>(
        `${siteUrl}/_api/web/lists(guid'${listId}')/GetItems?$select=Id`,
        ctx.log,
        { body: { query } },
      );
      const ids = (found.value ?? []).map((v) => v.Id ?? v.ID).filter((n): n is number => typeof n === 'number');
      const value: unknown[] = [];
      for (let i = 0; i < ids.length; i += 40) {
        const chunk = ids.slice(i, i + 40);
        const page = (await this.getItems(
          { siteUrl, listId, filter: chunk.map((id) => `ID eq ${id}`).join(' or '), orderby: 'ID' },
          ctx,
        )) as { value?: unknown[] };
        value.push(...(page.value ?? []));
      }
      return { value };
    }

    let combinedFilter = filter;
    if (folderPath) {
      const folderFilter = `FileDirRef eq '${this.toServerRelativeFolderPath(siteUrl, folderPath).replace(/'/g, "''")}'`;
      combinedFilter = filter ? `(${folderFilter}) and (${filter})` : folderFilter;
    }
    return this.getItems(
      { siteUrl, listId, filter: combinedFilter, orderby: inputs.orderby, top: inputs.top, skip: inputs.skip },
      ctx,
    );
  }

  /** Normalize a folder path for CamlQuery.FolderServerRelativeUrl. The cloud
   *  connector's folder picker yields a site-relative path ("Shared Documents/X"
   *  or "/Shared Documents/X"); a server-relative one ("/sites/s/Shared Documents/X")
   *  is passed through. Both forms are accepted so a flow authored against the
   *  cloud shape and one written by hand behave the same locally. */
  private toServerRelativeFolderPath(siteUrl: string, folderPath: string): string {
    const sitePath = new URL(siteUrl).pathname.replace(/\/+$/, ''); // '' for a root site
    const trimmed = folderPath.replace(/\/+$/, '');
    const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    if (sitePath && (withSlash === sitePath || withSlash.startsWith(`${sitePath}/`))) return withSlash;
    return `${sitePath}${withSlash}`;
  }

  private async getItemChanges(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);
    const since = inputs.since as string | undefined;
    const until = inputs.until as string | undefined;

    if (!siteUrl || !listId || !itemId) {
      throw new Error('getItemChanges requires siteUrl, listId and itemId');
    }

    const body = await this.spGet<{ value: Array<{ Created: string }> }>(
      `${siteUrl}/_api/web/lists(guid'${listId}')/items(${itemId})/versions`,
      ctx.log
    );

    // Filter by date range if specified
    if ((since || until) && body.value) {
      const sinceDate = since ? new Date(since) : null;
      const untilDate = until ? new Date(until) : null;

      body.value = body.value.filter((version) => {
        const versionDate = new Date(version.Created);
        if (sinceDate && versionDate < sinceDate) return false;
        if (untilDate && versionDate > untilDate) return false;
        return true;
      });
    }

    return body;
  }

  // ============= Attachment Operations =============

  /**
   * An attachment as the cloud reports it (SPListItemAttachment): `Id` is the identifier of its
   * site-relative path ("/Lists/My List/Attachments/1/a.txt"), which GetAttachmentContent and
   * DeleteAttachment take back; `AbsoluteUri` keeps the path unencoded.
   */
  private toAttachment(siteUrl: string, raw: { FileName?: string; ServerRelativeUrl?: string }): Record<string, unknown> {
    const { origin, pathname } = new URL(siteUrl);
    const sitePath = pathname.replace(/\/+$/, '');
    const serverRelative = String(raw.ServerRelativeUrl ?? '');
    const path = sitePath && serverRelative.startsWith(`${sitePath}/`) ? serverRelative.slice(sitePath.length) : serverRelative;
    return {
      Id: encodeFileIdentifier(path),
      AbsoluteUri: `${origin}${serverRelative}`,
      DisplayName: raw.FileName ?? path.split('/').pop(),
      '@odata.type': `${SP_TYPE}.SPListItemAttachment`,
    };
  }

  /** The file name an attachment id stands for: the cloud's path identifier or a plain name. */
  private attachmentFileName(attachmentId: string): string {
    return this.decodeFileIdentifier(attachmentId).split('/').pop() ?? attachmentId;
  }

  private attachmentResource(siteUrl: string, listId: string, itemId: string, attachmentId: string): string {
    const name = this.attachmentFileName(attachmentId).replace(/'/g, "''");
    return `${siteUrl}/_api/web/lists(guid'${listId}')/items(${itemId})/AttachmentFiles('${encodeURIComponent(name)}')`;
  }

  /**
   * Add attachment: the cloud's call (AddUsingPath, name form-encoded) so that a failure reports
   * the same `source`; its failure body is { status, message, source, errors } like HttpRequest's.
   */
  private async addAttachment(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);
    const fileName = String(inputs.fileName);
    const content = inputs.content;

    if (!siteUrl || !listId || !itemId || !fileName || content == null) {
      throw new Error('addAttachment requires siteUrl, listId, itemId, fileName and content');
    }

    const name = encodeURIComponent(fileName.replace(/'/g, "''")).replace(/%20/g, '+');
    const url = `${siteUrl}/_api/web/lists(guid'${listId}')/Items(${itemId})/AttachmentFiles/AddUsingPath(decodedUrl=@f)?@f='${name}'`;
    try {
      const added = await this.spPost<{ FileName?: string; ServerRelativeUrl?: string }>(url, ctx.log, {
        body: this.resolveFileContent(content),
        rawBody: true,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      return this.toAttachment(siteUrl, added);
    } catch (err) {
      if (err instanceof HttpError) Object.assign(err, { source: url });
      throw err;
    }
  }

  private async getAttachments(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);

    if (!siteUrl || !listId || !itemId) {
      throw new Error('getAttachments requires siteUrl, listId and itemId');
    }

    const data = await this.spGet<{ value?: Array<{ FileName?: string; ServerRelativeUrl?: string }> }>(
      `${siteUrl}/_api/web/lists(guid'${listId}')/items(${itemId})/AttachmentFiles`,
      ctx.log
    );
    return (data.value ?? []).map((a) => this.toAttachment(siteUrl, a));
  }

  private async getAttachmentContent(inputs: Record<string, unknown>, ctx: RunContext): Promise<FileContentResult> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);
    const attachmentId = this.normalizeValue(inputs.attachmentId);

    if (!siteUrl || !listId || !itemId || !attachmentId) {
      throw new Error('getAttachmentContent requires siteUrl, listId, itemId and attachmentId');
    }

    // By path, as the cloud reads it: a missing attachment is a 404 (by name it is a 400).
    let path = this.decodeFileIdentifier(attachmentId);
    if (!path.includes('/')) {
      const root = await this.spGet<{ ServerRelativeUrl: string }>(`${siteUrl}/_api/web/lists(guid'${listId}')/RootFolder?$select=ServerRelativeUrl`, ctx.log);
      path = `${root.ServerRelativeUrl}/Attachments/${itemId}/${path}`;
    }
    const serverRelative = this.toServerRelativePath(siteUrl, path);
    const url = `${siteUrl}/_api/web/GetFileByServerRelativeUrl('${this.encodeSharePointPath(serverRelative).replace(/'/g, "''")}')/$value`;
    return this.downloadFile(url, this.attachmentFileName(attachmentId), inputs, ctx);
  }

  // The cloud's DeleteAttachment has no body.
  private async deleteAttachment(inputs: Record<string, unknown>, ctx: RunContext): Promise<undefined> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);
    const attachmentId = this.normalizeValue(inputs.attachmentId);

    if (!siteUrl || !listId || !itemId || !attachmentId) {
      throw new Error('deleteAttachment requires siteUrl, listId, itemId and attachmentId');
    }

    await this.spDelete(this.attachmentResource(siteUrl, listId, itemId, attachmentId), ctx.log);
    return undefined;
  }

  // ============= Check In/Out Operations =============

  /**
   * The file a check in/out call addresses: the cloud passes the library item (`table` + `id`),
   * a local call may pass a file identifier instead.
   */
  private checkFileResource(inputs: Record<string, unknown>, siteUrl: string, op: string): string {
    if (inputs.listId && inputs.itemId) {
      return `lists(guid'${this.normalizeValue(inputs.listId)}')/items(${this.normalizeValue(inputs.itemId)})/File`;
    }
    if (inputs.fileId) return this.fileResource(siteUrl, this.normalizeValue(inputs.fileId));
    throw new Error(`${op} requires siteUrl and table + id (or a file id)`);
  }

  // Check out / check in / discard check out answer 200 with no body.
  private async checkOutFile(inputs: Record<string, unknown>, ctx: RunContext): Promise<undefined> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    await this.spPost(`${siteUrl}/_api/web/${this.checkFileResource(inputs, siteUrl, 'CheckOutFile')}/CheckOut()`, ctx.log);
    return undefined;
  }

  private async checkInFile(inputs: Record<string, unknown>, ctx: RunContext): Promise<undefined> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const comment = inputs.comment ? String(inputs.comment) : '';
    // 0 = minor version, 1 = major version, 2 = overwrite (the designer's "Choose type of check in")
    const checkInType = inputs.checkInType != null ? Number(inputs.checkInType) : 1;

    const resource = this.checkFileResource(inputs, siteUrl, 'CheckInFile');
    const url = `${siteUrl}/_api/web/${resource}/CheckIn(comment=@c,checkintype=${checkInType})?@c='${encodeURIComponent(comment.replace(/'/g, "''"))}'`;
    await this.spPost(url, ctx.log);
    return undefined;
  }

  private async discardCheckOut(inputs: Record<string, unknown>, ctx: RunContext): Promise<undefined> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    await this.spPost(`${siteUrl}/_api/web/${this.checkFileResource(inputs, siteUrl, 'DiscardFileCheckOut')}/UndoCheckOut()`, ctx.log);
    return undefined;
  }

  // ============= Sharing Operations =============

  private async createSharingLink(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const itemId = this.normalizeValue(inputs.itemId);
    const linkType = String(inputs.linkType || 'view');
    const scope = String(inputs.scope || 'anonymous');

    if (!siteUrl || !itemId || !linkType) {
      throw new Error('createSharingLink requires siteUrl, itemId and linkType');
    }

    const linkTypeMap: Record<string, number> = { view: 1, edit: 2, embed: 3 };
    const scopeMap: Record<string, number> = { anonymous: 1, organization: 2, users: 4 };

    const requestBody: Record<string, unknown> = {
      request: {
        createLink: true,
        settings: {
          linkKind: linkTypeMap[linkType] || 1,
          shareId: scopeMap[scope] || 1,
        },
      },
    };

    if (inputs.expirationDateTime) {
      (requestBody.request as Record<string, unknown>).settings = {
        ...(requestBody.request as Record<string, unknown>).settings as Record<string, unknown>,
        expiration: String(inputs.expirationDateTime),
      };
    }

    const url = `${siteUrl}/_api/web/GetFileById('${itemId}')/ListItemAllFields/ShareLink`;
    return this.spPost(url, ctx.log, { body: requestBody });
  }

  private async grantAccess(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const itemId = this.normalizeValue(inputs.itemId);
    const recipients = inputs.recipients;
    const roleValue = String(inputs.roleValue || 'view');

    if (!siteUrl || !itemId || !recipients || !roleValue) {
      throw new Error('grantAccess requires siteUrl, itemId, recipients and roleValue');
    }

    const recipientList = parseStringList(recipients as string | string[]);
    const roleMap: Record<string, number> = { view: 1, edit: 2, owner: 3 };

    const requestBody: Record<string, unknown> = {
      request: {
        peoplePickerInput: recipientList,
        roleValue: roleMap[roleValue] || 1,
        sendEmail: inputs.sendEmail !== false,
        requireSignIn: inputs.requireSignIn !== false,
      },
    };

    if (inputs.emailSubject) {
      (requestBody.request as Record<string, unknown>).emailSubject = String(inputs.emailSubject);
    }
    if (inputs.emailBody) {
      (requestBody.request as Record<string, unknown>).emailBody = String(inputs.emailBody);
    }

    const url = `${siteUrl}/_api/web/GetFileById('${itemId}')/ListItemAllFields/ShareLink`;
    return this.spPost(url, ctx.log, { body: requestBody });
  }

  private async stopSharing(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const itemId = this.normalizeValue(inputs.itemId);

    if (!siteUrl || !itemId) throw new Error('stopSharing requires siteUrl and itemId');

    await this.spPost(`${siteUrl}/_api/web/GetFileById('${itemId}')/ListItemAllFields/UnshareLink`, ctx.log);
    return { ok: true, status: 200 };
  }

  // ============= Content Approval =============

  private async setContentApprovalStatus(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number; approvalStatus: number }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);
    const approvalStatus = String(inputs.approvalStatus);
    const comments = inputs.comments ? String(inputs.comments) : '';

    if (!siteUrl || !listId || !itemId || approvalStatus == null) {
      throw new Error('setContentApprovalStatus requires siteUrl, listId, itemId and approvalStatus');
    }

    const statusMap: Record<string, number> = { Approved: 0, Rejected: 1, Pending: 2, Draft: 3 };
    const statusValue = statusMap[approvalStatus] !== undefined
      ? statusMap[approvalStatus]
      : parseInt(approvalStatus, 10);

    if (isNaN(statusValue) || statusValue < 0 || statusValue > 3) {
      throw new Error(`Invalid approvalStatus: ${approvalStatus}`);
    }

    const requestBody: Record<string, unknown> = {
      _ModerationStatus: statusValue,
    };

    if (comments) requestBody._ModerationComments = comments;

    const url = `${siteUrl}/_api/web/lists(guid'${listId}')/items(${itemId})`;
    await this.spPost(url, ctx.log, {
      body: requestBody,
      headers: { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' },
    });

    return { ok: true, status: 204, approvalStatus: statusValue };
  }

  private async getContentApprovalStatus(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);

    if (!siteUrl || !listId || !itemId) {
      throw new Error('getContentApprovalStatus requires siteUrl, listId and itemId');
    }

    const url = `${siteUrl}/_api/web/lists(guid'${listId}')/items(${itemId})?$select=Id,Title,_ModerationStatus,_ModerationComments,Modified,Editor/Title&$expand=Editor`;
    const body = await this.spGet<Record<string, unknown>>(url, ctx.log);

    const statusNames = ['Approved', 'Rejected', 'Pending', 'Draft'];
    const statusText = body._ModerationStatus !== undefined
      ? statusNames[body._ModerationStatus as number] || 'Unknown'
      : 'No approval required';

    return { ...body, approvalStatusText: statusText };
  }

  // ============= List Operations =============

  private async getLists(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    if (!siteUrl) throw new Error('getLists requires siteUrl');

    const queryParams = ['$select=Id,Title,BaseTemplate'];
    if (inputs.filter) queryParams.push(`$filter=${encodeURIComponent(String(inputs.filter))}`);

    const url = `${siteUrl}/_api/web/lists?${queryParams.join('&')}`;
    const body = await this.spGet<{ value: Array<{ Id: string; Title: string; BaseTemplate: number }> }>(url, ctx.log);

    // Transform to Power Automate format
    if (body.value) {
      body.value = body.value.map((list) => ({
        Name: list.Id,
        DisplayName: list.Title,
        Type: String(list.BaseTemplate),
      })) as unknown as Array<{ Id: string; Title: string; BaseTemplate: number }>;
    }

    return body;
  }

  private async getListViews(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);

    if (!siteUrl || !listId) throw new Error('getListViews requires siteUrl and listId');

    const url = `${siteUrl}/_api/web/lists(guid'${listId}')/views?$select=Id,Title,ViewType,ViewQuery,ViewFields,DefaultView,Hidden,RowLimit,ServerRelativeUrl`;
    return this.spGet(url, ctx.log);
  }

  // ============= User Operations =============

  private async resolvePerson(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const email = inputs.email || inputs.loginName;

    if (!siteUrl || !email) {
      throw new Error('resolvePerson requires siteUrl and either email or loginName');
    }

    return this.spPost(`${siteUrl}/_api/web/ensureuser`, ctx.log, {
      body: { logonName: String(email) },
    });
  }

  // ============= HTTP Request =============

  /**
   * "Send an HTTP request to SharePoint" (HttpRequest). The response is shaped the way the cloud
   * connector returns it (conformance/flows/sp-http.ff.ts): JSON without its top-level null properties, any
   * other content as { $content-type, $content } (base64), no body for an empty response, and
   * Content-Type re-formatted with "; " between its parts. A failure carries what errorOutputs
   * needs for the cloud's { status, message, source, errors } body.
   */
  private async sendHttpRequest(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ statusCode: number; headers: Record<string, string>; body?: unknown }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    let uri = String(inputs.uri);
    const method = inputs.method ? String(inputs.method).toUpperCase() : 'GET';
    const customHeaders = inputs.headers as Record<string, string> | undefined;
    const body = inputs.body;

    if (!siteUrl || !uri) throw new Error('sendHttpRequest requires siteUrl and uri');

    // Ensure URI starts with /_api/
    if (!uri.startsWith('/_api/') && !uri.startsWith('_api/')) {
      uri = '/_api/' + uri.replace(/^\//, '');
    }

    const url = `${siteUrl}${uri.startsWith('/') ? uri : '/' + uri}`;
    const clientRequestId = crypto.randomUUID();
    // The cloud's default Accept is OData verbose ({ d: { ... } } / { d: { results: [] } });
    // callers can override it via custom headers.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json;odata=verbose',
      'client-request-id': clientRequestId,
      ...customHeaders,
    };

    if (['POST', 'PATCH', 'PUT'].includes(method) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json;odata=verbose';
    }

    ctx.log?.({ type: 'sp.request', method, url });

    const fetchOptions: RequestInit = { method, headers };
    if (body && ['POST', 'PATCH', 'PUT'].includes(method)) {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const res = await fetch(url, fetchOptions);
    const contentType = res.headers.get('content-type') || '';
    const bytes = new Uint8Array(await res.arrayBuffer());

    let responseBody: unknown;
    if (bytes.length === 0) {
      responseBody = undefined;
    } else if (contentType.includes('application/json')) {
      responseBody = JSON.parse(new TextDecoder().decode(bytes));
    } else {
      responseBody = { '$content-type': formatContentType(contentType) || 'application/octet-stream', '$content': bytesBase64(bytes) };
    }

    if (!res.ok) {
      const errorMsg = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
      const err = new HttpError(`SharePoint sendHttpRequest failed: ${res.status} - ${errorMsg}`, res.status, responseBody);
      Object.assign(err, {
        source: url.replace(/ /g, '%20'),
        clientRequestId: res.headers.get('client-request-id') ?? clientRequestId,
        serviceRequestId: res.headers.get('sprequestguid') ?? res.headers.get('request-id') ?? undefined,
      });
      throw err;
    }

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = key.toLowerCase() === 'content-type' ? formatContentType(value) : value;
    });

    return {
      statusCode: res.status,
      headers: responseHeaders,
      ...(responseBody === undefined ? {} : { body: withoutNulls(responseBody) }),
    };
  }
}

/** "application/json;odata=verbose;charset=utf-8" → "application/json; odata=verbose; charset=utf-8", as .NET writes it. */
function formatContentType(value: string): string {
  return value.split(';').map((p) => p.trim()).filter(Boolean).join('; ');
}

/** Bytes → base64 (btoa exists in browsers and Node 16+). */
function bytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * The cloud's failure body for HttpRequest: SharePoint's message with the request ids appended,
 * the request URL, and the error code split into its parts.
 */
function httpRequestErrorOutputs(e: {
  status?: number;
  message?: string;
  response?: unknown;
  source?: string;
  clientRequestId?: string;
  serviceRequestId?: string;
}): { statusCode: number; body: unknown } {
  const r = e.response as Record<string, any> | undefined;
  const error = r?.error ?? r?.['odata.error'];
  const spMessage = typeof error?.message === 'string' ? error.message : error?.message?.value;
  const ids = [
    e.clientRequestId ? `clientRequestId: ${e.clientRequestId}` : undefined,
    e.serviceRequestId ? `serviceRequestId: ${e.serviceRequestId}` : undefined,
  ].filter(Boolean);
  const body: Record<string, unknown> = {
    status: e.status,
    message: [spMessage ?? e.message ?? '', ...ids].join('\r\n'),
  };
  if (e.source) body.source = e.source;
  if (typeof error?.code === 'string') body.errors = error.code.split(', ');
  return { statusCode: e.status!, body };
}

/** A JSON object without its top-level null properties (the cloud connector drops those, and keeps nested ones). */
function withoutNulls(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null));
}

export default SharePointConnector;

// Export metadata for language service
export { sharePointMetadata, sharepointScopes } from './metadata.js';
