/**
 * Excel Online Business Connector for FlowForger
 *
 * Implements Excel Online (Business) operations using Microsoft Graph API.
 * Requires a Microsoft Graph access token with appropriate permissions.
 *
 * API Reference: https://learn.microsoft.com/en-us/connectors/excelonlinebusiness/
 *
 * Operations:
 * - GetItems (ListRows): List rows present in a table
 * - GetItem (GetRow): Get a row using a key column
 * - AddRowV2 (AddRow): Add a new row into the Excel table
 * - PatchItem (UpdateRow): Update a row using a key column
 * - DeleteItem (DeleteRow): Delete a row using a key column
 * - GetTables: Get a list of tables in the Excel workbook
 * - GetAllWorksheets (GetWorksheets): Get a list of worksheets
 * - CreateTable: Create a new table in the Excel workbook
 * - CreateWorksheet: Create a new worksheet
 * - CreateIdColumn (AddKeyColumn): Add a key column to a table
 * - RunScriptProd (RunScript): Run an Office Script
 * - RunScriptProdV2 (RunScriptFromLibrary): Run a script from SharePoint library
 */

import type { BaseConnector, RunContext } from '@flowforger/engine';
import { BaseHttpClient, HttpError, buildODataQuery } from '@flowforger/connectors-shared';

export { HttpError };

export interface ExcelOnlineConnectorOptions {
  /** Microsoft Graph access token (resource: https://graph.microsoft.com) */
  token: string;
}

type LogFunction = (entry: Record<string, unknown>) => void;

/**
 * Excel Online Business connector for FlowForger
 *
 * Provides operations for working with Excel workbooks stored in OneDrive or SharePoint.
 */
export class ExcelOnlineConnector extends BaseHttpClient implements BaseConnector {
  constructor(opts: ExcelOnlineConnectorOptions) {
    super('https://graph.microsoft.com/v1.0', opts.token, {
      'Content-Type': 'application/json',
    });
  }

  async invoke(operation: string, inputs: unknown, ctx: RunContext): Promise<unknown> {
    ctx.log?.({ type: 'excelonline.invoke', operation, rawInputs: inputs });

    const normalizedInputs = this.normalizeInputs(operation, inputs as Record<string, unknown>);
    ctx.log?.({ type: 'excelonline.normalized', normalizedInputs });

    switch (operation) {
      // List/Get operations
      case 'GetItems':
      case 'ListRows':
        return this.listRows(normalizedInputs, ctx);

      case 'GetItem':
      case 'GetRow':
        return this.getRow(normalizedInputs, ctx);

      case 'GetTables':
        return this.getTables(normalizedInputs, ctx);

      case 'GetAllWorksheets':
      case 'GetWorksheets':
        return this.getWorksheets(normalizedInputs, ctx);

      // Create operations
      case 'AddRowV2':
      case 'AddRow':
        return this.addRow(normalizedInputs, ctx);

      case 'CreateTable':
        return this.createTable(normalizedInputs, ctx);

      case 'CreateWorksheet':
        return this.createWorksheet(normalizedInputs, ctx);

      case 'CreateIdColumn':
      case 'AddKeyColumn':
        return this.addKeyColumn(normalizedInputs, ctx);

      // Update operations
      case 'PatchItem':
      case 'UpdateRow':
        return this.updateRow(normalizedInputs, ctx);

      // Delete operations
      case 'DeleteItem':
      case 'DeleteRow':
        return this.deleteRow(normalizedInputs, ctx);

      case 'DeleteTable':
        return this.deleteTable(normalizedInputs, ctx);

      case 'DeleteWorksheet':
        return this.deleteWorksheet(normalizedInputs, ctx);

      // Range operations
      case 'GetRange':
        return this.getRange(normalizedInputs, ctx);

      case 'UpdateRange':
        return this.updateRange(normalizedInputs, ctx);

      // Column operations
      case 'GetColumn':
        return this.getColumn(normalizedInputs, ctx);

      case 'AddColumn':
        return this.addColumn(normalizedInputs, ctx);

      case 'DeleteColumn':
        return this.deleteColumn(normalizedInputs, ctx);

      // Script operations
      case 'RunScriptProd':
      case 'RunScript':
        return this.runScript(normalizedInputs, ctx);

      case 'RunScriptProdV2':
      case 'RunScriptFromLibrary':
        return this.runScriptFromLibrary(normalizedInputs, ctx);

      default:
        throw new Error(`ExcelOnlineConnector: unknown operation '${operation}'`);
    }
  }

