/**
 * Recursive-descent parser for OData $filter strings.
 *
 * Grammar (precedence low → high):
 *   filter     := or , end-of-input
 *   or         := and ( 'or' and )*            → flat n-ary logical node
 *   and        := unary ( 'and' unary )*       → flat n-ary logical node
 *   unary      := 'not' unary | primary
 *   primary    := '(' or ')'                                    → group
 *                | funcName '(' word ',' value ')'              → func
 *                | Microsoft.Dynamics.CRM.* '(' ... ')'         → raw (verbatim slice)
 *                | comparison
 *   comparison := (word | template) op value
 *   op         := eq | ne | gt | ge | lt | le   (case-insensitive)
 *
 * Keywords are matched case-insensitively (the legacy parser lowercased
 * tokens); canonical lowercase is stored on the node. The parser never skips
 * a token it does not understand — unknown constructs throw ODataParseError,
 * and callers fall back to verbatim preservation.
 */

import type { CompareOp, ODataFilter, ODataValue } from './ast.js';
import { ODataToken, tokenizeOData } from './lexer.js';

export class ODataParseError extends Error {
  constructor(
    message: string,
    readonly pos: number
  ) {
    super(`${message} at position ${pos}`);
    this.name = 'ODataParseError';
  }
}

const COMPARE_OPS = new Set<string>(['eq', 'ne', 'gt', 'ge', 'lt', 'le']);
const STRING_FUNCS = new Set<string>(['contains', 'startswith', 'endswith']);
const CRM_PREFIX = 'Microsoft.Dynamics.CRM.';

export function parseODataFilterString(input: string): ODataFilter {
  const tokens = tokenizeOData(input);
  if (tokens.length === 0) throw new ODataParseError('Empty filter', 0);
  const parser = new Parser(tokens, input);
  const filter = parser.parseOr();
  parser.expectEnd();
  return filter;
}

class Parser {
  private i = 0;

  constructor(
    private readonly tokens: ODataToken[],
    private readonly source: string
  ) {}

  private peek(): ODataToken | undefined {
    return this.tokens[this.i];
  }

  private next(): ODataToken {
    const tok = this.tokens[this.i];
    if (!tok) throw new ODataParseError('Unexpected end of filter', this.source.length);
    this.i++;
    return tok;
  }

  private isKeyword(tok: ODataToken | undefined, kw: string): boolean {
    return tok?.t === 'word' && tok.v.toLowerCase() === kw;
  }

  expectEnd(): void {
    const tok = this.peek();
    if (tok) throw new ODataParseError(`Unexpected trailing token`, tok.pos);
  }

  parseOr(): ODataFilter {
    const first = this.parseAnd();
    if (!this.isKeyword(this.peek(), 'or')) return first;
    const operands: ODataFilter[] = [first];
    while (this.isKeyword(this.peek(), 'or')) {
      this.i++;
      operands.push(this.parseAnd());
    }
    return { kind: 'logical', op: 'or', operands };
  }

  private parseAnd(): ODataFilter {
    const first = this.parseUnary();
    if (!this.isKeyword(this.peek(), 'and')) return first;
    const operands: ODataFilter[] = [first];
    while (this.isKeyword(this.peek(), 'and')) {
      this.i++;
      operands.push(this.parseUnary());
    }
    return { kind: 'logical', op: 'and', operands };
  }

  private parseUnary(): ODataFilter {
    if (this.isKeyword(this.peek(), 'not')) {
      this.i++;
      let operand = this.parseUnary();
      // The printer always parenthesizes not's operand (`not (...)`), so a
      // direct group here would print double parens. Collapse it.
      if (operand.kind === 'group') operand = operand.inner;
      return { kind: 'not', operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ODataFilter {
    const tok = this.peek();
    if (!tok) throw new ODataParseError('Unexpected end of filter', this.source.length);

    if (tok.t === 'lparen') {
      this.i++;
      const inner = this.parseOr();
      const close = this.peek();
      if (close?.t !== 'rparen') {
        throw new ODataParseError(`Expected ')'`, close?.pos ?? this.source.length);
      }
      this.i++;
      return { kind: 'group', inner };
    }

    if (tok.t === 'word' && this.tokens[this.i + 1]?.t === 'lparen') {
      const lower = tok.v.toLowerCase();
      if (STRING_FUNCS.has(lower)) return this.parseFunc();
      if (tok.v.startsWith(CRM_PREFIX)) return this.parseCrmRawCall();
      throw new ODataParseError(`Unsupported function '${tok.v}'`, tok.pos);
    }

    return this.parseComparison();
  }

  /** contains/startswith/endswith — cursor at the function-name word. */
  private parseFunc(): ODataFilter {
    const nameTok = this.next();
    const name = (nameTok as { v: string }).v.toLowerCase() as
      | 'contains'
      | 'startswith'
      | 'endswith';
    this.next(); // lparen (guaranteed by caller)
    const fieldTok = this.next();
    if (fieldTok.t !== 'word') {
      throw new ODataParseError(`Expected field name in ${name}()`, fieldTok.pos);
    }
    const comma = this.next();
    if (comma.t !== 'comma') throw new ODataParseError(`Expected ',' in ${name}()`, comma.pos);
    const value = this.parseValue();
    const close = this.next();
    if (close.t !== 'rparen') throw new ODataParseError(`Expected ')' in ${name}()`, close.pos);
    return { kind: 'func', name, field: fieldTok.v, value };
  }

  /**
   * Microsoft.Dynamics.CRM.* call — Dataverse-specific OData functions
   * (e.g. Microsoft.Dynamics.CRM.In). Preserved as a verbatim source slice:
   * walk tokens balancing parens, then slice the original source text.
   */
  private parseCrmRawCall(): ODataFilter {
    const nameTok = this.next(); // function-name word
    this.next(); // lparen
    let depth = 1;
    let endPos: number | undefined;
    while (depth > 0) {
      const tok = this.next();
      if (tok.t === 'lparen') depth++;
      else if (tok.t === 'rparen') {
        depth--;
        if (depth === 0) endPos = tok.pos + 1;
      }
    }
    return { kind: 'raw', text: this.source.slice(nameTok.pos, endPos) };
  }

  private parseComparison(): ODataFilter {
    const left = this.next();
    let field: string;
    if (left.t === 'word') field = left.v;
    else if (left.t === 'template') field = left.raw;
    else throw new ODataParseError('Expected field name', left.pos);

    const opTok = this.next();
    if (opTok.t !== 'word' || !COMPARE_OPS.has(opTok.v.toLowerCase())) {
      throw new ODataParseError(`Expected comparison operator after '${field}'`, opTok.pos);
    }
    const op = opTok.v.toLowerCase() as CompareOp;
    const value = this.parseValue();
    return { kind: 'compare', field, op, value };
  }

  private parseValue(): ODataValue {
    const tok = this.next();
    switch (tok.t) {
      case 'string':
        // A string with an embedded @{...} template must survive verbatim,
        // quotes included — decoding and re-encoding could move the escapes.
        return tok.hasTemplate
          ? { kind: 'verbatim', text: tok.raw }
          : { kind: 'string', value: tok.v };
      case 'number':
        return { kind: 'number', raw: tok.raw };
      case 'template':
        return { kind: 'template', raw: tok.raw };
      case 'word':
        if (tok.v === 'true') return { kind: 'bool', value: true };
        if (tok.v === 'false') return { kind: 'bool', value: false };
        if (tok.v === 'null') return { kind: 'null' };
        return { kind: 'verbatim', text: tok.v };
      default:
        throw new ODataParseError('Expected value', tok.pos);
    }
  }
}
