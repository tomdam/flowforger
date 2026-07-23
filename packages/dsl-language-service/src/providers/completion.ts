/**
 * Completion provider for DSL autocomplete.
 * This module provides completion items for ctx.* methods and connectors.
 */

import type {
  CompletionItem,
  CompletionItemKind,
  CompletionContext,
  CompletionTriggerKind,
  MethodSignature,
  ParameterInfo,
} from '../types.js';
import { flowContextMethods, getCategories } from '../data/flow-context-methods.js';
import {
  connectorOperations,
  getConnectorNames,
  getConnectorOperations,
} from '../data/connector-operations.js';
import {
  getConnectorMetadata,
  getConnectorOperationsFromRegistry,
  getRegisteredConnectorNames,
} from '../data/connector-registry.js';
import type { OperationMetadata } from '@flowforger/connectors-shared';

/**
 * Generate markdown documentation for a method.
 */
function generateMethodDoc(method: MethodSignature): string {
  const lines: string[] = [];

  // Description
  lines.push(method.description);
  lines.push('');

  // Parameters
  if (method.parameters.length > 0) {
    lines.push('**Parameters:**');
    for (const param of method.parameters) {
      const optional = param.optional ? '?' : '';
      lines.push(`- \`${param.name}${optional}: ${param.type}\` - ${param.description}`);
    }
    lines.push('');
  }

  // Return type
  lines.push(`**Returns:** \`${method.returnType}\``);

  // Examples
  if (method.examples && method.examples.length > 0) {
    lines.push('');
    lines.push('**Example:**');
    lines.push('```typescript');
    lines.push(method.examples[0]);
    lines.push('```');
  }

  // Deprecation
  if (method.deprecated) {
    lines.push('');
    lines.push(`**Deprecated:** ${method.deprecationMessage || 'This method is deprecated.'}`);
  }

  return lines.join('\n');
}

/**
 * Generate parameter snippet for a method.
 */
function generateParameterSnippet(params: ParameterInfo[]): string {
  if (params.length === 0) {
    return '()';
  }

  const snippetParts: string[] = [];
  let index = 1;

  for (const param of params) {
    if (param.optional) continue; // Skip optional params in snippet

    if (param.type === 'string') {
      snippetParts.push(`'\${${index}:${param.name}}'`);
    } else if (param.type === 'HttpInputs') {
      snippetParts.push(`{\n  method: '\${${index}:GET}',\n  url: '\${${index + 1}:url}'\n}`);
      index++;
    } else if (param.type.includes('Params')) {
      snippetParts.push(`{\n  \${${index}:...}\n}`);
    } else {
      snippetParts.push(`\${${index}:${param.name}}`);
    }
    index++;
  }

  return `(${snippetParts.join(', ')})`;
}

/**
 * Generate method signature for detail display.
 */
function generateMethodSignature(method: MethodSignature): string {
  const params = method.parameters.map((p) => {
    const optional = p.optional ? '?' : '';
    return `${p.name}${optional}: ${p.type}`;
  });
  return `(${params.join(', ')}): ${method.returnType}`;
}

/**
 * Get completion items for ctx.* methods.
 */
export function getContextMethodCompletions(): CompletionItem[] {
  const items: CompletionItem[] = [];

  for (const method of flowContextMethods) {
    const item: CompletionItem = {
      label: method.name,
      kind: 'method' as CompletionItemKind,
      detail: generateMethodSignature(method),
      documentation: {
        value: generateMethodDoc(method),
        isTrusted: true,
      },
      insertText: method.name + generateParameterSnippet(method.parameters),
      insertTextIsSnippet: true,
      sortText: getSortText(method),
      tags: method.deprecated ? [{ valueOf: () => 'deprecated' } as any] : undefined,
    };

    items.push(item);
  }

  return items;
}

/**
 * Get sort text to order completions by category.
 */
function getSortText(method: MethodSignature): string {
  const categoryOrder: Record<string, string> = {
    Reference: '0',
    Action: '1',
    SharePoint: '2',
    Dataverse: '3',
    Office365: '4',
    Connector: '5',
    DateTime: '6',
    Collection: '7',
    String: '8',
    Math: '9',
    Logical: 'a',
    Conversion: 'b',
    Object: 'c',
    Uri: 'd',
    Workflow: 'e',
    Expression: 'f',
    Utility: 'g',
  };

  const prefix = categoryOrder[method.category || ''] || 'z';
  const deprecatedSuffix = method.deprecated ? 'z' : 'a';
  return `${prefix}${deprecatedSuffix}_${method.name}`;
}

/**
 * Get completion items for connector names (ctx.connectors.*).
 */