  /**
   * Normalize inputs from various Power Automate formats
   */
  private normalizeInputs(operation: string, inputs: Record<string, unknown>): Record<string, unknown> {
    const normalized = { ...inputs };

    // Reconstitute slash-separated nested objects (DSL transformer flattens
    // e.g. rowData: { ID: 'x' } → 'rowData/ID': 'x')
    for (const key of Object.keys(inputs)) {
      const slashIdx = key.indexOf('/');
      if (slashIdx > 0) {
        const parent = key.substring(0, slashIdx);
        const child = key.substring(slashIdx + 1);
        if (!normalized[parent] || typeof normalized[parent] !== 'object') {
          normalized[parent] = {};
        }
        (normalized[parent] as Record<string, unknown>)[child] = inputs[key];
        delete normalized[key];
      }
    }

    // Handle source/location parameter
    if (inputs.source && !inputs.location) normalized.location = inputs.source;

    // Handle drive/documentLibrary parameter
    if (inputs.drive && !inputs.documentLibrary) normalized.documentLibrary = inputs.drive;

    // Handle file parameter
    if (inputs.file && !inputs.fileId) normalized.fileId = inputs.file;

    // Handle table parameter
    if (inputs.table && !inputs.tableName) normalized.tableName = inputs.table;

    // Handle key column/value for row operations
    if (inputs.idColumn && !inputs.keyColumn) normalized.keyColumn = inputs.idColumn;
    if (inputs.id && !inputs.keyValue) normalized.keyValue = inputs.id;

    // Handle item/row data
    if (inputs.item && !inputs.rowData) normalized.rowData = inputs.item;

    // Handle OData query parameters
    if (inputs['$filter'] && !inputs.filter) normalized.filter = inputs['$filter'];
    if (inputs['$orderby'] && !inputs.orderby) normalized.orderby = inputs['$orderby'];
    if (inputs['$top'] && !inputs.top) normalized.top = inputs['$top'];
    if (inputs['$skip'] && !inputs.skip) normalized.skip = inputs['$skip'];
    if (inputs['$select'] && !inputs.select) normalized.select = inputs['$select'];

    // Handle worksheet name
    if (inputs.name && !inputs.worksheetName) normalized.worksheetName = inputs.name;

    // Handle table creation parameters
    if (inputs.TableName && !inputs.tableName) normalized.tableName = inputs.TableName;
    if (inputs.Range && !inputs.range) normalized.range = inputs.Range;
    if (inputs.ColumnsNames && !inputs.columnNames) normalized.columnNames = inputs.ColumnsNames;

    // Handle script parameters
    if (inputs.scriptId && !inputs.scriptFile) normalized.scriptFile = inputs.scriptId;
    if (inputs.ScriptParameters && !inputs.scriptParameters) normalized.scriptParameters = inputs.ScriptParameters;

    // Handle script from library parameters
    if (inputs.scriptSource && !inputs.scriptLocation) normalized.scriptLocation = inputs.scriptSource;
    if (inputs.scriptDrive && !inputs.scriptLibrary) normalized.scriptLibrary = inputs.scriptDrive;

    // Handle worksheet identifier (for range operations)
    if (inputs.worksheet && !inputs.worksheetNameOrId) normalized.worksheetNameOrId = inputs.worksheet;
    if (inputs.worksheetId && !inputs.worksheetNameOrId) normalized.worksheetNameOrId = inputs.worksheetId;
    if (inputs.worksheetIdOrName && !inputs.worksheetNameOrId) normalized.worksheetNameOrId = inputs.worksheetIdOrName;

    // Handle column identifier
    if (inputs.column && !inputs.columnNameOrId) normalized.columnNameOrId = inputs.column;
    if (inputs.columnId && !inputs.columnNameOrId) normalized.columnNameOrId = inputs.columnId;

    // Handle range values for update
    if (inputs.values && !inputs.rangeValues) normalized.rangeValues = inputs.values;

    // Handle column index
    if (inputs.index !== undefined && inputs.columnIndex === undefined) normalized.columnIndex = inputs.index;

    // Handle column name for AddColumn
    if (inputs.name && !inputs.columnName) normalized.columnName = inputs.name;

    return normalized;
  }

