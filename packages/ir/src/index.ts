// Re-export configuration system
export {
  // Configuration interfaces
  type FlowForgerConfig,
  type LoggingConfig,
  type ParserConfig,
  type GeneratorConfig,
  type TransformerConfig,
  type EmitterConfig,
  type EmitterConnectionRef,
  type ParityConfig,
  // Default configurations
  DEFAULT_CONFIG,
  DEFAULT_LOGGING_CONFIG,
  DEFAULT_PARSER_CONFIG,
  DEFAULT_GENERATOR_CONFIG,
  DEFAULT_TRANSFORMER_CONFIG,
  DEFAULT_EMITTER_CONFIG,
  DEFAULT_PARITY_CONFIG,
  // Utility functions
  mergeConfig,
  getLoggingConfig,
  getParserConfig,
  getGeneratorConfig,
  getTransformerConfig,
  getEmitterConfig,
  getParityConfig,
  validateConfig,
  parseConfigFromJson,
} from './config.js';

export type StepResultStatus = 'Succeeded' | 'Failed' | 'Skipped' | 'TimedOut';

export interface StepResult {
  status: StepResultStatus;
  outputs?: any;
  error?: any;
}

export interface RetryPolicy {
  type: 'none' | 'fixed' | 'exponential';
  count?: number; // attempts
  interval?: number; // ms for fixed; base for exponential
}

/**
 * Action-level execution limit configuration.
 * Used to set timeouts on actions (e.g., connector actions).
 */
export interface ActionLimit {
  timeout?: string; // ISO 8601 duration (e.g., 'PT2M' = 2 minutes)
}

export interface HttpActionInputs {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: any;
}

export interface HttpTriggerInputs {
  method?: string;
  path?: string;
  schema?: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
  headersSchema?: Record<string, any>; // Schema for HTTP headers
  triggerAuthenticationType?: string;
  triggerKind?: 'Http' | 'VirtualAgent'; // Logic Apps trigger kind (defaults to 'Http' for HTTP triggers)
}

export interface ConnectorTriggerInputs {
  connector: string; // e.g., 'office365', 'sharepoint', 'dataverse'
  operation: string; // e.g., 'OnNewEmailV3', 'OnFileCreated'
  params: Record<string, any>;
  connectionReferenceName?: string; // Preserve exact connection reference (e.g., 'shared_sharepointonline_2')
  triggerType?: 'OpenApiConnection' | 'OpenApiConnectionWebhook' | 'OpenApiConnectionNotification'; // Preserve original trigger type
  splitOn?: string; // Batch processing expression
  recurrence?: {
    interval: number;
    frequency: string; // 'Second' | 'Minute' | 'Hour' | 'Day' | 'Week' | 'Month'
  };
  authentication?: string; // Authentication expression (e.g., "@parameters('$authentication')")
  retryPolicy?: Record<string, any>; // Retry policy for the trigger (type, count, interval, etc.)
}

export interface ManualTriggerInputs {
  schema?: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
  headersSchema?: Record<string, any>; // Schema for HTTP headers
  triggerAuthenticationType?: string;
  triggerKind?: 'Button' | 'PowerAppV2'; // Logic Apps trigger kind (defaults to 'Button' for manual triggers)
}

/**
 * Trigger condition for filtering when a trigger should fire.
 * Logic Apps supports conditions on triggers to prevent flow execution
 * unless the condition evaluates to true.
 */
export interface TriggerCondition {
  expression: string; // e.g., "@equals(triggerBody()?['text'],'test')"
}

export interface RecurrenceSchedule {
  minutes?: number[];
  hours?: number[];
  weekDays?: ('Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday')[];
  monthDays?: number[];
  monthlyOccurrences?: Array<{
    dayOfWeek: 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday';
    occurrence: number;
  }>;
}

export interface RecurrenceTriggerInputs {
  frequency: 'Second' | 'Minute' | 'Hour' | 'Day' | 'Week' | 'Month' | 'Year';
  interval: number;
  count?: number;
  startTime?: string; // ISO 8601 timestamp
  endTime?: string; // ISO 8601 timestamp
  timeZone?: string; // e.g., 'Eastern Standard Time', 'UTC'
  schedule?: RecurrenceSchedule;
}

