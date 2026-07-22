/**
 * Variable Tracker
 * Tracks variable declarations and assignments to generate
 * InitializeVariable and SetVariable actions.
 */

import {
  VariableDeclaration,
  BinaryExpression,
  SyntaxKind,
  Expression,
  PostfixUnaryExpression,
  PrefixUnaryExpression,
} from 'ts-morph';
import type { ActionNode } from '@flowforger/ir';
import { genActionId } from '../utils/id-generator.js';
import { inferVariableType, PAVariableType, getDefaultValue } from '../utils/type-inference.js';
import { transformExpression } from '../transformer/expression-transformer.js';
import type { TransformContext } from '../transformer/expression-transformer.js';
import { parseActionNameFromJSDoc, parseOriginalNameFromJSDoc, parseRunAfterFromJSDoc, parseParallelFromJSDoc, parseVarTypeFromJSDoc, parseDescriptionFromJSDoc, parseMetadataFromJSDoc, parseTrackedPropertiesFromJSDoc, parseValueArrayFormFromJSDoc, parseVarNameCaseFromJSDoc } from './action-collector.js';

export interface TrackedVariable {
  name: string;
  originalName: string; // Original name (may contain spaces, etc.)
  type: PAVariableType;
  initActionName: string;
  initActionId: string;
}

export class VariableTracker {
  private variables = new Map<string, TrackedVariable>();
  private assignmentCounters = new Map<string, number>();

  /**
   * Get all tracked variable names.
   */
  getTrackedVariableNames(): Set<string> {
    return new Set(this.variables.keys());
  }

  /**
   * Check if a variable is being tracked.
   */
  isTracked(name: string): boolean {
    return this.variables.has(name);
  }

  /**
   * Get the original name for a variable (may differ from sanitized TypeScript name).
   * Returns the sanitized name if no original name is stored.
   */
  getOriginalName(sanitizedName: string): string {
    const tracked = this.variables.get(sanitizedName);
    return tracked ? tracked.originalName : sanitizedName;
  }

