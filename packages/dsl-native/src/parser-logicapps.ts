/**
 * Logic Apps JSON to IR Parser
 * Converts Power Automate/Logic Apps clientdata JSON to FlowIR.
 *
 * This is the canonical conversion from Logic Apps JSON to IR.
 * Expressions are preserved in Power Automate format (e.g., @trim(...)).
 */

// Default authentication expression for ApiConnection actions/triggers. The Logic Apps
// emitter auto-injects this string when the IR has no explicit authentication, so we drop
// it on parse to keep the IR (and downstream generated DSL) free of redundant noise. HTTP
// actions are excluded — their emitter has no default fallback.
const DEFAULT_CONNECTOR_AUTHENTICATION = "@parameters('$authentication')";

function isDefaultConnectorAuthentication(value: unknown): boolean {
  return typeof value === 'string' && value === DEFAULT_CONNECTOR_AUTHENTICATION;
}

import type {
  FlowIR,
  Node,
  TriggerNode,
  RecurrenceTriggerNode,
  ActionNode,
  ScopeNode,
  IfNode,
  ForeachNode,
  SwitchNode,
  DoUntilNode,
  ConnectorActionNode,
  ConnectorWebhookActionNode,
  ConnectionReference,
  FlowParameter,
  FlowMetadata,
  StepResultStatus,
  FlowForgerConfig,
  ParserConfig,
  ChildFlowDefinition,
} from '@flowforger/ir';

import { getLoggingConfig, getParserConfig } from '@flowforger/ir';

// Module-level config storage for the current parse run
let currentParserConfig: Required<ParserConfig> = getParserConfig();

/**
 * Filter metadata object based on skipMetadataFields config.
 * Returns undefined if resulting metadata is empty.
 */
function filterMetadata(metadata: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!metadata) return undefined;

  const skipFields = currentParserConfig.skipMetadataFields;
  if (!skipFields || skipFields.length === 0) {
    return metadata;
  }

  const filtered: Record<string, any> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!skipFields.includes(key)) {
      filtered[key] = value;
    }
  }

  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

// ID counter for generating unique IDs
let idCounter = 0;

export function resetParserIdCounter(): void {
  idCounter = 0;
}

function nextId(prefix: string): string {
  return `${prefix}_${++idCounter}`;
}

// Operation ID mapping: Power Automate → FlowForger IR
// Reverse of the emitter's IR_TO_PA_OPERATIONS — Power Automate cloud → FlowForger IR.
// Keyed by connector so an operationId that means different things on different
// connectors won't collide. Keep in sync with packages/emitter-logicapps/src/index.ts.
const PA_TO_IR_OPERATIONS: Record<string, Record<string, string>> = {
  sharepoint: {
    'PostItem': 'CreateItem',
    'GetItem': 'GetItemById',
    'PatchItem': 'UpdateItem',
  },
  office365: {
    'ExportEmail_V2': 'ExportEmailV2',
  },
};

function mapOperationId(operationId: string, connector?: string): string {
  if (connector && PA_TO_IR_OPERATIONS[connector]?.[operationId]) {
    return PA_TO_IR_OPERATIONS[connector][operationId];
  }
  return operationId;
}

/**
 * Infer a canonical Power Automate operation ID from a legacy ApiConnection
 * URL path + HTTP method. Used as a fallback when metadata.flowSystemMetadata
 * .swaggerOperationId is missing — Power Automate strips that field when a flow
 * is re-imported into another environment, leaving us nothing but the path.
 *
 * Returns null if the path doesn't match a known shape, in which case the
 * caller falls back to the generic path-derived placeholder.
 */
function inferLegacyOperationId(
  path: string | undefined,
  method: string | undefined
): string | null {
  if (!path) return null;
  const m = (method || '').toLowerCase();
  // Replace @{...} expression blocks with a placeholder so their inner '/'
  // (e.g. inside encodeURIComponent('https://.../sites/...')) doesn't break
  // the segment shape match.
  const stripped = path.replace(/@\{[^}]*\}/g, 'X');

  // SharePoint dataset/table item operations
  if (/^\/datasets\/[^/]+\/tables\/[^/]+\/items\/[^/]+\/?$/.test(stripped)) {
    if (m === 'get') return 'GetItem';
    if (m === 'patch' || m === 'post') return 'PatchItem';
    if (m === 'delete') return 'DeleteItem';
  }
  if (/^\/datasets\/[^/]+\/tables\/[^/]+\/items\/?$/.test(stripped)) {
    if (m === 'get') return 'GetItems';
    if (m === 'post') return 'PostItem';
  }
  if (/^\/datasets\/[^/]+\/tables\/[^/]+\/onnewitems\/?$/.test(stripped)) return 'GetOnNewItems';
  if (/^\/datasets\/[^/]+\/tables\/[^/]+\/onupdateditems\/?$/.test(stripped)) return 'GetOnUpdatedItems';

  return null;
}

/**
 * Normalize Logic Apps status to FlowForger IR status format
 * Note: We preserve the original case to maintain parity during roundtrip.
 * Power Automate uses UPPERCASE (SUCCEEDED, FAILED) but we accept any case.
 */
function normalizeStatus(status: string): StepResultStatus {
  // Preserve original case for parity - just validate it's a known status
  const upper = status.toUpperCase();
  if (['SUCCEEDED', 'FAILED', 'SKIPPED', 'TIMEDOUT'].includes(upper)) {
    return status as StepResultStatus;
  }
  return status as StepResultStatus;
}

/**
 * Normalize runAfter object
 * IMPORTANT: Empty runAfter {} is meaningful in Logic Apps - it means "run after trigger" (parallel execution)
 */
function normalizeRunAfter(runAfter: Record<string, string[]> | undefined): Record<string, StepResultStatus[]> | undefined {
  if (!runAfter) {
    return undefined;
  }
  // Preserve empty runAfter {} - it means "run after trigger" (no dependencies on other actions)
  if (Object.keys(runAfter).length === 0) {
    return {};
  }
  const result: Record<string, StepResultStatus[]> = {};
  for (const [key, statuses] of Object.entries(runAfter)) {
    result[key] = statuses.map(s => normalizeStatus(s));
  }
  return result;
}

/**
 * Convert Logic Apps condition object to expression string
 */
