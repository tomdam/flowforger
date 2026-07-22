# FlowForger Connector Reference

All connector calls follow the pattern:
```typescript
await ctx.connectors.<connector>.<Operation>('ActionName', { ...params }, 'connectionReferenceName');
```

Use `ctx.body('ActionName')` to read connector responses (NOT `ctx.outputs()`).

---

## SharePoint Connector

Access via `ctx.connectors.sharepoint` | Connection: `shared_sharepointonline`

### List Item Operations

#### GetItems
```typescript
await ctx.connectors.sharepoint.GetItems('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  table: '{list-guid}',
  '$filter': "Status eq 'Active'",
  '$select': 'Title,Status,Created',
  '$orderby': 'Created desc',
  '$top': 100,
  folderPath: '/Documents/Subfolder',
  viewScopeOption: 'Default'
}, 'shared_sharepointonline');
```

#### GetItemById
```typescript
await ctx.connectors.sharepoint.GetItemById('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  table: '{list-guid}',
  id: 123
}, 'shared_sharepointonline');
```

#### PostItem (Create)
```typescript
await ctx.connectors.sharepoint.PostItem('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  table: '{list-guid}',
  item: { Title: 'New Item', Status: 'Draft', DueDate: '2024-12-31' }
}, 'shared_sharepointonline');
```

#### UpdateItem
```typescript
await ctx.connectors.sharepoint.UpdateItem('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  table: '{list-guid}',
  id: 123,
  'item/Title': 'Updated Title',
  'item/Status/Value': 'Completed'
}, 'shared_sharepointonline');
```

#### DeleteItem
```typescript
await ctx.connectors.sharepoint.DeleteItem('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  table: '{list-guid}',
  id: 123
}, 'shared_sharepointonline');
```

### File Operations

#### CreateFile
```typescript
await ctx.connectors.sharepoint.CreateFile('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  folderPath: '/Shared Documents/Reports',
  name: 'report.pdf',
  body: '<file content or base64>'
}, 'shared_sharepointonline');
```

#### GetFileContent
```typescript
await ctx.connectors.sharepoint.GetFileContent('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  id: '{file-identifier}'
}, 'shared_sharepointonline');
```

#### GetFileContentByPath
```typescript
await ctx.connectors.sharepoint.GetFileContentByPath('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  path: '/Shared Documents/Reports/report.pdf'
}, 'shared_sharepointonline');
```

#### GetFileMetadata / GetFileMetadataByPath
```typescript
await ctx.connectors.sharepoint.GetFileMetadata('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  id: '{file-identifier}'
}, 'shared_sharepointonline');

await ctx.connectors.sharepoint.GetFileMetadataByPath('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  path: '/Shared Documents/Reports/report.pdf'
}, 'shared_sharepointonline');
```

#### UpdateFile
```typescript
await ctx.connectors.sharepoint.UpdateFile('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  id: '{file-identifier}',
  body: '<updated file content>'
}, 'shared_sharepointonline');
```

#### DeleteFile
```typescript
await ctx.connectors.sharepoint.DeleteFile('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  id: '{file-identifier}'
}, 'shared_sharepointonline');
```

#### CopyFileAsync / MoveFileAsync (default — use these when you have a file ID)

The modern "Copy file" / "Move file" Power Automate actions are `CopyFileAsync` and `MoveFileAsync`. They take a **file identifier** (`sourceFileId`) — exactly what trigger/list-item outputs like `body/{Identifier}` give you.

```typescript
await ctx.connectors.sharepoint.CopyFileAsync('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  'parameters/sourceFileId': '{file-identifier}',
  'parameters/destinationDataset': 'https://contoso.sharepoint.com/sites/OtherSite',
  'parameters/destinationFolderPath': '/Shared Documents/Archive',
  'parameters/nameConflictBehavior': 2  // 0=Fail, 1=Replace, 2=Rename
}, 'shared_sharepointonline');

await ctx.connectors.sharepoint.MoveFileAsync('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  'parameters/sourceFileId': '{file-identifier}',
  'parameters/destinationDataset': 'https://contoso.sharepoint.com/sites/MySite',
  'parameters/destinationFolderPath': '/Shared Documents/Processed',
  'parameters/nameConflictBehavior': 1
}, 'shared_sharepointonline');
```

