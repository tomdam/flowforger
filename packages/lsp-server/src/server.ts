/**
 * FlowForger DSL Language Server
 *
 * Implements the Language Server Protocol for FlowForger DSL files (.ff.ts).
 * Provides autocomplete, diagnostics, hover, and go-to-definition.
 */

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionItem,
  CompletionItemKind as LSPCompletionItemKind,
  Diagnostic as LSPDiagnostic,
  DiagnosticSeverity as LSPDiagnosticSeverity,
  Hover,
  MarkupKind,
  TextDocumentPositionParams,
  CompletionParams,
  Location,
} from 'vscode-languageserver/node.js';

import { TextDocument } from 'vscode-languageserver-textdocument';

import ts from 'typescript';
import { getTypeScriptDiagnostics, removeDocument } from './embedded-ts/service.js';

import {
  analyzeCompletionContext,
  CompletionType,
  flowContextMethods,
  getConnectorNames,
  getConnectorOperations,
  buildSymbolIndex,
  getActionNamesAtLine,
  getVariableNamesAtLine,
  getAllLoopNames,
  getAllParameterNames,
  getAllConnectionReferenceNames,
  getDiagnostics,
  getConnectorMetadata,
  getOperationMetadata,
  getRegisteredConnectorNames,
  detectStringReference,
  findAction,
  findVariable,
  type Diagnostic,
  type SymbolIndex,
} from '@flowforger/dsl-language-service';

// Create a connection for the server using Node IPC or stdio
const connection = createConnection(ProposedFeatures.all);

// Create a document manager
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Cache for symbol indices (per document URI)
const symbolIndexCache: Map<string, SymbolIndex> = new Map();

connection.onInitialize((params: InitializeParams): InitializeResult => {
  connection.console.log('FlowForger LSP Server initializing...');

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ['.', "'", '"'],
      },
      hoverProvider: true,
      definitionProvider: true,
      // Future: referencesProvider, etc.
    },
  };
});

connection.onInitialized(() => {
  connection.console.log('FlowForger LSP Server initialized');
});

// Validate documents when they change
documents.onDidChangeContent((change) => {
  validateDocument(change.document);
});

