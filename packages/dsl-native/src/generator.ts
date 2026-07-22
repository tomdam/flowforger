/**
 * Native DSL Generator
 * Converts FlowIR to TypeScript native DSL code.
 *
 * Architecture:
 *   Logic Apps JSON → IR → Native DSL TypeScript
 *                       → Fluent DSL TypeScript
 *
 * This keeps IR as the central format, allowing both DSL styles
 * to be generated from the same intermediate representation.
 */

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
  FlowForgerConfig,
  ChildFlowDefinition,
} from '@flowforger/ir';

import {
  parseExpressionToTypeScript,
  parseItemsExpressionToTypeScript,
  parseSwitchExpressionToTypeScript,
  parseStringValue,
  type ParseExpressionOptions,
} from './generator/expression-parser.js';

import { getGeneratorConfig, getLoggingConfig, getParserConfig, type GeneratorConfig, type LoggingConfig, type ParserConfig } from '@flowforger/ir';

import { unflattenParams, needsUnflattening } from './utils/params-transform.js';

// Default authentication expression for ApiConnection actions/triggers. When the IR holds
// exactly this string, it matches what the Logic Apps emitter re-injects by default, so the
// generator can omit the argument from the produced DSL without changing emitted JSON.
const DEFAULT_CONNECTOR_AUTHENTICATION = "@parameters('$authentication')";

// Module-level config storage for the current generation run
let currentGeneratorConfig: GeneratorConfig = getGeneratorConfig();
let currentLoggingConfig: LoggingConfig = getLoggingConfig();
let currentParserConfig: Required<ParserConfig> = getParserConfig();
let currentChildFlows: Record<string, any> | undefined;

// Module-level loop context for the current generation run.
// Managed by generateForeachStatement (save/restore pattern).
let currentLoopMap: Map<string, string> = new Map();
let currentLoopVarName: string | undefined;
let usedLoopVarNames: Set<string> = new Set();

/**
 * Check if the action name should be skipped (not included in @action annotation)
 * based on the skipActionNamesForKinds config option.
 */
function shouldSkipActionName(actionKind: string): boolean {
  const skipKinds = currentParserConfig.skipActionNamesForKinds;
  if (!skipKinds || skipKinds.length === 0) {
    return false;
  }
  return skipKinds.includes(actionKind.toLowerCase());
}

import {
  parseODataFilter,
  isODataParameter,
} from './generator/odata-parser.js';

// Helper: Check if a name is a valid JavaScript identifier (can use dot notation)
// Returns true if the name contains only letters, digits, underscores, and dollar signs
// and doesn't start with a digit
function isValidJsIdentifier(name: string): boolean {
  // Valid JS identifier: starts with letter/underscore/$, followed by letters/digits/underscores/$
  return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name);
}

// Helper: Sanitize name for TypeScript identifier
// Preserves Unicode letters (ä, ö, ü, é, etc.) which are valid in JS/TS identifiers
// Uses whitelist approach: only keep letters, digits, underscore, and dollar sign
function sanitizeName(name: string): string {
  return name
    // Replace anything that's NOT a letter (including Unicode), digit, underscore, or dollar sign
    .replace(/[^\p{L}\p{N}_$]/gu, '_')
    .replace(/_+/g, '_') // Collapse multiple underscores
    .replace(/^_|_$/g, '') // Trim leading/trailing underscores
    .replace(/^[0-9]/, '_$&') // Prefix if starts with digit (MUST be after trim!)
    || '_var'; // Fallback if empty
}

