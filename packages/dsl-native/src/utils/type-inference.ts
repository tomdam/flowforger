/**
 * Type inference utilities for converting TypeScript types
 * to Power Automate variable types.
 */

import { SyntaxKind, Node, Expression, VariableDeclaration } from 'ts-morph';

export type PAVariableType = 'string' | 'integer' | 'float' | 'boolean' | 'array' | 'object';

/**
 * Infer Power Automate variable type from a variable declaration.
 * Checks TypeScript type annotation first, then falls back to initializer.
 */
export function inferVariableType(initializer: Expression | undefined, declaration?: VariableDeclaration): PAVariableType {
  // First, try to infer from TypeScript type annotation if available
  if (declaration) {
    const typeNode = declaration.getTypeNode();
    if (typeNode) {
      const typeText = typeNode.getText().toLowerCase();

      // Check for array types
      if (typeText.includes('[]') || typeText.includes('array<')) {
        return 'array';
      }

      // Check for object types first (Record, object, any)
      // These must be checked before 'string' because Record<string, any> contains 'string'
      if (typeText.startsWith('record<') || typeText === 'object' || typeText === 'any') {
        // For 'any', check the initializer to determine the actual type
        if (typeText === 'any' && initializer && initializer.getKind() !== SyntaxKind.UndefinedKeyword) {
          // Will fall through to initializer-based inference
        } else {
          return 'object';
        }
      }

      // Check for specific types
      if (typeText === 'string' || (typeText.includes('string') && !typeText.includes('record'))) return 'string';
      if (typeText.includes('number') || typeText.includes('integer')) return 'integer';
      if (typeText.includes('boolean')) return 'boolean';
      if (typeText.includes('object')) {
        // For 'any', check the initializer to determine the actual type
        // Only return object if there's no initializer
        if (!initializer || initializer.getKind() === SyntaxKind.UndefinedKeyword) {
          return 'object';
        }
      }
    }
  }

  if (!initializer) {
    return 'string'; // Default to string if no initializer
  }

  const kind = initializer.getKind();

  switch (kind) {
    case SyntaxKind.NumericLiteral: {
      const text = initializer.getText();
      // Check if it's a float (contains decimal point)
      if (text.includes('.')) {
        return 'float';
      }
      return 'integer';
    }

    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.TemplateExpression:
      return 'string';

    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
      return 'boolean';

    case SyntaxKind.ArrayLiteralExpression:
      return 'array';

    case SyntaxKind.ObjectLiteralExpression:
      return 'object';

    case SyntaxKind.NullKeyword:
    case SyntaxKind.UndefinedKeyword:
      return 'string'; // Default for null/undefined when no type annotation

    case SyntaxKind.PrefixUnaryExpression: {
      // Handle negative numbers like -5
      const unary = initializer.asKind(SyntaxKind.PrefixUnaryExpression);
      if (unary) {
        const operand = unary.getOperand();
        if (operand.getKind() === SyntaxKind.NumericLiteral) {
          const text = operand.getText();
          return text.includes('.') ? 'float' : 'integer';
        }
      }
      return 'integer'; // Assume numeric for prefix unary
    }

    case SyntaxKind.CallExpression:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
      // For complex expressions, try to infer from context
      // Default to object as it's most flexible
      return 'object';

    case SyntaxKind.BinaryExpression: {
      // For binary expressions like `a + b`, infer from operands
      const binary = initializer.asKind(SyntaxKind.BinaryExpression);
      if (binary) {
        const operator = binary.getOperatorToken().getKind();
        if (operator === SyntaxKind.PlusToken) {
          // Could be string concat or number addition
          // Check left operand for hints
          const left = binary.getLeft();
          if (left.getKind() === SyntaxKind.StringLiteral) {
            return 'string';
          }
          if (left.getKind() === SyntaxKind.NumericLiteral) {
            return 'integer';
          }
        }
        // Most binary operations result in numbers
        return 'integer';
      }
      return 'object';
    }

    default:
      // For unknown types, default to object
      return 'object';
  }
}

/**
 * Get the default value for a variable type.
 */
export function getDefaultValue(type: PAVariableType): any {
  switch (type) {
    case 'string':
      return '';
    case 'integer':
      return 0;
    case 'float':
      return 0.0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
  }
}

/**
 * Check if an expression is likely a string type.
 */
export function isLikelyString(node: Expression): boolean {
  const kind = node.getKind();
  return (
    kind === SyntaxKind.StringLiteral ||
    kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === SyntaxKind.TemplateExpression
  );
}

/**
 * Check if an expression is likely a numeric type.
 */
export function isLikelyNumeric(node: Expression): boolean {
  const kind = node.getKind();
  return kind === SyntaxKind.NumericLiteral;
}
