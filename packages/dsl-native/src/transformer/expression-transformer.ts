/**
 * Expression Transformer
 * Converts TypeScript expressions to Power Automate expression strings.
 *
 * Examples:
 * - ctx.body('GetUser').name -> @body('GetUser').name
 * - ctx.body('A').x === 'foo' -> @equals(body('A').x, 'foo')
 * - a && b -> @and(a, b)
 */

import {
  Expression,
  SyntaxKind,
  CallExpression,
  PropertyAccessExpression,
  BinaryExpression,
  PrefixUnaryExpression,
  ElementAccessExpression,
  Identifier,
  Node,
} from 'ts-morph';

export interface TransformContext {
  /** Current loop variable name (for foreach) */
  loopVariable?: string;
  /** Name of the current foreach loop (for @items() reference) */
  loopName?: string;
  /** Map of all enclosing loop variable names to their foreach loop names */
  loopVariables?: Map<string, string>;
  /** Set of tracked variable names */
  trackedVariables: Set<string>;
  /** Set of parameter names referenced via ctx.parameters() */
  referencedParameters: Set<string>;
  /** Map from sanitized variable names to original names (for variables with spaces, etc.) */
  variableOriginalNames?: Map<string, string>;
  /**
   * Flow-wide set of action names already emitted. Used by the IR transformer
   * to suffix duplicate auto-generated names (e.g. two `Check_ctx` ifs) — PA
   * requires unique action names per workflow, and the debug runner uses names
   * to track per-step execution, so collisions would silently skip steps.
   */
  usedActionNames: Set<string>;
}

export function createTransformContext(): TransformContext {
  return {
    trackedVariables: new Set(),
    referencedParameters: new Set(),
    variableOriginalNames: new Map(),
    usedActionNames: new Set(),
  };
}

/**
 * Transform a TypeScript expression to a Power Automate expression string.
 * @param node - The TypeScript AST node to transform
 * @param ctx - The transformation context
 * @param isRoot - Whether this is the root of the expression (default: true)
 *                 When true, certain constructs will get the @ prefix.
 *                 When false (nested calls), no @ prefix is added.
 */
