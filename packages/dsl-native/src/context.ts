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
  // Collection Functions (Runtime)
  // ============================================

  /**
   * Create an array from the given values.
   * Emits `@createArray(...)`.
   */
  createArray<T = any>(...items: T[]): T[];

  /**
   * Combine collections into one, removing duplicates.
   * Works on arrays and objects (later objects' properties win).
   * Emits `@union(...)`.
   */
  union<T = any>(...collections: T[]): T;

  /**
   * Return only the items present in all collections.
   * Works on arrays and objects.
   * Emits `@intersection(...)`.
   */
  intersection<T = any>(...collections: T[]): T;

  /**
   * Generate an array of integers, starting at startIndex with count elements.
   * Emits `@range(...)`.
   */
  range(startIndex: number, count: number): number[];

  /**
   * Get the first element of an array or the first character of a string.
   * Emits `@first(...)`.
   */
  first<T = any>(collection: T[] | string): T;

  /**
   * Get the last element of an array or the last character of a string.
   * Emits `@last(...)`.
   */
  last<T = any>(collection: T[] | string): T;

  /**
   * Skip the first count elements of an array.
   * Emits `@skip(...)`.
   */
  skip<T = any>(collection: T[], count: number): T[];

  /**
   * Take the first count elements of an array or characters of a string.
   * Emits `@take(...)`.
   */
  take<T = any>(collection: T[] | string, count: number): T;

  /**
   * Check whether an array, string, or object is empty.
   * Emits `@empty(...)`.
   */
  empty(collection: any[] | string | object): boolean;

  /**
   * Get the number of elements in an array or characters in a string.
   * Emits `@length(...)`.
   */
  length(collection: any[] | string): number;

  /**
   * Check whether a collection contains a value (string contains substring,
   * array contains item, object contains key).
   * Emits `@contains(...)`.
   */
  contains(collection: string | any[] | object, value: any): boolean;

  /**
   * Split an array or string into chunks of the given length.
   * Emits `@chunk(...)`.
   */
  chunk<T = any>(collection: T[] | string, length: number): T[][];

  /**
   * Reverse the order of items in an array.
   * Emits `@reverse(...)`.
   */
  reverse<T = any>(collection: T[]): T[];

  /**
   * Sort an array, optionally by an object property.
   * Emits `@sort(...)`.
   */
  sort<T = any>(collection: T[], sortBy?: string): T[];

  // ============================================
  // String Functions (Runtime)
  // ============================================

  /**
   * Concatenate values into a single string.
   * Emits `@concat(...)`.
   */
  concat(...values: any[]): string;

  /**
   * Index of the first occurrence of searchText (case-insensitive), or -1.
   * Emits `@indexOf(...)`.
   */
  indexOf(text: string, searchText: string): number;

  /**
   * Index of the last occurrence of searchText (case-insensitive), or -1.
   * Emits `@lastIndexOf(...)`.
   */
  lastIndexOf(text: string, searchText: string): number;

  /**
   * Index of the nth occurrence of searchText, or -1.
   * Emits `@nthIndexOf(...)`.
   */
  nthIndexOf(text: string, searchText: string, occurrence: number): number;

  /**
   * Extract a substring by start index and length (NOT end index).
   * Emits `@substring(...)`.
   */
  substring(text: string, startIndex: number, length?: number): string;

  /**
   * Replace all occurrences of oldText with newText (case-sensitive).
   * Emits `@replace(...)`.
   */
  replace(text: string, oldText: string, newText: string): string;

  /**
   * Convert to lowercase.
   * Emits `@toLower(...)`.
   */
  toLower(text: string): string;

  /**
   * Convert to uppercase.
   * Emits `@toUpper(...)`.
   */
  toUpper(text: string): string;

  /**
   * Remove leading and trailing whitespace.
   * Emits `@trim(...)`.
   */
  trim(text: string): string;

  /**
   * Split a string into an array on a delimiter.
   * Emits `@split(...)`.
   */
  split(text: string, delimiter: string): string[];

  /**
   * Whether the string starts with searchText (case-insensitive).
   * Emits `@startsWith(...)`.
   */
  startsWith(text: string, searchText: string): boolean;

  /**
   * Whether the string ends with searchText (case-insensitive).
   * Emits `@endsWith(...)`.
   */
  endsWith(text: string, searchText: string): boolean;

  /**
   * Extract a substring by start index and end index (exclusive).
   * Emits `@slice(...)`.
   */
  slice(text: string, startIndex: number, endIndex?: number): string;

  // ============================================
  // Math Functions (Runtime)
  // ============================================

  /**
   * Add two numbers.
   * Emits `@add(...)`.
   */
  add(summand1: number, summand2: number): number;

  /**
   * Subtract the second number from the first.
   * Emits `@sub(...)`.
   */
  sub(minuend: number, subtrahend: number): number;

  /**
   * Multiply two numbers.
   * Emits `@mul(...)`.
   */
  mul(multiplicand1: number, multiplicand2: number): number;

  /**
   * Divide the first number by the second.
   * Emits `@div(...)`.
   */
  div(dividend: number, divisor: number): number;

  /**
   * Remainder after dividing the first number by the second.
   * Emits `@mod(...)`.
   */
  mod(dividend: number, divisor: number): number;

  /**
   * Lowest value among the arguments (numbers or a single array of numbers).
   * Emits `@min(...)`.
   */
  min(...numbers: (number | number[])[]): number;

  /**
   * Highest value among the arguments (numbers or a single array of numbers).
   * Emits `@max(...)`.
   */
  max(...numbers: (number | number[])[]): number;

  /**
   * Absolute value.
   * Emits `@abs(...)`.
   */
  abs(value: number): number;

  /**
   * Round up to the nearest integer.
   * Emits `@ceil(...)`.
   */
  ceil(value: number): number;

  /**
   * Round down to the nearest integer.
   * Emits `@floor(...)`.
   */
  floor(value: number): number;

  /**
   * Round to the given number of decimal places.
   * Emits `@round(...)`.
   */
  round(value: number, digits?: number): number;

  /**
   * Random integer in the range [minValue, maxValue).
   * Emits `@rand(...)`.
   */
  rand(minValue: number, maxValue: number): number;

  /**
   * Convert a value to an integer.
   * Emits `@int(...)`.
   */
  int(value: any): number;

  /**
   * Convert a value to a floating-point number.
   * Emits `@float(...)`.
   */
  float(value: any): number;

  /**
   * Convert a value to a decimal number.
   * Emits `@decimal(...)`.
   */
  decimal(value: any): number;

  /**
   * Whether the value is a floating-point number (optionally locale-aware).
   * Emits `@isFloat(...)`.
   */
  isFloat(value: any, locale?: string): boolean;

  /**
   * Whether the value is an integer.
   * Emits `@isInt(...)`.
   */
  isInt(value: any): boolean;

  // ============================================
  // Comparison & Logical Functions (Runtime)
  // ============================================

  /**
   * Whether two values are equal.
   * Emits `@equals(...)`.
   */
  equals(object1: any, object2: any): boolean;

  /**
   * Whether the first value is greater than the second.
   * Emits `@greater(...)`.
   */
  greater(value: any, compareTo: any): boolean;

  /**
   * Whether the first value is less than the second.
   * Emits `@less(...)`.
   */
  less(value: any, compareTo: any): boolean;

  /**
   * Whether the first value is greater than or equal to the second.
   * Emits `@greaterOrEquals(...)`.
   */
  greaterOrEquals(value: any, compareTo: any): boolean;

  /**
   * Whether the first value is less than or equal to the second.
   * Emits `@lessOrEquals(...)`.
   */
  lessOrEquals(value: any, compareTo: any): boolean;

  /**
   * Whether all expressions are true.
   * Emits `@and(...)`.
   */
  and(...expressions: boolean[]): boolean;

  /**
   * Whether at least one expression is true.
   * Emits `@or(...)`.
   */
  or(...expressions: boolean[]): boolean;

  /**
   * Negate a boolean expression.
   * Emits `@not(...)`.
   */
  not(expression: boolean): boolean;

  /**
   * Return one of two values based on a condition.
   * Emits `@if(...)`.
   */
  if<T = any>(expression: boolean, valueIfTrue: T, valueIfFalse: T): T;

  /**
   * First non-null value among the arguments.
   * Emits `@coalesce(...)`.
   */
  coalesce<T = any>(...values: T[]): T;

  // ============================================
  // Conversion & Encoding Functions (Runtime)
  // ============================================

  /**
   * Parse a JSON string (or XML) into an object.
   * Emits `@json(...)`.
   */
  json<T = any>(value: string): T;

  /**
   * Convert a value to a string.
   * Emits `@string(...)`.
   */
  string(value: any): string;

  /**
   * Wrap a value in an array.
   * Emits `@array(...)`.
   */
  array<T = any>(value: T): T[];

  /**
   * Convert a value to a boolean.
   * Emits `@bool(...)`.
   */
  bool(value: any): boolean;

  /**
   * Base64-encode a string.
   * Emits `@base64(...)`.
   */
  base64(value: string): string;

  /**
   * Decode a base64 string to text.
   * Emits `@base64ToString(...)`.
   */
  base64ToString(value: string): string;

  /**
   * Convert a base64 string to binary content.
   * Emits `@base64ToBinary(...)`.
   */
  base64ToBinary(value: string): any;

  /**
   * Convert a string to binary content.
   * Emits `@binary(...)`.
   */
  binary(value: string): any;

  /**
   * Convert a string to a data URI.
   * Emits `@dataUri(...)`.
   */
  dataUri(value: string): string;

  /**
   * Convert a data URI to binary content.
   * Emits `@dataUriToBinary(...)`.
   */
  dataUriToBinary(value: string): any;

  /**
   * Convert a data URI to a string.
   * Emits `@dataUriToString(...)`.
   */
  dataUriToString(value: string): string;

  /**
   * Decode the data portion of a data URI.
   * Emits `@decodeDataUri(...)`.
   */
  decodeDataUri(value: string): any;

  /**
   * URI-encode a string.
   * Emits `@uriComponent(...)`.
   */
  uriComponent(value: string): string;

  /**
   * Decode a URI-encoded string.
   * Emits `@uriComponentToString(...)`.
   */
  uriComponentToString(value: string): string;

  /**
   * Convert a URI-encoded string to binary content.
   * Emits `@uriComponentToBinary(...)`.
   */
  uriComponentToBinary(value: string): any;

  /**
   * Decode a URI-encoded string. Prefer `uriComponentToString()`.
   * Emits `@decodeUriComponent(...)`.
   */
  decodeUriComponent(value: string): string;

  /**
   * Decode a base64 string to text. Prefer `base64ToString()`.
   * Emits `@decodeBase64(...)`.
   */
  decodeBase64(value: string): string;

  /**
   * URI-encode a string. Prefer `uriComponent()`.
   * Emits `@encodeUriComponent(...)`.
   */
  encodeUriComponent(value: string): string;

  /**
   * Convert a string or JSON object to XML.
   * Emits `@xml(...)`.
   */
  xml(value: any): any;

  /**
   * Evaluate an XPath expression against XML content.
   * Emits `@xpath(...)`.
   */
  xpath(xml: any, xpath: string): any;

  // ============================================
  // Object Functions (Runtime)
  // ============================================

  /**
   * Return a copy of the object with the property set (added or updated).
   * Emits `@setProperty(...)`.
   */
  setProperty<T = any>(object: T, property: string, value: any): T;

  /**
   * Return a copy of the object with the property added.
   * Emits `@addProperty(...)`.
   */
  addProperty<T = any>(object: T, property: string, value: any): T;

  /**
   * Return a copy of the object with the property removed.
   * Emits `@removeProperty(...)`.
   */
  removeProperty<T = any>(object: T, property: string): T;

  // ============================================
  // URI Parsing Functions (Runtime)
  // ============================================

  /**
   * Host portion of a URI.
   * Emits `@uriHost(...)`.
   */
  uriHost(uri: string): string;

  /**
   * Path portion of a URI.
   * Emits `@uriPath(...)`.
   */
  uriPath(uri: string): string;

  /**
   * Path and query portion of a URI.
   * Emits `@uriPathAndQuery(...)`.
   */
  uriPathAndQuery(uri: string): string;

  /**
   * Port number of a URI.
   * Emits `@uriPort(...)`.
   */
  uriPort(uri: string): number;

  /**
   * Query string portion of a URI.
   * Emits `@uriQuery(...)`.
   */
  uriQuery(uri: string): string;

  /**
   * Scheme (protocol) of a URI.
   * Emits `@uriScheme(...)`.
   */
  uriScheme(uri: string): string;

  // ============================================
  // Workflow & Form Data Functions (Runtime)
  // ============================================

  /**
   * Results of all actions inside a scope (useful in error handling).
   * Emits `@result(...)`.
   */
  result(scopeName: string): any[];

  /**
   * Details of the current action (inside do-until or error handlers).
   * Emits `@action()`.
   */
  action<T = any>(): T;

  /**
   * Body of a previous action. Prefer `body()`.
   * Emits `@actionBody(...)`.
   */
  actionBody<T = any>(actionName: string): T;

  /**
   * Current iteration index of a do-until loop.
   * Emits `@iterationIndexes(...)`.
   */
  iterationIndexes(loopName: string): number;

  /**
   * Callback URL of the flow's HTTP trigger.
   * Emits `@listCallbackUrl()`.
   */
  listCallbackUrl(): string;

  /**
   * Value of a form-data key in an action's output.
   * Emits `@formDataValue(...)`.
   */
  formDataValue(actionName: string, key: string): any;

  /**
   * All values of a form-data key in an action's output.
   * Emits `@formDataMultiValues(...)`.
   */
  formDataMultiValues(actionName: string, key: string): any[];

  /**
   * Body of a part in an action's multipart output.
   * Emits `@multipartBody(...)`.
   */
  multipartBody(actionName: string, index: number): any;

  /**
   * Value of a form-data key in the trigger output.
   * Emits `@triggerFormDataValue(...)`.
   */
  triggerFormDataValue(key: string): any;

  /**
   * All values of a form-data key in the trigger output.
   * Emits `@triggerFormDataMultiValues(...)`.
   */
  triggerFormDataMultiValues(key: string): any[];

  /**
   * Body of a part in the trigger's multipart output.
   * Emits `@triggerMultipartBody(...)`.
   */
  triggerMultipartBody(index: number): any;

  // ============================================
  // Additional Date/Time Functions (Runtime)
  // ============================================

  /**
   * Add an interval to a timestamp (unit: 'Second', 'Minute', 'Hour', 'Day', 'Week', 'Month', 'Year').
   * Emits `@addToTime(...)`.
   */
  addToTime(timestamp: string, interval: number, timeUnit: string, format?: string): string;

  /**
   * Subtract an interval from a timestamp (unit: 'Second', 'Minute', 'Hour', 'Day', 'Week', 'Month', 'Year').
   * Emits `@subtractFromTime(...)`.
   */
  subtractFromTime(timestamp: string, interval: number, timeUnit: string, format?: string): string;

  /**
   * Difference between two timestamps as a timespan string (e.g. "1.00:00:00").
   * Emits `@dateDifference(...)`.
   */
  dateDifference(startDate: string, endDate: string): string;

  // ============================================
  // Expression Literal Helpers (DSL-specific)
  // ============================================

  /**
   * Force string-interpolation output: wraps the expression as `@{...}`
   * (string coercion) instead of `@...` (type-preserving).
   */
  braced(expression: any): string;

  /**
   * Emit the literal expression `@true` (for parity with existing flows).
   */
  atTrue(): boolean;

  /**
   * Emit the literal expression `@false` (for parity with existing flows).
   */
  atFalse(): boolean;

  /**
   * Emit a literal number expression like `@0` (for parity with existing flows).
   */
  atNumber(value: number): number;

  /**
   * Emit a quoted string-literal expression like `@'text'` (for parity with existing flows).
   */
  atString(value: string): string;

  /**
   * Emit the literal expression `@null` (for parity with existing flows).
   */
  null(): null;

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