// Helper: Escape string for TypeScript (double quotes)
function escapeString(str: string): string {
  if (typeof str !== 'string') return String(str);
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

// Helper: Check if a string value is a Power Automate expression
function isExpression(value: any): boolean {
  if (typeof value !== 'string') return false;
  // Check for @ prefix or @{} template expressions
  if (value.startsWith('@@')) return false; return value.startsWith('@') || value.includes('@{');
}

// Helper: Check if we're at top level (in main run method)
function isTopLevelIndent(indent: string): boolean {
  // Top level actions in run() method have indent "    " (4 spaces)
  // Nested actions (inside if/foreach/scope) have more indentation (6+ spaces)
  return indent === '    ';
}

// Helper: Generate @runAfter JSDoc tags from runAfter property
// Returns empty string only if runAfter matches implied sequential behavior
// (single dependency on previousActionName with ['Succeeded'])
function generateRunAfterTags(
  runAfter: Record<string, string[]> | undefined,
  previousActionName?: string,
  indent?: string
): string {
  const isTopLevel = indent ? isTopLevelIndent(indent) : false;

  // No runAfter info (undefined) or empty runAfter {} - both mean "run first / in parallel"
  // If there's a previous action, we need to emit @runAfter first to indicate parallel execution
  // Otherwise the transformer will assume sequential behavior
  if (runAfter === undefined || Object.keys(runAfter).length === 0) {
    if (previousActionName) {
      // Not first action in container, but no dependency - parallel execution
      return isTopLevel ? '@runAfter trigger' : '@runAfter first';
    }
    // First action in container - no runAfter needed (implicitly runs first)
    return '';
  }

  const entries = Object.entries(runAfter);

  // Check if it's default sequential behavior:
  // - Single dependency
  // - Only 'Succeeded' status (exact case match for parity)
  // - Depends on the previous action (not a parallel branch)
  if (entries.length === 1) {
    const [depName, statuses] = entries[0];
    // Must be exactly 'Succeeded' (title case) to match default output
    // Other cases like 'SUCCEEDED' must be preserved explicitly
    if (statuses.length === 1 && statuses[0] === 'Succeeded') {
      // Only skip if this matches the implied sequential predecessor
      if (previousActionName && depName === previousActionName) {
        return '';
      }
    }
  }

  // Generate @runAfter tags for non-default behavior (multiple deps, non-Succeeded status, or parallel branches)
  return entries
    .map(([action, statuses]) => {
      // Quote action names containing colons to avoid parsing ambiguity
      const escapedAction = action.includes(':') ? `"${action}"` : action;
      return `@runAfter ${escapedAction}: ${statuses.join(', ')}`;
    })
    .join(' ');
}

// Helper: Extract runtimeConfiguration annotations
function extractRuntimeConfigAnnotations(runtimeConfiguration?: Record<string, any>): string[] {
  const annotations: string[] = [];
  if (runtimeConfiguration) {
    // Add full runtimeConfiguration as JSON (preserves all properties)
    annotations.push(`@runtimeConfig ${JSON.stringify(runtimeConfiguration)}`);
  }
  return annotations;
}

/**
 * Detect when a value's array form differs from the default round-trip heuristic.
 *
 * Default heuristic in transformer:
 *   - Array literal in DSL with any @-prefixed string element → IR `@createArray(...)` string.
 *   - Array literal in DSL with all-primitive elements → IR literal array.
 *
 * Returns:
 *   - 'array' when source has a literal array containing @-strings (heuristic would mangle to string).
 *   - 'createArrayString' when source has `@createArray(<primitives>)` (heuristic would mangle to array).
 *   - undefined when source matches default heuristic.
 *
 * Walks through nested objects/arrays so a single tag covers any nested anomaly.
 * If both anomalies exist, prefers 'array' (the more common case).
 */
function detectValueArrayForm(value: any): 'array' | 'createArrayString' | undefined {
  let needsArrayTag = false;
  let needsStringTag = false;

  function walk(v: any): void {
    if (Array.isArray(v)) {
      const hasAtPrefixed = v.some(el => typeof el === 'string' && el.startsWith('@'));
      if (hasAtPrefixed) needsArrayTag = true;
      v.forEach(walk);
    } else if (typeof v === 'string' && v.startsWith('@createArray(') && v.endsWith(')')) {
      const content = v.slice('@createArray('.length, -1);
      // Args are primitives only when no function-call pattern (`name(`) exists.
      if (!/[a-zA-Z_][\w$]*\s*\(/.test(content)) {
        needsStringTag = true;
      }
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  }

  walk(value);
  if (needsArrayTag) return 'array';
  if (needsStringTag) return 'createArrayString';
  return undefined;
}

// Helper: Build JSDoc comment with action name, optional type, runAfter, and originalName
/**
 * Format a trigger description according to the current `descriptionStyle` setting.
 * Returns one or more lines (already without leading indent — the caller adds class-level indent).
 */
function formatTriggerDescription(description: string): string[] {
  if (currentGeneratorConfig.descriptionStyle === 'lineComment') {
    return description.split('\n').map(l => `// ${l}`);
  }
  return [`/** @description ${description} */`];
}

function buildJSDocComment(
  actionName: string,
  options: {
    type?: string;
    limit?: number | { timeout?: string }; // number for do-until count, object for action timeout
    runAfter?: Record<string, string[]>;
    previousActionName?: string;
    originalName?: string;
    description?: string; // Action description
    indent?: string;
    extraAnnotations?: string | string[];
    runtimeConfiguration?: Record<string, any>;
    retryPolicy?: Record<string, any>;
    trackedProperties?: Record<string, string>;
    metadata?: Record<string, any>; // Action metadata (e.g., operationMetadataId, file path mapping)
    operationOptions?: string; // Logic Apps operationOptions (e.g., "Asynchronous")
    paramsOmitted?: boolean; // Connector source JSON had no `parameters` key
    includeAction?: boolean; // Whether to include @action tag (default: true)
    conditionFormat?: 'string' | 'object'; // Original condition format for if statements
    valueArrayForm?: 'array' | 'createArrayString'; // Override default array↔createArray heuristic
    varNameCase?: string; // Source's case for the variable name when it differs from the canonical (declared) casing
  } = {}
): string {
  const parts: string[] = [];

  // Only include @action if explicitly requested or by default (for backwards compatibility)
  if (options.includeAction !== false) {
    parts.push(`@action ${actionName}`);
  }

  if (options.type) {
    parts.push(`@type ${options.type}`);
  }

  // In 'lineComment' mode, description is emitted as // line(s) above the JSDoc
  // (handled at the bottom of this function), not inside the JSDoc parts list.
  const descriptionAsLineComment = currentGeneratorConfig.descriptionStyle === 'lineComment' && !!options.description;
  if (options.description && !descriptionAsLineComment) {
    parts.push(`@description ${options.description}`);
  }

  if (options.limit !== undefined) {
    // Serialize limit - number for do-until count, JSON for action timeout object
    const limitValue = typeof options.limit === 'number' ? options.limit : JSON.stringify(options.limit);
    parts.push(`@limit ${limitValue}`);
  }

  const runAfterTags = generateRunAfterTags(options.runAfter, options.previousActionName, options.indent);
  if (runAfterTags) {
    parts.push(runAfterTags);
  }

  if (options.originalName) {
    parts.push(`@originalName "${escapeString(options.originalName)}"`);
  }

  // Add runtimeConfiguration annotations
  if (options.runtimeConfiguration) {
    const runtimeConfigAnnotations = extractRuntimeConfigAnnotations(options.runtimeConfiguration);
    parts.push(...runtimeConfigAnnotations);
  }

  // Add retryPolicy annotation
  if (options.retryPolicy) {
    parts.push(`@retryPolicy ${JSON.stringify(options.retryPolicy)}`);
  }

  // Add trackedProperties annotation
  if (options.trackedProperties) {
    parts.push(`@trackedProperties ${JSON.stringify(options.trackedProperties)}`);
  }

  // Add metadata annotation
  if (options.metadata) {
    parts.push(`@metadata ${JSON.stringify(options.metadata)}`);
  }

  // Add operationOptions annotation (Logic Apps action setting, e.g. "Asynchronous")
  if (options.operationOptions) {
    parts.push(`@operationOptions ${JSON.stringify(options.operationOptions)}`);
  }

  // Marker indicating the source JSON had no `parameters` key (parameterless connector op).
  if (options.paramsOmitted) {
    parts.push(`@paramsOmitted`);
  }

  // Add conditionFormat annotation (for if statements)
  if (options.conditionFormat) {
    parts.push(`@conditionFormat ${options.conditionFormat}`);
  }

  // Sentinel for round-tripping array vs `@createArray(...)` source forms when
  // the source form differs from the transformer's default heuristic.
  if (options.valueArrayForm) {
    parts.push(`@valueArrayForm ${options.valueArrayForm}`);
  }

  // Sentinel preserving the source's case for the variable name when it differs
  // from the canonical (declared) casing — required for parity since PA names
  // are case-insensitive at runtime but JSON-byte-exact for parity.
  if (options.varNameCase) {
    parts.push(`@varNameCase "${escapeString(options.varNameCase)}"`);
  }

  // Add any extra annotations
  if (options.extraAnnotations) {
    const annotations = Array.isArray(options.extraAnnotations)
      ? options.extraAnnotations
      : [options.extraAnnotations];
    parts.push(...annotations);
  }

  // Build the description as // line(s) when descriptionStyle is 'lineComment'.
  // The caller prepends `indent` to the first line; subsequent lines need an explicit
  // indent prefix so the entire emission stays aligned.
  let lineCommentPrefix = '';
  if (descriptionAsLineComment) {
    const indent = options.indent ?? '';
    const descLines = options.description!.split('\n');
    lineCommentPrefix = descLines.map(l => `// ${l}`).join(`\n${indent}`);
  }

  // Return empty string if no parts to document (avoids empty JSDoc like "/**  */")
  if (parts.length === 0) {
    return lineCommentPrefix; // may be empty when no description and no other tags
  }

  const jsDoc = `/** ${parts.join(' ')} */`;
  if (lineCommentPrefix) {
    const indent = options.indent ?? '';
    return `${lineCommentPrefix}\n${indent}${jsDoc}`;
  }
  return jsDoc;
}

// Helper: Format value for TypeScript (without expression parsing - for literals only)
function formatValueLiteral(value: any, indent: string = ''): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') {
    return `"${escapeString(value)}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map(v => formatValueLiteral(v, indent + '  '));
    if (items.every(i => !i.includes('\n')) && items.join(', ').length < 60) {
      return `[${items.join(', ')}]`;
    }
    return `[\n${indent}  ${items.join(`,\n${indent}  `)}\n${indent}]`;
  }
  if (typeof value === 'object') {
    // Filter out undefined values from objects
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    const props = entries.map(([k, v]) => {
      const key = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) ? k : `"${escapeString(k)}"`;
      return `${key}: ${formatValueLiteral(v, indent + '  ')}`;
    });
    if (props.every(p => !p.includes('\n')) && props.join(', ').length < 60) {
      return `{ ${props.join(', ')} }`;
    }
    return `{\n${indent}  ${props.join(`,\n${indent}  `)}\n${indent}}`;
  }
  return String(value);
}

// Helper: Format value for TypeScript with expression parsing (recursively parses expressions in objects/arrays)
function formatValue(value: any, indent: string = '', variableMap?: VariableNameMap): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') {
    // Check if this is an expression (pure @... or mixed with @{...})
    if (isExpression(value)) {
      const parsed = parseStringValue(value, getExpressionOptions(variableMap));
      return parsed.code;
    }
    return `"${escapeString(value)}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map(v => formatValue(v, indent + '  ', variableMap));
    if (items.every(i => !i.includes('\n')) && items.join(', ').length < 60) {
      return `[${items.join(', ')}]`;
    }
    return `[\n${indent}  ${items.join(`,\n${indent}  `)}\n${indent}]`;
  }
  if (typeof value === 'object') {
    // Filter out undefined values from objects
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    const props = entries.map(([k, v]) => {
      const key = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) ? k : `"${escapeString(k)}"`;
      // Use OData parser for $filter parameters (when value is a string without pure expressions)
      if (isODataParameter(k) && typeof v === 'string' && !v.startsWith('@')) {
        return `${key}: ${parseODataFilter(v)}`;
      }
      return `${key}: ${formatValue(v, indent + '  ', variableMap)}`;
    });
    if (props.every(p => !p.includes('\n')) && props.join(', ').length < 60) {
      return `{ ${props.join(', ')} }`;
    }
    return `{\n${indent}  ${props.join(`,\n${indent}  `)}\n${indent}}`;
  }
  return String(value);
}

// Helper: Format a value that might be an expression (same as formatValue now, kept for compatibility)
function formatValueOrExpression(value: any, indent: string = '', variableMap?: VariableNameMap): string {
  return formatValue(value, indent, variableMap);
}

export interface GeneratorOptions {
  /** Override the flow name */
  flowName?: string;
  /** FlowForger configuration for controlling generation behavior */
  config?: FlowForgerConfig;
  /** Child flow definitions for name-based workflow references */
  childFlows?: Record<string, ChildFlowDefinition>;
}

/**
 * Maps original variable names to sanitized names (handles collision detection).
 * Key: original variable name, Value: { sanitized: sanitized name, needsTag: boolean }
 */
interface VariableNameMap {
  [originalName: string]: {
    sanitized: string;
    needsTag: boolean; // true if sanitized differs from original or collision occurred
    canonicalOriginalName: string; // original name from the FIRST occurrence (declared case)
  };
}

/**
 * Create expression options combining variableMap with current config.
 */
function getExpressionOptions(variableMap?: VariableNameMap): ParseExpressionOptions {
  return {
    variableMap,
    config: currentGeneratorConfig,
    loopMap: currentLoopMap.size > 0 ? currentLoopMap : undefined,
    currentLoopVar: currentLoopVarName,
  };
}

/**
 * Derive a unique loop variable name from a foreach action name.
 */
function deriveLoopVariableName(loopName: string): string {
  let baseName = 'item';

  // "ForEach_X" or "Foreach_X" → extract X and camelCase it
  const foreachMatch = loopName.match(/^For[Ee]ach[_\s]+(.+)$/);
  if (foreachMatch) {
    baseName = toCamelCase(foreachMatch[1]);
  }
  // "Apply_to_each" → "item", "Apply_to_each_2" → "item"
  else if (/^Apply_to_each/i.test(loopName)) {
    baseName = 'item';
  }
  // Any other name → camelCase the whole thing
  else {
    baseName = toCamelCase(loopName);
  }

  // Sanitize: must be a valid JS identifier
  baseName = baseName.replace(/[^a-zA-Z0-9_$]/g, '');
  if (!baseName || /^\d/.test(baseName)) {
    baseName = 'item';
  }
  // Ensure starts with lowercase
  baseName = baseName[0].toLowerCase() + baseName.slice(1);

  // Ensure uniqueness
  let name = baseName;
  let counter = 2;
  while (usedLoopVarNames.has(name)) {
    name = baseName + counter;
    counter++;
  }
  usedLoopVarNames.add(name);
  return name;
}

/**
 * Convert a string like "some_name" or "SomeName" to camelCase.
 */
function toCamelCase(str: string): string {
  const parts = str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .split(/[_\s-]+/)
    .filter(Boolean);
  if (parts.length === 0) return 'item';
  return parts
    .map((p, i) => i === 0 ? p.toLowerCase() : p[0].toUpperCase() + p.slice(1).toLowerCase())
    .join('');
}