#### CopyFile / MoveFile (legacy — use only when you have a path, not an ID)

The non-`Async` variants are **separate, path-based operations**. They expect `sourceFilePath` (a server-relative path string), NOT `sourceFileId`. Mixing them up produces a cloud-side validation error when activating the flow:

> *Invalid parameter for '<action name>'. Error: 'Source File Path' is required.*

That error means the operation name you used expects a path, but you supplied an ID (or vice-versa). The fix is almost always to add the `Async` suffix.

```typescript
// Only use this form if you genuinely have a server-relative path string:
await ctx.connectors.sharepoint.CopyFile('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  'parameters/sourceFilePath': '/sites/MySite/Shared Documents/report.pdf',
  'parameters/destinationDataset': 'https://contoso.sharepoint.com/sites/OtherSite',
  'parameters/destinationFolderPath': '/Shared Documents/Archive',
  'parameters/nameConflictBehavior': 2
}, 'shared_sharepointonline');
```

> **General rule for connector operation variants:** Several Power Automate connector operations come in paired variants where the name encodes which key parameter shape they expect (`*ByPath` vs by-ID, `*Async` vs sync, `*V2` vs `V1`, etc.). The operation **name** and the **parameter** must agree — the cloud validator won't auto-coerce one into the other. If activation fails with "<X> is required" for a field you didn't intend to supply, the operation variant is the first thing to check, not the parameters. When the source is an ID from a trigger or list query, prefer the **`Async`** / non-`ByPath` variant; when the source is a literal server-relative path, prefer the legacy / `ByPath` variant.

#### Fast copy/move via SharePoint REST (when latency matters)

`CopyFileAsync` / `MoveFileAsync` queue a background job on SharePoint and Power Automate then polls until completion. That polling cycle has a **multi-second floor regardless of file size** — typically 7–10 seconds even for a 3 KB file. For background flows this is harmless; for user-facing or latency-sensitive paths it dominates the runtime.

Bypass the connector by calling SharePoint's `SP.MoveCopyUtil.CopyFile` / `MoveFile` REST endpoint directly via `HttpRequest`. One round trip, no polling — usually sub-second.

```typescript
// Inputs you need to assemble first:
//   - srcAbsoluteUrl: https://<tenant>.sharepoint.com<server-relative source path>
//   - destAbsoluteUrl: https://<tenant>.sharepoint.com<server-relative destination path>/<filename>
// Trigger outputs from SharePoint file triggers usually expose body/{Path}, body/{Name},
// and body/{FullPath} — combine them (or read site origin from ctx.parameters) to build the
// two absolute URLs.

await ctx.connectors.sharepoint.HttpRequest('Copy_file_fast', {
  dataset: ctx.parameters('SharePoint site URL (cr_SiteUrl)'),
  'parameters/method': 'POST',
  'parameters/uri': '_api/SP.MoveCopyUtil.CopyFile',
  'parameters/headers': {
    'Content-Type': 'application/json;odata=verbose',
    Accept: 'application/json;odata=nometadata'
  },
  'parameters/body': ctx.eval(`@{json(concat(
    '{"srcUrl":"', variables('SrcAbsoluteUrl'),
    '","destUrl":"', variables('DestAbsoluteUrl'),
    '","options":{"KeepBoth":true,"ResetAuthorAndCreatedOnCopy":false,"ShouldBypassSharedLocks":true}}'
  ))}`)
}, 'shared_sharepointonline');
```

For Move, replace `SP.MoveCopyUtil.CopyFile` with `SP.MoveCopyUtil.MoveFile`. The `options` object controls conflict behavior:

| Field | Effect |
|---|---|
| `KeepBoth: true` | Auto-rename the copy (equivalent to `nameConflictBehavior: 2` on the connector op) |
| `KeepBoth: false` + (no other flags) | Fail on conflict (≈ `nameConflictBehavior: 0`) |
| `ShouldBypassSharedLocks: true` | Required when the source is checked out or under retention |
| `ResetAuthorAndCreatedOnCopy: true` | Stamp the copy with the current user/now instead of preserving original metadata |

**Trade-offs vs the connector op:**
- Fastest path (1 round trip vs poll-until-done) — typical 8x speedup for small files.
- You assemble absolute URLs yourself; the connector did this for you from the file ID.
- Bypasses Power Automate's built-in retry/error UX — wrap in a try/catch scope ([Rule 6](SKILL.md#6-trycatch-must-have-a-finally-scope-or-explicit-multi-dependency-runafter)) if the destination might collide or the source might be locked.

