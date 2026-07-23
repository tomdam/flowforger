/**
 * Monaco Editor type definitions for FlowForger DSL.
 *
 * This file exports the TypeScript type definitions as a string that can be
 * loaded into Monaco Editor's TypeScript language service for IntelliSense.
 *
 * IMPORTANT: Types are declared GLOBALLY (not as a module) so Monaco can
 * resolve them without module resolution. The import statement in user code
 * is just for documentation - types work without it.
 */

/**
 * Type definitions string for Monaco's addExtraLib.
 * All types are declared globally for easy access.
 */
export const monacoTypeDefinitions = `
// ============================================
// Trigger Options
// ============================================

interface HttpTriggerOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path?: string;
  schema?: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

interface ManualTriggerOptions {
  schema?: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

interface RecurrenceTriggerOptions {
  frequency: 'Second' | 'Minute' | 'Hour' | 'Day' | 'Week' | 'Month' | 'Year';
  interval: number;
  timeZone?: string;
  startTime?: string;
  schedule?: {
    minutes?: number[];
    hours?: number[];
    weekDays?: ('Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday')[];
    monthDays?: number[];
  };
}

interface ConnectorTriggerOptions {
  connector: string;
  operation: string;
  params: Record<string, any>;
  connectionReferenceName?: string;
  splitOn?: string;
  recurrence?: {
    interval: number;
    frequency: string;
  };
}

// ============================================
// Action Input Types
// ============================================

interface HttpInputs {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: any;
  authentication?: {
    type: string;
    tenant?: string;
    audience?: string;
    clientId?: string;
    secret?: string;
    username?: string;
    password?: string;
    value?: string;
    [key: string]: any;
  };
  retryPolicy?: {
    type: 'none' | 'fixed' | 'exponential';
    count?: number;
    interval?: number;
  };
}

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: any;
}

interface ResponseInputs {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: any;
}

interface SaveFileInputs {
  contentType: string;
  content: string;
  fileName?: string;
  encoding?: 'utf8' | 'base64';
}

type DelayUnit = 'Second' | 'Minute' | 'Hour' | 'Day' | 'Week' | 'Month';
type VariableType = 'String' | 'Integer' | 'Float' | 'Boolean' | 'Array' | 'Object';

interface ConnectorParams {
  [key: string]: any;
}

// ============================================
// Action Reference Type
// ============================================

interface ActionReference {
  name: string;
  status: 'Succeeded' | 'Failed' | 'Skipped' | 'TimedOut';
  outputs: any;
  error?: any;
}

// ============================================
// Connector Types
// ============================================

/** Authentication can be a string expression or an object with type and value */
type ConnectorAuthentication = string | {
  type: 'Raw' | string;
  value: any;
};

/** Generic connector operation signature */
type ConnectorOperation = (
  name: string,
  params: ConnectorParams,
  connectionReferenceName?: string,
  authentication?: ConnectorAuthentication
) => Promise<any>;

/** Generic connector with index signature for any operation */
interface GenericConnector {
  [operation: string]: ConnectorOperation;
}

/** Dataverse connector operations */
interface DataverseConnector {
  /** List rows from a Dataverse table */
  ListRecords: ConnectorOperation;
  /** Create a new row in a Dataverse table */
  CreateRecord: ConnectorOperation;
  /** Update an existing row */
  UpdateRecord: ConnectorOperation;
  /** Update only specified fields */
  UpdateOnlyRecord: ConnectorOperation;
  /** Delete a row */
  DeleteRecord: ConnectorOperation;
  /** Get a single row by ID */
  GetItem: ConnectorOperation;
  /** Retrieve a single row with all details */
  RetrieveRecord: ConnectorOperation;
  /** Allow any other operation name */
  [operationName: string]: ConnectorOperation;
}

/** SharePoint connector operations */
interface SharePointConnector {
  /** Get items from a SharePoint list */
  GetItems: ConnectorOperation;
  /** Get a single item by ID */
  GetItemById: ConnectorOperation;
  /** Create a new item */
  CreateItem: ConnectorOperation;
  /** Create a new item (POST method) */
  PostItem: ConnectorOperation;
  /** Update an existing item */
  UpdateItem: ConnectorOperation;
  /** Partially update an item */
  PatchItem: ConnectorOperation;
  /** Delete an item */
  DeleteItem: ConnectorOperation;
  /** Get file items from a document library */
  GetFileItems: ConnectorOperation;
  /** Partially update a file item in a document library */
  PatchFileItem: ConnectorOperation;
  /** Create a new folder */
  CreateNewFolder: ConnectorOperation;
  /** Create a new file */
  CreateFile: ConnectorOperation;
  /** Get file content by ID */
  GetFileContent: ConnectorOperation;
  /** Get file content by path */
  GetFileContentByPath: ConnectorOperation;
  /** Get file metadata by ID */
  GetFileMetadata: ConnectorOperation;
  /** Get file metadata by server-relative path */
  GetFileMetadataByPath: ConnectorOperation;
  /** Update file content */
  UpdateFile: ConnectorOperation;
  /** Delete a file */
  DeleteFile: ConnectorOperation;
  /** Copy a file */
  CopyFile: ConnectorOperation;
  /** Copy a file asynchronously */
  CopyFileAsync: ConnectorOperation;
  /** Copy a folder asynchronously */
  CopyFolderAsync: ConnectorOperation;
  /** Move a file */
  MoveFile: ConnectorOperation;
  /** Move a file asynchronously */
  MoveFileAsync: ConnectorOperation;
  /** Move a folder asynchronously */
  MoveFolderAsync: ConnectorOperation;
  /** List files and folders */
  ListFolder: ConnectorOperation;
  /** Get items when a file is created */
  GetOnNewFileItems: ConnectorOperation;
  /** Get folder metadata by ID */
  GetFolderMetadata: ConnectorOperation;
  /** Get folder metadata by server-relative path */
  GetFolderMetadataByPath: ConnectorOperation;
  /** Send a custom HTTP request to SharePoint */
  SendHttpRequest: ConnectorOperation;
  /** Send a custom HTTP request to SharePoint (alias) */
  HttpRequest: ConnectorOperation;
  /** Allow any other operation name */
  [operationName: string]: ConnectorOperation;
}

/** Office 365 connector operations */
interface Office365Connector {
  /** Send an email (V2) */
  SendEmailV2: ConnectorOperation;
  /** Send an email */
  SendEmail: ConnectorOperation;
  /** Get emails (V2) */
  GetEmailsV2: ConnectorOperation;
  /** Get emails */
  GetEmails: ConnectorOperation;
  /** Get a single email by ID */
  GetEmailV2: ConnectorOperation;
  /** Reply to an email */
  ReplyToEmailV2: ConnectorOperation;
  /** Forward an email */
  ForwardEmailV2: ConnectorOperation;
  /** Delete an email */
  DeleteEmailV2: ConnectorOperation;
  DeleteEmail_V2: ConnectorOperation;
  /** Move an email */
  MoveEmailV2: ConnectorOperation;
  /** Create a calendar event */
  CreateEventV4: ConnectorOperation;
  /** Get calendar events */
  GetEventsV4: ConnectorOperation;
  /** Update a calendar event */
  UpdateEventV4: ConnectorOperation;
  /** Delete a calendar event */
  DeleteEventV4: ConnectorOperation;
  /** Allow any other operation name */
  [operationName: string]: ConnectorOperation;
}

/** Office 365 Users connector operations */
interface Office365UsersConnector {
  /** Retrieves the profile of the current user (V2) */
  MyProfile_V2: ConnectorOperation;
  /** Retrieves the profile of a specific user (V2) */
  UserProfile_V2: ConnectorOperation;
  /** Retrieves the profile of the specified user's manager (V2) */
  Manager_V2: ConnectorOperation;
  /** Retrieves the user profiles of the specified user's direct reports (V2) */
  DirectReports_V2: ConnectorOperation;
  /** Retrieves the user profiles that match the search term (V2) */
  SearchUserV2: ConnectorOperation;
  /** Get the people most relevant to the specified user */
  RelevantPeople: ConnectorOperation;
  /** Retrieves the trending documents for the signed in user */
  MyTrendingDocuments: ConnectorOperation;
  /** Retrieves the trending documents for a user */
  TrendingDocuments: ConnectorOperation;
  /** Retrieves the photo of the specified user (V2) */
  UserPhoto_V2: ConnectorOperation;
  /** Get metadata about the specified user's photo */
  UserPhotoMetadata: ConnectorOperation;
  /** Updates the profile of the current user */
  UpdateMyProfile: ConnectorOperation;
  /** Updates the profile photo of the current user */
  UpdateMyPhoto: ConnectorOperation;
  /** Send a custom HTTP request to Graph API */
  HttpRequest: ConnectorOperation;
  /** Allow any other operation name */
  [operationName: string]: ConnectorOperation;
}

/** Office 365 Groups connector operations */
interface Office365GroupsConnector {
  /** List all groups */
  ListGroups: ConnectorOperation;
  /** Get a group by ID */
  GetGroup: ConnectorOperation;
  /** Create a new Office 365 group */
  CreateGroup: ConnectorOperation;
  /** Update a group */
  UpdateGroup: ConnectorOperation;
  /** Delete a group */
  DeleteGroup: ConnectorOperation;
  /** List members of a group */
  ListGroupMembers: ConnectorOperation;
  /** Add a member to a group */
  AddMemberToGroup: ConnectorOperation;
  /** Remove a member from a group */
  RemoveMemberFromGroup: ConnectorOperation;
  /** List owners of a group */
  ListGroupOwners: ConnectorOperation;
  /** Add an owner to a group */
  AddOwnerToGroup: ConnectorOperation;
  /** Remove an owner from a group */
  RemoveOwnerFromGroup: ConnectorOperation;
  /** Check if current user is a member of a group */
  IsMemberOfGroup: ConnectorOperation;
  /** List calendar events for a group */
  ListGroupEvents: ConnectorOperation;
  /** Get a calendar event by ID */
  GetGroupEvent: ConnectorOperation;
  /** Create a calendar event for a group */
  CreateGroupEvent: ConnectorOperation;
  /** Update a calendar event */
  UpdateGroupEvent: ConnectorOperation;
  /** Delete a calendar event */
  DeleteGroupEvent: ConnectorOperation;
  /** Send a custom HTTP request to Graph API */
  HttpRequest: ConnectorOperation;
  /** Allow any other operation name */
  [operationName: string]: ConnectorOperation;
}

/** Word Online connector operations */
interface WordOnlineConnector {
  /** Populate a Word template with data */
  PopulateAWordTemplate: ConnectorOperation;
  /** Convert a Word document to PDF */
  ConvertWordDocumentToPdf: ConnectorOperation;
  /** Allow any other operation name */
  [operationName: string]: ConnectorOperation;
}

/** Excel Online connector operations */
interface ExcelOnlineConnector {
  /** Get tables from a workbook */
  GetTables: ConnectorOperation;
  /** Get rows from a table */
  GetRows: ConnectorOperation;
  /** Add a row to a table */
  AddRow: ConnectorOperation;
  /** Update a row in a table */
  UpdateRow: ConnectorOperation;
  /** Delete a row from a table */
  DeleteRow: ConnectorOperation;
  /** Get cell values from a worksheet range */
  GetRange: ConnectorOperation;
  /** Update cell values in a worksheet range */
  UpdateRange: ConnectorOperation;
  /** Delete a table from a workbook */
  DeleteTable: ConnectorOperation;
  /** Delete a worksheet from a workbook */
  DeleteWorksheet: ConnectorOperation;
  /** Get column values from a table */
  GetColumn: ConnectorOperation;
  /** Add a column to a table */
  AddColumn: ConnectorOperation;
  /** Delete a column from a table */
  DeleteColumn: ConnectorOperation;
  /** Allow any other operation name */
  [operationName: string]: ConnectorOperation;
}

/** Approvals connector operations */
interface ApprovalsConnector {
  /** Start an approval and wait for response */
  StartAndWaitForAnApproval: ConnectorOperation;
  /** Create an approval without waiting */
  CreateAnApproval: ConnectorOperation;
  /** Wait for an existing approval */
  WaitForAnApproval: ConnectorOperation;
  /** Allow any other operation name */
  [operationName: string]: ConnectorOperation;
}

/** Microsoft Teams connector operations */
interface TeamsConnector {
  /** Create a new team */
  CreateATeam: ConnectorOperation;
  /** Get details for a team */
  GetTeam: ConnectorOperation;
  /** Add a member to a team */
  AddMemberToTeam: ConnectorOperation;
  /** List all teams you are a member of */
  GetAllTeams: ConnectorOperation;
  /** List all associated teams (direct + shared channel) */
  GetAllAssociatedTeams: ConnectorOperation;
  /** Create a new channel in a team */
  CreateChannel: ConnectorOperation;
  /** Get details for a channel */
  GetChannel: ConnectorOperation;
  /** List channels for a team */
  GetChannelsForGroup: ConnectorOperation;
  /** List all channels including shared channels */
  GetAllChannelsForTeam: ConnectorOperation;
  /** Add a member to a channel */
  AddMemberToChannel: ConnectorOperation;
  /** Remove a member from a channel */
  RemoveMemberFromChannel: ConnectorOperation;
  /** Create a one-on-one or group chat */
  CreateChat: ConnectorOperation;
  /** List recent chats */
  GetChats: ConnectorOperation;
  /** List members of a chat or channel */
  ListMembers: ConnectorOperation;
  /** Post a message to a channel or chat */
  PostMessageToConversation: ConnectorOperation;
  /** Post an adaptive card to a channel or chat */
  PostCardToConversation: ConnectorOperation;
  /** Reply to a channel message */
  ReplyWithMessageToConversation: ConnectorOperation;
  /** Reply to a channel message with an adaptive card */
  ReplyWithCardToConversation: ConnectorOperation;
  /** Update an existing adaptive card */
  UpdateCardInConversation: ConnectorOperation;
  /** Get details of a message */
  GetMessageDetails: ConnectorOperation;
  /** Get messages from a channel */
  GetMessagesFromChannel: ConnectorOperation;
  /** Get messages from a chat */
  GetMessagesFromChat: ConnectorOperation;
  /** List replies to a channel message */
  ListRepliesToMessage: ConnectorOperation;
  /** Post an activity feed notification */
  PostFeedNotification: ConnectorOperation;
  /** Create a tag in a team */
  CreateTag: ConnectorOperation;
  /** List tags for a team */
  GetTags: ConnectorOperation;
  /** Delete a tag */
  DeleteTag: ConnectorOperation;
  /** Add a user to a tag */
  AddMemberToTag: ConnectorOperation;
  /** Remove a user from a tag */
  DeleteTagMember: ConnectorOperation;
  /** List members of a tag */
  GetTagMembers: ConnectorOperation;
  /** Get an @mention token for a user */
  AtMentionUser: ConnectorOperation;
  /** Get an @mention token for a tag */
  AtMentionTag: ConnectorOperation;
  /** Create a Teams meeting */
  CreateTeamsMeeting: ConnectorOperation;
  /** Send a raw Microsoft Graph HTTP request */
  HttpRequest: ConnectorOperation;
  /** Allow any other operation name */
  [operationName: string]: ConnectorOperation;
}

/** OneDrive for Business connector operations */
interface OneDriveConnector {
  /** Create a file in OneDrive */
  CreateFile: ConnectorOperation;
  /** Update file content by ID */
  UpdateFile: ConnectorOperation;
  /** Get file content by ID */
  GetFileContent: ConnectorOperation;
  /** Get file content by path */
  GetFileContentByPath: ConnectorOperation;
  /** Get file metadata by ID */
  GetFileMetadata: ConnectorOperation;
  /** Get file metadata by path */
  GetFileMetadataByPath: ConnectorOperation;
  /** Delete a file by ID */
  DeleteFile: ConnectorOperation;
  /** Convert a file to another format (e.g., PDF) */
  ConvertFile: ConnectorOperation;
  /** Convert a file to another format using path */
  ConvertFileByPath: ConnectorOperation;
  /** Copy a file by ID */
  CopyDriveFile: ConnectorOperation;
  /** Copy a file by path */
  CopyDriveFileByPath: ConnectorOperation;
  /** Move or rename a file by ID */
  MoveFile: ConnectorOperation;
  /** Move or rename a file by path */
  MoveFileByPath: ConnectorOperation;
  /** List files and subfolders in a folder */
  ListFolderV2: ConnectorOperation;
  /** List files and subfolders in root folder */
  ListRootFolder: ConnectorOperation;
  /** Find files in a folder by search query */
  FindFiles: ConnectorOperation;
  /** Find files in a folder by path using search query */
  FindFilesByPath: ConnectorOperation;
  /** Create a share link for a file */
  CreateShareLinkV2: ConnectorOperation;
  /** Create a share link for a file by path */
  CreateShareLinkByPathV2: ConnectorOperation;
  /** Get file thumbnail */
  GetFileThumbnail: ConnectorOperation;
  /** Allow any other operation name */
  [operationName: string]: ConnectorOperation;
}

/** All connectors interface */
interface Connectors {
  /** Dataverse / Microsoft Dataverse connector */
  dataverse: DataverseConnector;
  /** SharePoint Online connector */
  sharepoint: SharePointConnector;
  /** Office 365 Outlook connector */
  office365: Office365Connector;
  /** Office 365 Users connector */
  office365users: Office365UsersConnector;
  /** Office 365 Groups connector */
  office365groups: Office365GroupsConnector;
  /** Word Online (Business) connector */
  wordonline: WordOnlineConnector;
  /** Excel Online (Business) connector */
  excelonline: ExcelOnlineConnector;
  /** Approvals connector */
  approvals: ApprovalsConnector;
  /** Microsoft Teams connector */
  teams: TeamsConnector;
  /** OneDrive for Business connector */
  onedriveforbusiness: OneDriveConnector;
}

// ============================================
// OData Builder Types
// ============================================

/** Represents an OData filter expression */
interface ODataExpression {
  readonly __odata: true;
  toString(): string;
}

/** OData query builder for type-safe filter expressions */
interface ODataBuilder {
  /** Equal: field eq value */
  eq(field: string, value: any): ODataExpression;
  /** Not equal: field ne value */
  ne(field: string, value: any): ODataExpression;
  /** Greater than: field gt value */
  gt(field: string, value: any): ODataExpression;
  /** Greater than or equal: field ge value */
  ge(field: string, value: any): ODataExpression;
  /** Less than: field lt value */
  lt(field: string, value: any): ODataExpression;
  /** Less than or equal: field le value */
  le(field: string, value: any): ODataExpression;
  /** Logical AND */
  and(...expressions: ODataExpression[]): ODataExpression;
  /** Logical OR */
  or(...expressions: ODataExpression[]): ODataExpression;
  /** Logical NOT */
  not(expression: ODataExpression): ODataExpression;
  /** Contains: contains(field, value) */
  contains(field: string, value: any): ODataExpression;
  /** Starts with: startswith(field, value) */
  startsWith(field: string, value: any): ODataExpression;
  /** Ends with: endswith(field, value) */
  endsWith(field: string, value: any): ODataExpression;
  /** Is null: field eq null */
  isNull(field: string): ODataExpression;
  /** Is not null: field ne null */
  isNotNull(field: string): ODataExpression;
  /** Raw OData expression string */
  raw(expression: string): ODataExpression;
}

// ============================================
// Flow Configuration Types
// ============================================

/** Connection reference for Logic Apps deployment */
interface ConnectionReferenceConfig {
  /** The API identifier (e.g., '/providers/Microsoft.PowerApps/apis/shared_sharepointonline') */
  apiId: string;
  /** The Dataverse logical name for this connection reference */
  connectionReferenceLogicalName?: string;
  /** The direct connection ID (for embedded connections) */
  connectionName?: string;
  /** Runtime source, typically 'embedded' or 'invoker' */
  runtimeSource?: string;
  /** Impersonation settings */
  impersonation?: Record<string, unknown>;
}

/** Flow parameter definition */
interface FlowParameterConfig {
  /** The parameter type */
  type: 'String' | 'Int' | 'Float' | 'Bool' | 'Array' | 'Object' | 'SecureString' | 'SecureObject';
  /** The default value for this parameter */
  defaultValue?: any;
  /** Allowed values (for enum-like parameters) */
  allowedValues?: any[];
  /** Metadata about the parameter */
  metadata?: {
    schemaName?: string;
    description?: string;
    displayName?: string;
  };
}

/** Flow metadata for Logic Apps schema versioning */
interface FlowMetadataConfig {
  /** Schema version (e.g., "1.0.0.0") */
  schemaVersion?: string;
  /** Content version (e.g., "1.0.0.0") */
  contentVersion?: string;
  /** Schema URL */
  $schema?: string;
}

/** Parameter definition for a child flow */
interface ChildFlowParameterConfig {
  /** Human-readable parameter label */
  title: string;
  /** Parameter type */
  type: string;
  /** Whether this parameter is required */
  required: boolean;
}

/** Definition of a child flow referenced by name */
interface ChildFlowDefinitionConfig {
  /** The workflow GUID in Dataverse */
  workflowId: string;
  /** Human-readable description */
  description?: string;
  /** Parameter schema for the child flow's trigger */
  parameters?: Record<string, ChildFlowParameterConfig>;
  /** Path to the child flow's .ff.ts DSL file (relative to parent flow file) */
  dslPath?: string;
}

/**
 * Flow-level configuration accessible via ctx.flow.
 * Set these in the constructor to define flow configuration.
 */
interface FlowConfig {
  /** Flow metadata (schema version, content version, etc.) */
  metadata: FlowMetadataConfig;
  /** Workflow-level metadata at definition.metadata (creator, provisioningMethod, etc.) — preserved verbatim. */
  workflowMetadata?: Record<string, any>;
  /** Connection references for connectors */
  connectionReferences: Record<string, ConnectionReferenceConfig>;
  /** Flow parameters (environment variables, etc.) */
  parameters: Record<string, FlowParameterConfig>;
  /** Child flow definitions for name-based workflow references */
  childFlows: Record<string, ChildFlowDefinitionConfig>;
}

// ============================================
// FlowContext Interface
// ============================================

/**
 * The FlowContext interface provides access to:
 * - Flow configuration (ctx.flow.metadata, ctx.flow.connectionReferences, ctx.flow.parameters)
 * - Action output references (body, outputs, actions)
 * - Trigger references (triggerBody, triggerOutputs)
 * - Variable access
 * - Action methods (http, compose, etc.)
 * - Typed connector access (ctx.connectors.sharepoint.GetItems, etc.)
 */
interface FlowContext {
  // Flow Configuration
  /**
   * Flow-level configuration for metadata, connection references, and parameters.
   * Set these in the constructor to define flow configuration.
   * @example
   * constructor(ctx: FlowContext) {
   *   ctx.flow.metadata = { schemaVersion: '1.0.0.0' };
   *   ctx.flow.connectionReferences = { ... };
   *   ctx.flow.parameters = { ... };
   * }
   */
  flow: FlowConfig;

  // Reference Functions
  /**
   * Get the body/output of a previous action. Use for HTTP and connector actions.
   * @param actionName Name of the action to reference
   * @example const user = ctx.body('GetUser');
   */
  body<T = any>(actionName: string): T;
  /**
   * Get the outputs of a previous action (includes headers, statusCode, etc.).
   * Use for Compose actions.
   * @param actionName Name of the action to reference
   * @example const value = ctx.outputs('MyCompose');
   */
  outputs<T = any>(actionName: string): T;
  /**
   * Get the full action reference including execution status.
   * @param actionName Name of the action to reference
   * @example if (ctx.actions('GetUser').status === 'Succeeded') { ... }
   */
  actions(actionName: string): ActionReference;
  /**
   * Get the trigger body (request payload for HTTP triggers).
   * @example const id = ctx.triggerBody()?.['id'];
   */
  triggerBody<T = any>(): T;
  /**
   * Get the trigger outputs (includes headers, queries, etc.).
   * @example const q = ctx.triggerOutputs().queries['id'];
   */
  triggerOutputs<T = any>(): T;
  /**
   * Get a variable value.
   * @param name Name of the variable
   * @example const count = ctx.variables('counter');
   */
  variables<T = any>(name: string): T;
  /**
   * Get the current item in a foreach loop. In the DSL, prefer using the loop
   * variable directly - it maps to item() automatically.
   */
  item<T = any>(): T;
  /**
   * Get the current item from a named foreach loop (for nested loops). In the
   * DSL, prefer using the outer loop variable directly.
   * @param loopName Name of the foreach loop
   */
  items<T = any>(loopName: string): T;

  // Built-in Actions
  /**
   * HTTP request action.
   * @param name Unique name for this action
   * @param inputs Request options (method, url, headers, body, ...)
   * @example const res = await ctx.http('GetData', { method: 'GET', url: 'https://api.example.com/items' });
   */
  http(name: string, inputs: HttpInputs): Promise<HttpResponse>;
  /**
   * Compose action - creates a value that can be referenced later via ctx.outputs().
   * @param name Unique name for this action
   * @param value The value to compose
   * @example await ctx.compose('FullName', ctx.concat(first, ' ', last));
   */
  compose(name: string, value: any): Promise<any>;
  /** Save File (debug aid) - compiles to a Compose; host saves/downloads the file when run locally. No Maker-portal effect. */
  saveFile(name: string, file: SaveFileInputs): Promise<any>;
  /**
   * Response action - returns an HTTP response to the caller of the flow.
   * @param name Unique name for this action
   * @param statusCode HTTP status code
   * @param body Optional response body
   * @param headers Optional response headers
   * @example await ctx.response('Reply', 200, { ok: true });
   */
  response(name: string, statusCode: number): Promise<void>;
  response(name: string, statusCode: number, body: any): Promise<void>;
  response(name: string, statusCode: number, body: any, headers: Record<string, string>): Promise<void>;
  response(name: string, statusCode: number, body: any, headers: Record<string, string> | undefined, schema: any): Promise<void>;
  response(name: string, statusCode: number, body: any, headers: Record<string, string> | undefined, schema: any, kind: 'VirtualAgent' | 'PowerApp' | 'Http'): Promise<void>;
  /**
   * Terminate action - ends the flow with the given run status. Use instead of
   * return statements.
   * @param name Unique name for this action
   * @param runStatus Final status: 'Succeeded', 'Cancelled', or 'Failed'
   * @param runError Optional error details when runStatus is 'Failed'
   * @example await ctx.terminate('StopEarly', 'Succeeded');
   */
  terminate(name: string, runStatus: 'Succeeded' | 'Cancelled' | 'Failed', runError?: { code?: string; message?: string }): Promise<void>;
  /**
   * Delay action - wait for a specified duration.
   * @param name Unique name for this action
   * @param count Number of units to wait
   * @param unit Time unit ('Second', 'Minute', 'Hour', 'Day', ...)
   * @example await ctx.delay('Wait5Min', 5, 'Minute');
   */
  delay(name: string, count: number, unit: DelayUnit): Promise<void>;
  /**
   * Delay Until action - wait until a specific timestamp.
   * @param name Unique name for this action
   * @param until ISO 8601 timestamp to wait until
   * @example await ctx.delayUntil('WaitUntilNoon', '2026-01-01T12:00:00Z');
   */
  delayUntil(name: string, until: string): Promise<void>;
  /**
   * Call a child workflow.
   * @param name Unique name for this action
   * @param workflowReferenceName Child flow reference (defined in ctx.flow.childFlows)
   * @param body Optional payload passed to the child flow
   * @param headers Optional headers
   * @example const result = await ctx.callWorkflow('RunChild', 'ProcessOrder', { orderId });
   */
  callWorkflow(name: string, workflowReferenceName: string, body?: any, headers?: Record<string, string>): Promise<any>;
  /**
   * Parse JSON action - parses content against an optional schema.
   * @param name Unique name for this action
   * @param content JSON string or object to parse
   * @param schema Optional JSON schema for validation and typing
   * @example const data = await ctx.parseJson('ParsePayload', ctx.triggerBody());
   */
  parseJson<T = any>(name: string, content: any, schema?: object): Promise<T>;
  /**
   * Join action - joins array elements into a string with a delimiter.
   * @param name Unique name for this action
   * @param from Source array
   * @param joinWith Delimiter string
   * @example const csv = await ctx.join('MakeCsv', emails, ';');
   */
  join(name: string, from: any[], joinWith: string): Promise<string>;
  /**
   * Select action - maps each array element to a new shape.
   * @param name Unique name for this action
   * @param from Source array
   * @param selectMap Mapping object (values may reference item())
   * @example const names = await ctx.select('PickNames', users, { name: ctx.item()?.['displayName'] });
   */
  select<T = any>(name: string, from: any[], selectMap: any): Promise<T[]>;
  /** Filter an array. 'where' accepts either a raw PA expression string (e.g. "@and(equals(item()?['type'], 'X'), ...)") or a TypeScript expression (e.g. ctx.item()?.['type'] === 'X' && ctx.item()?.['isEnabled']). */
  filter<T = any>(name: string, from: T[], where: string | boolean): Promise<T[]>;
  /** Filter an array (alias for filter). 'where' accepts either a raw PA expression string or a TypeScript expression. */
  filterArray<T = any>(name: string, from: T[], where: string | boolean): Promise<T[]>;
  /**
   * Create CSV Table action.
   * @param name Unique name for this action
   * @param from Source array of objects
   * @param columns Optional column definitions (header + value expression)
   * @example const csv = await ctx.createCsvTable('ToCsv', orders);
   */
  createCsvTable(name: string, from: any[], columns?: Array<{ header: string; value: any }>): Promise<string>;
  /**
   * Create HTML Table action.
   * @param name Unique name for this action
   * @param from Source array of objects
   * @param columns Optional column definitions (header + value expression)
   * @example const html = await ctx.createHtmlTable('ToHtml', orders);
   */
  createHtmlTable(name: string, from: any[], columns?: Array<{ header: string; value: any }>): Promise<string>;
  /** Append text to a string variable (objects are JSON-serialized, matching Logic Apps implicit coercion) */
  appendToStringVariable(name: string, value: string | Record<string, any>): Promise<void>;

  // Typed Connector Access
  /** Typed connector access with autocomplete support */
  connectors: Connectors;

  // Generic Connector (legacy)
  /** @deprecated Use ctx.connectors.connectorName.Operation() instead */
  connector(name: string, connector: string, operation: string, params: ConnectorParams, connectionReferenceName?: string, authentication?: ConnectorAuthentication): Promise<any>;
  /** Connector webhook action (for approvals, etc.) */
  connectorWebhook(name: string, connector: string, operation: string, params: ConnectorParams, connectionReferenceName?: string, authentication?: ConnectorAuthentication): Promise<any>;

  // OData Query Builder
  /** OData query builder for type-safe filter expressions */
  odata: ODataBuilder;

  // Runtime Expression Evaluation
  /** Evaluate a Power Automate expression at runtime */
  eval<T = any>(expression: string): T;
  /** Get a flow parameter value */
  parameters<T = any>(name: string): T;
  /** Get the trigger info object */
  trigger<T = any>(): T;
  /** Get workflow metadata */
  workflow<T = any>(): T;

  // Date/Time Functions
  utcNow(format?: string): string;
  addDays(timestamp: string, days: number, format?: string): string;
  addHours(timestamp: string, hours: number, format?: string): string;
  addMinutes(timestamp: string, minutes: number, format?: string): string;
  addSeconds(timestamp: string, seconds: number, format?: string): string;
  formatDateTime(timestamp: string, format?: string, locale?: string): string;
  parseDateTime(timestamp: string, locale?: string, format?: string): string;
  convertFromUtc(timestamp: string, timezone: string, format?: string): string;
  convertTimeZone(timestamp: string, sourceTimezone: string, targetTimezone: string, format?: string): string;
  convertToUtc(timestamp: string, sourceTimezone: string, format?: string): string;
  dayOfMonth(timestamp: string): number;
  dayOfWeek(timestamp: string): number;
  dayOfYear(timestamp: string): number;
  startOfDay(timestamp: string, format?: string): string;
  startOfHour(timestamp: string, format?: string): string;
  startOfMonth(timestamp: string, format?: string): string;
  getFutureTime(interval: number, unit: string, format?: string): string;
  getPastTime(interval: number, unit: string, format?: string): string;
  ticks(timestamp: string): number;

  // Collection Functions
  /** Create an array from the given values (emits @createArray) */
  createArray<T = any>(...items: T[]): T[];
  /** Combine collections into one, removing duplicates (emits @union) */
  union<T = any>(...collections: T[]): T;
  /** Return only the items present in all collections (emits @intersection) */
  intersection<T = any>(...collections: T[]): T;
  /** Generate an array of integers starting at startIndex with count elements (emits @range) */
  range(startIndex: number, count: number): number[];
  /** Get the first element of an array or first character of a string (emits @first) */
  first<T = any>(collection: T[] | string): T;
  /** Get the last element of an array or last character of a string (emits @last) */
  last<T = any>(collection: T[] | string): T;
  /** Skip the first count elements of an array (emits @skip) */
  skip<T = any>(collection: T[], count: number): T[];
  /** Take the first count elements of an array or characters of a string (emits @take) */
  take<T = any>(collection: T[] | string, count: number): T;
  /** Check whether an array, string, or object is empty (emits @empty) */
  empty(collection: any[] | string | object): boolean;
  /** Get the number of elements in an array or characters in a string (emits @length) */
  length(collection: any[] | string): number;
  /** Check whether a collection contains a value (emits @contains) */
  contains(collection: string | any[] | object, value: any): boolean;
  /** Split an array or string into chunks of the given length (emits @chunk) */
  chunk<T = any>(collection: T[] | string, length: number): T[][];
  /** Reverse the order of items in an array (emits @reverse) */
  reverse<T = any>(collection: T[]): T[];
  /** Sort an array, optionally by an object property (emits @sort) */
  sort<T = any>(collection: T[], sortBy?: string): T[];

  // String Functions
  /** Concatenate values into a single string (emits @concat) */
  concat(...values: any[]): string;
  /** Index of the first occurrence of searchText, or -1 (emits @indexOf) */
  indexOf(text: string, searchText: string): number;
  /** Index of the last occurrence of searchText, or -1 (emits @lastIndexOf) */
  lastIndexOf(text: string, searchText: string): number;
  /** Index of the nth occurrence of searchText, or -1 (emits @nthIndexOf) */
  nthIndexOf(text: string, searchText: string, occurrence: number): number;
  /** Extract a substring by start index and length (emits @substring) */
  substring(text: string, startIndex: number, length?: number): string;
  /** Replace all occurrences of oldText with newText (emits @replace) */
  replace(text: string, oldText: string, newText: string): string;
  /** Convert to lowercase (emits @toLower) */
  toLower(text: string): string;
  /** Convert to uppercase (emits @toUpper) */
  toUpper(text: string): string;
  /** Remove leading and trailing whitespace (emits @trim) */
  trim(text: string): string;
  /** Split a string into an array on a delimiter (emits @split) */
  split(text: string, delimiter: string): string[];
  /** Whether the string starts with searchText (emits @startsWith) */
  startsWith(text: string, searchText: string): boolean;
  /** Whether the string ends with searchText (emits @endsWith) */
  endsWith(text: string, searchText: string): boolean;
  /** Extract a substring by start and end index (emits @slice) */
  slice(text: string, startIndex: number, endIndex?: number): string;

  // Math Functions
  /** Add two numbers (emits @add) */
  add(summand1: number, summand2: number): number;
  /** Subtract the second number from the first (emits @sub) */
  sub(minuend: number, subtrahend: number): number;
  /** Multiply two numbers (emits @mul) */
  mul(multiplicand1: number, multiplicand2: number): number;
  /** Divide the first number by the second (emits @div) */
  div(dividend: number, divisor: number): number;
  /** Remainder after division (emits @mod) */
  mod(dividend: number, divisor: number): number;
  /** Lowest value among the arguments (emits @min) */
  min(...numbers: (number | number[])[]): number;
  /** Highest value among the arguments (emits @max) */
  max(...numbers: (number | number[])[]): number;
  /** Absolute value (emits @abs) */
  abs(value: number): number;
  /** Round up to the nearest integer (emits @ceil) */
  ceil(value: number): number;
  /** Round down to the nearest integer (emits @floor) */
  floor(value: number): number;
  /** Round to the given number of decimal places (emits @round) */
  round(value: number, digits?: number): number;
  /** Random integer in the range [minValue, maxValue) (emits @rand) */
  rand(minValue: number, maxValue: number): number;
  /** Convert a value to an integer (emits @int) */
  int(value: any): number;
  /** Convert a value to a floating-point number (emits @float) */
  float(value: any): number;
  /** Convert a value to a decimal number (emits @decimal) */
  decimal(value: any): number;
  /** Whether the value is a floating-point number (emits @isFloat) */
  isFloat(value: any, locale?: string): boolean;
  /** Whether the value is an integer (emits @isInt) */
  isInt(value: any): boolean;

  // Comparison & Logical Functions
  /** Whether two values are equal (emits @equals) */
  equals(object1: any, object2: any): boolean;
  /** Whether the first value is greater than the second (emits @greater) */
  greater(value: any, compareTo: any): boolean;
  /** Whether the first value is less than the second (emits @less) */
  less(value: any, compareTo: any): boolean;
  /** Whether the first value is greater than or equal to the second (emits @greaterOrEquals) */
  greaterOrEquals(value: any, compareTo: any): boolean;
  /** Whether the first value is less than or equal to the second (emits @lessOrEquals) */
  lessOrEquals(value: any, compareTo: any): boolean;
  /** Whether all expressions are true (emits @and) */
  and(...expressions: boolean[]): boolean;
  /** Whether at least one expression is true (emits @or) */
  or(...expressions: boolean[]): boolean;
  /** Negate a boolean expression (emits @not) */
  not(expression: boolean): boolean;
  /** Return one of two values based on a condition (emits @if) */
  if<T = any>(expression: boolean, valueIfTrue: T, valueIfFalse: T): T;
  /** First non-null value among the arguments (emits @coalesce) */
  coalesce<T = any>(...values: T[]): T;

  // Conversion & Encoding Functions
  /** Parse a JSON string (or XML) into an object (emits @json) */
  json<T = any>(value: string): T;
  /** Convert a value to a string (emits @string) */
  string(value: any): string;
  /** Wrap a value in an array (emits @array) */
  array<T = any>(value: T): T[];
  /** Convert a value to a boolean (emits @bool) */
  bool(value: any): boolean;
  /** Base64-encode a string (emits @base64) */
  base64(value: string): string;
  /** Decode a base64 string to text (emits @base64ToString) */
  base64ToString(value: string): string;
  /** Convert a base64 string to binary content (emits @base64ToBinary) */
  base64ToBinary(value: string): any;
  /** Convert a string to binary content (emits @binary) */
  binary(value: string): any;
  /** Convert a string to a data URI (emits @dataUri) */
  dataUri(value: string): string;
  /** Convert a data URI to binary content (emits @dataUriToBinary) */
  dataUriToBinary(value: string): any;
  /** Convert a data URI to a string (emits @dataUriToString) */
  dataUriToString(value: string): string;
  /** Decode the data portion of a data URI (emits @decodeDataUri) */
  decodeDataUri(value: string): any;
  /** URI-encode a string (emits @uriComponent) */
  uriComponent(value: string): string;
  /** Decode a URI-encoded string (emits @uriComponentToString) */
  uriComponentToString(value: string): string;
  /** Convert a URI-encoded string to binary content (emits @uriComponentToBinary) */
  uriComponentToBinary(value: string): any;
  /** Decode a URI-encoded string; prefer uriComponentToString() (emits @decodeUriComponent) */
  decodeUriComponent(value: string): string;
  /** Decode a base64 string to text; prefer base64ToString() (emits @decodeBase64) */
  decodeBase64(value: string): string;
  /** URI-encode a string; prefer uriComponent() (emits @encodeUriComponent) */
  encodeUriComponent(value: string): string;
  /** Convert a string or JSON object to XML (emits @xml) */
  xml(value: any): any;
  /** Evaluate an XPath expression against XML content (emits @xpath) */
  xpath(xml: any, xpath: string): any;

  // Object Functions
  /** Return a copy of the object with the property set (emits @setProperty) */
  setProperty<T = any>(object: T, property: string, value: any): T;
  /** Return a copy of the object with the property added (emits @addProperty) */
  addProperty<T = any>(object: T, property: string, value: any): T;
  /** Return a copy of the object with the property removed (emits @removeProperty) */
  removeProperty<T = any>(object: T, property: string): T;

  // URI Parsing Functions
  /** Host portion of a URI (emits @uriHost) */
  uriHost(uri: string): string;
  /** Path portion of a URI (emits @uriPath) */
  uriPath(uri: string): string;
  /** Path and query portion of a URI (emits @uriPathAndQuery) */
  uriPathAndQuery(uri: string): string;
  /** Port number of a URI (emits @uriPort) */
  uriPort(uri: string): number;
  /** Query string portion of a URI (emits @uriQuery) */
  uriQuery(uri: string): string;
  /** Scheme (protocol) of a URI (emits @uriScheme) */
  uriScheme(uri: string): string;

  // Workflow & Form Data Functions
  /** Results of all actions inside a scope (emits @result) */
  result(scopeName: string): any[];
  /** Details of the current action, inside do-until or error handlers (emits @action) */
  action<T = any>(): T;
  /** Body of a previous action; prefer body() (emits @actionBody) */
  actionBody<T = any>(actionName: string): T;
  /** Current iteration index of a do-until loop (emits @iterationIndexes) */
  iterationIndexes(loopName: string): number;
  /** Callback URL of the flow's HTTP trigger (emits @listCallbackUrl) */
  listCallbackUrl(): string;
  /** Value of a form-data key in an action's output (emits @formDataValue) */
  formDataValue(actionName: string, key: string): any;
  /** All values of a form-data key in an action's output (emits @formDataMultiValues) */
  formDataMultiValues(actionName: string, key: string): any[];
  /** Body of a part in an action's multipart output (emits @multipartBody) */
  multipartBody(actionName: string, index: number): any;
  /** Value of a form-data key in the trigger output (emits @triggerFormDataValue) */
  triggerFormDataValue(key: string): any;
  /** All values of a form-data key in the trigger output (emits @triggerFormDataMultiValues) */
  triggerFormDataMultiValues(key: string): any[];
  /** Body of a part in the trigger's multipart output (emits @triggerMultipartBody) */
  triggerMultipartBody(index: number): any;

  // Additional Date/Time Functions
  /** Add an interval to a timestamp (emits @addToTime) */
  addToTime(timestamp: string, interval: number, timeUnit: string, format?: string): string;
  /** Subtract an interval from a timestamp (emits @subtractFromTime) */
  subtractFromTime(timestamp: string, interval: number, timeUnit: string, format?: string): string;
  /** Difference between two timestamps as a timespan string (emits @dateDifference) */
  dateDifference(startDate: string, endDate: string): string;

  // Expression Literal Helpers (DSL-specific)
  /** Force string-interpolation output: wraps the expression in braces for string coercion */
  braced(expression: any): string;
  /** Emit the literal expression @true */
  atTrue(): boolean;
  /** Emit the literal expression @false */
  atFalse(): boolean;
  /** Emit a literal number expression like @0 */
  atNumber(value: number): number;
  /** Emit a quoted string-literal expression like @'text' */
  atString(value: string): string;
  /** Emit the literal expression @null */
  null(): null;

  // Utility Functions
  guid(): string;
  formatNumber(number: number, format: string, locale?: string): string;
}

// ============================================
// Decorators (functions)
// ============================================

/** Options for the @Flow decorator when using object syntax */
interface FlowDecoratorOptions {
  /** The name of the flow */
  name: string;
  /** Optional description for the flow */
  description?: string;
  /** Dataverse workflow GUID (used by \`flowforger push\` to identify the target flow) */
  workflowId?: string;
}

/** Class decorator that marks a class as a Flow definition */
declare function Flow(nameOrOptions: string | FlowDecoratorOptions): ClassDecorator;

/** Method decorator for HTTP Request trigger */
declare function HttpTrigger(options?: HttpTriggerOptions): MethodDecorator;

/** Method decorator for Manual (Button) trigger */
declare function ManualTrigger(options?: ManualTriggerOptions): MethodDecorator;

/** Method decorator for Recurrence (scheduled) trigger */
declare function RecurrenceTrigger(options?: RecurrenceTriggerOptions): MethodDecorator;

/** Method decorator for Connector-based triggers */
declare function ConnectorTrigger(options?: ConnectorTriggerOptions): MethodDecorator;

/** Method decorator that marks the main action method of a flow */
declare function Action(): MethodDecorator;

// ============================================
// Global ctx variable
// This is automatically available in the @Action() method
// ============================================

/**
 * The flow context - provides access to actions, connectors, and runtime functions.
 * Available in the @Action() method as the parameter.
 */
declare const ctx: FlowContext;

/**
 * Current loop item - available inside for...of loops.
 */
declare const item: any;

// ============================================
// Module declaration for imports
// (Makes import statements work without errors)
// ============================================

declare module '@flowforger/dsl-native' {
  export {
    Flow,
    FlowDecoratorOptions,
    HttpTrigger,
    ManualTrigger,
    RecurrenceTrigger,
    ConnectorTrigger,
    Action,
    FlowContext,
    FlowConfig,
    FlowMetadataConfig,
    FlowParameterConfig,
    ConnectionReferenceConfig,
    ChildFlowParameterConfig,
    ChildFlowDefinitionConfig,
    HttpTriggerOptions,
    ManualTriggerOptions,
    RecurrenceTriggerOptions,
    ConnectorTriggerOptions,
    HttpInputs,
    HttpResponse,
    ResponseInputs,
    SaveFileInputs,
    DelayUnit,
    VariableType,
    ConnectorParams,
    ActionReference,
    Connectors,
    DataverseConnector,
    SharePointConnector,
    Office365Connector,
    Office365UsersConnector,
    WordOnlineConnector,
    ExcelOnlineConnector,
    ApprovalsConnector,
    ODataExpression,
    ODataBuilder,
  };
}
`;

