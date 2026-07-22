# SharePoint Connector Examples

This directory contains example flows demonstrating SharePoint connector operations in FlowForger.

## Available Operations

### List Item Operations

**Get Items** (`GetItems`)
- Retrieve multiple items from a SharePoint list
- Example: `get-items.ir.json`
- DSL: `.spGetItems(name, params)`

**Get Item by ID** (`GetItemById`)
- Retrieve a single list item by ID
- DSL: `.spGetItemById(name, params)`

**Create Item** (`CreateItem`)
- Create a new item in a SharePoint list
- Example: `create-item.ir.json`
- DSL: `.spCreateItem(name, params)`

**Update Item** (`UpdateItem`)
- Update an existing list item
- Example: `update-item.ir.json`
- DSL: `.spUpdateItem(name, params)`

**Delete Item** (`DeleteItem`)
- Delete a list item
- Example: `delete-item.ir.json`
- DSL: `.spDeleteItem(name, params)`

### File Operations (Phase 1)

**Create File** (`CreateFile`)
- Upload a file to a SharePoint document library
- Example: `create-file.ir.json`
- DSL: `.spCreateFile(name, params)`
- Required params: `dataset` (site URL), `parameters/folderPath`, `parameters/name`, `body` (file content)

**Get File Content** (`GetFileContent`)
- Retrieve file content by file ID
- Example: `get-file-content.ir.json`
- DSL: `.spGetFileContent(name, params)`
- Required params: `dataset`, `id` (file unique ID)
- Returns: `{ $content: base64, $contentType: string }`

**Get File Content by Path** (`GetFileContentByPath`)
- Retrieve file content by server-relative path
- DSL: `.spGetFileContentByPath(name, params)`
- Required params: `dataset`, `path` (server-relative path)
- Returns: `{ $content: base64, $contentType: string }`

**Update File** (`UpdateFile`)
- Replace file content
- DSL: `.spUpdateFile(name, params)`
- Required params: `dataset`, `id` (file unique ID), `body` (new content)

**Delete File** (`DeleteFile`)
- Delete a file from library
- DSL: `.spDeleteFile(name, params)`
- Required params: `dataset`, `id` (file unique ID)

**Copy File** (`CopyFile`)
- Copy a file to another location
- Example: `copy-file.ir.json`
- DSL: `.spCopyFile(name, params)`
- Required params: `dataset`, `id`, `destSiteUrl`, `destFolderPath`

**Move File** (`MoveFile`)
- Move a file to another location
- DSL: `.spMoveFile(name, params)`
- Required params: `dataset`, `id`, `destSiteUrl`, `destFolderPath`

**Get File Metadata** (`GetFileMetadata`)
- Get file properties by ID
- DSL: `.spGetFileMetadata(name, params)`
- Required params: `dataset`, `id`
- Returns: File properties including Name, UniqueId, ServerRelativeUrl, Length, TimeCreated, TimeLastModified

**Get File Metadata by Path** (`GetFileMetadataByPath`)
- Get file properties by path
- DSL: `.spGetFileMetadataByPath(name, params)`
- Required params: `dataset`, `path`

**Create Folder** (`CreateNewFolder`)
- Create a folder in a list/library
- DSL: `.spCreateFolder(name, params)`
- Required params: `dataset`, `table` (list GUID), `parameters/path` (folder path)

### File Properties Operations (Phase 2)

**Get File Properties** (`GetFileProperties`)
- Get library column values for a file
- Example: `get-file-properties.ir.json`
- DSL: `.spGetFileProperties(name, params)`
- Required params: `dataset`, `listId` (library GUID), `itemId` (list item ID)
- Returns: All column values including Title, FileLeafRef, Created, Modified, Author, etc.

**Update File Properties** (`UpdateFileProperties`)
- Update library column values for a file (metadata only, not file content)
- Example: `update-file-properties.ir.json`
- DSL: `.spUpdateFileProperties(name, params)`
- Required params: `dataset`, `listId`, `itemId`, `fields` (object with column values)

**Get Files (Properties Only)** (`GetFilesPropertiesOnly`)
- Get all file/folder properties with advanced filtering and sorting
- Example: `get-files-properties-only.ir.json`
- DSL: `.spGetFilesPropertiesOnly(name, params)`
- Required params: `dataset`, `listId`
- Optional params: `filter` (OData filter), `orderby`, `top`, `skip`, `folderPath`, `includeNestedItems`
- Returns: Array of list items with File and Folder expanded