// Clear cache when document closes
documents.onDidClose((event) => {
  symbolIndexCache.delete(event.document.uri);
  removeDocument(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

/**
 * Validate a document and send diagnostics.
 */
async function validateDocument(document: TextDocument): Promise<void> {
  const text = document.getText();

  // Skip non-FlowForger files
  if (!isFlowForgerFile(document.uri, text)) {
    return;
  }

  // Build symbol index and cache it
  const symbolIndex = buildSymbolIndex(text);
  symbolIndexCache.set(document.uri, symbolIndex);

  // Get diagnostics from language service
  const dslDiagnostics = getDiagnostics(text);

  // Convert to LSP diagnostics
  const lspDiagnostics: LSPDiagnostic[] = dslDiagnostics.map((d) =>
    convertDiagnostic(d)
  );

  // Run the embedded TypeScript service for stock TS diagnostics (TS2451 redeclare,
  // TS2322 type-mismatch, etc.) — matches what Monaco shows in the web app.
  const tsDiagnostics = getTypeScriptDiagnostics(document.uri, text);
  for (const d of tsDiagnostics) {
    const converted = convertTsDiagnostic(document, d);
    if (converted) lspDiagnostics.push(converted);
  }

  // Send diagnostics to client
  connection.sendDiagnostics({
    uri: document.uri,
    diagnostics: lspDiagnostics,
  });
}

/**
 * Convert a TypeScript Diagnostic to an LSP Diagnostic.
 * Returns null if the diagnostic has no usable range (shouldn't happen for
 * the filtered set we surface, but defensive).
 */
function convertTsDiagnostic(
  document: TextDocument,
  d: ts.Diagnostic
): LSPDiagnostic | null {
  if (d.start === undefined || d.length === undefined) return null;
  const start = document.positionAt(d.start);
  const end = document.positionAt(d.start + d.length);
  return {
    severity: convertTsSeverity(d.category),
    range: { start, end },
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    source: 'ts',
    code: d.code,
  };
}

function convertTsSeverity(category: ts.DiagnosticCategory): LSPDiagnosticSeverity {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return LSPDiagnosticSeverity.Error;
    case ts.DiagnosticCategory.Warning:
      return LSPDiagnosticSeverity.Warning;
    case ts.DiagnosticCategory.Suggestion:
      return LSPDiagnosticSeverity.Hint;
    case ts.DiagnosticCategory.Message:
    default:
      return LSPDiagnosticSeverity.Information;
  }
}

/**
 * Check if a file is a FlowForger DSL file.
 */
function isFlowForgerFile(uri: string, content: string): boolean {
  // Check file extension
  if (uri.endsWith('.ff.ts')) {
    return true;
  }

  // Check for FlowForger imports or decorators
  if (
    content.includes('@flowforger/dsl-native') ||
    content.includes('@Flow(') ||
    content.includes('FlowContext')
  ) {
    return true;
  }

  return false;
}

/**
 * Convert DSL diagnostic to LSP diagnostic.
 */
function convertDiagnostic(diagnostic: Diagnostic): LSPDiagnostic {
  return {
    severity: convertSeverity(diagnostic.severity),
    range: {
      start: {
        line: diagnostic.range.start.line,
        character: diagnostic.range.start.character,
      },
      end: {
        line: diagnostic.range.end.line,
        character: diagnostic.range.end.character,
      },
    },
    message: diagnostic.message,
    source: diagnostic.source,
    code: diagnostic.code,
  };
}

/**
 * Convert severity string to LSP severity.
 */
function convertSeverity(
  severity: 'error' | 'warning' | 'info' | 'hint'
): LSPDiagnosticSeverity {
  switch (severity) {
    case 'error':
      return LSPDiagnosticSeverity.Error;
    case 'warning':
      return LSPDiagnosticSeverity.Warning;
    case 'info':
      return LSPDiagnosticSeverity.Information;
    case 'hint':
      return LSPDiagnosticSeverity.Hint;
    default:
      return LSPDiagnosticSeverity.Information;
  }
}

/**
 * Handle completion requests.
 */
connection.onCompletion((params: CompletionParams): CompletionItem[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const text = document.getText();

  // Skip non-FlowForger files
  if (!isFlowForgerFile(params.textDocument.uri, text)) {
    return [];
  }

  // Get text until cursor position
  const offset = document.offsetAt(params.position);
  const textUntilPosition = text.substring(
    document.offsetAt({ line: params.position.line, character: 0 }),
    offset
  );

  // Analyze completion context
  const completionContext = analyzeCompletionContext(textUntilPosition);

  // Get or build symbol index
  let symbolIndex = symbolIndexCache.get(params.textDocument.uri);
  if (!symbolIndex) {
    symbolIndex = buildSymbolIndex(text);
    symbolIndexCache.set(params.textDocument.uri, symbolIndex);
  }

  // Return completions based on context
  switch (completionContext.type) {
    case CompletionType.ContextMethods:
      return getContextMethodCompletions();

    case CompletionType.ConnectorNames:
      return getConnectorNameCompletions();

    case CompletionType.ConnectorOperations:
      return getConnectorOperationCompletions(
        completionContext.connectorName || ''
      );

    case CompletionType.ODataMethods:
      return getODataCompletions();

    case CompletionType.ActionName: {
      const actionNames = getActionNamesAtLine(
        symbolIndex,
        params.position.line
      );
      return getActionNameCompletions(actionNames, symbolIndex);
    }

    case CompletionType.VariableName: {
      const variableNames = getVariableNamesAtLine(
        symbolIndex,
        params.position.line
      );
      return getVariableNameCompletions(variableNames, symbolIndex);
    }

    case CompletionType.LoopName: {
      const loopNames = getAllLoopNames(symbolIndex);
      return getLoopNameCompletions(loopNames);
    }

    case CompletionType.ParameterName: {
      const parameterNames = getAllParameterNames(symbolIndex);
      return getParameterNameCompletions(parameterNames, symbolIndex);
    }

    case CompletionType.ConnectionReferenceName: {
      const connectionReferenceNames = getAllConnectionReferenceNames(symbolIndex);
      return getConnectionReferenceNameCompletions(connectionReferenceNames, symbolIndex);
    }

    default:
      return [];
  }
});

/**
 * Get completions for ctx.* methods.
 */
function getContextMethodCompletions(): CompletionItem[] {
  return flowContextMethods.map((method) => {
    const documentation = generateMethodDocumentation(method);

    return {
      label: method.name,
      kind: LSPCompletionItemKind.Method,
      detail: generateMethodDetail(method),
      documentation: {
        kind: MarkupKind.Markdown,
        value: documentation,
      },
      insertText: generateMethodInsertText(method),
      insertTextFormat: 2, // Snippet
      sortText: `${getCategorySortOrder(method.category)}${method.deprecated ? 'z' : 'a'}_${method.name}`,
      tags: method.deprecated ? [1] : undefined, // 1 = Deprecated
    };
  });
}

/**
 * Get completions for connector names.
 */
function getConnectorNameCompletions(): CompletionItem[] {
  return getConnectorNames().map((name) => ({
    label: name,
    kind: LSPCompletionItemKind.Module,
    detail: `${name} connector`,
    documentation: {
      kind: MarkupKind.Markdown,
      value: `Access ${name} connector operations.\n\n**Usage:**\n\`\`\`typescript\nctx.connectors.${name}.Operation('name', params)\n\`\`\``,
    },
    insertText: name,
    sortText: `0_${name}`,
  }));
}

/**
 * Get completions for connector operations.
 */
function getConnectorOperationCompletions(
  connectorName: string
): CompletionItem[] {
  const operations = getConnectorOperations(connectorName);

  return operations.map((op) => {
    const params = op.parameters.map((p) => {
      const optional = p.optional ? '?' : '';
      return `${p.name}${optional}: ${p.type}`;
    });

    const paramsDoc = op.parameters
      .map(
        (p) =>
          `- \`${p.name}${p.optional ? '?' : ''}: ${p.type}\` - ${p.description}`
      )
      .join('\n');

    return {
      label: op.operation,
      kind: LSPCompletionItemKind.Method,
      detail: `(${params.join(', ')}): Promise<any>`,
      documentation: {
        kind: MarkupKind.Markdown,
        value: `${op.description}\n\n**Parameters:**\n${paramsDoc}`,
      },
      insertText: `${op.operation}('\${1:actionName}', {\n  \${2}\n})`,
      insertTextFormat: 2, // Snippet
      sortText: `0_${op.operation}`,
    };
  });
}

/**
 * Get completions for OData builder methods.
 */
function getODataCompletions(): CompletionItem[] {
  const methods = [
    { name: 'eq', desc: 'Equal: field eq value', snippet: "eq('${1:field}', ${2:value})" },
    { name: 'ne', desc: 'Not equal: field ne value', snippet: "ne('${1:field}', ${2:value})" },
    { name: 'gt', desc: 'Greater than: field gt value', snippet: "gt('${1:field}', ${2:value})" },
    { name: 'ge', desc: 'Greater than or equal', snippet: "ge('${1:field}', ${2:value})" },
    { name: 'lt', desc: 'Less than: field lt value', snippet: "lt('${1:field}', ${2:value})" },
    { name: 'le', desc: 'Less than or equal', snippet: "le('${1:field}', ${2:value})" },
    { name: 'and', desc: 'Logical AND', snippet: 'and(${1:expr1}, ${2:expr2})' },
    { name: 'or', desc: 'Logical OR', snippet: 'or(${1:expr1}, ${2:expr2})' },
    { name: 'not', desc: 'Logical NOT', snippet: 'not(${1:expression})' },
    { name: 'contains', desc: 'Contains substring', snippet: "contains('${1:field}', ${2:value})" },
    { name: 'startsWith', desc: 'Starts with', snippet: "startsWith('${1:field}', ${2:value})" },
    { name: 'endsWith', desc: 'Ends with', snippet: "endsWith('${1:field}', ${2:value})" },
    { name: 'isNull', desc: 'Is null', snippet: "isNull('${1:field}')" },
    { name: 'isNotNull', desc: 'Is not null', snippet: "isNotNull('${1:field}')" },
    { name: 'raw', desc: 'Raw OData expression', snippet: "raw('${1:expression}')" },
  ];

  return methods.map((m) => ({
    label: m.name,
    kind: LSPCompletionItemKind.Method,
    detail: 'ODataExpression',
    documentation: { kind: MarkupKind.Markdown, value: m.desc },
    insertText: m.snippet,
    insertTextFormat: 2, // Snippet
    sortText: `0_${m.name}`,
  }));
}

/**
 * Get completions for action names.
 */
function getActionNameCompletions(
  actionNames: string[],
  symbolIndex: SymbolIndex
): CompletionItem[] {
  return actionNames.map((name) => {
    const action = symbolIndex.actions.find((a) => a.name === name);
    const actionType = action?.type || 'action';
    const line = action ? action.line + 1 : undefined;
    const detail = line ? `${actionType} (line ${line})` : actionType;

    return {
      label: name,
      kind: LSPCompletionItemKind.Reference,
      detail,
      documentation: action
        ? {
            kind: MarkupKind.Markdown,
            value: `**${name}**\n\nType: \`${actionType}\`\nDeclared at line ${line}${
              action.connector ? `\nConnector: ${action.connector}` : ''
            }${action.operation ? `\nOperation: ${action.operation}` : ''}`,
          }
        : undefined,
      insertText: name,
      sortText: `0_${name}`,
    };
  });
}

/**
 * Get completions for variable names.
 */
function getVariableNameCompletions(
  variableNames: string[],
  symbolIndex: SymbolIndex
): CompletionItem[] {
  return variableNames.map((name) => {
    const variable = symbolIndex.variables.find(
      (v) => v.name === name && v.isInitialDeclaration
    );
    const paType = variable?.paType || 'unknown';
    const line = variable ? variable.line + 1 : undefined;
    const detail = line ? `${paType} (line ${line})` : paType;

    return {
      label: name,
      kind: LSPCompletionItemKind.Variable,
      detail,
      documentation: variable
        ? {
            kind: MarkupKind.Markdown,
            value: `**${name}**\n\nType: \`${paType}\`\nDeclared at line ${line}${
              variable.initialValue !== undefined
                ? `\nInitial value: \`${JSON.stringify(variable.initialValue)}\``
                : ''
            }`,
          }
        : undefined,
      insertText: name,
      sortText: `0_${name}`,
    };
  });
}

/**
 * Get completions for loop names.
 */
function getLoopNameCompletions(loopNames: string[]): CompletionItem[] {
  return loopNames.map((name, index) => ({
    label: name,
    kind: LSPCompletionItemKind.Variable,
    detail: `Loop ${index + 1}`,
    documentation: {
      kind: MarkupKind.Markdown,
      value: `Access the current item from loop **${name}**.\n\nUsed with \`ctx.items('${name}')\` for nested loop scenarios.`,
    },
    insertText: name,
    sortText: `0_${name}`,
  }));
}

/**
 * Get completions for parameter names.
 */
function getParameterNameCompletions(
  parameterNames: string[],
  symbolIndex: SymbolIndex
): CompletionItem[] {
  return parameterNames.map((name) => {
    const param = symbolIndex.parameters.find((p) => p.name === name);
    const paramType = param?.type || 'unknown';
    const line = param ? param.line + 1 : undefined;
    const detail = line ? `${paramType} parameter (line ${line})` : `${paramType} parameter`;

    return {
      label: name,
      kind: LSPCompletionItemKind.Property,
      detail,
      documentation: param
        ? {
            kind: MarkupKind.Markdown,
            value: `**${name}**\n\nType: \`${paramType}\`\nDeclared at line ${line}\n\nDefined in constructor via \`ctx.flow.parameters\``,
          }
        : {
            kind: MarkupKind.Markdown,
            value: `Flow parameter: ${name}\n\nDefined in the constructor via \`ctx.flow.parameters\``,
          },
      insertText: name,
      sortText: `0_${name}`,
    };
  });
}

/**
 * Get completions for connection reference names.
 */
function getConnectionReferenceNameCompletions(
  connectionReferenceNames: string[],
  symbolIndex: SymbolIndex
): CompletionItem[] {
  return connectionReferenceNames.map((name) => {
    const connRef = symbolIndex.connectionReferences.find((c) => c.name === name);
    const line = connRef ? connRef.line + 1 : undefined;
    const detail = line ? `Connection Reference (line ${line})` : 'Connection Reference';

    return {
      label: name,
      kind: LSPCompletionItemKind.Reference,
      detail,
      documentation: connRef
        ? {
            kind: MarkupKind.Markdown,
            value: `**${name}**\n\nDeclared at line ${line}\n\nDefined in constructor via \`ctx.flow.connectionReferences\``,
          }
        : {
            kind: MarkupKind.Markdown,
            value: `Connection reference: ${name}\n\nDefined in the constructor via \`ctx.flow.connectionReferences\``,
          },
      insertText: name,
      sortText: `0_${name}`,
    };
  });
}

/**
 * Handle hover requests.
 */
connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const text = document.getText();

  // Skip non-FlowForger files
  if (!isFlowForgerFile(params.textDocument.uri, text)) {
    return null;
  }

  // Get word at position
  const word = getWordAtPosition(document, params.position);
  if (word) {
    // Check if it's a FlowContext method
    const method = flowContextMethods.find((m) => m.name === word.text);
    if (method) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**ctx.${method.name}**\n\n${generateMethodDocumentation(method)}`,
        },
        range: word.range,
      };
    }

    // Check if it's a connector operation (ctx.connectors.{connector}.{operation})
    const connectorOpHover = getConnectorOperationHover(document, params.position, word);
    if (connectorOpHover) {
      return connectorOpHover;
    }

    // Check if it's a connector name (ctx.connectors.{connector})
    const connectorHover = getConnectorHover(document, params.position, word);
    if (connectorHover) {
      return connectorHover;
    }

    // Check if it's a decorator
    const decorators: Record<string, string> = {
      Flow: 'Class decorator that marks a class as a Flow definition.\n\n`@Flow("FlowName")`',
      HttpTrigger:
        'Method decorator for HTTP Request trigger.\n\n`@HttpTrigger({ method: "POST", path: "/api/trigger" })`',
      ManualTrigger: 'Method decorator for Manual (Button) trigger.',
      RecurrenceTrigger:
        'Method decorator for scheduled/recurrence trigger.\n\n`@RecurrenceTrigger({ frequency: "Day", interval: 1 })`',
      ConnectorTrigger: 'Method decorator for connector-based triggers.',
      Action:
        'Method decorator that marks the main action method.\n\n`@Action()`',
      FlowContext:
        'Interface providing access to actions, references, and connectors.',
    };

    const decoratorDoc = decorators[word.text];
    if (decoratorDoc) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**@${word.text}**\n\n${decoratorDoc}`,
        },
        range: word.range,
      };
    }
  }

  // Check for string references (variables, actions, parameters, loops)
  const lines = text.split('\n');
  const lineText = lines[params.position.line];
  if (lineText) {
    const ref = detectStringReference(lineText, params.position.character);
    if (ref) {
      let symbolIndex = symbolIndexCache.get(params.textDocument.uri);
      if (!symbolIndex) {
        symbolIndex = buildSymbolIndex(text);
        symbolIndexCache.set(params.textDocument.uri, symbolIndex);
      }
      const hoverContent = buildReferenceHoverContent(ref, symbolIndex);
      if (hoverContent) {
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: hoverContent,
          },
          range: {
            start: { line: params.position.line, character: ref.nameStart },
            end: { line: params.position.line, character: ref.nameEnd },
          },
        };
      }
    }
  }

  return null;
});