  /**
   * Get the mapping of sanitized names to original names for all tracked variables.
   */
  getOriginalNameMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [sanitizedName, tracked] of this.variables) {
      map.set(sanitizedName, tracked.originalName);
    }
    return map;
  }

  /**
   * Process a variable declaration (let x = value).
   * Returns an InitializeVariable action node.
   */
  processDeclaration(
    declaration: VariableDeclaration,
    ctx: TransformContext
  ): ActionNode | null {
    const nameNode = declaration.getNameNode();

    // Only handle simple identifiers (not destructuring)
    if (nameNode.getKind() !== SyntaxKind.Identifier) {
      return null;
    }

    const name = nameNode.getText();
    const initializer = declaration.getInitializer();

    // Skip if initializer is an await expression (action call)
    if (initializer && isAwaitExpression(initializer)) {
      // This is an action result assignment, not a variable
      return null;
    }

    // Reject redeclarations: Power Automate has one InitializeVariable per variable name.
    // Without this guard the second declaration silently overwrites the first in the tracker
    // and the IR ends up with two InitializeVariable actions for the same name, which PA
    // rejects on import. .ff.ts files don't go through tsc, so TS2451 never fires either.
    if (this.variables.has(name)) {
      throw new Error(
        `Variable '${name}' is already declared. ` +
        `FlowForger variables map to Power Automate InitializeVariable actions, ` +
        `which must be unique per variable name. Remove the duplicate 'let ${name}' / 'var ${name}'.`
      );
    }

    let type = inferVariableType(initializer, declaration);
    const actionId = genActionId();

    // Check for @action, @originalName, @runAfter, @runtimeConfig, @varType, @description, @metadata, @trackedProperties JSDoc annotations
    // The JSDoc is on the parent VariableStatement, not the declaration itself
    const variableStatement = declaration.getVariableStatement();
    const jsDocActionName = variableStatement ? parseActionNameFromJSDoc(variableStatement) : undefined;
    const jsDocOriginalName = variableStatement ? parseOriginalNameFromJSDoc(variableStatement) : undefined;
    const runAfter = variableStatement ? parseRunAfterFromJSDoc(variableStatement) : undefined;
    const runtimeConfiguration = variableStatement ? parseParallelFromJSDoc(variableStatement) : undefined;
    const jsDocVarType = variableStatement ? parseVarTypeFromJSDoc(variableStatement) : undefined;
    const description = variableStatement ? parseDescriptionFromJSDoc(variableStatement) : undefined;
    const metadata = variableStatement ? parseMetadataFromJSDoc(variableStatement) : undefined;
    const trackedProperties = variableStatement ? parseTrackedPropertiesFromJSDoc(variableStatement) : undefined;
    const actionName = jsDocActionName || `Initialize_${name}`;

    // Override inferred type with @varType if present (e.g., to distinguish float from integer)
    if (jsDocVarType && ['string', 'integer', 'float', 'boolean', 'array', 'object'].includes(jsDocVarType)) {
      type = jsDocVarType as PAVariableType;
    }

    // Use @originalName if present, otherwise use the TypeScript variable name
    const originalName = jsDocOriginalName || name;

    // Determine the initial value
    let value: any;
    let hasValue = true;

    if (!initializer) {
      // No initializer - use default value for the type
      value = getDefaultValue(type);
    } else if (
      initializer.getKind() === SyntaxKind.UndefinedKeyword ||
      (initializer.getKind() === SyntaxKind.Identifier && initializer.getText() === 'undefined')
    ) {
      // Explicit undefined (as keyword or identifier) - don't include value field in IR
      hasValue = false;
    } else {
      // Transform value, handling object literals with expressions
      const arrayFormHint = variableStatement ? parseValueArrayFormFromJSDoc(variableStatement) : undefined;
      value = transformValueWithExpressions(initializer, ctx, arrayFormHint);
    }

    // Track the variable (key is sanitized name, stores original name for reverse lookup)
    this.variables.set(name, {
      name,
      originalName,
      type,
      initActionName: actionName,
      initActionId: actionId,
    });

    // Add to transform context
    ctx.trackedVariables.add(name);
    // Store original name mapping for expression transformer to use
    if (ctx.variableOriginalNames) {
      ctx.variableOriginalNames.set(name, originalName);
    }

    // Build inputs - use original name for the variable name in IR
    const inputs: any = {
      variableName: originalName,
      variableType: type,
    };

    // Only include value if it was specified (not undefined keyword)
    if (hasValue) {
      inputs.value = value;
    }

    const actionNode: ActionNode = {
      id: actionId,
      type: 'action',
      kind: 'initializevariable',
      name: actionName,
      inputs,
    };
    if (runAfter) actionNode.runAfter = runAfter;
    if (runtimeConfiguration) actionNode.runtimeConfiguration = runtimeConfiguration;
    if (description) actionNode.description = description;
    if (metadata) actionNode.metadata = metadata;
    if (trackedProperties) actionNode.trackedProperties = trackedProperties;
    return actionNode;
  }

  /**
   * Process a variable assignment (x = value).
   * Returns a SetVariable action node.
   */
  processAssignment(
    node: BinaryExpression,
    ctx: TransformContext
  ): ActionNode | null {
    const left = node.getLeft();
    const right = node.getRight();
    const operator = node.getOperatorToken().getKind();

    // Only handle simple identifier assignments
    if (left.getKind() !== SyntaxKind.Identifier) {
      return null;
    }

    const name = left.getText();

    // Check if this variable is tracked
    if (!this.variables.has(name)) {
      // Not a tracked variable, might be a const or parameter
      return null;
    }

    const variable = this.variables.get(name)!;
    const originalName = variable.originalName;
    const actionId = genActionId();
    // Counter is computed per-kind below — see comment on getNextCounter — so that
    // mixing Set/Increment/Decrement/AppendToString on the same variable doesn't
    // assign suffix `_2` across kinds (default-name prefixes already differ).

    // Check for @action, @runAfter, @runtimeConfig, @description, @metadata, @trackedProperties JSDoc annotations on the parent statement
    const parent = node.getParent();
    const jsDocActionName = parent ? parseActionNameFromJSDoc(parent) : undefined;
    const runAfter = parent ? parseRunAfterFromJSDoc(parent) : undefined;
    const runtimeConfiguration = parent ? parseParallelFromJSDoc(parent) : undefined;
    const description = parent ? parseDescriptionFromJSDoc(parent) : undefined;
    const metadata = parent ? parseMetadataFromJSDoc(parent) : undefined;
    const trackedProperties = parent ? parseTrackedPropertiesFromJSDoc(parent) : undefined;
    const arrayFormHint = parent ? parseValueArrayFormFromJSDoc(parent) : undefined;
    const varNameCase = parent ? parseVarNameCaseFromJSDoc(parent) : undefined;

    // Helper to add runAfter, runtimeConfiguration, description, metadata, trackedProperties to action node
    const addMetadata = (actionNode: ActionNode): ActionNode => {
      if (runAfter) actionNode.runAfter = runAfter;
      if (runtimeConfiguration) actionNode.runtimeConfiguration = runtimeConfiguration;
      if (description) actionNode.description = description;
      if (metadata) actionNode.metadata = metadata;
      if (trackedProperties) actionNode.trackedProperties = trackedProperties;
      return actionNode;
    };

    // Handle compound assignments
    if (operator === SyntaxKind.PlusEqualsToken) {
      // x += value
      if (variable.type === 'integer' || variable.type === 'float') {
        // Use IncrementVariable for numeric types
        const value = getLiteralValue(right) ?? transformExpression(right, ctx);
        return addMetadata({
          id: actionId,
          type: 'action',
          kind: 'incrementvariable',
          name: jsDocActionName || `Increment_${name}${this.getNextCounter(name, 'increment')}`,
          inputs: {
            name: originalName,
            value,
          },
        } as ActionNode);
      } else if (variable.type === 'string') {
        // Use AppendToStringVariable for strings
        const value = getLiteralValue(right) ?? transformExpression(right, ctx);
        return addMetadata({
          id: actionId,
          type: 'action',
          kind: 'appendtostringvariable',
          name: jsDocActionName || `Append_${name}${this.getNextCounter(name, 'appendstring')}`,
          inputs: {
            name: originalName,
            value,
          },
        } as ActionNode);
      }
    }

    if (operator === SyntaxKind.MinusEqualsToken) {
      // x -= value
      const value = getLiteralValue(right) ?? transformExpression(right, ctx);
      return addMetadata({
        id: actionId,
        type: 'action',
        kind: 'decrementvariable',
        name: jsDocActionName || `Decrement_${name}${this.getNextCounter(name, 'decrement')}`,
        inputs: {
          name: originalName,
          value,
        },
      } as ActionNode);
    }

    // Regular assignment: x = value
    if (operator === SyntaxKind.EqualsToken) {
      // Check if this is a self-referencing increment/decrement pattern
      // e.g., x = x + 1, x = x - 1
      if (right.getKind() === SyntaxKind.BinaryExpression) {
        const rightBinary = right.asKindOrThrow(SyntaxKind.BinaryExpression);
        const rightOp = rightBinary.getOperatorToken().getKind();
        const rightLeft = rightBinary.getLeft();
        const rightRight = rightBinary.getRight();

        // Check if it's "x = x + value" (increment pattern)
        if (rightOp === SyntaxKind.PlusToken &&
            rightLeft.getKind() === SyntaxKind.Identifier &&
            rightLeft.getText() === name) {
          if (variable.type === 'integer' || variable.type === 'float') {
            // Use IncrementVariable for numeric types
            const value = getLiteralValue(rightRight) ?? transformExpression(rightRight, ctx);
            return addMetadata({
              id: actionId,
              type: 'action',
              kind: 'incrementvariable',
              name: jsDocActionName || `Increment_${name}${this.getNextCounter(name, 'increment')}`,
              inputs: {
                name: originalName,
                value,
              },
            } as ActionNode);
          }
        }

        // Check if it's "x = x - value" (decrement pattern)
        if (rightOp === SyntaxKind.MinusToken &&
            rightLeft.getKind() === SyntaxKind.Identifier &&
            rightLeft.getText() === name) {
          const value = getLiteralValue(rightRight) ?? transformExpression(rightRight, ctx);
          return addMetadata({
            id: actionId,
            type: 'action',
            kind: 'decrementvariable',
            name: jsDocActionName || `Decrement_${name}${this.getNextCounter(name, 'decrement')}`,
            inputs: {
              name: originalName,
              value,
            },
          } as ActionNode);
        }
      }

      // Regular SetVariable (no self-reference)
      // Use transformValueWithExpressions to handle object literals with expressions
      const value = transformValueWithExpressions(right, ctx, arrayFormHint);
      return addMetadata({
        id: actionId,
        type: 'action',
        kind: 'setvariable',
        name: jsDocActionName || `Set_${name}${this.getNextCounter(name, 'set')}`,
        inputs: {
          name: varNameCase ?? originalName,
          value,
        },
      } as ActionNode);
    }

    return null;
  }

  /**
   * Process increment/decrement expressions (x++, ++x, x--, --x).
   */
  processUnaryMutation(
    node: PostfixUnaryExpression | PrefixUnaryExpression,
    ctx: TransformContext
  ): ActionNode | null {
    const operand = node.getOperand();

    if (operand.getKind() !== SyntaxKind.Identifier) {
      return null;
    }

    const name = operand.getText();

    if (!this.variables.has(name)) {
      return null;
    }

    const variable = this.variables.get(name)!;
    const originalName = variable.originalName;
    const actionId = genActionId();
    const operator = node.getOperatorToken();

    if (operator === SyntaxKind.PlusPlusToken) {
      return {
        id: actionId,
        type: 'action',
        kind: 'incrementvariable',
        name: `Increment_${name}${this.getNextCounter(name, 'increment')}`,
        inputs: {
          name: originalName,
          value: 1,
        },
      } as ActionNode;
    }

    if (operator === SyntaxKind.MinusMinusToken) {
      return {
        id: actionId,
        type: 'action',
        kind: 'decrementvariable',
        name: `Decrement_${name}${this.getNextCounter(name, 'decrement')}`,
        inputs: {
          name: originalName,
          value: 1,
        },
      } as ActionNode;
    }

    return null;
  }

  /**
   * Process array push: arr.push(item).
   */
  processArrayPush(
    variableName: string,
    value: Expression,
    ctx: TransformContext,
    arrayFormHint?: 'array' | 'createArrayString'
  ): ActionNode | null {
    if (!this.variables.has(variableName)) {
      return null;
    }

    const variable = this.variables.get(variableName)!;
    if (variable.type !== 'array') {
      return null;
    }

    const actionId = genActionId();
    const counter = this.getNextCounter(variableName, 'appendarray');
    // Use transformValueWithExpressions to properly handle object literals with expressions
    const transformedValue = transformValueWithExpressions(value, ctx, arrayFormHint);

    return {
      id: actionId,
      type: 'action',
      kind: 'appendtoarrayvariable',
      name: `Append_${variableName}${counter}`,
      inputs: {
        name: variable.originalName, // Use original name with spaces
        value: transformedValue,
      },
    } as ActionNode;
  }

  private getNextCounter(variableName: string, kind: string = ''): string {
    // Counter scoped per (variable, kind) so different default-name prefixes
    // (Set_x vs Increment_x vs Append_to_x) don't compete for suffix `_2`.
    // PA flows require globally unique action names, but cross-kind names
    // already differ via their prefix, so each kind gets its own sequence.
    const key = `${variableName} ${kind}`;
    const current = this.assignmentCounters.get(key) || 0;
    const next = current + 1;
    this.assignmentCounters.set(key, next);
    return next === 1 ? '' : `_${next}`;
  }

  /**
   * Public counter for callers that generate their own mutation action names
   * (e.g., the inline `.push()` handler in transformer/index.ts).
   */
  nextMutationSuffix(variableName: string, kind: string = 'append'): string {
    return this.getNextCounter(variableName, kind);
  }

  /**
   * Reset the tracker for a new flow.
   */
  reset(): void {
    this.variables.clear();
    this.assignmentCounters.clear();
  }
}