export function transformExpression(node: Expression, ctx: TransformContext, isRoot = true): string {
  const kind = node.getKind();

  switch (kind) {
    case SyntaxKind.CallExpression:
      return transformCallExpression(node.asKindOrThrow(SyntaxKind.CallExpression), ctx, isRoot);

    case SyntaxKind.PropertyAccessExpression:
      return transformPropertyAccess(node.asKindOrThrow(SyntaxKind.PropertyAccessExpression), ctx, isRoot);

    case SyntaxKind.ElementAccessExpression:
      return transformElementAccess(node.asKindOrThrow(SyntaxKind.ElementAccessExpression), ctx, isRoot);

    case SyntaxKind.BinaryExpression:
      return transformBinaryExpression(node.asKindOrThrow(SyntaxKind.BinaryExpression), ctx, isRoot);

    case SyntaxKind.PrefixUnaryExpression:
      return transformPrefixUnary(node.asKindOrThrow(SyntaxKind.PrefixUnaryExpression), ctx, isRoot);

    case SyntaxKind.ParenthesizedExpression: {
      const inner = node.asKindOrThrow(SyntaxKind.ParenthesizedExpression).getExpression();
      return transformExpression(inner, ctx, isRoot);
    }

    case SyntaxKind.Identifier:
      return transformIdentifier(node.asKindOrThrow(SyntaxKind.Identifier), ctx, isRoot);

    case SyntaxKind.StringLiteral: {
      // Get the literal value (already unescaped by TypeScript parser)
      const value = node.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
      // Escape single quotes for Power Automate: ' -> ''
      // Note: @ does NOT need escaping inside PA expressions - it's only needed at the JSON level
      const escaped = value.replace(/'/g, "''");
      return `'${escaped}'`;
    }

    case SyntaxKind.NumericLiteral:
      return node.getText();

    case SyntaxKind.TrueKeyword:
      return 'true';

    case SyntaxKind.FalseKeyword:
      return 'false';

    case SyntaxKind.NullKeyword:
      return 'null';

    case SyntaxKind.ArrayLiteralExpression: {
      const arr = node.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
      const elements = arr.getElements().map(e => transformExpression(e, ctx, false));
      const result = `createArray(${elements.join(', ')})`;
      return isRoot ? `@${result}` : result;
    }

    case SyntaxKind.ObjectLiteralExpression: {
      // Object literals in expressions get serialized as JSON
      return node.getText();
    }

    case SyntaxKind.TemplateExpression:
    case SyntaxKind.NoSubstitutionTemplateLiteral: {
      // Template strings need special handling
      return transformTemplateString(node, ctx, isRoot);
    }

    case SyntaxKind.ConditionalExpression: {
      // Ternary: a ? b : c -> if(a, b, c)
      const cond = node.asKindOrThrow(SyntaxKind.ConditionalExpression);
      const condition = transformExpression(cond.getCondition(), ctx, false);
      const whenTrue = transformExpression(cond.getWhenTrue(), ctx, false);
      const whenFalse = transformExpression(cond.getWhenFalse(), ctx, false);
      const result = `if(${condition},${whenTrue},${whenFalse})`;
      return isRoot ? `@${result}` : result;
    }

    case SyntaxKind.AsExpression: {
      // Strip TypeScript type assertions (e.g., `x as any`) and transform the inner expression
      const inner = node.asKindOrThrow(SyntaxKind.AsExpression).getExpression();
      return transformExpression(inner, ctx, isRoot);
    }

    default:
      // Fallback: return the raw text
      return node.getText();
  }
}

/**
 * Transform a call expression.
 * Handles ctx.body(), ctx.triggerBody(), etc.
 */
function transformCallExpression(node: CallExpression, ctx: TransformContext, isRoot = true): string {
  const expression = node.getExpression();
  const args = node.getArguments();
  const maybePrefix = (expr: string) => isRoot ? `@${expr}` : expr;

  // Handle direct function calls like Boolean(x), String(x), Number(x)
  if (expression.getKind() === SyntaxKind.Identifier) {
    const funcName = expression.getText();

    if (funcName === 'Boolean' && args.length === 1) {
      const argExpr = transformExpression(args[0] as Expression, ctx, false);
      return maybePrefix(`bool(${argExpr})`);
    }
    if (funcName === 'String' && args.length === 1) {
      const argExpr = transformExpression(args[0] as Expression, ctx, false);
      return maybePrefix(`string(${argExpr})`);
    }
    if (funcName === 'Number' && args.length === 1) {
      const argExpr = transformExpression(args[0] as Expression, ctx, false);
      return maybePrefix(`int(${argExpr})`);
    }
  }

  // Check if this is a method call (obj.method())
  if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
    const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const obj = propAccess.getExpression();
    const methodName = propAccess.getName();

    // Check if it's ctx.something()
    if (obj.getKind() === SyntaxKind.Identifier && obj.getText() === 'ctx') {
      return transformContextMethodCall(methodName, node, ctx, isRoot);
    }

    // Handle JavaScript static methods (JSON.parse, etc.)
    if (obj.getKind() === SyntaxKind.Identifier) {
      const objName = obj.getText();

      // JSON.parse(x) -> json(x)
      if (objName === 'JSON' && methodName === 'parse' && args.length === 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`json(${argExpr})`);
      }
      // JSON.stringify(x) -> string(x) (approximate)
      if (objName === 'JSON' && methodName === 'stringify' && args.length >= 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`string(${argExpr})`);
      }
    }

    // Handle JavaScript string/array methods and convert back to Power Automate functions
    const baseExpr = transformExpression(obj, ctx, false);

    switch (methodName) {
      // String methods -> PA functions
      case 'toLowerCase':
        return maybePrefix(`toLower(${baseExpr})`);

      case 'toUpperCase':
        return maybePrefix(`toUpper(${baseExpr})`);

      case 'trim':
        return maybePrefix(`trim(${baseExpr})`);

      case 'substring': {
        const startArg = args.length > 0 ? transformExpression(args[0] as Expression, ctx, false) : '0';
        if (args.length > 1) {
          // JavaScript: substring(start, end) vs PA: substring(str, start, length)
          // This is approximate - PA uses length, not end index
          const endArg = transformExpression(args[1] as Expression, ctx, false);
          return maybePrefix(`substring(${baseExpr},${startArg},sub(${endArg},${startArg}))`);
        }
        return maybePrefix(`substring(${baseExpr},${startArg})`);
      }

      case 'split': {
        const delimiter = args.length > 0 ? transformExpression(args[0] as Expression, ctx, false) : "''";
        return maybePrefix(`split(${baseExpr},${delimiter})`);
      }

      case 'join': {
        const delimiter = args.length > 0 ? transformExpression(args[0] as Expression, ctx, false) : "''";
        return maybePrefix(`join(${baseExpr},${delimiter})`);
      }

      case 'indexOf': {
        const searchStr = args.length > 0 ? transformExpression(args[0] as Expression, ctx, false) : "''";
        return maybePrefix(`indexOf(${baseExpr},${searchStr})`);
      }

      case 'lastIndexOf': {
        const searchStr = args.length > 0 ? transformExpression(args[0] as Expression, ctx, false) : "''";
        return maybePrefix(`lastIndexOf(${baseExpr},${searchStr})`);
      }

      case 'includes': {
        const searchStr = args.length > 0 ? transformExpression(args[0] as Expression, ctx, false) : "''";
        return maybePrefix(`contains(${baseExpr},${searchStr})`);
      }

      case 'startsWith': {
        const searchStr = args.length > 0 ? transformExpression(args[0] as Expression, ctx, false) : "''";
        return maybePrefix(`startsWith(${baseExpr},${searchStr})`);
      }

      case 'endsWith': {
        const searchStr = args.length > 0 ? transformExpression(args[0] as Expression, ctx, false) : "''";
        return maybePrefix(`endsWith(${baseExpr},${searchStr})`);
      }

      case 'replace': {
        const oldStr = args.length > 0 ? transformExpression(args[0] as Expression, ctx, false) : "''";
        const newStr = args.length > 1 ? transformExpression(args[1] as Expression, ctx, false) : "''";
        return maybePrefix(`replace(${baseExpr},${oldStr},${newStr})`);
      }

      case 'slice': {
        const startArg = args.length > 0 ? transformExpression(args[0] as Expression, ctx, false) : '0';
        if (args.length > 1) {
          const endArg = transformExpression(args[1] as Expression, ctx, false);
          return maybePrefix(`take(skip(${baseExpr},${startArg}),sub(${endArg},${startArg}))`);
        }
        return maybePrefix(`skip(${baseExpr},${startArg})`);
      }
    }
  }

  // For other calls, transform the expression and arguments
  const callee = transformExpression(expression, ctx, false);
  const transformedArgs = args.map(arg => transformExpression(arg as Expression, ctx, false));
  return `${callee}(${transformedArgs.join(', ')})`;
}