**Get Item Changes** (`GetItemChanges`)
- Get version history and audit trail for a file
- Example: `get-item-changes.ir.json`
- DSL: `.spGetItemChanges(name, params)`
- Required params: `dataset`, `listId`, `itemId`
- Optional params: `since` (date), `until` (date)
- Returns: Array of version history entries with timestamps and field changes

### Attachment Operations (Phase 3)

**Add Attachment** (`AddAttachment`)
- Add a file attachment to a list item
- Example: `add-attachment.ir.json`
- DSL: `.spAddAttachment(name, params)`
- Required params: `dataset`, `listId`, `itemId`, `fileName`, `content` (file data)
- Returns: Attachment metadata including FileName and ServerRelativeUrl
- Note: Maximum 90MB per attachment

**Get Attachments** (`GetAttachments`)
- Get list of all attachments for a list item
- Example: `get-attachments.ir.json`
- DSL: `.spGetAttachments(name, params)`
- Required params: `dataset`, `listId`, `itemId`
- Returns: Array of attachment metadata (FileName, ServerRelativeUrl)

**Get Attachment Content** (`GetAttachmentContent`)
- Download attachment file content
- DSL: `.spGetAttachmentContent(name, params)`
- Required params: `dataset`, `listId`, `itemId`, `attachmentId` (filename)
- Returns: `{ $content: base64, $contentType: string }`

**Delete Attachment** (`DeleteAttachment`)
- Remove an attachment from a list item
- DSL: `.spDeleteAttachment(name, params)`
- Required params: `dataset`, `listId`, `itemId`, `attachmentId` (filename)

### Check In/Out & Version Control Operations (Phase 4)

**Check Out File** (`CheckOutFile`)
- Lock a file for editing, preventing others from making changes
- Example: `checkout-checkin-workflow.ir.json`
- DSL: `.spCheckOutFile(name, params)`
- Required params: `dataset`, `fileId`
- Note: File remains locked until checked in or checkout is discarded

**Check In File** (`CheckInFile`)
- Release file lock and make changes visible to others
- Example: `checkout-checkin-workflow.ir.json`
- DSL: `.spCheckInFile(name, params)`
- Required params: `dataset`, `fileId`
- Optional params: `comment` (check-in comment), `checkInType` (0=Minor, 1=Major, 2=Overwrite, default=1)

**Discard Check Out** (`DiscardCheckOut`)
- Cancel checkout without saving changes
- Example: `discard-checkout.ir.json`
- DSL: `.spDiscardCheckOut(name, params)`
- Required params: `dataset`, `fileId`
- Note: All changes made while checked out will be lost

### Sharing & Permissions Operations (Phase 6)

**Create Sharing Link** (`CreateSharingLink`)
- Generate a shareable link for a file or folder
- Examples: `create-sharing-link.ir.json`, `sharing-workflow.ir.json`
- DSL: `.spCreateSharingLink(name, params)`
- Required params: `dataset`, `itemId`, `linkType` (view/edit/embed)
- Optional params:
  - `scope` - 'anonymous' (anyone), 'organization' (org only), 'users' (specific people), default='anonymous'
  - `expirationDateTime` - Link expiration date (ISO 8601 format)
  - `password` - Password protection for the link
- Link types:
  - `view` - Read-only access
  - `edit` - Read-write access
  - `embed` - Embeddable view
- Returns: Sharing link information including URL

**Grant Access** (`GrantAccess`)
- Share a file or folder with specific users or groups
- Examples: `grant-access.ir.json`, `sharing-workflow.ir.json`
- DSL: `.spGrantAccess(name, params)`
- Required params: `dataset`, `itemId`, `recipients`, `roleValue`
- Parameters:
  - `recipients` - Email addresses (string or semicolon-separated list)
  - `roleValue` - Permission level: 'view', 'edit', or 'owner'
  - `sendEmail` - Send notification email (default: true)
  - `emailSubject` - Custom email subject
  - `emailBody` - Custom email body/message
  - `requireSignIn` - Require sign-in to access (default: true)
- Role values:
  - `view` - Read permission
  - `edit` - Contribute/Edit permission
  - `owner` - Full Control permission

**Stop Sharing** (`StopSharing`)
- Remove all sharing permissions from a file or folder
- Examples: `stop-sharing.ir.json`, `sharing-workflow.ir.json`
- DSL: `.spStopSharing(name, params)`
- Required params: `dataset`, `itemId`
- Note: Removes all sharing links and permissions for the item

