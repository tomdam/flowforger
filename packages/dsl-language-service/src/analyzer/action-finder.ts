/**
 * Action Finder - extracts action declarations from DSL code.
 * Uses TypeScript AST to find all ctx.* method calls that define actions.
 */

import ts from 'typescript';
import { parseSource, getNodeRange, type SourceRange } from './dsl-parser.js';

/**
 * Represents a declared action in the flow.
 */
export interface ActionDeclaration {
  /** Unique name of the action */
  name: string;
  /** Type of action (http, compose, connector, etc.) */
  type: ActionType;
  /** Source range where the action is declared */
  range: SourceRange;
  /** Range of just the action name string */
  nameRange: SourceRange;
  /** Line number (0-indexed) */
  line: number;
  /** Optional: connector name for connector actions */
  connector?: string;
  /** Optional: operation name for connector actions */
  operation?: string;
}

/**
 * Types of actions that can be declared.
 */
export type ActionType =
  | 'http'
  | 'compose'
  | 'expression'
  | 'response'
  | 'terminate'
  | 'delay'
  | 'delayUntil'
  | 'callWorkflow'
  | 'parseJson'
  | 'join'
  | 'select'
  | 'filterArray'
  | 'createCsvTable'
  | 'createHtmlTable'
  | 'connector'
  | 'connectorWebhook'
  | 'scope'
  | 'if'
  | 'foreach'
  | 'switch'
  | 'dountil'
  | 'unknown';

/**
 * Method names that create actions (first argument is action name).
 */
const ACTION_METHODS: Record<string, ActionType> = {
  http: 'http',
  compose: 'compose',
  expression: 'expression',
  response: 'response',
  terminate: 'terminate',
  delay: 'delay',
  delayUntil: 'delayUntil',
  callWorkflow: 'callWorkflow',
  parseJson: 'parseJson',
  join: 'join',
  select: 'select',
  filter: 'filterArray',
  filterArray: 'filterArray',
  createCsvTable: 'createCsvTable',
  createHtmlTable: 'createHtmlTable',
  connector: 'connector',
  connectorWebhook: 'connectorWebhook',
};

/**
 * Find all action declarations in the source code.
 */