/**
 * Handle go-to-definition requests (Ctrl+Click).
 */
connection.onDefinition((params: TextDocumentPositionParams): Location | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const text = document.getText();

  if (!isFlowForgerFile(params.textDocument.uri, text)) {
    return null;
  }

  // Get the line text and detect string reference
  const lines = text.split('\n');
  const lineText = lines[params.position.line];
  if (!lineText) return null;

  const ref = detectStringReference(lineText, params.position.character);
  if (!ref) return null;

  // Get or build symbol index
  let symbolIndex = symbolIndexCache.get(params.textDocument.uri);
  if (!symbolIndex) {
    symbolIndex = buildSymbolIndex(text);
    symbolIndexCache.set(params.textDocument.uri, symbolIndex);
  }

  switch (ref.type) {
    case 'variable': {
      const variable = findVariable(symbolIndex, ref.name);
      if (!variable) return null;
      return Location.create(params.textDocument.uri, {
        start: { line: variable.nameRange.start.line, character: variable.nameRange.start.character },
        end: { line: variable.nameRange.end.line, character: variable.nameRange.end.character },
      });
    }

    case 'action': {
      const action = findAction(symbolIndex, ref.name);
      if (!action) return null;
      return Location.create(params.textDocument.uri, {
        start: { line: action.nameRange.start.line, character: action.nameRange.start.character },
        end: { line: action.nameRange.end.line, character: action.nameRange.end.character },
      });
    }

    case 'parameter': {
      const param = symbolIndex.parameters.find(
        (p) => p.name.toLowerCase() === ref.name.toLowerCase()
      );
      if (!param) return null;
      return Location.create(params.textDocument.uri, {
        start: { line: param.range.start.line, character: param.range.start.character },
        end: { line: param.range.end.line, character: param.range.end.character },
      });
    }

    case 'loop': {
      const loopMatch = ref.name.match(/^Loop_(\d+)$/);
      if (!loopMatch) return null;
      const loopIndex = parseInt(loopMatch[1], 10) - 1;
      const loop = symbolIndex.loops[loopIndex];
      if (!loop) return null;
      return Location.create(params.textDocument.uri, {
        start: { line: loop.range.start.line, character: loop.range.start.character },
        end: { line: loop.range.start.line, character: loop.range.start.character + 3 },
      });
    }

    default:
      return null;
  }
});

