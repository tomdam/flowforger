/**
 * Connector operation definitions for autocomplete.
 * These are used for ctx.connectors.{connector}.{operation} completions.
 */

import type { ConnectorOperation } from '../types.js';

/**
 * Dataverse connector operations.
 */
export const dataverseOperations: ConnectorOperation[] = [
  {
    connector: 'dataverse',
    operation: 'ListRecords',
    description: 'List rows from a Dataverse table.',
    parameters: [
      { name: 'entityName', type: 'string', description: 'Table logical name (e.g., "accounts")' },
      { name: '$filter', type: 'string', description: 'OData filter expression', optional: true },
      { name: '$select', type: 'string', description: 'Columns to return', optional: true },
      { name: '$orderby', type: 'string', description: 'Sort order', optional: true },
      { name: '$top', type: 'number', description: 'Maximum rows to return', optional: true },
      { name: '$expand', type: 'string', description: 'Related entities to expand', optional: true },
    ],
  },
  {
    connector: 'dataverse',
    operation: 'CreateRecord',
    description: 'Create a new row in a Dataverse table.',
    parameters: [
      { name: 'entityName', type: 'string', description: 'Table logical name' },
      { name: 'item', type: 'object', description: 'Record data to create' },
    ],
  },
  {
    connector: 'dataverse',
    operation: 'UpdateRecord',
    description: 'Update an existing row in a Dataverse table.',
    parameters: [
      { name: 'entityName', type: 'string', description: 'Table logical name' },
      { name: 'recordId', type: 'string', description: 'GUID of the record to update' },
      { name: 'item', type: 'object', description: 'Record data to update' },
    ],
  },
  {
    connector: 'dataverse',
    operation: 'UpdateOnlyRecord',
    description: 'Update only specified fields of an existing row.',
    parameters: [
      { name: 'entityName', type: 'string', description: 'Table logical name' },
      { name: 'recordId', type: 'string', description: 'GUID of the record to update' },
      { name: 'item', type: 'object', description: 'Record data to update' },
    ],
  },
  {
    connector: 'dataverse',
    operation: 'DeleteRecord',
    description: 'Delete a row from a Dataverse table.',
    parameters: [
      { name: 'entityName', type: 'string', description: 'Table logical name' },
      { name: 'recordId', type: 'string', description: 'GUID of the record to delete' },
    ],
  },
  {
    connector: 'dataverse',
    operation: 'GetItem',
    description: 'Get a single row by ID.',
    parameters: [
      { name: 'entityName', type: 'string', description: 'Table logical name' },
      { name: 'recordId', type: 'string', description: 'GUID of the record' },
      { name: '$select', type: 'string', description: 'Columns to return', optional: true },
      { name: '$expand', type: 'string', description: 'Related entities to expand', optional: true },
    ],
  },
  {
    connector: 'dataverse',
    operation: 'RetrieveRecord',
    description: 'Retrieve a single row with all details.',
    parameters: [
      { name: 'entityName', type: 'string', description: 'Table logical name' },
      { name: 'recordId', type: 'string', description: 'GUID of the record' },
      { name: '$select', type: 'string', description: 'Columns to return', optional: true },
      { name: '$expand', type: 'string', description: 'Related entities to expand', optional: true },
    ],
  },
];

/**
 * SharePoint connector operations.
 */
