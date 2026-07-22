/**
 * Variable Finder - extracts variable declarations from DSL code.
 * Finds `let` declarations that will become Power Automate variables.
 */

import ts from 'typescript';
import { parseSource, getNodeRange, type SourceRange } from './dsl-parser.js';

/**
 * Represents a declared variable in the flow.
 */
export interface VariableDeclaration {
  /** Name of the variable */
  name: string;
  /** Inferred Power Automate type */
  paType: PAVariableType;
  /** Source range of the declaration */
  range: SourceRange;
  /** Range of just the variable name */
  nameRange: SourceRange;
  /** Line number (0-indexed) */
  line: number;
  /** Whether this is the initial declaration or a reassignment */
  isInitialDeclaration: boolean;
  /** Optional: initial value (if simple literal) */
  initialValue?: string | number | boolean;
}

/**
 * Power Automate variable types.
 */
export type PAVariableType =
  | 'String'
  | 'Integer'
  | 'Float'
  | 'Boolean'
  | 'Array'
  | 'Object';

/**
 * Find all variable declarations in the source code.
 * Only finds `let` declarations (not `const` which are compile-time only).
 */
export function findVariables(code: string): VariableDeclaration[] {
  const sourceFile = parseSource(code);
  const variables: VariableDeclaration[] = [];
  const seenNames = new Set<string>();

  function visit(node: ts.Node): void {
    // Look for variable statements with 'let'
    if (ts.isVariableStatement(node)) {
      const declList = node.declarationList;

      // Only process 'let' declarations
      if (declList.flags & ts.NodeFlags.Let) {
        for (const decl of declList.declarations) {
          const variable = extractVariable(sourceFile, decl, seenNames);
          if (variable) {
            if (!seenNames.has(variable.name)) {
              variable.isInitialDeclaration = true;
              seenNames.add(variable.name);
            }
            variables.push(variable);
          }
        }
      }
    }

    // Also look for reassignments like: varName = newValue
    if (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)) {
      const varName = node.left.text;
      // Only track if it's a known variable (was declared with let)
      if (seenNames.has(varName)) {
        const paType = inferPAType(sourceFile, node.right);
        variables.push({
          name: varName,
          paType,
          range: getNodeRange(sourceFile, node),
          nameRange: getNodeRange(sourceFile, node.left),
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line,
          isInitialDeclaration: false,
        });
      }
    }

    // Continue traversing
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return variables;
}

/**
 * Extract variable declaration from a VariableDeclaration node.
 */
function extractVariable(
  sourceFile: ts.SourceFile,
  decl: ts.VariableDeclaration,
  seenNames: Set<string>
): VariableDeclaration | undefined {
  // Only handle simple identifier names
  if (!ts.isIdentifier(decl.name)) {
    return undefined;
  }

  const name = decl.name.text;
  const isInitial = !seenNames.has(name);

  // Infer type from initializer
  let paType: PAVariableType = 'String';
  let initialValue: string | number | boolean | undefined;

  if (decl.initializer) {
    paType = inferPAType(sourceFile, decl.initializer);
    initialValue = extractLiteralValue(decl.initializer);
  } else if (decl.type) {
    // Infer from type annotation
    paType = inferPATypeFromTypeNode(decl.type);
  }

  return {
    name,
    paType,
    range: getNodeRange(sourceFile, decl),
    nameRange: getNodeRange(sourceFile, decl.name),
    line: sourceFile.getLineAndCharacterOfPosition(decl.getStart(sourceFile)).line,
    isInitialDeclaration: isInitial,
    initialValue,
  };
}

/**
 * Infer Power Automate type from an expression.
 */
