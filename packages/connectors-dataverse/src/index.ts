/**
 * Dataverse Connector for FlowForger
 *
 * Implements Dataverse Web API operations for Power Platform.
 * Requires a Dataverse/Dynamics 365 access token.
 */

import type { BaseConnector, RunContext } from '@flowforger/engine';
import { BaseHttpClient, extractItemFields, getParam, HttpError } from '@flowforger/connectors-shared';

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
      case 'UpdateRecord':
      case 'UpdateOnlyRecord':
        return this.updateRow(inputs as Record<string, unknown>, ctx);
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
      case 'UpsertRow':
      case 'UpsertRecord':
        return this.upsertRow(inputs as Record<string, unknown>, ctx);
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

    if (select) query['$select'] = select;
    if (filter) query['$filter'] = filter;
    if (top) query['$top'] = top;

    return this.get(`/${entityName}`, ctx.log, {
      query,
      headers: {
        Accept: 'application/json; odata.metadata=full',
        Prefer: 'odata.include-annotations="*"',
      },
    });
  }

  private async createRow(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const { entityName } = this.getEntityAndId(inputs);
    const body = this.getBody(inputs);

    const response = await this.post<Record<string, unknown> | string>(`/${entityName}`, ctx.log, {
      body,
      headers: { Prefer: 'return=representation' },
    });

    // Handle response - if no body returned, try to extract ID from OData-EntityId header
    let result = typeof response === 'string' ? (response ? JSON.parse(response) : {}) : response;

    if (!result || Object.keys(result).length === 0) {
      // Fallback: the ID would typically come from the OData-EntityId header
      // but BaseHttpClient doesn't expose headers. For now, return empty.
      result = {};
    }

    // Return raw result — the engine wraps connector outputs in { body: ... }
    return result;
  }

  private async updateRow(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean }> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    if (!recordId) throw new Error('updateRow requires recordId or id');

    const body = this.getBody(inputs);

    await this.patch(`/${entityName}(${encodeURIComponent(recordId)})`, ctx.log, {
      body,
      headers: { 'If-Match': '*' },
    });

    return { ok: true };
  }

  private async deleteRow(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean }> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    if (!recordId) throw new Error('deleteRow requires recordId or id');

    await this.delete(`/${entityName}(${encodeURIComponent(recordId)})`, ctx.log);
    return { ok: true };
  }

  private async retrieveRow(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    if (!recordId) throw new Error('retrieveRow requires recordId or id');

    const select = getParam<string>(inputs, ['$select', 'select']);
    const query: Record<string, string | undefined> = {};
    if (select) query['$select'] = select;

    return this.get(`/${entityName}(${encodeURIComponent(recordId)})`, ctx.log, {
      query,
      headers: {
        Accept: 'application/json; odata.metadata=full',
        Prefer: 'odata.include-annotations="*"',
      },
    });
  }

  // ============= Relationship Operations =============

  private async associateEntities(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean }> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    if (!recordId) throw new Error('AssociateEntities requires recordId');

    const relationshipName = getParam<string>(inputs, ['relationshipName', 'navigationProperty']);
    const relatedEntityName = getParam<string>(inputs, ['relatedEntityName', 'relatedEntitySetName']);
    const relatedRecordId = getParam<string>(inputs, ['relatedRecordId', 'relatedId']);

    if (!relationshipName || !relatedEntityName || !relatedRecordId) {
      throw new Error('AssociateEntities requires relationshipName, relatedEntityName, and relatedRecordId');
    }

    await this.post(`/${entityName}(${encodeURIComponent(recordId)})/${relationshipName}/$ref`, ctx.log, {
      body: {
        '@odata.id': `${this.baseUrl}/${relatedEntityName}(${encodeURIComponent(relatedRecordId)})`,
      },
    });

    return { ok: true };
  }

  private async disassociateEntities(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean }> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    if (!recordId) throw new Error('DisassociateEntities requires recordId');

    const relationshipName = getParam<string>(inputs, ['relationshipName', 'navigationProperty']);
    if (!relationshipName) throw new Error('DisassociateEntities requires relationshipName');

    const relatedRecordId = getParam<string>(inputs, ['relatedRecordId', 'relatedId']);

    // If relatedRecordId is provided, it's a collection-valued navigation property
    const endpoint = relatedRecordId
      ? `/${entityName}(${encodeURIComponent(recordId)})/${relationshipName}(${encodeURIComponent(relatedRecordId)})/$ref`
      : `/${entityName}(${encodeURIComponent(recordId)})/${relationshipName}/$ref`;

    await this.delete(endpoint, ctx.log);
    return { ok: true };
  }

  // ============= Upsert =============

  private async upsertRow(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    if (!recordId) throw new Error('upsertRow requires recordId or id');

    const body = this.getBody(inputs);

    // Note: No If-Match header enables upsert behavior
    const result = await this.patch<Record<string, unknown>>(`/${entityName}(${encodeURIComponent(recordId)})`, ctx.log, {
      body,
      headers: { Prefer: 'return=representation' },
    });

    // Return raw result — the engine wraps connector outputs in { body: ... }
    return result || {};
  }

  // ============= Actions =============

  private async performBoundAction(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    if (!recordId) throw new Error('PerformBoundAction requires recordId');

    const actionName = inputs.actionName as string;
    if (!actionName) throw new Error('PerformBoundAction requires actionName');

    // Extract action parameters
    // Power Automate sends parameters in multiple formats:
    // 1. Nested 'item' object: { item: { Param1: '...' } }
    // 2. Flattened 'item/*' keys: { 'item/Param1': '...' }
    // 3. Direct parameters (fallback)
    let actionParams: Record<string, unknown> = {};

    // First, try to extract from 'item/*' flattened format (most common in Power Automate)
    const itemFields = extractItemFields(inputs);
    if (Object.keys(itemFields).length > 0) {
      actionParams = itemFields;
    } else if (inputs.item && typeof inputs.item === 'object' && !Array.isArray(inputs.item)) {
      // Second, try nested 'item' object
      actionParams = inputs.item as Record<string, unknown>;
    } else {
      // Fallback: extract all params except known ones
      const knownParams = ['entityName', 'entitySetName', 'recordId', 'id', 'actionName'];
      for (const key in inputs) {
        if (!knownParams.includes(key)) {
          actionParams[key] = inputs[key];
        }
      }
    }

    // Custom actions (with publisher prefix like brk_, new_, etc.) are called directly
    // Standard OData actions use the Microsoft.Dynamics.CRM namespace
    const isCustomAction = actionName.includes('_');
    const hasParams = Object.keys(actionParams).length > 0;
    const entityPath = `/${entityName}(${encodeURIComponent(recordId)})`;

    // Dataverse distinguishes between Functions (GET) and Actions (POST).
    // Try POST first (action), fall back to GET (function) on 404.
    try {
      const actionSuffix = isCustomAction ? actionName : `Microsoft.Dynamics.CRM.${actionName}`;
      const result = await this.post<Record<string, unknown>>(
        `${entityPath}/${actionSuffix}`,
        ctx.log,
        { body: hasParams ? actionParams : undefined }
      );
      return result || {};
    } catch (err: any) {
      if (err?.status === 404 && !isCustomAction) {
        // Likely a bound Function — retry as GET without namespace
        const result = await this.get<Record<string, unknown>>(`${entityPath}/${actionName}`, ctx.log);
        return result || {};
      }
      throw err;
    }
  }

  private async performUnboundAction(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const actionName = inputs.actionName as string;
    if (!actionName) throw new Error('PerformUnboundAction requires actionName');

    // Extract action parameters
    // Power Automate sends parameters in multiple formats:
    // 1. Nested 'item' object: { item: { RegardingId: '...' } }
    // 2. Flattened 'item/*' keys: { 'item/RegardingId': '...' }
    // 3. Direct parameters (fallback)
    let actionParams: Record<string, unknown> = {};

    // First, try to extract from 'item/*' flattened format (most common in Power Automate)
    const itemFields = extractItemFields(inputs);
    if (Object.keys(itemFields).length > 0) {
      actionParams = itemFields;
    } else if (inputs.item && typeof inputs.item === 'object' && !Array.isArray(inputs.item)) {
      // Second, try nested 'item' object
      actionParams = inputs.item as Record<string, unknown>;
    } else {
      // Fallback: extract all params except actionName
      for (const key in inputs) {
        if (key !== 'actionName') {
          actionParams[key] = inputs[key];
        }
      }
    }

    // Custom actions (with publisher prefix like brk_, new_, etc.) are called directly
    // Standard OData actions use the Microsoft.Dynamics.CRM namespace
    const isCustomAction = actionName.includes('_');
    const hasParams = Object.keys(actionParams).length > 0;

    // Dataverse distinguishes between Functions (GET) and Actions (POST).
    // Since we can't know upfront which one the caller means, try POST first
    // (action), and fall back to GET (function) on 404.
    try {
      const actionPath = isCustomAction ? `/${actionName}` : `/Microsoft.Dynamics.CRM.${actionName}`;
      const result = await this.post<Record<string, unknown>>(
        actionPath,
        ctx.log,
        { body: hasParams ? actionParams : undefined }
      );
      return result || {};
    } catch (err: any) {
      if (err?.status === 404 && !isCustomAction) {
        // Likely a Function (e.g. WhoAmI) — retry as GET without namespace
        const result = await this.get<Record<string, unknown>>(`/${actionName}`, ctx.log);
        return result || {};
      }
      throw err;
    }
  }

  // ============= File Operations =============

  private async getFileContent(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ $content: string; $contentType: string }> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    if (!recordId) throw new Error('GetFileContent requires recordId');

    const fieldName = getParam<string>(inputs, ['fieldName', 'attributeName']);
    if (!fieldName) throw new Error('GetFileContent requires fieldName');

    // We need direct fetch for binary content since BaseHttpClient assumes JSON
    const url = `${this.baseUrl}/${entityName}(${encodeURIComponent(recordId)})/${fieldName}/$value`;
    ctx.log?.({ type: 'dataverse.request', method: 'GET', url });

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/octet-stream',
        ...ODATA_HEADERS,
      },
    });

    if (!res.ok) {
      const out = await res.text();
      throw new HttpError(`Dataverse GetFileContent ${res.status}: ${out}`, res.status, out);
    }

    const buffer = await res.arrayBuffer();
    const base64 = uint8ToBase64(new Uint8Array(buffer));

    // Return raw result — the engine wraps connector outputs in { body: ... }
    return {
      $content: base64,
      $contentType: res.headers.get('Content-Type') || 'application/octet-stream',
    };
  }

  private async uploadFileContent(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean }> {
    const { entityName, recordId } = this.getEntityAndId(inputs);
    if (!recordId) throw new Error('UploadFileContent requires recordId');

    const fieldName = getParam<string>(inputs, ['fieldName', 'attributeName']);
    const content = getParam<string | ArrayBuffer | Uint8Array>(inputs, ['content', 'body', '$content']);

    if (!fieldName || !content) {
      throw new Error('UploadFileContent requires fieldName and content');
    }

    // Normalize content to a Uint8Array. Node's Buffer is a subclass of
    // Uint8Array, so an input Buffer also satisfies the instanceof check.
    let binary: Uint8Array;
    if (typeof content === 'string') {
      binary = base64ToUint8(content);
    } else if (content instanceof Uint8Array) {
      binary = content;
    } else if (content instanceof ArrayBuffer) {
      binary = new Uint8Array(content);
    } else {
      throw new Error('Content must be a base64 string, ArrayBuffer, or Uint8Array');
    }

    // Direct fetch for binary upload
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
        ...ODATA_HEADERS,
      },
      body: bodyBuf,
    });

    if (!res.ok) {
      const out = await res.text();
      throw new HttpError(`Dataverse UploadFileContent ${res.status}: ${out}`, res.status, out);
    }

    return { ok: true };
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