/**
 * Build a variable name mapping from all nodes in the flow.
 * Handles collision detection by adding numeric suffixes.
 */
function buildVariableNameMap(nodes: Node[]): VariableNameMap {
  const map: VariableNameMap = {};
  const usedNames = new Set<string>();
  // Case-insensitive lookup: lowercase(varName) -> canonical casing
  const caseInsensitiveLookup = new Map<string, string>();

  // Helper to process a single node
  const processNode = (node: Node) => {
    if (node.type === 'action') {
      const actionNode = node as ActionNode;
      const inputs = actionNode.inputs as any || {};
      const kind = actionNode.kind;

      if (kind === 'initializevariable' || kind === 'setvariable' ||
          kind === 'incrementvariable' || kind === 'decrementvariable' ||
          kind === 'appendtoarrayvariable' || kind === 'appendtostringvariable') {
        const originalName = inputs.variableName || inputs.name;
        if (!originalName) return;

        // Check if this variable (case-insensitive) already exists
        const lowerCaseName = originalName.toLowerCase();
        const canonicalName = caseInsensitiveLookup.get(lowerCaseName);

        if (canonicalName) {
          // Variable already exists with different casing - map to canonical casing
          if (originalName !== canonicalName && !map[originalName]) {
            map[originalName] = map[canonicalName];
          }
        } else {
          // First time seeing this variable - establish canonical casing
          let sanitized = sanitizeName(originalName);
          const isDifferent = sanitized !== originalName;

          // Check for collision
          if (usedNames.has(sanitized)) {
            let counter = 1;
            while (usedNames.has(`${sanitized}_${counter}`)) {
              counter++;
            }
            sanitized = `${sanitized}_${counter}`;
          }

          usedNames.add(sanitized);
          map[originalName] = {
            sanitized,
            needsTag: isDifferent || sanitized.includes('_') && sanitized !== originalName,
            canonicalOriginalName: originalName,
          };
          // Record this as the canonical casing for case-insensitive lookup
          caseInsensitiveLookup.set(lowerCaseName, originalName);
        }
      }
    }

    // Recursively process nested actions in control structures
    if (node.type === 'scope') {
      (node as ScopeNode).actions?.forEach(processNode);
    } else if (node.type === 'if') {
      const ifNode = node as IfNode;
      ifNode.actions?.forEach(processNode);
      ifNode.elseActions?.forEach(processNode);
    } else if (node.type === 'foreach') {
      (node as ForeachNode).actions?.forEach(processNode);
    } else if (node.type === 'switch') {
      const switchNode = node as SwitchNode;
      switchNode.cases?.forEach(c => c.actions?.forEach(processNode));
      switchNode.defaultActions?.forEach(processNode);
    } else if (node.type === 'dountil') {
      (node as DoUntilNode).actions?.forEach(processNode);
    }
  };

  // Process all nodes
  nodes.forEach(processNode);

  return map;
}

/**
 * Generate native DSL TypeScript code from FlowIR.
 */
export function generateNativeDslFromIR(ir: FlowIR, options: GeneratorOptions = {}): string {
  // Allow childFlows from options to supplement IR
  if (options.childFlows && !ir.childFlows) {
    ir = { ...ir, childFlows: options.childFlows };
  }

  // Set the module-level config for this generation run
  currentGeneratorConfig = getGeneratorConfig({ generator: options.config?.generator });
  currentLoggingConfig = getLoggingConfig(options.config);
  currentParserConfig = getParserConfig(options.config);
  currentChildFlows = ir.childFlows;

  // Reset loop context for this generation run
  currentLoopMap = new Map();
  currentLoopVarName = undefined;
  usedLoopVarNames = new Set();

  if (currentLoggingConfig.verbose) {
    //console.error('[FlowForger] Converting: IR → DSL');
  }

  const flowName = options.flowName || ir.name || 'GeneratedFlow';
  const className = sanitizeName(flowName);

  const lines: string[] = [];

  // No import statement: the transformer parses by structure (decorator/method names) and
  // Monaco's DSL extra-lib declares the types globally (see monaco-types.ts), so no consumer
  // needs the import. The generated `.ff.ts` files are never compiled standalone via tsc.

  // Emit description as JSDoc comment above the class
  if (ir.description) {
    lines.push('/**');
    for (const line of ir.description.split('\n')) {
      if (line === '') {
        lines.push(' *');
      } else {
        lines.push(` * ${line}`);
      }
    }
    lines.push(' */');
  }

  // Class declaration with @Flow decorator
  // Use object form when workflowId is set; otherwise keep short string form for minimal diffs
  if (ir.workflowId) {
    lines.push(`@Flow({`);
    lines.push(`  name: "${escapeString(flowName)}",`);
    lines.push(`  workflowId: "${escapeString(ir.workflowId)}"`);
    lines.push(`})`);
  } else {
    lines.push(`@Flow("${escapeString(flowName)}")`);
  }
  lines.push(`class ${className} {`);

  // Find trigger node
  const triggerNode = ir.nodes.find(n => n.type === 'trigger' || n.type === 'recurrence');
  if (triggerNode) {
    const triggerLines = generateTriggerFromNode(triggerNode);
    lines.push(...triggerLines.map(l => '  ' + l));
  } else {
    lines.push('  @HttpTrigger({ method: "POST" })');
    lines.push('  trigger() {}');
  }
  lines.push('');

  // Generate action method
  lines.push('  @Action()');
  lines.push('  async run(ctx: FlowContext) {');

  // Get non-trigger nodes
  const actionNodes = ir.nodes.filter(n => n.type !== 'trigger' && n.type !== 'recurrence');

  // Build variable name mapping for collision detection
  const variableMap = buildVariableNameMap(actionNodes);

  // Seed loop variable names with declared variable names to avoid shadowing
  for (const entry of Object.values(variableMap)) {
    usedLoopVarNames.add(entry.sanitized);
  }

  // Generate statements for each node, tracking previous action name for runAfter detection
  let previousActionName: string | undefined;
  for (const node of actionNodes) {
    const nodeLines = generateNodeStatement(node, '    ', previousActionName, variableMap);
    lines.push(...nodeLines);
    previousActionName = node.name;
  }

  lines.push('  }');

  // Generate constructor at the end if there are parameters, connectionReferences, metadata, workflowMetadata, outputs, or staticResults
  const hasConstructorContent = ir.parameters || ir.connectionReferences || ir.metadata || ir.workflowMetadata || ir.outputs || ir.staticResults || ir.childFlows;
  if (hasConstructorContent) {
    lines.push('');
    lines.push('  constructor(ctx: FlowContext) {');
    if (ir.metadata) {
      lines.push(`    ctx.flow.metadata = ${formatValue(ir.metadata, '    ')};`);
    }
    if (ir.workflowMetadata) {
      lines.push(`    ctx.flow.workflowMetadata = ${formatValue(ir.workflowMetadata, '    ')};`);
    }
    if (ir.parameters) {
      lines.push(`    ctx.flow.parameters = ${formatValue(ir.parameters, '    ')};`);
    }
    if (ir.connectionReferences) {
      lines.push(`    ctx.flow.connectionReferences = ${formatValue(ir.connectionReferences, '    ')};`);
    }
    if (ir.outputs !== undefined) {
      lines.push(`    ctx.flow.outputs = ${formatValue(ir.outputs, '    ')};`);
    }
    if (ir.staticResults) {
      lines.push(`    ctx.flow.staticResults = ${formatValue(ir.staticResults, '    ')};`);
    }
    if (ir.childFlows) {
      lines.push(`    ctx.flow.childFlows = ${formatValue(ir.childFlows, '    ')};`);
    }
    lines.push('  }');
  }

  lines.push('}');

  return lines.join('\n');
}

