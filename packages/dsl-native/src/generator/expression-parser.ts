/**
 * Expression Parser for Native DSL Generator
 * Converts Power Automate expression strings back to TypeScript/ctx method calls.
 *
 * Examples:
 * - @equals(body('X'), 1) → ctx.body('X') === 1
 * - @outputs('GetItems')?['body/value'] → ctx.outputs('GetItems')?.['body/value']
 * - @and(equals(x, y), greater(a, b)) → ctx.body('x') === ctx.body('y') && ctx.body('a') > ctx.body('b')
 * - body('ActionName').value → ctx.body('ActionName').value
 * - items('LoopName')?['field'] → ctx.items('LoopName')?.['field']
 */

import { type GeneratorConfig, getGeneratorConfig } from '@flowforger/ir';

// Module-level loop context for the current parse.
// Set by parseExpressionToTypeScript, read by parseFunctionCall.
let _loopMap: Map<string, string> | undefined;
let _currentLoopVar: string | undefined;

export interface ParseResult {
  /** TypeScript code using ctx methods */
  code: string;
  /** Whether the expression could be fully parsed */
  success: boolean;
  /** Original expression if parsing failed */
  original?: string;
}

/**
 * Variable name mapping for collision-free variable references.
 */
export interface VariableNameMap {
  [originalName: string]: {
    sanitized: string;
    needsTag: boolean;
  };
}

// Helper: Sanitize name for TypeScript identifier (matches generator.ts)
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

/**
 * Find a variable in the map using case-insensitive lookup.
 * Returns the sanitized name if found, undefined otherwise.
 */
function findVariableInMap(varName: string, variableMap?: VariableNameMap): string | undefined {
  if (!variableMap) return undefined;

  // First try exact match (fastest)
  if (variableMap[varName]) {
    return variableMap[varName].sanitized;
  }

  // Case-insensitive search
  const lowerVarName = varName.toLowerCase();
  for (const key in variableMap) {
    if (key.toLowerCase() === lowerVarName) {
      return variableMap[key].sanitized;
    }
  }

  return undefined;
}

/**
 * Options for parsing expressions.
 */
export interface ParseExpressionOptions {
  /** Variable name mapping for collision-free references */
  variableMap?: VariableNameMap;
  /** Generator configuration */
  config?: GeneratorConfig;
  /** Loop name → variable name mapping for resolving items() to loop variables */
  loopMap?: Map<string, string>;
  /** The variable name of the innermost enclosing foreach loop */
  currentLoopVar?: string;
}

/**
 * Type guard to check if options is ParseExpressionOptions (vs VariableNameMap)
 */
function isParseExpressionOptions(options: unknown): options is ParseExpressionOptions {
  if (!options || typeof options !== 'object') return false;
  // ParseExpressionOptions has optional 'config' or 'variableMap' keys
  // VariableNameMap has keys that map to { sanitized: string, needsTag: boolean }
  // Check if it looks like ParseExpressionOptions by checking for known keys or structure
  const keys = Object.keys(options);
  if (keys.length === 0) return true; // Empty object, treat as ParseExpressionOptions
  if ('config' in options || 'variableMap' in options || 'loopMap' in options || 'currentLoopVar' in options) return true;
  // Check if first value looks like VariableNameMap entry
  const firstValue = (options as Record<string, unknown>)[keys[0]];
  if (firstValue && typeof firstValue === 'object' && 'sanitized' in firstValue) {
    return false; // It's a VariableNameMap
  }
  return true;
}

/**
 * Parse a Power Automate expression and convert to TypeScript ctx method calls.
 *
 * @param expression - The Power Automate expression string
 * @param optionsOrVariableMap - Either ParseExpressionOptions or legacy VariableNameMap
 * @returns ParseResult with the converted code
 */