function inferPAType(sourceFile: ts.SourceFile, expr: ts.Expression): PAVariableType {
  // String literal
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return 'String';
  }

  // Template expression (interpolated string)
  if (ts.isTemplateExpression(expr)) {
    return 'String';
  }

  // Numeric literal
  if (ts.isNumericLiteral(expr)) {
    const text = expr.text;
    if (text.includes('.')) {
      return 'Float';
    }
    return 'Integer';
  }

  // Boolean literal
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) {
    return 'Boolean';
  }

  // Array literal
  if (ts.isArrayLiteralExpression(expr)) {
    return 'Array';
  }

  // Object literal
  if (ts.isObjectLiteralExpression(expr)) {
    return 'Object';
  }

  // Binary expression - check if it's arithmetic or string concatenation
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;

    // Arithmetic operators suggest number
    if (op === ts.SyntaxKind.PlusToken ||
        op === ts.SyntaxKind.MinusToken ||
        op === ts.SyntaxKind.AsteriskToken ||
        op === ts.SyntaxKind.SlashToken ||
        op === ts.SyntaxKind.PercentToken) {
      // Check operands to determine String vs Number
      const leftType = inferPAType(sourceFile, expr.left);
      const rightType = inferPAType(sourceFile, expr.right);

      if (leftType === 'String' || rightType === 'String') {
        return 'String';
      }
      if (leftType === 'Float' || rightType === 'Float') {
        return 'Float';
      }
      return 'Integer';
    }

    // Comparison operators
    if (op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.LessThanToken ||
        op === ts.SyntaxKind.LessThanEqualsToken ||
        op === ts.SyntaxKind.GreaterThanToken ||
        op === ts.SyntaxKind.GreaterThanEqualsToken) {
      return 'Boolean';
    }

    // Logical operators
    if (op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken) {
      return 'Boolean';
    }
  }

  // Prefix unary expression (like !)
  if (ts.isPrefixUnaryExpression(expr)) {
    if (expr.operator === ts.SyntaxKind.ExclamationToken) {
      return 'Boolean';
    }
  }

  // Call expression - try to infer from common patterns
  if (ts.isCallExpression(expr)) {
    const callText = expr.expression.getText(sourceFile);

    // Common array methods
    if (callText.endsWith('.filter') || callText.endsWith('.map') ||
        callText.endsWith('.slice') || callText.endsWith('.concat')) {
      return 'Array';
    }

    // String methods
    if (callText.endsWith('.toString') || callText.endsWith('.toLowerCase') ||
        callText.endsWith('.toUpperCase') || callText.endsWith('.trim')) {
      return 'String';
    }

    // Number methods
    if (callText === 'parseInt' || callText === 'Number') {
      return 'Integer';
    }
    if (callText === 'parseFloat') {
      return 'Float';
    }

    // JSON.parse usually returns Object
    if (callText === 'JSON.parse') {
      return 'Object';
    }
  }

  // Default to Object for unknown expressions
  return 'Object';
}

/**
 * Infer Power Automate type from a TypeScript type node.
 */
function inferPATypeFromTypeNode(typeNode: ts.TypeNode): PAVariableType {
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText();
    switch (typeName.toLowerCase()) {
      case 'string':
        return 'String';
      case 'number':
        return 'Float'; // TypeScript number is float
      case 'boolean':
        return 'Boolean';
      case 'array':
        return 'Array';
      case 'object':
        return 'Object';
    }
  }

  if (typeNode.kind === ts.SyntaxKind.StringKeyword) {
    return 'String';
  }
  if (typeNode.kind === ts.SyntaxKind.NumberKeyword) {
    return 'Float';
  }
  if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) {
    return 'Boolean';
  }
  if (ts.isArrayTypeNode(typeNode)) {
    return 'Array';
  }

  return 'Object';
}

/**
 * Extract literal value from an expression if it's a simple literal.
 */
function extractLiteralValue(expr: ts.Expression): string | number | boolean | undefined {
  if (ts.isStringLiteral(expr)) {
    return expr.text;
  }
  if (ts.isNumericLiteral(expr)) {
    return Number(expr.text);
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  return undefined;
}

/**
 * Get unique variable names (only initial declarations).
 */
export function getVariableNames(variables: VariableDeclaration[]): string[] {
  const names = new Set<string>();
  for (const v of variables) {
    if (v.isInitialDeclaration) {
      names.add(v.name);
    }
  }
  return Array.from(names);
}

/**
 * Find variable by name.
 */
export function findVariableByName(
  variables: VariableDeclaration[],
  name: string
): VariableDeclaration | undefined {
  return variables.find((v) => v.name === name && v.isInitialDeclaration);
}

/**
 * Find variables declared before a specific line.
 */
export function findVariablesBeforeLine(
  variables: VariableDeclaration[],
  line: number
): VariableDeclaration[] {
  return variables.filter((v) => v.isInitialDeclaration && v.line < line);
}

/**
 * Find duplicate `let`/`var` declarations by name (case-sensitive).
 * Re-walks the source so it can distinguish a second `let x` (duplicate
 * declaration — invalid) from `x = ...` (reassignment — fine).
 * `findVariables` collapses both into `isInitialDeclaration: false`, which
 * is why this needs its own pass.
 *
 * Returns an array of groups, each containing all declarations sharing
 * a name (so a group of length N means N-1 duplicates after the first).
 */
export function findDuplicateVariables(code: string): VariableDeclaration[][] {
  const sourceFile = parseSource(code);
  const byName = new Map<string, VariableDeclaration[]>();

  function visit(node: ts.Node): void {
    if (ts.isVariableStatement(node)) {
      const declList = node.declarationList;
      // Track both `let` and `var` — both produce InitializeVariable in the IR
      const isLetOrVar =
        (declList.flags & ts.NodeFlags.Let) !== 0 ||
        (declList.flags & ts.NodeFlags.BlockScoped) === 0; // var
      if (isLetOrVar) {
        for (const decl of declList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const name = decl.name.text;
          const record: VariableDeclaration = {
            name,
            paType: 'String',
            range: getNodeRange(sourceFile, decl),
            nameRange: getNodeRange(sourceFile, decl.name),
            line: sourceFile.getLineAndCharacterOfPosition(decl.getStart(sourceFile)).line,
            isInitialDeclaration: true,
          };
          const existing = byName.get(name);
          if (existing) existing.push(record);
          else byName.set(name, [record]);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return Array.from(byName.values()).filter((group) => group.length > 1);
}