function generateTriggerFromNode(node: Node): string[] {
  if (node.type === 'recurrence') {
    const recNode = node as RecurrenceTriggerNode;
    const inputs = recNode.inputs || {};
    const lines: string[] = [];
    // Add JSDoc comment with original trigger name and/or description if present
    const hasNonDefaultName = recNode.name && recNode.name !== 'Recurrence';
    if (hasNonDefaultName || recNode.description) {
      const parts: string[] = [];
      if (hasNonDefaultName) parts.push(`@trigger ${recNode.name}`);
      if (recNode.description) parts.push(`@description ${recNode.description}`);
      lines.push(`/** ${parts.join(' ')} */`);
    }
    lines.push('@RecurrenceTrigger()');
    lines.push('trigger(ctx: FlowContext) {');
    lines.push('  return {');
    lines.push(`    frequency: "${inputs.frequency || 'Day'}",`);
    lines.push(`    interval: ${inputs.interval || 1},`);
    if (inputs.timeZone) lines.push(`    timeZone: "${escapeString(inputs.timeZone)}",`);
    if (inputs.startTime) lines.push(`    startTime: "${inputs.startTime}",`);
    if (inputs.schedule) lines.push(`    schedule: ${formatValue(inputs.schedule, '    ')},`);
    // Add conditions if present (including empty arrays)
    if (recNode.conditions !== undefined) {
      lines.push(`    conditions: ${formatValue(recNode.conditions, '    ')},`);
    }
    // Add runtimeConfiguration if present
    if (recNode.runtimeConfiguration) {
      lines.push(`    runtimeConfiguration: ${formatValue(recNode.runtimeConfiguration, '    ')},`);
    }
    // Add evaluatedRecurrence if present (Power Automate's effective schedule)
    if (recNode.evaluatedRecurrence) {
      lines.push(`    evaluatedRecurrence: ${formatValue(recNode.evaluatedRecurrence, '    ')},`);
    }
    // Add correlation if present
    if (recNode.correlation !== undefined) {
      lines.push(`    correlation: ${formatValue(recNode.correlation, '    ')},`);
    }
    lines.push('  };');
    lines.push('}');
    return lines;
  }

  if (node.type === 'trigger') {
    const trigNode = node as TriggerNode;
    const kind = trigNode.kind;
    const inputs = trigNode.inputs as any || {};

    if (kind === 'http') {
      const lines: string[] = [];
      // Add description if present, in the configured style
      if (trigNode.description) {
        lines.push(...formatTriggerDescription(trigNode.description));
      }
      lines.push('@HttpTrigger()');
      lines.push('trigger(ctx: FlowContext) {');
      lines.push('  return {');
      // Only emit `method` line when source had it. Default-omitted POST is preserved
      // by leaving the field absent so the round-trip stays byte-exact.
      if (inputs.method !== undefined) {
        lines.push(`    method: "${inputs.method}",`);
      }
      if (inputs.schema) lines.push(`    schema: ${formatValue(inputs.schema, '    ')},`);
      if (inputs.headersSchema) lines.push(`    headersSchema: ${formatValue(inputs.headersSchema, '    ')},`);
      // Add triggerKind for VirtualAgent and other non-standard trigger kinds
      if (inputs.triggerKind && inputs.triggerKind !== 'Http') {
        lines.push(`    triggerKind: "${inputs.triggerKind}",`);
      }
      // Add triggerAuthenticationType if present
      if (inputs.triggerAuthenticationType) {
        lines.push(`    triggerAuthenticationType: "${inputs.triggerAuthenticationType}",`);
      }
      // Add conditions if present (including empty arrays)
      if (trigNode.conditions !== undefined) {
        lines.push(`    conditions: ${formatValue(trigNode.conditions, '    ')},`);
      }
      // Add runtimeConfiguration if present
      if (trigNode.runtimeConfiguration) {
        lines.push(`    runtimeConfiguration: ${formatValue(trigNode.runtimeConfiguration, '    ')},`);
      }
      // Add correlation if present
      if (trigNode.correlation !== undefined) {
        lines.push(`    correlation: ${formatValue(trigNode.correlation, '    ')},`);
      }
      lines.push('  };');
      lines.push('}');
      return lines;
    }

    if (kind === 'manual') {
      const lines: string[] = [];
      // Add description if present, in the configured style
      if (trigNode.description) {
        lines.push(...formatTriggerDescription(trigNode.description));
      }
      lines.push('@ManualTrigger()');
      lines.push('trigger(ctx: FlowContext) {');
      lines.push('  return {');
      if (inputs.schema) lines.push(`    schema: ${formatValue(inputs.schema, '    ')},`);
      if (inputs.headersSchema) lines.push(`    headersSchema: ${formatValue(inputs.headersSchema, '    ')},`);
      if (inputs.triggerKind && inputs.triggerKind !== 'Button') {
        lines.push(`    triggerKind: "${inputs.triggerKind}",`);
      }
      // Add triggerAuthenticationType if present
      if (inputs.triggerAuthenticationType) {
        lines.push(`    triggerAuthenticationType: "${inputs.triggerAuthenticationType}",`);
      }
      // Add conditions if present (including empty arrays)
      if (trigNode.conditions !== undefined) {
        lines.push(`    conditions: ${formatValue(trigNode.conditions, '    ')},`);
      }
      // Add runtimeConfiguration if present
      if (trigNode.runtimeConfiguration) {
        lines.push(`    runtimeConfiguration: ${formatValue(trigNode.runtimeConfiguration, '    ')},`);
      }
      // Add correlation if present
      if (trigNode.correlation !== undefined) {
        lines.push(`    correlation: ${formatValue(trigNode.correlation, '    ')},`);
      }
      lines.push('  };');
      lines.push('}');
      return lines;
    }

    if (kind === 'connector') {
      const connector = inputs.connector || 'unknown';
      const operation = inputs.operation || 'unknown';
      const params = inputs.params || {};
      const lines: string[] = [];
      // Add JSDoc comment with original trigger name, description, and metadata
      if (trigNode.name || trigNode.description || trigNode.metadata) {
        const parts: string[] = [];
        if (trigNode.name) parts.push(`@trigger ${trigNode.name}`);
        if (trigNode.description) parts.push(`@description ${trigNode.description}`);
        if (trigNode.metadata) parts.push(`@metadata ${JSON.stringify(trigNode.metadata)}`);
        lines.push(`/** ${parts.join(' ')} */`);
      }
      lines.push('@ConnectorTrigger()');
      lines.push('trigger(ctx: FlowContext) {');
      lines.push('  return {');
      lines.push(`    connector: "${connector}",`);
      lines.push(`    operation: "${operation}",`);
      lines.push(`    params: ${formatValue(params, '    ')},`);
      if (inputs.connectionReferenceName) {
        lines.push(`    connectionReferenceName: "${inputs.connectionReferenceName}",`);
      }
      if (inputs.splitOn) {
        lines.push(`    splitOn: ${formatValue(inputs.splitOn, '    ')},`);
      }
      if (inputs.recurrence) {
        lines.push(`    recurrence: ${formatValue(inputs.recurrence, '    ')},`);
      }
      // Add triggerType if present (e.g., OpenApiConnectionWebhook, OpenApiConnectionNotification)
      if (inputs.triggerType) {
        lines.push(`    triggerType: "${inputs.triggerType}",`);
      }
      // Add authentication if present
      if (inputs.authentication) {
        lines.push(`    authentication: ${formatValue(inputs.authentication, '    ')},`);
      }
      // Add retryPolicy if present
      if (inputs.retryPolicy) {
        lines.push(`    retryPolicy: ${formatValue(inputs.retryPolicy, '    ')},`);
      }
      // Add conditions if present (including empty arrays)
      if (trigNode.conditions !== undefined) {
        lines.push(`    conditions: ${formatValue(trigNode.conditions, '    ')},`);
      }
      // Add runtimeConfiguration if present
      if (trigNode.runtimeConfiguration) {
        lines.push(`    runtimeConfiguration: ${formatValue(trigNode.runtimeConfiguration, '    ')},`);
      }
      // Add correlation if present
      if (trigNode.correlation !== undefined) {
        lines.push(`    correlation: ${formatValue(trigNode.correlation, '    ')},`);
      }
      lines.push('  };');
      lines.push('}');
      return lines;
    }
  }

  return ['@HttpTrigger()', 'trigger(ctx: FlowContext) {', '  return { method: "POST" };', '}'];
}

function generateNodeStatement(node: Node, indent: string, previousActionName?: string, variableMap?: VariableNameMap): string[] {
  const lines: string[] = [];

  switch (node.type) {
    case 'action':
      return generateActionStatement(node as ActionNode, indent, previousActionName, variableMap);

    case 'connector':
      return generateConnectorStatement(node as ConnectorActionNode, indent, previousActionName, variableMap);

    case 'connectorwebhook':
      return generateConnectorWebhookStatement(node as ConnectorWebhookActionNode, indent, previousActionName, variableMap);

    case 'scope':
      return generateScopeStatement(node as ScopeNode, indent, previousActionName, variableMap);

    case 'if':
      return generateIfStatement(node as IfNode, indent, previousActionName, variableMap);

    case 'foreach':
      return generateForeachStatement(node as ForeachNode, indent, previousActionName, variableMap);

    case 'switch':
      return generateSwitchStatement(node as SwitchNode, indent, previousActionName, variableMap);

    case 'dountil':
      return generateDoUntilStatement(node as DoUntilNode, indent, previousActionName, variableMap);

    default:
      lines.push(`${indent}// Unknown node type: ${node.type}`);
      return lines;
  }
}