export interface BaseNode {
  id: string;
  name: string;
  description?: string; // Action description (e.g., "Foreach question element")
  runtimeConfiguration?: Record<string, any>; // Logic Apps runtime config (e.g., chunked transfer)
  metadata?: Record<string, any>; // Logic Apps metadata (preserves operationMetadataId, etc.)
}

export interface ActionNode extends BaseNode {
  type: 'action';
  kind: 'http' | 'compose' | 'expression' | 'initializevariable' | 'setvariable' | 'incrementvariable' | 'decrementvariable' |
        'appendtoarrayvariable' | 'appendtostringvariable' | 'join' | 'select' | 'filterarray' |
        'parsejson' | 'createcsvtable' | 'createhtmltable' | 'response' | 'terminate' | 'delay' | 'delayuntil' | 'workflow';
  inputs: HttpActionInputs | ComposeActionInputs | ExpressionActionInputs | VariableActionInputs | DataOperationInputs |
           ResponseInputs | TerminateInputs | DelayInputs | WorkflowActionInputs;
  retryPolicy?: RetryPolicy;
  runAfter?: Record<string, StepResultStatus[]>;
  limit?: ActionLimit; // Action timeout limit (e.g., for workflow calls)
  /** Tracked properties for telemetry and monitoring */
  trackedProperties?: Record<string, string>;
}

export interface ComposeActionInputs {
  value: any; // Can be an expression string or any value
}

// Expression action inputs (for IndexOf, Add, etc.)
export interface ExpressionActionInputs {
  expressionKind: string; // 'IndexOf', 'Add', 'Subtract', etc.
  // The raw inputs passed to the expression (varies by kind)
  // For IndexOf: { text: string, searchText: string }
  // For math: { input1: any, input2: any }
  [key: string]: any;
}

// Variable action inputs
export interface VariableActionInputs {
  variableName?: string;
  variableType?: 'String' | 'Integer' | 'Float' | 'Boolean' | 'Array' | 'Object';
  value?: any;
  name?: string; // For actions that reference existing variables
}

// Data operation inputs
export interface DataOperationInputs {
  from?: any; // Source array/data
  joinWith?: string; // For join
  select?: any; // For select (mapping)
  where?: string; // For filter array (condition)
  schema?: any; // For parse JSON
  columns?: Array<{ header: string; value: any }>; // For create table actions
}

// Response action inputs
export interface ResponseInputs {
  statusCode?: number | string;
  headers?: Record<string, string>;
  body?: any;
  schema?: any; // Schema for response body (used in Power Apps and Power Virtual Agents flows)
  kind?: 'VirtualAgent' | 'PowerApp' | 'Http'; // Logic Apps response kind
}

// Terminate action inputs
export interface TerminateInputs {
  runStatus: 'Succeeded' | 'Cancelled' | 'Failed';
  runError?: {
    code?: string;
    message?: string;
  };
}

// Delay action inputs
export interface DelayInputs {
  interval?: {
    count: number | string; // Can be a number or expression (e.g., "@rand(1,360)")
    unit: 'Second' | 'Minute' | 'Hour' | 'Day' | 'Week' | 'Month';
  };
  until?: string; // ISO 8601 timestamp or expression
}

// Workflow action inputs (child workflow invocation)
export interface WorkflowActionInputs {
  workflowReferenceName?: string; // GUID or name reference to child workflow
  workflowId?: string; // Alternative: direct workflow ID
  body?: any; // Input parameters to pass to child workflow
  headers?: Record<string, string>; // Optional headers
}

export interface ScopeNode extends BaseNode {
  type: 'scope';
  actions: Node[];
  runAfter?: Record<string, StepResultStatus[]>;
  /** Tracked properties for telemetry and monitoring */
  trackedProperties?: Record<string, string>;
}

export interface IfNode extends BaseNode {
  type: 'if';
  condition: string; // Logic Apps expression string (e.g., "@equals(...)" or simplified)
  /** Original condition format: 'string' for "@equals(...)", 'object' for {"equals":[...]} */
  conditionFormat?: 'string' | 'object';
  actions: Node[]; // then
  elseActions?: Node[];
  runAfter?: Record<string, StepResultStatus[]>;
  /** Tracked properties for telemetry and monitoring */
  trackedProperties?: Record<string, string>;
}