### Content Approval Operations (Phase 7)

**Set Content Approval Status** (`SetContentApprovalStatus`)
- Approve or reject a file/item in a list with content approval enabled
- Examples: `set-approval-status.ir.json`, `content-approval-workflow.ir.json`, `approval-integration.ir.json`
- DSL: `.spSetContentApprovalStatus(name, params)`
- Required params: `dataset`, `table` (list/library ID), `itemId`, `approvalStatus`
- Optional params: `comments` - Approval/rejection comments
- Approval status values:
  - `Approved` (0) - Approve the item for publication
  - `Rejected` (1) - Reject the item
  - `Pending` (2) - Set to pending approval
  - `Draft` (3) - Set to draft status
- Note: The list/library must have content approval enabled in SharePoint settings
- Returns: Success confirmation with approval status

**Get Content Approval Status** (`GetContentApprovalStatus`)
- Retrieve approval status and metadata for an item
- Examples: `get-approval-status.ir.json`, `content-approval-workflow.ir.json`, `approval-integration.ir.json`
- DSL: `.spGetContentApprovalStatus(name, params)`
- Required params: `dataset`, `table` (list/library ID), `itemId`
- Returns: Item with moderation fields:
  - `_ModerationStatus` - Numeric status (0-3)
  - `approvalStatusText` - Human-readable status (Approved/Rejected/Pending/Draft)
  - `_ModerationComments` - Approval comments
  - `Modified` - Last modified date
  - `Editor` - Last modified by user
- Use case: Check approval status before taking actions, audit approval history

### Advanced & Specialized Operations (Phase 8)

**Get Lists** (`GetLists` / `GetAllListsAndLibraries`)
- Retrieve all lists and libraries in a SharePoint site
- Examples: `get-lists.ir.json`, `advanced-workflow.ir.json`
- DSL: `.spGetLists(name, params)`
- Required params: `dataset` (site URL)
- Optional params: `filter` (OData filter), `select` (specific fields)
- Returns: Array of lists with metadata:
  - `Id` - List GUID
  - `Title` - List name
  - `BaseType` - 0=List, 1=Library (numeric)
  - `baseTypeName` - Friendly name (GenericList, DocumentLibrary, etc.)
  - `BaseTemplate` - Template ID
  - `Description` - List description
  - `Hidden` - Visibility flag
  - `ItemCount` - Number of items
  - `RootFolder.ServerRelativeUrl` - Folder path
- Use case: Site discovery, dynamic list selection, inventory management

**Get List Views** (`GetListViews`)
- Retrieve all views for a specific list or library
- Examples: `get-list-views.ir.json`, `advanced-workflow.ir.json`
- DSL: `.spGetListViews(name, params)`
- Required params: `dataset`, `table` (list ID)
- Returns: Array of views with metadata:
  - `Id` - View GUID
  - `Title` - View name
  - `DefaultView` - Is default view flag
  - `ViewType` - View type (HTML, Grid, Calendar, etc.)
  - `ViewQuery` - CAML query
  - `ViewFields` - Included columns
  - `RowLimit` - Items per page
  - `Hidden` - Visibility flag
- Use case: View management, query extraction, UI customization

**Resolve Person** (`ResolvePerson`)
- Look up user information by email or login name
- Examples: `resolve-person.ir.json`, `advanced-workflow.ir.json`
- DSL: `.spResolvePerson(name, params)`
- Required params: `dataset`, `email` or `loginName`
- Returns: User information:
  - `Id` - User ID in SharePoint
  - `Title` - Display name
  - `Email` - Email address
  - `LoginName` - User principal name
  - `PrincipalType` - User, Group, etc.
- Use case: User validation, permission assignment, people picker integration
- Note: Automatically ensures user in site if not already present

**Send HTTP Request** (`SendHttpRequest` / `HttpRequest`)
- Execute custom HTTP requests to SharePoint REST API
- Examples: `send-http-request.ir.json`, `advanced-workflow.ir.json`
- DSL: `.spSendHttpRequest(name, params)`
- Required params: `dataset`, `uri` (relative API path)
- Optional params:
  - `method` - HTTP method (GET, POST, PATCH, DELETE, default: GET)
  - `headers` - Custom headers object
  - `body` - Request body for POST/PATCH/PUT
- Returns: Response object:
  - `statusCode` - HTTP status code
  - `headers` - Response headers
  - `body` - Response body (parsed JSON or text)