/**
 * Check if an expression is an await expression.
 */
function isAwaitExpression(node: Expression): boolean {
  return node.getKind() === SyntaxKind.AwaitExpression;
}

/**
 * Try to get the literal value from an expression.
 * Returns undefined if not a simple literal.
 */
function getLiteralValue(node: Expression): any {
  const kind = node.getKind();

  switch (kind) {
    case SyntaxKind.NumericLiteral:
      return Number(node.getText());

    case SyntaxKind.StringLiteral:
      return node.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();

    case SyntaxKind.TrueKeyword:
      return true;

    case SyntaxKind.FalseKeyword:
      return false;

    case SyntaxKind.NullKeyword:
      return null;

    case SyntaxKind.UndefinedKeyword:
      // Return undefined as a literal value (not the string "undefined")
      return undefined;

    case SyntaxKind.ArrayLiteralExpression: {
      const arr = node.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
      const elements = arr.getElements();
      const values: any[] = [];
      for (const el of elements) {
        const val = getLiteralValue(el);
        if (val === undefined) {
          return undefined; // Contains non-literal
        }
        values.push(val);
      }
      return values;
    }

    case SyntaxKind.ObjectLiteralExpression: {
      const obj = node.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
      const properties = obj.getProperties();
      const result: Record<string, any> = {};
      for (const prop of properties) {
        if (prop.getKind() === SyntaxKind.PropertyAssignment) {
          const assignment = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
          // Use the name node so string-literal keys decode escape sequences
          // (e.g. `"Accept\n"` → "Accept" + newline rather than literal backslash+n).
          const nameNode = assignment.getNameNode();
          let name: string;
          if (nameNode.getKind() === SyntaxKind.StringLiteral) {
            name = nameNode.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
          } else {
            name = assignment.getName();
            if ((name.startsWith("'") && name.endsWith("'")) || (name.startsWith('"') && name.endsWith('"'))) {
              name = name.slice(1, -1);
            }
          }
          const init = assignment.getInitializer();
          if (init) {
            const val = getLiteralValue(init);
            if (val === undefined) {
              return undefined; // Contains non-literal
            }
            result[name] = val;
          }
        } else {
          return undefined; // Complex property
        }
      }
      return result;
    }

    case SyntaxKind.PrefixUnaryExpression: {
      // Handle negative numbers
      const prefix = node.asKindOrThrow(SyntaxKind.PrefixUnaryExpression);
      if (prefix.getOperatorToken() === SyntaxKind.MinusToken) {
        const operand = prefix.getOperand();
        if (operand.getKind() === SyntaxKind.NumericLiteral) {
          return -Number(operand.getText());
        }
      }
      return undefined;
    }

    default:
      return undefined;
  }
}

