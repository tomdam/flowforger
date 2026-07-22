/**
 * Direct Connection to Connection Reference Optimization
 *
 * Detects connection references that use direct/embedded connections (connectionName)
 * instead of solution-aware connection references (connectionReferenceLogicalName).
 * Suggests converting them for better portability across environments.
 *
 * Pattern:
 *   connectionReferences: {
 *     "shared_sharepointonline": {
 *       apiId: "/providers/Microsoft.PowerApps/apis/shared_sharepointonline",
 *       connectionName: "b41731b4a9fe4561bc46c535ac774076"  // direct connection
 *     }
 *   }
 *
 * Suggests conversion to:
 *   connectionReferences: {
 *     "shared_sharepointonline": {
 *       apiId: "/providers/Microsoft.PowerApps/apis/shared_sharepointonline",
 *       connectionReferenceLogicalName: "cr_shared_sharepointonline"  // solution-aware
 *     }
 *   }
 */

import type {
  FlowIR,
  Node,
  ConnectorActionNode,
  ConnectorWebhookActionNode,
  TriggerNode,
  ConnectionReference,
} from '@flowforger/ir';
import { isConnector, isConnectorWebhook, isTrigger, isForeach, isIf, isScope, isSwitch, isDoUntil } from '@flowforger/ir';
import type {
  OptimizationReport,
  ConnectionRefSuggestion,
  ConnectionRefSelection,
} from '../report.js';

/**
 * Known API ID patterns mapped to human-readable display names.
 */
const API_DISPLAY_NAMES: Record<string, string> = {
  shared_sharepointonline: 'SharePoint Online',
  shared_commondataservice: 'Dataverse',
  shared_commondataserviceforapps: 'Dataverse',
  shared_office365: 'Office 365 Outlook',
  shared_office365users: 'Office 365 Users',
  shared_office365groups: 'Office 365 Groups',
  shared_teams: 'Microsoft Teams',
  shared_approvals: 'Approvals',
  shared_flowmanagement: 'Power Automate Management',
  shared_onedriveforbusiness: 'OneDrive for Business',
  shared_excelonlinebusiness: 'Excel Online (Business)',
  shared_wordonlinebusiness: 'Word Online (Business)',
  shared_planner: 'Planner',
  shared_todo: 'Microsoft To Do',
  shared_sendmail: 'Mail',
  shared_keyvault: 'Azure Key Vault',
  shared_sql: 'SQL Server',
  shared_azureblob: 'Azure Blob Storage',
  shared_servicebus: 'Azure Service Bus',
  shared_dynamicscrmonline: 'Dynamics 365',
  shared_cognitiveservicestextanalytics: 'Text Analytics',
  shared_openaiazure: 'Azure OpenAI',
};

/**
 * Derives a human-readable connector display name from an API identifier.
 * E.g., '/providers/Microsoft.PowerApps/apis/shared_sharepointonline' -> 'SharePoint Online'
 */
function deriveDisplayName(apiId: string): string {
  // Extract the connector slug from the apiId path
  const parts = apiId.split('/');
  const slug = parts[parts.length - 1]; // e.g., 'shared_sharepointonline'

  if (slug && API_DISPLAY_NAMES[slug]) {
    return API_DISPLAY_NAMES[slug];
  }

  // Fallback: humanize the slug
  if (slug) {
    return slug
      .replace(/^shared_/, '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return apiId;
}

/**
 * Detects connection references using direct connections (connectionName)
 * instead of solution-aware connection references (connectionReferenceLogicalName).
 */
export function detectDirectConnections(ir: FlowIR, report: OptimizationReport): void {
  if (!ir.connectionReferences) return;

  for (const [refName, ref] of Object.entries(ir.connectionReferences)) {
    // Only flag entries that have connectionName but no connectionReferenceLogicalName
    if (!ref.connectionName || ref.connectionReferenceLogicalName) continue;

    const usages: Array<{ nodeId: string; nodeName: string; path: string[] }> = [];
    collectUsages(ir.nodes, refName, [], usages);

    const suggestion: ConnectionRefSuggestion = {
      referenceName: refName,
      connectionName: ref.connectionName,
      apiId: ref.apiId,
      connectorDisplayName: deriveDisplayName(ref.apiId),
      usages,
    };

    report.connectionSuggestions.push(suggestion);
  }
}

/**
 * Recursively walks nodes to find actions/triggers that reference the given connection reference name.
 */
function collectUsages(
  nodes: Node[],
  referenceName: string,
  path: string[],
  usages: Array<{ nodeId: string; nodeName: string; path: string[] }>
): void {
  for (const node of nodes) {
    // Check connector actions
    if (isConnector(node) || isConnectorWebhook(node)) {
      if (getConnectionReferenceName(node) === referenceName) {
        usages.push({ nodeId: node.id, nodeName: node.name, path: [...path] });
      }
    }

    // Check connector triggers
    if (isTrigger(node) && node.kind === 'connector') {
      const inputs = node.inputs as { connectionReferenceName?: string };
      if (inputs.connectionReferenceName === referenceName) {
        usages.push({ nodeId: node.id, nodeName: node.name, path: [...path] });
      }
    }

    // Recurse into child nodes
    const childPath = [...path, node.name];
    for (const children of getChildNodes(node)) {
      collectUsages(children, referenceName, childPath, usages);
    }
  }
}

/**
 * Gets the connectionReferenceName from a connector action node.
 */
function getConnectionReferenceName(node: ConnectorActionNode | ConnectorWebhookActionNode): string | undefined {
  return node.connectionReferenceName;
}

/**
 * Gets all child node arrays from a control flow node.
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
 * Applies connection reference conversions to the IR.
 *
 * For each selection:
 * 1. Sets connectionReferenceLogicalName on the connection reference
 * 2. Removes connectionName (no longer needed for solution-aware flows)
 */
export function applyConnectionRefConversions(
  ir: FlowIR,
  selections: ConnectionRefSelection[]
): FlowIR {
  if (selections.length === 0) return ir;

  // Deep clone to avoid mutating the original
  const result = JSON.parse(JSON.stringify(ir)) as FlowIR;

  if (!result.connectionReferences) return result;

  for (const selection of selections) {
    const ref = result.connectionReferences[selection.referenceName];
    if (!ref) continue;

    ref.connectionReferenceLogicalName = selection.connectionReferenceLogicalName;
    delete ref.connectionName;
  }

  return result;
}