/**
 * Transform ctx.method() calls to Power Automate expressions.
 */
function transformContextMethodCall(methodName: string, node: CallExpression, ctx: TransformContext, isRoot = true): string {
  const args = node.getArguments();
  // Helper to add @ prefix when this is a root expression
  const maybePrefix = (expr: string) => isRoot ? `@${expr}` : expr;
  // Generic fallback when an arg-count branch doesn't match the expected shape.
  // Recursively transforms args (so nested ctx.X calls become PA expressions) and
  // emits canonical PA form. Replaces the older `return node.getText()` fallbacks
  // which leaked literal `ctx.method(...)` JS code into the IR.
  const genericTransform = () => {
    const argExprs = args.map(a => transformExpression(a as Expression, ctx, false));
    return maybePrefix(`${methodName}(${argExprs.join(', ')})`);
  };

  switch (methodName) {
    case 'body': {
      if (args.length === 0) {
        return maybePrefix('body()');
      }
      const actionName = getStringLiteralValue(args[0]);
      return maybePrefix(`body('${actionName.replace(/'/g, "''")}')`);
    }

    case 'outputs': {
      if (args.length === 0) {
        return maybePrefix('outputs()');
      }
      const actionName = getStringLiteralValue(args[0]);
      return maybePrefix(`outputs('${actionName.replace(/'/g, "''")}')`);
    }

    case 'actions': {
      const actionName = getStringLiteralValue(args[0]);
      return maybePrefix(`actions('${actionName.replace(/'/g, "''")}')`);
    }

    case 'triggerBody':
      return maybePrefix('triggerBody()');

    case 'triggerOutputs':
      return maybePrefix('triggerOutputs()');

    case 'variables': {
      const sanitizedName = getStringLiteralValue(args[0]);
      // Use original name if available (for variables with spaces, etc.)
      const originalName = ctx.variableOriginalNames?.get(sanitizedName) ?? sanitizedName;
      return maybePrefix(`variables('${originalName}')`);
    }

    case 'item':
      return maybePrefix('item()');

    case 'items': {
      const loopName = getStringLiteralValue(args[0]);
      return maybePrefix(`items('${loopName}')`);
    }

    case 'parameters': {
      const paramName = getStringLiteralValue(args[0]);
      // Track the parameter reference for validation
      ctx.referencedParameters.add(paramName);
      return maybePrefix(`parameters('${paramName}')`);
    }

    case 'trigger':
      return maybePrefix('trigger()');

    case 'workflow':
      return maybePrefix('workflow()');

    // Result function - returns the result of a scope action
    case 'result': {
      if (args.length > 0) {
        const actionName = getStringLiteralValue(args[0]);
        return maybePrefix(`result('${actionName}')`);
      }
      return maybePrefix('result()');
    }

    // Date/time functions
    case 'utcNow': {
      // utcNow can take an optional format argument
      if (args.length > 0) {
        const argStrs = args.map((a) => transformExpression(a as Expression, ctx, false));
        return maybePrefix(`utcNow(${argStrs.join(', ')})`);
      }
      return maybePrefix('utcNow()');
    }

    case 'addDays':
    case 'addHours':
    case 'addMinutes':
    case 'addSeconds':
    case 'formatDateTime':
    case 'parseDateTime':
    case 'startOfDay':
    case 'startOfHour':
    case 'startOfMonth':
    case 'dayOfWeek':
    case 'dayOfMonth':
    case 'dayOfYear':
    case 'ticks':
    case 'convertFromUtc':
    case 'convertToUtc':
    case 'convertTimeZone': {
      const argStrs = args.map((a) => transformExpression(a as Expression, ctx, false));
      return maybePrefix(`${methodName}(${argStrs.join(', ')})`);
    }

    // GUID
    case 'guid':
      return maybePrefix('guid()');

    // Base64 functions
    case 'base64': {
      if (args.length === 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`base64(${argExpr})`);
      }
      return genericTransform();
    }

    case 'base64ToString': {
      if (args.length === 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`base64ToString(${argExpr})`);
      }
      return genericTransform();
    }

    // URI encoding functions
    case 'uriComponent': {
      if (args.length === 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`uriComponent(${argExpr})`);
      }
      return genericTransform();
    }

    case 'uriComponentToString': {
      if (args.length === 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`uriComponentToString(${argExpr})`);
      }
      return genericTransform();
    }

    case 'decodeUriComponent': {
      if (args.length === 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`decodeUriComponent(${argExpr})`);
      }
      return genericTransform();
    }

    // Type conversion functions
    case 'json': {
      // ctx.json(x) -> json(x)
      if (args.length === 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`json(${argExpr})`);
      }
      return genericTransform();
    }

    case 'string': {
      // ctx.string(x) -> string(x)
      if (args.length === 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`string(${argExpr})`);
      }
      return genericTransform();
    }

    case 'bool': {
      // ctx.bool(x) -> bool(x) (for @bool(...) expressions)
      if (args.length === 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`bool(${argExpr})`);
      }
      return genericTransform();
    }

    // ctx.atTrue() -> @true, ctx.atFalse() -> @false (for parity with @true/@false literals)
    // These always return @true/@false regardless of isRoot
    case 'atTrue': {
      return '@true';
    }

    case 'atFalse': {
      return '@false';
    }

    case 'atNumber': {
      // ctx.atNumber(n) -> @n (for parity with @0, @1, etc. literals)
      if (args.length >= 1) {
        const numArg = args[0].getText();
        return `@${numArg}`;
      }
      return '@0';
    }

    case 'atString': {
      // ctx.atString('text') -> @'text' (PA quoted-string-literal expression)
      if (args.length >= 1) {
        const arg = args[0];
        if (arg.getKind() === SyntaxKind.StringLiteral) {
          const value = arg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
          return `@'${value.replace(/'/g, "''")}'`;
        }
      }
      return "@''";
    }

    case 'null': {
      // ctx.null() -> @null (for parity)
      return '@null';
    }

    case 'and': {
      // ctx.and(x) -> and(x) - preserves single-element and wrapper for parity
      if (args.length === 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`and(${argExpr})`);
      }
      return genericTransform();
    }

    case 'or': {
      // ctx.or(x) -> or(x) - preserves single-element or wrapper for parity
      if (args.length === 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`or(${argExpr})`);
      }
      return genericTransform();
    }

    case 'int': {
      // ctx.int(x) -> int(x)
      if (args.length === 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`int(${argExpr})`);
      }
      return genericTransform();
    }

    case 'float': {
      // ctx.float(x) -> float(x)
      if (args.length === 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`float(${argExpr})`);
      }
      return genericTransform();
    }

    case 'rand': {
      // ctx.rand(min, max) -> rand(min,max)
      if (args.length === 2) {
        const minExpr = transformExpression(args[0] as Expression, ctx, false);
        const maxExpr = transformExpression(args[1] as Expression, ctx, false);
        return maybePrefix(`rand(${minExpr},${maxExpr})`);
      }
      return genericTransform();
    }

    case 'coalesce': {
      // ctx.coalesce(x) -> coalesce(x) (for single-arg coalesce preservation)
      if (args.length === 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`coalesce(${argExpr})`);
      }
      return genericTransform();
    }

    // Empty check - ctx.empty(x) -> empty(x)
    case 'empty': {
      if (args.length === 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`empty(${argExpr})`);
      }
      return genericTransform();
    }

    // Contains check - ctx.contains(collection, value) -> contains(collection, value)
    // Also handles 3-arg variant for parity with some Power Automate flows
    case 'contains': {
      const argExprs = args.map(a => transformExpression(a as Expression, ctx, false));
      return maybePrefix(`contains(${argExprs.join(',')})`);
    }

    // Array functions - ctx.first(x) -> first(x), ctx.last(x) -> last(x), etc.
    case 'first': {
      if (args.length === 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`first(${argExpr})`);
      }
      return genericTransform();
    }

    case 'last': {
      if (args.length === 1) {
        const argExpr = transformExpression(args[0] as Expression, ctx, false);
        return maybePrefix(`last(${argExpr})`);
      }
      return genericTransform();
    }

    case 'skip': {
      if (args.length === 2) {
        const arrExpr = transformExpression(args[0] as Expression, ctx, false);
        const countExpr = transformExpression(args[1] as Expression, ctx, false);
        return maybePrefix(`skip(${arrExpr},${countExpr})`);
      }
      return genericTransform();
    }

    case 'take': {
      if (args.length === 2) {
        const arrExpr = transformExpression(args[0] as Expression, ctx, false);
        const countExpr = transformExpression(args[1] as Expression, ctx, false);
        return maybePrefix(`take(${arrExpr},${countExpr})`);
      }
      return genericTransform();
    }

    // String concatenation - ctx.concat(...) -> concat(...)
    case 'concat': {
      const argExprs = args.map(a => transformExpression(a as Expression, ctx, false));
      return maybePrefix(`concat(${argExprs.join(', ')})`);
    }

    // ctx.eval() - extract the template string and return it as-is
    // This handles expressions that couldn't be fully parsed to TypeScript
    case 'eval': {
      if (args.length === 1) {
        const arg = args[0];
        // Check if it's a template literal
        if (arg.getKind() === SyntaxKind.TemplateExpression || arg.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
          // Extract the raw template string content
          const templateText = arg.getText();
          // Remove the backticks and return the content
          // The content already has @{...} expressions
          let content = templateText.slice(1, -1); // Remove ` at start and end
          // Unescape \$ and \` that were escaped for JS template literals
          content = content.replace(/\\\$/g, '$').replace(/\\`/g, '`');
          return content;
        }
        // For string literals, just extract the string value
        if (arg.getKind() === SyntaxKind.StringLiteral) {
          return getStringLiteralValue(arg);
        }
      }
      // Fallback - return the raw expression
      return node.getText();
    }

    // ctx.braced() - indicates the expression should be output with @{...} format
    case 'braced': {
      if (args.length === 1) {
        // Transform the inner expression without @ prefix
        const innerExpr = transformExpression(args[0] as Expression, ctx, false);
        // If the inner expression already has @{...} format (from ctx.eval), return as-is
        // Handle trailing whitespace that may be present from template literals
        const trimmed = innerExpr.trimEnd();
        if (trimmed.startsWith('@{') && trimmed.endsWith('}')) {
          return innerExpr;
        }
        // Otherwise wrap in @{...} format
        return `@{${innerExpr}}`;
      }
      return node.getText();
    }

    // Array functions
    case 'sort': {
      // ctx.sort(array, 'property') -> sort(array, 'property')
      if (args.length === 2) {
        const arrayExpr = transformExpression(args[0] as Expression, ctx, false);
        const propertyName = getStringLiteralValue(args[1]);
        return maybePrefix(`sort(${arrayExpr},'${propertyName}')`);
      }
      // Fallback if incorrect number of arguments
      return genericTransform();
    }

    default: {
      // Generic ctx.function() call - transform arguments and emit as Power Automate function
      // This handles functions like union(), intersection(), decodeBase64(), etc.
      // that weren't explicitly mapped above
      const argExprs = args.map(a => transformExpression(a as Expression, ctx, false));
      return maybePrefix(`${methodName}(${argExprs.join(', ')})`);
    }
  }
}

