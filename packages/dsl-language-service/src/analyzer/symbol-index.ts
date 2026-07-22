/**
 * Symbol Index - unified index for all symbols in DSL code.
 * Provides efficient lookup for actions, variables, loops, and other symbols.
 */

import ts from 'typescript';
import {
  parseSource,
  findFlowClass,
  findActionMethod,
  findTriggerMethod,
  getDecoratorArgument,
  findEnclosingForOfLoops,
  getForOfLoopVariable,
  getNodeRange,
  type SourcePosition,
  type SourceRange,
} from './dsl-parser.js';
import { findActions, type ActionDeclaration, getActionNames } from './action-finder.js';
import { findVariables, type VariableDeclaration, getVariableNames } from './variable-finder.js';

/**
 * Represents a for-of loop in the code.
 */
export interface LoopDeclaration {
  /** Variable name used in the loop (e.g., 'item' in 'for (const item of items)') */
  variableName: string;
  /** Expression being iterated (the 'items' part) */
  iteratedExpression: string;
  /** Source range of the loop */
  range: SourceRange;
  /** Line number */
  line: number;
}

/**
 * Information about the flow class.
 */
export interface FlowInfo {
  /** Flow name from @Flow decorator */
  name?: string;
  /** Whether a flow class exists */
  exists: boolean;
  /** Whether a trigger method exists */
  hasTrigger: boolean;
  /** Whether an action method exists */
  hasAction: boolean;
  /** Range of the flow class */
  classRange?: SourceRange;
  /** Range of the @Action method */
  actionMethodRange?: SourceRange;
}

/**
 * Represents a flow parameter defined in the constructor.
 */
export interface ParameterDeclaration {
  /** Parameter name */
  name: string;
  /** Parameter type (if available) */
  type?: string;
  /** Source range of the parameter definition */
  range: SourceRange;
  /** Line number */
  line: number;
}

/**
 * Represents a connection reference defined in the constructor.
 */
export interface ConnectionReferenceDeclaration {
  /** Connection reference name */
  name: string;
  /** Source range of the connection reference definition */
  range: SourceRange;
  /** Line number */
  line: number;
}

/**
 * Represents a child flow defined in the constructor.
 */
export interface ChildFlowDeclaration {
  /** Child flow name (key in ctx.flow.childFlows) */
  name: string;
  /** Workflow GUID */
  workflowId?: string;
  /** Description */
  description?: string;
  /** Parameter names with their titles */
  parameters?: Array<{ key: string; title: string; type: string; required: boolean }>;
  /** Source range of the child flow definition */
  range?: SourceRange;
  /** Line where this child flow is defined */
  line: number;
}

/**
 * Result of analyzing DSL source code.
 */
export interface SymbolIndex {
  /** All action declarations */
  actions: ActionDeclaration[];
  /** All variable declarations */
  variables: VariableDeclaration[];
  /** All for-of loops */
  loops: LoopDeclaration[];
  /** All flow parameters (from constructor ctx.flow.parameters) */
  parameters: ParameterDeclaration[];
  /** All connection references (from constructor ctx.flow.connectionReferences) */
  connectionReferences: ConnectionReferenceDeclaration[];
  /** All child flows (from constructor ctx.flow.childFlows) */
  childFlows: ChildFlowDeclaration[];
  /** Flow information */
  flow: FlowInfo;
  /** The parsed source file (for additional queries) */
  sourceFile: ts.SourceFile;
}

/**
 * Build a symbol index from source code.
 */
export function buildSymbolIndex(code: string): SymbolIndex {
  const sourceFile = parseSource(code);

  // Find actions and variables
  const actions = findActions(code);
  const variables = findVariables(code);

  // Find loops
  const loops = findLoops(sourceFile);

  // Find flow parameters
  const parameters = findParameters(sourceFile);

  // Find connection references
  const connectionReferences = findConnectionReferences(sourceFile);

  // Find child flows
  const childFlows = findChildFlows(sourceFile);

  // Find flow info
  const flow = extractFlowInfo(sourceFile);

  return {
    actions,
    variables,
    loops,
    parameters,
    connectionReferences,
    childFlows,
    flow,
    sourceFile,
  };
}