/**
 * Transform a value expression to PA format, handling object literals with expressions.
 * Unlike getLiteralValue, this doesn't return undefined for complex expressions.
 * Instead, it transforms expressions to PA format and preserves object structure.
 */
export function transformValueWithExpressions(
  node: Expression,
  ctx: TransformContext,
  arrayFormHint?: 'array' | 'createArrayString'
): any {
  const kind = node.getKind();

  switch (kind) {
    case SyntaxKind.NumericLiteral:
      return Number(node.getText());

    case SyntaxKind.StringLiteral:
      return node.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();

    case SyntaxKind.TrueKeyword:
      return true;

    case SyntaxKind.FalseKeyword:
      return false;

    case SyntaxKind.NullKeyword:
      return null;

    case SyntaxKind.UndefinedKeyword:
      return undefined;

    case SyntaxKind.ArrayLiteralExpression: {
      const arr = node.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
      const elements = arr.getElements();
      const transformedElements = elements.map(el => transformValueWithExpressions(el, ctx, arrayFormHint));

      // A string element is a real PA expression (vs a literal containing @) if it starts
      // with @ followed by an identifier-like char or {. A bare '@' (single char) or '@@x'
      // is a literal string, not an expression.
      const isPaExpression = (el: any): el is string => {
        if (typeof el !== 'string' || !el.startsWith('@')) return false;
        const next = el.charAt(1);
        return /^[a-zA-Z_{]/.test(next);
      };

      const buildCreateArrayString = (): string => {
        const innerExprs = transformedElements.map(el => {
          if (isPaExpression(el)) return el.slice(1);
          if (typeof el === 'string') return `'${el.replace(/'/g, "''")}'`;
          return JSON.stringify(el);
        });
        return `@createArray(${innerExprs.join(', ')})`;
      };

      // Honor the explicit JSDoc hint when present — sentinel set on the action when
      // source form differs from the default heuristic.
      if (arrayFormHint === 'array') {
        return transformedElements;
      }
      if (arrayFormHint === 'createArrayString') {
        return buildCreateArrayString();
      }

      // Default heuristic: use @createArray(...) form when ANY element is a string starting
      // with @ — either a PA expression OR a literal containing @ (like '@'). PA UI emits
      // arrays with such characters as @createArray(...) strings rather than JSON arrays.
      const anyAtPrefixed = transformedElements.some(
        el => typeof el === 'string' && el.startsWith('@')
      );

      if (anyAtPrefixed) {
        return buildCreateArrayString();
      }

      return transformedElements;
    }

    case SyntaxKind.ObjectLiteralExpression: {
      const obj = node.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
      const properties = obj.getProperties();
      const result: Record<string, any> = {};
      for (const prop of properties) {
        if (prop.getKind() === SyntaxKind.PropertyAssignment) {
          const assignment = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
          // Use the name node so string-literal keys decode escape sequences
          // (e.g. `"Accept\n"` → "Accept" + newline rather than literal backslash+n).
          const nameNode = assignment.getNameNode();
          let name: string;
          if (nameNode.getKind() === SyntaxKind.StringLiteral) {
            name = nameNode.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
          } else {
            name = assignment.getName();
            if ((name.startsWith("'") && name.endsWith("'")) || (name.startsWith('"') && name.endsWith('"'))) {
              name = name.slice(1, -1);
            }
          }
          const init = assignment.getInitializer();
          if (init) {
            result[name] = transformValueWithExpressions(init, ctx, arrayFormHint);
          }
        } else if (prop.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
          // Handle { foo } shorthand
          const shorthand = prop.asKindOrThrow(SyntaxKind.ShorthandPropertyAssignment);
          const name = shorthand.getName();
          result[name] = transformExpression(shorthand.getNameNode(), ctx);
        }
      }
      return result;
    }

    case SyntaxKind.PrefixUnaryExpression: {
      // Handle negative numbers
      const prefix = node.asKindOrThrow(SyntaxKind.PrefixUnaryExpression);
      if (prefix.getOperatorToken() === SyntaxKind.MinusToken) {
        const operand = prefix.getOperand();
        if (operand.getKind() === SyntaxKind.NumericLiteral) {
          return -Number(operand.getText());
        }
      }
      // For other prefix expressions, transform as expression
      return transformExpression(node, ctx);
    }

    default:
      // For complex expressions (ctx.* calls, etc.), transform to PA format
      return transformExpression(node, ctx);
  }
}