The FlowForger local engine implements `CopyFile` / `MoveFile` using exactly this REST endpoint — see `packages/connectors-sharepoint/src/index.ts` `copyFile()` for the reference shape (absolute URLs, `srcUrl`/`destUrl`/`options` body).

### Folder Operations

#### CreateNewFolder
```typescript
await ctx.connectors.sharepoint.CreateNewFolder('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  table: '{library-guid}',
  'parameters/path': 'NewFolderName'
}, 'shared_sharepointonline');
```

#### ListFolder
```typescript
await ctx.connectors.sharepoint.ListFolder('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  id: '{folder-identifier}'
}, 'shared_sharepointonline');
```

#### GetFolderMetadata / GetFolderMetadataByPath
```typescript
await ctx.connectors.sharepoint.GetFolderMetadata('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  id: '/Shared Documents/FolderName'
}, 'shared_sharepointonline');
```

#### CopyFolderAsync / MoveFolderAsync
```typescript
await ctx.connectors.sharepoint.CopyFolderAsync('ActionName', {
  dataset: 'https://source.sharepoint.com/sites/Site1',
  'parameters/sourceFolderId': '/Documents/SourceFolder',
  'parameters/destinationDataset': 'https://dest.sharepoint.com/sites/Site2',
  'parameters/destinationFolderPath': '/Documents/DestFolder',
  'parameters/nameConflictBehavior': 2
}, 'shared_sharepointonline');
```

### Document Library File Items

#### GetFileItems
```typescript
await ctx.connectors.sharepoint.GetFileItems('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  table: '{library-guid}',
  '$filter': "ContentType eq 'Document'",
  '$top': 100
}, 'shared_sharepointonline');
```

#### PatchFileItem
```typescript
await ctx.connectors.sharepoint.PatchFileItem('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  table: '{library-guid}',
  id: 123,
  'item/Title': 'Updated Document Title'
}, 'shared_sharepointonline');
```

### Custom REST API (HttpRequest)

```typescript
await ctx.connectors.sharepoint.HttpRequest('ActionName', {
  dataset: 'https://contoso.sharepoint.com/sites/MySite',
  'parameters/method': 'GET',
  'parameters/uri': '_api/web/lists',
  'parameters/headers': {
    Accept: 'application/json;odata=verbose',
    'Content-Type': 'application/json'
  },
  'parameters/body': JSON.stringify({ key: 'value' })  // For POST/PATCH
}, 'shared_sharepointonline');
```

---

## Dataverse Connector

Access via `ctx.connectors.dataverse` | Connection: `shared_commondataserviceforapps`

### ListRecords
```typescript
await ctx.connectors.dataverse.ListRecords('ActionName', {
  entityName: 'accounts',
  '$select': 'name,accountnumber,revenue',
  '$filter': 'statecode eq 0 and revenue gt 1000000',
  '$orderby': 'name asc',
  '$top': 50,
  '$expand': 'primarycontactid($select=fullname,emailaddress1)'
}, 'shared_commondataserviceforapps');
```

### GetItem / RetrieveRecord
```typescript
await ctx.connectors.dataverse.GetItem('ActionName', {
  entityName: 'accounts',
  recordId: 'guid-here',
  '$select': 'name,accountnumber'
}, 'shared_commondataserviceforapps');
```

### CreateRecord
```typescript
await ctx.connectors.dataverse.CreateRecord('ActionName', {
  entityName: 'contacts',
  item: {
    firstname: 'John',
    lastname: 'Doe',
    emailaddress1: 'john@example.com',
    'parentcustomerid_account@odata.bind': '/accounts(guid-here)'
  }
}, 'shared_commondataserviceforapps');
```

### UpdateRecord
```typescript
await ctx.connectors.dataverse.UpdateRecord('ActionName', {
  entityName: 'accounts',
  recordId: 'guid-here',
  item: { name: 'Updated Name', revenue: 2000000 }
}, 'shared_commondataserviceforapps');
```

### UpdateOnlyRecord
Same as UpdateRecord but only updates fields that have changed (no merge with existing data).
```typescript
await ctx.connectors.dataverse.UpdateOnlyRecord('ActionName', {
  entityName: 'accounts',
  recordId: 'guid-here',
  item: { revenue: 3000000 }
}, 'shared_commondataserviceforapps');
```