export interface ForeachNode extends BaseNode {
  type: 'foreach';
  itemsExpression: string; // expression of items to iterate
  actions: Node[];
  parallel?: boolean;
  runAfter?: Record<string, StepResultStatus[]>;
  /** Tracked properties for telemetry and monitoring */
  trackedProperties?: Record<string, string>;
}

export interface SwitchCase {
  name: string; // human-readable case name (used as key in Logic Apps JSON)
  value: string | number; // case value to match (the "case" property in Logic Apps JSON)
  actions: Node[];
}

export interface SwitchNode extends BaseNode {
  type: 'switch';
  expression: string; // expression to evaluate
  cases: SwitchCase[];
  defaultActions?: Node[];
  runAfter?: Record<string, StepResultStatus[]>;
  /** Tracked properties for telemetry and monitoring */
  trackedProperties?: Record<string, string>;
}

export interface DoUntilNode extends BaseNode {
  type: 'dountil';
  condition: string; // expression to check after each iteration
  actions: Node[];
  limit?: number; // max iterations (default 60)
  timeout?: string; // ISO 8601 duration (e.g., 'PT1H')
  runAfter?: Record<string, StepResultStatus[]>;
  /** Tracked properties for telemetry and monitoring */
  trackedProperties?: Record<string, string>;
}

export interface ConnectorActionNode extends BaseNode {
  type: 'connector';
  connector: 'sharepoint' | 'dataverse' | string;
  operation: string;
  params: Record<string, any>;
  /** True if the source JSON had no `parameters` key on inputs (parameterless operation). Used to preserve parity (don't emit `parameters: {}`). */
  paramsOmitted?: boolean;
  connectionReferenceName?: string; // Preserve exact connection reference (e.g., 'shared_sharepointonline_2')
  runAfter?: Record<string, StepResultStatus[]>;
  retryPolicy?: RetryPolicy;
  limit?: ActionLimit; // Action timeout limit
  /** Tracked properties for telemetry and monitoring */
  trackedProperties?: Record<string, string>;
}

export interface ConnectorWebhookActionNode extends BaseNode {
  type: 'connectorwebhook';
  connector: string; // e.g., 'approvals', 'teams', etc.
  operation: string; // e.g., 'StartAndWaitForAnApproval'
  params: Record<string, any>;
  connectionReferenceName?: string; // Preserve exact connection reference (e.g., 'shared_approvals')
  runAfter?: Record<string, StepResultStatus[]>;
  retryPolicy?: RetryPolicy;
  limit?: ActionLimit; // Action timeout limit
  /** Tracked properties for telemetry and monitoring */
  trackedProperties?: Record<string, string>;
}

export interface TriggerNode extends BaseNode {
  type: 'trigger';
  kind: 'http' | 'connector' | 'manual';
  inputs: HttpTriggerInputs | ConnectorTriggerInputs | ManualTriggerInputs;
  conditions?: TriggerCondition[]; // Trigger conditions that must be met for flow to execute
  correlation?: Record<string, any>; // Trigger correlation settings
  // Note: runtimeConfiguration is inherited from BaseNode (e.g., { concurrency: { runs: 20 } })
}

export interface RecurrenceTriggerNode extends BaseNode {
  type: 'recurrence';
  inputs: RecurrenceTriggerInputs;
  /** Evaluated recurrence (actual effective schedule after Power Automate processes settings) */
  evaluatedRecurrence?: RecurrenceTriggerInputs;
  conditions?: TriggerCondition[]; // Trigger conditions that must be met for flow to execute
  correlation?: Record<string, any>; // Trigger correlation settings
  // Note: runtimeConfiguration is inherited from BaseNode (e.g., { concurrency: { runs: 20 } })
}

export type Node = TriggerNode | RecurrenceTriggerNode | ActionNode | ScopeNode | IfNode | ForeachNode | SwitchNode | DoUntilNode | ConnectorActionNode | ConnectorWebhookActionNode;

/**
 * Connection reference metadata for Logic Apps deployment.
 * Maps connection reference names to their Dataverse logical names and API info.
 */