function conditionToExpression(condition: any): string {
  if (typeof condition === 'string') {
    return condition;
  }

  if (typeof condition !== 'object' || condition === null) {
    return String(condition);
  }

  // Handle logical operators: and, or, not
  // Unwrap single-element `and`/`or` — the maker-portal designer adds a
  // single-element `and` wrapper around bare comparisons for visual rendering,
  // but in the DSL we want the cleaner inner expression. The emitter's default
  // re-wraps single comparisons in `and: [...]` so round-trip parity is kept.
  if ('and' in condition && Array.isArray(condition.and)) {
    if (condition.and.length === 1) {
      return conditionToExpression(condition.and[0]);
    }
    const parts = condition.and.map((c: any) => conditionToExpression(c));
    return `@and(${parts.join(', ')})`;
  }

  if ('or' in condition && Array.isArray(condition.or)) {
    if (condition.or.length === 1) {
      return conditionToExpression(condition.or[0]);
    }
    const parts = condition.or.map((c: any) => conditionToExpression(c));
    return `@or(${parts.join(', ')})`;
  }

  if ('not' in condition) {
    const inner = conditionToExpression(condition.not);
    return `@not(${inner})`;
  }

  // Handle comparison operators
  const comparisonOps = ['equals', 'not', 'greater', 'greaterOrEquals', 'less', 'lessOrEquals', 'contains', 'startsWith', 'endsWith'];
  for (const op of comparisonOps) {
    if (op in condition && Array.isArray(condition[op])) {
      const args = condition[op].map((arg: any) => {
        if (typeof arg === 'string' && arg.startsWith('@')) {
          // Preserve @true/@false/@null as-is for parity
          if (arg === '@true' || arg === '@false' || arg === '@null') {
            return arg;
          }
          // Preserve @<number> patterns like @0, @1, @-5 for parity
          if (/^@-?\d+(\.\d+)?$/.test(arg)) {
            return arg;
          }
          // Preserve @'<text>' (PA quoted-string-literal expression) for parity.
          // Distinct from a plain JSON string with the same value.
          if (/^@'[^']*'$/.test(arg)) {
            return arg;
          }
          return arg.substring(1);
        }
        // Plain string args become PA quoted-string literals; embedded `'` escape
        // to `''` per PA syntax so the resulting expression string round-trips.
        return typeof arg === 'string' ? `'${arg.replace(/'/g, "''")}'` : arg;
      });
      return `@${op}(${args.join(', ')})`;
    }
  }

  return JSON.stringify(condition);
}

/**
 * Order actions by their runAfter dependencies
 */
function orderActions(actionsObj: Record<string, any>): string[] {
  const keys = Object.keys(actionsObj || {});
  const deps: Record<string, string[]> = {};
  for (const k of keys) {
    const ra = actionsObj[k]?.runAfter || {};
    deps[k] = Object.keys(ra);
  }
  const ordered: string[] = [];
  const visited = new Set<string>();
  function visit(k: string) {
    if (visited.has(k)) return;
    visited.add(k);
    for (const d of deps[k] || []) if (actionsObj[d]) visit(d);
    ordered.push(k);
  }
  for (const k of keys) visit(k);
  return ordered;
}

/**
 * Determine connector name from apiId
 */
function getConnectorName(apiId: string): string {
  const conn = String(apiId).toLowerCase();
  // Check more specific patterns first to avoid false matches
  // e.g., 'office365users' and 'office365groups' should not match 'office365'
  if (conn.includes('office365users')) return 'office365users';
  if (conn.includes('office365groups')) return 'office365groups';
  if (conn.includes('office365')) return 'office365';
  if (conn.includes('sharepoint')) return 'sharepoint';
  if (conn.includes('commondataservice') || conn.includes('dataverse')) return 'dataverse';
  if (conn.includes('approvals')) return 'approvals';
  if (conn.includes('teams')) return 'teams';

  const match = apiId.match(/\/apis\/(?:shared_)?([^\/]+)$/);
  if (match) return match[1];

  return 'unknown';
}

/**
 * Parse a single trigger from Logic Apps JSON
 */