- Use case: Custom endpoints, unsupported operations, advanced scenarios
- Note: Automatically adds `/_api/` prefix if not present

## Complete Workflow Examples

**File Operations** (`file-operations.ir.json`)
Demonstrates basic file lifecycle:
1. Creating a file
2. Getting file metadata
3. Updating file content
4. Retrieving updated content
5. Copying file to archive
6. Deleting original file

**File Properties Workflow** (`file-properties-workflow.ir.json`)
Demonstrates advanced file properties management:
1. Get all files in a folder with filtering
2. Loop through each file
3. Get file properties
4. Check if properties are missing
5. Update properties if needed
6. Get change history for each file

**Attachment Workflow** (`attachment-workflow.ir.json`)
Demonstrates complete attachment lifecycle:
1. Add multiple attachments to a list item
2. Get list of all attachments
3. Loop through attachments
4. Download each attachment's content
5. Delete specific attachment
6. Verify remaining attachments

**Check Out/Check In Workflow** (`checkout-checkin-workflow.ir.json`)
Demonstrates version control best practices:
1. Get file metadata
2. Check out file for exclusive editing
3. Update file content while checked out
4. Check in file with comment and version type
5. Track changes with version history

**Discard Check Out** (`discard-checkout.ir.json`)
Demonstrates abandoning changes:
1. Check out file
2. Decide not to make changes
3. Discard checkout to unlock file

**Version Control Workflow** (`version-control-workflow.ir.json`)
Demonstrates robust version control with error handling:
1. Find files needing update
2. Check out file
3. Try to update file content
4. Check in with major version on success
5. Discard checkout on failure (error handling)
6. View version history

**Sharing Workflow** (`sharing-workflow.ir.json`)
Demonstrates complete sharing lifecycle with time-limited access:
1. Create a new document in SharePoint
2. Store the file ID for later operations
3. Create a secure sharing link with organization scope
4. Grant edit access to specific recipients with email notification
5. Wait for review period (7 days)
6. Automatically remove sharing after expiration
7. Return summary of sharing activity

**Create Sharing Link** (`create-sharing-link.ir.json`)
Demonstrates different sharing link types:
1. View-only link for anonymous users
2. Edit link for organization with expiration
3. Password-protected view link

**Grant Access** (`grant-access.ir.json`)
Demonstrates different permission levels:
1. Grant view access to single user with custom email
2. Grant edit access to multiple users
3. Grant owner access without email notification

**Stop Sharing** (`stop-sharing.ir.json`)
Demonstrates removing all sharing:
1. Remove all sharing links and permissions from a file

**Content Approval Workflow** (`content-approval-workflow.ir.json`)
Demonstrates complete content approval lifecycle:
1. Accept input for site, library, item, action (approve/reject), and comments
2. Get current approval status before making changes
3. Log current status information
4. Branch based on action (approve or reject)
5. Set approval status with comments
6. Verify final status after change
7. Return summary of workflow execution

**Set Approval Status** (`set-approval-status.ir.json`)
Demonstrates different approval status settings:
1. Approve a document with quality comments
2. Reject a document with feedback
3. Set document to pending approval status

**Get Approval Status** (`get-approval-status.ir.json`)
Demonstrates retrieving approval information:
1. Get item approval status and metadata
2. Display all moderation fields including status, comments, and editor

**Approval Integration** (`approval-integration.ir.json`)
Demonstrates integration with Power Automate Approvals:
1. Get document details from SharePoint
2. Set document to pending approval status
3. Create approval request using Power Automate Approvals connector
4. Wait for approver response
5. Update SharePoint approval status based on response
6. Include approver name and comments in SharePoint
7. Verify final status and return summary

**Get Lists** (`get-lists.ir.json`)
Demonstrates site inventory and filtering:
1. Get all lists and libraries from site
2. Filter to document libraries only
3. Filter to visible lists only
4. Return summary with counts and details

**Get List Views** (`get-list-views.ir.json`)
Demonstrates view discovery and analysis:
1. Get all views for a specific list
2. Find the default view
3. Filter to visible views only
4. Return summary with view metadata

**Resolve Person** (`resolve-person.ir.json`)
Demonstrates user lookup:
1. Accept user email as input
2. Look up user information in SharePoint
3. Return user ID, display name, and login details