export function getConnectorNameCompletions(): CompletionItem[] {
  // Try registry first (new metadata-driven approach)
  const registryNames = getRegisteredConnectorNames();
  if (registryNames.length > 0) {
    return registryNames.map((name) => {
      const metadata = getConnectorMetadata(name);
      return {
        label: name,
        kind: 'module' as CompletionItemKind,
        detail: metadata?.displayName || `${name} connector`,
        documentation: {
          value: metadata
            ? `**${metadata.displayName}**\n\n${metadata.description}\n\n**Usage:**\n\`\`\`typescript\nctx.connectors.${name}.Operation('actionName', params)\n\`\`\``
            : `Access ${name} connector operations.\n\nUsage: \`ctx.connectors.${name}.Operation('name', params)\``,
          isTrusted: true,
        },
        insertText: name,
        sortText: `0_${name}`,
      };
    });
  }

  // Fallback to legacy connector names
  const connectorNames = getConnectorNames();
  return connectorNames.map((name) => ({
    label: name,
    kind: 'module' as CompletionItemKind,
    detail: `${name} connector`,
    documentation: {
      value: `Access ${name} connector operations.\n\nUsage: \`ctx.connectors.${name}.Operation('name', params)\``,
      isTrusted: true,
    },
    insertText: name,
    sortText: `0_${name}`,
  }));
}

/**
 * Get completion items for connector operations (ctx.connectors.{connector}.*).
 */
export function getConnectorOperationCompletions(connectorName: string): CompletionItem[] {
  // Try registry first (new metadata-driven approach)
  const registryOps = getConnectorOperationsFromRegistry(connectorName);
  if (registryOps.length > 0) {
    return registryOps.map((op) => {
      const params = op.parameters.map((p) => {
        const optional = p.required ? '' : '?';
        return `${p.name}${optional}: ${p.type}`;
      });

      return {
        label: op.name,
        kind: 'method' as CompletionItemKind,
        detail: `(${params.join(', ')}): ${op.returnType || 'void'}`,
        documentation: {
          value: generateRegistryOperationDoc(op, connectorName),
          isTrusted: true,
        },
        insertText: `${op.name}('\${1:actionName}', {\n  \${2}\n})`,
        insertTextIsSnippet: true,
        sortText: `0_${op.name}`,
      };
    });
  }

  // Fallback to legacy operations
  const operations = getConnectorOperations(connectorName);
  return operations.map((op) => {
    const params = op.parameters.map((p) => {
      const optional = p.optional ? '?' : '';
      return `${p.name}${optional}: ${p.type}`;
    });

    return {
      label: op.operation,
      kind: 'method' as CompletionItemKind,
      detail: `(${params.join(', ')}): Promise<any>`,
      documentation: {
        value: generateOperationDoc(op),
        isTrusted: true,
      },
      insertText: `${op.operation}('\${1:actionName}', {\n  \${2:...}\n})`,
      insertTextIsSnippet: true,
      sortText: `0_${op.operation}`,
    };
  });
}

/**
 * Generate documentation for a registry operation (new metadata format).
 */
function generateRegistryOperationDoc(op: OperationMetadata, connectorName: string): string {
  const lines: string[] = [];

  lines.push(`**${op.name}**`);
  lines.push('');
  lines.push(op.description);
  lines.push('');

  if (op.parameters.length > 0) {
    lines.push('**Parameters:**');
    for (const param of op.parameters) {
      const optional = param.required ? '' : '?';
      lines.push(`- \`${param.name}${optional}: ${param.type}\` - ${param.description}`);
    }
    lines.push('');
  }

  if (op.category) {
    lines.push(`**Category:** ${op.category}`);
    lines.push('');
  }

  if (op.examples && op.examples.length > 0) {
    lines.push('**Example:**');
    lines.push('```typescript');
    lines.push(op.examples[0]);
    lines.push('```');
  }

  return lines.join('\n');
}

/**
 * Generate documentation for a connector operation.
 */
function generateOperationDoc(op: { description: string; parameters: ParameterInfo[] }): string {
  const lines: string[] = [];

  lines.push(op.description);
  lines.push('');

  if (op.parameters.length > 0) {
    lines.push('**Parameters:**');
    for (const param of op.parameters) {
      const optional = param.optional ? '?' : '';
      lines.push(`- \`${param.name}${optional}: ${param.type}\` - ${param.description}`);
    }
  }

  return lines.join('\n');
}

/**
 * Get completion items for OData builder methods (ctx.odata.*).
 */