  // Cache resolved site IDs to avoid repeated lookups
  private siteIdCache = new Map<string, string>();

  /**
   * Resolve a SharePoint site URL to a Graph site ID.
   * Results are cached per URL for the lifetime of the connector instance.
   */
  private async resolveSiteId(siteUrl: string, log?: LogFunction): Promise<string> {
    if (this.siteIdCache.has(siteUrl)) {
      return this.siteIdCache.get(siteUrl)!;
    }
    const url = new URL(siteUrl);
    const hostname = url.hostname;
    const sitePath = url.pathname;
    const site = await this.get<{ id: string }>(`/sites/${hostname}:${sitePath}`, log);
    this.siteIdCache.set(siteUrl, site.id);
    return site.id;
  }

  /**
   * Build the drive item path based on location type.
   * For HTTP URLs, resolves the site ID first to avoid nested colon-path
   * segments that Graph API does not support.
   */
  private async buildDrivePath(location: string, documentLibrary?: string, log?: LogFunction): Promise<string> {
    if (!location || location === 'me') {
      return documentLibrary ? `/me/drives/${documentLibrary}` : '/me/drive';
    }

    if (location.startsWith('users/')) {
      return documentLibrary ? `/${location}/drives/${documentLibrary}` : `/${location}/drive`;
    }

    if (location.startsWith('groups/')) {
      return documentLibrary ? `/${location}/drives/${documentLibrary}` : `/${location}/drive`;
    }

    if (location.startsWith('sites/')) {
      return documentLibrary ? `/${location}/drives/${documentLibrary}` : `/${location}/drive`;
    }

    if (location.startsWith('http')) {
      try {
        const siteId = await this.resolveSiteId(location, log);
        return documentLibrary
          ? `/sites/${siteId}/drives/${documentLibrary}`
          : `/sites/${siteId}/drive`;
      } catch {
        const url = new URL(location);
        return documentLibrary
          ? `/sites/${url.hostname}:${url.pathname}:/drives/${documentLibrary}`
          : `/sites/${url.hostname}:${url.pathname}:/drive`;
      }
    }

    return documentLibrary ? `/sites/${location}/drives/${documentLibrary}` : `/sites/${location}/drive`;
  }

  /**
   * Build the workbook item path
   */
  private async buildWorkbookPath(location: string, documentLibrary: string | undefined, fileId: string, log?: LogFunction): Promise<string> {
    const drivePath = await this.buildDrivePath(location, documentLibrary, log);
    const isPath = fileId.startsWith('/') || fileId.includes('/');
    return isPath ? `${drivePath}/root:${fileId}:/workbook` : `${drivePath}/items/${fileId}/workbook`;
  }

  // ============= List/Get Operations =============

  /**
   * List rows present in a table
   */
  private async listRows(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const tableName = String(inputs.tableName);

    if (!fileId || !tableName) {
      throw new Error('ListRows requires fileId and tableName');
    }

    ctx.log?.({ type: 'excelonline.listRows', location, fileId, tableName });

    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);

    // Build query parameters
    const queryParams: Record<string, string | number | boolean | undefined> = {};
    if (inputs.top) queryParams['$top'] = Number(inputs.top);
    if (inputs.skip) queryParams['$skip'] = Number(inputs.skip);
    if (inputs.select) queryParams['$select'] = String(inputs.select);

    const url = `${workbookPath}/tables/${encodeURIComponent(tableName)}/rows`;
    const result = await this.get<{ value: Array<{ values: unknown[][] }> }>(url, ctx.log, { query: queryParams });

    // Get column headers to build row objects
    const columnsUrl = `${workbookPath}/tables/${encodeURIComponent(tableName)}/columns`;
    const columnsResult = await this.get<{ value: Array<{ name: string }> }>(columnsUrl, ctx.log);
    const columnNames = columnsResult.value.map(col => col.name);