export const sharePointOperations: ConnectorOperation[] = [
  {
    connector: 'sharepoint',
    operation: 'GetItems',
    description: 'Get items from a SharePoint list.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'table', type: 'string', description: 'List GUID or title' },
      { name: '$filter', type: 'string', description: 'OData filter expression', optional: true },
      { name: '$orderby', type: 'string', description: 'Sort order', optional: true },
      { name: '$top', type: 'number', description: 'Maximum items to return', optional: true },
      { name: '$select', type: 'string', description: 'Columns to return', optional: true },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'GetItemById',
    description: 'Get a single item by ID.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'table', type: 'string', description: 'List GUID or title' },
      { name: 'id', type: 'number', description: 'Item ID' },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'CreateItem',
    description: 'Create a new item in a SharePoint list.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'table', type: 'string', description: 'List GUID or title' },
      { name: 'item', type: 'object', description: 'Item data to create' },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'PostItem',
    description: 'Create a new item (POST method).',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'table', type: 'string', description: 'List GUID or title' },
      { name: 'item', type: 'object', description: 'Item data to create' },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'UpdateItem',
    description: 'Update an existing item.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'table', type: 'string', description: 'List GUID or title' },
      { name: 'id', type: 'number', description: 'Item ID' },
      { name: 'item', type: 'object', description: 'Item data to update' },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'PatchItem',
    description: 'Partially update an item (PATCH method).',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'table', type: 'string', description: 'List GUID or title' },
      { name: 'id', type: 'number', description: 'Item ID' },
      { name: 'item', type: 'object', description: 'Item data to update' },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'DeleteItem',
    description: 'Delete an item from a SharePoint list.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'table', type: 'string', description: 'List GUID or title' },
      { name: 'id', type: 'number', description: 'Item ID' },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'CreateNewFolder',
    description: 'Create a new folder.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'table', type: 'string', description: 'Library name' },
      { name: 'folderPath', type: 'string', description: 'Parent folder path' },
      { name: 'name', type: 'string', description: 'New folder name' },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'CreateFile',
    description: 'Create a new file.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'folderPath', type: 'string', description: 'Destination folder path' },
      { name: 'name', type: 'string', description: 'File name' },
      { name: 'body', type: 'any', description: 'File content' },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'GetFileContent',
    description: 'Get file content by file identifier.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'id', type: 'string', description: 'File identifier' },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'GetFileContentByPath',
    description: 'Get file content by path.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'path', type: 'string', description: 'File path' },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'UpdateFile',
    description: 'Update file content.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'id', type: 'string', description: 'File identifier' },
      { name: 'body', type: 'any', description: 'New file content' },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'DeleteFile',
    description: 'Delete a file.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'id', type: 'string', description: 'File identifier' },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'CopyFile',
    description: 'Copy a file.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'sourceFileId', type: 'string', description: 'Source file identifier' },
      { name: 'destinationDataset', type: 'string', description: 'Destination site URL' },
      { name: 'destinationFolderPath', type: 'string', description: 'Destination folder path' },
      { name: 'name', type: 'string', description: 'New file name', optional: true },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'CopyFileAsync',
    description: 'Copy a file asynchronously.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'sourceFileId', type: 'string', description: 'Source file identifier' },
      { name: 'destinationDataset', type: 'string', description: 'Destination site URL' },
      { name: 'destinationFolderPath', type: 'string', description: 'Destination folder path' },
      { name: 'name', type: 'string', description: 'New file name', optional: true },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'MoveFile',
    description: 'Move a file.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'sourceFileId', type: 'string', description: 'Source file identifier' },
      { name: 'destinationDataset', type: 'string', description: 'Destination site URL' },
      { name: 'destinationFolderPath', type: 'string', description: 'Destination folder path' },
      { name: 'name', type: 'string', description: 'New file name', optional: true },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'MoveFileAsync',
    description: 'Move a file asynchronously.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'sourceFileId', type: 'string', description: 'Source file identifier' },
      { name: 'destinationDataset', type: 'string', description: 'Destination site URL' },
      { name: 'destinationFolderPath', type: 'string', description: 'Destination folder path' },
      { name: 'name', type: 'string', description: 'New file name', optional: true },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'ListFolder',
    description: 'List files and folders in a folder.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'id', type: 'string', description: 'Folder identifier' },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'GetOnNewFileItems',
    description: 'Get items when a file is created.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'table', type: 'string', description: 'Library name' },
      { name: 'folderId', type: 'string', description: 'Folder identifier', optional: true },
    ],
  },
  {
    connector: 'sharepoint',
    operation: 'SendHttpRequest',
    description: 'Send a custom HTTP request to SharePoint.',
    parameters: [
      { name: 'dataset', type: 'string', description: 'Site URL' },
      { name: 'method', type: 'string', description: 'HTTP method (GET, POST, PATCH, DELETE)' },
      { name: 'uri', type: 'string', description: 'Request URI (relative to site)' },
      { name: 'headers', type: 'object', description: 'Request headers', optional: true },
      { name: 'body', type: 'any', description: 'Request body', optional: true },
    ],
  },
];