function parseTrigger(name: string, trigger: any): TriggerNode | RecurrenceTriggerNode {
  const tType = (trigger.type || '').toLowerCase();
  const tKind = (trigger.kind || '').toLowerCase();

  // Recurrence trigger
  if (tType === 'recurrence' && trigger.recurrence) {
    const rec = trigger.recurrence;
    const node: RecurrenceTriggerNode = {
      id: nextId('trg'),
      type: 'recurrence',
      name,
      inputs: {
        frequency: rec.frequency || 'Day',
        interval: rec.interval || 1,
      },
    };
    if (rec.timeZone) node.inputs.timeZone = rec.timeZone;
    if (rec.startTime) node.inputs.startTime = rec.startTime;
    if (rec.endTime) node.inputs.endTime = rec.endTime;
    if (rec.schedule) node.inputs.schedule = rec.schedule;
    if (trigger.description) node.description = trigger.description;
    if (trigger.conditions !== undefined) node.conditions = trigger.conditions;
    if (trigger.correlation !== undefined) node.correlation = trigger.correlation;
    if (trigger.runtimeConfiguration) node.runtimeConfiguration = trigger.runtimeConfiguration;
    if (trigger.metadata) node.metadata = filterMetadata(trigger.metadata);
    // Preserve evaluatedRecurrence if present (Power Automate's effective schedule)
    if (trigger.evaluatedRecurrence) {
      const evalRec = trigger.evaluatedRecurrence;
      node.evaluatedRecurrence = {
        frequency: evalRec.frequency || 'Day',
        interval: evalRec.interval || 1,
      };
      if (evalRec.timeZone) node.evaluatedRecurrence.timeZone = evalRec.timeZone;
      if (evalRec.startTime) node.evaluatedRecurrence.startTime = evalRec.startTime;
      if (evalRec.endTime) node.evaluatedRecurrence.endTime = evalRec.endTime;
      if (evalRec.schedule) node.evaluatedRecurrence.schedule = evalRec.schedule;
    }
    return node;
  }

  // Manual trigger (Button or PowerAppV2)
  if (tType === 'request' && (tKind === 'button' || tKind === 'powerappv2')) {
    const node: TriggerNode = {
      id: nextId('trg'),
      type: 'trigger',
      kind: 'manual',
      name,
      inputs: {},
    };
    if (trigger.inputs?.schema) {
      (node.inputs as any).schema = trigger.inputs.schema;
    }
    if (trigger.inputs?.headersSchema) {
      (node.inputs as any).headersSchema = trigger.inputs.headersSchema;
    }
    if (tKind === 'powerappv2') {
      (node.inputs as any).triggerKind = 'PowerAppV2';
    }
    if (trigger.description) node.description = trigger.description;
    if (trigger.conditions !== undefined) node.conditions = trigger.conditions;
    if (trigger.correlation !== undefined) node.correlation = trigger.correlation;
    if (trigger.runtimeConfiguration) node.runtimeConfiguration = trigger.runtimeConfiguration;
    if (trigger.metadata) node.metadata = filterMetadata(trigger.metadata);
    return node;
  }

  // Legacy ApiConnection trigger (Request type with ApiConnection kind)
  // e.g., Dataverse triggers that use the old connection format
  if (tType === 'request' && tKind === 'apiconnection') {
    // This is a connector trigger using the legacy host.connection.name format
    const connExpr = trigger.inputs?.host?.connection?.name || '';
    let connRefName = 'unknown';

    // Extract connection reference name from expression
    const match1 = connExpr.match(/\['\$connections'\]\['([^']+)'\]/);
    const match2 = connExpr.match(/\$connections\.([a-zA-Z0-9_-]+)\./);
    // Pattern 3: @parameters('$connections')['name']['connectionId'] - extract name before connectionId
    const match3 = connExpr.match(/\['([^']+)'\]\['connectionId'\]/);
    if (match1) {
      connRefName = match1[1];
    } else if (match2) {
      connRefName = match2[1];
    } else if (match3) {
      connRefName = match3[1];
    }

    // Extract connector name from reference (e.g., 'shared_commondataservice' -> 'commondataservice')
    const connectorName = connRefName
      .replace(/^shared_/, '')
      .replace(/_\d+$/, '')
      .replace(/-\d+$/, '');

    const operationId = trigger.inputs?.operationId || '';

    // Store legacy info in params so it survives DSL roundtrip
    const legacyInfo: Record<string, any> = {
      connectionExpression: connExpr,
    };
    if (trigger.inputs?.schema) legacyInfo.schema = trigger.inputs.schema;
    if (trigger.inputs?.headersSchema) legacyInfo.headersSchema = trigger.inputs.headersSchema;
    // Preserve host.api info (contains runtimeUrl)
    if (trigger.inputs?.host?.api) legacyInfo.hostApi = trigger.inputs.host.api;

    const params = {
      ...(trigger.inputs?.parameters || {}),
      __legacyApiConnection: legacyInfo
    };

    const node: TriggerNode = {
      id: nextId('trg'),
      type: 'trigger',
      kind: 'connector',
      name,
      inputs: {
        connector: connectorName,
        operation: operationId,
        params,
      },
    };

    // Store legacy connection info (also set directly for non-DSL paths)
    (node.inputs as any).connectionReferenceName = connRefName;
    (node.inputs as any).legacyApiConnection = params.__legacyApiConnection;

    if (trigger.splitOn) {
      (node.inputs as any).splitOn = trigger.splitOn;
    }
    if (trigger.inputs?.authentication && !isDefaultConnectorAuthentication(trigger.inputs.authentication)) {
      (node.inputs as any).authentication = trigger.inputs.authentication;
    }

    if (trigger.description) node.description = trigger.description;
    if (trigger.conditions !== undefined) node.conditions = trigger.conditions;
    if (trigger.correlation !== undefined) node.correlation = trigger.correlation;
    if (trigger.runtimeConfiguration) node.runtimeConfiguration = trigger.runtimeConfiguration;
    if (trigger.metadata) node.metadata = filterMetadata(trigger.metadata);
    return node;
  }

  // HTTP request trigger
  if (tType === 'request' || tKind === 'http') {
    const node: TriggerNode = {
      id: nextId('trg'),
      type: 'trigger',
      kind: 'http',
      name,
      inputs: {},
    };
    // Preserve `method` only when source had it explicitly. Logic Apps treats
    // POST as the default for Request triggers and emits no `method` field for it,
    // so byte-exact parity requires distinguishing source-omitted from source-explicit.
    if (trigger.inputs?.method !== undefined) {
      (node.inputs as any).method = trigger.inputs.method;
    }
    if (trigger.inputs?.schema) {
      (node.inputs as any).schema = trigger.inputs.schema;
    }
    if (trigger.inputs?.headersSchema) {
      (node.inputs as any).headersSchema = trigger.inputs.headersSchema;
    }
    // Preserve triggerAuthenticationType for HTTP triggers
    if (trigger.inputs?.triggerAuthenticationType) {
      (node.inputs as any).triggerAuthenticationType = trigger.inputs.triggerAuthenticationType;
    }
    // Preserve VirtualAgent kind for Power Virtual Agents flows
    if (tKind === 'virtualagent') {
      (node.inputs as any).triggerKind = 'VirtualAgent';
    }
    // Preserve PowerApp kind for Power Apps flows
    if (tKind === 'powerapp') {
      (node.inputs as any).triggerKind = 'PowerApp';
    }
    if (trigger.description) node.description = trigger.description;
    if (trigger.conditions !== undefined) node.conditions = trigger.conditions;
    if (trigger.correlation !== undefined) node.correlation = trigger.correlation;
    if (trigger.runtimeConfiguration) node.runtimeConfiguration = trigger.runtimeConfiguration;
    if (trigger.metadata) node.metadata = filterMetadata(trigger.metadata);
    return node;
  }

  // Connector trigger (OpenApiConnection, etc.)
  if (tType === 'openapiconnection' || tType === 'openapiconnectionnotification' ||
      tType === 'apiconnection' || tType === 'openapiconnectionwebhook' ||
      tType === 'apiconnectionnotification') {

    // Check for modern format (host.apiId) vs legacy format (host.connection.name)
    const hasModernFormat = !!trigger.inputs?.host?.apiId;
    const hasLegacyFormat = !!trigger.inputs?.host?.connection?.name;

    if (hasModernFormat) {
      // Modern OpenApiConnection format
      const apiId = trigger.inputs?.host?.apiId || '';
      const operationId = trigger.inputs?.host?.operationId || trigger.inputs?.operationId || '';
      const params = trigger.inputs?.parameters || {};
      const connectorName = getConnectorName(apiId);

      const node: TriggerNode = {
        id: nextId('trg'),
        type: 'trigger',
        kind: 'connector',
        name,
        inputs: {
          connector: connectorName,
          operation: operationId,
          params,
        },
      };

      if (trigger.inputs?.host?.connectionName) {
        (node.inputs as any).connectionReferenceName = trigger.inputs.host.connectionName;
      }
      if (trigger.splitOn) {
        (node.inputs as any).splitOn = trigger.splitOn;
      }
      if (trigger.recurrence) {
        (node.inputs as any).recurrence = trigger.recurrence;
      }
      // Preserve original trigger type
      (node.inputs as any).triggerType = trigger.type;
      // Preserve authentication only when it differs from the emitter-injected default
      if (trigger.inputs?.authentication && !isDefaultConnectorAuthentication(trigger.inputs.authentication)) {
        (node.inputs as any).authentication = trigger.inputs.authentication;
      }
      // Preserve retryPolicy if present (from inputs)
      if (trigger.inputs?.retryPolicy) {
        (node.inputs as any).retryPolicy = trigger.inputs.retryPolicy;
      }

      if (trigger.description) node.description = trigger.description;
      if (trigger.conditions !== undefined) node.conditions = trigger.conditions;
      if (trigger.correlation !== undefined) node.correlation = trigger.correlation;
      if (trigger.runtimeConfiguration) node.runtimeConfiguration = trigger.runtimeConfiguration;
      if (trigger.metadata) node.metadata = filterMetadata(trigger.metadata);
      return node;
    } else if (hasLegacyFormat) {
      // Legacy ApiConnection trigger with host.connection.name, method, path
      const connExpr = trigger.inputs.host.connection.name;
      let connRefName = 'unknown';

      // Extract connection reference name from expression
      // Pattern 1: ['$connections']['shared_xxx']['connectionId']
      const match1 = connExpr.match(/\['\$connections'\]\['([^']+)'\]/);
      // Pattern 2: $connections.shared_xxx.connectionId
      const match2 = connExpr.match(/\$connections\.([a-zA-Z0-9_-]+)\./);
      // Pattern 3: @parameters('$connections')['shared_xxx']['connectionId']
      const match3 = connExpr.match(/\['([^']+)'\]\['connectionId'\]/);
      if (match1) {
        connRefName = match1[1];
      } else if (match2) {
        connRefName = match2[1];
      } else if (match3) {
        connRefName = match3[1];
      }

      // Extract connector name from reference (e.g., 'shared_sharepointonline' -> 'sharepointonline')
      const connectorName = connRefName
        .replace(/^shared_/, '')
        .replace(/_\d+$/, '')
        .replace(/-\d+$/, '');

      // Get operationId from metadata.flowSystemMetadata.swaggerOperationId.
      // Power Automate drops the metadata when flows are re-imported, so we also try to
      // infer the operation ID from a recognized URL shape before giving up.
      const operationId = trigger.metadata?.flowSystemMetadata?.swaggerOperationId ||
                         trigger.inputs?.operationId ||
                         inferLegacyOperationId(trigger.inputs?.path, trigger.inputs?.method) ||
                         '';

      // Store legacy info in params so it survives DSL roundtrip
      const legacyInfo: Record<string, any> = {
        connectionExpression: connExpr,
      };
      if (trigger.inputs?.method) legacyInfo.method = trigger.inputs.method;
      if (trigger.inputs?.path) legacyInfo.path = trigger.inputs.path;
      // For ApiConnectionNotification triggers, preserve fetch and subscribe
      if (trigger.inputs?.fetch) legacyInfo.fetch = trigger.inputs.fetch;
      if (trigger.inputs?.subscribe) legacyInfo.subscribe = trigger.inputs.subscribe;
      // Preserve host.api (contains runtimeUrl)
      if (trigger.inputs?.host?.api) legacyInfo.hostApi = trigger.inputs.host.api;

      const params: Record<string, any> = {
        __legacyApiConnection: legacyInfo
      };

      const node: TriggerNode = {
        id: nextId('trg'),
        type: 'trigger',
        kind: 'connector',
        name,
        inputs: {
          connector: connectorName,
          operation: operationId,
          params,
        },
      };

      (node.inputs as any).connectionReferenceName = connRefName;
      (node.inputs as any).legacyApiConnection = params.__legacyApiConnection;

      if (trigger.splitOn) {
        (node.inputs as any).splitOn = trigger.splitOn;
      }
      if (trigger.recurrence) {
        (node.inputs as any).recurrence = trigger.recurrence;
      }
      // Preserve original trigger type
      (node.inputs as any).triggerType = trigger.type;
      // Preserve authentication only when it differs from the emitter-injected default
      if (trigger.inputs?.authentication && !isDefaultConnectorAuthentication(trigger.inputs.authentication)) {
        (node.inputs as any).authentication = trigger.inputs.authentication;
      }
      // Preserve retryPolicy if present (from inputs)
      if (trigger.inputs?.retryPolicy) {
        (node.inputs as any).retryPolicy = trigger.inputs.retryPolicy;
      }

      if (trigger.description) node.description = trigger.description;
      if (trigger.conditions !== undefined) node.conditions = trigger.conditions;
      if (trigger.correlation !== undefined) node.correlation = trigger.correlation;
      if (trigger.runtimeConfiguration) node.runtimeConfiguration = trigger.runtimeConfiguration;
      if (trigger.metadata) node.metadata = filterMetadata(trigger.metadata);
      return node;
    }
  }

  // Default to HTTP trigger
  return {
    id: nextId('trg'),
    type: 'trigger',
    kind: 'http',
    name,
    inputs: { method: 'POST' },
  };
}