    // Transform rows to objects with column names as keys
    const rows = result.value.map((row, rowIndex) => {
      const rowObj: Record<string, unknown> = { _rowIndex: rowIndex };
      const values = row.values[0] || [];
      columnNames.forEach((colName, colIndex) => {
        rowObj[colName] = values[colIndex];
      });
      return rowObj;
    });

    // Apply client-side filtering if specified (Graph API doesn't support OData filter on rows)
    let filteredRows = rows;
    if (inputs.filter) {
      // Basic filter implementation for common patterns
      filteredRows = this.applyFilter(rows, String(inputs.filter));
    }

    // Apply ordering if specified
    if (inputs.orderby) {
      filteredRows = this.applyOrderBy(filteredRows, String(inputs.orderby));
    }

    return { value: filteredRows };
  }

  /**
   * Get a row using a key column
   */
  private async getRow(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const tableName = String(inputs.tableName);
    const keyColumn = String(inputs.keyColumn);
    const keyValue = inputs.keyValue;

    if (!fileId || !tableName || !keyColumn || keyValue === undefined) {
      throw new Error('GetRow requires fileId, tableName, keyColumn, and keyValue');
    }

    ctx.log?.({ type: 'excelonline.getRow', location, fileId, tableName, keyColumn, keyValue });

    // List all rows and find the matching one
    const allRows = await this.listRows({ ...inputs, filter: undefined, top: undefined, skip: undefined }, ctx) as { value: Array<Record<string, unknown>> };

    const matchingRow = allRows.value.find(row => String(row[keyColumn]) === String(keyValue));

    if (!matchingRow) {
      throw new HttpError(`Row not found with ${keyColumn} = ${keyValue}`, 404, { message: 'Row not found' });
    }

    return matchingRow;
  }

  /**
   * Get a list of tables in the Excel workbook
   */
  private async getTables(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);

    if (!fileId) {
      throw new Error('GetTables requires fileId');
    }

    ctx.log?.({ type: 'excelonline.getTables', location, fileId });

    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);
    const url = `${workbookPath}/tables`;

    return this.get(url, ctx.log);
  }

  /**
   * Get a list of worksheets in the Excel workbook
   */
  private async getWorksheets(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);

    if (!fileId) {
      throw new Error('GetWorksheets requires fileId');
    }

    ctx.log?.({ type: 'excelonline.getWorksheets', location, fileId });

    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);
    const url = `${workbookPath}/worksheets`;

    return this.get(url, ctx.log);
  }

  // ============= Create Operations =============

  /**
   * Add a new row into the Excel table
   */
  private async addRow(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const tableName = String(inputs.tableName);
    const rowData = inputs.rowData as Record<string, unknown>;

    if (!fileId || !tableName || !rowData) {
      throw new Error('AddRow requires fileId, tableName, and rowData');
    }

    ctx.log?.({ type: 'excelonline.addRow', location, fileId, tableName, rowData });

    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);

    // Get column names to build the values array in correct order
    const columnsUrl = `${workbookPath}/tables/${encodeURIComponent(tableName)}/columns`;
    const columnsResult = await this.get<{ value: Array<{ name: string }> }>(columnsUrl, ctx.log);
    const columnNames = columnsResult.value.map(col => col.name);

    // Build values array in column order
    const values = columnNames.map(colName => rowData[colName] ?? null);

    const url = `${workbookPath}/tables/${encodeURIComponent(tableName)}/rows`;
    const result = await this.post(url, ctx.log, {
      body: { values: [values] }
    });

    // Return the added row with column names
    const resultRow: Record<string, unknown> = {};
    columnNames.forEach((colName, index) => {
      resultRow[colName] = values[index];
    });

    return resultRow;
  }

  /**
   * Create a new table in the Excel workbook
   */
  private async createTable(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const range = String(inputs.range);
    const tableName = inputs.tableName ? String(inputs.tableName) : undefined;
    const hasHeaders = inputs.hasHeaders !== false;

    if (!fileId || !range) {
      throw new Error('CreateTable requires fileId and range');
    }

    ctx.log?.({ type: 'excelonline.createTable', location, fileId, range, tableName });

    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);
    const url = `${workbookPath}/tables/add`;

    const result = await this.post(url, ctx.log, {
      body: {
        address: range,
        hasHeaders
      }
    });

    // Rename table if name provided
    if (tableName && result && typeof result === 'object' && 'id' in result) {
      const tableId = (result as { id: string }).id;
      const renameUrl = `${workbookPath}/tables/${tableId}`;
      await this.patch(renameUrl, ctx.log, {
        body: { name: tableName }
      });
      (result as Record<string, unknown>).name = tableName;
    }

    return result;
  }

  /**
   * Create a new worksheet in the Excel workbook
   */
  private async createWorksheet(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const worksheetName = inputs.worksheetName ? String(inputs.worksheetName) : undefined;

    if (!fileId) {
      throw new Error('CreateWorksheet requires fileId');
    }

    ctx.log?.({ type: 'excelonline.createWorksheet', location, fileId, worksheetName });

    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);
    const url = `${workbookPath}/worksheets/add`;

    const body: Record<string, unknown> = {};
    if (worksheetName) {
      body.name = worksheetName;
    }

    return this.post(url, ctx.log, { body });
  }

  /**
   * Add a key column to a table
   */
  private async addKeyColumn(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const tableName = String(inputs.tableName);
    const keyColumnName = inputs.keyColumn ? String(inputs.keyColumn) : '_KeyColumn';

    if (!fileId || !tableName) {
      throw new Error('AddKeyColumn requires fileId and tableName');
    }

    ctx.log?.({ type: 'excelonline.addKeyColumn', location, fileId, tableName, keyColumnName });

    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);
    const url = `${workbookPath}/tables/${encodeURIComponent(tableName)}/columns`;

    // Add a new column with auto-generated unique values
    const result = await this.post(url, ctx.log, {
      body: {
        name: keyColumnName,
        values: [] // Graph API will add the column; we'd need to populate it separately
      }
    });

    return result;
  }

  // ============= Update Operations =============

  /**
   * Update a row using a key column
   */
  private async updateRow(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const tableName = String(inputs.tableName);
    const keyColumn = String(inputs.keyColumn);
    const keyValue = inputs.keyValue;
    const rowData = inputs.rowData as Record<string, unknown>;

    if (!fileId || !tableName || !keyColumn || keyValue === undefined || !rowData) {
      throw new Error('UpdateRow requires fileId, tableName, keyColumn, keyValue, and rowData');
    }

    ctx.log?.({ type: 'excelonline.updateRow', location, fileId, tableName, keyColumn, keyValue, rowData });

    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);

    // Get column names
    const columnsUrl = `${workbookPath}/tables/${encodeURIComponent(tableName)}/columns`;
    const columnsResult = await this.get<{ value: Array<{ name: string }> }>(columnsUrl, ctx.log);
    const columnNames = columnsResult.value.map(col => col.name);

    // Find the key column index
    const keyColIndex = columnNames.indexOf(keyColumn);
    if (keyColIndex === -1) {
      throw new HttpError(`Key column '${keyColumn}' not found in table`, 400, { message: 'Key column not found' });
    }

    // Get all rows to find the matching one
    const rowsUrl = `${workbookPath}/tables/${encodeURIComponent(tableName)}/rows`;
    const rowsResult = await this.get<{ value: Array<{ index: number; values: unknown[][] }> }>(rowsUrl, ctx.log);

    // Find the row index
    let rowIndex = -1;
    for (const row of rowsResult.value) {
      const values = row.values[0] || [];
      if (String(values[keyColIndex]) === String(keyValue)) {
        rowIndex = row.index;
        break;
      }
    }

    if (rowIndex === -1) {
      throw new HttpError(`Row not found with ${keyColumn} = ${keyValue}`, 404, { message: 'Row not found' });
    }

    // Build the updated values array, keeping existing values for unspecified columns
    const existingRow = rowsResult.value.find(r => r.index === rowIndex);
    const existingValues = existingRow?.values[0] || [];
    const newValues = columnNames.map((colName, index) => {
      return rowData.hasOwnProperty(colName) ? rowData[colName] : existingValues[index];
    });

    // Update the row
    const updateUrl = `${workbookPath}/tables/${encodeURIComponent(tableName)}/rows/itemAt(index=${rowIndex})`;
    await this.patch(updateUrl, ctx.log, {
      body: { values: [newValues] }
    });

    // Return the updated row
    const updatedRow: Record<string, unknown> = { _rowIndex: rowIndex };
    columnNames.forEach((colName, index) => {
      updatedRow[colName] = newValues[index];
    });

    return updatedRow;
  }

  // ============= Delete Operations =============

  /**
   * Delete a row using a key column
   */
  private async deleteRow(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number }> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const tableName = String(inputs.tableName);
    const keyColumn = String(inputs.keyColumn);
    const keyValue = inputs.keyValue;

    if (!fileId || !tableName || !keyColumn || keyValue === undefined) {
      throw new Error('DeleteRow requires fileId, tableName, keyColumn, and keyValue');
    }

    ctx.log?.({ type: 'excelonline.deleteRow', location, fileId, tableName, keyColumn, keyValue });

    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);

    // Get column names to find key column index
    const columnsUrl = `${workbookPath}/tables/${encodeURIComponent(tableName)}/columns`;
    const columnsResult = await this.get<{ value: Array<{ name: string }> }>(columnsUrl, ctx.log);
    const columnNames = columnsResult.value.map(col => col.name);
    const keyColIndex = columnNames.indexOf(keyColumn);

    if (keyColIndex === -1) {
      throw new HttpError(`Key column '${keyColumn}' not found in table`, 400, { message: 'Key column not found' });
    }

    // Get all rows to find the matching one
    const rowsUrl = `${workbookPath}/tables/${encodeURIComponent(tableName)}/rows`;
    const rowsResult = await this.get<{ value: Array<{ index: number; values: unknown[][] }> }>(rowsUrl, ctx.log);

    // Find the row index
    let rowIndex = -1;
    for (const row of rowsResult.value) {
      const values = row.values[0] || [];
      if (String(values[keyColIndex]) === String(keyValue)) {
        rowIndex = row.index;
        break;
      }
    }

    if (rowIndex === -1) {
      throw new HttpError(`Row not found with ${keyColumn} = ${keyValue}`, 404, { message: 'Row not found' });
    }

    // Delete the row
    const deleteUrl = `${workbookPath}/tables/${encodeURIComponent(tableName)}/rows/itemAt(index=${rowIndex})`;
    await this.delete(deleteUrl, ctx.log);

    return { ok: true, status: 204 };
  }

  /**
   * Delete a table from a workbook
   */
  private async deleteTable(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number }> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const tableName = String(inputs.tableName);

    if (!fileId || !tableName) {
      throw new Error('DeleteTable requires fileId and tableName');
    }

    ctx.log?.({ type: 'excelonline.deleteTable', location, fileId, tableName });

    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);
    const url = `${workbookPath}/tables/${encodeURIComponent(tableName)}`;

    await this.delete(url, ctx.log);

    return { ok: true, status: 204 };
  }

  /**
   * Delete a worksheet from a workbook
   */
  private async deleteWorksheet(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number }> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const worksheetNameOrId = String(inputs.worksheetNameOrId);

    if (!fileId || !worksheetNameOrId) {
      throw new Error('DeleteWorksheet requires fileId and worksheetNameOrId');
    }

    ctx.log?.({ type: 'excelonline.deleteWorksheet', location, fileId, worksheetNameOrId });

    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);
    const url = `${workbookPath}/worksheets/${encodeURIComponent(worksheetNameOrId)}`;

    await this.delete(url, ctx.log);

    return { ok: true, status: 204 };
  }

  // ============= Range Operations =============

  /**
   * Get cell values from a worksheet range
   */
  private async getRange(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const worksheetNameOrId = String(inputs.worksheetNameOrId);
    const range = String(inputs.range);

    if (!fileId || !worksheetNameOrId || !range) {
      throw new Error('GetRange requires fileId, worksheetNameOrId, and range');
    }

    ctx.log?.({ type: 'excelonline.getRange', location, fileId, worksheetNameOrId, range });

    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);
    const url = `${workbookPath}/worksheets/${encodeURIComponent(worksheetNameOrId)}/range(address='${encodeURIComponent(range)}')`;

    const result = await this.get<{
      values: unknown[][];
      text: string[][];
      formulas: string[][];
      address: string;
    }>(url, ctx.log);

    return {
      values: result.values,
      text: result.text,
      formulas: result.formulas,
      address: result.address,
    };
  }

  /**
   * Update cell values in a worksheet range
   */
  private async updateRange(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const worksheetNameOrId = String(inputs.worksheetNameOrId);
    const range = String(inputs.range);
    const values = inputs.rangeValues as unknown[][] || inputs.values as unknown[][];

    if (!fileId || !worksheetNameOrId || !range || !values) {
      throw new Error('UpdateRange requires fileId, worksheetNameOrId, range, and values');
    }

    ctx.log?.({ type: 'excelonline.updateRange', location, fileId, worksheetNameOrId, range, values });

    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);
    const url = `${workbookPath}/worksheets/${encodeURIComponent(worksheetNameOrId)}/range(address='${encodeURIComponent(range)}')`;

    const result = await this.patch(url, ctx.log, {
      body: { values }
    });

    return result;
  }

  // ============= Column Operations =============

  /**
   * Get column values from a table
   */
  private async getColumn(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const tableName = String(inputs.tableName);
    const columnNameOrId = String(inputs.columnNameOrId);

    if (!fileId || !tableName || !columnNameOrId) {
      throw new Error('GetColumn requires fileId, tableName, and columnNameOrId');
    }

    ctx.log?.({ type: 'excelonline.getColumn', location, fileId, tableName, columnNameOrId });

    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);
    const url = `${workbookPath}/tables/${encodeURIComponent(tableName)}/columns/${encodeURIComponent(columnNameOrId)}`;

    const result = await this.get<{
      name: string;
      values: unknown[][];
      id: string;
      index: number;
    }>(url, ctx.log);

    return {
      name: result.name,
      values: result.values,
      id: result.id,
      index: result.index,
    };
  }

  /**
   * Add a column to a table
   */
  private async addColumn(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const tableName = String(inputs.tableName);
    const columnName = String(inputs.columnName);
    const columnIndex = inputs.columnIndex !== undefined ? Number(inputs.columnIndex) : undefined;
    const values = inputs.values as unknown[][] | undefined;

    if (!fileId || !tableName || !columnName) {
      throw new Error('AddColumn requires fileId, tableName, and columnName');
    }

    ctx.log?.({ type: 'excelonline.addColumn', location, fileId, tableName, columnName, columnIndex, values });

    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);
    // Use /columns/add endpoint (not plain /columns which is OData collection POST
    // and conflicts with existing column IDs)
    const url = `${workbookPath}/tables/${encodeURIComponent(tableName)}/columns/add`;

    const body: Record<string, unknown> = {
      name: columnName,
      index: columnIndex ?? null,
    };
    if (values) {
      body.values = values;
    }

    const result = await this.post(url, ctx.log, { body });

    return result;
  }

  /**
   * Delete a column from a table
   */
  private async deleteColumn(inputs: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; status: number }> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const tableName = String(inputs.tableName);
    const columnNameOrId = String(inputs.columnNameOrId);

    if (!fileId || !tableName || !columnNameOrId) {
      throw new Error('DeleteColumn requires fileId, tableName, and columnNameOrId');
    }

    ctx.log?.({ type: 'excelonline.deleteColumn', location, fileId, tableName, columnNameOrId });

    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);
    const url = `${workbookPath}/tables/${encodeURIComponent(tableName)}/columns/${encodeURIComponent(columnNameOrId)}`;

    await this.delete(url, ctx.log);

    return { ok: true, status: 204 };
  }

  // ============= Script Operations =============

  /**
   * Run an Office Script
   */
  private async runScript(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const scriptFile = String(inputs.scriptFile);
    const scriptParameters = inputs.scriptParameters as Record<string, unknown> | undefined;

    if (!fileId || !scriptFile) {
      throw new Error('RunScript requires fileId and scriptFile');
    }

    ctx.log?.({ type: 'excelonline.runScript', location, fileId, scriptFile, scriptParameters });

    // Note: Running Office Scripts requires using the Office Scripts API
    // which is different from the standard Graph API
    // This would typically be done via Power Automate's internal service

    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);

    // The Graph API endpoint for running scripts
    const url = `${workbookPath}/scripts/${encodeURIComponent(scriptFile)}/run`;

    return this.post(url, ctx.log, {
      body: scriptParameters || {}
    });
  }

  /**
   * Run an Office Script from a SharePoint library
   */
  private async runScriptFromLibrary(inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const location = String(inputs.location || 'me');
    const documentLibrary = inputs.documentLibrary ? String(inputs.documentLibrary) : undefined;
    const fileId = String(inputs.fileId);
    const scriptLocation = String(inputs.scriptLocation || 'me');
    const scriptLibrary = inputs.scriptLibrary ? String(inputs.scriptLibrary) : undefined;
    const scriptFile = String(inputs.scriptFile);
    const scriptParameters = inputs.scriptParameters as Record<string, unknown> | undefined;

    if (!fileId || !scriptFile) {
      throw new Error('RunScriptFromLibrary requires fileId and scriptFile');
    }

    ctx.log?.({ type: 'excelonline.runScriptFromLibrary', location, fileId, scriptLocation, scriptFile, scriptParameters });

    // Similar to runScript but with script from a different location
    const workbookPath = await this.buildWorkbookPath(location, documentLibrary, fileId, ctx.log);
    const scriptPath = await this.buildDrivePath(scriptLocation, scriptLibrary, ctx.log);

    // Build script file reference
    const scriptIsPath = scriptFile.startsWith('/') || scriptFile.includes('/');
    const scriptItemPath = scriptIsPath ? `${scriptPath}/root:${scriptFile}:` : `${scriptPath}/items/${scriptFile}`;

    const url = `${workbookPath}/runScript`;

    return this.post(url, ctx.log, {
      body: {
        script: { '@odata.id': scriptItemPath },
        parameters: scriptParameters || {}
      }
    });
  }

  // ============= Helper Methods =============

  /**
   * Apply a simple filter to rows (client-side implementation)
   */
  private applyFilter(rows: Array<Record<string, unknown>>, filter: string): Array<Record<string, unknown>> {
    // Parse simple OData-like filter expressions
    // Supports: eq, ne, contains, startswith, endswith

    const eqMatch = filter.match(/(\w+)\s+eq\s+'([^']+)'/);
    if (eqMatch) {
      const [, field, value] = eqMatch;
      return rows.filter(row => String(row[field]) === value);
    }

    const neMatch = filter.match(/(\w+)\s+ne\s+'([^']+)'/);
    if (neMatch) {
      const [, field, value] = neMatch;
      return rows.filter(row => String(row[field]) !== value);
    }

    const containsMatch = filter.match(/contains\((\w+),\s*'([^']+)'\)/);
    if (containsMatch) {
      const [, field, value] = containsMatch;
      return rows.filter(row => String(row[field]).includes(value));
    }

    const startsWithMatch = filter.match(/startswith\((\w+),\s*'([^']+)'\)/);
    if (startsWithMatch) {
      const [, field, value] = startsWithMatch;
      return rows.filter(row => String(row[field]).startsWith(value));
    }

    const endsWithMatch = filter.match(/endswith\((\w+),\s*'([^']+)'\)/);
    if (endsWithMatch) {
      const [, field, value] = endsWithMatch;
      return rows.filter(row => String(row[field]).endsWith(value));
    }

    // If filter pattern not recognized, return all rows
    return rows;
  }

  /**
   * Apply ordering to rows
   */
  private applyOrderBy(rows: Array<Record<string, unknown>>, orderBy: string): Array<Record<string, unknown>> {
    const parts = orderBy.trim().split(/\s+/);
    const field = parts[0];
    const direction = parts[1]?.toLowerCase() === 'desc' ? -1 : 1;

    return [...rows].sort((a, b) => {
      const aVal = a[field];
      const bVal = b[field];

      if (aVal === bVal) return 0;
      if (aVal === null || aVal === undefined) return direction;
      if (bVal === null || bVal === undefined) return -direction;

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return (aVal - bVal) * direction;
      }

      return String(aVal).localeCompare(String(bVal)) * direction;
    });
  }
}

export default ExcelOnlineConnector;

// Export metadata for language service
export { excelOnlineMetadata, excelonlineScopes } from './metadata.js';
