/**
 * @flowforger/dsl-language-service
 *
 * Language service for FlowForger DSL autocomplete and analysis.
 * This package provides browser-compatible language features for the dsl-native TypeScript DSL.
 */

// Types
export type {
  Position,
  Range,
  CompletionItem,
  CompletionContext,
  Documentation,
  Diagnostic as TypesDiagnostic,
  DiagnosticRelatedInformation,
  Hover,
  Location,
  Symbol,
  TextEdit,
  MethodSignature,
  ParameterInfo,
  ConnectorOperation,
} from './types.js';

export {
  CompletionItemKind,
  CompletionItemTag,
  CompletionTriggerKind,
  DiagnosticSeverity as TypesDiagnosticSeverity,
  SymbolKind,
} from './types.js';

// Data - Flow Context Methods
export {
  flowContextMethods,
  getMethodsByCategory,
  getCategories,
  findMethod,
} from './data/flow-context-methods.js';

// Data - Connector Operations (legacy, for backwards compatibility)
export {
  connectorOperations,
  dataverseOperations,
  sharePointOperations,
  office365Operations,
  wordOnlineOperations,
  excelOnlineOperations,
  approvalsOperations,
  getConnectorOperations,
  getConnectorNames,
  findOperation,
} from './data/connector-operations.js';

// Data - Connector Registry (new, metadata-driven)
export {
  registerConnector,
  getConnectorRegistry,
  getConnectorRegistryAsync,
  getRegisteredConnectorNames,
  getConnectorMetadata,
  getConnectorOperationsFromRegistry,
  getOperationMetadata,
  searchOperations,
  refreshRegistry,
  type ConnectorMetadata,
  type OperationMetadata,
} from './data/connector-registry.js';

// Data - Trigger Catalog
export {
  getTriggerCatalog,
  getConnectorTriggers,
  getTriggerOperation,
  getConnectorNamesWithTriggers,
  type ConnectorTriggerType,
  type TriggerOperationMetadata,
  type ConnectorTriggerCatalogEntry,
} from '@flowforger/connectors-shared';

// Providers - Completion
export {
  getContextMethodCompletions,
  getConnectorNameCompletions,
  getConnectorOperationCompletions,
  getODataBuilderCompletions,
  getCompletions,
  analyzeCompletionContext,
  CompletionType,
} from './providers/completion.js';

// Analyzer - DSL Parser
export {
  parseSource,
  findNodeAtPosition,
  findEnclosingForOfLoops,
  getForOfLoopVariable,
  findFlowClass,
  findActionMethod,
  findTriggerMethod,
  hasDecorator,
  getDecoratorArgument,
  type SourcePosition,
  type SourceRange,
} from './analyzer/dsl-parser.js';

// Analyzer - Action Finder
export {
  findActions,
  findActionByName,
  getActionNames,
  isActionDeclared,
  findDuplicateActions,
  findActionsBeforeLine,
  type ActionDeclaration,
  type ActionType,
} from './analyzer/action-finder.js';

// Analyzer - Variable Finder
export {
  findVariables,
  findVariableByName,
  getVariableNames,
  findVariablesBeforeLine,
  type VariableDeclaration,
  type PAVariableType,
} from './analyzer/variable-finder.js';

// Analyzer - Symbol Index
export {
  buildSymbolIndex,
  getActionNamesAtLine,
  getVariableNamesAtLine,
  getLoopVariablesAtPosition,
  isInsideLoop,
  findAction,
  findVariable,
  isValidActionReference,
  isValidVariableReference,
  getAllActionNames,
  getAllVariableNames,
  getAllLoopNames,
  getAllParameterNames,
  getAllConnectionReferenceNames,
  getAllChildFlowNames,
  findUnusedVariables,
  findInvalidActionReferences,
  findInvalidParameterReferences,
  findInvalidConnectionReferences,
  type SymbolIndex,
  type LoopDeclaration,
  type ParameterDeclaration,
  type ConnectionReferenceDeclaration,
  type ChildFlowDeclaration,
  type FlowInfo,
} from './analyzer/symbol-index.js';

// Data - Diagnostic Codes
export {
  DiagnosticCodes,
  getDiagnosticCode,
  formatDiagnosticMessage,
  getAllDiagnosticCodes,
  type DiagnosticCode,
} from './data/diagnostic-codes.js';

// Providers - Reference Detection
export {
  detectStringReference,
  type StringReference,
} from './providers/reference-detection.js';

// Providers - Diagnostics
export {
  getDiagnostics,
  hasStructuralIssues,
  getDiagnosticCounts,
  type Diagnostic,
  type DiagnosticsOptions,
} from './providers/diagnostics.js';
