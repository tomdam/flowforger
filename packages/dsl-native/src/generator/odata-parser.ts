/**
 * OData Filter Parser
 * Parses OData filter strings and generates ctx.odata.* builder code.
 */

import { parseStringValue } from './expression-parser.js';

interface ParsedExpression {
  type: 'comparison' | 'logical' | 'function' | 'raw';
  operator?: string;
  field?: string;
  value?: any;
  expressions?: ParsedExpression[];
  funcName?: string;
  args?: any[];
}

/**
 * Check if a value contains a Power Automate expression.
 */
function containsExpression(value: string): boolean {
  return value.includes("@{") || value.startsWith("@");
}

/**
 * Convert a value to TypeScript code.
 * Handles PA expressions like @{parameters('name')} -> ctx.parameters("name")
 * Uses the expression parser for complex expressions.
 */
function valueToCode(value: any): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);

  if (typeof value === 'string') {
    // Check if this contains an expression
    if (containsExpression(value)) {
      // Use the full expression parser for complex expressions
      const parsed = parseStringValue(value);
      return parsed.code;
    }

    // Plain string value
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  return String(value);
}

/**
 * Tokenize an OData filter string.
 * Handles embedded expressions like '@{parameters('name')}' within strings.
 */
function tokenize(filter: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inString = false;
  let stringChar = '';
  let inExpression = false;
  let braceDepth = 0;

  for (let i = 0; i < filter.length; i++) {
    const char = filter[i];

    // Handle expressions within strings or standalone
    if (inExpression) {
      current += char;
      if (char === '{') braceDepth++;
      else if (char === '}') {
        braceDepth--;
        if (braceDepth === 0) {
          inExpression = false;
          // If we were in a string, continue the string
          // Otherwise, push the expression as a token
          if (!inString) {
            tokens.push(current);
            current = '';
          }
        }
      }
      continue;
    }

    if (inString) {
      // Check for embedded expression within string
      if (char === '@' && filter[i + 1] === '{') {
        current += '@{';
        inExpression = true;
        braceDepth = 1;
        i++; // Skip the '{'
        continue;
      }

      current += char;
      // Only end string if the quote is not inside an expression
      if (char === stringChar && !inExpression) {
        inString = false;
        tokens.push(current);
        current = '';
      }
      continue;
    }

    if (char === "'" || char === '"') {
      if (current.trim()) tokens.push(current.trim());
      current = char;
      inString = true;
      stringChar = char;
      continue;
    }

    if (char === '@' && filter[i + 1] === '{') {
      if (current.trim()) tokens.push(current.trim());
      current = '@{';
      inExpression = true;
      braceDepth = 1;
      i++; // Skip the '{'
      continue;
    }

    if (char === ' ' || char === '\t') {
      if (current.trim()) {
        tokens.push(current.trim());
        current = '';
      }
      continue;
    }

    if (char === '(' || char === ')' || char === ',') {
      if (current.trim()) tokens.push(current.trim());
      tokens.push(char);
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

/**
 * Parse a simple comparison: field op value
 */
function parseComparison(tokens: string[], startIdx: number): { expr: ParsedExpression; endIdx: number } | null {
  if (startIdx + 2 >= tokens.length) return null;

  const field = tokens[startIdx];
  const op = tokens[startIdx + 1]?.toLowerCase();
  const value = tokens[startIdx + 2];

  const comparisonOps = ['eq', 'ne', 'gt', 'ge', 'lt', 'le'];
  if (!comparisonOps.includes(op)) return null;

  // Parse value
  let parsedValue: any = value;
  if (value === 'true') parsedValue = true;
  else if (value === 'false') parsedValue = false;
  else if (value === 'null') parsedValue = null;
  else if (value.match(/^-?\d+$/)) parsedValue = parseInt(value, 10);
  else if (value.match(/^-?\d+\.\d+$/)) parsedValue = parseFloat(value);
  else if (value.startsWith("'") && value.endsWith("'")) {
    parsedValue = value.slice(1, -1);
  } else if (value.startsWith('@')) {
    parsedValue = value; // Keep as expression
  }

  return {
    expr: { type: 'comparison', operator: op, field, value: parsedValue },
    endIdx: startIdx + 2
  };
}

/**
 * Parse OData filter tokens into expressions.
 */
function parseTokens(tokens: string[]): ParsedExpression {
  const expressions: ParsedExpression[] = [];
  let logicalOp: string | null = null;
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i].toLowerCase();

    // Handle logical operators
    if (token === 'and' || token === 'or') {
      logicalOp = token;
      i++;
      continue;
    }

    // Handle parentheses (grouping)
    if (tokens[i] === '(') {
      let depth = 1;
      let j = i + 1;
      while (j < tokens.length && depth > 0) {
        if (tokens[j] === '(') depth++;
        if (tokens[j] === ')') depth--;
        j++;
      }
      const subTokens = tokens.slice(i + 1, j - 1);
      if (subTokens.length > 0) {
        expressions.push(parseTokens(subTokens));
      }
      i = j;
      continue;
    }

    // Handle Microsoft.Dynamics.CRM.* functions (like Microsoft.Dynamics.CRM.In)
    // These are Dataverse-specific OData functions that need to be preserved as-is
    if (tokens[i].startsWith('Microsoft.Dynamics.CRM.')) {
      if (tokens[i + 1] === '(') {
        // Capture the entire function call including its arguments
        const funcName = tokens[i];
        let depth = 1;
        let j = i + 2;
        let rawExpr = funcName + '(';

        while (j < tokens.length && depth > 0) {
          if (tokens[j] === '(') depth++;
          else if (tokens[j] === ')') depth--;

          rawExpr += tokens[j];
          j++;
        }

        expressions.push({
          type: 'raw',
          value: rawExpr
        });
        i = j;
        continue;
      }
    }

    // Handle string functions: contains(field, value)
    if (token === 'contains' || token === 'startswith' || token === 'endswith') {
      if (tokens[i + 1] === '(') {
        const funcName = token;
        let depth = 1;
        let j = i + 2;
        const args: string[] = [];
        let currentArg = '';

        while (j < tokens.length && depth > 0) {
          if (tokens[j] === '(') depth++;
          else if (tokens[j] === ')') {
            depth--;
            if (depth === 0) {
              if (currentArg.trim()) args.push(currentArg.trim());
            } else {
              currentArg += tokens[j];
            }
          } else if (tokens[j] === ',' && depth === 1) {
            args.push(currentArg.trim());
            currentArg = '';
          } else {
            currentArg += (currentArg ? ' ' : '') + tokens[j];
          }
          j++;
        }

        expressions.push({
          type: 'function',
          funcName,
          field: args[0],
          value: args[1]?.startsWith("'") ? args[1].slice(1, -1) : args[1]
        });
        i = j;
        continue;
      }
    }

    // Try to parse comparison
    const comparison = parseComparison(tokens, i);
    if (comparison) {
      expressions.push(comparison.expr);
      i = comparison.endIdx + 1;
      continue;
    }

    // Unknown token, skip
    i++;
  }

  // Combine with logical operator
  if (expressions.length === 0) {
    return { type: 'raw', value: tokens.join(' ') };
  }
  if (expressions.length === 1) {
    return expressions[0];
  }

  return {
    type: 'logical',
    operator: logicalOp || 'and',
    expressions
  };
}

/**
 * Generate TypeScript code from parsed expression.
 */
function generateCode(expr: ParsedExpression, indent: string = ''): string {
  switch (expr.type) {
    case 'comparison': {
      const opMap: Record<string, string> = {
        eq: 'eq', ne: 'ne', gt: 'gt', ge: 'ge', lt: 'lt', le: 'le'
      };
      const method = opMap[expr.operator!] || 'eq';
      return `ctx.odata.${method}("${expr.field}", ${valueToCode(expr.value)})`;
    }

    case 'function': {
      const funcMap: Record<string, string> = {
        contains: 'contains',
        startswith: 'startsWith',
        endswith: 'endsWith'
      };
      const method = funcMap[expr.funcName!] || expr.funcName!;
      return `ctx.odata.${method}("${expr.field}", ${valueToCode(expr.value)})`;
    }

    case 'logical': {
      const method = expr.operator === 'or' ? 'or' : 'and';
      const args = expr.expressions!.map(e => generateCode(e, indent + '  '));
      if (args.length === 1) return args[0];
      return `ctx.odata.${method}(\n${indent}  ${args.join(`,\n${indent}  `)}\n${indent})`;
    }

    case 'raw':
    default:
      return `ctx.odata.raw("${escapeForStringLiteral(String(expr.value))}")`;
  }
}

/**
 * Escape a string for use in a JavaScript double-quoted string literal.
 * Handles quotes, backslashes, and newlines/control characters.
 */
function escapeForStringLiteral(str: string): string {
  return str
    .replace(/\\/g, '\\\\')  // Escape backslashes first
    .replace(/"/g, '\\"')    // Escape double quotes
    .replace(/\n/g, '\\n')   // Escape newlines
    .replace(/\r/g, '\\r')   // Escape carriage returns
    .replace(/\t/g, '\\t');  // Escape tabs
}

/**
 * Check if a filter contains parenthesized expressions that need to be preserved.
 * This catches cases like "(a eq b) and (c eq d)" where each condition is wrapped.
 */
function hasParenthesizedConditions(filter: string): boolean {
  const trimmed = filter.trim();
  // Check if filter starts with ( followed by a word (field name)
  // This indicates a parenthesized condition, not a function call like contains(...)
  if (/^\([a-zA-Z_]/.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Check if a filter contains expressions inside quoted strings.
 * These need to be preserved as-is to maintain the quotes around expressions.
 * Examples:
 *   - 'field eq '@{outputs('X')}'' - has quoted expression
 *   - 'field eq @{outputs('X')}' - expression not quoted, can be parsed
 */
function hasQuotedExpressions(filter: string): boolean {
  // Match patterns like '@{...}' (expression wrapped in OData single quotes)
  // The pattern: ' followed by @{ then any content then } followed by '
  return /'@\{[^}]*\}'/.test(filter);
}

/**
 * Check if a filter has leading/trailing whitespace that should be preserved.
 */
function hasSignificantWhitespace(filter: string): boolean {
  return filter !== filter.trim();
}

/**
 * Detect OData functions the parser doesn't natively handle. Fall back to raw
 * preservation when the filter starts with one of these.
 */
function hasUnsupportedFunction(filter: string): boolean {
  // Match a function-call start like `funcName(` at the beginning of the filter.
  const m = filter.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
  if (!m) return false;
  const fn = m[1].toLowerCase();
  // These are explicitly handled by parseTokens.
  const supported = new Set(['contains', 'startswith', 'endswith']);
  return !supported.has(fn);
}

/**
 * Detect a `@{...}` PA template appearing as a standalone clause after `and`/`or`
 * (rather than as the value of a `field op value` triple). Our parser silently
 * drops standalone template operands, so fall back to raw when present.
 */
function hasTemplateAfterAndOr(filter: string): boolean {
  return /\b(?:and|or)\s+@\{/i.test(filter);
}

/**
 * Detect a `@{...}` PA template embedded inside a quoted string with non-empty
 * prefix text (e.g. `'/@{...}'` or `'CMDS_..._@{...}'`). Quoted-expression
 * filters with no prefix (`'@{...}'`) are already handled by `hasQuotedExpressions`.
 */
function hasTemplateInsideStringWithPrefix(filter: string): boolean {
  let inString = false;
  let stringStart = -1;
  for (let i = 0; i < filter.length; i++) {
    const ch = filter[i];
    if (ch === "'") {
      if (inString) {
        inString = false;
      } else {
        inString = true;
        stringStart = i;
      }
    } else if (inString && ch === '@' && filter[i + 1] === '{') {
      const prefix = filter.slice(stringStart + 1, i);
      if (prefix.length > 0) return true;
    }
  }
  return false;
}

/**
 * Detect a `@{...}` template directly followed by an alphanumeric character
 * (e.g. `(@{variables('X')}AH_ID eq '1')`). The parser silently drops the
 * template prefix.
 */
function hasTemplateFollowedByLetter(filter: string): boolean {
  return /@\{[^}]*\}[a-zA-Z_]/.test(filter);
}

/**
 * Detect a `@{...}` template whose contents reference functions that get
 * translated to JS operators/methods (`if`, `equals`, `replace`, `concat`,
 * `join`, `split`, `coalesce`). The transformer cannot reliably reverse these
 * back to PA expression form, so fall back to raw.
 */
function hasTranslatableTemplate(filter: string): boolean {
  const TRANSLATABLE = /\b(?:if|equals|replace|concat|join|split|coalesce)\s*\(/;
  let i = 0;
  while (i < filter.length) {
    if (filter[i] === '@' && filter[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      const start = j;
      while (j < filter.length && depth > 0) {
        if (filter[j] === '{') depth++;
        else if (filter[j] === '}') {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      const content = filter.slice(start, j);
      if (TRANSLATABLE.test(content)) return true;
      i = j + 1;
    } else {
      i++;
    }
  }
  return false;
}

/**
 * Detect an unquoted ISO 8601 datetime (e.g. `createdon ge 2023-08-30T00:00:00Z`).
 * Our parser treats the unquoted token as a string and the transformer re-quotes
 * it on emit, breaking parity. Source flows that rely on unquoted dates need raw
 * fallback to preserve the form.
 */
function hasUnquotedDate(filter: string): boolean {
  return /(?<!['])\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?(?!['])/.test(filter);
}

/**
 * Detect a top-level function call (`startswith`/`endswith`/`contains`/`substringof`)
 * with no whitespace after a comma. The transformer always emits ', ' (with space),
 * so source forms with `,'X'` round-trip to `, 'X'` and break parity.
 */
function hasNoSpaceCommaInFunc(filter: string): boolean {
  return /\b(?:startswith|endswith|contains|substringof)\s*\([^,()]*,(?!\s)/i.test(filter);
}

/**
 * Detect non-canonical whitespace inside a parenthesized group (e.g. `( foo`,
 * `foo )`, or a tab inside a string literal). The structured parser normalizes
 * these away, so raw preservation is required for byte-exact parity.
 */
function hasNonCanonicalParenWhitespace(filter: string): boolean {
  return /\s\)/.test(filter) || /\(\s/.test(filter) || /\t/.test(filter);
}

/**
 * Detect an unbalanced (odd) number of single quotes outside of `''` PA escapes.
 * Sources sometimes have stray quotes that the structured parser silently drops;
 * raw preservation keeps the source form byte-exact.
 */
function hasUnbalancedSingleQuotes(filter: string): boolean {
  let count = 0;
  let i = 0;
  while (i < filter.length) {
    if (filter[i] === "'") {
      if (filter[i + 1] === "'") { i += 2; continue; }
      count++;
    }
    i++;
  }
  return count % 2 !== 0;
}

/**
 * Parse an OData filter string and generate ctx.odata.* builder code.
 */
export function parseODataFilter(filter: string): string {
  if (!filter || filter.trim() === '') {
    return '""';
  }

  try {
    // If the filter has parenthesized conditions, preserve using raw for parity
    // This handles cases like "(field eq value) and (field2 eq value2)"
    if (hasParenthesizedConditions(filter)) {
      return `ctx.odata.raw("${escapeForStringLiteral(filter)}")`;
    }

    // If the filter has expressions inside quoted strings, preserve using raw
    // This handles cases like "field eq '@{outputs('X')}'" where quotes matter
    if (hasQuotedExpressions(filter)) {
      return `ctx.odata.raw("${escapeForStringLiteral(filter)}")`;
    }

    // If the filter has leading/trailing whitespace, preserve using raw
    if (hasSignificantWhitespace(filter)) {
      return `ctx.odata.raw("${escapeForStringLiteral(filter)}")`;
    }

    // If the filter starts with an unsupported OData function (e.g. substringof),
    // preserve using raw — the tokenizer/parser only handles contains/startswith/endswith
    // and would silently produce a malformed result for others.
    if (hasUnsupportedFunction(filter)) {
      return `ctx.odata.raw("${escapeForStringLiteral(filter)}")`;
    }

    // Patterns that don't round-trip cleanly through DSL → IR → JSON. Fall back
    // to raw to preserve source verbatim.
    if (
      hasTemplateAfterAndOr(filter) ||
      hasTemplateInsideStringWithPrefix(filter) ||
      hasTemplateFollowedByLetter(filter) ||
      hasTranslatableTemplate(filter) ||
      hasUnquotedDate(filter) ||
      hasNoSpaceCommaInFunc(filter) ||
      hasUnbalancedSingleQuotes(filter) ||
      hasNonCanonicalParenWhitespace(filter)
    ) {
      return `ctx.odata.raw("${escapeForStringLiteral(filter)}")`;
    }

    const tokens = tokenize(filter);
    const parsed = parseTokens(tokens);
    return generateCode(parsed, '      ');
  } catch (e) {
    // Fallback to raw expression
    return `ctx.odata.raw("${escapeForStringLiteral(filter)}")`;
  }
}

/**
 * Check if a parameter name is an OData query parameter that needs parsing.
 * Only $filter needs special parsing - $select, $expand, $top, $skip are plain strings.
 */
export function isODataParameter(paramName: string): boolean {
  const odataParams = ['$filter'];
  return odataParams.includes(paramName.toLowerCase());
}
