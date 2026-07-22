/**
 * SharePoint Connector for FlowForger
 *
 * Implements SharePoint REST API operations using SharePoint-specific tokens.
 * Requires a SharePoint access token with resource https://tenant.sharepoint.com
 */

import type { BaseConnector, RunContext } from '@flowforger/engine';
import { extractItemFields, HttpError, buildODataQuery, parseStringList } from '@flowforger/connectors-shared';

export interface SharePointConnectorOptions {
  token: string; // SharePoint access token with resource https://tenant.sharepoint.com
}

// SharePoint REST API headers
const SP_HEADERS = {
  Accept: 'application/json;odata=nometadata',
};

// Re-export HttpError for consumers
export { HttpError };

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

    if (contentType.includes('application/json')) {
      const text = await response.text();
      data = text ? JSON.parse(text) : null;
    } else if (contentType.includes('application/octet-stream') || contentType.includes('image/')) {
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

  async invoke(operation: string, inputs: unknown, ctx: RunContext): Promise<unknown> {
    ctx.log?.({ type: 'sp.invoke', operation, rawInputs: inputs });

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
        throw new Error(`SharePointConnector: unknown operation '${operation}'`);
    }
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
      'GetItemChanges', 'SetContentApprovalStatus', 'GetContentApprovalStatus'];
    if (inputs.id && !inputs.itemId && listItemOps.includes(operation)) {
      normalized.itemId = inputs.id;
    } else if (inputs.id && !inputs.fileId) {
      normalized.fileId = inputs.id;
    }
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
      if (inputs['parameters/includeNestedItems'] !== undefined) normalized.includeNestedItems = inputs['parameters/includeNestedItems'];
    }

    // For create/update operations, transform item/* to fields object
    if (['PostItem', 'CreateItem', 'PatchItem', 'UpdateItem'].includes(operation)) {
      const existingFields = (inputs.fields || {}) as Record<string, unknown>;
      const itemFields = extractItemFields(inputs);
      normalized.fields = { ...existingFields, ...itemFields };
    }

    // For SendHttpRequest
    if (operation === 'SendHttpRequest' || operation === 'HttpRequest') {
      if (inputs['parameters/method']) normalized.method = inputs['parameters/method'];
      if (inputs['parameters/uri']) normalized.uri = inputs['parameters/uri'];
      if (inputs['parameters/headers']) normalized.headers = inputs['parameters/headers'];
      if (inputs['parameters/body']) normalized.body = inputs['parameters/body'];
    }

    // For CopyFile / MoveFile
    if (operation === 'CopyFile' || operation === 'MoveFile') {
      if (inputs['parameters/sourceFileId']) normalized.fileId = inputs['parameters/sourceFileId'];
      if (inputs['parameters/destinationDataset']) normalized.destSiteUrl = inputs['parameters/destinationDataset'];
      if (inputs['parameters/destinationFolderPath']) normalized.destFolderPath = inputs['parameters/destinationFolderPath'];
      if (inputs['parameters/nameConflictBehavior'] !== undefined) normalized.nameConflictBehavior = inputs['parameters/nameConflictBehavior'];
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

  private async getExpandableFields(siteUrl: string, listId: string, log?: LogFunction): Promise<ExpandableFieldInfo[]> {
    const cacheKey = `${siteUrl}|${listId}`;
    const cached = this.fieldMetadataCache.get(cacheKey);
    if (cached) return cached;

    const typeFilter = Object.keys(FIELD_KIND_MAP).map((t) => `TypeAsString eq '${t}'`).join(' or ');
    const filter = encodeURIComponent(`(${typeFilter}) and Hidden eq false`);
    const url = `${siteUrl}/_api/web/lists(guid'${listId}')/fields?$filter=${filter}`;
    const data = await this.spGet<{ value?: Array<Record<string, unknown>> }>(url, log);

    const fields: ExpandableFieldInfo[] = [];
    for (const f of data.value ?? []) {
      const mapping = FIELD_KIND_MAP[String(f.TypeAsString)];
      if (!mapping || typeof f.InternalName !== 'string') continue;
      const rawChoices = f.Choices as string[] | { results?: string[] } | undefined;
      fields.push({
        internalName: f.InternalName,
        kind: mapping.kind,
        multi: mapping.multi,
        choices: Array.isArray(rawChoices) ? rawChoices : rawChoices?.results ?? [],
        lookupField: typeof f.LookupField === 'string' && f.LookupField ? f.LookupField : 'Title',
      });
    }
    this.fieldMetadataCache.set(cacheKey, fields);
    return fields;
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

    if (userSelect) {
      const selected = new Set(userSelect.split(',').map((s) => s.trim().split('/')[0]));
      refFields = refFields.filter((f) => selected.has(f.internalName));
    }
    if (refFields.length === 0) return passthrough;

    const userExpandParts = userExpand ? userExpand.split(',').map((s) => s.trim()) : [];
    // With no user $select, '*' covers scalar fields but not expanded
    // navigations — keep the user's own expansions selected as whole entities.
    const selectParts = userSelect ? [userSelect] : ['*', ...userExpandParts];
    const expandParts = [...userExpandParts];
    for (const f of refFields) {
      if (!expandParts.includes(f.internalName)) expandParts.push(f.internalName);
      if (f.kind === 'user') {
        selectParts.push(`${f.internalName}/Id`, `${f.internalName}/Title`, `${f.internalName}/EMail`, `${f.internalName}/Name`);
      } else {
        selectParts.push(`${f.internalName}/Id`, `${f.internalName}/${f.lookupField}`);
      }
    }
    return {
      select: selectParts.join(','),
      expand: expandParts.join(','),
      augmented: true,
      refNames: refFields.map((f) => f.internalName),
    };
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
      Picture: email ? `${siteUrl}/_layouts/15/UserPhoto.aspx?Size=L&AccountName=${encodeURIComponent(email)}` : null,
      Department: null,
      JobTitle: null,
    };
  }

  /** Wrap expandable column values in `item` (in place) to match the cloud connector's output shape. */
  private expandItemFieldValues(siteUrl: string, item: Record<string, unknown>, fields: ExpandableFieldInfo[]): void {
    for (const field of fields) {
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
      if (fields.length === 0) return;
      for (const item of items) {
        if (item && typeof item === 'object') {
          this.expandItemFieldValues(siteUrl, item as Record<string, unknown>, fields);
        }
      }
    } catch (err) {
      ctx.log?.({ type: 'sp.cloud-shape-skipped', error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ============= List Item Operations =============

  private async getItems(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    if (!siteUrl || !listId) throw new Error('getItems requires siteUrl (dataset) and listId (table)');

    const baseQuery = {
      filter: inputs.filter as string,
      top: inputs.top as number,
      orderby: inputs.orderby as string,
      select: inputs.select as string | undefined,
      expand: inputs.expand as string | undefined,
    };
    const aug = await this.resolveRefExpansion(siteUrl, listId, baseQuery.select, baseQuery.expand, ctx);
    const makeUrl = (select?: string, expand?: string) => {
      const qs = buildODataQuery({ ...baseQuery, select, expand });
      return `${siteUrl}/_api/web/lists(guid'${listId}')/items${qs ? '?' + qs : ''}`;
    };

    let body: { value: unknown[] };
    let refNames = aug.refNames;
    try {
      body = await this.spGet<{ value: unknown[] }>(makeUrl(aug.select, aug.expand), ctx.log);
    } catch (err) {
      if (!aug.augmented) throw err;
      // Expanded queries can fail (e.g. lookup column threshold) — retry raw.
      ctx.log?.({ type: 'sp.ref-expansion-fallback', error: err instanceof Error ? err.message : String(err) });
      body = await this.spGet<{ value: unknown[] }>(makeUrl(baseQuery.select, baseQuery.expand), ctx.log);
      refNames = [];
    }
    ctx.log?.({ type: 'sp.response', itemCount: body.value?.length });
    if (Array.isArray(body.value)) {
      await this.applyCloudShape(siteUrl, listId, body.value, ctx, refNames);
    }
    return body;
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
        item = await this.spGet(baseUrl, ctx.log);
        refNames = [];
      }
    } else {
      item = await this.spGet(baseUrl, ctx.log);
    }

    if (item && typeof item === 'object') {
      await this.applyCloudShape(siteUrl, listId, [item], ctx, refNames);
    }
    return item;
  }

  private async createItem(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const fields = inputs.fields as Record<string, unknown>;

    if (!siteUrl || !listId || !fields) {
      throw new Error(`createItem requires siteUrl, listId and fields. Got: ${JSON.stringify({ siteUrl: !!siteUrl, listId: !!listId, fields: !!fields })}`);
    }

    const url = `${siteUrl}/_api/web/lists(guid'${listId}')/items`;

    return this.spPost(url, ctx.log, {
      body: fields,
    });
  }

  private async updateItem(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);
    const fields = inputs.fields as Record<string, unknown>;

    if (!siteUrl || !listId || !itemId || !fields) {
      throw new Error('updateItem requires siteUrl, listId, itemId and fields');
    }

    const url = `${siteUrl}/_api/web/lists(guid'${listId}')/items(${itemId})`;

    await this.spPost(url, ctx.log, {
      body: fields,
      headers: { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' },
    });

    return { ok: true, status: 204 };
  }

  private async deleteItem(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);

    if (!siteUrl || !listId || !itemId) throw new Error('deleteItem requires siteUrl, listId and itemId');

    const url = `${siteUrl}/_api/web/lists(guid'${listId}')/items(${itemId})`;
    await this.spPost(url, ctx.log, {
      headers: { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' },
    });

    return { ok: true, status: 204 };
  }

  // ============= Folder Operations =============

  private async createFolder(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const folderPath = String(inputs.folderPath);

    if (!siteUrl || !listId || !folderPath) {
      throw new Error(`createFolder requires siteUrl, listId and folderPath`);
    }

    // Get root folder URL
    const listInfoUrl = `${siteUrl}/_api/web/lists(guid'${listId}')?$select=RootFolder/ServerRelativeUrl&$expand=RootFolder`;
    const listInfo = await this.spGet<{ RootFolder: { ServerRelativeUrl: string } }>(listInfoUrl, ctx.log);
    const rootFolderUrl = listInfo.RootFolder.ServerRelativeUrl;

    const fullPath = `${rootFolderUrl}/${folderPath}`;
    const addFolderUrl = `${siteUrl}/_api/web/folders/add('${encodeURIComponent(fullPath)}')`;

    return this.spPost(addFolderUrl, ctx.log);
  }

  private async listFolder(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ files: unknown[]; folders: unknown[] }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const folderId = this.normalizeValue(inputs.folderId);

    if (!siteUrl || !folderId) throw new Error('listFolder requires siteUrl and folderId');

    const [files, folders] = await Promise.all([
      this.spGet<{ value: unknown[] }>(`${siteUrl}/_api/web/GetFolderById('${folderId}')/Files`, ctx.log),
      this.spGet<{ value: unknown[] }>(`${siteUrl}/_api/web/GetFolderById('${folderId}')/Folders`, ctx.log),
    ]);

    return { files: files.value || [], folders: folders.value || [] };
  }

  private async listRootFolder(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ files: unknown[]; folders: unknown[] }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const folderPath = inputs.folderPath ? String(inputs.folderPath) : '/Shared Documents';

    if (!siteUrl) throw new Error('listRootFolder requires siteUrl');

    const serverRelativePath = this.toServerRelativePath(siteUrl, folderPath);
    const encodedPath = this.encodeSharePointPath(serverRelativePath);
    const [files, folders] = await Promise.all([
      this.spGet<{ value: unknown[] }>(`${siteUrl}/_api/web/GetFolderByServerRelativeUrl('${encodedPath}')/Files`, ctx.log),
      this.spGet<{ value: unknown[] }>(`${siteUrl}/_api/web/GetFolderByServerRelativeUrl('${encodedPath}')/Folders`, ctx.log),
    ]);

    return { files: files.value || [], folders: folders.value || [] };
  }

  private async getFolderMetadata(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const folderId = this.normalizeValue(inputs.folderId);

    if (!siteUrl || !folderId) throw new Error('getFolderMetadata requires siteUrl and folderId');
    return this.spGet(`${siteUrl}/_api/web/GetFolderById('${folderId}')`, ctx.log);
  }

  private async getFolderMetadataByPath(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const path = String(inputs.path);

    if (!siteUrl || !path) throw new Error('getFolderMetadataByPath requires siteUrl and path');
    const serverRelativePath = this.toServerRelativePath(siteUrl, path);
    return this.spGet(`${siteUrl}/_api/web/GetFolderByServerRelativeUrl('${this.encodeSharePointPath(serverRelativePath)}')`, ctx.log);
  }

  private async copyFolder(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number; destUrl: string }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const folderId = this.normalizeValue(inputs.folderId);
    const destFolderPath = String(inputs.destFolderPath);

    if (!siteUrl || !folderId || !destFolderPath) {
      throw new Error('copyFolder requires siteUrl, folderId, and destFolderPath');
    }

    const url = `${siteUrl}/_api/web/GetFolderById('${folderId}')/copyto(strnewurl='${encodeURIComponent(destFolderPath)}',boverwrite=true)`;
    await this.spPost(url, ctx.log);
    return { ok: true, status: 200, destUrl: destFolderPath };
  }

  private async moveFolder(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number; destUrl: string }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const folderId = this.normalizeValue(inputs.folderId);
    const destFolderPath = String(inputs.destFolderPath);

    if (!siteUrl || !folderId || !destFolderPath) {
      throw new Error('moveFolder requires siteUrl, folderId, and destFolderPath');
    }

    const url = `${siteUrl}/_api/web/GetFolderById('${folderId}')/moveto(newurl='${encodeURIComponent(destFolderPath)}',flags=1)`;
    await this.spPost(url, ctx.log);
    return { ok: true, status: 200, destUrl: destFolderPath };
  }

  private async extractFolder(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number; destination: string }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const source = String(inputs.source);
    const destination = String(inputs.destination);

    if (!siteUrl || !source || !destination) {
      throw new Error('extractFolder requires siteUrl, source and destination');
    }

    const url = `${siteUrl}/_api/SP.CompressedFolder.extractToFolder(sourceUrl='${encodeURIComponent(source)}',destinationUrl='${encodeURIComponent(destination)}',boverwrite=true)`;
    await this.spPost(url, ctx.log);
    return { ok: true, status: 200, destination };
  }

  // ============= File Operations =============

  private async createFile(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const folderPath = String(inputs.folderPath);
    const fileName = String(inputs.fileName);
    const rawContent = inputs.content;

    if (!siteUrl || !folderPath || !fileName || rawContent === undefined) {
      throw new Error('createFile requires siteUrl, folderPath, fileName and content');
    }

    const content = this.resolveFileContent(rawContent);
    const serverRelativePath = this.toServerRelativePath(siteUrl, folderPath);
    const url = `${siteUrl}/_api/web/GetFolderByServerRelativeUrl('${this.encodeSharePointPath(serverRelativePath)}')/Files/add(url='${encodeURIComponent(fileName)}',overwrite=true)`;
    return this.spPost(url, ctx.log, {
      body: content,
      rawBody: true,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }

  private async getFileContent(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ $content: string; $contentType: string }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const fileId = this.normalizeValue(inputs.fileId);

    if (!siteUrl || !fileId) throw new Error('getFileContent requires siteUrl and fileId');

    const url = `${siteUrl}/_api/web/GetFileById('${fileId}')/$value`;
    return this.spGet(url, ctx.log, { Accept: 'application/octet-stream' });
  }

  private async getFileContentByPath(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ $content: string; $contentType: string }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const path = String(inputs.path);

    if (!siteUrl || !path) throw new Error('getFileContentByPath requires siteUrl and path');

    const serverRelativePath = this.toServerRelativePath(siteUrl, path);
    const url = `${siteUrl}/_api/web/GetFileByServerRelativeUrl('${this.encodeSharePointPath(serverRelativePath)}')/$value`;
    return this.spGet(url, ctx.log, { Accept: 'application/octet-stream' });
  }

  private async updateFile(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const fileId = this.normalizeValue(inputs.fileId);
    const rawContent = inputs.content;

    if (!siteUrl || !fileId || rawContent === undefined) {
      throw new Error('updateFile requires siteUrl, fileId and content');
    }

    const content = this.resolveFileContent(rawContent);
    const url = `${siteUrl}/_api/web/GetFileById('${fileId}')/$value`;
    await this.spPost(url, ctx.log, {
      body: content,
      rawBody: true,
      headers: { 'X-HTTP-Method': 'PUT', 'Content-Type': 'application/octet-stream' },
    });

    return { ok: true, status: 200 };
  }

  private async deleteFile(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const fileId = this.normalizeValue(inputs.fileId);

    if (!siteUrl || !fileId) throw new Error('deleteFile requires siteUrl and fileId');

    const url = `${siteUrl}/_api/web/GetFileById('${fileId}')`;
    await this.spPost(url, ctx.log, {
      headers: { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' },
    });

    return { ok: true, status: 200 };
  }

  private async copyFile(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number; destUrl: string }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const fileId = this.normalizeValue(inputs.fileId);
    const destSiteUrl = inputs.destSiteUrl ? this.normalizeSiteUrl(inputs.destSiteUrl) : siteUrl;
    const rawDestFolderPath = String(inputs.destFolderPath);
    const nameConflictBehavior = Number(inputs.nameConflictBehavior ?? 1);

    if (!siteUrl || !fileId || !rawDestFolderPath) {
      throw new Error('copyFile requires siteUrl, fileId, and destFolderPath');
    }

    const metadata = await this.getFileMetadata({ siteUrl, fileId }, ctx) as { Name: string; ServerRelativeUrl: string };
    const fileName = (inputs.fileName as string | undefined) || metadata.Name;
    const srcPath = metadata.ServerRelativeUrl;
    const destFolderServerRelative = this.toServerRelativePath(destSiteUrl, rawDestFolderPath);
    const destPath = `${destFolderServerRelative}/${fileName}`;

    // nameConflictBehavior: 0=fail, 1=replace, 2=rename (keep both)
    // Build absolute URLs from server-relative paths (extract origin from siteUrl)
    const origin = new URL(siteUrl).origin;
    const absSrcUrl = `${origin}${srcPath}`;
    const absDestUrl = `${origin}${destPath}`;
    const url = `${siteUrl}/_api/SP.MoveCopyUtil.CopyFile`;
    await this.spPost(url, ctx.log, {
      body: {
        srcUrl: absSrcUrl,
        destUrl: absDestUrl,
        options: {
          KeepBoth: nameConflictBehavior === 2,
          ResetAuthorAndCreatedOnCopy: false,
          ShouldBypassSharedLocks: true,
        },
      },
    });
    return { ok: true, status: 200, destUrl: destPath };
  }

  private async moveFile(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number; destUrl: string }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const fileId = this.normalizeValue(inputs.fileId);
    const destSiteUrl = inputs.destSiteUrl ? this.normalizeSiteUrl(inputs.destSiteUrl) : siteUrl;
    const rawDestFolderPath = String(inputs.destFolderPath);
    const nameConflictBehavior = Number(inputs.nameConflictBehavior ?? 1);

    if (!siteUrl || !fileId || !rawDestFolderPath) {
      throw new Error('moveFile requires siteUrl, fileId, and destFolderPath');
    }

    const metadata = await this.getFileMetadata({ siteUrl, fileId }, ctx) as { Name: string; ServerRelativeUrl: string };
    const fileName = (inputs.fileName as string | undefined) || metadata.Name;
    const srcPath = metadata.ServerRelativeUrl;
    const destFolderServerRelative = this.toServerRelativePath(destSiteUrl, rawDestFolderPath);
    const destPath = `${destFolderServerRelative}/${fileName}`;

    // nameConflictBehavior: 0=fail, 1=replace, 2=rename (keep both)
    const origin = new URL(siteUrl).origin;
    const absSrcUrl = `${origin}${srcPath}`;
    const absDestUrl = `${origin}${destPath}`;
    const url = `${siteUrl}/_api/SP.MoveCopyUtil.MoveFile`;
    await this.spPost(url, ctx.log, {
      body: {
        srcUrl: absSrcUrl,
        destUrl: absDestUrl,
        options: {
          KeepBoth: nameConflictBehavior === 2,
          ResetAuthorAndCreatedOnCopy: false,
          ShouldBypassSharedLocks: true,
        },
      },
    });
    return { ok: true, status: 200, destUrl: destPath };
  }

  private async getFileMetadata(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const fileId = this.normalizeValue(inputs.fileId);

    if (!siteUrl || !fileId) throw new Error('getFileMetadata requires siteUrl and fileId');
    return this.spGet(`${siteUrl}/_api/web/GetFileById('${fileId}')`, ctx.log);
  }

  private async getFileMetadataByPath(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const path = String(inputs.path);

    if (!siteUrl || !path) throw new Error('getFileMetadataByPath requires siteUrl and path');
    const serverRelativePath = this.toServerRelativePath(siteUrl, path);
    return this.spGet(`${siteUrl}/_api/web/GetFileByServerRelativeUrl('${this.encodeSharePointPath(serverRelativePath)}')`, ctx.log);
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

  private async updateFileProperties(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);
    const fields = inputs.fields as Record<string, unknown>;

    if (!siteUrl || !listId || !itemId || !fields) {
      throw new Error('updateFileProperties requires siteUrl, listId, itemId and fields');
    }

    const url = `${siteUrl}/_api/web/lists(guid'${listId}')/items(${itemId})`;

    await this.spPost(url, ctx.log, {
      body: fields,
      headers: { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' },
    });

    return { ok: true, status: 204 };
  }

  private async getFilesPropertiesOnly(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);

    if (!siteUrl || !listId) throw new Error('getFilesPropertiesOnly requires siteUrl and listId');

    const queryParams: string[] = [];
    const folderPath = inputs.folderPath ? String(inputs.folderPath) : null;
    const filter = inputs.filter as string | undefined;

    if (folderPath) {
      const folderFilter = `FileDirRef eq '${folderPath}'`;
      queryParams.push(`$filter=${filter ? `(${folderFilter}) and (${filter})` : folderFilter}`);
    } else if (filter) {
      queryParams.push(`$filter=${encodeURIComponent(filter)}`);
    }

    if (inputs.orderby) queryParams.push(`$orderby=${encodeURIComponent(String(inputs.orderby))}`);
    if (inputs.top) queryParams.push(`$top=${inputs.top}`);
    if (inputs.skip) queryParams.push(`$skip=${inputs.skip}`);

    const aug = await this.resolveRefExpansion(siteUrl, listId, undefined, 'File,Folder', ctx);
    const makeUrl = (select?: string, expand?: string) => {
      const parts = [...queryParams];
      if (select) parts.push(`$select=${encodeURIComponent(select)}`);
      parts.push(`$expand=${encodeURIComponent(expand || 'File,Folder')}`);
      return `${siteUrl}/_api/web/lists(guid'${listId}')/items?${parts.join('&')}`;
    };

    let body: { value?: unknown[] };
    let refNames = aug.refNames;
    try {
      body = await this.spGet<{ value?: unknown[] }>(makeUrl(aug.select, aug.expand), ctx.log);
    } catch (err) {
      if (!aug.augmented) throw err;
      ctx.log?.({ type: 'sp.ref-expansion-fallback', error: err instanceof Error ? err.message : String(err) });
      body = await this.spGet<{ value?: unknown[] }>(makeUrl(), ctx.log);
      refNames = [];
    }
    if (Array.isArray(body.value)) {
      await this.applyCloudShape(siteUrl, listId, body.value, ctx, refNames);
    }
    return body;
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

  private async addAttachment(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);
    const fileName = String(inputs.fileName);
    const content = inputs.content;

    if (!siteUrl || !listId || !itemId || !fileName || content === undefined) {
      throw new Error('addAttachment requires siteUrl, listId, itemId, fileName and content');
    }

    const url = `${siteUrl}/_api/web/lists(guid'${listId}')/items(${itemId})/AttachmentFiles/add(FileName='${encodeURIComponent(fileName)}')`;
    return this.spPost(url, ctx.log, {
      body: content,
      rawBody: true,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }

  private async getAttachments(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);

    if (!siteUrl || !listId || !itemId) {
      throw new Error('getAttachments requires siteUrl, listId and itemId');
    }

    return this.spGet(`${siteUrl}/_api/web/lists(guid'${listId}')/items(${itemId})/AttachmentFiles`, ctx.log);
  }

  private async getAttachmentContent(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ $content: string; $contentType: string }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);
    const attachmentId = this.normalizeValue(inputs.attachmentId);

    if (!siteUrl || !listId || !itemId || !attachmentId) {
      throw new Error('getAttachmentContent requires siteUrl, listId, itemId and attachmentId');
    }

    const url = `${siteUrl}/_api/web/lists(guid'${listId}')/items(${itemId})/AttachmentFiles('${encodeURIComponent(attachmentId)}')/$value`;
    return this.spGet(url, ctx.log, { Accept: 'application/octet-stream' });
  }

  private async deleteAttachment(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const listId = this.normalizeValue(inputs.listId);
    const itemId = this.normalizeValue(inputs.itemId);
    const attachmentId = this.normalizeValue(inputs.attachmentId);

    if (!siteUrl || !listId || !itemId || !attachmentId) {
      throw new Error('deleteAttachment requires siteUrl, listId, itemId and attachmentId');
    }

    await this.spDelete(
      `${siteUrl}/_api/web/lists(guid'${listId}')/items(${itemId})/AttachmentFiles('${encodeURIComponent(attachmentId)}')`,
      ctx.log
    );

    return { ok: true, status: 200 };
  }

  // ============= Check In/Out Operations =============

  private async checkOutFile(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const fileId = this.normalizeValue(inputs.fileId);

    if (!siteUrl || !fileId) throw new Error('checkOutFile requires siteUrl and fileId');

    await this.spPost(`${siteUrl}/_api/web/GetFileById('${fileId}')/CheckOut()`, ctx.log);
    return { ok: true, status: 200 };
  }

  private async checkInFile(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const fileId = this.normalizeValue(inputs.fileId);
    const comment = inputs.comment ? String(inputs.comment) : '';
    const checkInType = inputs.checkInType !== undefined ? Number(inputs.checkInType) : 1;

    if (!siteUrl || !fileId) throw new Error('checkInFile requires siteUrl and fileId');

    const url = `${siteUrl}/_api/web/GetFileById('${fileId}')/CheckIn(comment='${encodeURIComponent(comment)}',checkintype=${checkInType})`;
    await this.spPost(url, ctx.log);
    return { ok: true, status: 200 };
  }

  private async discardCheckOut(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number }> {
    const siteUrl = this.normalizeSiteUrl(inputs.siteUrl);
    const fileId = this.normalizeValue(inputs.fileId);

    if (!siteUrl || !fileId) throw new Error('discardCheckOut requires siteUrl and fileId');

    await this.spPost(`${siteUrl}/_api/web/GetFileById('${fileId}')/UndoCheckOut()`, ctx.log);
    return { ok: true, status: 200 };
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

    if (!siteUrl || !listId || !itemId || approvalStatus === undefined) {
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

  private async sendHttpRequest(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ statusCode: number; headers: Record<string, string>; body: unknown }> {
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
    // Default Accept to OData verbose to match Power Automate's "Send an HTTP request to
    // SharePoint" action, which wraps responses as { d: { ... } } / { d: { results: [] } }.
    // DSL converted from PA flows expects this shape; callers can override via custom headers.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json;odata=verbose',
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

    let responseBody: unknown;
    if (contentType.includes('application/json')) {
      responseBody = await res.json();
    } else {
      responseBody = await res.text();
    }

    if (!res.ok) {
      const errorMsg = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
      throw new HttpError(`SharePoint sendHttpRequest failed: ${res.status} - ${errorMsg}`, res.status, responseBody);
    }

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return { statusCode: res.status, headers: responseHeaders, body: responseBody };
  }
}

export default SharePointConnector;

// Export metadata for language service
export { sharePointMetadata, sharepointScopes } from './metadata.js';