/**
 * Transform property access expressions.
 * Handles chains like ctx.body('Action').user.name
 * Also handles optional chaining: ctx.body('Action')?.user
 */
function transformPropertyAccess(node: PropertyAccessExpression, ctx: TransformContext, isRoot = true): string {
  const expression = node.getExpression();
  const propertyName = node.getName();
  // Check for optional chaining - Power Automate uses ?. for property access
  const isOptional = node.hasQuestionDotToken();
  const accessor = isOptional ? '?.' : '.';

  // Check for special properties
  if (propertyName === 'length') {
    const base = transformExpression(expression, ctx, false);
    const result = `length(${base})`;
    return isRoot ? `@${result}` : result;
  }

  // Check if base is a ctx call
  if (expression.getKind() === SyntaxKind.CallExpression) {
    const call = expression.asKindOrThrow(SyntaxKind.CallExpression);
    const callExpr = call.getExpression();

    if (callExpr.getKind() === SyntaxKind.PropertyAccessExpression) {
      const propAccess = callExpr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      const obj = propAccess.getExpression();

      if (obj.getText() === 'ctx') {
        // This is ctx.method().property or ctx.method()?.property
        const baseExpr = transformCallExpression(call, ctx, false);
        const result = `${baseExpr}${accessor}${propertyName}`;
        return isRoot ? `@${result}` : result;
      }
    }
  }

  // Regular property access
  const base = transformExpression(expression, ctx, false);
  const result = `${base}${accessor}${propertyName}`;
  return isRoot ? `@${result}` : result;
}

