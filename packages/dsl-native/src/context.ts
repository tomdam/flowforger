/**
 * FlowContext interface - provides typed methods for actions and references.
 * This interface is used for type checking in the native DSL.
 * The transformer reads these method calls and converts them to IR nodes.
 *
 * The interface supports two modes:
 * 1. Compile-time: Methods are markers that get transformed to IR
 * 2. Runtime: Methods are called during flow execution (for expressions like ctx.eval)
 */

// HTTP action input types
export interface HttpInputs {
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

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: any;
}

// Response action inputs
export interface ResponseInputs {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: any;
}

// Save File inputs (debug aid; see FlowContext.saveFile)
export interface SaveFileInputs {
  /** MIME type, e.g. 'text/xml', 'application/pdf'. */
  contentType: string;
  /** File content: text, or base64 when encoding === 'base64'. */
  content: string;
  /** Optional file name; defaults to '<actionName>.<ext-from-contentType>'. */
  fileName?: string;
  /** Encoding of `content`; defaults to 'utf8'. Use 'base64' for binary. */
  encoding?: 'utf8' | 'base64';
}

// Delay inputs
export type DelayUnit = 'Second' | 'Minute' | 'Hour' | 'Day' | 'Week' | 'Month';

// Variable types
export type VariableType = 'String' | 'Integer' | 'Float' | 'Boolean' | 'Array' | 'Object';

// Connector parameter types (generic)
export interface ConnectorParams {
  [key: string]: any;
}

// ============================================
// Typed Connector Interfaces
// ============================================

/** Authentication can be a string expression or an object with type and value */
export type ConnectorAuthentication = string | {
  type: 'Raw' | string;
  value: any;
};

/** Generic connector operation signature */
export type ConnectorOperation = (
  name: string,
  params: ConnectorParams,
  connectionReferenceName?: string,
  authentication?: ConnectorAuthentication
) => Promise<any>;

/** Generic connector with index signature for any operation */
export interface GenericConnector {
  [operation: string]: ConnectorOperation;
}

/** Dataverse connector operations */
export interface DataverseConnector extends GenericConnector {
  ListRecords: ConnectorOperation;
  CreateRecord: ConnectorOperation;
  UpdateRecord: ConnectorOperation;
  UpdateOnlyRecord: ConnectorOperation;
  DeleteRecord: ConnectorOperation;
  GetItem: ConnectorOperation;
  RetrieveRecord: ConnectorOperation;
}

/** SharePoint connector operations */
export interface SharePointConnector extends GenericConnector {
  // List item operations
  GetItems: ConnectorOperation;
  GetItemById: ConnectorOperation;
  CreateItem: ConnectorOperation;
  PostItem: ConnectorOperation;
  UpdateItem: ConnectorOperation;
  PatchItem: ConnectorOperation;
  DeleteItem: ConnectorOperation;
  // File item operations (document library items with file metadata)
  GetFileItems: ConnectorOperation;
  PatchFileItem: ConnectorOperation;
  // Folder operations
  CreateNewFolder: ConnectorOperation;
  ListFolder: ConnectorOperation;
  GetFolderMetadata: ConnectorOperation;
  GetFolderMetadataByPath: ConnectorOperation;
  // File operations
  CreateFile: ConnectorOperation;
  GetFileContent: ConnectorOperation;
  GetFileContentByPath: ConnectorOperation;
  GetFileMetadata: ConnectorOperation;
  GetFileMetadataByPath: ConnectorOperation;
  UpdateFile: ConnectorOperation;
  DeleteFile: ConnectorOperation;
  CopyFile: ConnectorOperation;
  CopyFileAsync: ConnectorOperation;
  CopyFolderAsync: ConnectorOperation;
  MoveFile: ConnectorOperation;
  MoveFileAsync: ConnectorOperation;
  MoveFolderAsync: ConnectorOperation;
  // Trigger-related
  GetOnNewFileItems: ConnectorOperation;
  // HTTP operations
  SendHttpRequest: ConnectorOperation;
  HttpRequest: ConnectorOperation;
}

