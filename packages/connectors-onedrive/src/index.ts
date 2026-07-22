/**
 * OneDrive for Business Connector for FlowForger
 *
 * Implements OneDrive file operations using Microsoft Graph API.
 * Requires a Microsoft Graph API token with appropriate permissions:
 * - Files.Read, Files.ReadWrite for file operations
 * - Files.Read.All, Files.ReadWrite.All for accessing all drives
 */

import type { BaseConnector, RunContext } from '@flowforger/engine';
import { BaseHttpClient, HttpError, getParam } from '@flowforger/connectors-shared';

export interface OneDriveConnectorOptions {
  /** Microsoft Graph API access token */
  token: string;
  /** Optional: Graph API base URL (defaults to https://graph.microsoft.com/v1.0) */
  baseUrl?: string;
}

// Re-export HttpError for consumers
export { HttpError };
export { onedriveScopes, oneDriveMetadata } from './metadata.js';

// Cross-platform base64 decoder: returns a Uint8Array of the decoded bytes.
// Node uses Buffer (fast), browsers use atob (Buffer does not exist there).
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

export class OneDriveConnector extends BaseHttpClient implements BaseConnector {
  constructor(opts: OneDriveConnectorOptions) {
    super(
      opts.baseUrl?.replace(/\/$/, '') || 'https://graph.microsoft.com/v1.0',
      opts.token
    );
  }

  async invoke(operation: string, inputs: unknown, ctx: RunContext): Promise<unknown> {
    ctx.log?.({ type: 'onedrive.invoke', operation, inputs });

    const p = inputs as Record<string, unknown>;

    switch (operation) {
      // ---- File CRUD ----
      case 'CreateFile':
        return this.createFile(p, ctx);

      case 'UpdateFile':
        return this.updateFile(p, ctx);

      case 'GetFileContent':
        return this.getFileContent(p, ctx);

      case 'GetFileContentByPath':
        return this.getFileContentByPath(p, ctx);

      case 'GetFileMetadata':
        return this.getFileMetadata(p, ctx);

      case 'GetFileMetadataByPath':
        return this.getFileMetadataByPath(p, ctx);

      case 'DeleteFile':
        return this.deleteFile(p, ctx);

      // ---- Copy/Move ----
      case 'CopyDriveFile':
        return this.copyDriveFile(p, ctx);

      case 'CopyDriveFileByPath':
        return this.copyDriveFileByPath(p, ctx);

      case 'MoveFile':
        return this.moveFile(p, ctx);

      case 'MoveFileByPath':
        return this.moveFileByPath(p, ctx);

      // ---- Convert ----
      case 'ConvertFile':
        return this.convertFile(p, ctx);

      case 'ConvertFileByPath':
        return this.convertFileByPath(p, ctx);

      // ---- Folder listing ----
      case 'ListFolderV2':
      case 'ListFolder':
        return this.listFolder(p, ctx);

      case 'ListRootFolder':
        return this.listRootFolder(ctx);

      // ---- Search ----
      case 'FindFiles':
        return this.findFiles(p, ctx);

      case 'FindFilesByPath':
        return this.findFilesByPath(p, ctx);

      // ---- Sharing ----
      case 'CreateShareLinkV2':
      case 'CreateShareLink':
        return this.createShareLink(p, ctx);

      case 'CreateShareLinkByPathV2':
      case 'CreateShareLinkByPath':
        return this.createShareLinkByPath(p, ctx);

      // ---- Other ----
      case 'ExtractFolderV2':
        throw new Error('OneDriveConnector: ExtractFolderV2 is a server-side operation and cannot be executed locally');

      case 'GetFileThumbnail':
        return this.getFileThumbnail(p, ctx);

      case 'CopyFile':
        return this.copyFileFromUrl(p, ctx);

      default:
        throw new Error(`OneDriveConnector: unknown operation '${operation}'`);
    }
  }

  // ============= Helper Methods =============