/**
 * Transform element access expressions (bracket notation).
 * Handles arr[0], obj['key'], obj?['key'], etc.
 * Note: Power Automate uses ?['key'] syntax (without dot), not ?.['key']
 */
function transformElementAccess(node: ElementAccessExpression, ctx: TransformContext, isRoot = true): string {
  const expression = node.getExpression();
  const argument = node.getArgumentExpression();
  // Check for optional chaining - Power Automate uses ?['key'] not ?.['key']
  const isOptional = node.hasQuestionDotToken();
  const optionalPrefix = isOptional ? '?' : '';

  const base = transformExpression(expression, ctx, false);
  const maybePrefix = (expr: string) => isRoot ? `@${expr}` : expr;

  if (!argument) {
    return maybePrefix(base);
  }

  const argKind = argument.getKind();

  if (argKind === SyntaxKind.NumericLiteral) {
    // Array index: arr[0] or arr?[0]
    return maybePrefix(`${base}${optionalPrefix}[${argument.getText()}]`);
  }

  if (argKind === SyntaxKind.StringLiteral) {
    // Object key: obj['key'] or obj?['key'] (Power Automate syntax without dot)
    const key = getStringLiteralValue(argument);
    return maybePrefix(`${base}${optionalPrefix}['${key}']`);
  }

  // Dynamic index
  const index = transformExpression(argument, ctx, false);
  return maybePrefix(`${base}${optionalPrefix}[${index}]`);
}

/**
 * Collect all parts of a string concatenation chain.
 * This flattens nested + operations like ((a + b) + c) into [a, b, c]
 * so we can emit concat(a, b, c) instead of concat(concat(a, b), c).
 */
