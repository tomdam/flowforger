/**
 * Dataverse Connector for FlowForger
 *
 * Implements Dataverse Web API operations for Power Platform.
 * Requires a Dataverse/Dynamics 365 access token.
 */

import type { BaseConnector, RunContext } from '@flowforger/engine';
import { BaseHttpClient, connectorResponse, extractItemFields, getParam, HttpError } from '@flowforger/connectors-shared';

export interface DataverseConnectorOptions {
  baseUrl: string; // https://org.crm.dynamics.com
  token: string;
}

// OData headers used by Dataverse API
const ODATA_HEADERS = {
  'OData-MaxVersion': '4.0',
  'OData-Version': '4.0',
};

// Re-export HttpError for consumers
export { HttpError };

const INCLUDE_ANNOTATIONS = 'odata.include-annotations="*"';

/**
 * Rows as the cloud connector returns them (conformance/flows/dv-read, dv-expand): columns whose
 * value is null are left out of the row itself — a null lookup's expanded `fft_Account` too — but
 * kept inside expanded related rows. A collection-valued expand's `<nav>@odata.nextLink` names
 * the v9.1 endpoint the connector calls. Applies to a single row or a { value: [...] } page.
 */
export function toCloudRecords<T>(data: T): T {
  const row = (r: unknown): unknown => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return r;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      if (v === null) continue;
      out[k] = k.endsWith('@odata.nextLink') && typeof v === 'string' ? v.replace('/api/data/v9.2/', '/api/data/v9.1/') : v;
    }
    return out;
  };
  const page = data as { value?: unknown };
  if (page && typeof page === 'object' && Array.isArray(page.value)) {
    return { ...page, value: page.value.map(row) } as T;
  }
  return row(data) as T;
}

// Cross-platform base64 encode/decode helpers. Node uses Buffer (fast),
// browsers use btoa/atob (Buffer does not exist there).
function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

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

const LIST_OPTIONS = ['$select', '$filter', '$orderby', '$expand', '$top'];
const GET_OPTIONS = ['$select', '$expand'];

/**
 * OData options the flow passed as null or "" (an expression that found nothing). The cloud
 * connector sends them as empty values (`$filter=`), which Dataverse rejects with a 400 ("The
 * value for OData query '$filter' cannot be empty."), so they are sent the same way.
 */
function emptyODataOptions(inputs: Record<string, unknown>, keys: string[]): string {
  const empty = keys.filter((k) => k in inputs && (inputs[k] === null || inputs[k] === ''));
  return empty.length ? `?${empty.map((k) => `${k}=`).join('&')}` : '';
}

export class DataverseConnector extends BaseHttpClient implements BaseConnector {
  constructor(opts: DataverseConnectorOptions) {
    super(
      `${opts.baseUrl.replace(/\/$/, '')}/api/data/v9.2`,
      opts.token,
      ODATA_HEADERS
    );
  }

  async invoke(operation: string, inputs: unknown, ctx: RunContext): Promise<unknown> {
    ctx.log?.({ type: 'dataverse.invoke', operation, inputs });

    switch (operation) {
      case 'listRows':
      case 'ListRows':
      case 'ListRecords':
        return this.listRows(inputs as Record<string, unknown>, ctx);
      case 'CreateRow':
      case 'CreateRecord':
        return this.createRow(inputs as Record<string, unknown>, ctx);
      case 'UpdateRow':
      case 'UpdateOnlyRecord':
        return this.updateRow(inputs as Record<string, unknown>, ctx);
      // The cloud's "Upsert a row" is UpdateRecord: a PATCH without If-Match.
      case 'UpdateRecord':
      case 'UpsertRow':
      case 'UpsertRecord':
        return this.upsertRow(inputs as Record<string, unknown>, ctx);
      case 'DeleteRow':
      case 'DeleteRecord':
        return this.deleteRow(inputs as Record<string, unknown>, ctx);
      case 'RetrieveRow':
      case 'GetItem':
      case 'GetItemById':
      case 'GetRecord':
        return this.retrieveRow(inputs as Record<string, unknown>, ctx);
      case 'AssociateEntities':
      case 'AssociateRecords':
        return this.associateEntities(inputs as Record<string, unknown>, ctx);
      case 'DisassociateEntities':
      case 'DisassociateRecords':
        return this.disassociateEntities(inputs as Record<string, unknown>, ctx);
      case 'PerformBoundAction':
        return this.performBoundAction(inputs as Record<string, unknown>, ctx);
      case 'PerformUnboundAction':
        return this.performUnboundAction(inputs as Record<string, unknown>, ctx);
      case 'GetEntityFileImageFieldContent':
      case 'GetFileContent':
        return this.getFileContent(inputs as Record<string, unknown>, ctx);
      case 'UpdateEntityFileImageFieldContent':
      case 'UploadFileContent':
        return this.uploadFileContent(inputs as Record<string, unknown>, ctx);
      case 'ExecuteChangeset':
      case 'ExecuteBatch':
        return this.executeChangeset(inputs as Record<string, unknown>, ctx);
      case 'GetRelevantRows':
      case 'RelevanceSearch':
        return this.getRelevantRows(inputs as Record<string, unknown>, ctx);
      default:
        throw new Error(`DataverseConnector: unknown operation '${operation}'`);
    }
  }