/**
 * Office 365 connector operations.
 */
export const office365Operations: ConnectorOperation[] = [
  {
    connector: 'office365',
    operation: 'SendEmailV2',
    description: 'Send an email (V2).',
    parameters: [
      { name: 'to', type: 'string', description: 'Recipients (semicolon-separated)' },
      { name: 'subject', type: 'string', description: 'Email subject' },
      { name: 'body', type: 'string', description: 'Email body' },
      { name: 'from', type: 'string', description: 'From address', optional: true },
      { name: 'cc', type: 'string', description: 'CC recipients', optional: true },
      { name: 'bcc', type: 'string', description: 'BCC recipients', optional: true },
      { name: 'importance', type: 'string', description: 'Importance (Low, Normal, High)', optional: true },
      { name: 'isHtml', type: 'boolean', description: 'Whether body is HTML', optional: true },
    ],
  },
  {
    connector: 'office365',
    operation: 'SendEmail',
    description: 'Send an email.',
    parameters: [
      { name: 'to', type: 'string', description: 'Recipients' },
      { name: 'subject', type: 'string', description: 'Email subject' },
      { name: 'body', type: 'string', description: 'Email body' },
    ],
  },
  {
    connector: 'office365',
    operation: 'GetEmailsV2',
    description: 'Get emails (V2).',
    parameters: [
      { name: 'folderPath', type: 'string', description: 'Folder path (e.g., "Inbox")' },
      { name: 'top', type: 'number', description: 'Maximum emails to return', optional: true },
      { name: 'fetchOnlyUnread', type: 'boolean', description: 'Only fetch unread', optional: true },
      { name: 'includeAttachments', type: 'boolean', description: 'Include attachments', optional: true },
      { name: 'searchQuery', type: 'string', description: 'Search query', optional: true },
    ],
  },
  {
    connector: 'office365',
    operation: 'GetEmails',
    description: 'Get emails.',
    parameters: [
      { name: 'folderPath', type: 'string', description: 'Folder path' },
    ],
  },
  {
    connector: 'office365',
    operation: 'GetEmailV2',
    description: 'Get a single email by ID.',
    parameters: [
      { name: 'messageId', type: 'string', description: 'Message ID' },
      { name: 'includeAttachments', type: 'boolean', description: 'Include attachments', optional: true },
    ],
  },
  {
    connector: 'office365',
    operation: 'ReplyToEmailV2',
    description: 'Reply to an email.',
    parameters: [
      { name: 'messageId', type: 'string', description: 'Original message ID' },
      { name: 'body', type: 'string', description: 'Reply body' },
      { name: 'replyAll', type: 'boolean', description: 'Reply to all', optional: true },
    ],
  },
  {
    connector: 'office365',
    operation: 'ForwardEmailV2',
    description: 'Forward an email.',
    parameters: [
      { name: 'messageId', type: 'string', description: 'Original message ID' },
      { name: 'to', type: 'string', description: 'Forward recipients' },
      { name: 'body', type: 'string', description: 'Additional message', optional: true },
    ],
  },
  {
    connector: 'office365',
    operation: 'DeleteEmailV2',
    description: 'Delete an email.',
    parameters: [
      { name: 'messageId', type: 'string', description: 'Message ID to delete' },
    ],
  },
  {
    connector: 'office365',
    operation: 'MoveEmailV2',
    description: 'Move an email to a folder.',
    parameters: [
      { name: 'messageId', type: 'string', description: 'Message ID' },
      { name: 'destinationFolderPath', type: 'string', description: 'Destination folder' },
    ],
  },
  {
    connector: 'office365',
    operation: 'CreateEventV4',
    description: 'Create a calendar event.',
    parameters: [
      { name: 'calendarId', type: 'string', description: 'Calendar ID', optional: true },
      { name: 'subject', type: 'string', description: 'Event subject' },
      { name: 'start', type: 'string', description: 'Start date/time' },
      { name: 'end', type: 'string', description: 'End date/time' },
      { name: 'timeZone', type: 'string', description: 'Time zone', optional: true },
      { name: 'body', type: 'string', description: 'Event body', optional: true },
      { name: 'location', type: 'string', description: 'Location', optional: true },
      { name: 'requiredAttendees', type: 'string', description: 'Required attendees', optional: true },
      { name: 'optionalAttendees', type: 'string', description: 'Optional attendees', optional: true },
      { name: 'isAllDay', type: 'boolean', description: 'All-day event', optional: true },
    ],
  },
  {
    connector: 'office365',
    operation: 'GetEventsV4',
    description: 'Get calendar events.',
    parameters: [
      { name: 'calendarId', type: 'string', description: 'Calendar ID', optional: true },
      { name: 'startDateTime', type: 'string', description: 'Start filter', optional: true },
      { name: 'endDateTime', type: 'string', description: 'End filter', optional: true },
    ],
  },
  {
    connector: 'office365',
    operation: 'UpdateEventV4',
    description: 'Update a calendar event.',
    parameters: [
      { name: 'calendarId', type: 'string', description: 'Calendar ID', optional: true },
      { name: 'eventId', type: 'string', description: 'Event ID' },
      { name: 'subject', type: 'string', description: 'Event subject', optional: true },
      { name: 'start', type: 'string', description: 'Start date/time', optional: true },
      { name: 'end', type: 'string', description: 'End date/time', optional: true },
      { name: 'body', type: 'string', description: 'Event body', optional: true },
    ],
  },
  {
    connector: 'office365',
    operation: 'DeleteEventV4',
    description: 'Delete a calendar event.',
    parameters: [
      { name: 'calendarId', type: 'string', description: 'Calendar ID', optional: true },
      { name: 'eventId', type: 'string', description: 'Event ID' },
    ],
  },
];

