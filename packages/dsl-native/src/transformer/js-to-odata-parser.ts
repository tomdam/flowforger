/**
 * JavaScript-to-OData Expression Parser
 * Parses JavaScript-like filter syntax and converts to OData filter strings.
 *
 * Supports:
 * - Comparison operators: ==, !=, <, >, <=, >=
 * - Logical operators: &&, ||, !
 * - Parentheses for grouping
 * - Placeholders ${0}, ${1}, etc. for interpolated values
 */

interface Token {
  type: 'identifier' | 'operator' | 'literal' | 'placeholder' | 'lparen' | 'rparen';
  value: string;
  position: number;
}

interface ParsedExpr {
  type: 'comparison' | 'logical' | 'unary' | 'placeholder' | 'identifier' | 'literal';
  operator?: string;
  left?: ParsedExpr;
  right?: ParsedExpr;
  operand?: ParsedExpr;
  value?: any;
  index?: number;
}

/**
 * Tokenize a JavaScript-like expression.
 */
function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    const char = expr[i];

    // Skip whitespace
    if (/\s/.test(char)) {
      i++;
      continue;
    }

    // Parentheses
    if (char === '(') {
      tokens.push({ type: 'lparen', value: '(', position: i });
      i++;
      continue;
    }
    if (char === ')') {
      tokens.push({ type: 'rparen', value: ')', position: i });
      i++;
      continue;
    }

    // Placeholder: ${0}, ${1}, etc.
    if (char === '$' && expr[i + 1] === '{') {
      const start = i;
      i += 2;
      let index = '';
      while (i < expr.length && /\d/.test(expr[i])) {
        index += expr[i];
        i++;
      }
      if (expr[i] === '}') {
        tokens.push({ type: 'placeholder', value: index, position: start });
        i++;
        continue;
      }
      throw new Error(`Invalid placeholder at position ${start}`);
    }

    // Two-character operators: ==, !=, <=, >=, &&, ||
    if (i + 1 < expr.length) {
      const twoChar = expr.substring(i, i + 2);
      if (['==', '!=', '<=', '>=', '&&', '||'].includes(twoChar)) {
        tokens.push({ type: 'operator', value: twoChar, position: i });
        i += 2;
        continue;
      }
    }

    // Single-character operators: <, >, !
    if (['<', '>', '!'].includes(char)) {
      tokens.push({ type: 'operator', value: char, position: i });
      i++;
      continue;
    }

    // String literals (single or double quoted)
    if (char === '"' || char === "'") {
      const quote = char;
      const start = i;
      i++;
      let value = '';
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === '\\' && i + 1 < expr.length) {
          value += expr[i + 1];
          i += 2;
        } else {
          value += expr[i];
          i++;
        }
      }
      if (expr[i] !== quote) {
        throw new Error(`Unterminated string at position ${start}`);
      }
      tokens.push({ type: 'literal', value, position: start });
      i++;
      continue;
    }

    // Numbers
    if (/\d/.test(char) || (char === '-' && i + 1 < expr.length && /\d/.test(expr[i + 1]))) {
      const start = i;
      let num = '';
      if (char === '-') {
        num += char;
        i++;
      }
      while (i < expr.length && /[\d.]/.test(expr[i])) {
        num += expr[i];
        i++;
      }
      tokens.push({ type: 'literal', value: num, position: start });
      continue;
    }

    // Keywords and identifiers
    if (/[a-zA-Z_]/.test(char)) {
      const start = i;
      let identifier = '';
      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) {
        identifier += expr[i];
        i++;
      }

      // Check for boolean and null literals
      if (identifier === 'true' || identifier === 'false' || identifier === 'null') {
        tokens.push({ type: 'literal', value: identifier, position: start });
      } else {
        tokens.push({ type: 'identifier', value: identifier, position: start });
      }
      continue;
    }

    throw new Error(`Unexpected character '${char}' at position ${i}`);
  }

  return tokens;
}

/**
 * Parse tokens into an expression tree.
 */
function parseExpression(tokens: Token[], startIdx: number = 0): { expr: ParsedExpr; endIdx: number } {
  return parseLogicalOr(tokens, startIdx);
}

/**
 * Parse logical OR (||) - lowest precedence
 */
function parseLogicalOr(tokens: Token[], startIdx: number): { expr: ParsedExpr; endIdx: number } {
  let { expr: left, endIdx } = parseLogicalAnd(tokens, startIdx);

  while (endIdx < tokens.length && tokens[endIdx].type === 'operator' && tokens[endIdx].value === '||') {
    endIdx++; // Skip ||
    const { expr: right, endIdx: newEndIdx } = parseLogicalAnd(tokens, endIdx);
    left = { type: 'logical', operator: 'or', left, right };
    endIdx = newEndIdx;
  }

  return { expr: left, endIdx };
}

/**
 * Parse logical AND (&&)
 */
function parseLogicalAnd(tokens: Token[], startIdx: number): { expr: ParsedExpr; endIdx: number } {
  let { expr: left, endIdx } = parseUnary(tokens, startIdx);

  while (endIdx < tokens.length && tokens[endIdx].type === 'operator' && tokens[endIdx].value === '&&') {
    endIdx++; // Skip &&
    const { expr: right, endIdx: newEndIdx } = parseUnary(tokens, endIdx);
    left = { type: 'logical', operator: 'and', left, right };
    endIdx = newEndIdx;
  }

  return { expr: left, endIdx };
}

/**
 * Parse unary operators (!)
 */