function collectConcatParts(node: BinaryExpression, ctx: TransformContext): string[] {
  const parts: string[] = [];
  const left = node.getLeft();
  const right = node.getRight();

  // Recursively collect from left side if it's also a string concatenation
  if (left.getKind() === SyntaxKind.BinaryExpression) {
    const leftBinary = left.asKindOrThrow(SyntaxKind.BinaryExpression);
    if (leftBinary.getOperatorToken().getKind() === SyntaxKind.PlusToken &&
        (isLikelyStringExpression(leftBinary.getLeft()) || isLikelyStringExpression(leftBinary.getRight()))) {
      parts.push(...collectConcatParts(leftBinary, ctx));
    } else {
      parts.push(transformExpression(left, ctx, false));
    }
  } else {
    parts.push(transformExpression(left, ctx, false));
  }

  // Recursively collect from right side if it's also a string concatenation
  if (right.getKind() === SyntaxKind.BinaryExpression) {
    const rightBinary = right.asKindOrThrow(SyntaxKind.BinaryExpression);
    if (rightBinary.getOperatorToken().getKind() === SyntaxKind.PlusToken &&
        (isLikelyStringExpression(rightBinary.getLeft()) || isLikelyStringExpression(rightBinary.getRight()))) {
      parts.push(...collectConcatParts(rightBinary, ctx));
    } else {
      parts.push(transformExpression(right, ctx, false));
    }
  } else {
    parts.push(transformExpression(right, ctx, false));
  }

  return parts;
}

/**
 * Collect all operands from a chained && or || expression.
 * This flattens nested logical operations like ((a && b) && c) into [a, b, c]
 * so we can emit and(a, b, c) instead of and(and(a, b), c).
 */
function collectLogicalParts(node: BinaryExpression, targetOperator: SyntaxKind, ctx: TransformContext): string[] {
  const parts: string[] = [];
  const left = node.getLeft();
  const right = node.getRight();

  // Recursively collect from left side if it's also the same logical operator
  if (left.getKind() === SyntaxKind.BinaryExpression) {
    const leftBinary = left.asKindOrThrow(SyntaxKind.BinaryExpression);
    if (leftBinary.getOperatorToken().getKind() === targetOperator) {
      parts.push(...collectLogicalParts(leftBinary, targetOperator, ctx));
    } else {
      parts.push(transformExpression(left, ctx, false));
    }
  } else {
    parts.push(transformExpression(left, ctx, false));
  }

  // Recursively collect from right side if it's also the same logical operator
  if (right.getKind() === SyntaxKind.BinaryExpression) {
    const rightBinary = right.asKindOrThrow(SyntaxKind.BinaryExpression);
    if (rightBinary.getOperatorToken().getKind() === targetOperator) {
      parts.push(...collectLogicalParts(rightBinary, targetOperator, ctx));
    } else {
      parts.push(transformExpression(right, ctx, false));
    }
  } else {
    parts.push(transformExpression(right, ctx, false));
  }

  return parts;
}

/**
 * Transform binary expressions.
 * Handles ==, ===, >, <, &&, ||, +, -, etc.
 */
function transformBinaryExpression(node: BinaryExpression, ctx: TransformContext, isRoot = true): string {
  const left = node.getLeft();
  const right = node.getRight();
  const operator = node.getOperatorToken().getKind();

  // Pass isRoot=false to nested expressions so they don't get @ prefix
  const leftExpr = transformExpression(left, ctx, false);
  const rightExpr = transformExpression(right, ctx, false);

  // Helper to add @ only at root level
  const maybePrefix = (expr: string) => isRoot ? `@${expr}` : expr;

  switch (operator) {
    // Equality
    case SyntaxKind.EqualsEqualsToken:
    case SyntaxKind.EqualsEqualsEqualsToken:
      return maybePrefix(`equals(${leftExpr}, ${rightExpr})`);

    // Inequality - not(equals(...))
    case SyntaxKind.ExclamationEqualsToken:
    case SyntaxKind.ExclamationEqualsEqualsToken:
      return maybePrefix(`not(equals(${leftExpr}, ${rightExpr}))`);

    // Comparison
    case SyntaxKind.GreaterThanToken:
      return maybePrefix(`greater(${leftExpr}, ${rightExpr})`);

    case SyntaxKind.LessThanToken:
      return maybePrefix(`less(${leftExpr}, ${rightExpr})`);

    case SyntaxKind.GreaterThanEqualsToken:
      return maybePrefix(`greaterOrEquals(${leftExpr}, ${rightExpr})`);

    case SyntaxKind.LessThanEqualsToken:
      return maybePrefix(`lessOrEquals(${leftExpr}, ${rightExpr})`);

    // Logical - flatten chained && or || to avoid nested and(and(a,b),c)
    case SyntaxKind.AmpersandAmpersandToken: {
      const allParts = collectLogicalParts(node, SyntaxKind.AmpersandAmpersandToken, ctx);
      return maybePrefix(`and(${allParts.join(', ')})`);
    }

    case SyntaxKind.BarBarToken: {
      const allParts = collectLogicalParts(node, SyntaxKind.BarBarToken, ctx);
      return maybePrefix(`or(${allParts.join(', ')})`);
    }

    // Null coalescing - flatten chained ?? to avoid nested coalesce(coalesce(a,b),c)
    case SyntaxKind.QuestionQuestionToken: {
      const allParts = collectLogicalParts(node, SyntaxKind.QuestionQuestionToken, ctx);
      return maybePrefix(`coalesce(${allParts.join(', ')})`);
    }

    // Arithmetic
    case SyntaxKind.PlusToken: {
      // Check if string concatenation or numeric addition
      if (isLikelyStringExpression(left) || isLikelyStringExpression(right)) {
        // Flatten nested string concatenations to produce concat(a, b, c) instead of concat(concat(a, b), c)
        const allParts = collectConcatParts(node, ctx);
        return maybePrefix(`concat(${allParts.join(', ')})`);
      }
      return maybePrefix(`add(${leftExpr}, ${rightExpr})`);
    }

    case SyntaxKind.MinusToken:
      return maybePrefix(`sub(${leftExpr}, ${rightExpr})`);

    case SyntaxKind.AsteriskToken:
      return maybePrefix(`mul(${leftExpr}, ${rightExpr})`);

    case SyntaxKind.SlashToken:
      return maybePrefix(`div(${leftExpr}, ${rightExpr})`);

    case SyntaxKind.PercentToken:
      return maybePrefix(`mod(${leftExpr}, ${rightExpr})`);

    default:
      // Fallback for unknown operators
      return `${leftExpr} ${node.getOperatorToken().getText()} ${rightExpr}`;
  }
}

