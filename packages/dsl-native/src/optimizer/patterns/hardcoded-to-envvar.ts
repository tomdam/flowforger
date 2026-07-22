/**
 * Hardcoded Value to Environment Variable Optimization
 *
 * Detects hardcoded literal values in connector action parameters that should
 * be extracted to environment variables (parameters) for portability across
 * environments.
 *
 * Pattern:
 *   ctx.sharepoint.getItems("https://contoso.sharepoint.com/sites/HR", "abc-123-list-guid", ...)
 *
 * Suggests extraction to:
 *   ctx.parameters('cr_SP_SiteUrl_HR')  // with parameter definition in ir.parameters
 */

import type {
  FlowIR,
  Node,
  ConnectorActionNode,
  ConnectorWebhookActionNode,
} from '@flowforger/ir';
import { isConnector, isConnectorWebhook, isForeach, isIf, isScope, isSwitch, isDoUntil } from '@flowforger/ir';
import type {
  OptimizationReport,
  HardcodedValueSuggestion,
  HardcodedValueSelection,
} from '../report.js';

/**
 * Rule defining which connector parameters should be checked for hardcoded values.
 */
interface ConnectorParamRule {
  connector: string;
  paramNames: string[];
  description: string;
  schemaPrefix: string;
}

/**
 * Extensible rules table for connector parameters that commonly hold
 * environment-specific hardcoded values.
 */
const CONNECTOR_PARAM_RULES: ConnectorParamRule[] = [
  {
    connector: 'sharepoint',
    paramNames: ['dataset', 'siteId'],
    description: 'SharePoint Site URL',
    schemaPrefix: 'cr_SP_SiteUrl',
  },
  {
    connector: 'sharepoint',
    paramNames: ['table', 'listId'],
    description: 'SharePoint List ID',
    schemaPrefix: 'cr_SP_ListId',
  },
  {
    connector: 'dataverse',
    paramNames: ['organization'],
    description: 'Dataverse Organization URL',
    schemaPrefix: 'cr_DV_OrgUrl',
  },
  {
    connector: 'office365',
    paramNames: ['mailbox'],
    description: 'Shared Mailbox',
    schemaPrefix: 'cr_O365_Mailbox',
  },
  {
    connector: 'excelonline',
    paramNames: ['source', 'drive', 'file'],
    description: 'Excel File Location',
    schemaPrefix: 'cr_Excel_File',
  },
  {
    connector: 'excelonlinebusiness',
    paramNames: ['source', 'drive', 'file'],
    description: 'Excel File Location',
    schemaPrefix: 'cr_Excel_File',
  },
  {
    connector: 'wordonline',
    paramNames: ['source', 'drive', 'file'],
    description: 'Word File Location',
    schemaPrefix: 'cr_Word_File',
  },
  {
    connector: 'wordonlinebusiness',
    paramNames: ['source', 'drive', 'file'],
    description: 'Word File Location',
    schemaPrefix: 'cr_Word_File',
  },
];

/**
 * Detects hardcoded literal values in connector action parameters.
 * Groups identical values into one suggestion with multiple usages.
 */
export function detectHardcodedValues(ir: FlowIR, report: OptimizationReport): void {
  // Collect existing parameter expressions so we skip already-parameterized values
  const existingParamExpressions = new Set<string>();
  if (ir.parameters) {
    for (const paramName of Object.keys(ir.parameters)) {
      existingParamExpressions.add(`@parameters('${paramName}')`);
    }
  }

  // Map: grouping key -> suggestion being built
  const suggestionMap = new Map<string, HardcodedValueSuggestion>();

  // Walk all nodes (including nested), tracking the path for context
  walkNodes(ir.nodes, [], existingParamExpressions, suggestionMap);

  // Add results to report
  for (const suggestion of suggestionMap.values()) {
    report.hardcodedValues.push(suggestion);
  }
}

/**
 * Recursively walks nodes to find connector actions with hardcoded params.
 * Tracks the path of parent node names for context (e.g., ['Switch_Type', 'Case_IHK']).
 */
function walkNodes(
  nodes: Node[],
  path: string[],
  existingParamExpressions: Set<string>,
  suggestionMap: Map<string, HardcodedValueSuggestion>
): void {
  for (const node of nodes) {
    if (isConnector(node) || isConnectorWebhook(node)) {
      checkConnectorNode(node, path, existingParamExpressions, suggestionMap);
    }

    // Recurse into child nodes with updated path
    const childPath = [...path, node.name];
    for (const children of getChildNodes(node)) {
      walkNodes(children, childPath, existingParamExpressions, suggestionMap);
    }
  }
}

/**
 * Checks a connector node's params against the rules table.
 */