function generateActionStatement(node: ActionNode, indent: string, previousActionName?: string, variableMap?: VariableNameMap): string[] {
  const lines: string[] = [];
  const kind = node.kind;
  const inputs = node.inputs as any || {};
  const name = node.name;

  switch (kind) {
    case 'http': {
      const method = inputs.method || 'GET';
      const url = inputs.url || inputs.uri || '';
      const opts: string[] = [`method: "${method}"`, `url: ${formatValue(url, indent, variableMap)}`];
      if (inputs.headers && Object.keys(inputs.headers).length > 0) {
        opts.push(`headers: ${formatValue(inputs.headers, indent, variableMap)}`);
      }
      if (inputs.queries && Object.keys(inputs.queries).length > 0) {
        opts.push(`queries: ${formatValue(inputs.queries, indent, variableMap)}`);
      }
      if (inputs.body !== undefined) {
        opts.push(`body: ${formatValue(inputs.body, indent, variableMap)}`);
      }
      if (inputs.cookie !== undefined) {
        opts.push(`cookie: ${formatValue(inputs.cookie, indent, variableMap)}`);
      }
      // Add authentication if present (OAuth, API Key, etc.)
      if (inputs.authentication) {
        opts.push(`authentication: ${formatValue(inputs.authentication, indent, variableMap)}`);
      }
      const runAfterTags = generateRunAfterTags(node.runAfter, previousActionName, indent);
      const httpOperationOptions = (node as any).operationOptions as string | undefined;
      if (runAfterTags || node.runtimeConfiguration || node.retryPolicy || node.trackedProperties || node.description || node.metadata || httpOperationOptions) {
        lines.push(`${indent}${buildJSDocComment(name, { runAfter: node.runAfter, previousActionName, indent, runtimeConfiguration: node.runtimeConfiguration, retryPolicy: node.retryPolicy, trackedProperties: node.trackedProperties, description: node.description, metadata: node.metadata, operationOptions: httpOperationOptions, includeAction: false })}`);
      }
      lines.push(`${indent}await ctx.http("${escapeString(name)}", { ${opts.join(', ')} });`);
      break;
    }

    case 'compose': {
      const value = inputs.value !== undefined ? inputs.value : inputs;
      const runAfterTags = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (runAfterTags || node.runtimeConfiguration || node.trackedProperties || node.description || node.metadata) {
        lines.push(`${indent}${buildJSDocComment(name, { runAfter: node.runAfter, previousActionName, indent, runtimeConfiguration: node.runtimeConfiguration, trackedProperties: node.trackedProperties, description: node.description, metadata: node.metadata, includeAction: false })}`);
      }
      lines.push(`${indent}await ctx.compose("${escapeString(name)}", ${formatValueOrExpression(value, indent, variableMap)});`);
      break;
    }

    case 'expression': {
      // Expression actions (IndexOf, Add, Subtract, etc.)
      const { expressionKind, ...restInputs } = inputs;
      const runAfterTags = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (runAfterTags || node.runtimeConfiguration || node.trackedProperties || node.description || node.metadata) {
        lines.push(`${indent}${buildJSDocComment(name, { runAfter: node.runAfter, previousActionName, indent, runtimeConfiguration: node.runtimeConfiguration, trackedProperties: node.trackedProperties, description: node.description, metadata: node.metadata, includeAction: false })}`);
      }
      lines.push(`${indent}await ctx.expression("${escapeString(name)}", "${expressionKind}", ${formatValue(restInputs, indent, variableMap)});`);
      break;
    }

    case 'initializevariable': {
      const varName = inputs.variableName || inputs.name || 'var';
      const varType = inputs.variableType || inputs.type || 'String';
      const varValue = inputs.value;
      // Generate as native variable declaration with JSDoc @action annotation
      const normalizedType = varType.toLowerCase();
      const tsType = normalizedType === 'integer' || normalizedType === 'float' ? 'number' :
                     normalizedType === 'boolean' ? 'boolean' :
                     normalizedType === 'array' ? 'any[]' :
                     normalizedType === 'object' ? 'Record<string, any>' : 'string';

      // Get sanitized name from variable map
      const sanitized = variableMap?.[varName]?.sanitized || sanitizeName(varName);
      const needsOriginalName = variableMap?.[varName]?.needsTag || false;

      // Preserve PA variable type if it's float (since both float and integer map to TypeScript number)
      const extraAnnotations: string[] = [];
      if (normalizedType === 'float') {
        extraAnnotations.push(`@varType float`);
      }

      // Detect anomalous source array form so the round-trip preserves it.
      const valueArrayForm = detectValueArrayForm(varValue);

      // Check if action names should be skipped for this kind.
      // Never skip when the name differs from default — @action is needed for @runAfter references.
      const defaultName = `Initialize_${varName}`;
      const skipActionName = shouldSkipActionName('initializevariable') && name === defaultName;

      const hasRunAfter = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (!skipActionName && (name !== defaultName || hasRunAfter || needsOriginalName || extraAnnotations.length > 0 || node.description || node.trackedProperties || node.metadata || valueArrayForm)) {
        lines.push(`${indent}${buildJSDocComment(name, {
          runAfter: node.runAfter,
          previousActionName,
          originalName: needsOriginalName ? varName : undefined,
          runtimeConfiguration: node.runtimeConfiguration,
          trackedProperties: node.trackedProperties,
          description: node.description,
          metadata: node.metadata,
          valueArrayForm,
          extraAnnotations: extraAnnotations.length > 0 ? extraAnnotations : undefined
        })}`);
      } else if (skipActionName && (hasRunAfter || extraAnnotations.length > 0 || node.description || node.trackedProperties || node.metadata || node.runtimeConfiguration || valueArrayForm)) {
        // Still emit JSDoc for other metadata, but without @action
        lines.push(`${indent}${buildJSDocComment(name, {
          runAfter: node.runAfter,
          previousActionName,
          runtimeConfiguration: node.runtimeConfiguration,
          trackedProperties: node.trackedProperties,
          description: node.description,
          metadata: node.metadata,
          valueArrayForm,
          extraAnnotations: extraAnnotations.length > 0 ? extraAnnotations : undefined,
          includeAction: false
        })}`);
      }
      lines.push(`${indent}let ${sanitized}: ${tsType} = ${formatValueOrExpression(varValue, indent, variableMap)};`);
      break;
    }

    case 'setvariable': {
      const varName = inputs.name || 'var';
      const value = inputs.value;
      const sanitized = variableMap?.[varName]?.sanitized || sanitizeName(varName);
      const valueArrayForm = detectValueArrayForm(value);
      const canonical = variableMap?.[varName]?.canonicalOriginalName;
      const varNameCase = canonical && canonical !== varName ? varName : undefined;
      // Skip @action annotation when name matches default pattern (Set_{varName} or Set_{varName}_{N})
      const defaultNamePattern = new RegExp(`^Set_${varName}(_\\d+)?$`);
      const isDefaultName = defaultNamePattern.test(name);
      const skipAction = shouldSkipActionName('setvariable') && isDefaultName;
      const hasRunAfter = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (!skipAction && (name !== `Set_${varName}` || !isDefaultName || hasRunAfter || node.description || node.trackedProperties || node.metadata || valueArrayForm || varNameCase)) {
        const jsDoc = buildJSDocComment(name, {
          runAfter: node.runAfter,
          previousActionName,
          runtimeConfiguration: node.runtimeConfiguration,
          trackedProperties: node.trackedProperties,
          description: node.description,
          metadata: node.metadata,
          valueArrayForm,
          varNameCase,
        });
        if (jsDoc) {
          lines.push(`${indent}${jsDoc}`);
        }
      } else if (skipAction && (hasRunAfter || node.description || node.trackedProperties || node.metadata || node.runtimeConfiguration || valueArrayForm || varNameCase)) {
        const jsDoc = buildJSDocComment(name, {
          runAfter: node.runAfter,
          previousActionName,
          runtimeConfiguration: node.runtimeConfiguration,
          trackedProperties: node.trackedProperties,
          description: node.description,
          metadata: node.metadata,
          valueArrayForm,
          varNameCase,
          includeAction: false
        });
        if (jsDoc) {
          lines.push(`${indent}${jsDoc}`);
        }
      }
      lines.push(`${indent}${sanitized} = ${formatValueOrExpression(value, indent, variableMap)};`);
      break;
    }

    case 'incrementvariable': {
      const varName = inputs.name || 'var';
      const value = inputs.value !== undefined ? inputs.value : 1;
      const sanitized = variableMap?.[varName]?.sanitized || sanitizeName(varName);
      const incrementValue = formatValueOrExpression(value, indent, variableMap);
      // Skip @action annotation when name matches default pattern (Increment_{varName} or Increment_{varName}_{N})
      const defaultNamePattern = new RegExp(`^Increment_${varName}(_\\d+)?$`);
      const isDefaultName = defaultNamePattern.test(name);
      const skipAction = shouldSkipActionName('incrementvariable') && isDefaultName;
      const hasRunAfter = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (!skipAction && (name !== `Increment_${varName}` || !isDefaultName || hasRunAfter || node.description || node.trackedProperties || node.metadata)) {
        const jsDoc = buildJSDocComment(name, {
          runAfter: node.runAfter,
          previousActionName,
          runtimeConfiguration: node.runtimeConfiguration,
          trackedProperties: node.trackedProperties,
          description: node.description,
          metadata: node.metadata,
        });
        if (jsDoc) {
          lines.push(`${indent}${jsDoc}`);
        }
      } else if (skipAction && (hasRunAfter || node.description || node.trackedProperties || node.metadata || node.runtimeConfiguration)) {
        const jsDoc = buildJSDocComment(name, {
          runAfter: node.runAfter,
          previousActionName,
          runtimeConfiguration: node.runtimeConfiguration,
          trackedProperties: node.trackedProperties,
          description: node.description,
          metadata: node.metadata,
          includeAction: false
        });
        if (jsDoc) {
          lines.push(`${indent}${jsDoc}`);
        }
      }
      lines.push(`${indent}${sanitized} = ${sanitized} + ${incrementValue};`);
      break;
    }

    case 'decrementvariable': {
      const varName = inputs.name || 'var';
      const value = inputs.value !== undefined ? inputs.value : 1;
      const sanitized = variableMap?.[varName]?.sanitized || sanitizeName(varName);
      const decrementValue = formatValueOrExpression(value, indent, variableMap);
      // Skip @action annotation when name matches default pattern (Decrement_{varName} or Decrement_{varName}_{N})
      const defaultNamePattern = new RegExp(`^Decrement_${varName}(_\\d+)?$`);
      const isDefaultName = defaultNamePattern.test(name);
      const skipAction = shouldSkipActionName('decrementvariable') && isDefaultName;
      const hasRunAfter = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (!skipAction && (name !== `Decrement_${varName}` || !isDefaultName || hasRunAfter || node.description || node.trackedProperties || node.metadata)) {
        const jsDoc = buildJSDocComment(name, {
          runAfter: node.runAfter,
          previousActionName,
          runtimeConfiguration: node.runtimeConfiguration,
          trackedProperties: node.trackedProperties,
          description: node.description,
          metadata: node.metadata,
        });
        if (jsDoc) {
          lines.push(`${indent}${jsDoc}`);
        }
      } else if (skipAction && (hasRunAfter || node.description || node.trackedProperties || node.metadata || node.runtimeConfiguration)) {
        const jsDoc = buildJSDocComment(name, {
          runAfter: node.runAfter,
          previousActionName,
          runtimeConfiguration: node.runtimeConfiguration,
          trackedProperties: node.trackedProperties,
          description: node.description,
          metadata: node.metadata,
          includeAction: false
        });
        if (jsDoc) {
          lines.push(`${indent}${jsDoc}`);
        }
      }
      lines.push(`${indent}${sanitized} = ${sanitized} - ${decrementValue};`);
      break;
    }

    case 'appendtoarrayvariable': {
      const varName = inputs.name || 'var';
      const value = inputs.value;
      const sanitized = variableMap?.[varName]?.sanitized || sanitizeName(varName);
      const valueArrayForm = detectValueArrayForm(value);
      // Skip @action annotation when name matches default pattern (Append_{varName} or Append_{varName}_{N})
      const defaultNamePattern = new RegExp(`^Append_${varName}(_\\d+)?$`);
      const isDefaultName = defaultNamePattern.test(name);
      const skipAction = shouldSkipActionName('appendtoarrayvariable') && isDefaultName;
      const hasRunAfter = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (!skipAction && (name !== `Append_${varName}` || !isDefaultName || hasRunAfter || node.description || node.trackedProperties || node.metadata || valueArrayForm)) {
        const jsDoc = buildJSDocComment(name, {
          runAfter: node.runAfter,
          previousActionName,
          runtimeConfiguration: node.runtimeConfiguration,
          trackedProperties: node.trackedProperties,
          description: node.description,
          metadata: node.metadata,
          valueArrayForm,
        });
        if (jsDoc) {
          lines.push(`${indent}${jsDoc}`);
        }
      } else if (skipAction && (hasRunAfter || node.description || node.trackedProperties || node.metadata || node.runtimeConfiguration || valueArrayForm)) {
        const jsDoc = buildJSDocComment(name, {
          runAfter: node.runAfter,
          previousActionName,
          runtimeConfiguration: node.runtimeConfiguration,
          trackedProperties: node.trackedProperties,
          description: node.description,
          metadata: node.metadata,
          valueArrayForm,
          includeAction: false
        });
        if (jsDoc) {
          lines.push(`${indent}${jsDoc}`);
        }
      }
      lines.push(`${indent}${sanitized}.push(${formatValueOrExpression(value, indent, variableMap)});`);
      break;
    }

    case 'appendtostringvariable': {
      const varName = inputs.name || 'var';
      const value = inputs.value;
      // Skip @action annotation when name matches default pattern (Append_{varName} or Append_{varName}_{N})
      const defaultNamePatternStr = new RegExp(`^Append_${varName}(_\\d+)?$`);
      const isDefaultNameStr = defaultNamePatternStr.test(name);
      const skipAction = shouldSkipActionName('appendtostringvariable') && isDefaultNameStr;
      const hasRunAfter = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (!skipAction && (name !== `Append_${varName}` || !isDefaultNameStr || hasRunAfter || node.description || node.trackedProperties || node.metadata)) {
        const jsDoc = buildJSDocComment(name, {
          runAfter: node.runAfter,
          previousActionName,
          runtimeConfiguration: node.runtimeConfiguration,
          trackedProperties: node.trackedProperties,
          description: node.description,
          metadata: node.metadata,
        });
        if (jsDoc) {
          lines.push(`${indent}${jsDoc}`);
        }
      } else if (skipAction && (hasRunAfter || node.description || node.trackedProperties || node.metadata || node.runtimeConfiguration)) {
        const jsDoc = buildJSDocComment(name, {
          runAfter: node.runAfter,
          previousActionName,
          runtimeConfiguration: node.runtimeConfiguration,
          trackedProperties: node.trackedProperties,
          description: node.description,
          metadata: node.metadata,
          includeAction: false
        });
        if (jsDoc) {
          lines.push(`${indent}${jsDoc}`);
        }
      }
      lines.push(`${indent}await ctx.appendToStringVariable('${varName}', ${formatValueOrExpression(value, indent, variableMap)});`);
      break;
    }

    case 'response': {
      const statusCode = inputs.statusCode || 200;
      const body = inputs.body;
      const headers = inputs.headers;
      const schema = inputs.schema;
      const kind = inputs.kind;
      const hasHeaders = headers && Object.keys(headers).length > 0;
      const hasSchema = schema !== undefined;
      const hasKind = kind && (kind === 'VirtualAgent' || kind === 'PowerApp');

      // Build args: ctx.response(name, statusCode, body?, headers?, schema?, kind?)
      // Positional args require placeholders when later args exist
      const args: string[] = [`"${escapeString(name)}"`, String(statusCode)];

      // Body: include if present, or placeholder if headers/schema/kind exist
      if (body !== undefined) {
        args.push(formatValue(body, indent, variableMap));
      } else if (hasHeaders || hasSchema || hasKind) {
        args.push('undefined');
      }

      // Headers: include if present, or placeholder if schema/kind exist
      if (hasHeaders) {
        args.push(formatValue(headers, indent, variableMap));
      } else if (hasSchema || hasKind) {
        args.push('undefined');
      }

      // Schema: include if present, or placeholder if kind exists
      if (hasSchema) {
        args.push(formatValue(schema, indent, variableMap));
      } else if (hasKind) {
        args.push('undefined');
      }

      // Kind: include if present
      if (hasKind) {
        args.push(`"${kind}"`);
      }

      const runAfterTags = generateRunAfterTags(node.runAfter, previousActionName, indent);
      const operationOptions = (node as any).operationOptions as string | undefined;
      if (runAfterTags || node.runtimeConfiguration || node.trackedProperties || node.description || node.metadata || operationOptions) {
        lines.push(`${indent}${buildJSDocComment(name, { runAfter: node.runAfter, previousActionName, indent, runtimeConfiguration: node.runtimeConfiguration, trackedProperties: node.trackedProperties, description: node.description, metadata: node.metadata, operationOptions, includeAction: false })}`);
      }
      lines.push(`${indent}await ctx.response(${args.join(', ')});`);
      break;
    }

    case 'terminate': {
      const status = inputs.runStatus || 'Succeeded';
      const error = inputs.runError;
      const runAfterTags = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (runAfterTags || node.runtimeConfiguration || node.trackedProperties || node.description || node.metadata) {
        lines.push(`${indent}${buildJSDocComment(name, { runAfter: node.runAfter, previousActionName, indent, runtimeConfiguration: node.runtimeConfiguration, trackedProperties: node.trackedProperties, description: node.description, metadata: node.metadata, includeAction: false })}`);
      }
      if (error) {
        lines.push(`${indent}await ctx.terminate("${escapeString(name)}", "${escapeString(status)}", ${formatValue(error, indent, variableMap)});`);
      } else {
        lines.push(`${indent}await ctx.terminate("${escapeString(name)}", "${escapeString(status)}");`);
      }
      break;
    }

    case 'delay': {
      const interval = inputs.interval || {};
      const count = interval.count || 1;
      const unit = interval.unit || 'Second';
      const runAfterTags = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (runAfterTags || node.runtimeConfiguration || node.trackedProperties || node.description || node.metadata) {
        lines.push(`${indent}${buildJSDocComment(name, { runAfter: node.runAfter, previousActionName, indent, runtimeConfiguration: node.runtimeConfiguration, trackedProperties: node.trackedProperties, description: node.description, metadata: node.metadata, includeAction: false })}`);
      }
      lines.push(`${indent}await ctx.delay("${escapeString(name)}", ${formatValue(count, indent, variableMap)}, "${unit}");`);
      break;
    }

    case 'delayuntil': {
      const until = inputs.until?.timestamp || '';
      const runAfterTags = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (runAfterTags || node.runtimeConfiguration || node.trackedProperties || node.description || node.metadata) {
        lines.push(`${indent}${buildJSDocComment(name, { runAfter: node.runAfter, previousActionName, indent, runtimeConfiguration: node.runtimeConfiguration, trackedProperties: node.trackedProperties, description: node.description, metadata: node.metadata, includeAction: false })}`);
      }
      lines.push(`${indent}await ctx.delayUntil("${escapeString(name)}", ${formatValueOrExpression(until, indent, variableMap)});`);
      break;
    }

    case 'parsejson': {
      const content = inputs.from;
      const schema = inputs.schema;
      const args: string[] = [`"${escapeString(name)}"`, formatValue(content, indent, variableMap)];
      if (schema) args.push(formatValue(schema, indent, variableMap));
      const runAfterTags = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (runAfterTags || node.runtimeConfiguration || node.trackedProperties || node.description || node.metadata) {
        lines.push(`${indent}${buildJSDocComment(name, { runAfter: node.runAfter, previousActionName, indent, runtimeConfiguration: node.runtimeConfiguration, trackedProperties: node.trackedProperties, description: node.description, metadata: node.metadata, includeAction: false })}`);
      }
      lines.push(`${indent}await ctx.parseJson(${args.join(', ')});`);
      break;
    }

    case 'join': {
      const from = inputs.from;
      const joinWith = inputs.joinWith || '';
      const runAfterTags = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (runAfterTags || node.runtimeConfiguration || node.trackedProperties || node.description || node.metadata) {
        lines.push(`${indent}${buildJSDocComment(name, { runAfter: node.runAfter, previousActionName, indent, runtimeConfiguration: node.runtimeConfiguration, trackedProperties: node.trackedProperties, description: node.description, metadata: node.metadata, includeAction: false })}`);
      }
      lines.push(`${indent}await ctx.join("${escapeString(name)}", ${formatValue(from, indent, variableMap)}, "${escapeString(joinWith)}");`);
      break;
    }

    case 'select': {
      const from = inputs.from;
      const select = inputs.select;
      const runAfterTags = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (runAfterTags || node.runtimeConfiguration || node.trackedProperties || node.description || node.metadata) {
        lines.push(`${indent}${buildJSDocComment(name, { runAfter: node.runAfter, previousActionName, indent, runtimeConfiguration: node.runtimeConfiguration, trackedProperties: node.trackedProperties, description: node.description, metadata: node.metadata, includeAction: false })}`);
      }
      lines.push(`${indent}await ctx.select("${escapeString(name)}", ${formatValue(from, indent, variableMap)}, ${formatValue(select, indent, variableMap)});`);
      break;
    }

    case 'filterarray': {
      const from = inputs.from;
      const where = inputs.where || '';
      const runAfterTags = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (runAfterTags || node.runtimeConfiguration || node.trackedProperties || node.description || node.metadata) {
        lines.push(`${indent}${buildJSDocComment(name, { runAfter: node.runAfter, previousActionName, indent, runtimeConfiguration: node.runtimeConfiguration, trackedProperties: node.trackedProperties, description: node.description, metadata: node.metadata, includeAction: false })}`);
      }
      lines.push(`${indent}await ctx.filterArray("${escapeString(name)}", ${formatValue(from, indent, variableMap)}, "${escapeString(where)}");`);
      break;
    }

    case 'createcsvtable': {
      const from = inputs.from;
      const columns = inputs.columns;
      const args: string[] = [`"${escapeString(name)}"`, formatValue(from, indent, variableMap)];
      if (columns) args.push(formatValue(columns, indent, variableMap));
      const runAfterTags = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (runAfterTags || node.runtimeConfiguration || node.trackedProperties || node.description || node.metadata) {
        lines.push(`${indent}${buildJSDocComment(name, { runAfter: node.runAfter, previousActionName, indent, runtimeConfiguration: node.runtimeConfiguration, trackedProperties: node.trackedProperties, description: node.description, metadata: node.metadata, includeAction: false })}`);
      }
      lines.push(`${indent}await ctx.createCsvTable(${args.join(', ')});`);
      break;
    }

    case 'createhtmltable': {
      const from = inputs.from;
      const columns = inputs.columns;
      const args: string[] = [`"${escapeString(name)}"`, formatValue(from, indent, variableMap)];
      if (columns) args.push(formatValue(columns, indent, variableMap));
      const runAfterTags = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (runAfterTags || node.runtimeConfiguration || node.trackedProperties || node.description || node.metadata) {
        lines.push(`${indent}${buildJSDocComment(name, { runAfter: node.runAfter, previousActionName, indent, runtimeConfiguration: node.runtimeConfiguration, trackedProperties: node.trackedProperties, description: node.description, metadata: node.metadata, includeAction: false })}`);
      }
      lines.push(`${indent}await ctx.createHtmlTable(${args.join(', ')});`);
      break;
    }

    case 'workflow': {
      const rawRef = inputs.workflowReferenceName || inputs.workflowId || '';
      let workflowRef = rawRef;

      // If childFlows are defined, try to use name instead of GUID
      if (currentChildFlows) {
        // If rawRef is already a name in childFlows, keep it
        if (currentChildFlows[rawRef]) {
          workflowRef = rawRef;
        } else {
          // Try to find by GUID match
          for (const [name, def] of Object.entries(currentChildFlows)) {
            if ((def as any).workflowId === rawRef) {
              workflowRef = name;
              break;
            }
          }
        }
      }
      const body = inputs.body;
      const headers = inputs.headers;
      const args: string[] = [`"${escapeString(name)}"`, `"${escapeString(workflowRef)}"`];
      if (body !== undefined) args.push(formatValue(body, indent, variableMap));
      if (headers && Object.keys(headers).length > 0) args.push(formatValue(headers, indent, variableMap));
      const runAfterTags = generateRunAfterTags(node.runAfter, previousActionName, indent);
      if (runAfterTags || node.runtimeConfiguration || node.retryPolicy || node.limit || node.trackedProperties || node.description || node.metadata) {
        lines.push(`${indent}${buildJSDocComment(name, { runAfter: node.runAfter, previousActionName, indent, runtimeConfiguration: node.runtimeConfiguration, retryPolicy: node.retryPolicy, limit: node.limit, trackedProperties: node.trackedProperties, description: node.description, metadata: node.metadata, includeAction: false })}`);
      }
      lines.push(`${indent}await ctx.callWorkflow(${args.join(', ')});`);
      break;
    }

    default:
      lines.push(`${indent}// Unknown action kind: ${kind}`);
      lines.push(`${indent}await ctx.compose("${escapeString(name)}", ${formatValue(inputs, indent, variableMap)});`);
  }

  return lines;
}

