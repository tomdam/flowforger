/**
 * OneDrive for Business Connector Metadata
 *
 * Defines all OneDrive for Business operations with their parameters and documentation.
 * Used by the language service for completions and hover docs.
 */

import {
  type ConnectorMetadata,
  param,
  operation,
  connector,
} from '@flowforger/connectors-shared';

export const oneDriveMetadata: ConnectorMetadata = connector(
  'onedriveforbusiness',
  'OneDrive for Business',
  'Microsoft Graph connector for managing OneDrive files. Upload, download, convert, copy, move, and delete files.',
  [
    // ---- File CRUD ----
    operation('CreateFile', 'Create a file in OneDrive.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CreateFileParams', 'Operation parameters: { folderPath: string, name: string, body: any }'),
    ], { category: 'File', examples: [`ctx.connectors.onedriveforbusiness.CreateFile('UploadDoc', {\n  folderPath: '/',\n  name: 'report.docx',\n  body: ctx.body('PreviousStep')\n});`] }),

    operation('UpdateFile', 'Update file content by ID.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'UpdateFileParams', 'Operation parameters: { id: string, body: any }'),
    ], { category: 'File' }),

    operation('GetFileContent', 'Get file content by ID.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetFileContentParams', 'Operation parameters: { id: string }'),
    ], { category: 'File' }),

    operation('GetFileContentByPath', 'Get file content by path.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetFileContentByPathParams', 'Operation parameters: { path: string }'),
    ], { category: 'File' }),

    operation('GetFileMetadata', 'Get file metadata by ID.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetFileMetadataParams', 'Operation parameters: { id: string }'),
    ], { category: 'File' }),

    operation('GetFileMetadataByPath', 'Get file metadata by path.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetFileMetadataByPathParams', 'Operation parameters: { path: string }'),
    ], { category: 'File' }),

    operation('DeleteFile', 'Delete a file by ID.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'DeleteFileParams', 'Operation parameters: { id: string }'),
    ], { category: 'File' }),

    // ---- Convert ----
    operation('ConvertFile', 'Convert a file to another format (e.g., PDF).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ConvertFileParams', 'Operation parameters: { id: string, type: string }'),
    ], { category: 'Convert', examples: [`ctx.connectors.onedriveforbusiness.ConvertFile('ToPDF', {\n  id: ctx.outputs('Upload')?.['body/Id'],\n  type: 'PDF'\n});`] }),

    operation('ConvertFileByPath', 'Convert a file to another format using path.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ConvertFileByPathParams', 'Operation parameters: { path: string, type: string }'),
    ], { category: 'Convert' }),

    // ---- Copy / Move ----
    operation('CopyDriveFile', 'Copy a file by ID.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CopyFileParams', 'Operation parameters: { id: string, destination: string, overwrite?: boolean }'),
    ], { category: 'File' }),

    operation('CopyDriveFileByPath', 'Copy a file by path.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CopyFileByPathParams', 'Operation parameters: { source: string, destination: string, overwrite?: boolean }'),
    ], { category: 'File' }),

    operation('MoveFile', 'Move or rename a file by ID.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'MoveFileParams', 'Operation parameters: { id: string, destination: string, overwrite?: boolean }'),
    ], { category: 'File' }),

    operation('MoveFileByPath', 'Move or rename a file by path.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'MoveFileByPathParams', 'Operation parameters: { source: string, destination: string, overwrite?: boolean }'),
    ], { category: 'File' }),

    // ---- Folder ----
    operation('ListFolderV2', 'List files and subfolders in a folder.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ListFolderParams', 'Operation parameters: { id: string }'),
    ], { category: 'Folder' }),

    operation('ListRootFolder', 'List files and subfolders in the root folder.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'object', 'No parameters required'),
    ], { category: 'Folder' }),

    // ---- Search ----
    operation('FindFiles', 'Find files in a folder by search query.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'FindFilesParams', 'Operation parameters: { id: string, query: string, maxFileCount?: number }'),
    ], { category: 'Search' }),

    operation('FindFilesByPath', 'Find files in a folder by path using search query.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'FindFilesByPathParams', 'Operation parameters: { path: string, query: string, maxFileCount?: number }'),
    ], { category: 'Search' }),

    // ---- Sharing ----
    operation('CreateShareLinkV2', 'Create a share link for a file.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CreateShareLinkParams', 'Operation parameters: { id: string, type: string, scope?: string }'),
    ], { category: 'Sharing' }),

    operation('CreateShareLinkByPathV2', 'Create a share link for a file by path.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CreateShareLinkByPathParams', 'Operation parameters: { path: string, type: string, scope?: string }'),
    ], { category: 'Sharing' }),

    // ---- Thumbnail ----
    operation('GetFileThumbnail', 'Get file thumbnail.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetFileThumbnailParams', 'Operation parameters: { id: string, size?: string }'),
    ], { category: 'File' }),
  ],
  {
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/onedriveforbusiness/',
  }
);

/**
 * OneDrive for Business uses Graph API Files scope for all operations.
 * Used by the CLI --auth feature.
 */
export const onedriveScopes = { default: ['Files.ReadWrite'] };

export default oneDriveMetadata;