/**
 * Word Online connector operations.
 */
export const wordOnlineOperations: ConnectorOperation[] = [
  {
    connector: 'wordonline',
    operation: 'PopulateAWordTemplate',
    description: 'Populate a Word template with data.',
    parameters: [
      { name: 'source', type: 'string', description: 'Document location' },
      { name: 'locationName', type: 'string', description: 'Library name' },
      { name: 'file', type: 'string', description: 'File path' },
      { name: 'data', type: 'object', description: 'Template data' },
    ],
  },
  {
    connector: 'wordonline',
    operation: 'ConvertWordDocumentToPdf',
    description: 'Convert a Word document to PDF.',
    parameters: [
      { name: 'source', type: 'string', description: 'Document location' },
      { name: 'locationName', type: 'string', description: 'Library name' },
      { name: 'file', type: 'string', description: 'File path' },
    ],
  },
];

/**
 * Excel Online connector operations.
 */
export const excelOnlineOperations: ConnectorOperation[] = [
  {
    connector: 'excelonline',
    operation: 'GetTables',
    description: 'Get tables from an Excel workbook.',
    parameters: [
      { name: 'source', type: 'string', description: 'Document location' },
      { name: 'drive', type: 'string', description: 'Document library' },
      { name: 'file', type: 'string', description: 'File path' },
    ],
  },
  {
    connector: 'excelonline',
    operation: 'GetRows',
    description: 'Get rows from an Excel table.',
    parameters: [
      { name: 'source', type: 'string', description: 'Document location' },
      { name: 'drive', type: 'string', description: 'Document library' },
      { name: 'file', type: 'string', description: 'File path' },
      { name: 'table', type: 'string', description: 'Table name' },
      { name: '$top', type: 'number', description: 'Maximum rows', optional: true },
      { name: '$skip', type: 'number', description: 'Rows to skip', optional: true },
      { name: '$orderby', type: 'string', description: 'Sort order', optional: true },
      { name: '$filter', type: 'string', description: 'Filter expression', optional: true },
    ],
  },
  {
    connector: 'excelonline',
    operation: 'AddRow',
    description: 'Add a row to an Excel table.',
    parameters: [
      { name: 'source', type: 'string', description: 'Document location' },
      { name: 'drive', type: 'string', description: 'Document library' },
      { name: 'file', type: 'string', description: 'File path' },
      { name: 'table', type: 'string', description: 'Table name' },
      { name: 'item', type: 'object', description: 'Row data' },
    ],
  },
  {
    connector: 'excelonline',
    operation: 'UpdateRow',
    description: 'Update a row in an Excel table.',
    parameters: [
      { name: 'source', type: 'string', description: 'Document location' },
      { name: 'drive', type: 'string', description: 'Document library' },
      { name: 'file', type: 'string', description: 'File path' },
      { name: 'table', type: 'string', description: 'Table name' },
      { name: 'id', type: 'string', description: 'Row ID' },
      { name: 'item', type: 'object', description: 'Row data' },
    ],
  },
  {
    connector: 'excelonline',
    operation: 'DeleteRow',
    description: 'Delete a row from an Excel table.',
    parameters: [
      { name: 'source', type: 'string', description: 'Document location' },
      { name: 'drive', type: 'string', description: 'Document library' },
      { name: 'file', type: 'string', description: 'File path' },
      { name: 'table', type: 'string', description: 'Table name' },
      { name: 'id', type: 'string', description: 'Row ID' },
    ],
  },
];