/**
 * Transform prefix unary expressions.
 * Handles !x, -x, etc.
 */
function transformPrefixUnary(node: PrefixUnaryExpression, ctx: TransformContext, isRoot = true): string {
  const operand = node.getOperand();
  const operator = node.getOperatorToken();

  // Pass isRoot=false to nested expressions
  const operandExpr = transformExpression(operand, ctx, false);

  switch (operator) {
    case SyntaxKind.ExclamationToken: {
      const result = `not(${operandExpr})`;
      return isRoot ? `@${result}` : result;
    }

    case SyntaxKind.MinusToken:
      return `-${operandExpr}`;

    case SyntaxKind.PlusToken:
      return operandExpr;

    default:
      return node.getText();
  }
}

/**
 * Transform identifier references.
 * Handles variable names and loop variables.
 */
function transformIdentifier(node: Identifier, ctx: TransformContext, isRoot = true): string {
  const name = node.getText();
  const maybePrefix = (expr: string) => isRoot ? `@${expr}` : expr;

  // Check if this is the current loop variable
  if (ctx.loopVariable && name === ctx.loopVariable) {
    if (ctx.loopName) {
      return maybePrefix(`items('${ctx.loopName}')`);
    }
    return maybePrefix('item()');
  }

  // Check if this is an outer loop variable (nested foreach)
  if (ctx.loopVariables?.has(name)) {
    return maybePrefix(`items('${ctx.loopVariables.get(name)}')`);
  }

  // Check if this is a tracked variable
  if (ctx.trackedVariables.has(name)) {
    return maybePrefix(`variables('${name}')`);
  }

  // Return as-is (might be a parameter or external reference)
  return name;
}

/**
 * Transform template string to Power Automate expression using inline @{...} format.
 * This preserves the original format for better parity with Logic Apps JSON.
 *
 * For templates with any literal text (before/between/after expressions):
 *   outputs: "literal @{expr} more literal" or "@{expr}-@{expr2}-1"
 * For templates with only expressions (no literal text):
 *   outputs: @concat(expr1, expr2)
 */