export function getODataBuilderCompletions(): CompletionItem[] {
  const methods = [
    { name: 'eq', desc: 'Equal: field eq value', params: 'field, value' },
    { name: 'ne', desc: 'Not equal: field ne value', params: 'field, value' },
    { name: 'gt', desc: 'Greater than: field gt value', params: 'field, value' },
    { name: 'ge', desc: 'Greater than or equal: field ge value', params: 'field, value' },
    { name: 'lt', desc: 'Less than: field lt value', params: 'field, value' },
    { name: 'le', desc: 'Less than or equal: field le value', params: 'field, value' },
    { name: 'and', desc: 'Logical AND: expr1 and expr2 and ...', params: '...expressions' },
    { name: 'or', desc: 'Logical OR: expr1 or expr2 or ...', params: '...expressions' },
    { name: 'not', desc: 'Logical NOT: not expr', params: 'expression' },
    { name: 'contains', desc: 'Contains: contains(field, value)', params: 'field, value' },
    { name: 'startsWith', desc: 'Starts with: startswith(field, value)', params: 'field, value' },
    { name: 'endsWith', desc: 'Ends with: endswith(field, value)', params: 'field, value' },
    { name: 'isNull', desc: 'Is null: field eq null', params: 'field' },
    { name: 'isNotNull', desc: 'Is not null: field ne null', params: 'field' },
    { name: 'raw', desc: 'Raw OData expression string', params: 'expression' },
  ];

  return methods.map((m) => ({
    label: m.name,
    kind: 'method' as CompletionItemKind,
    detail: `(${m.params}): ODataExpression`,
    documentation: {
      value: m.desc,
      isTrusted: true,
    },
    insertText: m.params.includes('...')
      ? `${m.name}(\${1:expression})`
      : m.params.includes(',')
        ? `${m.name}('\${1:field}', \${2:value})`
        : `${m.name}('\${1:${m.params}}')`,
    insertTextIsSnippet: true,
    sortText: `0_${m.name}`,
  }));
}

/**
 * Completion context types for determining what completions to show.
 */
export enum CompletionType {
  /** After ctx. */
  ContextMethods = 'context_methods',
  /** After ctx.connectors. */
  ConnectorNames = 'connector_names',
  /** After ctx.connectors.{connector}. */
  ConnectorOperations = 'connector_operations',
  /** After ctx.odata. */
  ODataMethods = 'odata_methods',
  /** Inside body('...' */
  ActionName = 'action_name',
  /** Inside variables('...' */
  VariableName = 'variable_name',
  /** Inside items('...' */
  LoopName = 'loop_name',
  /** Inside parameters('...' */
  ParameterName = 'parameter_name',
  /** Connection reference name in connector calls */
  ConnectionReferenceName = 'connection_reference_name',
  /** Child flow name in callWorkflow second argument */
  ChildFlowName = 'child_flow_name',
  /** Child flow parameter key in callWorkflow body object */
  ChildFlowParameter = 'child_flow_parameter',
  /** No specific completion context */
  None = 'none',
}

/**
 * Analyze text to determine what type of completion is needed.
 */