**Send HTTP Request** (`send-http-request.ir.json`)
Demonstrates custom REST API calls:
1. Get site metadata using custom endpoint
2. Get current user information
3. Create list item with custom HTTP request
4. Return combined results

**Advanced Discovery Workflow** (`advanced-workflow.ir.json`)
Demonstrates comprehensive site analysis:
1. Get site metadata using custom HTTP request
2. Get all lists and libraries
3. Filter to document libraries
4. Resolve user information
5. Loop through each library to get views
6. Compile detailed discovery summary with site, user, and library information

## Running Examples

See [examples/README.md](../README.md) for CLI install/setup. Use `npx flowforger`, `flowforger` (global), or `node packages/cli/dist/index.js` interchangeably.

```bash
# Run a flow locally (auto-compiles DSL → IR)
npx flowforger run examples/sharepoint/create-file.ff.ts --auth
# Or with a manual SharePoint token:
npx flowforger run examples/sharepoint/create-file.ff.ts --sp-token "$SP_TOKEN"

# Compile to Logic Apps JSON
npx flowforger compile examples/sharepoint/create-file.ff.ts --out output.json --config flowforger.config.json

# Validate an example
npx flowforger validate examples/sharepoint/create-file.ff.ts
```

### Getting a SharePoint Token

You need a SharePoint-specific token (not Microsoft Graph):

```bash
# Using Azure CLI
az account get-access-token --resource "https://<tenant>.sharepoint.com" --query accessToken -o tsv
```

See [CLAUDE.md](../../CLAUDE.md#sharepoint-connector-authentication) for detailed authentication setup instructions, or just use `--auth` with `flowforger.config.json` for automatic token acquisition.

## Parameter Reference

### Common Parameters

- **dataset**: SharePoint site URL (e.g., `https://tenant.sharepoint.com/sites/sitename`)
- **table**: List GUID for list operations (e.g., `{12345678-1234-1234-1234-123456789012}`)
- **id**: File unique ID (GUID) for file operations
- **path**: Server-relative path (e.g., `/sites/sitename/Shared Documents/file.txt`)

### Power Automate Format

Parameters can use Power Automate naming convention:
- `dataset` → site URL
- `table` → list GUID
- `id` → file/item ID
- `parameters/path` → folder path
- `parameters/name` → file name
- `parameters/folderPath` → folder path
- `body` → file content or item fields
- `item/*` → list item field values (e.g., `item/Title`)

The connector automatically normalizes these to the internal format.

## Implementation Status

### ✅ Phase 1 Complete - Core File Operations (9 operations)
- CreateFile, GetFileContent, GetFileContentByPath, UpdateFile, DeleteFile
- CopyFile, MoveFile, GetFileMetadata, GetFileMetadataByPath

### ✅ Phase 2 Complete - File Properties & Advanced List Operations (4 operations)
- GetFileProperties, UpdateFileProperties
- GetFilesPropertiesOnly (with advanced filtering)
- GetItemChanges (version history)

### ✅ Phase 3 Complete - Attachment Operations (4 operations)
- AddAttachment
- GetAttachments
- GetAttachmentContent
- DeleteAttachment

### ✅ Phase 4 Complete - Check In/Out & Version Control (3 operations)
- CheckOutFile
- CheckInFile
- DiscardCheckOut

### ✅ Phase 5 Complete - Folder & Library Discovery (7 operations)
- ListFolder
- ListRootFolder
- GetFolderMetadata
- GetFolderMetadataByPath
- CopyFolder
- MoveFolder
- ExtractFolder (unzip)

### ✅ Phase 6 Complete - Sharing & Permissions (3 operations)
- CreateSharingLink
- GrantAccess
- StopSharing

### ✅ Phase 7 Complete - Content Approval (2 operations)
- SetContentApprovalStatus
- GetContentApprovalStatus

### ✅ Phase 8 Complete - Advanced & Specialized (4 operations)
- GetLists / GetAllListsAndLibraries
- GetListViews
- ResolvePerson
- SendHttpRequest / HttpRequest

## Summary

FlowForger now supports **41 SharePoint operations** across 8 completed phases, providing comprehensive coverage of SharePoint automation scenarios. The implementation includes:

- **Core operations**: List items, files, folders
- **Advanced features**: Sharing, permissions, content approval
- **Discovery**: Lists, views, users
- **Extensibility**: Custom HTTP requests for any SharePoint REST API endpoint

All operations support both Power Automate parameter format and direct REST API usage, with automatic normalization and comprehensive error handling.