/**
 * Get word at a position in a document.
 */
function getWordAtPosition(
  document: TextDocument,
  position: { line: number; character: number }
): { text: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } } | null {
  const text = document.getText();
  const lines = text.split('\n');
  const line = lines[position.line];

  if (!line) {
    return null;
  }

  // Find word boundaries
  let start = position.character;
  let end = position.character;

  while (start > 0 && /\w/.test(line[start - 1])) {
    start--;
  }

  while (end < line.length && /\w/.test(line[end])) {
    end++;
  }

  if (start === end) {
    return null;
  }

  return {
    text: line.substring(start, end),
    range: {
      start: { line: position.line, character: start },
      end: { line: position.line, character: end },
    },
  };
}

/**
 * Check if the word is a connector operation and return hover info.
 */
function getConnectorOperationHover(
  document: TextDocument,
  position: { line: number; character: number },
  word: { text: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }
): Hover | null {
  const text = document.getText();
  const lines = text.split('\n');
  const line = lines[position.line];
  if (!line) return null;

  // Look for pattern: ctx.connectors.{connector}.{word}
  const textBeforeWord = line.substring(0, word.range.start.character);
  const connectorMatch = textBeforeWord.match(/ctx\.connectors\.(\w+)\.\s*$/);

  if (connectorMatch) {
    const connectorName = connectorMatch[1];
    const operationName = word.text;

    // Try registry first
    const opMetadata = getOperationMetadata(connectorName, operationName);
    if (opMetadata) {
      const connector = getConnectorMetadata(connectorName);
      const displayName = connector?.displayName || connectorName;

      const lines: string[] = [];
      lines.push(`**${displayName}.${opMetadata.name}**`);
      lines.push('');
      lines.push(opMetadata.description);
      lines.push('');

      if (opMetadata.parameters.length > 0) {
        lines.push('**Parameters:**');
        for (const param of opMetadata.parameters) {
          const optional = param.required ? '' : '?';
          lines.push(`- \`${param.name}${optional}: ${param.type}\` - ${param.description}`);
        }
        lines.push('');
      }

      if (opMetadata.category) {
        lines.push(`**Category:** ${opMetadata.category}`);
        lines.push('');
      }

      if (opMetadata.examples && opMetadata.examples.length > 0) {
        lines.push('**Example:**');
        lines.push('```typescript');
        lines.push(opMetadata.examples[0]);
        lines.push('```');
      }

      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: lines.join('\n'),
        },
        range: word.range,
      };
    }

    // Fallback to legacy operations
    const operations = getConnectorOperations(connectorName);
    const op = operations.find(o => o.operation === operationName);
    if (op) {
      const params = op.parameters.map((p) => {
        const optional = p.optional ? '?' : '';
        return `\`${p.name}${optional}: ${p.type}\` - ${p.description}`;
      });

      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**${connectorName}.${op.operation}**\n\n${op.description}\n\n**Parameters:**\n${params.map(p => `- ${p}`).join('\n')}`,
        },
        range: word.range,
      };
    }
  }

  return null;
}

/**
 * Check if the word is a connector name and return hover info.
 */
function getConnectorHover(
  document: TextDocument,
  position: { line: number; character: number },
  word: { text: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }
): Hover | null {
  const text = document.getText();
  const lines = text.split('\n');
  const line = lines[position.line];
  if (!line) return null;

  // Look for pattern: ctx.connectors.{word}
  const textBeforeWord = line.substring(0, word.range.start.character);
  if (textBeforeWord.match(/ctx\.connectors\.\s*$/)) {
    const connectorName = word.text;

    // Check if it's a known connector (from registry or legacy)
    const allConnectors = [...getRegisteredConnectorNames(), ...getConnectorNames()];
    if (allConnectors.includes(connectorName)) {
      const metadata = getConnectorMetadata(connectorName);

      if (metadata) {
        const operationCount = metadata.operations.length;
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `**${metadata.displayName}**\n\n${metadata.description}\n\n*${operationCount} operations available*\n\n**Usage:**\n\`\`\`typescript\nctx.connectors.${connectorName}.Operation('actionName', params)\n\`\`\``,
          },
          range: word.range,
        };
      }

      // Fallback
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**${connectorName} Connector**\n\nAccess ${connectorName} connector operations.\n\n**Usage:**\n\`\`\`typescript\nctx.connectors.${connectorName}.Operation('actionName', params)\n\`\`\``,
        },
        range: word.range,
      };
    }
  }

  return null;
}