export function analyzeCompletionContext(
  textBeforeCursor: string
): { type: CompletionType; connectorName?: string; childFlowName?: string } {
  // Check for ctx.connectors.{connector}.
  const connectorOpMatch = textBeforeCursor.match(/ctx\.connectors\.(\w+)\.\s*$/);
  if (connectorOpMatch) {
    return { type: CompletionType.ConnectorOperations, connectorName: connectorOpMatch[1] };
  }

  // Check for ctx.connectors.
  if (/ctx\.connectors\.\s*$/.test(textBeforeCursor)) {
    return { type: CompletionType.ConnectorNames };
  }

  // Check for ctx.odata.
  if (/ctx\.odata\.\s*$/.test(textBeforeCursor)) {
    return { type: CompletionType.ODataMethods };
  }

  // Check for ctx.
  if (/ctx\.\s*$/.test(textBeforeCursor)) {
    return { type: CompletionType.ContextMethods };
  }

  // Check for body('
  if (/body\s*\(\s*['"]$/.test(textBeforeCursor)) {
    return { type: CompletionType.ActionName };
  }

  // Check for outputs('
  if (/outputs\s*\(\s*['"]$/.test(textBeforeCursor)) {
    return { type: CompletionType.ActionName };
  }

  // Check for actions('
  if (/actions\s*\(\s*['"]$/.test(textBeforeCursor)) {
    return { type: CompletionType.ActionName };
  }

  // Check for variables('
  if (/variables\s*\(\s*['"]$/.test(textBeforeCursor)) {
    return { type: CompletionType.VariableName };
  }

  // Check for items('
  if (/items\s*\(\s*['"]$/.test(textBeforeCursor)) {
    return { type: CompletionType.LoopName };
  }

  // Check for parameters('
  if (/parameters\s*\(\s*['"]$/.test(textBeforeCursor)) {
    return { type: CompletionType.ParameterName };
  }

  // Inside callWorkflow second argument: callWorkflow("name", "
  if (/callWorkflow\s*\(\s*(['"][^'"]*['"]\s*,\s*['"])$/.test(textBeforeCursor)) {
    return { type: CompletionType.ChildFlowName };
  }

  // Inside callWorkflow body object: callWorkflow("name", "ChildFlow", { ... })
  // Detect when cursor is inside the 3rd argument object literal
  const childFlowParamMatch = textBeforeCursor.match(
    /callWorkflow\s*\(\s*['"][^'"]*['"]\s*,\s*['"]([^'"]*)['"]\s*,\s*\{([\s\S]*)$/
  );
  if (childFlowParamMatch) {
    const afterOpenBrace = childFlowParamMatch[2];
    // Count braces/parens to ensure we're at the top level of the body object
    let braceDepth = 0;
    let parenDepth = 0;
    let inString: string | null = null;
    for (const ch of afterOpenBrace) {
      if (inString) {
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue; }
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
      if (ch === '(') parenDepth++;
      if (ch === ')') parenDepth--;
    }
    // braceDepth === 0 means we're at the top level of the body object (the opening { is not counted)
    if (braceDepth === 0 && parenDepth >= 0) {
      // Check we're at a key position (after { or , possibly with whitespace)
      const trimmed = afterOpenBrace.trimEnd();
      if (trimmed.length === 0 || trimmed[trimmed.length - 1] === ',') {
        return { type: CompletionType.ChildFlowParameter, childFlowName: childFlowParamMatch[1] };
      }
    }
  }

  // Check for connection reference name in connector calls
  // Connection references are the last argument after closing a params object
  // Pattern: }, ' or },  ' at the end (we just closed an object and started a string)
  if (/\}\s*,\s*['"]$/.test(textBeforeCursor)) {
    // Verify we're in a connector call context (look for ctx.connectors. or ctx.connector( earlier)
    if (/ctx\.connectors\.\w+\.\w+\s*\(/.test(textBeforeCursor) ||
        /ctx\.connector\s*\(/.test(textBeforeCursor) ||
        /ctx\.connectorWebhook\s*\(/.test(textBeforeCursor)) {
      return { type: CompletionType.ConnectionReferenceName };
    }
  }

  return { type: CompletionType.None };
}

/**
 * Get completions based on the context.
 */
export function getCompletions(
  textBeforeCursor: string,
  actionNames?: string[],
  variableNames?: string[],
  loopNames?: string[],
  parameterNames?: string[],
  connectionReferenceNames?: string[],
  childFlowNames?: string[]
): CompletionItem[] {
  const context = analyzeCompletionContext(textBeforeCursor);

  switch (context.type) {
    case CompletionType.ContextMethods:
      return getContextMethodCompletions();

    case CompletionType.ConnectorNames:
      return getConnectorNameCompletions();

    case CompletionType.ConnectorOperations:
      return getConnectorOperationCompletions(context.connectorName || '');

    case CompletionType.ODataMethods:
      return getODataBuilderCompletions();

    case CompletionType.ActionName:
      return (actionNames || []).map((name) => ({
        label: name,
        kind: 'reference' as CompletionItemKind,
        detail: 'Action',
        insertText: name,
        sortText: `0_${name}`,
      }));

    case CompletionType.VariableName:
      return (variableNames || []).map((name) => ({
        label: name,
        kind: 'variable' as CompletionItemKind,
        detail: 'Variable',
        insertText: name,
        sortText: `0_${name}`,
      }));

    case CompletionType.LoopName:
      return (loopNames || []).map((name) => ({
        label: name,
        kind: 'variable' as CompletionItemKind,
        detail: 'Loop',
        insertText: name,
        sortText: `0_${name}`,
      }));

    case CompletionType.ParameterName:
      return (parameterNames || []).map((name) => ({
        label: name,
        kind: 'property' as CompletionItemKind,
        detail: 'Flow Parameter',
        documentation: {
          value: `Flow parameter: ${name}\n\nDefined in the constructor via \`ctx.flow.parameters\``,
          isTrusted: true,
        },
        insertText: name,
        sortText: `0_${name}`,
      }));

    case CompletionType.ConnectionReferenceName:
      return (connectionReferenceNames || []).map((name) => ({
        label: name,
        kind: 'reference' as CompletionItemKind,
        detail: 'Connection Reference',
        documentation: {
          value: `Connection reference: ${name}\n\nDefined in the constructor via \`ctx.flow.connectionReferences\``,
          isTrusted: true,
        },
        insertText: name,
        sortText: `0_${name}`,
      }));

    case CompletionType.ChildFlowName:
      return (childFlowNames || []).map((name) => ({
        label: name,
        kind: 'reference' as CompletionItemKind,
        detail: 'Child Flow',
        insertText: name,
        sortText: `0_${name}`,
      }));

    case CompletionType.ChildFlowParameter:
      // Handled by Monaco provider with full symbol index access
      return [];

    default:
      return [];
  }
}