function parseUnary(tokens: Token[], startIdx: number): { expr: ParsedExpr; endIdx: number } {
  if (startIdx < tokens.length && tokens[startIdx].type === 'operator' && tokens[startIdx].value === '!') {
    const { expr: operand, endIdx } = parseComparison(tokens, startIdx + 1);
    return { expr: { type: 'unary', operator: 'not', operand }, endIdx };
  }

  return parseComparison(tokens, startIdx);
}

/**
 * Parse comparison operators (==, !=, <, >, <=, >=)
 */
function parseComparison(tokens: Token[], startIdx: number): { expr: ParsedExpr; endIdx: number } {
  let { expr: left, endIdx } = parsePrimary(tokens, startIdx);

  if (endIdx < tokens.length && tokens[endIdx].type === 'operator') {
    const operator = tokens[endIdx].value;
    if (['==', '!=', '<', '>', '<=', '>='].includes(operator)) {
      endIdx++; // Skip operator
      const { expr: right, endIdx: newEndIdx } = parsePrimary(tokens, endIdx);

      // Map JS operators to OData
      const operatorMap: Record<string, string> = {
        '==': 'eq',
        '!=': 'ne',
        '<': 'lt',
        '>': 'gt',
        '<=': 'le',
        '>=': 'ge',
      };

      return {
        expr: { type: 'comparison', operator: operatorMap[operator], left, right },
        endIdx: newEndIdx
      };
    }
  }

  return { expr: left, endIdx };
}

/**
 * Parse primary expressions (identifiers, literals, placeholders, parentheses)
 */
function parsePrimary(tokens: Token[], startIdx: number): { expr: ParsedExpr; endIdx: number } {
  if (startIdx >= tokens.length) {
    throw new Error('Unexpected end of expression');
  }

  const token = tokens[startIdx];

  // Parentheses
  if (token.type === 'lparen') {
    const { expr, endIdx } = parseExpression(tokens, startIdx + 1);
    if (endIdx >= tokens.length || tokens[endIdx].type !== 'rparen') {
      throw new Error(`Expected ')' at position ${token.position}`);
    }
    return { expr, endIdx: endIdx + 1 };
  }

  // Placeholder
  if (token.type === 'placeholder') {
    return {
      expr: { type: 'placeholder', index: parseInt(token.value, 10) },
      endIdx: startIdx + 1
    };
  }

  // Identifier
  if (token.type === 'identifier') {
    return {
      expr: { type: 'identifier', value: token.value },
      endIdx: startIdx + 1
    };
  }

  // Literal
  if (token.type === 'literal') {
    let value: any = token.value;
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value === 'null') value = null;
    else if (/^-?\d+$/.test(value)) value = parseInt(value, 10);
    else if (/^-?\d+\.\d+$/.test(value)) value = parseFloat(value);
    // else it's a string

    return {
      expr: { type: 'literal', value },
      endIdx: startIdx + 1
    };
  }

  throw new Error(`Unexpected token '${token.value}' at position ${token.position}`);
}

/**
 * Convert parsed expression to OData string.
 */
function exprToOData(expr: ParsedExpr, placeholderValues: string[]): string {
  switch (expr.type) {
    case 'comparison': {
      const left = exprToOData(expr.left!, placeholderValues);
      const right = exprToOData(expr.right!, placeholderValues);
      return `${left} ${expr.operator} ${right}`;
    }

    case 'logical': {
      const left = exprToOData(expr.left!, placeholderValues);
      const right = exprToOData(expr.right!, placeholderValues);

      // Add parentheses if needed
      const needsParens = (e: ParsedExpr) => e.type === 'logical';
      const leftStr = needsParens(expr.left!) ? `(${left})` : left;
      const rightStr = needsParens(expr.right!) ? `(${right})` : right;

      return `${leftStr} ${expr.operator} ${rightStr}`;
    }

    case 'unary': {
      const operand = exprToOData(expr.operand!, placeholderValues);
      return `${expr.operator} (${operand})`;
    }

    case 'placeholder': {
      if (expr.index! >= placeholderValues.length) {
        throw new Error(`Placeholder \${${expr.index}} out of range`);
      }
      return placeholderValues[expr.index!];
    }

    case 'identifier': {
      return expr.value as string;
    }

    case 'literal': {
      const value = expr.value;
      if (value === null) return 'null';
      if (typeof value === 'boolean') return String(value);
      if (typeof value === 'number') return String(value);
      if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
      return String(value);
    }

    default:
      throw new Error(`Unknown expression type: ${(expr as any).type}`);
  }
}

/**
 * Parse a JavaScript-like expression and convert to OData filter string.
 *
 * @param jsExpr The JavaScript-like expression (e.g., "field == ${0} && status != null")
 * @param placeholderValues The OData strings to substitute for ${0}, ${1}, etc.
 * @returns The OData filter string
 *
 * @example
 * parseJsToOData("field == ${0} && status != null", ["@{parameters('value')}"])
 * // Returns: "field eq @{parameters('value')} and status ne null"
 */
export function parseJsToOData(jsExpr: string, placeholderValues: string[]): string {
  try {
    const tokens = tokenize(jsExpr);
    if (tokens.length === 0) return '';

    const { expr, endIdx } = parseExpression(tokens, 0);

    if (endIdx < tokens.length) {
      throw new Error(`Unexpected token '${tokens[endIdx].value}' at position ${tokens[endIdx].position}`);
    }

    return exprToOData(expr, placeholderValues);
  } catch (error) {
    throw new Error(`Failed to parse JS expression: ${(error as Error).message}`);
  }
}