/**
 * Build markdown hover content for a string reference.
 */
function buildReferenceHoverContent(
  ref: { type: string; name: string },
  symbolIndex: SymbolIndex
): string | null {
  switch (ref.type) {
    case 'variable': {
      const variable = findVariable(symbolIndex, ref.name);
      if (!variable) return null;
      const line = variable.line + 1;
      const lines = [`**${variable.name}** (variable)`, ''];
      lines.push(`Type: \`${variable.paType}\``);
      if (variable.initialValue !== undefined) {
        lines.push(`Initial value: \`${JSON.stringify(variable.initialValue)}\``);
      }
      lines.push(`Declared at line ${line}`);
      return lines.join('\n');
    }

    case 'action': {
      const action = findAction(symbolIndex, ref.name);
      if (!action) return null;
      const line = action.line + 1;
      const typeLabel = action.connector ? 'connector action' : `${action.type} action`;
      const lines = [`**${action.name}** (${typeLabel})`, ''];
      lines.push(`Type: \`${action.type}\``);
      if (action.connector) {
        const parts = [action.connector];
        if (action.operation) parts.push(action.operation);
        lines.push(`Connector: ${parts.join(' \u00b7 ')}`);
      }
      lines.push(`Declared at line ${line}`);
      return lines.join('\n');
    }

    case 'parameter': {
      const param = symbolIndex.parameters.find(
        (p) => p.name.toLowerCase() === ref.name.toLowerCase()
      );
      if (!param) return null;
      const line = param.line + 1;
      const lines = [`**${param.name}** (parameter)`, ''];
      if (param.type) {
        lines.push(`Type: \`${param.type}\``);
      }
      lines.push(`Defined at line ${line}`);
      return lines.join('\n');
    }

    case 'loop': {
      const loopMatch = ref.name.match(/^Loop_(\d+)$/);
      if (!loopMatch) return null;
      const loopIndex = parseInt(loopMatch[1], 10) - 1;
      const loop = symbolIndex.loops[loopIndex];
      if (!loop) return null;
      const line = loop.line + 1;
      const lines = [`**${ref.name}** (foreach loop)`, ''];
      lines.push(`Variable: \`${loop.variableName}\``);
      lines.push(`Iterates: \`${loop.iteratedExpression}\``);
      lines.push(`Declared at line ${line}`);
      return lines.join('\n');
    }

    default:
      return null;
  }
}

