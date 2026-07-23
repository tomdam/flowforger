/**
 * @flowforger/dsl-native
 *
 * TypeScript native DSL for Power Automate flows.
 * Allows writing flows using native TypeScript syntax with decorators.
 */

// Main transformer
export { transformFile, transformCode, TransformOptions, TransformResult } from './transformer/index.js';

// Decorators
export {
  Flow,
  HttpTrigger,
  ManualTrigger,
  RecurrenceTrigger,
  ConnectorTrigger,
  Action,
  HttpTriggerOptions,
  ManualTriggerOptions,
  RecurrenceTriggerOptions,
  ConnectorTriggerOptions,
} from './decorators.js';

// Context types
export {
  FlowContext,
  FlowConfig,
  FlowMetadataConfig,
  FlowParameterConfig,
  ConnectionReferenceConfig,
  HttpInputs,
  HttpResponse,
  ResponseInputs,
  DelayUnit,
  VariableType,
  ConnectorParams,
  ActionReference,
} from './context.js';

// Expression transformer (for advanced usage)
export {
  transformExpression,
  transformCondition,
  transformItemsExpression,
  transformTemplateStringInline,
  createTransformContext,
} from './transformer/expression-transformer.js';
export type { TransformContext } from './transformer/expression-transformer.js';

// Expression scope + DSL expression evaluation support (debug console)
export { buildExpressionScope, dslExpressionToPA, evaluateDebugInput } from './expression-scope.js';
export type { ExpressionScope, DebugEvalOutcome, DebugEvalContext } from './expression-scope.js';

// Utilities
export { resetIdCounter, genId } from './utils/id-generator.js';
export { inferVariableType, PAVariableType } from './utils/type-inference.js';

// Generator (IR -> Native DSL)
export { generateNativeDslFromIR, GeneratorOptions } from './generator.js';

// Generator with Source Map (IR -> Native DSL + line mapping)
export { generateNativeDslWithSourceMap, type DslWithSourceMap, type SourceMapEntry } from './generator-sourcemap.js';

// Source Map Builder (User DSL + IR -> bidirectional source map for debugging)
export { buildSourceMapFromDsl, type DslSourceMap } from './source-map-builder.js';

// Parser (Logic Apps JSON -> IR)
export { parseLogicAppsToIR, resetParserIdCounter, ParseOptions } from './parser-logicapps.js';

// Expression Parser (PA expressions -> TypeScript)
export {
  parseExpressionToTypeScript,
  parseItemsExpressionToTypeScript,
  parseSwitchExpressionToTypeScript,
  parseStringValue,
  parseStringToTemplateLiteral,
  isMixedExpressionString,
  ParseResult,
} from './generator/expression-parser.js';

// OData Query Builder
export { parseODataFilter, isODataParameter } from './generator/odata-parser.js';
export { isODataCall, transformODataCall, isODataTaggedTemplate, transformODataTaggedTemplate } from './transformer/odata-transformer.js';
export { parseJsToOData } from './transformer/js-to-odata-parser.js';

// OData Types
export type { ODataExpression, ODataBuilder } from './context.js';

// Monaco Editor type definitions (for IDE integrations)
export { monacoTypeDefinitions, dslExampleSnippets } from './monaco-types.js';

// Optimizer (DSL performance transformations)
export {
  optimizeDsl,
  optimizeIR,
  OptimizeOptions,
  OptimizeResult,
  OptimizationReport,
  OptimizationChange,
  OptimizationWarning,
  OptimizationSummary,
  OptimizationType,
  createEmptyReport,
  addChange,
  addWarning,
  formatReportSummary,
  applyHardcodedValueExtractions,
  applyConnectionRefConversions,
} from './optimizer/index.js';

export type {
  HardcodedValueSuggestion,
  HardcodedValueSelection,
  ConnectionRefSuggestion,
  ConnectionRefSelection,
} from './optimizer/report.js';