/** Office 365 connector operations */
export interface Office365Connector extends GenericConnector {
  SendEmailV2: ConnectorOperation;
  SendEmail: ConnectorOperation;
  GetEmailsV2: ConnectorOperation;
  GetEmails: ConnectorOperation;
  GetEmailV2: ConnectorOperation;
  ReplyToEmailV2: ConnectorOperation;
  ForwardEmailV2: ConnectorOperation;
  DeleteEmailV2: ConnectorOperation;
  MoveEmailV2: ConnectorOperation;
  CreateEventV4: ConnectorOperation;
  GetEventsV4: ConnectorOperation;
  UpdateEventV4: ConnectorOperation;
  DeleteEventV4: ConnectorOperation;
}

/** Office 365 Users connector operations */
export interface Office365UsersConnector extends GenericConnector {
  MyProfile_V2: ConnectorOperation;
  UserProfile_V2: ConnectorOperation;
  Manager_V2: ConnectorOperation;
  DirectReports_V2: ConnectorOperation;
  SearchUserV2: ConnectorOperation;
  RelevantPeople: ConnectorOperation;
  MyTrendingDocuments: ConnectorOperation;
  TrendingDocuments: ConnectorOperation;
  UserPhoto_V2: ConnectorOperation;
  UserPhotoMetadata: ConnectorOperation;
  UpdateMyProfile: ConnectorOperation;
  UpdateMyPhoto: ConnectorOperation;
  HttpRequest: ConnectorOperation;
}

/** Office 365 Groups connector operations */
export interface Office365GroupsConnector extends GenericConnector {
  ListGroups: ConnectorOperation;
  GetGroup: ConnectorOperation;
  CreateGroup: ConnectorOperation;
  UpdateGroup: ConnectorOperation;
  DeleteGroup: ConnectorOperation;
  ListGroupMembers: ConnectorOperation;
  AddMemberToGroup: ConnectorOperation;
  RemoveMemberFromGroup: ConnectorOperation;
  ListGroupOwners: ConnectorOperation;
  AddOwnerToGroup: ConnectorOperation;
  RemoveOwnerFromGroup: ConnectorOperation;
  IsMemberOfGroup: ConnectorOperation;
  ListGroupEvents: ConnectorOperation;
  GetGroupEvent: ConnectorOperation;
  CreateGroupEvent: ConnectorOperation;
  UpdateGroupEvent: ConnectorOperation;
  DeleteGroupEvent: ConnectorOperation;
  HttpRequest: ConnectorOperation;
}

/** Word Online connector operations */
export interface WordOnlineConnector extends GenericConnector {
  PopulateAWordTemplate: ConnectorOperation;
  ConvertWordDocumentToPdf: ConnectorOperation;
}

/** Excel Online connector operations */
export interface ExcelOnlineConnector extends GenericConnector {
  // Row operations
  GetTables: ConnectorOperation;
  GetRows: ConnectorOperation;
  AddRow: ConnectorOperation;
  UpdateRow: ConnectorOperation;
  DeleteRow: ConnectorOperation;
  // Range operations
  GetRange: ConnectorOperation;
  UpdateRange: ConnectorOperation;
  // Delete operations
  DeleteTable: ConnectorOperation;
  DeleteWorksheet: ConnectorOperation;
  // Column operations
  GetColumn: ConnectorOperation;
  AddColumn: ConnectorOperation;
  DeleteColumn: ConnectorOperation;
}

/** Approvals connector operations */
export interface ApprovalsConnector extends GenericConnector {
  StartAndWaitForAnApproval: ConnectorOperation;
  CreateAnApproval: ConnectorOperation;
  WaitForAnApproval: ConnectorOperation;
}

/** Microsoft Teams connector operations */
export interface TeamsConnector extends GenericConnector {
  CreateATeam: ConnectorOperation;
  GetTeam: ConnectorOperation;
  AddMemberToTeam: ConnectorOperation;
  GetAllTeams: ConnectorOperation;
  GetAllAssociatedTeams: ConnectorOperation;
  CreateChannel: ConnectorOperation;
  GetChannel: ConnectorOperation;
  GetChannelsForGroup: ConnectorOperation;
  GetAllChannelsForTeam: ConnectorOperation;
  AddMemberToChannel: ConnectorOperation;
  RemoveMemberFromChannel: ConnectorOperation;
  CreateChat: ConnectorOperation;
  GetChats: ConnectorOperation;
  ListMembers: ConnectorOperation;
  PostMessageToConversation: ConnectorOperation;
  PostCardToConversation: ConnectorOperation;
  ReplyWithMessageToConversation: ConnectorOperation;
  ReplyWithCardToConversation: ConnectorOperation;
  UpdateCardInConversation: ConnectorOperation;
  GetMessageDetails: ConnectorOperation;
  GetMessagesFromChannel: ConnectorOperation;
  GetMessagesFromChat: ConnectorOperation;
  ListRepliesToMessage: ConnectorOperation;
  PostFeedNotification: ConnectorOperation;
  CreateTag: ConnectorOperation;
  GetTags: ConnectorOperation;
  DeleteTag: ConnectorOperation;
  AddMemberToTag: ConnectorOperation;
  DeleteTagMember: ConnectorOperation;
  GetTagMembers: ConnectorOperation;
  AtMentionUser: ConnectorOperation;
  AtMentionTag: ConnectorOperation;
  CreateTeamsMeeting: ConnectorOperation;
  HttpRequest: ConnectorOperation;
}