export function findActions(code: string): ActionDeclaration[] {
  const sourceFile = parseSource(code);
  const actions: ActionDeclaration[] = [];

  function visit(node: ts.Node): void {
    // Look for call expressions like ctx.http('ActionName', ...)
    if (ts.isCallExpression(node)) {
      const action = extractActionFromCall(sourceFile, node);
      if (action) {
        actions.push(action);
      }
    }

    // Look for JSDoc-defined actions on control structures
    const jsDocAction = extractActionFromJSDoc(sourceFile, node);
    if (jsDocAction) {
      actions.push(jsDocAction);
    }

    // Continue traversing
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return actions;
}

/**
 * Extract action declaration from a call expression.
 */
function extractActionFromCall(
  sourceFile: ts.SourceFile,
  call: ts.CallExpression
): ActionDeclaration | undefined {
  const expr = call.expression;

  // Handle ctx.connectors.{connector}['{operation}'](...) pattern (bracket notation for operation)
  // AST: CallExpression > ElementAccessExpression (operation) > PropertyAccessExpression (connector)
  if (ts.isElementAccessExpression(expr)) {
    const elementAccess = expr;
    const operation = extractStringValue(elementAccess.argumentExpression);

    if (operation && ts.isPropertyAccessExpression(elementAccess.expression)) {
      const connectorAccess = elementAccess.expression;
      const connector = connectorAccess.name.text;

      if (ts.isPropertyAccessExpression(connectorAccess.expression) &&
          ts.isIdentifier(connectorAccess.expression.expression) &&
          connectorAccess.expression.expression.text === 'ctx' &&
          ts.isIdentifier(connectorAccess.expression.name) &&
          connectorAccess.expression.name.text === 'connectors') {
        if (call.arguments.length > 0) {
          const firstArg = call.arguments[0];
          const actionName = extractStringValue(firstArg);
          if (actionName) {
            return {
              name: actionName,
              type: 'connector',
              range: getNodeRange(sourceFile, call),
              nameRange: getNodeRange(sourceFile, firstArg),
              line: sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line,
              connector,
              operation,
            };
          }
        }
      }
    }
  }

  // Handle ctx.methodName(...) pattern
  if (ts.isPropertyAccessExpression(expr)) {
    const methodName = expr.name.text;
    const object = expr.expression;

    // Check if it's ctx.methodName
    if (ts.isIdentifier(object) && object.text === 'ctx') {
      const actionType = ACTION_METHODS[methodName];
      if (actionType && call.arguments.length > 0) {
        const firstArg = call.arguments[0];
        const actionName = extractStringValue(firstArg);
        if (actionName) {
          return {
            name: actionName,
            type: actionType,
            range: getNodeRange(sourceFile, call),
            nameRange: getNodeRange(sourceFile, firstArg),
            line: sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line,
          };
        }
      }
    }

    // Check if it's ctx.connectors.{connector}.{operation} (dot notation)
    if (ts.isPropertyAccessExpression(object)) {
      const connectorExpr = object;
      const operation = methodName;

      if (ts.isPropertyAccessExpression(connectorExpr.expression)) {
        const connectorsAccess = connectorExpr.expression;
        if (ts.isIdentifier(connectorsAccess.expression) &&
            connectorsAccess.expression.text === 'ctx' &&
            ts.isIdentifier(connectorsAccess.name) &&
            connectorsAccess.name.text === 'connectors') {
          const connector = connectorExpr.name.text;

          if (call.arguments.length > 0) {
            const firstArg = call.arguments[0];
            const actionName = extractStringValue(firstArg);
            if (actionName) {
              return {
                name: actionName,
                type: 'connector',
                range: getNodeRange(sourceFile, call),
                nameRange: getNodeRange(sourceFile, firstArg),
                line: sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line,
                connector,
                operation,
              };
            }
          }
        }
      }

    }

    // Check if it's ctx.connectors['{connector}'].{operation} (bracket notation)
    // AST: PropertyAccessExpression > ElementAccessExpression > PropertyAccessExpression
    if (ts.isElementAccessExpression(object)) {
      const elementAccess = object;
      const operation = methodName;

      if (ts.isPropertyAccessExpression(elementAccess.expression) &&
          ts.isIdentifier(elementAccess.expression.expression) &&
          elementAccess.expression.expression.text === 'ctx' &&
          ts.isIdentifier(elementAccess.expression.name) &&
          elementAccess.expression.name.text === 'connectors') {
        const connector = extractStringValue(elementAccess.argumentExpression);

        if (connector && call.arguments.length > 0) {
          const firstArg = call.arguments[0];
          const actionName = extractStringValue(firstArg);
          if (actionName) {
            return {
              name: actionName,
              type: 'connector',
              range: getNodeRange(sourceFile, call),
              nameRange: getNodeRange(sourceFile, firstArg),
              line: sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line,
              connector,
              operation,
            };
          }
        }
      }
    }
  }

  return undefined;
}

/**
 * Extract action from JSDoc comment on control structures.
 * Handles patterns like:
 * - @Action MyScope @type scope on block statements
 * - @Action CheckCondition @type if on if statements
 * - @Action ProcessItems @type foreach on for-of loops
 */
function extractActionFromJSDoc(
  sourceFile: ts.SourceFile,
  node: ts.Node
): ActionDeclaration | undefined {
  // Only check relevant node types
  if (!ts.isBlock(node) && !ts.isIfStatement(node) &&
      !ts.isForOfStatement(node) && !ts.isSwitchStatement(node) &&
      !ts.isWhileStatement(node) && !ts.isDoStatement(node) &&
      !ts.isVariableStatement(node) && !ts.isExpressionStatement(node)) {
    return undefined;
  }

  // Get JSDoc comment for this node
  const jsDocComment = getJSDocComment(sourceFile, node);
  if (!jsDocComment) {
    return undefined;
  }

  // Parse @Action tag
  const actionMatch = jsDocComment.match(/@[Aa]ction\s+([^\s@*]+)/);
  if (!actionMatch) {
    return undefined;
  }

  const actionName = actionMatch[1].trim();

  // Parse @type tag
  const typeMatch = jsDocComment.match(/@type\s+([^\s@*]+)/);
  let actionType: ActionType = 'unknown';

  if (typeMatch) {
    const typeName = typeMatch[1].trim();
    // Map type names to ActionType
    if (typeName === 'scope') {
      actionType = 'scope';
    } else if (typeName === 'if') {
      actionType = 'if';
    } else if (typeName === 'foreach') {
      actionType = 'foreach';
    } else if (typeName === 'switch') {
      actionType = 'switch';
    } else if (typeName === 'dountil') {
      actionType = 'dountil';
    }
  } else {
    // Infer type from node kind if not specified
    if (ts.isBlock(node)) {
      actionType = 'scope';
    } else if (ts.isIfStatement(node)) {
      actionType = 'if';
    } else if (ts.isForOfStatement(node)) {
      actionType = 'foreach';
    } else if (ts.isSwitchStatement(node)) {
      actionType = 'switch';
    } else if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      actionType = 'dountil';
    }
  }

  const range = getNodeRange(sourceFile, node);
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;

  // Create a synthetic name range (use the start of the node)
  const nameRange: SourceRange = {
    start: range.start,
    end: { line: range.start.line, character: range.start.character + actionName.length },
  };

  return {
    name: actionName,
    type: actionType,
    range,
    nameRange,
    line,
  };
}