/**
 * Find all for-of loops in the source.
 */
function findLoops(sourceFile: ts.SourceFile): LoopDeclaration[] {
  const loops: LoopDeclaration[] = [];

  function visit(node: ts.Node): void {
    if (ts.isForOfStatement(node)) {
      const variableName = getForOfLoopVariable(node);
      if (variableName) {
        loops.push({
          variableName,
          iteratedExpression: node.expression.getText(sourceFile),
          range: getNodeRange(sourceFile, node),
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return loops;
}

/**
 * Find all flow parameters from the constructor.
 * Looks for: ctx.flow.parameters = { param1: {...}, param2: {...} }
 */
function findParameters(sourceFile: ts.SourceFile): ParameterDeclaration[] {
  const parameters: ParameterDeclaration[] = [];
  const flowClass = findFlowClass(sourceFile);

  if (!flowClass) {
    return parameters;
  }

  // Find the constructor
  for (const member of flowClass.members) {
    if (ts.isConstructorDeclaration(member) && member.body) {
      // Look for ctx.flow.parameters = {...} assignment
      for (const stmt of member.body.statements) {
        if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression)) {
          const binary = stmt.expression;
          if (binary.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const leftText = binary.left.getText(sourceFile);
            // Match ctx.flow.parameters or similar patterns
            if (/\w+\.flow\.parameters$/.test(leftText)) {
              // Extract parameter names from the object literal
              if (ts.isObjectLiteralExpression(binary.right)) {
                for (const prop of binary.right.properties) {
                  if (ts.isPropertyAssignment(prop)) {
                    let paramName: string;
                    if (ts.isIdentifier(prop.name)) {
                      paramName = prop.name.text;
                    } else if (ts.isStringLiteral(prop.name)) {
                      paramName = prop.name.text;
                    } else {
                      continue;
                    }

                    // Try to extract the type from the property value
                    let paramType: string | undefined;
                    if (ts.isObjectLiteralExpression(prop.initializer)) {
                      for (const innerProp of prop.initializer.properties) {
                        if (ts.isPropertyAssignment(innerProp) &&
                            ts.isIdentifier(innerProp.name) &&
                            innerProp.name.text === 'type' &&
                            ts.isStringLiteral(innerProp.initializer)) {
                          paramType = innerProp.initializer.text;
                        }
                      }
                    }

                    parameters.push({
                      name: paramName,
                      type: paramType,
                      range: getNodeRange(sourceFile, prop),
                      line: sourceFile.getLineAndCharacterOfPosition(prop.getStart(sourceFile)).line,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return parameters;
}

/**
 * Find all connection references from the constructor or actions method.
 * Looks for: ctx.flow.connectionReferences = { ref1: {...}, ref2: {...} }
 */
function findConnectionReferences(sourceFile: ts.SourceFile): ConnectionReferenceDeclaration[] {
  const connectionRefs: ConnectionReferenceDeclaration[] = [];
  const flowClass = findFlowClass(sourceFile);

  if (!flowClass) {
    return connectionRefs;
  }

  // Helper function to extract connection references from statements
  function extractFromStatements(statements: readonly ts.Statement[]): void {
    for (const stmt of statements) {
      if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression)) {
        const binary = stmt.expression;
        if (binary.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const leftText = binary.left.getText(sourceFile);
          // Match ctx.flow.connectionReferences or similar patterns
          if (/\w+\.flow\.connectionReferences$/.test(leftText)) {
            // Extract connection reference names from the object literal
            if (ts.isObjectLiteralExpression(binary.right)) {
              for (const prop of binary.right.properties) {
                if (ts.isPropertyAssignment(prop)) {
                  let refName: string;
                  if (ts.isIdentifier(prop.name)) {
                    refName = prop.name.text;
                  } else if (ts.isStringLiteral(prop.name)) {
                    refName = prop.name.text;
                  } else {
                    continue;
                  }

                  connectionRefs.push({
                    name: refName,
                    range: getNodeRange(sourceFile, prop),
                    line: sourceFile.getLineAndCharacterOfPosition(prop.getStart(sourceFile)).line,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  // Search in both constructor and actions method
  for (const member of flowClass.members) {
    // Check constructor
    if (ts.isConstructorDeclaration(member) && member.body) {
      extractFromStatements(member.body.statements);
    }

    // Check actions method (most common location)
    if (ts.isMethodDeclaration(member) &&
        ts.isIdentifier(member.name) &&
        member.name.text === 'actions' &&
        member.body) {
      extractFromStatements(member.body.statements);
    }
  }

  return connectionRefs;
}

/**
 * Find all child flows from the constructor.
 * Looks for: ctx.flow.childFlows = { childFlow1: {...}, childFlow2: {...} }
 */
function findChildFlows(sourceFile: ts.SourceFile): ChildFlowDeclaration[] {
  const childFlows: ChildFlowDeclaration[] = [];
  const flowClass = findFlowClass(sourceFile);

  if (!flowClass) {
    return childFlows;
  }

  // Find the constructor
  for (const member of flowClass.members) {
    if (ts.isConstructorDeclaration(member) && member.body) {
      // Look for ctx.flow.childFlows = {...} assignment
      for (const stmt of member.body.statements) {
        if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression)) {
          const binary = stmt.expression;
          if (binary.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const leftText = binary.left.getText(sourceFile);
            // Match ctx.flow.childFlows or similar patterns
            if (/\w+\.flow\.childFlows$/.test(leftText)) {
              // Extract child flow names from the object literal
              if (ts.isObjectLiteralExpression(binary.right)) {
                for (const prop of binary.right.properties) {
                  if (ts.isPropertyAssignment(prop)) {
                    let childFlowName: string;
                    if (ts.isIdentifier(prop.name)) {
                      childFlowName = prop.name.text;
                    } else if (ts.isStringLiteral(prop.name)) {
                      childFlowName = prop.name.text;
                    } else {
                      continue;
                    }

                    let workflowId: string | undefined;
                    let description: string | undefined;
                    let parameters: Array<{ key: string; title: string; type: string; required: boolean }> | undefined;

                    // Try to extract nested properties from the child flow object
                    if (ts.isObjectLiteralExpression(prop.initializer)) {
                      for (const innerProp of prop.initializer.properties) {
                        if (ts.isPropertyAssignment(innerProp) && ts.isIdentifier(innerProp.name)) {
                          if (innerProp.name.text === 'workflowId' && ts.isStringLiteral(innerProp.initializer)) {
                            workflowId = innerProp.initializer.text;
                          } else if (innerProp.name.text === 'description' && ts.isStringLiteral(innerProp.initializer)) {
                            description = innerProp.initializer.text;
                          } else if (innerProp.name.text === 'parameters' && ts.isObjectLiteralExpression(innerProp.initializer)) {
                            parameters = [];
                            for (const paramProp of innerProp.initializer.properties) {
                              if (ts.isPropertyAssignment(paramProp)) {
                                let paramKey: string;
                                if (ts.isIdentifier(paramProp.name)) {
                                  paramKey = paramProp.name.text;
                                } else if (ts.isStringLiteral(paramProp.name)) {
                                  paramKey = paramProp.name.text;
                                } else {
                                  continue;
                                }

                                let title = paramKey;
                                let type = 'string';
                                let required = false;

                                if (ts.isObjectLiteralExpression(paramProp.initializer)) {
                                  for (const subProp of paramProp.initializer.properties) {
                                    if (ts.isPropertyAssignment(subProp) && ts.isIdentifier(subProp.name)) {
                                      if (subProp.name.text === 'title' && ts.isStringLiteral(subProp.initializer)) {
                                        title = subProp.initializer.text;
                                      } else if (subProp.name.text === 'type' && ts.isStringLiteral(subProp.initializer)) {
                                        type = subProp.initializer.text;
                                      } else if (subProp.name.text === 'required') {
                                        if (subProp.initializer.kind === ts.SyntaxKind.TrueKeyword) {
                                          required = true;
                                        } else if (subProp.initializer.kind === ts.SyntaxKind.FalseKeyword) {
                                          required = false;
                                        }
                                      }
                                    }
                                  }
                                }

                                parameters.push({ key: paramKey, title, type, required });
                              }
                            }
                          }
                        }
                      }
                    }

                    childFlows.push({
                      name: childFlowName,
                      workflowId,
                      description,
                      parameters: parameters && parameters.length > 0 ? parameters : undefined,
                      range: getNodeRange(sourceFile, prop),
                      line: sourceFile.getLineAndCharacterOfPosition(prop.getStart(sourceFile)).line,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return childFlows;
}

/**
 * Extract flow information from source.
 */
function extractFlowInfo(sourceFile: ts.SourceFile): FlowInfo {
  const flowClass = findFlowClass(sourceFile);

  if (!flowClass) {
    return {
      exists: false,
      hasTrigger: false,
      hasAction: false,
    };
  }

  // Get flow name from decorator
  const flowNameArg = getDecoratorArgument(flowClass, 'Flow');
  let flowName: string | undefined;
  if (flowNameArg && ts.isStringLiteral(flowNameArg)) {
    flowName = flowNameArg.text;
  }

  const triggerMethod = findTriggerMethod(flowClass);
  const actionMethod = findActionMethod(flowClass);

  return {
    name: flowName,
    exists: true,
    hasTrigger: !!triggerMethod,
    hasAction: !!actionMethod,
    classRange: getNodeRange(sourceFile, flowClass),
    actionMethodRange: actionMethod ? getNodeRange(sourceFile, actionMethod) : undefined,
  };
}

/**
 * Get action names available at a specific line.
 * Only returns actions declared before the given line.
 * Returns unique names (case-insensitive deduplication).
 */
export function getActionNamesAtLine(index: SymbolIndex, line: number): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const action of index.actions) {
    if (action.line < line) {
      const lowerName = action.name.toLowerCase();
      if (!seen.has(lowerName)) {
        seen.add(lowerName);
        names.push(action.name);
      }
    }
  }

  return names;
}

/**
 * Get variable names available at a specific line.
 */
export function getVariableNamesAtLine(index: SymbolIndex, line: number): string[] {
  const names = new Set<string>();
  for (const v of index.variables) {
    if (v.isInitialDeclaration && v.line < line) {
      names.add(v.name);
    }
  }
  return Array.from(names);
}

/**
 * Get loop variable names available at a specific position.
 * Returns variables from enclosing for-of loops.
 */
export function getLoopVariablesAtPosition(
  index: SymbolIndex,
  position: SourcePosition
): string[] {
  const loops = findEnclosingForOfLoops(index.sourceFile, position);
  return loops
    .map((loop) => getForOfLoopVariable(loop))
    .filter((name): name is string => name !== undefined);
}

/**
 * Check if a position is inside a for-of loop.
 */
export function isInsideLoop(index: SymbolIndex, position: SourcePosition): boolean {
  const loops = findEnclosingForOfLoops(index.sourceFile, position);
  return loops.length > 0;
}

/**
 * Find an action by name (case-insensitive, matching Logic Apps behavior).
 */
export function findAction(index: SymbolIndex, name: string): ActionDeclaration | undefined {
  const lowerName = name.toLowerCase();
  return index.actions.find((a) => a.name.toLowerCase() === lowerName);
}

/**
 * Find a variable by name (case-insensitive, matching Logic Apps behavior).
 */
export function findVariable(
  index: SymbolIndex,
  name: string
): VariableDeclaration | undefined {
  const lowerName = name.toLowerCase();
  return index.variables.find((v) => v.name.toLowerCase() === lowerName && v.isInitialDeclaration);
}

/**
 * Check if an action name is valid (case-insensitive, matching Logic Apps behavior).
 */
export function isValidActionReference(
  index: SymbolIndex,
  name: string,
  atLine: number
): boolean {
  const lowerName = name.toLowerCase();
  return index.actions.some((a) => a.name.toLowerCase() === lowerName && a.line < atLine);
}

/**
 * Check if a variable name is valid (case-insensitive, matching Logic Apps behavior).
 */
export function isValidVariableReference(
  index: SymbolIndex,
  name: string,
  atLine: number
): boolean {
  const lowerName = name.toLowerCase();
  return index.variables.some(
    (v) => v.name.toLowerCase() === lowerName && v.isInitialDeclaration && v.line < atLine
  );
}

/**
 * Get all action names (simple array).
 */
export function getAllActionNames(index: SymbolIndex): string[] {
  return getActionNames(index.actions);
}

/**
 * Get all variable names (simple array).
 */
export function getAllVariableNames(index: SymbolIndex): string[] {
  return getVariableNames(index.variables);
}

/**
 * Get all loop names (for items() references).
 */
export function getAllLoopNames(index: SymbolIndex): string[] {
  // In dsl-native, loop names are derived from the variable name or can be
  // specified via JSDoc. For simplicity, we use the iterated expression
  // or generate names like "Loop_1", "Loop_2", etc.
  return index.loops.map((_, i) => `Loop_${i + 1}`);
}

/**
 * Get all parameter names (for parameters() references).
 */
export function getAllParameterNames(index: SymbolIndex): string[] {
  return index.parameters.map((p) => p.name);
}

/**
 * Get all connection reference names.
 */
export function getAllConnectionReferenceNames(index: SymbolIndex): string[] {
  return index.connectionReferences.map((c) => c.name);
}

/**
 * Get all child flow names.
 */
export function getAllChildFlowNames(index: SymbolIndex): string[] {
  return index.childFlows.map((cf) => cf.name);
}

/**
 * Find unused variables (declared but never referenced in variables()).
 * Uses case-insensitive matching to align with Logic Apps behavior.
 */
export function findUnusedVariables(index: SymbolIndex): VariableDeclaration[] {
  // `.text` (raw input), not `getText()` — see note in providers/diagnostics.ts:checkVariableReferences.
  const sourceText = index.sourceFile.text;
  // Store lowercase names for case-insensitive comparison
  const usedNames = new Set<string>();

  // Pattern 1: Direct variables() references
  // Example: ctx.variables('name') or variables('name')
  const variablesPattern = /variables\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = variablesPattern.exec(sourceText)) !== null) {
    usedNames.add(match[1].toLowerCase());
  }

  // Pattern 2: Inside ctx.eval() expressions with @{variables('name')}
  // Example: ctx.eval(`@{variables('projectPath')}`)
  const evalVariablesPattern = /ctx\.eval\s*\([^)]*@\{variables\s*\(\s*['"]([^'"]+)['"]\s*\)\}/g;
  while ((match = evalVariablesPattern.exec(sourceText)) !== null) {
    usedNames.add(match[1].toLowerCase());
  }

  // Pattern 3: Inside template literals with ${variables('name')}
  // Example: `some text ${variables('varName')} more text`
  const templateVariablesPattern = /\$\{[^}]*variables\s*\(\s*['"]([^'"]+)['"]\s*\)[^}]*\}/g;
  while ((match = templateVariablesPattern.exec(sourceText)) !== null) {
    usedNames.add(match[1].toLowerCase());
  }

  // Pattern 4: Inside string literals (for complex expressions)
  // Example: "@variables('name')" or "'@{variables('name')}'"
  const stringVariablesPattern = /['"]@?\{?variables\s*\(\s*['"]([^'"]+)['"]\s*\)\}?['"]/g;
  while ((match = stringVariablesPattern.exec(sourceText)) !== null) {
    usedNames.add(match[1].toLowerCase());
  }

  // Also check for direct variable usage (identifier references)
  const declarations = index.variables.filter((v) => v.isInitialDeclaration);
  for (const decl of declarations) {
    // Simple check: if the variable name appears elsewhere in the code (case-insensitive)
    const namePattern = new RegExp(`\\b${decl.name}\\b`, 'gi');
    const matches = sourceText.match(namePattern);
    // If it appears more than once (declaration + at least one usage)
    if (matches && matches.length > 1) {
      usedNames.add(decl.name.toLowerCase());
    }
  }

  return declarations.filter((v) => !usedNames.has(v.name.toLowerCase()));
}

/**
 * Find all comment ranges in the source file.
 * Returns an array of [start, end] positions for each comment.
 */
function findCommentRanges(sourceFile: ts.SourceFile): Array<[number, number]> {
  const sourceText = sourceFile.text;
  const ranges: Array<[number, number]> = [];

  // Match single-line comments (// ...) and multi-line comments (/* ... */ including JSDoc)
  const commentPattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  let match;
  while ((match = commentPattern.exec(sourceText)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }

  return ranges;
}

/**
 * Check if a position is inside any comment range.
 */
function isInComment(position: number, commentRanges: Array<[number, number]>): boolean {
  return commentRanges.some(([start, end]) => position >= start && position < end);
}

/**
 * Find invalid action references (body(), outputs(), actions() with non-existent action names).
 * Uses case-insensitive matching to align with Logic Apps behavior.
 * Skips references inside JSDoc comments (e.g., @description containing PA expressions).
 */
export function findInvalidActionReferences(
  index: SymbolIndex
): Array<{ name: string; range: SourceRange; line: number }> {
  const invalid: Array<{ name: string; range: SourceRange; line: number }> = [];
  const sourceText = index.sourceFile.text;
  // Store lowercase names for case-insensitive comparison
  const validNames = new Set(index.actions.map((a) => a.name.toLowerCase()));

  // Also include auto-generated variable action names (Initialize_, Set_, Increment_, etc.)
  const mutationCounters = new Map<string, number>();
  for (const variable of index.variables) {
    const name = variable.name.toLowerCase();
    if (variable.isInitialDeclaration) {
      validNames.add(`initialize_${name}`);
    } else {
      const current = mutationCounters.get(name) || 0;
      const next = current + 1;
      mutationCounters.set(name, next);
      const suffix = next === 1 ? '' : `_${next}`;
      validNames.add(`set_${name}${suffix}`);
      validNames.add(`increment_${name}${suffix}`);
      validNames.add(`decrement_${name}${suffix}`);
      validNames.add(`append_${name}${suffix}`);
    }
  }

  // Find all comment ranges to skip matches inside comments
  const commentRanges = findCommentRanges(index.sourceFile);

  // Find all body(), outputs(), actions() calls
  const patterns = [
    /body\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /outputs\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /actions\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(sourceText)) !== null) {
      // Skip matches inside comments (e.g., JSDoc @description with PA expressions)
      if (isInComment(match.index, commentRanges)) {
        continue;
      }

      const name = match[1];
      if (!validNames.has(name.toLowerCase())) {
        const startPos = index.sourceFile.getLineAndCharacterOfPosition(match.index);
        const endPos = index.sourceFile.getLineAndCharacterOfPosition(
          match.index + match[0].length
        );
        invalid.push({
          name,
          range: { start: startPos, end: endPos },
          line: startPos.line,
        });
      }
    }
  }

  return invalid;
}

/**
 * Find invalid parameter references (ctx.parameters() with non-existent parameter names).
 */
export function findInvalidParameterReferences(
  index: SymbolIndex
): Array<{ name: string; range: SourceRange; line: number }> {
  const invalid: Array<{ name: string; range: SourceRange; line: number }> = [];
  const sourceText = index.sourceFile.text;
  const validNames = new Set(index.parameters.map((p) => p.name));
  const commentRanges = findCommentRanges(index.sourceFile);

  // Find all ctx.parameters() or parameters() calls
  // Match patterns like: ctx.parameters('name'), parameters('name'), ctx.parameters<T>('name')
  const pattern = /(?:ctx\.)?parameters\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  let match;
  while ((match = pattern.exec(sourceText)) !== null) {
    if (isInComment(match.index, commentRanges)) {
      continue;
    }
    const name = match[1];
    if (!validNames.has(name)) {
      const startPos = index.sourceFile.getLineAndCharacterOfPosition(match.index);
      const endPos = index.sourceFile.getLineAndCharacterOfPosition(
        match.index + match[0].length
      );
      invalid.push({
        name,
        range: { start: startPos, end: endPos },
        line: startPos.line,
      });
    }
  }

  return invalid;
}

/**
 * Find invalid connection reference usages in connector calls.
 * Connection references are used in:
 * - ctx.connectors.connector.Operation('name', params, 'connectionRefName')
 * - ctx.connector('name', 'connector', 'operation', params, 'connectionRefName')
 * - ctx.connectorWebhook('name', 'connector', 'operation', params, 'connectionRefName')
 */
export function findInvalidConnectionReferences(
  index: SymbolIndex
): Array<{ name: string; range: SourceRange; line: number }> {
  const invalid: Array<{ name: string; range: SourceRange; line: number }> = [];
  const validNames = new Set(index.connectionReferences.map((c) => c.name));

  // Use AST traversal instead of regex to handle complex nested structures
  function visit(node: ts.Node): void {
    // Pattern 1-3: Check if it's a call expression (connector actions)
    if (ts.isCallExpression(node)) {
      let connectionRefArg: ts.Expression | undefined;
      let isConnectorCall = false;

      // Pattern 1: ctx.connectors.XXX.YYY('name', params, 'connectionRefName')
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        ts.isPropertyAccessExpression(node.expression.expression.expression)
      ) {
        const base = node.expression.expression.expression;
        const connectors = node.expression.expression;
        if (
          ts.isIdentifier(base.expression) &&
          base.expression.text === 'ctx' &&
          ts.isIdentifier(base.name) &&
          base.name.text === 'connectors'
        ) {
          // This is a ctx.connectors.XXX.YYY() call
          // Connection reference is the 3rd argument (index 2)
          connectionRefArg = node.arguments[2];
          isConnectorCall = true;
        }
      }

      // Pattern 2: ctx.connector('name', 'connector', 'operation', params, 'connectionRefName')
      // Pattern 3: ctx.connectorWebhook('name', 'connector', 'operation', params, 'connectionRefName')
      if (
        !isConnectorCall &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'ctx' &&
        ts.isIdentifier(node.expression.name)
      ) {
        const methodName = node.expression.name.text;
        if (methodName === 'connector' || methodName === 'connectorWebhook') {
          // Connection reference is the 5th argument (index 4)
          connectionRefArg = node.arguments[4];
          isConnectorCall = true;
        }
      }

      // Validate the connection reference if found
      if (isConnectorCall && connectionRefArg && ts.isStringLiteral(connectionRefArg)) {
        const refName = connectionRefArg.text;
        if (!validNames.has(refName)) {
          const startPos = index.sourceFile.getLineAndCharacterOfPosition(
            connectionRefArg.getStart(index.sourceFile)
          );
          const endPos = index.sourceFile.getLineAndCharacterOfPosition(
            connectionRefArg.getEnd()
          );
          invalid.push({
            name: refName,
            range: { start: startPos, end: endPos },
            line: startPos.line,
          });
        }
      }
    }

    // Pattern 4: Check for object literals with connectionReferenceName property (triggers)
    // Example: return { connector: 'sharepoint', connectionReferenceName: 'shared_sharepointonline' }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === 'connectionReferenceName' &&
          ts.isStringLiteral(property.initializer)
        ) {
          const refName = property.initializer.text;
          if (!validNames.has(refName)) {
            const startPos = index.sourceFile.getLineAndCharacterOfPosition(
              property.initializer.getStart(index.sourceFile)
            );
            const endPos = index.sourceFile.getLineAndCharacterOfPosition(
              property.initializer.getEnd()
            );
            invalid.push({
              name: refName,
              range: { start: startPos, end: endPos },
              line: startPos.line,
            });
          }
        }
      }
    }

    // Continue traversing
    ts.forEachChild(node, visit);
  }

  // Start traversal from the source file
  visit(index.sourceFile);

  return invalid;
}
