/**
 * Excel Online Connector Metadata
 *
 * Defines Excel Online operations with their parameters and documentation.
 * Used by the language service for completions and hover docs.
 */

import {
  type ConnectorMetadata,
  param,
  operation,
  connector,
} from '@flowforger/connectors-shared';

export const excelOnlineMetadata: ConnectorMetadata = connector(
  'excelOnline',
  'Excel Online (Business)',
  'Microsoft Excel Online connector for working with Excel workbooks, tables, and data.',
  [
    // ============= Row Operations =============
    operation('ListRows', 'List rows from an Excel table.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ListRowsParams', 'Operation parameters'),
    ], {
      category: 'Rows',
      examples: [`ctx.connectors.excelOnline.ListRows('GetSalesData', {\n  source: 'OneDrive',\n  driveId: 'drive-id',\n  fileId: 'file-id',\n  tableName: 'SalesTable',\n  $top: 100\n});`],
    }),

    operation('GetRow', 'Get a single row from an Excel table.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetRowParams', 'Operation parameters'),
    ], { category: 'Rows' }),

    operation('AddRow', 'Add a new row to an Excel table.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'AddRowParams', 'Operation parameters'),
    ], {
      category: 'Rows',
      examples: [`ctx.connectors.excelOnline.AddRow('AddSale', {\n  source: 'OneDrive',\n  driveId: 'drive-id',\n  fileId: 'file-id',\n  tableName: 'SalesTable',\n  item: {\n    Product: 'Widget',\n    Quantity: 10,\n    Price: 99.99\n  }\n});`],
    }),

    operation('UpdateRow', 'Update an existing row in an Excel table.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'UpdateRowParams', 'Operation parameters'),
    ], { category: 'Rows' }),

    operation('DeleteRow', 'Delete a row from an Excel table.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'DeleteRowParams', 'Operation parameters'),
    ], { category: 'Rows' }),

    // ============= Table Operations =============
    operation('GetTables', 'Get list of tables in a workbook.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetTablesParams', 'Operation parameters'),
    ], { category: 'Tables' }),

    operation('CreateTable', 'Create a new table in a workbook.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CreateTableParams', 'Operation parameters'),
    ], { category: 'Tables' }),

    operation('CreateIdColumn', 'Add a key column to a table for row identification.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CreateIdColumnParams', 'Operation parameters'),
    ], { category: 'Tables' }),

    operation('DeleteTable', 'Delete a table from a workbook.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'DeleteTableParams', 'Operation parameters'),
    ], { category: 'Tables' }),

    // ============= Worksheet Operations =============
    operation('GetWorksheets', 'Get list of worksheets in a workbook.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetWorksheetsParams', 'Operation parameters'),
    ], { category: 'Worksheets' }),

    operation('CreateWorksheet', 'Create a new worksheet in a workbook.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CreateWorksheetParams', 'Operation parameters'),
    ], { category: 'Worksheets' }),

    operation('DeleteWorksheet', 'Delete a worksheet from a workbook.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'DeleteWorksheetParams', 'Operation parameters'),
    ], { category: 'Worksheets' }),

    // ============= Range Operations =============
    operation('GetRange', 'Get cell values from a worksheet range.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetRangeParams', 'Operation parameters'),
    ], {
      category: 'Ranges',
      examples: [`ctx.connectors.excelOnline.GetRange('GetData', {\n  location: 'me',\n  fileId: 'file-id',\n  worksheetNameOrId: 'Sheet1',\n  range: 'A1:C10'\n});`],
    }),

    operation('UpdateRange', 'Update cell values in a worksheet range.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'UpdateRangeParams', 'Operation parameters'),
    ], {
      category: 'Ranges',
      examples: [`ctx.connectors.excelOnline.UpdateRange('UpdateData', {\n  location: 'me',\n  fileId: 'file-id',\n  worksheetNameOrId: 'Sheet1',\n  range: 'A1:B2',\n  values: [['Hello', 'World'], ['Foo', 'Bar']]\n});`],
    }),

    // ============= Column Operations =============
    operation('GetColumn', 'Get column values from a table.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetColumnParams', 'Operation parameters'),
    ], { category: 'Columns' }),

    operation('AddColumn', 'Add a column to a table.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'AddColumnParams', 'Operation parameters'),
    ], {
      category: 'Columns',
      examples: [`ctx.connectors.excelOnline.AddColumn('AddCategory', {\n  location: 'me',\n  fileId: 'file-id',\n  tableName: 'SalesTable',\n  columnName: 'Category',\n  index: 2\n});`],
    }),

    operation('DeleteColumn', 'Delete a column from a table.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'DeleteColumnParams', 'Operation parameters'),
    ], { category: 'Columns' }),

    // ============= Script Operations =============
    operation('RunScript', 'Run an Office Script on a workbook.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'RunScriptParams', 'Operation parameters'),
    ], {
      category: 'Scripts',
      examples: [`ctx.connectors.excelOnline.RunScript('ProcessData', {\n  source: 'OneDrive',\n  driveId: 'drive-id',\n  fileId: 'file-id',\n  scriptId: 'script-id',\n  scriptParameters: { startRow: 1, endRow: 100 }\n});`],
    }),

    operation('RunScriptFromLibrary', 'Run an Office Script from a shared library.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'RunScriptFromLibraryParams', 'Operation parameters'),
    ], { category: 'Scripts' }),
  ],
  {
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/excelonlinebusiness/',
  }
);

/**
 * Excel Online uses Graph API Files scope for all operations.
 */
export const excelonlineScopes = { default: ['Files.ReadWrite'] };

export default excelOnlineMetadata;
