/**
 * @flowforger/dsl-native - Optimizer Report Types
 *
 * Types and utilities for tracking and reporting DSL optimizations.
 */

/**
 * Types of optimizations that can be applied.
 */
export type OptimizationType =
  | 'single_set_variable_to_compose'
  | 'loop_variable_to_compose'
  | 'append_to_select'
  | 'parallelism_warning'
  | 'hardcoded_to_envvar'
  | 'connection_to_connref';

/**
 * A single optimization change applied to the flow.
 */
export interface OptimizationChange {
  /** Type of optimization applied */
  type: OptimizationType;
  /** Name of the original action that was transformed */
  originalAction: string;
  /** Name of the new action (if replaced with a different action) */
  newAction?: string;
  /** Path to the action location (e.g., ['ForEach_Items', 'Process']) */
  location: string[];
  /** Human-readable description of the change */
  description: string;
}

/**
 * A warning about potential performance issues (no auto-fix).
 */
export interface OptimizationWarning {
  /** Type of warning */
  type: OptimizationType;
  /** Path to the location of the issue */
  location: string[];
  /** Warning message */
  message: string;
  /** Suggested fix or improvement */
  suggestion: string;
  /** Variables involved in the issue */
  affectedVariables?: string[];
}

/**
 * Summary statistics of optimizations applied.
 */
export interface OptimizationSummary {
  /** Total number of changes applied */
  totalChanges: number;
  /** Total number of warnings emitted */
  totalWarnings: number;
  /** Count of each optimization type */
  byType: Partial<Record<OptimizationType, number>>;
}

/**
 * A hardcoded value detected in a connector action that could be extracted
 * to an environment variable (parameter).
 */
export interface HardcodedValueSuggestion {
  /** Grouping key (connector:paramType:value) */
  key: string;
  /** The hardcoded literal value */
  value: string;
  /** Connector name (e.g., 'sharepoint') */
  connector: string;
  /** Parameter name in the connector action (e.g., 'dataset') */
  paramName: string;
  /** Human-readable description (e.g., 'SharePoint Site URL') */
  description: string;
  /** Suggested environment variable schema name (e.g., 'cr_SP_SiteUrl_HR') */
  suggestedSchemaName: string;
  /** Suggested display name (e.g., 'SharePoint Site URL - HR') */
  suggestedDisplayName: string;
  /** Parameter type for the environment variable */
  paramType: 'String';
  /** All actions using this hardcoded value */
  usages: Array<{ nodeId: string; nodeName: string; paramName: string; path: string[] }>;
}

/**
 * User selection for applying a hardcoded value extraction.
 */
export interface HardcodedValueSelection {
  /** The grouping key from HardcodedValueSuggestion */
  key: string;
  /** The hardcoded value to replace */
  value: string;
  /** Connector name */
  connector: string;
  /** Parameter name in the connector action */
  paramName: string;
  /** Final schema name chosen by the user (may differ from suggestion) */
  schemaName: string;
  /** Final display name chosen by the user */
  displayName: string;
  /** Description for the environment variable */
  description: string;
  /** Usages to replace */
  usages: Array<{ nodeId: string; nodeName: string; paramName: string; path: string[] }>;
}

/**
 * A direct connection detected in connectionReferences that could be converted
 * to a connection reference (solution-aware) for portability.
 */
export interface ConnectionRefSuggestion {
  /** Key in ir.connectionReferences (e.g., 'shared_sharepointonline') */
  referenceName: string;
  /** The direct connection ID being used */
  connectionName: string;
  /** API identifier (e.g., '/providers/Microsoft.PowerApps/apis/shared_sharepointonline') */
  apiId: string;
  /** Human-readable connector name derived from apiId */
  connectorDisplayName: string;
  /** All nodes referencing this connection */
  usages: Array<{ nodeId: string; nodeName: string; path: string[] }>;
}

/**
 * User selection for converting a direct connection to a connection reference.
 */
export interface ConnectionRefSelection {
  /** Key in ir.connectionReferences to convert */
  referenceName: string;
  /** The Dataverse logical name to set */
  connectionReferenceLogicalName: string;
}

/**
 * Complete optimization report for a flow.
 */
export interface OptimizationReport {
  /** Name of the flow that was optimized */
  flowName: string;
  /** Timestamp when optimization was performed */
  timestamp: string;
  /** List of changes applied */
  changes: OptimizationChange[];
  /** List of warnings (issues detected but not auto-fixed) */
  warnings: OptimizationWarning[];
  /** Hardcoded values that could be extracted to environment variables */
  hardcodedValues: HardcodedValueSuggestion[];
  /** Direct connections that could be converted to connection references */
  connectionSuggestions: ConnectionRefSuggestion[];
  /** Summary statistics */
  summary: OptimizationSummary;
}

/**
 * Creates an empty optimization report.
 */
export function createEmptyReport(flowName: string): OptimizationReport {
  return {
    flowName,
    timestamp: new Date().toISOString(),
    changes: [],
    warnings: [],
    hardcodedValues: [],
    connectionSuggestions: [],
    summary: {
      totalChanges: 0,
      totalWarnings: 0,
      byType: {},
    },
  };
}

/**
 * Adds a change to the report and updates summary.
 */
export function addChange(report: OptimizationReport, change: OptimizationChange): void {
  report.changes.push(change);
  report.summary.totalChanges++;
  report.summary.byType[change.type] = (report.summary.byType[change.type] || 0) + 1;
}

/**
 * Adds a warning to the report and updates summary.
 */
export function addWarning(report: OptimizationReport, warning: OptimizationWarning): void {
  report.warnings.push(warning);
  report.summary.totalWarnings++;
  report.summary.byType[warning.type] = (report.summary.byType[warning.type] || 0) + 1;
}

/**
 * Formats the report as a human-readable string for console output.
 */
export function formatReportSummary(report: OptimizationReport): string {
  const lines: string[] = [];

  lines.push(`Optimization Report for: ${report.flowName}`);
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push('');

  if (report.changes.length > 0) {
    lines.push(`Changes Applied (${report.summary.totalChanges}):`);
    for (const change of report.changes) {
      const location = change.location.length > 0 ? ` in ${change.location.join(' > ')}` : '';
      lines.push(`  - [${change.type}] ${change.description}${location}`);
    }
    lines.push('');
  }

  if (report.warnings.length > 0) {
    lines.push(`Warnings (${report.summary.totalWarnings}):`);
    for (const warning of report.warnings) {
      const location = warning.location.length > 0 ? ` at ${warning.location.join(' > ')}` : '';
      lines.push(`  - [${warning.type}] ${warning.message}${location}`);
      lines.push(`    Suggestion: ${warning.suggestion}`);
    }
    lines.push('');
  }

  if (report.connectionSuggestions.length > 0) {
    lines.push(`Direct Connections (${report.connectionSuggestions.length}):`);
    for (const suggestion of report.connectionSuggestions) {
      lines.push(`  - [${suggestion.connectorDisplayName}] ${suggestion.referenceName} uses direct connection ${suggestion.connectionName} (${suggestion.usages.length} usage(s))`);
    }
    lines.push('');
  }

  if (report.changes.length === 0 && report.warnings.length === 0 && report.connectionSuggestions.length === 0) {
    lines.push('No optimizations found. Flow is already optimized!');
  }

  return lines.join('\n');
}
