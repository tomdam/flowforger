/**
 * Word Online Business Connector for FlowForger
 *
 * Implements Word Online (Business) operations using Microsoft Graph API.
 * Requires a Microsoft Graph access token with appropriate permissions.
 *
 * API Reference: https://learn.microsoft.com/en-us/connectors/wordonlinebusiness/
 *
 * Operations:
 * - PopulateWordTemplate (CreateFileItem): Fill template fields with dynamic values
 * - ConvertToPdf (GetFilePDF): Convert Word document to PDF
 */

import type { BaseConnector, RunContext } from '@flowforger/engine';
import { BaseHttpClient, HttpError } from '@flowforger/connectors-shared';
import JSZip from 'jszip';

export { HttpError };

export interface WordOnlineConnectorOptions {
  /** Microsoft Graph access token (resource: https://graph.microsoft.com) */
  token: string;
}

type LogFunction = (entry: Record<string, unknown>) => void;

// Cross-platform base64 encoder for binary data. Uses Node's Buffer when
// available (faster, safe for large files); falls back to a chunked btoa()
// path in browsers, where Buffer does not exist.
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

/**
 * Word Online Business connector for FlowForger
 *
 * Supports the following operations:
 * - PopulateWordTemplate / CreateFileItem: Populate a Word template with dynamic content
 * - ConvertToPdf / GetFilePDF: Convert a Word document to PDF format
 */
export class WordOnlineConnector extends BaseHttpClient implements BaseConnector {
  private siteIdCache = new Map<string, string>();

  constructor(opts: WordOnlineConnectorOptions) {
    super('https://graph.microsoft.com/v1.0', opts.token, {
      'Content-Type': 'application/json',
    });
  }

  async invoke(operation: string, inputs: unknown, ctx: RunContext): Promise<unknown> {
    ctx.log?.({ type: 'wordonline.invoke', operation, rawInputs: inputs });

    const normalizedInputs = this.normalizeInputs(operation, inputs as Record<string, unknown>);
    ctx.log?.({ type: 'wordonline.normalized', normalizedInputs });

    switch (operation) {
      // Populate Word Template
      case 'PopulateWordTemplate':
      case 'PopulateAWordTemplate':
      case 'CreateFileItem':
        return this.populateWordTemplate(normalizedInputs, ctx);

      // Convert to PDF
      case 'ConvertToPdf':
      case 'ConvertWordDocumentToPdf':
      case 'GetFilePDF':
        return this.convertToPdf(normalizedInputs, ctx);

      default:
        throw new Error(`WordOnlineConnector: unknown operation '${operation}'`);
    }
  }

  /**
   * Normalize inputs from various Power Automate formats
   */
  private normalizeInputs(operation: string, inputs: Record<string, unknown>): Record<string, unknown> {
    const normalized = { ...inputs };

    // Handle source/location parameter (OneDrive/SharePoint)
    if (inputs.source && !inputs.location) normalized.location = inputs.source;

    // Handle drive/documentLibrary parameter
    if (inputs.drive && !inputs.documentLibrary) normalized.documentLibrary = inputs.drive;

    // Handle file parameter
    if (inputs.file && !inputs.fileId) normalized.fileId = inputs.file;

    // Handle template content/data for PopulateWordTemplate
    if (operation === 'PopulateWordTemplate' || operation === 'CreateFileItem') {
      const templateData: Record<string, unknown> = {};

      // dynamicFileSchema as a nested object (runtime format)
      if (inputs.dynamicFileSchema && typeof inputs.dynamicFileSchema === 'object') {
        Object.assign(templateData, inputs.dynamicFileSchema);
      }

      const knownKeys = ['source', 'location', 'drive', 'documentLibrary', 'file', 'fileId', 'dynamicFileSchema'];
      for (const [key, value] of Object.entries(inputs)) {
        // DSL transformer flattens nested objects into slash-delimited keys:
        // e.g., dynamicFileSchema/295577773 → content control ID 295577773
        if (key.startsWith('dynamicFileSchema/')) {
          const controlId = key.slice('dynamicFileSchema/'.length);
          templateData[controlId] = value;
        } else if (!knownKeys.includes(key)) {
          templateData[key] = value;
        }
      }

      if (Object.keys(templateData).length > 0) {
        normalized.templateData = templateData;
      }
    }

    // Handle sensitivity label options for ConvertToPdf
    if (inputs.extractSensitivityLabel !== undefined) {
      normalized.extractSensitivityLabel = inputs.extractSensitivityLabel;
    }
    if (inputs.fetchSensitivityLabelMetadata !== undefined) {
      normalized.fetchSensitivityLabelMetadata = inputs.fetchSensitivityLabelMetadata;
    }

    return normalized;
  }