export function parseExpressionToTypeScript(
  expression: string,
  optionsOrVariableMap?: ParseExpressionOptions | VariableNameMap
): ParseResult {
  // Handle legacy call signature (variableMap only)
  let variableMap: VariableNameMap | undefined;
  let config: GeneratorConfig;

  if (isParseExpressionOptions(optionsOrVariableMap)) {
    variableMap = optionsOrVariableMap?.variableMap;
    config = getGeneratorConfig({ generator: optionsOrVariableMap?.config });
    _loopMap = optionsOrVariableMap?.loopMap;
    _currentLoopVar = optionsOrVariableMap?.currentLoopVar;
  } else {
    variableMap = optionsOrVariableMap;
    config = getGeneratorConfig();
    _loopMap = undefined;
    _currentLoopVar = undefined;
  }

  if (!expression) {
    return { code: 'true', success: true };
  }

  function hasIrregularTopLevelCommaSpacing(expr: string): boolean {
    let depth = 0;
    let inString = false;
    let stringChar = '';
    let sawSpaced = false;
    let sawUnspaced = false;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (inString) {
        if (ch === stringChar && expr[i + 1] !== stringChar) inString = false;
        else if (ch === stringChar && expr[i + 1] === stringChar) i++;
        continue;
      }
      if (ch === "'" || ch === '"') { inString = true; stringChar = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',') {
        const next = expr[i + 1];
        if (next === ' ' || next === '\t') sawSpaced = true;
        else sawUnspaced = true;
      }
    }
    return sawSpaced && sawUnspaced;
  }

  // Check for multiline expressions that should be preserved
  const hasMultilineFormatting = expression.includes('\r\n') || expression.includes('\n');
  if (hasMultilineFormatting && config.multilineExpressions === 'preserve') {
    // Preserve the original expression using ctx.eval()
    return {
      code: `ctx.eval(\`${escapeBackticks(expression)}\`)`,
      success: true,
    };
  }

  // Preserve expressions with trailing whitespace verbatim. The parser/reconstitution
  // path normalizes whitespace (trim + canonical comma spacing), which loses fidelity.
  if (expression !== expression.trimEnd()) {
    return {
      code: `ctx.eval(\`${escapeBackticks(expression)}\`)`,
      success: true,
    };
  }

  // Preserve expressions whose comma spacing is irregular at the top level —
  // some commas have a following space and others don't. The transformer always
  // emits canonical `, ` so any regeneration would lose source fidelity.
  if (hasIrregularTopLevelCommaSpacing(expression)) {
    return {
      code: `ctx.eval(\`${escapeBackticks(expression)}\`)`,
      success: true,
    };
  }

  // Preserve expressions containing an explicit `+<number>` sign — the parser
  // strips the `+` prefix when re-emitting (numbers don't require a leading sign),
  // which breaks byte-exact parity for sources that write `+1` literally.
  if (/[(,]\s*\+\d/.test(expression)) {
    return {
      code: `ctx.eval(\`${escapeBackticks(expression)}\`)`,
      success: true,
    };
  }

  // Remove leading @ if present
  let expr = expression.trim();
// Handle @@ escape sequence (literal @)
  // In Power Automate, @@ produces a literal @ character
  if (expr.startsWith('@@')) {
    // Replace leading @@ with single @ and return as string literal
    const literal = '@' + expr.slice(2);
    return { code: JSON.stringify(literal), success: true };
  }

  if (expr.startsWith('@{')) {
    // Template expression: @{expression}
    expr = expr.slice(2, -1);
  } else if (expr === '@true') {
    // Preserve @true as ctx.atTrue() for parity (distinct from @bool(true))
    return { code: 'ctx.atTrue()', success: true };
  } else if (expr === '@false') {
    // Preserve @false as ctx.atFalse() for parity (distinct from @bool(false))
    return { code: 'ctx.atFalse()', success: true };
  } else if (expr === '@null') {
    // Preserve @null as ctx.null() for parity
    return { code: 'ctx.null()', success: true };
  } else if (/^@-?\d+(\.\d+)?$/.test(expr)) {
    // Preserve @<number> (like @0, @1, @-5, @3.14) as ctx.atNumber() for parity
    // These are distinct from plain numeric literals and should be preserved
    const numStr = expr.slice(1);
    return { code: `ctx.atNumber(${numStr})`, success: true };
  } else if (/^@'[^']*'$/.test(expr)) {
    // Preserve @'<text>' (PA quoted-string-literal expression) as ctx.atString()
    // for parity. Distinct from a plain JSON string with the same value because
    // the source carries the `@` prefix in JSON.
    const inner = expr.slice(2, -1);
    return { code: `ctx.atString(${JSON.stringify(inner)})`, success: true };
  } else if (expr.startsWith('@')) {
    expr = expr.slice(1);
  }

  try {
    const code = parseExpression(expr, variableMap);
    return { code, success: true };
  } catch {
    // If parsing fails, return a fallback with eval
    return {
      code: `ctx.eval(\`${escapeBackticks(expression)}\`)`,
      success: false,
      original: expression,
    };
  }
}

/**
 * Parse an expression recursively.
 */