  // The cloud answers a create with 201; a delete, (un)relate and file upload with 204 and no
  // body (conformance/flows/dv-*.ff.ts). Upserts, actions and downloads report their status per
  // call (connectorResponse). Failed calls need no errorOutputs(): the Web API's
  // { error: { code, message } } is already the cloud's body.
  successStatusCode(operation: string): number {
    switch (operation) {
      case 'CreateRow':
      case 'CreateRecord':
        return 201;
      case 'DeleteRow':
      case 'DeleteRecord':
      case 'AssociateEntities':
      case 'AssociateRecords':
      case 'DisassociateEntities':
      case 'DisassociateRecords':
      case 'UpdateEntityFileImageFieldContent':
      case 'UploadFileContent':
        return 204;
      default:
        return 200;
    }
  }

  /** A ListRecords continuation page (the engine follows these for a pagination policy). */
  async nextPage(_operation: string, _inputs: unknown, nextLink: string, ctx: RunContext): Promise<unknown> {
    return toCloudRecords(await this.get(nextLink, ctx.log, { headers: { Prefer: INCLUDE_ANNOTATIONS } }));
  }

  // ============= Helper Methods =============

  private getEntityAndId(inputs: Record<string, unknown>): { entityName: string; recordId?: string } {
    const entityName = getParam<string>(inputs, ['entityName', 'entitySetName']);
    const recordId = getParam<string>(inputs, ['recordId', 'id']);
    if (!entityName) throw new Error('Operation requires entityName or entitySetName');
    return { entityName, recordId };
  }

  private getBody(inputs: Record<string, unknown>): Record<string, unknown> {
    // Extract body from either 'body' field or 'item/*' fields
    if (inputs.body && typeof inputs.body === 'object') {
      return inputs.body as Record<string, unknown>;
    }
    return extractItemFields(inputs as Record<string, unknown>);
  }

  // ============= CRUD Operations =============

  private async listRows(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const { entityName } = this.getEntityAndId(inputs);

    const query: Record<string, string | number | boolean | undefined> = {};
    const select = getParam<string>(inputs, ['$select', 'select']);
    const filter = getParam<string>(inputs, ['$filter', 'filter']);
    const top = getParam<number>(inputs, ['$top', 'top']);
    const orderby = getParam<string>(inputs, ['$orderby', 'orderby', 'orderBy']);
    const expand = getParam<string>(inputs, ['$expand', 'expand']);
    const skip = getParam<number>(inputs, ['$skip', 'skip']);
    const skiptoken = getParam<string>(inputs, ['$skiptoken', 'skiptoken', 'skipToken']);
    const apply = getParam<string>(inputs, ['$apply', 'apply']);
    const count = getParam<boolean | string>(inputs, ['$count', 'count']);
    const fetchXml = getParam<string>(inputs, ['fetchXml', 'fetchxml']);

    if (select) query['$select'] = select;
    if (filter) query['$filter'] = filter;
    if (top) query['$top'] = top;
    if (orderby) query['$orderby'] = orderby;
    if (expand) query['$expand'] = expand;
    if (skip) query['$skip'] = skip;
    if (skiptoken) query['$skiptoken'] = skiptoken;
    if (apply) query['$apply'] = apply;
    if (count) query['$count'] = true;
    if (fetchXml) query['fetchXml'] = fetchXml;

    return toCloudRecords(
      await this.get(`/${entityName}${emptyODataOptions(inputs, LIST_OPTIONS)}`, ctx.log, {
        query,
        headers: { Prefer: INCLUDE_ANNOTATIONS },
      })
    );
  }