// Helper interfaces and functions

interface MethodInfo {
  name: string;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    description: string;
    optional?: boolean;
  }>;
  returnType: string;
  examples?: string[];
  deprecated?: boolean;
  deprecationMessage?: string;
  category?: string;
}

/**
 * Generate method documentation markdown.
 */
function generateMethodDocumentation(method: MethodInfo): string {
  const lines: string[] = [];

  lines.push(method.description);
  lines.push('');

  if (method.parameters.length > 0) {
    lines.push('**Parameters:**');
    for (const param of method.parameters) {
      const optional = param.optional ? '?' : '';
      lines.push(
        `- \`${param.name}${optional}: ${param.type}\` - ${param.description}`
      );
    }
    lines.push('');
  }

  lines.push(`**Returns:** \`${method.returnType}\``);

  if (method.examples && method.examples.length > 0) {
    lines.push('');
    lines.push('**Example:**');
    lines.push('```typescript');
    lines.push(method.examples[0]);
    lines.push('```');
  }

  if (method.deprecated) {
    lines.push('');
    lines.push(
      `**Deprecated:** ${method.deprecationMessage || 'This method is deprecated.'}`
    );
  }

  return lines.join('\n');
}

/**
 * Generate method detail string.
 */
function generateMethodDetail(method: MethodInfo): string {
  const params = method.parameters.map((p) => {
    const optional = p.optional ? '?' : '';
    return `${p.name}${optional}: ${p.type}`;
  });
  return `(${params.join(', ')}): ${method.returnType}`;
}

