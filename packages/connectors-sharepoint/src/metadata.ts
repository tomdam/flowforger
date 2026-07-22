/**
 * SharePoint Connector Metadata
 *
 * Defines all SharePoint operations with their parameters and documentation.
 * Used by the language service for completions and hover docs.
 */

import {
  type ConnectorMetadata,
  param,
  operation,
  connector,
} from '@flowforger/connectors-shared';

export const sharePointMetadata: ConnectorMetadata = connector(
  'sharepoint',
  'SharePoint',
  'SharePoint REST API connector for working with lists, items, files, and folders.',
  [
    // ============= List Item Operations =============
    operation(
      'GetItems',
      'Get items from a SharePoint list.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetItemsParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Items',
        examples: [
          `ctx.connectors.sharepoint.GetItems('GetTasks', {
  dataset: 'https://tenant.sharepoint.com/sites/mysite',
  table: 'list-guid-here',
  $filter: "Status eq 'Active'",
  $top: 100
});`,
        ],
      }
    ),
    operation(
      'GetItem',
      'Get a single item by ID from a SharePoint list.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetItemParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Items',
        examples: [
          `ctx.connectors.sharepoint.GetItem('GetTask', {
  dataset: 'https://tenant.sharepoint.com/sites/mysite',
  table: 'list-guid-here',
  itemId: 42
});`,
        ],
      }
    ),
    operation(
      'CreateItem',
      'Create a new item in a SharePoint list.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'CreateItemParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Items',
        examples: [
          `ctx.connectors.sharepoint.CreateItem('CreateTask', {
  dataset: 'https://tenant.sharepoint.com/sites/mysite',
  table: 'list-guid-here',
  item: { Title: 'New Task', Status: 'Active' }
});`,
        ],
      }
    ),
    operation(
      'UpdateItem',
      'Update an existing item in a SharePoint list.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'UpdateItemParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Items',
        examples: [
          `ctx.connectors.sharepoint.UpdateItem('UpdateTask', {
  dataset: 'https://tenant.sharepoint.com/sites/mysite',
  table: 'list-guid-here',
  itemId: 42,
  item: { Status: 'Completed' }
});`,
        ],
      }
    ),
    operation(
      'DeleteItem',
      'Delete an item from a SharePoint list.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'DeleteItemParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Items',
        examples: [
          `ctx.connectors.sharepoint.DeleteItem('DeleteTask', {
  dataset: 'https://tenant.sharepoint.com/sites/mysite',
  table: 'list-guid-here',
  itemId: 42
});`,
        ],
      }
    ),

    // ============= File Operations =============
    operation(
      'CreateFile',
      'Create a new file in a SharePoint library.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'CreateFileParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Files',
        examples: [
          `ctx.connectors.sharepoint.CreateFile('UploadDocument', {
  dataset: 'https://tenant.sharepoint.com/sites/mysite',
  folderPath: '/Shared Documents/Reports',
  fileName: 'report.pdf',
  body: fileContent
});`,
        ],
      }
    ),
    operation(
      'GetFileContent',
      'Get the content of a file by ID.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetFileContentParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Files',
        examples: [
          `ctx.connectors.sharepoint.GetFileContent('DownloadFile', {
  dataset: 'https://tenant.sharepoint.com/sites/mysite',
  id: 'file-guid-here'
});`,
        ],
      }
    ),
    operation(
      'GetFileContentByPath',
      'Get the content of a file by server-relative path.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetFileContentByPathParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Files',
        examples: [
          `ctx.connectors.sharepoint.GetFileContentByPath('DownloadByPath', {
  dataset: 'https://tenant.sharepoint.com/sites/mysite',
  path: '/sites/mysite/Shared Documents/report.pdf'
});`,
        ],
      }
    ),
    operation(
      'UpdateFile',
      'Update the content of an existing file.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'UpdateFileParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Files',
      }
    ),
    operation(
      'DeleteFile',
      'Delete a file from a SharePoint library.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'DeleteFileParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Files',
      }
    ),
    operation(
      'CopyFile',
      'Copy a file to a new location.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'CopyFileParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Files',
        examples: [
          `ctx.connectors.sharepoint.CopyFile('CopyReport', {
  dataset: 'https://tenant.sharepoint.com/sites/mysite',
  id: 'file-guid-here',
  destFolderPath: '/sites/mysite/Archive'
});`,
        ],
      }
    ),
    operation(
      'MoveFile',
      'Move a file to a new location.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'MoveFileParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Files',
      }
    ),
    operation(
      'GetFileMetadata',
      'Get metadata for a file by ID.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetFileMetadataParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Files',
      }
    ),
    operation(
      'GetFileMetadataByPath',
      'Get metadata for a file by server-relative path.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetFileMetadataByPathParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Files',
      }
    ),
    operation(
      'GetFileProperties',
      'Get list item properties for a file.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetFilePropertiesParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Files',
      }
    ),
    operation(
      'UpdateFileProperties',
      'Update list item properties for a file.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'UpdateFilePropertiesParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Files',
      }
    ),
    operation(
      'GetFilesPropertiesOnly',
      'Get properties of all files in a library (without content).',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetFilesPropertiesOnlyParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Files',
      }
    ),
    operation(
      'CheckOutFile',
      'Check out a file for editing.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'CheckOutFileParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Files',
      }
    ),
    operation(
      'CheckInFile',
      'Check in a file after editing.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'CheckInFileParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Files',
      }
    ),
    operation(
      'DiscardCheckOut',
      'Discard changes and undo check out.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'DiscardCheckOutParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Files',
      }
    ),

    // ============= Folder Operations =============
    operation(
      'CreateNewFolder',
      'Create a new folder in a SharePoint library.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'CreateFolderParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Folders',
        examples: [
          `ctx.connectors.sharepoint.CreateNewFolder('CreateArchive', {
  dataset: 'https://tenant.sharepoint.com/sites/mysite',
  table: 'library-guid-here',
  'parameters/path': 'Archive/2024'
});`,
        ],
      }
    ),
    operation(
      'ListFolder',
      'List files and folders in a folder by ID.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'ListFolderParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Folders',
      }
    ),
    operation(
      'ListRootFolder',
      'List files and folders by server-relative path.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'ListRootFolderParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Folders',
      }
    ),
    operation(
      'GetFolderMetadata',
      'Get metadata for a folder by ID.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetFolderMetadataParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Folders',
      }
    ),
    operation(
      'GetFolderMetadataByPath',
      'Get metadata for a folder by server-relative path.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetFolderMetadataByPathParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Folders',
      }
    ),
    operation(
      'CopyFolder',
      'Copy a folder to a new location.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'CopyFolderParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Folders',
      }
    ),
    operation(
      'MoveFolder',
      'Move a folder to a new location.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'MoveFolderParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Folders',
      }
    ),
    operation(
      'ExtractFolder',
      'Extract a ZIP file to a folder.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'ExtractFolderParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Folders',
      }
    ),

    // ============= Attachment Operations =============
    operation(
      'AddAttachment',
      'Add an attachment to a list item.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'AddAttachmentParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Attachments',
      }
    ),
    operation(
      'GetAttachments',
      'Get all attachments for a list item.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetAttachmentsParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Attachments',
      }
    ),
    operation(
      'GetAttachmentContent',
      'Get the content of an attachment.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetAttachmentContentParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Attachments',
      }
    ),
    operation(
      'DeleteAttachment',
      'Delete an attachment from a list item.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'DeleteAttachmentParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Attachments',
      }
    ),

    // ============= Sharing Operations =============
    operation(
      'CreateSharingLink',
      'Create a sharing link for a file.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'CreateSharingLinkParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Sharing',
        examples: [
          `ctx.connectors.sharepoint.CreateSharingLink('ShareReport', {
  dataset: 'https://tenant.sharepoint.com/sites/mysite',
  id: 'file-guid-here',
  linkType: 'view',
  scope: 'organization'
});`,
        ],
      }
    ),
    operation(
      'GrantAccess',
      'Grant access to a file for specific users.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GrantAccessParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Sharing',
      }
    ),
    operation(
      'StopSharing',
      'Stop sharing a file.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'StopSharingParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Sharing',
      }
    ),

    // ============= Approval Operations =============
    operation(
      'SetContentApprovalStatus',
      'Set the approval status of an item.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'SetContentApprovalStatusParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Approval',
        examples: [
          `ctx.connectors.sharepoint.SetContentApprovalStatus('ApproveDocument', {
  dataset: 'https://tenant.sharepoint.com/sites/mysite',
  table: 'list-guid-here',
  itemId: 42,
  approvalStatus: 'Approved',
  comments: 'Looks good!'
});`,
        ],
      }
    ),
    operation(
      'GetContentApprovalStatus',
      'Get the approval status of an item.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetContentApprovalStatusParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Approval',
      }
    ),

    // ============= List Operations =============
    operation(
      'GetAllListsAndLibraries',
      'Get all lists and libraries from a site.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetListsParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Lists',
        examples: [
          `ctx.connectors.sharepoint.GetAllListsAndLibraries('GetLists', {
  dataset: 'https://tenant.sharepoint.com/sites/mysite'
});`,
        ],
      }
    ),
    operation(
      'GetListViews',
      'Get all views for a list.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetListViewsParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Lists',
      }
    ),

    // ============= User Operations =============
    operation(
      'ResolvePerson',
      'Resolve a person by email or login name.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'ResolvePersonParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Users',
        examples: [
          `ctx.connectors.sharepoint.ResolvePerson('GetUser', {
  dataset: 'https://tenant.sharepoint.com/sites/mysite',
  email: 'user@tenant.com'
});`,
        ],
      }
    ),

    // ============= HTTP Operations =============
    operation(
      'SendHttpRequest',
      'Send a custom HTTP request to SharePoint REST API.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'SendHttpRequestParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Advanced',
        examples: [
          `ctx.connectors.sharepoint.SendHttpRequest('CustomRequest', {
  dataset: 'https://tenant.sharepoint.com/sites/mysite',
  'parameters/method': 'GET',
  'parameters/uri': '_api/web/currentuser'
});`,
        ],
      }
    ),

    // ============= Change Operations =============
    operation(
      'GetItemChanges',
      'Get version history for an item.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetItemChangesParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Items',
      }
    ),
  ],
  {
    docsUrl: 'https://learn.microsoft.com/en-us/sharepoint/dev/sp-add-ins/sharepoint-net-server-csom-jsom-and-rest-api-index',
  }
);

/**
 * SharePoint uses a single scope for all operations.
 * The actual scope URL is resource-specific: {sharepointUrl}/AllSites.Write
 */
export const sharepointScopes = { default: ['AllSites.Write'] };

export default sharePointMetadata;