/**
 * Example code snippets for the DSL.
 * Used by Monaco for snippet completions.
 */
export const dslExampleSnippets = {
  'flow-class': {
    label: 'Flow Class',
    insertText: `@Flow('\${1:MyFlow}')
class \${1:MyFlow} {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    \${2:// Add your actions here}
  }

  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      schemaVersion: '1.0.0.0',
    };
  }
}`,
    documentation: 'Create a new flow class with HTTP trigger and constructor',
  },
  'flow-constructor': {
    label: 'Flow Constructor',
    insertText: `constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      schemaVersion: '\${1:1.0.0.0}',
    };

    ctx.flow.connectionReferences = {
      '\${2:shared_sharepointonline}': {
        apiId: '/providers/Microsoft.PowerApps/apis/\${2:shared_sharepointonline}',
        connectionReferenceLogicalName: '\${3:cr_sharepoint}',
      },
    };

    ctx.flow.parameters = {
      '\${4:SiteUrl}': {
        type: 'String',
        defaultValue: '\${5:https://contoso.sharepoint.com}',
      },
    };
  }`,
    documentation: 'Add a constructor to configure flow metadata, connections, and parameters',
  },
  'manual-trigger': {
    label: 'Manual Trigger',
    insertText: `@ManualTrigger()
  trigger() {}`,
    documentation: 'Add a manual (button) trigger',
  },
  'recurrence-trigger': {
    label: 'Recurrence Trigger',
    insertText: `@RecurrenceTrigger({
    frequency: '\${1|Day,Hour,Minute,Week,Month|}',
    interval: \${2:1}
  })
  trigger() {}`,
    documentation: 'Add a scheduled recurrence trigger',
  },
  'http-action': {
    label: 'HTTP Action',
    insertText: `await ctx.http('\${1:ActionName}', {
  method: '\${2|GET,POST,PUT,DELETE,PATCH|}',
  url: '\${3:https://api.example.com/data}'
});`,
    documentation: 'Make an HTTP request',
  },
  'compose': {
    label: 'Compose',
    insertText: `await ctx.compose('\${1:ComposeName}', {
  \${2:key}: \${3:value}
});`,
    documentation: 'Compose and transform data',
  },
  'saveFile': {
    label: 'Save File (debug)',
    insertText: `await ctx.saveFile('\${1:FileName}', {
  contentType: '\${2:text/xml}',
  content: \${3:content},
});`,
    documentation: 'Save/download a file when running locally (no-op Compose in Maker portal)',
  },
  'response': {
    label: 'Response',
    insertText: `await ctx.response('\${1:Response}', \${2:200}, \${3:ctx.body('ActionName')});`,
    documentation: 'Return an HTTP response',
  },
  'if-condition': {
    label: 'If Condition',
    insertText: `if (ctx.body('\${1:ActionName}').\${2:property} === \${3:value}) {
  \${4:// Then actions}
} else {
  \${5:// Else actions}
}`,
    documentation: 'Create a conditional branch using native TypeScript if',
  },
  'for-each': {
    label: 'For Each',
    insertText: `for (const item of ctx.body('\${1:GetItems}').value) {
  \${2:// Loop actions}
}`,
    documentation: 'Loop over array items using native TypeScript for...of',
  },
  'sp-getitems': {
    label: 'SharePoint Get Items',
    insertText: `await ctx.connectors.sharepoint.GetItems('\${1:GetItems}', {
  dataset: '\${2:https://tenant.sharepoint.com/sites/site}',
  table: '\${3:list-guid}',
  $top: \${4:100},
  $filter: '\${5:Status eq "Active"}'
});`,
    documentation: 'Get items from a SharePoint list',
  },
  'dv-listrows': {
    label: 'Dataverse List Records',
    insertText: `await ctx.connectors.dataverse.ListRecords('\${1:ListAccounts}', {
  entityName: '\${2:accounts}',
  $select: '\${3:name,accountnumber}',
  $top: \${4:100}
});`,
    documentation: 'List records from a Dataverse table',
  },
  'switch': {
    label: 'Switch Case',
    insertText: `switch (ctx.variables('\${1:varName}')) {
  case '\${2:value1}':
    \${3:// Case 1 actions}
    break;
  case '\${4:value2}':
    \${5:// Case 2 actions}
    break;
  default:
    \${6:// Default actions}
}`,
    documentation: 'Create a switch/case statement using native TypeScript',
  },
  'while-loop': {
    label: 'Do Until Loop',
    insertText: `let \${1:counter} = 0;
while (\${1:counter} < \${2:10}) {
  \${3:// Loop actions}
  \${1:counter}++;
}`,
    documentation: 'Create a do-until loop using native TypeScript while',
  },
  'variable': {
    label: 'Variable',
    insertText: `let \${1:myVar} = \${2:0};`,
    documentation: 'Declare a variable (will become InitializeVariable action)',
  },
  'body-reference': {
    label: 'Body Reference',
    insertText: `ctx.body('\${1:ActionName}')`,
    documentation: 'Reference the body of a previous action',
  },
  'trigger-body': {
    label: 'Trigger Body',
    insertText: `ctx.triggerBody()`,
    documentation: 'Reference the trigger body',
  },
};