function generateConnectorStatement(node: ConnectorActionNode, indent: string, previousActionName?: string, variableMap?: VariableNameMap): string[] {
  const lines: string[] = [];
  const connector = node.connector || 'unknown';
  const operation = node.operation || 'unknown';
  const rawParams = node.params || {};
  // Unflatten "parent/child" keys to nested objects for cleaner DSL
  const params = needsUnflattening(rawParams) ? unflattenParams(rawParams) : rawParams;
  const connRef = node.connectionReferenceName;
  // Omit the default `@parameters('$authentication')` — the emitter re-injects it when missing,
  // so dropping it here keeps generated DSL clean without affecting Logic Apps JSON output.
  const rawAuthentication = (node as any).authentication;
  const authentication = rawAuthentication === DEFAULT_CONNECTOR_AUTHENTICATION ? undefined : rawAuthentication;
  const paramsOmitted = (node as any).paramsOmitted as boolean | undefined;

  // Add JSDoc if runAfter, runtimeConfiguration, retryPolicy, limit, trackedProperties, description, metadata, paramsOmitted, or operationOptions is present
  const runAfterTags = generateRunAfterTags(node.runAfter, previousActionName, indent);
  const connectorOperationOptions = (node as any).operationOptions as string | undefined;
  if (runAfterTags || node.runtimeConfiguration || node.retryPolicy || node.limit || node.trackedProperties || node.description || node.metadata || paramsOmitted || connectorOperationOptions) {
    lines.push(`${indent}${buildJSDocComment(node.name, { runAfter: node.runAfter, previousActionName, indent, runtimeConfiguration: node.runtimeConfiguration, retryPolicy: node.retryPolicy, limit: node.limit, trackedProperties: node.trackedProperties, description: node.description, metadata: node.metadata, operationOptions: connectorOperationOptions, paramsOmitted, includeAction: false })}`);
  }

  // Use the new typed connector syntax: ctx.connectors.connector.Operation(name, params, connRef, authentication)
  const args: string[] = [
    `"${escapeString(node.name)}"`,
    formatValue(params, indent, variableMap),
  ];
  if (connRef || authentication) args.push(connRef ? `"${connRef}"` : 'undefined');
  if (authentication) {
    // Non-default @parameters(...) expressions still round-trip via ctx.parameters(...)
    const authValue = typeof authentication === 'string' && authentication.startsWith('@parameters')
      ? `ctx.parameters('$authentication')`
      : formatValue(authentication, indent, variableMap);
    args.push(authValue);
  }

  // Use bracket notation if connector or operation name contains invalid JS identifier characters (e.g., hyphens)
  const connectorAccess = isValidJsIdentifier(connector)
    ? `.${connector}`
    : `['${escapeString(connector)}']`;
  const operationAccess = isValidJsIdentifier(operation)
    ? `.${operation}`
    : `['${escapeString(operation)}']`;
  lines.push(`${indent}await ctx.connectors${connectorAccess}${operationAccess}(${args.join(', ')});`);
  return lines;
}