/** OneDrive for Business connector operations */
export interface OneDriveConnector extends GenericConnector {
  CreateFile: ConnectorOperation;
  UpdateFile: ConnectorOperation;
  GetFileContent: ConnectorOperation;
  GetFileContentByPath: ConnectorOperation;
  GetFileMetadata: ConnectorOperation;
  GetFileMetadataByPath: ConnectorOperation;
  DeleteFile: ConnectorOperation;
  ConvertFile: ConnectorOperation;
  ConvertFileByPath: ConnectorOperation;
  CopyDriveFile: ConnectorOperation;
  CopyDriveFileByPath: ConnectorOperation;
  MoveFile: ConnectorOperation;
  MoveFileByPath: ConnectorOperation;
  ListFolderV2: ConnectorOperation;
  ListRootFolder: ConnectorOperation;
  FindFiles: ConnectorOperation;
  FindFilesByPath: ConnectorOperation;
  CreateShareLinkV2: ConnectorOperation;
  CreateShareLinkByPathV2: ConnectorOperation;
  GetFileThumbnail: ConnectorOperation;
}

/** All connectors interface */
export interface Connectors {
  dataverse: DataverseConnector;
  sharepoint: SharePointConnector;
  office365: Office365Connector;
  office365users: Office365UsersConnector;
  office365groups: Office365GroupsConnector;
  wordonline: WordOnlineConnector;
  excelonline: ExcelOnlineConnector;
  approvals: ApprovalsConnector;
  teams: TeamsConnector;
  onedriveforbusiness: OneDriveConnector;
  /** Generic connector fallback for any connector name */
  [connectorName: string]: GenericConnector;
}

// Action reference type for ctx.actions()
export interface ActionReference {
  name: string;
  status: 'Succeeded' | 'Failed' | 'Skipped' | 'TimedOut';
  outputs: any;
  error?: any;
}

// ============================================
// OData Query Builder Types
// ============================================

/**
 * Represents an OData filter expression that will be converted to a string.
 * The symbol property marks it as an OData expression for the transformer.
 */
export interface ODataExpression {
  /** Internal marker to identify OData expressions */
  readonly __odata: true;
  /** The OData expression string */
  toString(): string;
}

/**
 * OData query builder for constructing type-safe filter expressions.
 *
 * Supports two syntaxes:
 *
 * 1. Builder methods (verbose but type-safe):
 * ```typescript
 * ctx.odata.and(
 *   ctx.odata.eq('field', ctx.parameters('value')),
 *   ctx.odata.eq('status', true)
 * )
 * ```
 *
 * 2. Tagged template (concise JavaScript-like syntax):
 * ```typescript
 * ctx.odata`field == ${ctx.parameters('value')} && status == true`
 * ```
 */
export interface ODataBuilder {
  // Tagged template signature (for JavaScript-like syntax)
  /**
   * Tagged template for JavaScript-like filter expressions.
   * Supports: ==, !=, <, >, <=, >=, &&, ||, !, parentheses
   *
   * @example
   * ctx.odata`field == ${value} && status != null`
   * // Transforms to: "field eq <value> and status ne null"
   */
  (strings: TemplateStringsArray, ...values: any[]): ODataExpression;

  // Comparison operators
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

  // Logical operators
  /** Logical AND: expr1 and expr2 and ... */
  and(...expressions: ODataExpression[]): ODataExpression;
  /** Logical OR: expr1 or expr2 or ... */
  or(...expressions: ODataExpression[]): ODataExpression;
  /** Logical NOT: not expr */
  not(expression: ODataExpression): ODataExpression;