function parseExpression(expr: string, variableMap?: VariableNameMap): string {
  expr = expr.trim();

  if (!expr) {
    return 'true';
  }

  // Handle @true and @false specially before stripping @ prefix
  // Use atTrue()/atFalse() to distinguish from bool(true)/bool(false)
  if (expr === '@true') {
    return 'ctx.atTrue()';
  }
  if (expr === '@false') {
    return 'ctx.atFalse()';
  }
  if (expr === '@null') {
    return 'ctx.null()';
  }
  // Handle @<number> patterns like @0, @1, @-5 for parity
  if (/^@-?\d+(\.\d+)?$/.test(expr)) {
    const numStr = expr.slice(1);
    return `ctx.atNumber(${numStr})`;
  }
  // Handle @'<text>' (PA quoted-string-literal expression) — preserve `@` prefix
  // for parity. Distinct from a plain JSON string with the same value.
  if (/^@'[^']*'$/.test(expr)) {
    const inner = expr.slice(2, -1);
    return `ctx.atString(${JSON.stringify(inner)})`;
  }

  // Strip leading @ if present (for nested expressions like @equals inside @and)
  if (expr.startsWith('@')) {
    expr = expr.slice(1);
  }

  // String literal must be checked BEFORE function-call detection — a literal like
  // '(' (just a paren) contains '(' and would otherwise be misclassified as a call.
  // BUT only for "simple" literals: if the content has unescaped quotes inside
  // (e.g. 'empty(variables('X'))'), the old verbatim ctx.eval path round-trips
  // better, so fall through.
  if ((expr.startsWith("'") && expr.endsWith("'") && expr.length >= 2) ||
      (expr.startsWith('"') && expr.endsWith('"') && expr.length >= 2)) {
    const quote = expr[0];
    const content = expr.slice(1, -1);
    // PA escapes ' as '' inside single-quoted strings. content.replace(/''/g, '') would
    // remove valid escapes; instead test that no unescaped quote remains.
    const contentForCheck = quote === "'" ? content.replace(/''/g, '') : content;
    if (!contentForCheck.includes(quote)) {
      let processed = content;
      if (quote === "'") {
        processed = processed.replace(/''/g, "'");
      }
      processed = processed.replace(/\\/g, '\\\\');
      if (quote === "'") {
        processed = processed.replace(/'/g, "\\'");
      }
      if (quote === '"') {
        processed = processed.replace(/"/g, '\\"');
      }
      return `${quote}${processed}${quote}`;
    }
  }

  // Check for function calls
  const funcMatch = expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
  if (funcMatch) {
    return parseFunctionCall(expr, variableMap);
  }

  // Check for property access on expression
  if (expr.includes('(')) {
    return parseFunctionCallWithPropertyAccess(expr, variableMap);
  }

  // Literal values
  if (expr === 'true') return 'true';
  if (expr === 'false') return 'false';
  if (expr === 'null') return 'null';

  // String literal (unreachable now — handled above; kept for safety)
  if ((expr.startsWith("'") && expr.endsWith("'")) || (expr.startsWith('"') && expr.endsWith('"'))) {
    const quote = expr[0];
    let content = expr.slice(1, -1);

    // In Power Automate, '' represents a single quote inside a single-quoted string
    // Replace '' with ' to get the actual content
    if (quote === "'") {
      content = content.replace(/''/g, "'");
    }

    // Escape backslashes for TypeScript: \ -> \\
    content = content.replace(/\\/g, '\\\\');

    // For single-quoted strings, escape single quotes: ' -> \'
    if (quote === "'") {
      content = content.replace(/'/g, "\\'");
    }
    // For double-quoted strings, escape double quotes: " -> \"
    if (quote === '"') {
      content = content.replace(/"/g, '\\"');
    }

    return `${quote}${content}${quote}`;
  }

  // Number literal
  if (/^-?\d+(\.\d+)?$/.test(expr)) {
    return expr;
  }

  // Variable or identifier
  return expr;
}

/**
 * Check if an expression is fully wrapped in a single pair of parentheses,
 * e.g., "(a === b)" but not "(a + b) * (c + d)".
 */
function isFullyParenthesized(expr: string): boolean {
  if (!expr.startsWith('(') || !expr.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < expr.length - 1; i++) {
    if (expr[i] === '(') depth++;
    if (expr[i] === ')') depth--;
    if (depth === 0) return false; // Opening paren closed before the end
  }
  return true;
}

/**
 * Check if two parsed TypeScript expressions look like they'd cause a TS2367 cross-type
 * comparison error. Returns true when one side is a boolean or null literal and the other
 * is clearly a different type (expression, string, number).
 * Power Automate's equals() is loose-typed, but TypeScript's === is strict.
 */
function looksLikeCrossTypeComparison(left: string, right: string): boolean {
  const boolLiterals = new Set(['true', 'false']);
  const leftIsBool = boolLiterals.has(left);
  const rightIsBool = boolLiterals.has(right);
  const leftIsNull = left === 'null';
  const rightIsNull = right === 'null';

  // Boolean on one side, non-boolean on the other
  if (leftIsBool !== rightIsBool) return true;
  // null vs a string or number literal
  if (leftIsNull && !rightIsNull && right !== 'undefined') return true;
  if (rightIsNull && !leftIsNull && left !== 'undefined') return true;

  // Two distinct primitive literals (e.g. `1 === 2`, `'a' === 'b'`).
  // TypeScript narrows literal types to no-overlap, triggering TS2367.
  if (isPrimitiveLiteral(left) && isPrimitiveLiteral(right) && left !== right) return true;

  return false;
}

function isPrimitiveLiteral(s: string): boolean {
  // Numeric literal (int or decimal, optionally negative)
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  // String literal — single- or double-quoted, with no embedded same-quote
  if (/^'[^']*'$/.test(s)) return true;
  if (/^"[^"]*"$/.test(s)) return true;
  return false;
}

/**
 * Parse a function call and convert to TypeScript.
 */
function parseFunctionCall(expr: string, variableMap?: VariableNameMap): string {
  const { funcName, args, remainder } = parseFunctionParts(expr);

  switch (funcName.toLowerCase()) {
    // Comparison operators - convert to TypeScript operators.
    // PA comparisons are loose-typed (equals(string, bool) is valid).
    // Add `as any` cast when operand types clearly differ to prevent TS2367 errors.
    case 'equals':
      if (args.length === 2) {
        const left = parseExpression(args[0], variableMap);
        const right = parseExpression(args[1], variableMap);
        const leftExpr = looksLikeCrossTypeComparison(left, right) ? `(${left} as any)` : left;
        return `(${leftExpr} === ${right})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'greater':
      if (args.length === 2) {
        const left = parseExpression(args[0], variableMap);
        const right = parseExpression(args[1], variableMap);
        const leftExpr = looksLikeCrossTypeComparison(left, right) ? `(${left} as any)` : left;
        return `(${leftExpr} > ${right})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'less':
      if (args.length === 2) {
        const left = parseExpression(args[0], variableMap);
        const right = parseExpression(args[1], variableMap);
        const leftExpr = looksLikeCrossTypeComparison(left, right) ? `(${left} as any)` : left;
        return `(${leftExpr} < ${right})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'greaterorequals':
      if (args.length === 2) {
        const left = parseExpression(args[0], variableMap);
        const right = parseExpression(args[1], variableMap);
        const leftExpr = looksLikeCrossTypeComparison(left, right) ? `(${left} as any)` : left;
        return `(${leftExpr} >= ${right})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'lessorequals':
      if (args.length === 2) {
        const left = parseExpression(args[0], variableMap);
        const right = parseExpression(args[1], variableMap);
        const leftExpr = looksLikeCrossTypeComparison(left, right) ? `(${left} as any)` : left;
        return `(${leftExpr} <= ${right})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    // Logical operators
    case 'and':
      if (args.length >= 2) {
        return `(${args.map(a => parseExpression(a, variableMap)).join(' && ')})${parsePropertyAccess(remainder, variableMap)}`;
      } else if (args.length === 1) {
        // Single-element and - preserve as ctx.and() for parity
        return `ctx.and(${parseExpression(args[0], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'or':
      if (args.length >= 2) {
        return `(${args.map(a => parseExpression(a, variableMap)).join(' || ')})${parsePropertyAccess(remainder, variableMap)}`;
      } else if (args.length === 1) {
        // Single-element or - preserve as ctx.or() for parity
        return `ctx.or(${parseExpression(args[0], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'not':
      if (args.length === 1) {
        const inner = parseExpression(args[0], variableMap);
        // If inner is already parenthesized (from equals, greater, etc.), don't double-wrap
        const negated = isFullyParenthesized(inner) ? `!${inner}` : `!(${inner})`;
        return `${negated}${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    // Reference functions - keep as ctx methods
    case 'body':
      return formatCtxMethodWithPropertyAccess('body', args, remainder, variableMap);

    case 'outputs':
      return formatCtxMethodWithPropertyAccess('outputs', args, remainder, variableMap);

    case 'actions':
      return formatCtxMethodWithPropertyAccess('actions', args, remainder, variableMap);

    case 'triggerbody':
      return formatCtxMethodWithPropertyAccess('triggerBody', [], remainder, variableMap);

    case 'triggeroutputs':
      return formatCtxMethodWithPropertyAccess('triggerOutputs', [], remainder, variableMap);

    case 'variables':
      // Use sanitized variable name for TypeScript compatibility and diagnostics validation
      // The transformer will convert back to original name using @originalName annotation
      if (args.length > 0) {
        const varNameArg = args[0].trim();
        // If it's a string literal, preserve the source name in the DSL.
        // We pass the source name (which can be any case or contain spaces) directly
        // to ctx.variables(...) — the transformer's fallback path returns the literal
        // unchanged when it isn't in the sanitized→original map, so source case round-trips.
        if ((varNameArg.startsWith("'") && varNameArg.endsWith("'")) ||
            (varNameArg.startsWith('"') && varNameArg.endsWith('"'))) {
          const originalName = varNameArg.slice(1, -1);
          return `ctx.variables('${originalName}')${parsePropertyAccess(remainder, variableMap)}`;
        }
      }
      return formatCtxMethodWithPropertyAccess('variables', args, remainder, variableMap);

    case 'item':
      if (_currentLoopVar) {
        return _currentLoopVar + parsePropertyAccess(remainder, variableMap);
      }
      return formatCtxMethodWithPropertyAccess('item', [], remainder, variableMap);

    case 'items':
      if (_loopMap && args.length > 0) {
        const loopNameArg = args[0].trim();
        let loopName: string | undefined;
        if ((loopNameArg.startsWith("'") && loopNameArg.endsWith("'")) ||
            (loopNameArg.startsWith('"') && loopNameArg.endsWith('"'))) {
          loopName = loopNameArg.slice(1, -1);
        }
        if (loopName && _loopMap.has(loopName)) {
          return _loopMap.get(loopName)! + parsePropertyAccess(remainder, variableMap);
        }
      }
      return formatCtxMethodWithPropertyAccess('items', args, remainder, variableMap);

    case 'parameters':
      return formatCtxMethodWithPropertyAccess('parameters', args, remainder, variableMap);

    case 'trigger':
      return formatCtxMethodWithPropertyAccess('trigger', [], remainder, variableMap);

    case 'workflow':
      return formatCtxMethodWithPropertyAccess('workflow', [], remainder, variableMap);

    // String functions
    case 'concat':
      // Preserve concat() as ctx.concat() for accurate roundtrip
      // This avoids issues with isLikelyStringExpression not recognizing complex expressions
      return formatCtxMethodWithPropertyAccess('concat', args, remainder, variableMap);

    case 'substring':
      // Use ctx.substring() to preserve Power Automate semantics (start, length)
      // rather than JavaScript's substring(start, end) to ensure correct roundtrip
      return formatCtxMethodWithPropertyAccess('substring', args, remainder, variableMap);

    case 'replace':
      // Source must use canonical 'replace' casing; the round-trip emits canonical and loses original case.
      if (funcName !== 'replace') {
        return `ctx.eval(\`${escapeBackticks(expr)}\`)`;
      }
      if (args.length === 3) {
        return `${parseExpression(args[0], variableMap)}.replace(${parseExpression(args[1], variableMap)}, ${parseExpression(args[2], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'tolower':
      // Source must use canonical 'toLower' casing; the round-trip emits canonical and loses original case.
      if (funcName !== 'toLower') {
        return `ctx.eval(\`${escapeBackticks(expr)}\`)`;
      }
      if (args.length === 1) {
        return `${parseExpression(args[0], variableMap)}.toLowerCase()${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'toupper':
      if (funcName !== 'toUpper') {
        return `ctx.eval(\`${escapeBackticks(expr)}\`)`;
      }
      if (args.length === 1) {
        return `${parseExpression(args[0], variableMap)}.toUpperCase()${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'trim':
      if (funcName !== 'trim') {
        return `ctx.eval(\`${escapeBackticks(expr)}\`)`;
      }
      if (args.length === 1) {
        return `${parseExpression(args[0], variableMap)}.trim()${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'split':
      if (funcName !== 'split') {
        return `ctx.eval(\`${escapeBackticks(expr)}\`)`;
      }
      if (args.length === 2) {
        return `${parseExpression(args[0], variableMap)}.split(${parseExpression(args[1], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'join':
      if (args.length === 2) {
        return `${parseExpression(args[0], variableMap)}.join(${parseExpression(args[1], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'indexof':
      if (args.length === 2) {
        return `${parseExpression(args[0], variableMap)}.indexOf(${parseExpression(args[1], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'lastindexof':
      if (args.length === 2) {
        return `${parseExpression(args[0], variableMap)}.lastIndexOf(${parseExpression(args[1], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'startswith':
      if (args.length === 2) {
        return `${parseExpression(args[0], variableMap)}.startsWith(${parseExpression(args[1], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'endswith':
      if (args.length === 2) {
        return `${parseExpression(args[0], variableMap)}.endsWith(${parseExpression(args[1], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'contains':
      // Use ctx.contains() for parity - handles any number of args
      return formatCtxMethodWithPropertyAccess('contains', args, remainder, variableMap);

    // Collection functions
    case 'length':
      if (args.length === 1) {
        const val = parseExpression(args[0], variableMap);
        return `${val}.length${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'empty':
      if (args.length === 1) {
        // Use ctx.empty() for roundtrip fidelity, with property access support
        return formatCtxMethodWithPropertyAccess('empty', args, remainder, variableMap);
      }
      break;

    case 'first':
      // Preserve first() for parity - use ctx.first() pattern
      return formatCtxMethodWithPropertyAccess('first', args, remainder, variableMap);

    case 'last':
      // Preserve last() for parity - use ctx.last() pattern
      return formatCtxMethodWithPropertyAccess('last', args, remainder, variableMap);

    case 'skip':
      // Preserve skip() for parity - use ctx.skip() pattern
      return formatCtxMethodWithPropertyAccess('skip', args, remainder, variableMap);

    case 'take':
      // Preserve take() for parity - use ctx.take() pattern
      return formatCtxMethodWithPropertyAccess('take', args, remainder, variableMap);

    case 'createarray':
      return `[${args.map(a => parseExpression(a, variableMap)).join(', ')}]${parsePropertyAccess(remainder, variableMap)}`;

    case 'range':
      if (funcName !== 'range') {
        return `ctx.eval(\`${escapeBackticks(expr)}\`)`;
      }
      if (args.length === 2) {
        // Use ctx.range() to preserve PA semantics on round-trip.
        // Array.from(...) would be more JS-idiomatic but doesn't reverse-map.
        return formatCtxMethodWithPropertyAccess('range', args, remainder, variableMap);
      }
      break;

    // Math functions
    case 'add':
      if (args.length === 2) {
        return `(${parseExpression(args[0], variableMap)} + ${parseExpression(args[1], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'sub':
      if (args.length === 2) {
        return `(${parseExpression(args[0], variableMap)} - ${parseExpression(args[1], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'mul':
      if (args.length === 2) {
        return `(${parseExpression(args[0], variableMap)} * ${parseExpression(args[1], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'div':
      if (args.length === 2) {
        return `(${parseExpression(args[0], variableMap)} / ${parseExpression(args[1], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'mod':
      if (args.length === 2) {
        return `(${parseExpression(args[0], variableMap)} % ${parseExpression(args[1], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'int':
      if (args.length === 1) {
        // Use ctx.int() for roundtrip fidelity with Power Automate's int() function
        return formatCtxMethodWithPropertyAccess('int', args, remainder, variableMap);
      }
      break;

    case 'float':
      if (args.length === 1) {
        // Use ctx.float() for roundtrip fidelity with Power Automate's float() function
        return formatCtxMethodWithPropertyAccess('float', args, remainder, variableMap);
      }
      break;

    case 'abs':
      if (args.length === 1) {
        return `Math.abs(${parseExpression(args[0], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'min':
      return `Math.min(${args.map(a => parseExpression(a, variableMap)).join(', ')})${parsePropertyAccess(remainder, variableMap)}`;

    case 'max':
      return `Math.max(${args.map(a => parseExpression(a, variableMap)).join(', ')})${parsePropertyAccess(remainder, variableMap)}`;

    case 'rand':
      // Use ctx.rand() for round-trip fidelity
      if (args.length === 2) {
        return formatCtxMethodWithPropertyAccess('rand', args, remainder, variableMap);
      }
      break;

    // Conditional
    case 'if':
      // Source must use canonical lowercase 'if' casing; the round-trip emits canonical and loses original case.
      if (funcName !== 'if') {
        return `ctx.eval(\`${escapeBackticks(expr)}\`)`;
      }
      if (args.length === 3) {
        return `(${parseExpression(args[0], variableMap)} ? ${parseExpression(args[1], variableMap)} : ${parseExpression(args[2], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'coalesce':
      // Source must use canonical 'coalesce' casing; otherwise the round-trip
      // (typed/operator -> IR) re-emits the canonical form and loses the original case.
      if (funcName !== 'coalesce') {
        return `ctx.eval(\`${escapeBackticks(expr)}\`)`;
      }
      // Single-arg coalesce needs ctx.coalesce() for round-trip fidelity
      if (args.length === 1) {
        return formatCtxMethodWithPropertyAccess('coalesce', args, remainder, variableMap);
      }
      return `(${args.map(a => parseExpression(a, variableMap)).join(' ?? ')})${parsePropertyAccess(remainder, variableMap)}`;

    // Type conversion - use ctx methods for roundtrip fidelity, with property access support
    case 'string':
      if (args.length === 1) {
        return formatCtxMethodWithPropertyAccess('string', args, remainder, variableMap);
      }
      break;

    case 'json':
      if (args.length === 1) {
        return formatCtxMethodWithPropertyAccess('json', args, remainder, variableMap);
      }
      break;

    case 'bool':
      if (args.length === 1) {
        return formatCtxMethodWithPropertyAccess('bool', args, remainder, variableMap);
      }
      break;

    // Date/time functions - use ctx.eval for these
    case 'utcnow':
    case 'adddays':
    case 'addhours':
    case 'addminutes':
    case 'addseconds':
    case 'addtottime':
    case 'convertfromutc':
    case 'converttimezone':
    case 'converttoutc':
    case 'dayofmonth':
    case 'dayofweek':
    case 'dayofyear':
    case 'formatdatetime':
    case 'getfuturetime':
    case 'getpasttime':
    case 'startofday':
    case 'startofhour':
    case 'startofmonth':
    case 'ticks':
      // Date/time functions need runtime evaluation - use comma-space for consistency
      return `ctx.${funcName}(${args.map(a => parseExpression(a, variableMap)).join(', ')})${parsePropertyAccess(remainder)}`;

    // GUID
    case 'guid':
      return `ctx.guid()${parsePropertyAccess(remainder)}`;

    // Base64 - use ctx methods for parity
    case 'base64':
      if (args.length === 1) {
        return `ctx.base64(${parseExpression(args[0], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'base64tostring':
      if (args.length === 1) {
        return `ctx.base64ToString(${parseExpression(args[0], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    // URI encoding - use ctx methods for parity
    case 'uricomponent':
      if (args.length === 1) {
        return `ctx.uriComponent(${parseExpression(args[0], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'uricomponenttostring':
      if (args.length === 1) {
        return `ctx.uriComponentToString(${parseExpression(args[0], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    case 'decodeuricomponent':
      // Source must use canonical 'decodeUriComponent' casing for round-trip fidelity.
      if (funcName !== 'decodeUriComponent') {
        return `ctx.eval(\`${escapeBackticks(expr)}\`)`;
      }
      if (args.length === 1) {
        return `ctx.decodeUriComponent(${parseExpression(args[0], variableMap)})${parsePropertyAccess(remainder, variableMap)}`;
      }
      break;

    // XML/XPath - use typed ctx method so the transformer's default handler
    // recursively transforms args and applies @ prefix only at root via maybePrefix.
    // (Earlier `ctx.eval(\`xpath(...)\`)` form lost the @ prefix at root, and
    // `ctx.eval(\`@xpath(...)\`)` leaked a stray @ when xpath was nested.)
    case 'xml':
    case 'xpath':
      return formatCtxMethodWithPropertyAccess(funcName, args, remainder, variableMap);
  }

  // Default: keep as ctx method call - use comma-space for consistency
  const argStrs = args.map(a => parseExpression(a, variableMap));
  return `ctx.${funcName}(${argStrs.join(', ')})${parsePropertyAccess(remainder)}`;
}

/**
 * Parse a function call and extract its parts.
 */
function parseFunctionParts(expr: string): { funcName: string; args: string[]; remainder: string } {
  const funcMatch = expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
  if (!funcMatch) {
    throw new Error(`Not a function call: ${expr}`);
  }

  const funcName = funcMatch[1];
  let pos = funcMatch[0].length;

  // Find matching closing parenthesis
  const args: string[] = [];
  let depth = 1;
  let argStart = pos;
  let inString = false;
  let stringChar = '';

  while (pos < expr.length && depth > 0) {
    const char = expr[pos];

    if (inString) {
      if (char === stringChar && !isQuoteEscaped(expr, pos)) {
        inString = false;
      }
    } else {
      if (char === "'" || char === '"') {
        inString = true;
        stringChar = char;
      } else if (char === '(') {
        depth++;
      } else if (char === ')') {
        depth--;
        if (depth === 0) {
          const arg = expr.slice(argStart, pos).trim();
          if (arg) {
            args.push(arg);
          }
        }
      } else if (char === ',' && depth === 1) {
        const arg = expr.slice(argStart, pos).trim();
        if (arg) {
          args.push(arg);
        }
        argStart = pos + 1;
      }
    }

    pos++;
  }

  // Get the remainder after the function call (property access, etc.)
  const remainder = expr.slice(pos).trim();

  return { funcName, args, remainder };
}

/**
 * Parse function call with potential property access chain.
 */
function parseFunctionCallWithPropertyAccess(expr: string, variableMap?: VariableNameMap): string {
  // Try to parse as a function call first
  try {
    return parseFunctionCall(expr, variableMap);
  } catch {
    // Not a simple function call, might have complex structure
    return `ctx.eval(\`${escapeBackticks(expr)}\`)`;
  }
}

/**
 * Format a ctx method call with optional property access.
 */
function formatCtxMethodWithPropertyAccess(methodName: string, args: string[], remainder: string, variableMap?: VariableNameMap): string {
  const argStrs = args.map(a => {
    // If arg is already a string literal, escape for TypeScript
    if ((a.startsWith("'") && a.endsWith("'")) || (a.startsWith('"') && a.endsWith('"'))) {
      const quote = a[0];
      let content = a.slice(1, -1);

      // In Power Automate, '' represents a single quote inside a single-quoted string
      // Replace '' with ' to get the actual content
      if (quote === "'") {
        content = content.replace(/''/g, "'");
      }

      // Escape backslashes for TypeScript: \ -> \\
      content = content.replace(/\\/g, '\\\\');

      // For single-quoted strings, escape single quotes: ' -> \'
      if (quote === "'") {
        content = content.replace(/'/g, "\\'");
      }
      // For double-quoted strings, escape double quotes: " -> \"
      if (quote === '"') {
        content = content.replace(/"/g, '\\"');
      }

      return `${quote}${content}${quote}`;
    }
    // Otherwise try to parse it
    return parseExpression(a, variableMap);
  });

  // Use comma-space for arguments to match Power Automate's typical format
  const call = argStrs.length > 0 ? `ctx.${methodName}(${argStrs.join(', ')})` : `ctx.${methodName}()`;

  return call + parsePropertyAccess(remainder, variableMap);
}

/**
 * Parse property access chain (e.g., ?['field'], .field, ['field']).
 */
function parsePropertyAccess(remainder: string, variableMap?: VariableNameMap): string {
  if (!remainder) return '';

  let result = '';
  let pos = 0;

  while (pos < remainder.length) {
    // Skip whitespace
    while (pos < remainder.length && /\s/.test(remainder[pos])) {
      pos++;
    }

    if (pos >= remainder.length) break;

    // Optional chaining with bracket notation: ?['field'] or ?[item()]
    if (remainder.slice(pos, pos + 2) === '?[') {
      pos += 2;
      const endBracket = findMatchingBracket(remainder, pos - 1);
      const key = remainder.slice(pos, endBracket);
      // Check if the key is a function call that needs parsing (e.g., item())
      if (key.match(/^[a-zA-Z_][a-zA-Z0-9_]*\s*\(/)) {
        // Parse the function call to convert to ctx method with variable name mapping
        const parsedKey = parseExpression(key, variableMap);
        result += `?.[${parsedKey}]`;
      } else {
        result += `?.[${key}]`;
      }
      pos = endBracket + 1;
    }
    // Optional chaining with dot notation: ?.field
    else if (remainder.slice(pos, pos + 2) === '?.') {
      pos += 2;
      const match = remainder.slice(pos).match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
      if (match) {
        result += `?.${match[1]}`;
        pos += match[1].length;
      }
    }
    // Bracket notation: ['field'] or [0] or [variables('x')]
    else if (remainder[pos] === '[') {
      const endBracket = findMatchingBracket(remainder, pos);
      const key = remainder.slice(pos + 1, endBracket);
      // Check if the key is a function call that needs parsing (e.g., variables('x'))
      if (key.match(/^[a-zA-Z_][a-zA-Z0-9_]*\s*\(/)) {
        // Parse the function call to convert to ctx method with variable name mapping
        const parsedKey = parseExpression(key, variableMap);
        result += `[${parsedKey}]`;
      } else {
        result += `[${key}]`;
      }
      pos = endBracket + 1;
    }
    // Dot notation: .field
    else if (remainder[pos] === '.') {
      pos++;
      const match = remainder.slice(pos).match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
      if (match) {
        result += `.${match[1]}`;
        pos += match[1].length;
      }
    }
    // Function call on result: .method()
    else if (remainder[pos] === '(') {
      const endParen = findMatchingParen(remainder, pos);
      const args = remainder.slice(pos + 1, endParen);
      result += `(${args})`;
      pos = endParen + 1;
    } else {
      break;
    }
  }

  return result;
}

/**
 * Check if a quote character at position `pos` is escaped.
 *
 * IMPORTANT: Power Automate does NOT use backslash escaping for quotes.
 * Instead, it uses doubled quotes: '' for a literal ' inside a single-quoted string.
 * A backslash in Power Automate is just a literal backslash, e.g., '\' means backslash.
 *
 * So we should NOT treat \' as an escaped quote. This function always returns false
 * because Power Automate strings don't use backslash escaping.
 */
function isQuoteEscaped(_str: string, _pos: number): boolean {
  // Power Automate doesn't use backslash escaping, so quotes are never escaped this way
  return false;
}

/**
 * Find matching closing bracket.
 */
function findMatchingBracket(str: string, startPos: number): number {
  let depth = 1;
  let pos = startPos + 1;
  let inString = false;
  let stringChar = '';

  while (pos < str.length && depth > 0) {
    const char = str[pos];

    if (inString) {
      if (char === stringChar && !isQuoteEscaped(str, pos)) {
        inString = false;
      }
    } else {
      if (char === "'" || char === '"') {
        inString = true;
        stringChar = char;
      } else if (char === '[') {
        depth++;
      } else if (char === ']') {
        depth--;
      }
    }

    pos++;
  }

  return pos - 1;
}

/**
 * Find matching closing parenthesis.
 */
function findMatchingParen(str: string, startPos: number): number {
  let depth = 1;
  let pos = startPos + 1;
  let inString = false;
  let stringChar = '';

  while (pos < str.length && depth > 0) {
    const char = str[pos];

    if (inString) {
      if (char === stringChar && !isQuoteEscaped(str, pos)) {
        inString = false;
      }
    } else {
      if (char === "'" || char === '"') {
        inString = true;
        stringChar = char;
      } else if (char === '(') {
        depth++;
      } else if (char === ')') {
        depth--;
      }
    }

    pos++;
  }

  return pos - 1;
}

/**
 * Escape backticks for template literals.
 */
function escapeBackticks(str: string): string {
  return str.replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

/**
 * Parse an items expression for foreach loops.
 * Returns code that yields an iterable array.
 */
export function parseItemsExpressionToTypeScript(
  expression: string,
  optionsOrVariableMap?: ParseExpressionOptions | VariableNameMap
): ParseResult {
  if (!expression) {
    return { code: '[]', success: true };
  }

  // Check if expression is a JSON array string (literal array from Logic Apps)
  const trimmed = expression.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      // Validate it's valid JSON
      JSON.parse(trimmed);
      // Return as-is - it's already a valid TypeScript array literal
      return { code: trimmed, success: true };
    } catch {
      // Not valid JSON, fall through to expression parsing
    }
  }

  const result = parseExpressionToTypeScript(expression, optionsOrVariableMap);

  // Ensure the result is treated as an array
  if (result.success && !result.code.includes('ctx.eval')) {
    return result;
  }

  return result;
}

/**
 * Parse a switch expression for switch statements.
 *
 * Switch expressions can be multi-segment templates like `@{a}_@{b}` where the
 * value is the concatenation of multiple PA expressions. parseStringValue
 * routes those through `parseStringToTemplateLiteral` so the segments survive
 * the round-trip; calling parseExpressionToTypeScript directly would mangle
 * everything past the first `@{...}` block.
 */
export function parseSwitchExpressionToTypeScript(
  expression: string,
  optionsOrVariableMap?: ParseExpressionOptions | VariableNameMap
): ParseResult {
  if (typeof expression === 'string' && isMixedExpressionString(expression)) {
    try {
      return parseStringToTemplateLiteral(expression, optionsOrVariableMap);
    } catch {
      return {
        code: `ctx.eval(\`${escapeBackticks(expression)}\`)`,
        success: false,
        original: expression,
      };
    }
  }
  return parseExpressionToTypeScript(expression, optionsOrVariableMap);
}

/**
 * Check if a string is a "mixed" string with text and embedded expressions.
 * Returns true for strings like "Hello @{parameters('Name')}, welcome!"
 * Returns true for strings with leading/trailing whitespace like "@{...} " or " @{...}"
 * Returns false for pure expressions like "@{body('action')}" with no surrounding text.
 */
export function isMixedExpressionString(value: string): boolean {
  if (typeof value !== 'string') return false;

  // Must contain @{ to have embedded expressions
  if (!value.includes('@{')) return false;

  // Check if there's leading or trailing whitespace (that should be preserved)
  const trimmed = value.trim();
  if (value !== trimmed) {
    // There's whitespace outside the expression - treat as mixed
    return true;
  }

  // If it starts with @{ and ends with } with no other text, it's a pure expression
  if (trimmed.startsWith('@{') && trimmed.endsWith('}')) {
    // Check if there's text outside the expression
    // Need to properly track depth, skipping braces inside string literals
    let depth = 0;
    let firstExprEnd = -1;
    let inSingleQuote = false;
    let inDoubleQuote = false;

    for (let i = 2; i < trimmed.length; i++) {
      const char = trimmed[i];
      const prev = i > 0 ? trimmed[i - 1] : '';

      // Track string literal state (skip escaped quotes)
      if (char === "'" && !inDoubleQuote && prev !== '\\') {
        inSingleQuote = !inSingleQuote;
        continue;
      }
      if (char === '"' && !inSingleQuote && prev !== '\\') {
        inDoubleQuote = !inDoubleQuote;
        continue;
      }

      // Skip braces inside string literals
      if (inSingleQuote || inDoubleQuote) continue;

      if (char === '{') depth++;
      else if (char === '}') {
        if (depth === 0) {
          firstExprEnd = i;
          break;
        }
        depth--;
      }
    }
    // If first expression ends at the end of string, it's a pure expression
    if (firstExprEnd === trimmed.length - 1) {
      return false;
    }
  }

  return true;
}

/**
 * Parse a string with embedded @{...} expressions and convert to TypeScript template literal.
 *
 * Example:
 * Input:  "Hello @{parameters('Name')}, your order @{body('GetOrder').id} is ready."
 * Output: `Hello ${ctx.parameters("Name")}, your order ${ctx.body("GetOrder").id} is ready.`
 */
export function parseStringToTemplateLiteral(
  value: string,
  optionsOrVariableMap?: ParseExpressionOptions | VariableNameMap
): ParseResult {
  if (typeof value !== 'string') {
    return { code: String(value), success: false, original: String(value) };
  }

  // Refresh the module-level loop context for nested parseExpression() calls.
  // Without this, mixed strings like "\@{item()?...}" use a stale _currentLoopVar
  // left over from the previous parseExpressionToTypeScript call.
  let variableMap: VariableNameMap | undefined;
  if (isParseExpressionOptions(optionsOrVariableMap)) {
    variableMap = optionsOrVariableMap?.variableMap;
    _loopMap = optionsOrVariableMap?.loopMap;
    _currentLoopVar = optionsOrVariableMap?.currentLoopVar;
  } else {
    variableMap = optionsOrVariableMap;
  }

  // If no embedded expressions, return as regular string
  if (!value.includes('@{')) {
    // Escape order matters: backslash first to avoid double-escaping the new backslashes
    // introduced by ` and $ escapes.
    const escaped = value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    return { code: `\`${escaped}\``, success: true };
  }

  const parts: string[] = [];
  let currentText = '';
  let i = 0;

  while (i < value.length) {
    // Check for embedded expression @{...}
    if (value[i] === '@' && value[i + 1] === '{') {
      // Save any accumulated text
      if (currentText) {
        parts.push({ type: 'text', value: currentText } as any);
        currentText = '';
      }

      // Find the matching closing brace
      let depth = 1;
      let j = i + 2;
      while (j < value.length && depth > 0) {
        if (value[j] === '{') depth++;
        else if (value[j] === '}') depth--;
        j++;
      }

      // Extract the expression (without @{ and })
      const exprContent = value.slice(i + 2, j - 1);

      // Parse the expression to TypeScript
      const parsed = parseExpression(exprContent, variableMap);
      parts.push({ type: 'expr', value: parsed } as any);

      i = j;
    } else {
      currentText += value[i];
      i++;
    }
  }

  // Add any remaining text
  if (currentText) {
    parts.push({ type: 'text', value: currentText } as any);
  }

  // Build the template literal
  let templateContent = '';
  for (const part of parts) {
    if ((part as any).type === 'text') {
      // Escape backslash first, then backtick and $ — order matters so newly-introduced
      // backslashes from the second pair don't get double-escaped.
      templateContent += (part as any).value
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$/g, '\\$');
    } else {
      // Add expression as ${...}
      templateContent += '${' + (part as any).value + '}';
    }
  }

  return { code: '`' + templateContent + '`', success: true };
}

/**
 * Smart string parser that chooses the best representation:
 * - Pure expression (@body('x')) -> ctx.body('x')
 * - Mixed string with expressions -> template literal
 * - Plain string -> quoted string
 */
export function parseStringValue(
  value: string,
  optionsOrVariableMap?: ParseExpressionOptions | VariableNameMap
): ParseResult {
  if (typeof value !== 'string') {
    return { code: JSON.stringify(value), success: true };
  }

  // Pure expression starting with @
  if (value.startsWith('@') && !value.startsWith('@{')) {
    return parseExpressionToTypeScript(value, optionsOrVariableMap);
  }

  // Pure expression @{...} with no surrounding text
  // Wrap in ctx.braced() to preserve the @{...} format during roundtrip
  if (value.startsWith('@{') && !isMixedExpressionString(value)) {
    const result = parseExpressionToTypeScript(value, optionsOrVariableMap);
    if (result.success) {
      // Wrap in ctx.braced() to indicate this should be output as @{...}
      return { ...result, code: `ctx.braced(${result.code})` };
    }
    return result;
  }

  // Mixed string with embedded expressions -> template literal
  if (isMixedExpressionString(value)) {
    try {
      // Pass full options through so nested parseExpression() calls see the current
      // loop context (currentLoopVar, loopMap), not stale module-level state.
      return parseStringToTemplateLiteral(value, optionsOrVariableMap);
    } catch {
      // Fallback to eval
      return {
        code: `ctx.eval(\`${escapeBackticks(value)}\`)`,
        success: false,
        original: value,
      };
    }
  }

  // Plain string with no expressions
  return { code: `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`, success: true };
}
