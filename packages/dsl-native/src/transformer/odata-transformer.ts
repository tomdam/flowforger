/**
 * OData Transformer
 * Transforms ctx.odata.* builder calls back to OData filter strings.
 * Also supports tagged template literals: ctx.odata`field == ${value}`
 */

import { CallExpression, SyntaxKind, Expression, Node, TaggedTemplateExpression } from 'ts-morph';
import { parseJsToOData } from './js-to-odata-parser.js';
import { transformExpression } from './expression-transformer.js';
import type { TransformContext } from './expression-transformer.js';

/**
 * Check if an expression is a ctx.odata.* call.
 */
export function isODataCall(node: Expression): boolean {
  if (node.getKind() !== SyntaxKind.CallExpression) return false;

  const call = node.asKindOrThrow(SyntaxKind.CallExpression);
  const expr = call.getExpression();

  if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return false;

  const propAccess = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const obj = propAccess.getExpression();

  // Check for ctx.odata pattern
  if (obj.getKind() === SyntaxKind.PropertyAccessExpression) {
    const objPropAccess = obj.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (objPropAccess.getName() === 'odata') {
      const ctxExpr = objPropAccess.getExpression();
      return ctxExpr.getKind() === SyntaxKind.Identifier && ctxExpr.getText() === 'ctx';
    }
  }

  return false;
}

/**
 * Get the OData method name from a ctx.odata.* call.
 */
function getODataMethod(call: CallExpression): string {
  const expr = call.getExpression();
  const propAccess = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  return propAccess.getName();
}

/**
 * Transform a value expression to its OData string representation.
 */