### DeleteRecord
```typescript
await ctx.connectors.dataverse.DeleteRecord('ActionName', {
  entityName: 'accounts',
  recordId: 'guid-here'
}, 'shared_commondataserviceforapps');
```

### PerformBoundAction
```typescript
await ctx.connectors.dataverse.PerformBoundAction('ActionName', {
  entityName: 'accounts',
  recordId: 'guid-here',
  actionName: 'Microsoft.Dynamics.CRM.QualifyLead',
  item: { /* action parameters */ }
}, 'shared_commondataserviceforapps');
```

---

## Office 365 Connector

Access via `ctx.connectors.office365` | Connection: `shared_office365`

### SendEmailV2
```typescript
await ctx.connectors.office365.SendEmailV2('ActionName', {
  'emailMessage/To': 'recipient@example.com',
  'emailMessage/Subject': 'Email Subject',
  'emailMessage/Body': '<p>HTML email body</p>',
  'emailMessage/Cc': 'cc@example.com',
  'emailMessage/Bcc': 'bcc@example.com',
  'emailMessage/Importance': 'Normal',  // Low, Normal, High
  'emailMessage/IsHtml': true
}, 'shared_office365');
```

### GetEmailsV2
```typescript
await ctx.connectors.office365.GetEmailsV2('ActionName', {
  folderPath: 'Inbox',
  fetchOnlyUnread: true,
  top: 25,
  importance: 'Any'
}, 'shared_office365');
```

### ReplyToEmailV2
```typescript
await ctx.connectors.office365.ReplyToEmailV2('ActionName', {
  messageId: ctx.body('GetEmail')?.['id'],
  comment: '<p>Reply body</p>',
  replyAll: false
}, 'shared_office365');
```

### HttpRequest (Send HTTP Request to Microsoft Graph)
```typescript
await ctx.connectors.office365.HttpRequest('ActionName', {
  'Uri': 'https://graph.microsoft.com/v1.0/me/messages',
  'Method': 'GET',       // GET, POST, PATCH, DELETE
  'Body': '{}',          // JSON string for POST/PATCH
  'ContentType': 'application/json'
}, 'shared_office365');
```

### Calendar: CreateEventV4 / GetEventsV4
```typescript
await ctx.connectors.office365.CreateEventV4('ActionName', {
  calendarId: 'Calendar',
  subject: 'Meeting',
  start: '2024-06-15T10:00:00Z',
  end: '2024-06-15T11:00:00Z',
  timeZone: 'UTC',
  body: '<p>Agenda</p>',
  requiredAttendees: 'attendee@example.com'
}, 'shared_office365');
```

---

## Excel Online Connector

Access via `ctx.connectors.excelonline` | Connection: `shared_excelonlinebusiness`

### GetTables
```typescript
await ctx.connectors.excelonline.GetTables('ActionName', {
  source: 'drives/{drive-id}/items/{file-id}'
}, 'shared_excelonlinebusiness');
```

### GetRows
```typescript
await ctx.connectors.excelonline.GetRows('ActionName', {
  source: 'drives/{drive-id}/items/{file-id}',
  table: 'Table1',
  '$filter': "Status eq 'Active'",
  '$top': 100,
  '$orderby': 'Name asc'
}, 'shared_excelonlinebusiness');
```

### AddRow
```typescript
await ctx.connectors.excelonline.AddRow('ActionName', {
  source: 'drives/{drive-id}/items/{file-id}',
  table: 'Table1',
  item: { Name: 'New Entry', Value: 42, Status: 'Active' }
}, 'shared_excelonlinebusiness');
```

### UpdateRow
```typescript
await ctx.connectors.excelonline.UpdateRow('ActionName', {
  source: 'drives/{drive-id}/items/{file-id}',
  table: 'Table1',
  id: '{row-key}',
  item: { Status: 'Completed' }
}, 'shared_excelonlinebusiness');
```

### DeleteRow
```typescript
await ctx.connectors.excelonline.DeleteRow('ActionName', {
  source: 'drives/{drive-id}/items/{file-id}',
  table: 'Table1',
  id: '{row-key}'
}, 'shared_excelonlinebusiness');
```