  private async createRow(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const { entityName } = this.getEntityAndId(inputs);
    const body = this.getBody(inputs);

    const response = await this.post<Record<string, unknown> | string>(`/${entityName}`, ctx.log, {
      body,
      headers: { Prefer: `return=representation,${INCLUDE_ANNOTATIONS}` },
    });

    // Handle response - if no body returned, try to extract ID from OData-EntityId header
    let result = typeof response === 'string' ? (response ? JSON.parse(response) : {}) : response;

    if (!result || Object.keys(result).length === 0) {
      // Fallback: the ID would typically come from the OData-EntityId header
      // but BaseHttpClient doesn't expose headers. For now, return empty.
      result = {};
    }

    // The engine wraps connector outputs in { body: ... }
    return toCloudRecords(result);
  }

  // "Update a row" (UpdateOnlyRecord): If-Match: * makes a missing row fail with 404 instead of
  // creating it. Answers with the updated row, as the cloud does.
  private async updateRow(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    if (!recordId) throw new Error('updateRow requires recordId or id');

    const body = this.getBody(inputs);

    const updated = await this.patch(`/${entityName}(${encodeURIComponent(recordId)})`, ctx.log, {
      body,
      headers: { 'If-Match': '*', Prefer: `return=representation,${INCLUDE_ANNOTATIONS}` },
    });

    return updated && typeof updated === 'object' ? toCloudRecords(updated) : { ok: true };
  }

  // The cloud's DeleteRecord has no body.
  private async deleteRow(inputs: Record<string, unknown>, ctx: RunContext): Promise<undefined> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    if (!recordId) throw new Error('deleteRow requires recordId or id');