  // String functions
  /** Contains: contains(field, value) */
  contains(field: string, value: any): ODataExpression;
  /** Starts with: startswith(field, value) */
  startsWith(field: string, value: any): ODataExpression;
  /** Ends with: endswith(field, value) */
  endsWith(field: string, value: any): ODataExpression;

  // Null checks
  /** Is null: field eq null */
  isNull(field: string): ODataExpression;
  /** Is not null: field ne null */
  isNotNull(field: string): ODataExpression;

  // Raw expression (escape hatch)
  /** Raw OData expression string */
  raw(expression: string): ODataExpression;
}

// ============================================
// Flow Configuration Types
// ============================================

/**
 * Connection reference for Logic Apps deployment.
 */
export interface ConnectionReferenceConfig {
  /** The API identifier (e.g., '/providers/Microsoft.PowerApps/apis/shared_sharepointonline') */
  apiId: string;
  /** The Dataverse logical name for this connection reference (for solution-aware flows) */
  connectionReferenceLogicalName?: string;
  /** The direct connection ID (for embedded connections) */
  connectionName?: string;
  /** Runtime source, typically 'embedded' or 'invoker' */
  runtimeSource?: string;
  /** Impersonation settings (optional, used with some connectors like Dataverse) */
  impersonation?: Record<string, unknown>;
}

/**
 * Flow parameter definition.
 */
export interface FlowParameterConfig {
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

/**
 * Flow metadata for Logic Apps schema versioning.
 */
export interface FlowMetadataConfig {
  /** Schema version (e.g., "1.0.0.0") */
  schemaVersion?: string;
  /** Content version (e.g., "1.0.0.0") */
  contentVersion?: string;
  /** Schema URL */
  $schema?: string;
}

/**
 * Parameter definition for a child flow.
 */
export interface ChildFlowParameterConfig {
  /** Human-readable parameter label */
  title: string;
  /** Parameter type */
  type: string;
  /** Whether this parameter is required */
  required: boolean;
}

/**
 * Definition of a child flow referenced by name.
 */
export interface ChildFlowDefinitionConfig {
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
 * Use this in the constructor to define metadata, connection references, and parameters.
 */
export interface FlowConfig {
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

/**
 * The FlowContext interface provides access to:
 * - Action output references (body, outputs, actions)
 * - Trigger references (triggerBody, triggerOutputs)
 * - Variable access
 * - Action methods (http, compose, etc.)
 * - Typed connector access (ctx.connectors.sharepoint.GetItems, ctx.connectors.dataverse.ListRecords, etc.)
 * - Flow configuration (ctx.flow.metadata, ctx.flow.connectionReferences, ctx.flow.parameters)
 */
export interface FlowContext {
  // ============================================
  // Flow Configuration
  // ============================================

  /**
   * Flow-level configuration for metadata, connection references, and parameters.
   * Set these in the constructor to define flow configuration.
   *
   * @example
   * ```typescript
   * constructor(ctx: FlowContext) {
   *   ctx.flow.metadata = { schemaVersion: '1.0.0.0' };
   *   ctx.flow.connectionReferences = {
   *     'shared_sharepointonline': {
   *       apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
   *       connectionReferenceLogicalName: 'cr_sharepoint'
   *     }
   *   };
   *   ctx.flow.parameters = {
   *     'SiteUrl': { type: 'String', defaultValue: 'https://contoso.sharepoint.com' }
   *   };
   * }
   * ```
   */
  flow: FlowConfig;
  // ============================================
  // Reference Functions (for expressions)
  // ============================================

  /**
   * Get the body/output of a previous action.
   * @param actionName Name of the action to reference
   */
  body<T = any>(actionName: string): T;

  /**
   * Get the outputs of a previous action.
   * @param actionName Name of the action to reference
   */
  outputs<T = any>(actionName: string): T;

  /**
   * Get the full action reference including status.
   * @param actionName Name of the action to reference
   */
  actions(actionName: string): ActionReference;

  /**
   * Get the trigger body.
   */
  triggerBody<T = any>(): T;

  /**
   * Get the trigger outputs.
   */
  triggerOutputs<T = any>(): T;

  /**
   * Get a variable value.
   * @param name Name of the variable
   */
  variables<T = any>(name: string): T;