### GetRange / UpdateRange
```typescript
await ctx.connectors.excelonline.GetRange('ActionName', {
  source: 'drives/{drive-id}/items/{file-id}',
  worksheetName: 'Sheet1',
  range: 'A1:D10'
}, 'shared_excelonlinebusiness');

await ctx.connectors.excelonline.UpdateRange('ActionName', {
  source: 'drives/{drive-id}/items/{file-id}',
  worksheetName: 'Sheet1',
  range: 'A1:B2',
  values: [['Name', 'Value'], ['Test', '42']]
}, 'shared_excelonlinebusiness');
```

---

## Word Online Connector

Access via `ctx.connectors.wordonline` | Connection: `shared_wordonlinebusiness`

### PopulateAWordTemplate
```typescript
await ctx.connectors.wordonline.PopulateAWordTemplate('ActionName', {
  source: 'drives/{drive-id}/items/{template-file-id}',
  // Template fields are passed as key-value pairs
  CustomerName: 'Contoso Inc.',
  InvoiceDate: '2024-06-15',
  Amount: '$1,500.00'
}, 'shared_wordonlinebusiness');
```

### ConvertWordDocumentToPdf
```typescript
await ctx.connectors.wordonline.ConvertWordDocumentToPdf('ActionName', {
  source: 'drives/{drive-id}/items/{file-id}'
}, 'shared_wordonlinebusiness');
```

---

## Approvals Connector

Access via `ctx.connectors.approvals` | Connection: `shared_approvals`

> **Note:** Approvals use webhook callbacks. Use `ctx.connectorWebhook()` instead of `ctx.connectors.approvals` for `StartAndWaitForAnApproval`. Approvals cannot be executed locally with the engine.

### StartAndWaitForAnApproval (via connectorWebhook)
```typescript
await ctx.connectorWebhook('WaitForApproval', {
  connector: 'approvals',
  operation: 'StartAndWaitForAnApproval',
  params: {
    approvalType: 'Basic',                    // or 'CustomResponse'
    title: 'Approve expense report',
    assignedTo: 'approver@example.com',       // semicolon-separated for multiple
    details: 'Please review the attached expense report.',
    requestor: 'submitter@example.com',
    enableNotifications: true,
    enableReassignment: true
  },
  connectionReferenceName: 'shared_approvals'
});

// Check approval result — use inline, e.g. in an if condition:
// ctx.body('WaitForApproval')?.['outcome'] === 'Approve'
```

### CreateAnApproval (fire-and-forget)
```typescript
await ctx.connectors.approvals.CreateAnApproval('CreateApproval', {
  approvalType: 'Basic',
  title: 'Approve request',
  assignedTo: 'approver@example.com'
}, 'shared_approvals');
```

### WaitForAnApproval
```typescript
await ctx.connectorWebhook('WaitForResult', {
  connector: 'approvals',
  operation: 'WaitForAnApproval',
  params: {
    approvalId: ctx.body('CreateApproval')?.['approvalId']
  },
  connectionReferenceName: 'shared_approvals'
});
```

---

## Generic Connector (Any Connector)

For connectors not explicitly typed, use bracket notation:

```typescript
await ctx.connectors['teams'].PostMessageToConversation('PostToTeams', {
  // connector-specific parameters
}, 'shared_teams');
```

---

## Connection Reference Summary

| Connector | Reference Name | apiId |
|-----------|---------------|-------|
| SharePoint | `shared_sharepointonline` | `.../shared_sharepointonline` |
| Dataverse | `shared_commondataserviceforapps` | `.../shared_commondataserviceforapps` |
| Office 365 | `shared_office365` | `.../shared_office365` |
| Excel Online | `shared_excelonlinebusiness` | `.../shared_excelonlinebusiness` |
| Word Online | `shared_wordonlinebusiness` | `.../shared_wordonlinebusiness` |
| Approvals | `shared_approvals` | `.../shared_approvals` |

All apiIds are prefixed with `/providers/Microsoft.PowerApps/apis/`.

## Referencing Connector Outputs

```typescript
ctx.body('ActionName')                   // Full response body
ctx.body('ActionName')?.['value']        // Array of items (list operations)
ctx.body('ActionName')?.['ID']           // Specific property
ctx.outputs('ActionName')?.['body/id']   // Via outputs path
```