  /**
   * Splits a full path like "/folder/subfolder/file.docx" into
   * { parentPath: "/folder/subfolder", fileName: "file.docx" }
   */
  private splitDestination(path: string): { parentPath: string; fileName: string } {
    const normalized = path.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash <= 0) {
      return { parentPath: '/', fileName: normalized.replace(/^\//, '') };
    }
    return {
      parentPath: normalized.substring(0, lastSlash) || '/',
      fileName: normalized.substring(lastSlash + 1),
    };
  }

  /**
   * GET a raw (binary or text) resource and return it as base64 for binary
   * content or as a JSON object for JSON responses.
   */
  private async getRaw(path: string, log?: RunContext['log']): Promise<unknown> {
    const url = this.buildUrl(path);

    log?.({ type: 'OneDriveConnector.getRaw', url });

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...this.defaultHeaders,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorData: unknown;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = errorText;
      }
      const message = this.extractErrorMessage(errorData, response.status);
      throw new HttpError(message, response.status, errorData);
    }

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }

    // Return binary as base64
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Resolve file content that may be a base64 content object from another connector
   * (e.g., Word Online returns { content: "<base64>", fileName: "..." } or
   * { $content: "<base64>", $contentType: "..." }).
   * Returns a Uint8Array for binary upload, or the original value if it's already
   * a string or binary buffer. Node's Buffer is a subclass of Uint8Array, so
   * the instanceof check below also covers Buffer inputs.
   */
  private resolveFileContent(body: unknown): unknown {
    if (body == null) return body;
    if (typeof body === 'string') {
      // Could be raw base64 — try to decode it
      if (/^[A-Za-z0-9+/=]+$/.test(body) && body.length > 100) {
        return base64ToUint8(body);
      }
      return body;
    }
    if (body instanceof Uint8Array) return body;
    if (typeof body === 'object') {
      const obj = body as Record<string, unknown>;
      // Power Automate format: { $content: "<base64>", $content-type: "..." }
      const b64 = obj['$content'] || obj['content'];
      if (typeof b64 === 'string') {
        return base64ToUint8(b64);
      }
    }
    return body;
  }

  /**
   * Convert a Graph API DriveItem response to Power Automate's BlobMetadata format.
   * Graph returns camelCase (id, name, size); Power Automate uses PascalCase (Id, Name, Size).
   */
  private toBlobMetadata(item: Record<string, unknown>): Record<string, unknown> {
    const name = (item.name as string) || '';
    const dotIdx = name.lastIndexOf('.');
    return {
      Id: item.id,
      Name: name,
      NameNoExt: dotIdx > 0 ? name.substring(0, dotIdx) : name,
      DisplayName: name,
      Path: (item.parentReference as any)?.path
        ? `${(item.parentReference as any).path}/${name}`.replace(/^\/drive\/root:/, '')
        : `/${name}`,
      LastModified: item.lastModifiedDateTime,
      Size: item.size,
      MediaType: (item.file as any)?.mimeType || '',
      IsFolder: !!item.folder,
      ETag: item.eTag || '',
      FileLocator: item.id,
      LastModifiedBy: (item.lastModifiedBy as any)?.user?.displayName || '',
      // Preserve the original Graph properties too for compatibility
      ...item,
    };
  }

  // ============= File CRUD =============

  private async createFile(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const folderPath = getParam<string>(p, ['folderPath', 'folder', 'path'], '') ?? '';
    const name = getParam<string>(p, ['name', 'fileName']) ?? '';
    const rawBody = getParam<unknown>(p, ['body', 'content', 'fileContent']);
    const body = this.resolveFileContent(rawBody);

    const endpoint = `/me/drive/root:${encodeURI(`${folderPath}/${name}`)}:/content`;

    const result = await this.put<Record<string, unknown>>(endpoint, ctx.log, {
      body,
      rawBody: true,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    return this.toBlobMetadata(result);
  }

  private async updateFile(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const id = getParam<string>(p, ['id', 'file', 'fileId']) ?? '';
    const rawBody = getParam<unknown>(p, ['body', 'content', 'fileContent']);
    const body = this.resolveFileContent(rawBody);

    const result = await this.put<Record<string, unknown>>(`/me/drive/items/${encodeURIComponent(id)}/content`, ctx.log, {
      body,
      rawBody: true,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    return this.toBlobMetadata(result);
  }

  private async getFileContent(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const id = getParam<string>(p, ['id', 'file', 'fileId']) ?? '';
    return this.getRaw(`/me/drive/items/${encodeURIComponent(id)}/content`, ctx.log);
  }

  private async getFileContentByPath(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const path = getParam<string>(p, ['path', 'filePath']) ?? '';
    return this.getRaw(`/me/drive/root:${encodeURI(path)}:/content`, ctx.log);
  }

  private async getFileMetadata(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const id = getParam<string>(p, ['id', 'file', 'fileId']) ?? '';
    const result = await this.get<Record<string, unknown>>(`/me/drive/items/${encodeURIComponent(id)}`, ctx.log);
    return this.toBlobMetadata(result);
  }

  private async getFileMetadataByPath(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const path = getParam<string>(p, ['path', 'filePath']) ?? '';
    const result = await this.get<Record<string, unknown>>(`/me/drive/root:${encodeURI(path)}:`, ctx.log);
    return this.toBlobMetadata(result);
  }

  private async deleteFile(p: Record<string, unknown>, ctx: RunContext): Promise<Record<string, never>> {
    const id = getParam<string>(p, ['id', 'file', 'fileId']) ?? '';
    await this.delete(`/me/drive/items/${encodeURIComponent(id)}`, ctx.log);
    return {};
  }

  // ============= Copy / Move =============

  private async copyDriveFile(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const id = getParam<string>(p, ['id', 'file', 'fileId']) ?? '';
    const parentPath = getParam<string>(p, ['parentPath', 'destination', 'destinationPath']) ?? '/';
    const name = getParam<string>(p, ['name', 'fileName']);

    const body: Record<string, unknown> = {
      parentReference: { path: `/drive/root:${parentPath}` },
    };
    if (name) body.name = name;

    return this.post(`/me/drive/items/${encodeURIComponent(id)}/copy`, ctx.log, { body });
  }

  private async copyDriveFileByPath(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const source = getParam<string>(p, ['source', 'sourcePath', 'path']) ?? '';
    const parentPath = getParam<string>(p, ['parentPath', 'destination', 'destinationPath']) ?? '/';
    const name = getParam<string>(p, ['name', 'fileName']);

    const body: Record<string, unknown> = {
      parentReference: { path: `/drive/root:${parentPath}` },
    };
    if (name) body.name = name;

    return this.post(`/me/drive/root:${encodeURI(source)}:/copy`, ctx.log, { body });
  }

  private async moveFile(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const id = getParam<string>(p, ['id', 'file', 'fileId']) ?? '';
    const parentPath = getParam<string>(p, ['parentPath', 'destination', 'destinationPath']) ?? '/';
    const name = getParam<string>(p, ['name', 'fileName']);

    const body: Record<string, unknown> = {
      parentReference: { path: `/drive/root:${parentPath}` },
    };
    if (name) body.name = name;

    const result = await this.patch<Record<string, unknown>>(`/me/drive/items/${encodeURIComponent(id)}`, ctx.log, { body });
    return this.toBlobMetadata(result);
  }

  private async moveFileByPath(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const path = getParam<string>(p, ['path', 'sourcePath', 'filePath']) ?? '';
    const parentPath = getParam<string>(p, ['parentPath', 'destination', 'destinationPath']) ?? '/';
    const name = getParam<string>(p, ['name', 'fileName']);

    // First resolve the path to an item ID
    const item = await this.get<{ id: string }>(`/me/drive/root:${encodeURI(path)}:`, ctx.log);
    const id = item.id;

    const body: Record<string, unknown> = {
      parentReference: { path: `/drive/root:${parentPath}` },
    };
    if (name) body.name = name;

    const result = await this.patch<Record<string, unknown>>(`/me/drive/items/${encodeURIComponent(id)}`, ctx.log, { body });
    return this.toBlobMetadata(result);
  }

  // ============= Convert =============

  private async convertFile(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const id = getParam<string>(p, ['id', 'file', 'fileId']) ?? '';
    const type = getParam<string>(p, ['type', 'format'], 'pdf') ?? 'pdf';
    return this.getRaw(`/me/drive/items/${encodeURIComponent(id)}/content?format=${encodeURIComponent(type)}`, ctx.log);
  }

  private async convertFileByPath(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const path = getParam<string>(p, ['path', 'filePath']) ?? '';
    const type = getParam<string>(p, ['type', 'format'], 'pdf') ?? 'pdf';
    return this.getRaw(`/me/drive/root:${encodeURI(path)}:/content?format=${encodeURIComponent(type)}`, ctx.log);
  }

  // ============= Folder Listing =============

  private async listFolder(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const id = getParam<string>(p, ['id', 'folder', 'folderId']) ?? '';
    const result = await this.get<{ value: Record<string, unknown>[] }>(`/me/drive/items/${encodeURIComponent(id)}/children`, ctx.log);
    return (result.value || []).map((item) => this.toBlobMetadata(item));
  }

  private async listRootFolder(ctx: RunContext): Promise<unknown> {
    const result = await this.get<{ value: Record<string, unknown>[] }>('/me/drive/root/children', ctx.log);
    return (result.value || []).map((item) => this.toBlobMetadata(item));
  }

  // ============= Search =============

  private async findFiles(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const id = getParam<string>(p, ['id', 'folder', 'folderId']) ?? '';
    const query = getParam<string>(p, ['query', 'search', 'searchQuery']) ?? '';
    const top = getParam<number>(p, ['top', '$top']);

    const queryParams: Record<string, string | number | boolean | undefined> = {};
    if (top !== undefined) queryParams['$top'] = top;

    return this.get(
      `/me/drive/items/${encodeURIComponent(id)}/search(q='${encodeURIComponent(query)}')`,
      ctx.log,
      { query: queryParams }
    );
  }

  private async findFilesByPath(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const path = getParam<string>(p, ['path', 'folderPath']) ?? '';
    const query = getParam<string>(p, ['query', 'search', 'searchQuery']) ?? '';

    return this.get(
      `/me/drive/root:${encodeURI(path)}:/search(q='${encodeURIComponent(query)}')`,
      ctx.log
    );
  }

  // ============= Sharing =============

  private async createShareLink(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const id = getParam<string>(p, ['id', 'file', 'fileId']) ?? '';
    const type = getParam<string>(p, ['type', 'linkType'], 'view') ?? 'view';
    const scope = getParam<string>(p, ['scope', 'linkScope'], 'anonymous') ?? 'anonymous';

    return this.post(`/me/drive/items/${encodeURIComponent(id)}/createLink`, ctx.log, {
      body: { type, scope },
    });
  }

  private async createShareLinkByPath(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const path = getParam<string>(p, ['path', 'filePath']) ?? '';
    const type = getParam<string>(p, ['type', 'linkType'], 'view') ?? 'view';
    const scope = getParam<string>(p, ['scope', 'linkScope'], 'anonymous') ?? 'anonymous';

    return this.post(`/me/drive/root:${encodeURI(path)}:/createLink`, ctx.log, {
      body: { type, scope },
    });
  }

  // ============= Other =============

  private async getFileThumbnail(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const id = getParam<string>(p, ['id', 'file', 'fileId']) ?? '';
    const size = getParam<string>(p, ['size', 'thumbnailSize'], 'medium') ?? 'medium';
    return this.get(`/me/drive/items/${encodeURIComponent(id)}/thumbnails/0/${encodeURIComponent(size)}`, ctx.log);
  }

  /**
   * CopyFile - Power Automate's "Upload file from URL" operation.
   * Fetches binary content from a source URL and uploads it to OneDrive.
   */
  private async copyFileFromUrl(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const sourceUrl = getParam<string>(p, ['sourceUrl', 'url', 'source']) ?? '';
    const destination = getParam<string>(p, ['destination', 'destinationPath', 'path']) ?? '';
    const name = getParam<string>(p, ['name', 'fileName']);

    // Determine target filename and folder
    let targetName = name;
    let folderPath = destination;

    if (!targetName) {
      // Try to extract filename from destination path or source URL
      const { parentPath, fileName } = this.splitDestination(destination);
      if (fileName) {
        targetName = fileName;
        folderPath = parentPath;
      } else {
        // Fall back to extracting from source URL
        const urlParts = sourceUrl.split('/');
        targetName = urlParts[urlParts.length - 1] || 'file';
        folderPath = destination;
      }
    }

    // Fetch content from source URL
    ctx.log?.({ type: 'OneDriveConnector.copyFileFromUrl', sourceUrl });
    const sourceResponse = await fetch(sourceUrl);
    if (!sourceResponse.ok) {
      throw new HttpError(
        `Failed to fetch source URL: HTTP ${sourceResponse.status}`,
        sourceResponse.status
      );
    }

    const buffer = await sourceResponse.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Upload to OneDrive
    const oneDrivePath = folderPath && folderPath !== '/'
      ? `${folderPath}/${targetName}`
      : `/${targetName}`;

    const endpoint = `/me/drive/root:${encodeURI(oneDrivePath)}:/content`;

    return this.put(endpoint, ctx.log, {
      body: bytes,
      rawBody: true,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }
}

export default OneDriveConnector;