  /**
   * Get the current item in a foreach loop.
   */
  item<T = any>(): T;

  /**
   * Get the current item from a named foreach loop.
   * @param loopName Name of the foreach loop
   */
  items<T = any>(loopName: string): T;

  // ============================================
  // Built-in Actions
  // ============================================

  /**
   * HTTP request action.
   */
  http(name: string, inputs: HttpInputs): Promise<HttpResponse>;

  /**
   * Compose action - creates a value.
   */
  compose(name: string, value: any): Promise<any>;

  /**
   * Save File (debug aid) - compiles to a Compose emitting a sentinel object.
   * In the Maker portal this is an ordinary Compose with no special behavior;
   * when run locally via the FlowForger engine, the host writes the file to
   * disk (CLI) or offers a download (web). No production/Maker-portal effect.
   */
  saveFile(name: string, file: SaveFileInputs): Promise<any>;

  /**
   * Response action - returns an HTTP response.
   */
  response(name: string, statusCode: number): Promise<void>;
  response(name: string, statusCode: number, body: any): Promise<void>;
  response(name: string, statusCode: number, body: any, headers: Record<string, string>): Promise<void>;
  response(name: string, statusCode: number, body: any, headers: Record<string, string> | undefined, schema: any): Promise<void>;
  response(name: string, statusCode: number, body: any, headers: Record<string, string> | undefined, schema: any, kind: 'VirtualAgent' | 'PowerApp' | 'Http'): Promise<void>;
  response(name: string, statusCode?: number, body?: any, headers?: Record<string, string>, schema?: any, kind?: 'VirtualAgent' | 'PowerApp' | 'Http'): Promise<void>;

  /**
   * Terminate action - ends the flow.
   */
  terminate(name: string, runStatus: 'Succeeded' | 'Cancelled' | 'Failed', runError?: { code?: string; message?: string }): Promise<void>;

  /**
   * Delay action - wait for a specified duration.
   */
  delay(name: string, count: number, unit: DelayUnit): Promise<void>;

  /**
   * Delay Until action - wait until a specified time.
   */
  delayUntil(name: string, until: string): Promise<void>;

  /**
   * Call a child workflow.
   */
  callWorkflow(name: string, workflowReferenceName: string, body?: any, headers?: Record<string, string>): Promise<any>;

  /**
   * Parse JSON action.
   */
  parseJson<T = any>(name: string, content: any, schema?: object): Promise<T>;

  /**
   * Join array elements into a string.
   */
  join(name: string, from: any[], joinWith: string): Promise<string>;

  /**
   * Select/map array elements.
   */
  select<T = any>(name: string, from: any[], selectMap: any): Promise<T[]>;

  /**
   * Filter an array. The `where` clause may be either:
   *   - a raw Power Automate expression string (e.g. `"@and(equals(item()?['type'], 'X'), ...)"`), or
   *   - a TypeScript expression that the transformer converts (e.g. `ctx.item()?.['type'] === 'X' && ctx.item()?.['isEnabled']`).
   */
  filter<T = any>(name: string, from: T[], where: string | boolean): Promise<T[]>;

  /**
   * Filter an array (alias for filter). The `where` clause accepts either a raw
   * PA expression string or a TypeScript expression (see `filter`).
   */
  filterArray<T = any>(name: string, from: T[], where: string | boolean): Promise<T[]>;

  /**
   * Create CSV table from array.
   */
  createCsvTable(name: string, from: any[], columns?: Array<{ header: string; value: any }>): Promise<string>;

  /**
   * Create HTML table from array.
   */
  createHtmlTable(name: string, from: any[], columns?: Array<{ header: string; value: any }>): Promise<string>;

  // ============================================
  // Generic Connector (legacy signature)
  // ============================================

  /**
   * Generic connector action for any connector/operation (legacy signature).
   * @deprecated Use ctx.connector.connectorName.Operation() instead
   */
  connector(name: string, connector: string, operation: string, params: ConnectorParams, connectionReferenceName?: string, authentication?: ConnectorAuthentication): Promise<any>;

  /**
   * Connector webhook action (for approvals, etc.).
   */
  connectorWebhook(name: string, connector: string, operation: string, params: ConnectorParams, connectionReferenceName?: string, authentication?: ConnectorAuthentication): Promise<any>;