function checkConnectorNode(
  node: ConnectorActionNode | ConnectorWebhookActionNode,
  path: string[],
  existingParamExpressions: Set<string>,
  suggestionMap: Map<string, HardcodedValueSuggestion>
): void {
  const connector = node.connector;

  for (const rule of CONNECTOR_PARAM_RULES) {
    if (rule.connector !== connector) continue;

    for (const paramName of rule.paramNames) {
      const value = node.params[paramName];

      // Only flag string literals that are not expressions and not already parameterized
      if (typeof value !== 'string') continue;
      if (value.startsWith('@')) continue;
      if (existingParamExpressions.has(value)) continue;

      // Build grouping key: same connector + description + value = one env var
      const groupKey = `${connector}:${rule.schemaPrefix}:${value}`;

      if (!suggestionMap.has(groupKey)) {
        const suffix = deriveSuffix(value, rule);
        const schemaName = suffix ? `${rule.schemaPrefix}_${suffix}` : rule.schemaPrefix;
        const displayName = suffix ? `${rule.description} - ${suffix}` : rule.description;

        suggestionMap.set(groupKey, {
          key: groupKey,
          value,
          connector,
          paramName,
          description: rule.description,
          suggestedSchemaName: schemaName,
          suggestedDisplayName: displayName,
          paramType: 'String',
          usages: [],
        });
      }

      suggestionMap.get(groupKey)!.usages.push({
        nodeId: node.id,
        nodeName: node.name,
        paramName,
        path: [...path],
      });
    }
  }
}

/**
 * Derives a human-readable suffix from the hardcoded value for naming.
 * E.g., "https://contoso.sharepoint.com/sites/HR" -> "HR"
 *       "abc-123-def" (GUID-like) -> "1" (sequential fallback)
 */
function deriveSuffix(value: string, rule: ConnectorParamRule): string {
  // For site URLs, extract the site name from the path
  if (rule.schemaPrefix.includes('SiteUrl')) {
    try {
      const url = new URL(value);
      const parts = url.pathname.split('/').filter(Boolean);
      // Look for /sites/NAME or /teams/NAME pattern
      const sitesIndex = parts.findIndex(p => p.toLowerCase() === 'sites' || p.toLowerCase() === 'teams');
      if (sitesIndex >= 0 && parts[sitesIndex + 1]) {
        return sanitizeName(parts[sitesIndex + 1]);
      }
      // Fallback: use last path segment
      if (parts.length > 0) {
        return sanitizeName(parts[parts.length - 1]);
      }
    } catch {
      // Not a valid URL, fall through
    }
  }

  // For org URLs (Dataverse), extract org name
  if (rule.schemaPrefix.includes('OrgUrl')) {
    try {
      const url = new URL(value);
      const hostname = url.hostname.split('.')[0];
      if (hostname) {
        return sanitizeName(hostname);
      }
    } catch {
      // Not a valid URL
    }
  }

  // For mailbox, use the part before @
  if (rule.schemaPrefix.includes('Mailbox') && value.includes('@')) {
    return sanitizeName(value.split('@')[0]);
  }

  // Default: no suffix (will use just the prefix)
  return '';
}

/**
 * Sanitizes a string for use in a schema name (alphanumeric + underscore).
 */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Gets all child node arrays from a control flow node.
 * (Same pattern as single-set-to-compose.ts)
 */
function getChildNodes(node: Node): Node[][] {
  if (isForeach(node)) return [node.actions];
  if (isIf(node)) {
    const result = [node.actions];
    if (node.elseActions) result.push(node.elseActions);
    return result;
  }
  if (isScope(node)) return [node.actions];
  if (isSwitch(node)) {
    const result = node.cases.map(c => c.actions);
    if (node.defaultActions) result.push(node.defaultActions);
    return result;
  }
  if (isDoUntil(node)) return [node.actions];
  return [];
}

/**
 * Applies hardcoded value extractions to the IR.
 *
 * For each selection:
 * 1. Adds a parameter definition to ir.parameters with metadata.schemaName
 * 2. Replaces the literal value with @parameters('displayName') in all usages
 */
export function applyHardcodedValueExtractions(
  ir: FlowIR,
  selections: HardcodedValueSelection[]
): FlowIR {
  if (selections.length === 0) return ir;

  // Deep clone to avoid mutating the original
  const result = JSON.parse(JSON.stringify(ir)) as FlowIR;

  // Initialize parameters if not present
  if (!result.parameters) {
    result.parameters = {};
  }

  // Build a replacement map: for each usage (nodeId + paramName) -> expression
  const replacements = new Map<string, { paramExpression: string; value: string }>();

  for (const selection of selections) {
    const paramDisplayName = selection.displayName;

    // Add parameter definition
    result.parameters[paramDisplayName] = {
      type: 'String',
      defaultValue: selection.value,
      metadata: {
        schemaName: selection.schemaName,
        displayName: paramDisplayName,
        description: selection.description || `Environment variable for ${selection.connector} ${selection.paramName}`,
      },
    };

    const paramExpression = `@parameters('${paramDisplayName}')`;

    // Register replacements for all usages
    for (const usage of selection.usages) {
      const usageKey = `${usage.nodeId}:${usage.paramName}`;
      replacements.set(usageKey, { paramExpression, value: selection.value });
    }
  }

  // Apply replacements to all connector nodes
  applyReplacementsToNodes(result.nodes, replacements);

  return result;
}

/**
 * Recursively walks nodes and applies parameter replacements to connector params.
 */
function applyReplacementsToNodes(
  nodes: Node[],
  replacements: Map<string, { paramExpression: string; value: string }>
): void {
  for (const node of nodes) {
    if (isConnector(node) || isConnectorWebhook(node)) {
      for (const [paramName, paramValue] of Object.entries(node.params)) {
        const usageKey = `${node.id}:${paramName}`;
        const replacement = replacements.get(usageKey);
        if (replacement && paramValue === replacement.value) {
          node.params[paramName] = replacement.paramExpression;
        }
      }
    }

    // Recurse into children
    for (const children of getChildNodes(node)) {
      applyReplacementsToNodes(children, replacements);
    }
  }
}