export interface ConnectionReference {
  /** The API identifier (e.g., '/providers/Microsoft.PowerApps/apis/shared_sharepointonline') */
  apiId: string;
  /** The Dataverse logical name for this connection reference (for solution-aware flows) */
  connectionReferenceLogicalName?: string;
  /** The direct connection ID (for embedded connections, e.g., 'b41731b4a9fe4561bc46c535ac774076') */
  connectionName?: string;
  /** Runtime source, typically 'embedded' or 'invoker' */
  runtimeSource?: string;
  /** Impersonation settings (optional, used with some connectors like Dataverse) */
  impersonation?: Record<string, unknown>;
}

/**
 * Flow metadata for Logic Apps schema versioning.
 */
export interface FlowMetadata {
  /** Schema version (e.g., "1.0.0.0") */
  schemaVersion?: string;
  /** Content version (e.g., "1.0.0.0") */
  contentVersion?: string;
  /** Schema URL (e.g., "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#") */
  $schema?: string;
}

/**
 * Flow parameter definition for Logic Apps.
 * Maps parameter names to their type and default value.
 */
export interface FlowParameter {
  /** The parameter type (String, Int, Float, Bool, Array, Object, SecureString, SecureObject) */
  type: 'String' | 'Int' | 'Float' | 'Bool' | 'Array' | 'Object' | 'SecureString' | 'SecureObject';
  /** The default value for this parameter */
  defaultValue?: any;
  /** Allowed values (for enum-like parameters) */
  allowedValues?: any[];
  /** Metadata about the parameter */
  metadata?: {
    /** Schema name for environment variable binding */
    schemaName?: string;
    description?: string;
    displayName?: string;
  };
}

/**
 * Parameter definition for a child flow.
 */
export interface ChildFlowParameter {
  /** Human-readable parameter label */
  title: string;
  /** Parameter type: 'string' | 'number' | 'boolean' | 'object' | 'array' */
  type: string;
  /** Whether this parameter is required */
  required: boolean;
}

/**
 * Definition of a child flow referenced by name.
 */
export interface ChildFlowDefinition {
  /** The workflow GUID in Dataverse */
  workflowId: string;
  /** Human-readable description */
  description?: string;
  /** Parameter schema for the child flow's trigger */
  parameters?: Record<string, ChildFlowParameter>;
  /** Path to the child flow's .ff.ts DSL file (relative to parent flow file) */
  dslPath?: string;
}

export interface FlowIR {
  name: string;
  /** Flow-level description (shown in Power Automate UI) */
  description?: string;
  /** Dataverse workflow GUID (DSL-layer only; not part of Logic Apps JSON) */
  workflowId?: string;
  nodes: Node[];
  /** Flow parameters (e.g., environment variables). Keys are parameter names. */
  parameters?: Record<string, FlowParameter>;
  /** Logic Apps outputs definition */
  outputs?: Record<string, any>;
  /** Connection references for Logic Apps deployment. Keys are reference names (e.g., 'shared_sharepointonline'). */
  connectionReferences?: Record<string, ConnectionReference>;
  /** Schema metadata (schemaVersion, contentVersion, $schema) */
  metadata?: FlowMetadata;
  /** Workflow-level metadata at definition.metadata (creator, flowclientsuspensionreason, etc.) — preserved verbatim. */
  workflowMetadata?: Record<string, any>;
  /** Static results for testing (mock responses for actions) */
  staticResults?: Record<string, any>;
  /** Child flow definitions for name-based workflow references. Keys are friendly names. */
  childFlows?: Record<string, ChildFlowDefinition>;
}

export function isTrigger(n: Node): n is TriggerNode {
  return n.type === 'trigger';
}

export function isAction(n: Node): n is ActionNode {
  return n.type === 'action';
}

export function isScope(n: Node): n is ScopeNode {
  return n.type === 'scope';
}

export function isIf(n: Node): n is IfNode {
  return n.type === 'if';
}

export function isForeach(n: Node): n is ForeachNode {
  return n.type === 'foreach';
}

export function isSwitch(n: Node): n is SwitchNode {
  return n.type === 'switch';
}

export function isDoUntil(n: Node): n is DoUntilNode {
  return n.type === 'dountil';
}

export function isConnector(n: Node): n is ConnectorActionNode {
  return n.type === 'connector';
}

export function isConnectorWebhook(n: Node): n is ConnectorWebhookActionNode {
  return n.type === 'connectorwebhook';
}

export function isRecurrenceTrigger(n: Node): n is RecurrenceTriggerNode {
  return n.type === 'recurrence';
}

export * from './diff.js';