  // ============================================
  // Typed Connectors (new syntax)
  // ============================================

  /**
   * Typed connector access with autocomplete support.
   * Usage: ctx.connectors.dataverse.ListRecords('name', params)
   *        ctx.connectors.sharepoint.GetItems('name', params)
   */
  connectors: Connectors;

  // ============================================
  // OData Query Builder
  // ============================================

  /**
   * OData query builder for type-safe filter expressions.
   * Usage:
   * ```typescript
   * "$filter": ctx.odata.and(
   *   ctx.odata.eq('status', ctx.parameters('Status')),
   *   ctx.odata.eq('active', true)
   * )
   * ```
   */
  odata: ODataBuilder;

  // ============================================
  // Runtime Expression Evaluation
  // ============================================

  /**
   * Evaluate a Power Automate expression at runtime.
   * Used for expressions that cannot be converted to TypeScript.
   * @param expression The Power Automate expression string
   */
  eval<T = any>(expression: string): T;

  /**
   * Get a flow parameter value.
   * @param name Name of the parameter
   */
  parameters<T = any>(name: string): T;

  /**
   * Get the trigger info object.
   */
  trigger<T = any>(): T;

  /**
   * Get workflow metadata.
   */
  workflow<T = any>(): T;

  // ============================================
  // Date/Time Functions (Runtime)
  // ============================================

  /**
   * Get current UTC time.
   * @param format Optional format string (e.g., 'yyyy-MM-dd', 'HH:mm:ss')
   */
  utcNow(format?: string): string;

  /**
   * Add days to a timestamp.
   */
  addDays(timestamp: string, days: number, format?: string): string;

  /**
   * Add hours to a timestamp.
   */
  addHours(timestamp: string, hours: number, format?: string): string;

  /**
   * Add minutes to a timestamp.
   */
  addMinutes(timestamp: string, minutes: number, format?: string): string;

  /**
   * Add seconds to a timestamp.
   */
  addSeconds(timestamp: string, seconds: number, format?: string): string;

  /**
   * Format a date/time string.
   */
  formatDateTime(timestamp: string, format?: string, locale?: string): string;

  /**
   * Parse a date/time string with optional locale.
   * @param timestamp The date/time string to parse
   * @param locale Optional locale for parsing (e.g., 'de-DE', 'en-US')
   * @param format Optional format string
   */
  parseDateTime(timestamp: string, locale?: string, format?: string): string;

  /**
   * Convert a timestamp from UTC to a target timezone.
   */
  convertFromUtc(timestamp: string, timezone: string, format?: string): string;

  /**
   * Convert a timestamp between timezones.
   */
  convertTimeZone(timestamp: string, sourceTimezone: string, targetTimezone: string, format?: string): string;

  /**
   * Convert a timestamp to UTC.
   */
  convertToUtc(timestamp: string, sourceTimezone: string, format?: string): string;

  /**
   * Get the day of month (1-31).
   */
  dayOfMonth(timestamp: string): number;

  /**
   * Get the day of week (0-6, Sunday = 0).
   */
  dayOfWeek(timestamp: string): number;

  /**
   * Get the day of year (1-366).
   */
  dayOfYear(timestamp: string): number;

  /**
   * Get the start of the day.
   */
  startOfDay(timestamp: string, format?: string): string;

  /**
   * Get the start of the hour.
   */
  startOfHour(timestamp: string, format?: string): string;

  /**
   * Get the start of the month.
   */
  startOfMonth(timestamp: string, format?: string): string;

  /**
   * Get a future time.
   */
  getFutureTime(interval: number, unit: string, format?: string): string;

  /**
   * Get a past time.
   */
  getPastTime(interval: number, unit: string, format?: string): string;

  /**
   * Get ticks (100-nanosecond intervals since Jan 1, 0001).
   */
  ticks(timestamp: string): number;

  // ============================================
  // Utility Functions (Runtime)
  // ============================================

  /**
   * Generate a new GUID.
   */
  guid(): string;

  /**
   * Format a number as a string using a .NET numeric format string and optional locale.
   * @param number The number to format
   * @param format Format string (e.g., 'C2', 'P2', 'N0', 'F2', '0.00')
   * @param locale Optional locale (e.g., 'en-US', 'de-DE')
   */
  formatNumber(number: number, format: string, locale?: string): string;
}