  /**
   * Convert a SharePoint-style file path to a Graph API drive-relative path.
   * In SharePoint, paths include the library name (e.g., "/Shared Documents/file.docx"),
   * but in Graph API, the default drive IS the library, so the path should be "/file.docx".
   */
  private toDriveRelativePath(filePath: string): string {
    // Common SharePoint document library folder names
    const libraryPrefixes = [
      '/Shared Documents/',
      '/Shared%20Documents/',
      '/Documents/',
    ];
    for (const prefix of libraryPrefixes) {
      if (filePath.startsWith(prefix)) {
        return '/' + filePath.slice(prefix.length);
      }
    }
    return filePath;
  }

  /**
   * Resolve a SharePoint site URL to a Graph API site ID.
   * Caches the result to avoid repeated lookups.
   */
  private async resolveSiteId(siteUrl: string): Promise<string> {
    const cached = this.siteIdCache.get(siteUrl);
    if (cached) return cached;

    const url = new URL(siteUrl);
    const hostname = url.hostname;
    const sitePath = url.pathname;

    const response = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${hostname}:${sitePath}:`,
      { headers: { Authorization: `Bearer ${this['token']}` } }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new HttpError(`Failed to resolve site '${siteUrl}': ${response.status} - ${errorText}`, response.status, errorText);
    }

    const site = await response.json();
    const siteId = site.id as string;
    this.siteIdCache.set(siteUrl, siteId);
    return siteId;
  }

  /**
   * Build the drive path based on location type.
   * For SharePoint URLs, resolves the site ID first to avoid
   * nested colon-path expressions that Graph API cannot parse.
   */
  private async buildDrivePath(location: string, documentLibrary?: string): Promise<string> {
    // Default to user's OneDrive if not specified
    if (!location || location === 'me') {
      return documentLibrary ? `/me/drives/${documentLibrary}` : '/me/drive';
    }

    // Handle users/{UPN} format
    if (location.startsWith('users/')) {
      return documentLibrary ? `/${location}/drives/${documentLibrary}` : `/${location}/drive`;
    }

    // Handle groups/{groupId} format
    if (location.startsWith('groups/')) {
      return documentLibrary ? `/${location}/drives/${documentLibrary}` : `/${location}/drive`;
    }

    // Handle sites/{siteUrl} format (including teams)
    if (location.startsWith('sites/')) {
      return documentLibrary ? `/${location}/drives/${documentLibrary}` : `/${location}/drive`;
    }

    // Handle direct SharePoint site URL — resolve site ID to avoid nested colon paths
    if (location.startsWith('http')) {
      const siteId = await this.resolveSiteId(location);
      return documentLibrary
        ? `/sites/${siteId}/drives/${documentLibrary}`
        : `/sites/${siteId}/drive`;
    }

    // Default: treat as site identifier
    return documentLibrary ? `/sites/${location}/drives/${documentLibrary}` : `/sites/${location}/drive`;
  }

  /**
   * Populate a Microsoft Word template with dynamic values
   *
   * This operation reads a Word template file and fills in content controls
   * with the provided data values.
   *
   * @param inputs.location - Document source (me, SharePoint URL, etc.)
   * @param inputs.documentLibrary - Document library ID
   * @param inputs.fileId - Template file ID or path
   * @param inputs.templateData - Object with field names and values to populate
   * @returns Generated Word document as base64 content
   */
  private async populateWordTemplate(
    inputs: Record<string, unknown>,
    ctx: RunContext
  ): Promise<{ $content: string; $contentType: string; fileName?: string }> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const templateData = (inputs.templateData || {}) as Record<string, unknown>;

    if (!fileId) {
      throw new Error('PopulateWordTemplate requires fileId (file path or ID)');
    }

    ctx.log?.({ type: 'wordonline.populateTemplate', location, documentLibrary, fileId, templateData });

    // Build the drive path (resolves site ID for SharePoint URLs)
    const drivePath = await this.buildDrivePath(location, documentLibrary);

    // Determine if fileId is a path or an ID
    const isPath = fileId.startsWith('/') || fileId.includes('/');
    const driveRelative = isPath ? this.toDriveRelativePath(fileId) : '';
    const encodedPath = isPath ? driveRelative.split('/').map(s => encodeURIComponent(s)).join('/') : '';
    const itemPath = isPath ? `${drivePath}/root:${encodedPath}:` : `${drivePath}/items/${fileId}`;

    // Step 1: Download the template file content
    const templateContent = await this.downloadFile(itemPath, ctx.log);

    // Step 2: Process the template with the provided data
    // Note: The actual template processing would require a Word document library
    // For now, we'll use the Graph API's native approach or return a placeholder
    // In production, this would use Office.js or a server-side Word processing library

    // For the connector, we need to use Microsoft's template processing endpoint
    // which is typically done via Power Automate's internal service
    // As a workaround, we'll make a request to the Word Online template endpoint

    // The actual implementation depends on how Power Automate handles this internally
    // Using the createUploadSession approach for template processing
    const processedContent = await this.processTemplate(
      templateContent,
      templateData,
      drivePath,
      fileId,
      ctx.log
    );

    return {
      $content: processedContent.content,
      $contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: processedContent.fileName,
    };
  }

  /**
   * Download a file from OneDrive/SharePoint
   */
  private async downloadFile(itemPath: string, log?: LogFunction): Promise<Uint8Array> {
    const url = `${itemPath}/content`;
    log?.({ type: 'wordonline.download', url });

    const response = await fetch(`https://graph.microsoft.com/v1.0${url}`, {
      headers: {
        Authorization: `Bearer ${this['token']}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new HttpError(`Failed to download file: ${response.status} - ${errorText}`, response.status, errorText);
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  /**
   * Process a Word template by populating content controls with data.
   *
   * A .docx file is a ZIP containing XML. Content controls are <w:sdt> elements
   * in word/document.xml (and headers/footers). Each has a <w:id w:val="N"/> in
   * its <w:sdtPr> matching the numeric keys from dynamicFileSchema.
   * We replace the text runs inside <w:sdtContent> with the provided values.
   */
  private async processTemplate(
    templateBuffer: Uint8Array,
    data: Record<string, unknown>,
    _drivePath: string,
    originalFileName: string,
    log?: LogFunction
  ): Promise<{ content: string; fileName: string }> {
    log?.({ type: 'wordonline.processTemplate', dataFields: Object.keys(data) });

    if (Object.keys(data).length === 0) {
      return { content: uint8ToBase64(templateBuffer), fileName: originalFileName };
    }

    const zip = await JSZip.loadAsync(templateBuffer);

    // Process all XML parts that can contain content controls
    const xmlParts = Object.keys(zip.files).filter(
      (name) => name.startsWith('word/') && name.endsWith('.xml')
    );

    for (const partName of xmlParts) {
      const xml = await zip.file(partName)!.async('string');
      const modified = this.replaceContentControls(xml, data, log);
      if (modified !== xml) {
        zip.file(partName, modified);
      }
    }

    const outputBytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const content = uint8ToBase64(outputBytes);

    const baseName = originalFileName.replace(/\.[^/.]+$/, '');
    const fileName = `${baseName}_populated.docx`;

    return { content, fileName };
  }

  /**
   * Find <w:sdt> elements by their <w:id w:val="N"/> and replace text content.
   *
   * Content control structure in Word XML:
   *   <w:sdt>
   *     <w:sdtPr>
   *       <w:id w:val="295577773"/>
   *       ...
   *     </w:sdtPr>
   *     <w:sdtContent>
   *       <w:r><w:t>old text</w:t></w:r>
   *       ...
   *     </w:sdtContent>
   *   </w:sdt>
   */
  private replaceContentControls(
    xml: string,
    data: Record<string, unknown>,
    log?: LogFunction
  ): string {
    // Match each <w:sdt>...</w:sdt> block (non-greedy, handles nesting via iterative approach)
    const sdtRegex = /<w:sdt\b[^>]*>[\s\S]*?<\/w:sdt>/g;

    return xml.replace(sdtRegex, (sdtBlock) => {
      // Extract <w:id w:val="..."/> from <w:sdtPr>
      const idMatch = sdtBlock.match(/<w:sdtPr>[\s\S]*?<w:id\s+w:val="([^"]*)"[\s\S]*?<\/w:sdtPr>/);
      if (!idMatch) return sdtBlock;

      const controlId = idMatch[1];
      if (!(controlId in data)) return sdtBlock;

      const newValue = String(data[controlId] ?? '');
      log?.({ type: 'wordonline.replaceControl', controlId, newValue });

      // Replace content inside <w:sdtContent>...</w:sdtContent>
      // Preserve the sdtPr, only modify sdtContent
      const contentMatch = sdtBlock.match(
        /(<w:sdtContent>)([\s\S]*?)(<\/w:sdtContent>)/
      );
      if (!contentMatch) return sdtBlock;

      const oldContent = contentMatch[2];

      // Try to preserve the first <w:r> run's formatting (<w:rPr>) if present
      const rPrMatch = oldContent.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
      const rPr = rPrMatch ? rPrMatch[0] : '';

      // Escape XML special characters in the replacement value
      const escaped = newValue
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

      const newRun = `<w:r>${rPr}<w:t xml:space="preserve">${escaped}</w:t></w:r>`;

      // Check if the original content is inline (no <w:p>) or block-level (has <w:p>)
      const isInline = !oldContent.includes('<w:p');
      let newContent: string;
      if (isInline) {
        // Inline content control: just a run, no paragraph wrapper
        newContent = newRun;
      } else {
        // Block-level: preserve paragraph properties and wrap in <w:p>
        const pPrMatch = oldContent.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
        const pPr = pPrMatch ? pPrMatch[0] : '';
        newContent = `<w:p>${pPr}${newRun}</w:p>`;
      }

      return sdtBlock.replace(
        contentMatch[0],
        `${contentMatch[1]}${newContent}${contentMatch[3]}`
      );
    });
  }

  /**
   * Convert a Word document to PDF
   *
   * @param inputs.location - Document source (me, SharePoint URL, etc.)
   * @param inputs.documentLibrary - Document library ID
   * @param inputs.fileId - File ID or path
   * @param inputs.extractSensitivityLabel - Whether to extract sensitivity label
   * @returns PDF document as base64 content
   */
  private async convertToPdf(
    inputs: Record<string, unknown>,
    ctx: RunContext
  ): Promise<{ $content: string; $contentType: string; fileName?: string }> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);

    if (!fileId) {
      throw new Error('ConvertToPdf requires fileId (file path or ID)');
    }

    ctx.log?.({ type: 'wordonline.convertToPdf', location, documentLibrary, fileId });

    // Build the drive path (resolves site ID for SharePoint URLs)
    const drivePath = await this.buildDrivePath(location, documentLibrary);

    // Determine if fileId is a path or an ID
    const isPath = fileId.startsWith('/') || fileId.includes('/');
    const driveRelative = isPath ? this.toDriveRelativePath(fileId) : '';
    const encodedPath = isPath ? driveRelative.split('/').map(s => encodeURIComponent(s)).join('/') : '';
    const itemPath = isPath ? `${drivePath}/root:${encodedPath}:` : `${drivePath}/items/${fileId}`;

    // Use Graph API to convert to PDF
    // The /content endpoint with format=pdf query parameter converts the file
    const url = `${itemPath}/content?format=pdf`;

    ctx.log?.({ type: 'wordonline.convertRequest', url });

    const response = await fetch(`https://graph.microsoft.com/v1.0${url}`, {
      headers: {
        Authorization: `Bearer ${this['token']}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new HttpError(`Failed to convert to PDF: ${response.status} - ${errorText}`, response.status, errorText);
    }

    const arrayBuffer = await response.arrayBuffer();
    const content = uint8ToBase64(new Uint8Array(arrayBuffer));

    // Get original filename to generate PDF name
    let fileName = 'document.pdf';
    try {
      // Try to get file metadata for the name
      const metadataResponse = await fetch(`https://graph.microsoft.com/v1.0${itemPath}`, {
        headers: {
          Authorization: `Bearer ${this['token']}`,
        },
      });
      if (metadataResponse.ok) {
        const metadata = await metadataResponse.json();
        if (metadata.name) {
          fileName = metadata.name.replace(/\.[^/.]+$/, '.pdf');
        }
      }
    } catch {
      // Ignore metadata errors, use default filename
    }

    return {
      $content: content,
      $contentType: 'application/pdf',
      fileName,
    };
  }
}

export default WordOnlineConnector;

// Export metadata for language service
export { wordOnlineMetadata, wordonlineScopes } from './metadata.js';
