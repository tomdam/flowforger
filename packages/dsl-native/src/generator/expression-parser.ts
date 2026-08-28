/**
 * Expression Parser for Native DSL Generator
 * Converts Power Automate expression strings back to TypeScript/ctx method calls.
 *
 * Parsing runs on the shared @flowforger/expressions AST (the same grammar the
 * engine evaluates); emission lives in ./expression-emitter.ts. This module
 * owns the public API, the legacy-compatible option handling, and the
 * round-trip fidelity heuristics that preserve expressions verbatim via
 * ctx.eval(`...`) when regeneration would lose source fidelity.
 *
 * Examples:
 * - @equals(body('X'), 1) → ctx.body('X') === 1
 * - @outputs('GetItems')?['body/value'] → ctx.outputs('GetItems')?.['body/value']
 * - @and(equals(x, y), greater(a, b)) → ... && ...
 */

import { type GeneratorConfig, getGeneratorConfig } from '@flowforger/ir';
import { tryParseExpression, parseTemplateStrict } from '@flowforger/expressions';
import { emitNode, EmitBailout, type EmitContext } from './expression-emitter.js';

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
  const keys = Object.keys(options);
  if (keys.length === 0) return true; // Empty object, treat as ParseExpressionOptions
  if ('config' in options || 'variableMap' in options || 'loopMap' in options || 'currentLoopVar' in options) return true;
  const firstValue = (options as Record<string, unknown>)[keys[0]];
  if (firstValue && typeof firstValue === 'object' && 'sanitized' in firstValue) {
    return false; // It's a VariableNameMap
  }
  return true;
}

function resolveOptions(optionsOrVariableMap?: ParseExpressionOptions | VariableNameMap): {
  ec: EmitContext;
  config: GeneratorConfig;
} {
  if (isParseExpressionOptions(optionsOrVariableMap)) {
    const config = getGeneratorConfig({ generator: optionsOrVariableMap?.config });
    return {
      ec: {
        variableMap: optionsOrVariableMap?.variableMap,
        loopMap: optionsOrVariableMap?.loopMap,
        currentLoopVar: optionsOrVariableMap?.currentLoopVar,
        relaxedFidelity: config.expressionFidelity === 'relaxed',
      },
      config,
    };
  }
  return { ec: { variableMap: optionsOrVariableMap }, config: getGeneratorConfig() };
}

/**
 * Escape backticks for template literals.
 */
function escapeBackticks(str: string): string {
  return str.replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

function ctxEval(expression: string, success: boolean): ParseResult {
  const result: ParseResult = { code: `ctx.eval(\`${escapeBackticks(expression)}\`)`, success };
  if (!success) result.original = expression;
  return result;
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
  const { ec, config } = resolveOptions(optionsOrVariableMap);

  if (!expression) {
    return { code: 'true', success: true };
  }

  // Round-trip fidelity heuristics — preserve the original verbatim whenever
  // regeneration (trim + canonical comma spacing + normalized literals) would
  // lose source fidelity. With expressionFidelity 'relaxed', the cosmetic-only
  // guards are skipped: the regenerated expression may differ textually from
  // the source (spacing, +signs, casing) but is semantically identical.
  const relaxed = config.expressionFidelity === 'relaxed';
  const hasMultilineFormatting = expression.includes('\r\n') || expression.includes('\n');
  if (hasMultilineFormatting && config.multilineExpressions === 'preserve') {
    return ctxEval(expression, true);
  }
  if (!relaxed) {
    if (expression !== expression.trimEnd()) {
      return ctxEval(expression, true);
    }
    if (hasIrregularTopLevelCommaSpacing(expression)) {
      return ctxEval(expression, true);
    }
  }
  // Explicit `+<number>` sign — the expression AST cannot represent it, so
  // preservation is intentional even in relaxed mode (not a parse failure).
  if (/[(,]\s*\+\d/.test(expression)) {
    return ctxEval(expression, true);
  }

  let expr = expression.trim();

  // Handle @@ escape sequence (literal @)
  if (expr.startsWith('@@')) {
    const literal = '@' + expr.slice(2);
    return { code: JSON.stringify(literal), success: true };
  }

  if (expr.startsWith('@{')) {
    // Template expression: @{expression}
    expr = expr.slice(2, -1);
  } else if (expr === '@true') {
    return { code: 'ctx.atTrue()', success: true };
  } else if (expr === '@false') {
    return { code: 'ctx.atFalse()', success: true };
  } else if (expr === '@null') {
    return { code: 'ctx.null()', success: true };
  } else if (/^@-?\d+(\.\d+)?$/.test(expr)) {
    // Preserve @<number> (like @0, @1, @-5, @3.14) for parity
    return { code: `ctx.atNumber(${expr.slice(1)})`, success: true };
  } else if (/^@'[^']*'$/.test(expr)) {
    // Preserve @'<text>' (PA quoted-string-literal expression) for parity
    return { code: `ctx.atString(${JSON.stringify(expr.slice(2, -1))})`, success: true };
  } else if (expr.startsWith('@')) {
    expr = expr.slice(1);
  }

  if (!expr.trim()) {
    return { code: 'true', success: true };
  }

  const node = tryParseExpression(expr);
  if (!node) {
    // Unparseable — preserve verbatim (the original, @ prefix and all).
    return ctxEval(expression, false);
  }
  try {
    return { code: emitNode(node, ec), success: true };
  } catch (err) {
    if (err instanceof EmitBailout) {
      // Canonical-casing guard: regeneration would lose source casing.
      return ctxEval(expression, true);
    }
    return ctxEval(expression, false);
  }
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
      JSON.parse(trimmed);
      // Return as-is - it's already a valid TypeScript array literal
      return { code: trimmed, success: true };
    } catch {
      // Not valid JSON, fall through to expression parsing
    }
  }

  return parseExpressionToTypeScript(expression, optionsOrVariableMap);
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
      return ctxEval(expression, false);
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

      if (char === "'" && !inDoubleQuote && prev !== '\\') {
        inSingleQuote = !inSingleQuote;
        continue;
      }
      if (char === '"' && !inSingleQuote && prev !== '\\') {
        inDoubleQuote = !inDoubleQuote;
        continue;
      }

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

  const { ec } = resolveOptions(optionsOrVariableMap);

  // If no embedded expressions, return as regular string
  if (!value.includes('@{')) {
    // Escape order matters: backslash first to avoid double-escaping the new
    // backslashes introduced by the ` and $ escapes.
    const escaped = value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    return { code: `\`${escaped}\``, success: true };
  }

  const parts = parseTemplateStrict(value);
  if (!parts) {
    // A segment failed to parse — callers catch and fall back to ctx.eval.
    throw new Error('template segment failed to parse');
  }

  let templateContent = '';
  for (const part of parts) {
    if (part.kind === 'text') {
      templateContent += part.text
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$/g, '\\$');
    } else {
      templateContent += '${' + emitNode(part.node, ec) + '}';
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
      return { ...result, code: `ctx.braced(${result.code})` };
    }
    return result;
  }

  // Mixed string with embedded expressions -> template literal
  if (isMixedExpressionString(value)) {
    try {
      return parseStringToTemplateLiteral(value, optionsOrVariableMap);
    } catch {
      return ctxEval(value, false);
    }
  }

  // Plain string with no expressions
  return { code: `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`, success: true };
}