/**
 * Parse actions recursively from Logic Apps JSON
 */
function parseActions(actionsObj: Record<string, any>): Node[] {
  const nodes: Node[] = [];
  const ordered = orderActions(actionsObj);

  for (const actionName of ordered) {
    const action = actionsObj[actionName];
    const node = parseAction(actionName, action);
    if (node) {
      nodes.push(node);
    }
  }

  return nodes;
}

/**
 * Parse a single action from Logic Apps JSON
 */
function parseAction(name: string, action: any): Node | null {
  const t = String(action?.type || '').toLowerCase();
  const runAfter = normalizeRunAfter(action?.runAfter);

  switch (t) {
    case 'http': {
      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: 'http',
        name,
        inputs: {
          method: action.inputs?.method || 'GET',
          url: action.inputs?.uri || action.inputs?.url || '',
        },
      };
      if (action.inputs?.headers) {
        (node.inputs as any).headers = action.inputs.headers;
      }
      if (action.inputs?.queries) {
        (node.inputs as any).queries = action.inputs.queries;
      }
      if (action.inputs?.body !== undefined) {
        (node.inputs as any).body = action.inputs.body;
      }
      if (action.inputs?.cookie !== undefined) {
        (node.inputs as any).cookie = action.inputs.cookie;
      }
      // Preserve authentication if present (OAuth, API Key, etc.)
      if (action.inputs?.authentication) {
        (node.inputs as any).authentication = action.inputs.authentication;
      }
      if (runAfter) node.runAfter = runAfter;
      // HTTP actions store retryPolicy inside inputs (Logic Apps convention)
      if (action.inputs?.retryPolicy) node.retryPolicy = action.inputs.retryPolicy;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      if (action.operationOptions) (node as any).operationOptions = action.operationOptions;
      return node;
    }

    case 'compose': {
      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: 'compose',
        name,
        inputs: {
          value: action.inputs,
        },
      };
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'expression': {
      // Expression actions have a kind (e.g., IndexOf, Add, Subtract)
      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: 'expression',
        name,
        inputs: {
          expressionKind: action.kind || 'Unknown',
          ...action.inputs,
        },
      };
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'initializevariable': {
      const varData = action.inputs?.variables?.[0];
      if (!varData) return null;

      // Build inputs, only including value if it's defined
      const inputs: any = {
        variableName: varData.name,
        variableType: varData.type,
      };
      if (varData.value !== undefined) {
        inputs.value = varData.value;
      }

      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: 'initializevariable',
        name,
        inputs,
      };
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'setvariable': {
      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: 'setvariable',
        name,
        inputs: {
          name: action.inputs?.name,
          value: action.inputs?.value,
        },
      };
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'incrementvariable': {
      // Only include value if explicitly specified (default is 1 in Logic Apps)
      const inputs: any = { name: action.inputs?.name };
      if (action.inputs?.value !== undefined) {
        inputs.value = action.inputs.value;
      }
      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: 'incrementvariable',
        name,
        inputs,
      };
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'decrementvariable': {
      // Only include value if explicitly specified (default is 1 in Logic Apps)
      const inputs: any = { name: action.inputs?.name };
      if (action.inputs?.value !== undefined) {
        inputs.value = action.inputs.value;
      }
      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: 'decrementvariable',
        name,
        inputs,
      };
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'appendtoarrayvariable': {
      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: 'appendtoarrayvariable',
        name,
        inputs: {
          name: action.inputs?.name,
          value: action.inputs?.value,
        },
      };
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'appendtostringvariable': {
      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: 'appendtostringvariable',
        name,
        inputs: {
          name: action.inputs?.name,
          value: action.inputs?.value,
        },
      };
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'join': {
      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: 'join',
        name,
        inputs: {
          from: action.inputs?.from,
          joinWith: action.inputs?.joinWith,
        },
      };
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'select': {
      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: 'select',
        name,
        inputs: {
          from: action.inputs?.from,
          select: action.inputs?.select,
        },
      };
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'query': {
      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: 'filterarray',
        name,
        inputs: {
          from: action.inputs?.from,
          where: action.inputs?.where,
        },
      };
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'parsejson': {
      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: 'parsejson',
        name,
        inputs: {
          from: action.inputs?.content,
          schema: action.inputs?.schema,
        },
      };
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'response': {
      const aKind = (action.kind || '').toLowerCase();
      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: 'response',
        name,
        inputs: {
          statusCode: action.inputs?.statusCode,
          headers: action.inputs?.headers,
          body: action.inputs?.body,
        },
      };
      // Preserve kind for various response types
      if (aKind === 'virtualagent') {
        (node.inputs as any).kind = 'VirtualAgent';
      } else if (aKind === 'powerapp') {
        (node.inputs as any).kind = 'PowerApp';
      } else if (aKind === 'http' || action.kind) {
        // Preserve any other kind value
        (node.inputs as any).kind = action.kind;
      }
      // Preserve schema for Power Apps and Power Virtual Agents responses
      if (action.inputs?.schema) {
        (node.inputs as any).schema = action.inputs.schema;
      }
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      if (action.operationOptions) (node as any).operationOptions = action.operationOptions;
      return node;
    }

    case 'terminate': {
      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: 'terminate',
        name,
        inputs: {
          runStatus: action.inputs?.runStatus || 'Succeeded',
          runError: action.inputs?.runError,
        },
      };
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'wait': {
      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: action.inputs?.until ? 'delayuntil' : 'delay',
        name,
        inputs: action.inputs?.until
          ? { until: action.inputs.until }
          : { interval: action.inputs?.interval },
      };
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'workflow': {
      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: 'workflow',
        name,
        inputs: {
          workflowReferenceName: action.inputs?.host?.workflowReferenceName,
          workflowId: action.inputs?.host?.workflow?.id,
          body: action.inputs?.body,
          headers: action.inputs?.headers,
        },
      };
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      // Workflow actions have retryPolicy inside inputs
      if (action.inputs?.retryPolicy) node.retryPolicy = action.inputs.retryPolicy;
      // Preserve limit (timeout) if present
      if (action.limit) node.limit = action.limit;
      return node;
    }

    case 'scope': {
      const node: ScopeNode = {
        id: nextId('scp'),
        type: 'scope',
        name,
        actions: parseActions(action.actions || {}),
      };
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'if': {
      const condition = action.expression
        ? conditionToExpression(action.expression)
        : '@true';
      // Detect original condition format for parity preservation.
      // Top-level `and`/`or` is the emitter's default output shape, so we
      // intentionally leave conditionFormat unset for those — the DSL stays
      // annotation-free and the emitter's default re-produces the same shape.
      // Other object shapes (bare comparisons, `not`, etc.) need 'object' so
      // the emitter preserves them without adding the `and: [...]` wrapper.
      const isTopLevelAndOr =
        action.expression && typeof action.expression === 'object' &&
        ('and' in action.expression || 'or' in action.expression);
      const conditionFormat: 'string' | 'object' | undefined =
        action.expression && typeof action.expression === 'string' ? 'string' :
        action.expression && typeof action.expression === 'object' && !isTopLevelAndOr ? 'object' :
        undefined;

      const node: IfNode = {
        id: nextId('if'),
        type: 'if',
        name,
        condition,
        actions: parseActions(action.actions || {}),
      };
      if (conditionFormat) node.conditionFormat = conditionFormat;
      // Preserve else block even if empty - this is important for parity
      if (action.else?.actions !== undefined) {
        node.elseActions = parseActions(action.else.actions);
      }
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'foreach': {
      // Handle both string expressions and literal arrays
      let itemsExpression: string = '';
      if (typeof action.foreach === 'string') {
        itemsExpression = action.foreach;
      } else if (Array.isArray(action.foreach)) {
        // Convert literal array to JSON string representation
        itemsExpression = JSON.stringify(action.foreach);
      }

      const node: ForeachNode = {
        id: nextId('fe'),
        type: 'foreach',
        name,
        itemsExpression,
        actions: parseActions(action.actions || {}),
      };
      // Preserve source casing of the type field (e.g. "foreach" vs "Foreach") for parity.
      // Logic Apps accepts both; the PA UI typically emits "Foreach" but some sources have "foreach".
      if (typeof action.type === 'string' && action.type !== 'Foreach') {
        (node as any).typeCase = action.type;
      }
      if (action.runtimeConfiguration?.concurrency?.repetitions > 1) {
        node.parallel = true;
      }
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'switch': {
      const node: SwitchNode = {
        id: nextId('sw'),
        type: 'switch',
        name,
        expression: action.expression || '',
        cases: [],
      };

      // Parse cases
      if (action.cases) {
        for (const [caseName, caseData] of Object.entries(action.cases as Record<string, any>)) {
          node.cases.push({
            name: caseName,
            value: caseData.case,
            actions: parseActions(caseData.actions || {}),
          });
        }
      }

      // Parse default case - preserve empty default for parity
      if (action.default !== undefined) {
        node.defaultActions = action.default.actions ? parseActions(action.default.actions) : [];
      }

      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'until': {
      const node: DoUntilNode = {
        id: nextId('du'),
        type: 'dountil',
        name,
        condition: action.expression ? conditionToExpression(action.expression) : '@true',
        actions: parseActions(action.actions || {}),
      };
      if (action.limit?.count) node.limit = action.limit.count;
      if (action.limit?.timeout) node.timeout = action.limit.timeout;
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'openapiconnection':
    case 'apiconnection': {
      // Check for modern format (host.apiId) vs legacy format (host.connection.name)
      const hasModernFormat = !!action.inputs?.host?.apiId;
      const hasLegacyFormat = !!action.inputs?.host?.connection?.name;

      if (hasModernFormat) {
        // Modern format: OpenApiConnection or modern ApiConnection
        const apiId = action.inputs?.host?.apiId || '';
        const operationId = action.inputs?.host?.operationId || '';
        const hasParams = !!action.inputs && Object.prototype.hasOwnProperty.call(action.inputs, 'parameters');
        const params = hasParams ? action.inputs.parameters : {};
        const connectorName = getConnectorName(apiId);

        const node: ConnectorActionNode = {
          id: nextId('con'),
          type: 'connector',
          name,
          connector: connectorName,
          operation: mapOperationId(operationId, connectorName),
          params,
        };
        if (!hasParams) node.paramsOmitted = true;

        if (action.inputs?.host?.connectionName) {
          node.connectionReferenceName = action.inputs.host.connectionName;
        }
        // Preserve authentication only when it differs from the emitter-injected default
        if (action.inputs?.authentication && !isDefaultConnectorAuthentication(action.inputs.authentication)) {
          (node as any).authentication = action.inputs.authentication;
        }
        // Preserve retryPolicy if present (from inputs)
        if (action.inputs?.retryPolicy) {
          node.retryPolicy = action.inputs.retryPolicy;
        }
        // Preserve limit (timeout) if present
        if (action.limit) {
          node.limit = action.limit;
        }
        if (runAfter) node.runAfter = runAfter;
        if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
        if (action.metadata) node.metadata = filterMetadata(action.metadata);
        if (action.description) node.description = action.description;
        if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
        if (action.operationOptions) (node as any).operationOptions = action.operationOptions;
        return node;
      } else if (hasLegacyFormat) {
        // Legacy format: ApiConnection with host.connection.name
        // Extract connection reference name from expression like:
        // @json(decodeBase64(triggerOutputs().headers['X-MS-APIM-Tokens']))['$connections']['shared_office365_1']['connectionId']
        // or @parameters('$connections')['shared_commondataservice']['connectionId']
        const connExpr = action.inputs.host.connection.name;
        let connRefName = 'unknown';

        // Try to extract connection reference name from various expression patterns
        const match1 = connExpr.match(/\['\$connections'\]\['([^']+)'\]/);
        const match2 = connExpr.match(/\$connections\.([a-zA-Z0-9_-]+)\./);
        // Pattern 3: @parameters('$connections')['name']['connectionId'] - extract name before connectionId
        const match3 = connExpr.match(/\['([^']+)'\]\['connectionId'\]/);
        if (match1) {
          connRefName = match1[1];
        } else if (match2) {
          connRefName = match2[1];
        } else if (match3) {
          connRefName = match3[1];
        }

        // Extract connector name from reference (e.g., 'shared_office365_1' -> 'office365')
        const connectorName = connRefName
          .replace(/^shared_/, '')
          .replace(/_\d+$/, '')
          .replace(/-\d+$/, '');

        // Get operationId from metadata.flowSystemMetadata.swaggerOperationId or from path.
        // Power Automate drops the metadata when flows are re-imported, so we also try to
        // infer the operation ID from a recognized URL shape before the generic fallback.
        const operationId = action.metadata?.flowSystemMetadata?.swaggerOperationId ||
                           inferLegacyOperationId(action.inputs?.path, action.inputs?.method) ||
                           action.inputs?.path?.replace(/^\/v?\d*\/?/, '') || // e.g., "/v2/Mail" -> "Mail"
                           'unknown';

        // Store all legacy format info in params so it survives DSL roundtrip
        // The emitter will detect __legacyApiConnection and emit legacy format
        const params: Record<string, any> = {
          __legacyApiConnection: {
            connectionExpression: connExpr,
            method: action.inputs?.method,
            path: action.inputs?.path,
            body: action.inputs?.body,
            queries: action.inputs?.queries,
            headers: action.inputs?.headers,
            hostApi: action.inputs?.host?.api,
            inputsApi: action.inputs?.api, // Some flows have api at inputs level too
          }
        };

        const node: ConnectorActionNode = {
          id: nextId('con'),
          type: 'connector',
          name,
          connector: connectorName,
          operation: mapOperationId(operationId, connectorName),
          params,
        };

        node.connectionReferenceName = connRefName;

        // Also set legacyApiConnection for direct IR usage (will be lost in DSL roundtrip)
        (node as any).legacyApiConnection = params.__legacyApiConnection;

        // Preserve authentication only when it differs from the emitter-injected default
        if (action.inputs?.authentication && !isDefaultConnectorAuthentication(action.inputs.authentication)) {
          (node as any).authentication = action.inputs.authentication;
        }
        // Preserve retryPolicy if present
        if (action.inputs?.retryPolicy) {
          node.retryPolicy = action.inputs.retryPolicy;
        }
        // Preserve limit (timeout) if present
        if (action.limit) {
          node.limit = action.limit;
        }
        if (runAfter) node.runAfter = runAfter;
        if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
        if (action.metadata) node.metadata = filterMetadata(action.metadata);
        if (action.description) node.description = action.description;
        if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
        if (action.operationOptions) (node as any).operationOptions = action.operationOptions;
        return node;
      } else {
        // Neither format - create placeholder
        const node: ConnectorActionNode = {
          id: nextId('con'),
          type: 'connector',
          name,
          connector: 'unknown',
          operation: 'unknown',
          params: action.inputs?.parameters || {},
        };
        if (runAfter) node.runAfter = runAfter;
        if (action.metadata) node.metadata = filterMetadata(action.metadata);
        if (action.description) node.description = action.description;
        if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
        return node;
      }
    }

    case 'openapiconnectionwebhook': {
      const apiId = action.inputs?.host?.apiId || '';
      const operationId = action.inputs?.host?.operationId || '';
      const params = action.inputs?.parameters || {};
      const connectorName = getConnectorName(apiId);

      const node: ConnectorWebhookActionNode = {
        id: nextId('cwh'),
        type: 'connectorwebhook',
        name,
        connector: connectorName,
        operation: mapOperationId(operationId),
        params,
      };

      if (action.inputs?.host?.connectionName) {
        node.connectionReferenceName = action.inputs.host.connectionName;
      }
      // Preserve authentication only when it differs from the emitter-injected default
      if (action.inputs?.authentication && !isDefaultConnectorAuthentication(action.inputs.authentication)) {
        (node as any).authentication = action.inputs.authentication;
      }
      // Preserve retryPolicy if present (from inputs)
      if (action.inputs?.retryPolicy) {
        node.retryPolicy = action.inputs.retryPolicy;
      }
      // Preserve limit (timeout) if present
      if (action.limit) {
        node.limit = action.limit;
      }
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'apiconnectionwebhook': {
      // Legacy webhook format: ApiConnectionWebhook with host.connection.name (e.g., Approvals)
      // Similar to legacy ApiConnection but for webhook-based actions
      const connExpr = action.inputs?.host?.connection?.name || '';
      let connRefName = 'unknown';

      // Try to extract connection reference name from various expression patterns
      const match1 = connExpr.match(/\['\$connections'\]\['([^']+)'\]/);
      const match2 = connExpr.match(/\$connections\.([a-zA-Z0-9_-]+)\./);
      // Pattern 3: @parameters('$connections')['name']['connectionId'] - extract name before connectionId
      const match3 = connExpr.match(/\['([^']+)'\]\['connectionId'\]/);
      if (match1) {
        connRefName = match1[1];
      } else if (match2) {
        connRefName = match2[1];
      } else if (match3) {
        connRefName = match3[1];
      }

      // Extract connector name from reference (e.g., 'shared_approvals' -> 'approvals')
      const connectorName = connRefName
        .replace(/^shared_/, '')
        .replace(/_\d+$/, '')
        .replace(/-\d+$/, '');

      // Get operationId from metadata.flowSystemMetadata.swaggerOperationId.
      // Power Automate drops the metadata when flows are re-imported, so we also try to
      // infer the operation ID from a recognized URL shape before the generic fallback.
      const operationId = action.metadata?.flowSystemMetadata?.swaggerOperationId ||
                         inferLegacyOperationId(action.inputs?.path, action.inputs?.method) ||
                         action.inputs?.path?.replace(/^\/[^\/]+\//, '') || // e.g., "/types/.../subscriptions" -> "subscriptions"
                         'unknown';

      // Store all legacy format info in params so it survives DSL roundtrip
      // The emitter will detect __legacyApiConnectionWebhook and emit legacy format
      const params: Record<string, any> = {
        __legacyApiConnectionWebhook: {
          connectionExpression: connExpr,
          path: action.inputs?.path,
          body: action.inputs?.body,
          hostApi: action.inputs?.host?.api,
        }
      };

      const node: ConnectorWebhookActionNode = {
        id: nextId('cwh'),
        type: 'connectorwebhook',
        name,
        connector: connectorName,
        operation: mapOperationId(operationId),
        params,
      };

      node.connectionReferenceName = connRefName;

      // Also set legacyApiConnectionWebhook for direct IR usage
      (node as any).legacyApiConnectionWebhook = params.__legacyApiConnectionWebhook;

      // Preserve authentication only when it differs from the emitter-injected default
      if (action.inputs?.authentication && !isDefaultConnectorAuthentication(action.inputs.authentication)) {
        (node as any).authentication = action.inputs.authentication;
      }
      // Preserve retryPolicy if present
      if (action.inputs?.retryPolicy) {
        node.retryPolicy = action.inputs.retryPolicy;
      }
      // Preserve limit (timeout) if present
      if (action.limit) {
        node.limit = action.limit;
      }
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    case 'table': {
      // Create CSV or HTML table from array
      const format = (action.inputs?.format || 'CSV').toLowerCase();
      const kind = format === 'html' ? 'createhtmltable' : 'createcsvtable';
      const node: ActionNode = {
        id: nextId('act'),
        type: 'action',
        kind: kind as ActionNode['kind'],
        name,
        inputs: {
          from: action.inputs?.from,
        },
      };
      // Include columns if specified (custom column headers)
      if (action.inputs?.columns) {
        (node.inputs as any).columns = action.inputs.columns;
      }
      if (runAfter) node.runAfter = runAfter;
      if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
      if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
      return node;
    }

    default:
      // For unknown action types, try to treat as connector action
      if (action.inputs?.host?.apiId) {
        const apiId = action.inputs.host.apiId;
        const operationId = action.inputs.host.operationId || '';
        const params = action.inputs.parameters || {};
        const connectorName = getConnectorName(apiId);

        const node: ConnectorActionNode = {
          id: nextId('con'),
          type: 'connector',
          name,
          connector: connectorName,
          operation: mapOperationId(operationId, connectorName),
          params,
        };

        if (action.inputs.host.connectionName) {
          node.connectionReferenceName = action.inputs.host.connectionName;
        }
        // Preserve authentication only when it differs from the emitter-injected default
        if (action.inputs.authentication && !isDefaultConnectorAuthentication(action.inputs.authentication)) {
          (node as any).authentication = action.inputs.authentication;
        }
        // Preserve retryPolicy if present (from inputs)
        if (action.inputs.retryPolicy) {
          node.retryPolicy = action.inputs.retryPolicy;
        }
        // Preserve limit (timeout) if present
        if (action.limit) {
          node.limit = action.limit;
        }
        if (runAfter) node.runAfter = runAfter;
        if (action.runtimeConfiguration) node.runtimeConfiguration = action.runtimeConfiguration;
        if (action.metadata) node.metadata = filterMetadata(action.metadata);
      if (action.description) node.description = action.description;
      if (action.trackedProperties) node.trackedProperties = action.trackedProperties;
        return node;
      }

      console.warn(`Unknown action type: ${t} for action ${name}`);
      return null;
  }
}

/**
 * Extract connection references from Logic Apps JSON
 */
function extractConnectionReferences(input: any): Record<string, ConnectionReference> | undefined {
  const refs = input?.properties?.connectionReferences || input?.connectionReferences;
  if (!refs || Object.keys(refs).length === 0) return undefined;

  const result: Record<string, ConnectionReference> = {};
  for (const [refName, refData] of Object.entries(refs as Record<string, any>)) {
    // apiId can come from multiple sources:
    // 1. api.id - full path like '/providers/Microsoft.PowerApps/apis/shared_sharepointonline'
    // 2. apiId - same as above
    // 3. api.name - short name like 'shared_sharepointonline' (need to construct full path)
    let apiId = refData.api?.id || refData.apiId || '';
    if (!apiId && refData.api?.name) {
      // Construct the full apiId from the short api.name
      apiId = `/providers/Microsoft.PowerApps/apis/${refData.api.name}`;
    }

    result[refName] = {
      apiId,
      connectionReferenceLogicalName: refData.connection?.connectionReferenceLogicalName || refData.connectionReferenceLogicalName,
      connectionName: refData.connection?.name || refData.connectionName,
      runtimeSource: refData.runtimeSource,
      impersonation: refData.impersonation,
    };
  }
  return result;
}

/**
 * Extract parameters from Logic Apps definition
 * Preserves the original parameter structure and key ordering for parity
 */
function extractParameters(definition: any): Record<string, FlowParameter> | undefined {
  const params = definition?.$parameters || definition?.parameters;
  if (!params || Object.keys(params).length === 0) return undefined;

  // Preserve original parameters as-is for parity
  // Cast to Record<string, FlowParameter> since we're storing the raw data
  return params as Record<string, FlowParameter>;
}

/**
 * Extract metadata from Logic Apps JSON
 */
function extractMetadata(input: any, definition: any): FlowMetadata | undefined {
  const metadata: FlowMetadata = {};

  if (definition?.$schema) metadata.$schema = definition.$schema;
  if (definition?.contentVersion) metadata.contentVersion = definition.contentVersion;
  // schemaVersion can be at top level or inside properties
  if (input?.schemaVersion) metadata.schemaVersion = input.schemaVersion;
  else if (input?.properties?.schemaVersion) metadata.schemaVersion = input.properties.schemaVersion;

  if (Object.keys(metadata).length === 0) return undefined;
  return metadata;
}

export interface ParseOptions {
  flowName?: string;
  /** FlowForger configuration for controlling behavior */
  config?: FlowForgerConfig;
  /** Child flow definitions to attach to parsed IR (for name-based references) */
  childFlows?: Record<string, ChildFlowDefinition>;
}

/**
 * Parse Logic Apps JSON to FlowIR.
 * This is the canonical conversion from Logic Apps format to IR.
 */
export function parseLogicAppsToIR(input: any, options: ParseOptions = {}): FlowIR {
  // Set the module-level config for this parse run
  currentParserConfig = getParserConfig(options.config);

  const loggingConfig = getLoggingConfig(options.config);
  if (loggingConfig.verbose) {
    //console.error('[FlowForger] Converting: Logic Apps JSON → IR');
  }

  // Reset ID counter for consistent IDs
  resetParserIdCounter();

  // Handle both formats:
  // 1. { definition: { triggers, actions } } - old format
  // 2. { properties: { definition: { triggers, actions } } } - Dataverse format
  let definition = input;
  if (input?.properties?.definition) {
    definition = input.properties.definition;
  } else if (input?.definition?.triggers) {
    definition = input.definition;
  }

  if (!definition || typeof definition !== 'object' || !definition.triggers) {
    throw new Error('Invalid definition: expected an object with triggers/actions');
  }

  // Prefer displayName (human-readable) over name (GUID)
  const flowName = options.flowName || input.properties?.displayName || input.name || 'ParsedFlow';

  // Parse triggers
  const nodes: Node[] = [];
  const triggers = definition.triggers || {};
  for (const [triggerName, trigger] of Object.entries(triggers)) {
    const triggerNode = parseTrigger(triggerName, trigger);
    nodes.push(triggerNode);
  }

  // Parse actions
  const actions = definition.actions || {};
  const actionNodes = parseActions(actions);
  nodes.push(...actionNodes);

  // Build FlowIR
  const ir: FlowIR = {
    name: flowName,
    nodes,
  };

  // Add optional properties
  // Description at the flow level (inside definition)
  if (definition.description) {
    ir.description = definition.description;
  }

  const parameters = extractParameters(definition);
  if (parameters) ir.parameters = parameters;

  const connectionReferences = extractConnectionReferences(input);
  if (connectionReferences) ir.connectionReferences = connectionReferences;

  const metadata = extractMetadata(input, definition);
  if (metadata) ir.metadata = metadata;

  // Preserve workflow-level metadata (definition.metadata) verbatim. Fields here include
  // creator, flowclientsuspensionreason, provisioningMethod, etc. — heterogeneous and
  // not part of the schema-versioning FlowMetadata.
  if (definition.metadata && typeof definition.metadata === 'object') {
    ir.workflowMetadata = definition.metadata;
  }

  if (definition.outputs) ir.outputs = definition.outputs;

  if (definition.staticResults) ir.staticResults = definition.staticResults;

  if (options.childFlows) ir.childFlows = options.childFlows;

  return ir;
}