/**
 * Get JSDoc comment text for a node.
 * Searches for JSDoc block comments before the node.
 */
function getJSDocComment(sourceFile: ts.SourceFile, node: ts.Node): string | undefined {
  const fullText = sourceFile.getFullText();
  const start = node.getStart(sourceFile);

  // Look for JSDoc comment before the node
  // We need to search backwards from the node to find the comment
  const textBefore = fullText.substring(0, start);
  const lastJSDocMatch = textBefore.match(/\/\*\*([^*]|\*(?!\/))*\*\/\s*$/);

  return lastJSDocMatch ? lastJSDocMatch[0] : undefined;
}

/**
 * Extract string value from a node (string literal or template literal).
 */
function extractStringValue(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node)) {
    return node.text;
  }
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

/**
 * Find action by name.
 */
export function findActionByName(
  actions: ActionDeclaration[],
  name: string
): ActionDeclaration | undefined {
  return actions.find((a) => a.name === name);
}

/**
 * Get action names as a simple string array.
 */
export function getActionNames(actions: ActionDeclaration[]): string[] {
  return actions.map((a) => a.name);
}

/**
 * Check if an action name is already declared (case-insensitive).
 */
export function isActionDeclared(actions: ActionDeclaration[], name: string): boolean {
  const lowerName = name.toLowerCase();
  return actions.some((a) => a.name.toLowerCase() === lowerName);
}

/**
 * Find duplicate action names (case-insensitive).
 */
export function findDuplicateActions(actions: ActionDeclaration[]): ActionDeclaration[][] {
  const nameMap = new Map<string, ActionDeclaration[]>();

  for (const action of actions) {
    // Use lowercase for case-insensitive grouping
    const lowerName = action.name.toLowerCase();
    const existing = nameMap.get(lowerName);
    if (existing) {
      existing.push(action);
    } else {
      nameMap.set(lowerName, [action]);
    }
  }

  return Array.from(nameMap.values()).filter((group) => group.length > 1);
}

/**
 * Find actions declared before a specific line.
 * Useful for completions to only suggest actions that exist at the cursor position.
 */
export function findActionsBeforeLine(
  actions: ActionDeclaration[],
  line: number
): ActionDeclaration[] {
  return actions.filter((a) => a.line < line);
}