/**
 * Approvals connector operations.
 */
export const approvalsOperations: ConnectorOperation[] = [
  {
    connector: 'approvals',
    operation: 'StartAndWaitForAnApproval',
    description: 'Start an approval and wait for a response.',
    parameters: [
      { name: 'approvalType', type: 'string', description: 'Approval type (Basic, Custom)' },
      { name: 'title', type: 'string', description: 'Approval title' },
      { name: 'assignedTo', type: 'string', description: 'Approvers (semicolon-separated)' },
      { name: 'details', type: 'string', description: 'Approval details', optional: true },
      { name: 'itemLink', type: 'string', description: 'Link to item', optional: true },
      { name: 'itemLinkDescription', type: 'string', description: 'Link description', optional: true },
    ],
  },
  {
    connector: 'approvals',
    operation: 'CreateAnApproval',
    description: 'Create an approval without waiting.',
    parameters: [
      { name: 'approvalType', type: 'string', description: 'Approval type' },
      { name: 'title', type: 'string', description: 'Approval title' },
      { name: 'assignedTo', type: 'string', description: 'Approvers' },
      { name: 'details', type: 'string', description: 'Approval details', optional: true },
    ],
  },
  {
    connector: 'approvals',
    operation: 'WaitForAnApproval',
    description: 'Wait for an existing approval to complete.',
    parameters: [
      { name: 'approvalId', type: 'string', description: 'Approval ID' },
    ],
  },
];

/**
 * All connector operations organized by connector name.
 */
export const connectorOperations: Record<string, ConnectorOperation[]> = {
  dataverse: dataverseOperations,
  sharepoint: sharePointOperations,
  office365: office365Operations,
  wordonline: wordOnlineOperations,
  excelonline: excelOnlineOperations,
  approvals: approvalsOperations,
};

/**
 * Get operations for a specific connector.
 */
export function getConnectorOperations(connector: string): ConnectorOperation[] {
  return connectorOperations[connector.toLowerCase()] || [];
}

/**
 * Get all connector names.
 */
export function getConnectorNames(): string[] {
  return Object.keys(connectorOperations);
}

/**
 * Find a specific operation.
 */
export function findOperation(connector: string, operation: string): ConnectorOperation | undefined {
  const ops = getConnectorOperations(connector);
  return ops.find((op) => op.operation === operation);
}