function generateConnectorWebhookStatement(node: ConnectorWebhookActionNode, indent: string, previousActionName?: string, variableMap?: VariableNameMap): string[] {
  const lines: string[] = [];
  const connector = node.connector || 'unknown';
  const operation = node.operation || 'unknown';
  const rawParams = node.params || {};
  // Unflatten "parent/child" keys to nested objects for cleaner DSL
  const params = needsUnflattening(rawParams) ? unflattenParams(rawParams) : rawParams;
  const connRef = node.connectionReferenceName;
  const rawAuthentication = (node as any).authentication;
  const authentication = rawAuthentication === DEFAULT_CONNECTOR_AUTHENTICATION ? undefined : rawAuthentication;

  // Add JSDoc if runAfter, runtimeConfiguration, retryPolicy, limit, trackedProperties, description, or metadata is present
  const runAfterTags = generateRunAfterTags(node.runAfter, previousActionName, indent);
  if (runAfterTags || node.runtimeConfiguration || node.retryPolicy || node.limit || node.trackedProperties || node.description || node.metadata) {
    lines.push(`${indent}${buildJSDocComment(node.name, { runAfter: node.runAfter, previousActionName, indent, runtimeConfiguration: node.runtimeConfiguration, retryPolicy: node.retryPolicy, limit: node.limit, trackedProperties: node.trackedProperties, description: node.description, metadata: node.metadata, includeAction: false })}`);
  }

  // Webhook connectors use a special method
  const args: string[] = [
    `"${escapeString(node.name)}"`,
    `"${connector}"`,
    `"${operation}"`,
    formatValue(params, indent, variableMap),
  ];
  if (connRef || authentication) args.push(connRef ? `"${connRef}"` : 'undefined');
  if (authentication) {
    const authValue = typeof authentication === 'string' && authentication.startsWith('@parameters')
      ? `ctx.parameters('$authentication')`
      : formatValue(authentication, indent, variableMap);
    args.push(authValue);
  }

  lines.push(`${indent}await ctx.connectorWebhook(${args.join(', ')});`);
  return lines;
}