function transformValueToOData(node: Expression): string {
  const kind = node.getKind();

  switch (kind) {
    case SyntaxKind.StringLiteral:
      return `'${node.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue()}'`;

    case SyntaxKind.NumericLiteral:
      return node.getText();

    case SyntaxKind.TrueKeyword:
      return 'true';

    case SyntaxKind.FalseKeyword:
      return 'false';

    case SyntaxKind.NullKeyword:
      return 'null';

    case SyntaxKind.PrefixUnaryExpression: {
      // Handle negative numbers: -26 etc.
      const prefix = node.asKindOrThrow(SyntaxKind.PrefixUnaryExpression);
      if (prefix.getOperatorToken() === SyntaxKind.MinusToken) {
        const operand = prefix.getOperand();
        if (operand.getKind() === SyntaxKind.NumericLiteral) {
          return `-${operand.getText()}`;
        }
      }
      return node.getText();
    }

    case SyntaxKind.CallExpression: {
      // Handle ctx.* calls like ctx.parameters('name')
      const call = node.asKindOrThrow(SyntaxKind.CallExpression);
      const expr = call.getExpression();

      if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
        const obj = propAccess.getExpression();
        const methodName = propAccess.getName();

        if (obj.getKind() === SyntaxKind.Identifier && obj.getText() === 'ctx') {
          const args = call.getArguments();

          // Handle ctx.braced() - transform the inner expression and wrap in @{...}
          if (methodName === 'braced' && args.length > 0) {
            const innerResult = transformValueToOData(args[0] as Expression);
            // Remove @ prefix if present, since we're wrapping in @{...}
            const innerExpr = innerResult.startsWith('@') ? innerResult.substring(1) : innerResult;
            // Also remove @{ prefix if present (double-wrapped)
            const cleanExpr = innerExpr.startsWith('{') ? innerExpr.substring(1, innerExpr.length - 1) : innerExpr;
            return `@{${cleanExpr}}`;
          }

          // Transform all arguments recursively
          if (args.length > 0) {
            const argStrs = args.map(arg => {
              const argExpr = arg as Expression;
              const argResult = transformValueToOData(argExpr);
              // Remove @{ and } wrapper if present since we're building the inner expression
              if (argResult.startsWith('@{') && argResult.endsWith('}')) {
                return argResult.slice(2, -1);
              }
              // Remove @ prefix if present
              if (argResult.startsWith('@')) {
                return argResult.slice(1);
              }
              return argResult;
            });
            return `@{${methodName}(${argStrs.join(', ')})}`;
          }
          return `@{${methodName}()}`;
        }
      }

      // Nested OData call
      if (isODataCall(node)) {
        return transformODataCall(call);
      }

      return node.getText();
    }

    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.NonNullExpression: {
      // Handle complex property access like ctx.body('action')?['field']
      const text = node.getText();
      if (text.startsWith('ctx.')) {
        // Remove 'ctx.' prefix and wrap in @{...}
        let exprWithoutCtx = text.substring(4); // Remove 'ctx.'
        // Convert TypeScript optional chaining syntax ?.[ to Power Automate syntax ?[
        exprWithoutCtx = exprWithoutCtx.replace(/\?\.\[/g, '?[');
        return `@{${exprWithoutCtx}}`;
      }
      return node.getText();
    }

    case SyntaxKind.TemplateExpression: {
      // Handle template literals with embedded expressions like:
      // `${ctx.outputs('Get_App')?.['field']}_${ctx.outputs('Get_App')?.['other']}`
      // Transform to: '@{outputs('Get_App')?['field']}_@{outputs('Get_App')?['other']}'
      const templateExpr = node.asKindOrThrow(SyntaxKind.TemplateExpression);
      const head = templateExpr.getHead().getLiteralText();
      const spans = templateExpr.getTemplateSpans();

      let result = head;
      spans.forEach(span => {
        // Transform the embedded expression
        const expression = span.getExpression();
        const transformed = transformValueToOData(expression);
        result += transformed;

        // Add the literal part after the substitution
        const literal = span.getLiteral();
        if (literal.getKind() === SyntaxKind.TemplateMiddle) {
          result += literal.asKindOrThrow(SyntaxKind.TemplateMiddle).getLiteralText();
        } else if (literal.getKind() === SyntaxKind.TemplateTail) {
          result += literal.asKindOrThrow(SyntaxKind.TemplateTail).getLiteralText();
        }
      });

      return `'${result}'`;
    }

    case SyntaxKind.NoSubstitutionTemplateLiteral: {
      // Handle simple template literals without embedded expressions
      const text = node.asKindOrThrow(SyntaxKind.NoSubstitutionTemplateLiteral).getLiteralText();
      return `'${text}'`;
    }

    default:
      // If it's any other expression starting with ctx., wrap in @{...}
      const text = node.getText();
      if (text.startsWith('ctx.')) {
        let exprWithoutCtx = text.substring(4);
        // Convert TypeScript optional chaining syntax ?.[ to Power Automate syntax ?[
        exprWithoutCtx = exprWithoutCtx.replace(/\?\.\[/g, '?[');
        return `@{${exprWithoutCtx}}`;
      }
      return text;
  }
}

/**
 * Transform a ctx.odata.* call to an OData filter string.
 */
export function transformODataCall(call: CallExpression): string {
  const method = getODataMethod(call);
  const args = call.getArguments() as Expression[];

  switch (method) {
    // Comparison operators
    case 'eq':
    case 'ne':
    case 'gt':
    case 'ge':
    case 'lt':
    case 'le': {
      if (args.length < 2) return '';
      const field = args[0].getKind() === SyntaxKind.StringLiteral
        ? (args[0] as any).asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue()
        : args[0].getText();
      const value = transformValueToOData(args[1]);
      return `${field} ${method} ${value}`;
    }

    // Logical operators
    case 'and':
    case 'or': {
      const parts = args.map(arg => {
        if (isODataCall(arg)) {
          const call = (arg as any).asKindOrThrow(SyntaxKind.CallExpression);
          const innerMethod = getODataMethod(call);
          const result = transformODataCall(call);
          // Only wrap in parentheses if this is a nested logical operator with different precedence
          // (e.g., 'or' inside 'and' needs parens, but simple comparisons don't)
          const needsParens = (innerMethod === 'and' || innerMethod === 'or') && innerMethod !== method;
          return needsParens ? `(${result})` : result;
        }
        return arg.getText();
      });
      return parts.join(` ${method} `);
    }

    // NOT operator
    case 'not': {
      if (args.length < 1) return '';
      const inner = isODataCall(args[0])
        ? transformODataCall((args[0] as any).asKindOrThrow(SyntaxKind.CallExpression))
        : args[0].getText();
      return `not (${inner})`;
    }

    // String functions
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      if (args.length < 2) return '';
      const field = args[0].getKind() === SyntaxKind.StringLiteral
        ? (args[0] as any).asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue()
        : args[0].getText();
      const value = transformValueToOData(args[1]);
      const funcName = method.toLowerCase();
      return `${funcName}(${field}, ${value})`;
    }

    // Null checks
    case 'isNull': {
      if (args.length < 1) return '';
      const field = args[0].getKind() === SyntaxKind.StringLiteral
        ? (args[0] as any).asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue()
        : args[0].getText();
      return `${field} eq null`;
    }

    case 'isNotNull': {
      if (args.length < 1) return '';
      const field = args[0].getKind() === SyntaxKind.StringLiteral
        ? (args[0] as any).asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue()
        : args[0].getText();
      return `${field} ne null`;
    }

    // Raw expression
    case 'raw': {
      if (args.length < 1) return '';
      if (args[0].getKind() === SyntaxKind.StringLiteral) {
        return (args[0] as any).asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
      }
      return args[0].getText();
    }

    default:
      return '';
  }
}