/**
 * Generate insert text snippet for method.
 */
function generateMethodInsertText(method: MethodInfo): string {
  if (method.parameters.length === 0) {
    return `${method.name}()`;
  }

  const requiredParams = method.parameters.filter((p) => !p.optional);

  if (requiredParams.length === 0) {
    return `${method.name}()`;
  }

  const snippetParts: string[] = [];
  let index = 1;

  for (const param of requiredParams) {
    if (param.type === 'string') {
      snippetParts.push(`'\${${index}:${param.name}}'`);
    } else if (param.type === 'HttpInputs') {
      snippetParts.push(`{
  method: '\${${index}:GET}',
  url: '\${${index + 1}:url}'
}`);
      index++;
    } else if (param.type.endsWith('Params') || param.type === 'object') {
      snippetParts.push(`{
  \${${index}}
}`);
    } else {
      snippetParts.push(`\${${index}:${param.name}}`);
    }
    index++;
  }

  return `${method.name}(${snippetParts.join(', ')})`;
}

/**
 * Get sort order for method category.
 */
function getCategorySortOrder(category?: string): string {
  const order: Record<string, string> = {
    Reference: '0',
    Action: '1',
    SharePoint: '2',
    Dataverse: '3',
    Office365: '4',
    Connector: '5',
    DateTime: '6',
    Utility: '7',
  };
  return order[category || ''] || '9';
}

// Listen on documents
documents.listen(connection);

// Start the connection
connection.listen();