    await this.delete(`/${entityName}(${encodeURIComponent(recordId)})`, ctx.log);
    return undefined;
  }

  private async retrieveRow(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    if (!recordId) throw new Error('retrieveRow requires recordId or id');

    const select = getParam<string>(inputs, ['$select', 'select']);
    const expand = getParam<string>(inputs, ['$expand', 'expand']);
    const query: Record<string, string | undefined> = {};
    if (select) query['$select'] = select;
    if (expand) query['$expand'] = expand;

    return toCloudRecords(
      await this.get(`/${entityName}(${encodeURIComponent(recordId)})${emptyODataOptions(inputs, GET_OPTIONS)}`, ctx.log, {
        query,
        headers: { Prefer: INCLUDE_ANNOTATIONS },
      })
    );
  }

  // ============= Relationship Operations =============

  /**
   * The row a relate/unrelate call points at: the cloud's `item/@odata.id` (relate) or `$id`
   * (unrelate) — a row URL such as https://org.crm.dynamics.com/api/data/v9.1/accounts(<id>) —
   * or the local relatedEntityName + relatedRecordId pair.
   */
  private relatedRowUrl(inputs: Record<string, unknown>, odataId: unknown): string | undefined {
    // The cloud connector calls v9.1, so flows carry v9.1 row URLs; the Web API rejects a URL
    // "not based on" the version it is called with, so rebase them onto this client's.
    if (typeof odataId === 'string' && odataId) return odataId.replace(/^https?:\/\/[^/]+\/api\/data\/v[\d.]+(?=\/)/i, this.baseUrl);
    const relatedEntityName = getParam<string>(inputs, ['relatedEntityName', 'relatedEntitySetName']);
    const relatedRecordId = getParam<string>(inputs, ['relatedRecordId', 'relatedId']);
    return relatedEntityName && relatedRecordId
      ? `${this.baseUrl}/${relatedEntityName}(${encodeURIComponent(relatedRecordId)})`
      : undefined;
  }

  private relationshipName(inputs: Record<string, unknown>): string | undefined {
    return getParam<string>(inputs, ['associationEntityRelationship', 'relationshipName', 'navigationProperty']);
  }

  // "Relate rows": 204 and no body.
  private async associateEntities(inputs: Record<string, unknown>, ctx: RunContext): Promise<undefined> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    const relationshipName = this.relationshipName(inputs);
    const related = this.relatedRowUrl(inputs, extractItemFields(inputs)['@odata.id'] ?? (inputs.item as Record<string, unknown> | undefined)?.['@odata.id']);
    if (!recordId || !relationshipName || !related) {
      throw new Error('AssociateEntities requires recordId, associationEntityRelationship and item/@odata.id');
    }

    await this.post(`/${entityName}(${encodeURIComponent(recordId)})/${relationshipName}/$ref`, ctx.log, {
      body: { '@odata.id': related },
    });
    return undefined;
  }

  // "Unrelate rows": DELETE .../<relationship>/$ref?$id=<row URL>; 204 and no body.
  private async disassociateEntities(inputs: Record<string, unknown>, ctx: RunContext): Promise<undefined> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    const relationshipName = this.relationshipName(inputs);
    if (!recordId || !relationshipName) throw new Error('DisassociateEntities requires recordId and associationEntityRelationship');

    const related = this.relatedRowUrl(inputs, inputs['$id']);
    const query = related ? `?$id=${encodeURIComponent(related)}` : '';
    await this.delete(`/${entityName}(${encodeURIComponent(recordId)})/${relationshipName}/$ref${query}`, ctx.log);
    return undefined;
  }

  // ============= Upsert =============

  /**
   * "Upsert a row" (the cloud's UpdateRecord): a PATCH without If-Match, which creates the row
   * when the id is new. Answers with the row and 201 when it created it, 200 when it updated it.
   * Measured quirk: the created row keeps its null columns, the updated one leaves them out.
   */
  private async upsertRow(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    if (!recordId) throw new Error('upsertRow requires recordId or id');

    const { status, data } = await this.requestWithStatus('PATCH', `/${entityName}(${encodeURIComponent(recordId)})`, ctx.log, {
      body: this.getBody(inputs),
      headers: { Prefer: `return=representation,${INCLUDE_ANNOTATIONS}` },
    });
    return connectorResponse(status === 201 ? data : toCloudRecords(data), status);
  }

  // ============= Actions =============

  /** An action's parameters: the designer's `item/*` keys, a nested `item`, or (local) the remaining inputs. */
  private actionParams(inputs: Record<string, unknown>, known: string[]): Record<string, unknown> {
    const itemFields = extractItemFields(inputs);
    if (Object.keys(itemFields).length > 0) return itemFields;
    if (inputs.item && typeof inputs.item === 'object' && !Array.isArray(inputs.item)) {
      return inputs.item as Record<string, unknown>;
    }
    return Object.fromEntries(Object.entries(inputs).filter(([k]) => !known.includes(k)));
  }

  /**
   * POST an action the way the cloud connector does: `actionName` goes into the URL as given
   * (a bound action needs its namespace, `Microsoft.Dynamics.CRM.<name>`; the cloud fails the
   * plain name with 404, and refuses to save a namespaced unbound action). Answers with the
   * response's properties (nulls left out), or with 204 and no body for an action without a response.
   * Without parameters it sends no body at all, as the cloud does (so a missing required parameter
   * fails with Dataverse's "Required field 'X' is missing", not an OData payload error).
   */
  private async performAction(path: string, params: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    // No `Prefer: odata.include-annotations`: the cloud's error bodies for actions carry no
    // @Microsoft.PowerApps.CDS.* annotations.
    const { status, data } = await this.requestWithStatus('POST', path, ctx.log, {
      body: Object.keys(params).length > 0 ? params : undefined,
    });
    return connectorResponse(status === 204 || data === '' ? undefined : toCloudRecords(data), status);
  }

  private async performBoundAction(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    if (!recordId) throw new Error('PerformBoundAction requires recordId');
    const actionName = inputs.actionName as string;
    if (!actionName) throw new Error('PerformBoundAction requires actionName');

    const params = this.actionParams(inputs, ['entityName', 'entitySetName', 'recordId', 'id', 'actionName']);
    return this.performAction(`/${entityName}(${encodeURIComponent(recordId)})/${actionName}`, params, ctx);
  }

  private async performUnboundAction(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const actionName = inputs.actionName as string;
    if (!actionName) throw new Error('PerformUnboundAction requires actionName');

    return this.performAction(`/${actionName}`, this.actionParams(inputs, ['actionName']), ctx);
  }

  // ============= File Operations =============

  private fileFieldName(inputs: Record<string, unknown>): string | undefined {
    return getParam<string>(inputs, ['fileImageFieldName', 'fieldName', 'attributeName']);
  }

  /**
   * "Download a file or an image": the cloud asks for the first 4 MB (Range: bytes=0-4194303),
   * so a file answers 206 — recorded without outputs.statusCode — while an image answers 200, and
   * a full-size image that was never stored 204. The body is { $content-type, $content }.
   */
  private async getFileContent(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    const fieldName = this.fileFieldName(inputs);
    if (!recordId || !fieldName) throw new Error('GetEntityFileImageFieldContent requires recordId and fileImageFieldName');

    const size = getParam<string>(inputs, ['size']);
    const url = `${this.baseUrl}/${entityName}(${encodeURIComponent(recordId)})/${fieldName}/$value${size ? `?size=${encodeURIComponent(size)}` : ''}`;
    ctx.log?.({ type: 'dataverse.request', method: 'GET', url });

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/octet-stream',
        Range: 'bytes=0-4194303',
        ...ODATA_HEADERS,
      },
    });

    if (!res.ok) {
      const out = await res.text();
      let body: unknown = out;
      try {
        body = JSON.parse(out);
      } catch {
        // not JSON: keep the text
      }
      throw new HttpError(`Dataverse GetEntityFileImageFieldContent ${res.status}: ${out}`, res.status, body);
    }

    if (res.status === 204) return connectorResponse(undefined, 204);
    const base64 = uint8ToBase64(new Uint8Array(await res.arrayBuffer()));
    const body = { '$content-type': res.headers.get('Content-Type') || 'application/octet-stream', '$content': base64 };
    return connectorResponse(body, res.status, { omitStatusCode: res.status === 206 });
  }

  /**
   * File/image upload content: text is sent as its UTF-8 bytes (as the cloud sends a string body),
   * binary content ({ $content } from base64ToBinary() or another action) as the decoded bytes.
   */
  private uploadBytes(content: unknown): Uint8Array {
    if (typeof content === 'string') return new TextEncoder().encode(content);
    if (content instanceof Uint8Array) return content;
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (content && typeof content === 'object' && typeof (content as Record<string, unknown>)['$content'] === 'string') {
      return base64ToUint8((content as Record<string, string>)['$content']);
    }
    throw new Error('File content must be text, binary content ({ $content }), ArrayBuffer or Uint8Array');
  }

  // "Upload a file or an image": 204 and no body.
  private async uploadFileContent(inputs: Record<string, unknown>, ctx: RunContext): Promise<undefined> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    const fieldName = this.fileFieldName(inputs);
    const content = getParam<unknown>(inputs, ['item', 'content', 'body', '$content']);
    if (!recordId || !fieldName || content === undefined || content === null) {
      throw new Error('UpdateEntityFileImageFieldContent requires recordId, fileImageFieldName and item');
    }

    const binary = this.uploadBytes(content);
    const fileName = getParam<string>(inputs, ['x-ms-file-name', 'fileName']) ?? 'Untitled';
    const url = `${this.baseUrl}/${entityName}(${encodeURIComponent(recordId)})/${fieldName}`;
    ctx.log?.({ type: 'dataverse.request', method: 'PATCH', url, contentLength: binary.byteLength });

    // Copy into a fresh ArrayBuffer: avoids shared-pool issues with Node's
    // Buffer allocator and produces a plain ArrayBuffer that fetch's BodyInit
    // accepts (Uint8Array.buffer is typed as ArrayBufferLike, which widens to
    // SharedArrayBuffer and TypeScript then rejects it).
    const bodyBuf = new ArrayBuffer(binary.byteLength);
    new Uint8Array(bodyBuf).set(binary);
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/octet-stream',
        'x-ms-file-name': fileName,
        ...ODATA_HEADERS,
      },
      body: bodyBuf,
    });

    if (!res.ok) {
      const out = await res.text();
      let body: unknown = out;
      try {
        body = JSON.parse(out);
      } catch {
        // not JSON: keep the text
      }
      throw new HttpError(`Dataverse UpdateEntityFileImageFieldContent ${res.status}: ${out}`, res.status, body);
    }
    return undefined;
  }

  // ============= Batch Operations =============

  private async executeChangeset(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ responses: unknown[] }> {
    const requests = (inputs.requests || inputs.operations) as Array<{
      method?: string;
      url?: string;
      body?: unknown;
      entityName?: string;
      recordId?: string;
      contentId?: string;
    }>;

    if (!requests || !Array.isArray(requests)) {
      throw new Error('ExecuteChangeset requires an array of requests');
    }

    // Generate batch and changeset boundaries
    const batchBoundary = `batch_${Date.now()}`;
    const changesetBoundary = `changeset_${Date.now()}`;

    // Build multipart batch request
    let batchBody = '';

    // Start changeset
    batchBody += `--${batchBoundary}\r\n`;
    batchBody += `Content-Type: multipart/mixed; boundary=${changesetBoundary}\r\n\r\n`;

    // Add each request to the changeset
    requests.forEach((req, index) => {
      const method = req.method || 'POST';
      const url = req.url || this.buildRequestUrl(req);
      const body = req.body;
      const contentId = req.contentId || (index + 1).toString();

      batchBody += `--${changesetBoundary}\r\n`;
      batchBody += `Content-Type: application/http\r\n`;
      batchBody += `Content-Transfer-Encoding: binary\r\n`;
      batchBody += `Content-ID: ${contentId}\r\n\r\n`;
      batchBody += `${method} ${url} HTTP/1.1\r\n`;
      batchBody += `Content-Type: application/json\r\n`;
      batchBody += `OData-Version: 4.0\r\n`;
      batchBody += `OData-MaxVersion: 4.0\r\n`;

      if (body) {
        const bodyJson = JSON.stringify(body);
        batchBody += `Content-Length: ${bodyJson.length}\r\n\r\n`;
        batchBody += bodyJson;
      } else {
        batchBody += `\r\n`;
      }
      batchBody += `\r\n`;
    });

    // End changeset and batch
    batchBody += `--${changesetBoundary}--\r\n`;
    batchBody += `--${batchBoundary}--\r\n`;

    // Direct fetch for multipart batch
    const url = `${this.baseUrl}/$batch`;
    ctx.log?.({ type: 'dataverse.request', method: 'POST', url, requestCount: requests.length });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': `multipart/mixed; boundary=${batchBoundary}`,
        ...ODATA_HEADERS,
      },
      body: batchBody,
    });

    if (!res.ok) {
      const out = await res.text();
      throw new HttpError(`Dataverse ExecuteChangeset ${res.status}: ${out}`, res.status, out);
    }

    const responseText = await res.text();
    const responses = this.parseBatchResponse(responseText);

    // Return raw result — the engine wraps connector outputs in { body: ... }
    return { responses };
  }

  private buildRequestUrl(req: { entityName?: string; recordId?: string }): string {
    if (req.entityName && req.recordId) {
      return `${this.baseUrl}/${req.entityName}(${req.recordId})`;
    } else if (req.entityName) {
      return `${this.baseUrl}/${req.entityName}`;
    }
    throw new Error('Request must have entityName, or explicit url');
  }

  private parseBatchResponse(responseText: string): Array<{ status: number; body: unknown }> {
    const responses: Array<{ status: number; body: unknown }> = [];
    const parts = responseText.split(/--changeset_[^\r\n]+/);

    for (const part of parts) {
      if (part.includes('HTTP/1.1')) {
        const statusMatch = part.match(/HTTP\/1\.1 (\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1]) : 500;

        const jsonMatch = part.match(/\{[\s\S]*\}/);
        const body = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

        responses.push({ status, body });
      }
    }

    return responses;
  }

  // ============= Search =============

  private async getRelevantRows(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const searchText = getParam<string>(inputs, ['searchText', 'search', 'query']);
    if (!searchText) throw new Error('GetRelevantRows requires searchText');

    const searchRequest: Record<string, unknown> = { search: searchText };

    // Optional parameters
    const entities = getParam<string[]>(inputs, ['entities', 'tables']);
    if (entities) searchRequest.entities = entities;
    if (inputs.top) searchRequest.top = inputs.top;
    if (inputs.skip) searchRequest.skip = inputs.skip;
    if (inputs.filter) searchRequest.filter = inputs.filter;
    if (inputs.orderby) searchRequest.orderby = inputs.orderby;

    // Search API uses different base URL
    const searchBaseUrl = this.baseUrl.replace('/api/data/v9.2', '');
    const url = `${searchBaseUrl}/api/search/v1.0/query`;
    ctx.log?.({ type: 'dataverse.request', method: 'POST', url, searchRequest });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(searchRequest),
    });

    if (!res.ok) {
      const out = await res.text();
      throw new HttpError(`Dataverse GetRelevantRows ${res.status}: ${out}`, res.status, out);
    }

    // Return raw result — the engine wraps connector outputs in { body: ... }
    return await res.json();
  }
}

export default DataverseConnector;

// Export metadata for language service
export { dataverseMetadata, dataverseScopes } from './metadata.js';