function generateScopeStatement(node: ScopeNode, indent: string, previousActionName?: string, variableMap?: VariableNameMap): string[] {
  const lines: string[] = [];

  lines.push(`${indent}${buildJSDocComment(node.name, {
    type: 'scope',
    description: node.description,
    runAfter: node.runAfter,
    previousActionName,
    indent,
    runtimeConfiguration: node.runtimeConfiguration,
    trackedProperties: node.trackedProperties,
    metadata: node.metadata
  })}`);
  lines.push(`${indent}{`);

  // Track previous action name within the scope
  let innerPreviousActionName: string | undefined;
  for (const innerNode of node.actions || []) {
    const innerLines = generateNodeStatement(innerNode, indent + "  ", innerPreviousActionName, variableMap);
    lines.push(...innerLines);
    innerPreviousActionName = innerNode.name;
  }

  lines.push(`${indent}}`);
  return lines;
}

function generateIfStatement(node: IfNode, indent: string, previousActionName?: string, variableMap?: VariableNameMap): string[] {
  const lines: string[] = [];
  const condition = node.condition || '@true';

  // Parse the condition to TypeScript
  const parsedCondition = parseExpressionToTypeScript(condition, getExpressionOptions(variableMap));

  // Generate the if statement with JSDoc @action annotation
  lines.push(`${indent}${buildJSDocComment(node.name, {
    type: 'if',
    description: node.description,
    runAfter: node.runAfter,
    previousActionName,
    indent,
    runtimeConfiguration: node.runtimeConfiguration,
    trackedProperties: node.trackedProperties,
    metadata: node.metadata,
    conditionFormat: node.conditionFormat
  })}`);
  if (!parsedCondition.success) {
    lines.push(`${indent}// Original condition: ${condition}`);
  }
  lines.push(`${indent}if (${parsedCondition.code}) {`);

  // Track previous action name within the if block
  let innerPreviousActionName: string | undefined;
  for (const innerNode of node.actions || []) {
    const innerLines = generateNodeStatement(innerNode, indent + "  ", innerPreviousActionName, variableMap);
    lines.push(...innerLines);
    innerPreviousActionName = innerNode.name;
  }

  // Emit else block if it exists (even if empty, for parity)
  if (node.elseActions !== undefined) {
    lines.push(`${indent}} else {`);
    if (node.elseActions.length > 0) {
      // Track previous action name within the else block (reset)
      let elsePreviousActionName: string | undefined;
      for (const innerNode of node.elseActions) {
        const innerLines = generateNodeStatement(innerNode, indent + "  ", elsePreviousActionName, variableMap);
        lines.push(...innerLines);
        elsePreviousActionName = innerNode.name;
      }
    } else {
      // Empty else block - add comment to preserve it
      lines.push(`${indent}  // empty else`);
    }
    lines.push(`${indent}}`);
  } else {
    lines.push(`${indent}}`);
  }

  return lines;
}

function generateForeachStatement(node: ForeachNode, indent: string, previousActionName?: string, variableMap?: VariableNameMap): string[] {
  const lines: string[] = [];
  const itemsExpr = node.itemsExpression || '@items()';

  // Derive a unique variable name for this loop
  const varName = deriveLoopVariableName(node.name);

  // Parse the items expression with the CURRENT (parent) loop context.
  // This allows items('OuterLoop') in the items expression to resolve to the outer variable.
  const parsedItems = parseItemsExpressionToTypeScript(itemsExpr, getExpressionOptions(variableMap));

  // Don't add automatic null coalescing - preserve the original expression
  const itemsCode = parsedItems.code;

  // Generate the foreach with JSDoc @action annotation
  const foreachExtraAnnotations: string[] = [];
  const foreachTypeCase = (node as any).typeCase as string | undefined;
  if (foreachTypeCase) {
    foreachExtraAnnotations.push(`@typeCase ${JSON.stringify(foreachTypeCase)}`);
  }
  lines.push(`${indent}${buildJSDocComment(node.name, {
    type: 'foreach',
    description: node.description,
    runAfter: node.runAfter,
    trackedProperties: node.trackedProperties,
    metadata: node.metadata,
    previousActionName,
    indent,
    runtimeConfiguration: node.runtimeConfiguration,
    extraAnnotations: foreachExtraAnnotations.length > 0 ? foreachExtraAnnotations : undefined
  })}`);
  if (!parsedItems.success) {
    lines.push(`${indent}// Original items: ${itemsExpr}`);
  }
  lines.push(`${indent}for (const ${varName} of ${itemsCode}) {`);

  // Save parent loop context and set new context for the loop body
  const parentLoopMap = currentLoopMap;
  const parentLoopVar = currentLoopVarName;
  currentLoopMap = new Map(parentLoopMap);
  currentLoopMap.set(node.name, varName);
  currentLoopVarName = varName;

  // Track previous action name within the foreach block
  let innerPreviousActionName: string | undefined;
  for (const innerNode of node.actions || []) {
    const innerLines = generateNodeStatement(innerNode, indent + "  ", innerPreviousActionName, variableMap);
    lines.push(...innerLines);
    innerPreviousActionName = innerNode.name;
  }

  // Restore parent loop context
  currentLoopMap = parentLoopMap;
  currentLoopVarName = parentLoopVar;

  lines.push(`${indent}}`);
  return lines;
}

function generateSwitchStatement(node: SwitchNode, indent: string, previousActionName?: string, variableMap?: VariableNameMap): string[] {
  const lines: string[] = [];
  const expression = node.expression || '@true';

  // Parse the switch expression to TypeScript
  const parsedExpr = parseSwitchExpressionToTypeScript(expression, variableMap);

  // Generate the switch with JSDoc @action annotation
  lines.push(`${indent}${buildJSDocComment(node.name, {
    type: 'switch',
    description: node.description,
    runAfter: node.runAfter,
    previousActionName,
    indent,
    runtimeConfiguration: node.runtimeConfiguration,
    trackedProperties: node.trackedProperties,
    metadata: node.metadata
  })}`);
  if (!parsedExpr.success) {
    lines.push(`${indent}// Original expression: ${expression}`);
  }
  lines.push(`${indent}switch (${parsedExpr.code}) {`);

  for (const switchCase of node.cases || []) {
    const caseValue = switchCase.value;
    const caseName = switchCase.name || `Case_${caseValue}`;
    lines.push(`${indent}  /** @action ${caseName} @type case */`);
    lines.push(`${indent}  case ${formatValue(caseValue, indent, variableMap)}:`);
    // Track previous action name within the case block
    let casePreviousActionName: string | undefined;
    for (const innerNode of switchCase.actions || []) {
      const innerLines = generateNodeStatement(innerNode, indent + '    ', casePreviousActionName, variableMap);
      lines.push(...innerLines);
      casePreviousActionName = innerNode.name;
    }
  }

  // Emit default case if it exists (even if empty, to preserve parity)
  if (node.defaultActions !== undefined) {
    lines.push(`${indent}  /** @action default @type case */`);
    lines.push(`${indent}  default:`);
    if (node.defaultActions.length > 0) {
      // Track previous action name within the default block
      let defaultPreviousActionName: string | undefined;
      for (const innerNode of node.defaultActions) {
        const innerLines = generateNodeStatement(innerNode, indent + '    ', defaultPreviousActionName, variableMap);
        lines.push(...innerLines);
        defaultPreviousActionName = innerNode.name;
      }
    }
  }

  lines.push(`${indent}}`);
  return lines;
}

function generateDoUntilStatement(node: DoUntilNode, indent: string, previousActionName?: string, variableMap?: VariableNameMap): string[] {
  const lines: string[] = [];
  const condition = node.condition || '@true';

  // Build limit object with count and timeout for preservation
  const limitObj: { count?: number; timeout?: string } = {};
  if (node.limit !== undefined) limitObj.count = node.limit;
  if (node.timeout !== undefined) limitObj.timeout = node.timeout;

  // Parse the condition to TypeScript
  // Note: DoUntil loops until condition is true, so we need to negate it for while
  const parsedCondition = parseExpressionToTypeScript(condition, getExpressionOptions(variableMap));

  // Generate the do-until with JSDoc @action annotation (includes limit for metadata)
  lines.push(`${indent}${buildJSDocComment(node.name, {
    type: 'dountil',
    description: node.description,
    limit: Object.keys(limitObj).length > 0 ? limitObj : undefined,
    runAfter: node.runAfter,
    previousActionName,
    indent,
    runtimeConfiguration: node.runtimeConfiguration,
    trackedProperties: node.trackedProperties,
    metadata: node.metadata
  })}`);
  if (!parsedCondition.success) {
    lines.push(`${indent}// Original until condition: ${condition}`);
  }
  lines.push(`${indent}do {`);

  // Track previous action name within the do-until block
  let innerPreviousActionName: string | undefined;
  for (const innerNode of node.actions || []) {
    const innerLines = generateNodeStatement(innerNode, indent + "  ", innerPreviousActionName, variableMap);
    lines.push(...innerLines);
    innerPreviousActionName = innerNode.name;
  }

  // DoUntil loops until condition is true, so we continue while NOT condition
  lines.push(`${indent}} while (!(${parsedCondition.code}));`);
  return lines;
}