/**
 * Check if an expression is a ctx.odata tagged template.
 */
export function isODataTaggedTemplate(node: Expression): boolean {
  if (node.getKind() !== SyntaxKind.TaggedTemplateExpression) return false;

  const tagged = node.asKindOrThrow(SyntaxKind.TaggedTemplateExpression);
  const tag = tagged.getTag();

  // Check for ctx.odata pattern
  if (tag.getKind() === SyntaxKind.PropertyAccessExpression) {
    const propAccess = tag.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (propAccess.getName() === 'odata') {
      const obj = propAccess.getExpression();
      return obj.getKind() === SyntaxKind.Identifier && obj.getText() === 'ctx';
    }
  }

  return false;
}

/**
 * Transform a ctx.odata tagged template to an OData filter string.
 *
 * Example:
 *   ctx.odata`field == ${ctx.parameters('value')} && status != null`
 * Transforms to:
 *   "field eq @{parameters('value')} and status ne null"
 */
export function transformODataTaggedTemplate(tagged: TaggedTemplateExpression): string {
  const template = tagged.getTemplate();

  // Handle NoSubstitutionTemplateLiteral (no ${...} expressions)
  if (template.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
    const text = template.asKindOrThrow(SyntaxKind.NoSubstitutionTemplateLiteral).getLiteralText();
    // Parse the text as a JS expression with no placeholders
    return parseJsToOData(text, []);
  }

  // Handle TemplateExpression (has ${...} expressions)
  if (template.getKind() === SyntaxKind.TemplateExpression) {
    const templateExpr = template.asKindOrThrow(SyntaxKind.TemplateExpression);
    const head = templateExpr.getHead().getLiteralText();
    const spans = templateExpr.getTemplateSpans();

    // Build the full expression string with placeholders
    let jsExpr = head;
    const placeholderValues: string[] = [];

    spans.forEach((span, index) => {
      // Add placeholder for the substitution
      jsExpr += `\${${index}}`;

      // Get the OData representation of the substituted value
      const expression = span.getExpression();
      const odataValue = transformValueToOData(expression);
      placeholderValues.push(odataValue);

      // Add the literal part after the substitution
      const literal = span.getLiteral();
      if (literal.getKind() === SyntaxKind.TemplateMiddle) {
        jsExpr += literal.asKindOrThrow(SyntaxKind.TemplateMiddle).getLiteralText();
      } else if (literal.getKind() === SyntaxKind.TemplateTail) {
        jsExpr += literal.asKindOrThrow(SyntaxKind.TemplateTail).getLiteralText();
      }
    });

    // Parse the JS expression and substitute placeholders
    return parseJsToOData(jsExpr, placeholderValues);
  }

  throw new Error(`Unexpected template type: ${template.getKindName()}`);
}