function transformTemplateString(node: Expression, ctx: TransformContext, isRoot = true): string {
  if (node.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
    // Simple template without expressions - use getText and strip backticks
    let text = node.getText().slice(1, -1); // Remove ` from start and end
    // Unescape template literal escapes
    text = unescapeTemplateLiteral(text);
    return `'${text}'`;
  }

  // Template with expressions: `Hello ${name}` or `${expr}...`
  const template = node.asKindOrThrow(SyntaxKind.TemplateExpression);
  const headText = template.getHead().getText();
  // Remove the opening ` and trailing ${
  const head = headText.slice(1, -2);
  const spans = template.getTemplateSpans();

  // Check if template has any literal text (before/between/after expressions)
  // If so, use inline @{...} format for better parity with Logic Apps
  let hasLiteralText = head.length > 0;
  if (!hasLiteralText) {
    for (const span of spans) {
      const literalText = span.getLiteral().getText();
      // Remove leading } and trailing ` or ${
      const literal = literalText.startsWith('}')
        ? literalText.slice(1, literalText.endsWith('`') ? -1 : -2)
        : literalText;
      if (literal.length > 0) {
        hasLiteralText = true;
        break;
      }
    }
  }

  if (hasLiteralText && isRoot) {
    // Use inline format: "literal @{expr} more literal" or "@{expr}-@{expr2}-1"
    // Unescape template literal escapes (\$ -> $, \` -> `)
    let result = unescapeTemplateLiteral(head);

    for (const span of spans) {
      // Transform the expression without @ prefix since we'll wrap in @{...}
      const expr = transformExpression(span.getExpression(), ctx, false);
      result += `@{${expr}}`;

      const literalText = span.getLiteral().getText();
      // Remove leading } and trailing ` or ${
      let literal = literalText.startsWith('}')
        ? literalText.slice(1, literalText.endsWith('`') ? -1 : -2)
        : literalText;
      // Unescape template literal escapes
      literal = unescapeTemplateLiteral(literal);
      result += literal;
    }

    return result;
  }

  // Template has only expressions (no literal text), or is nested - use concat format
  const parts: string[] = [];
  if (head) {
    // Unescape template literal escapes
    parts.push(`'${unescapeTemplateLiteral(head)}'`);
  }

  for (const span of spans) {
    // Nested expressions should not get @ prefix
    const expr = transformExpression(span.getExpression(), ctx, false);
    parts.push(expr);

    const literalText = span.getLiteral().getText();
    // Remove leading } and trailing ` or ${
    let literal = literalText.startsWith('}')
      ? literalText.slice(1, literalText.endsWith('`') ? -1 : -2)
      : literalText;
    if (literal) {
      // Unescape template literal escapes
      literal = unescapeTemplateLiteral(literal);
      parts.push(`'${literal}'`);
    }
  }

  if (parts.length === 1) {
    // Single expression with no literal text - use @{expr} format for parity
    // This matches the original format: @{replace(...)} or @{variables('x')}
    return isRoot ? `@{${parts[0]}}` : parts[0];
  }

  // At root, multiple expressions with no literal text — emit as adjacent @{...} templates
  // (the PA UI's canonical form for "@{X}@{Y}"). concat(X, Y) would also work but loses parity.
  // When isRoot is true here, hasLiteralText is guaranteed false (the inline branch above handled
  // the literal-text case), so all `parts` are pure expressions.
  if (isRoot) {
    return parts.map(p => `@{${p}}`).join('');
  }

  const result = `concat(${parts.join(', ')})`;
  return result;
}

/**
 * Transform template string to inline @{...} format for text content.
 * Used for email body, message content, etc. where inline expressions are preferred.
 *
 * Example:
 * Input:  `Hello ${ctx.parameters("Name")}, your order is ready.`
 * Output: "Hello @{parameters('Name')}, your order is ready."
 */
export function transformTemplateStringInline(node: Expression, ctx: TransformContext): string {
  if (node.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
    // Simple template without expressions
    const text = node.getText().slice(1, -1); // Remove ` from start and end
    return unescapeTemplateLiteral(text);
  }

  // Template with expressions: `Hello ${name}`
  const template = node.asKindOrThrow(SyntaxKind.TemplateExpression);
  const headText = template.getHead().getText();
  // Remove the opening ` and trailing ${
  const head = headText.slice(1, -2);
  const spans = template.getTemplateSpans();

  // Unescape template literal escapes in head
  let result = unescapeTemplateLiteral(head);

  for (const span of spans) {
    // Transform the expression without @ prefix since we'll wrap in @{...}
    const expr = transformExpression(span.getExpression(), ctx, false);
    result += `@{${expr}}`;

    const literalText = span.getLiteral().getText();
    // Remove leading } and trailing ` or ${
    let literal = literalText.startsWith('}')
      ? literalText.slice(1, literalText.endsWith('`') ? -1 : -2)
      : literalText;
    // Unescape template literal escapes
    literal = unescapeTemplateLiteral(literal);
    result += literal;
  }

  return result;
}

/**
 * Check if an expression is likely a string type.
 */
function isLikelyStringExpression(node: Expression): boolean {
  const kind = node.getKind();

  if (
    kind === SyntaxKind.StringLiteral ||
    kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === SyntaxKind.TemplateExpression
  ) {
    return true;
  }

  // Check for string methods
  if (kind === SyntaxKind.CallExpression) {
    const call = node.asKindOrThrow(SyntaxKind.CallExpression);
    const expr = call.getExpression();
    if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
      const prop = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      const methodName = prop.getName();
      const stringMethods = ['toString', 'toLowerCase', 'toUpperCase', 'trim', 'substring', 'slice'];
      if (stringMethods.includes(methodName)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Unescape template literal escapes (\$ -> $, \` -> `, \\ -> \)
 */
function unescapeTemplateLiteral(str: string): string {
  return str
    .replace(/\\\$/g, '$')
    .replace(/\\`/g, '`')
    .replace(/\\\\/g, '\\');
}

/**
 * Extract string literal value from a node.
 */
function getStringLiteralValue(node: Node): string {
  if (node.getKind() === SyntaxKind.StringLiteral) {
    return node.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
  }
  // Fallback: strip quotes from text
  const text = node.getText();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Transform an expression specifically for use as a condition.
 * Ensures the result starts with @ for Logic Apps.
 */
export function transformCondition(node: Expression, ctx: TransformContext): string {
  const result = transformExpression(node, ctx);

  // Ensure condition starts with @
  if (!result.startsWith('@')) {
    return `@${result}`;
  }

  return result;
}

/**
 * Transform an expression for use as an items expression in foreach.
 */
export function transformItemsExpression(node: Expression, ctx: TransformContext): string {
  const result = transformExpression(node, ctx);

  // Ensure it starts with @
  if (!result.startsWith('@')) {
    return `@${result}`;
  }

  return result;
}
