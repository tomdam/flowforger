/**
 * Recursive-descent parser for the Logic Apps expression language.
 *
 * Grammar (no infix operators, no precedence):
 *   expression := '@'? expr                       (all tokens must be consumed)
 *   expr       := call | string | number | true | false | null | undefined | ident
 *   call       := ident '(' [ expr (',' expr)* ] ')' path*
 *   path       := '?'? ( '.' ident | '.'? '[' expr ']' )
 *
 * After a leading '@' only a call or a keyword literal is allowed —
 * '@foo' / '@123' are not expressions (evaluating consumers return them
 * verbatim; emitting consumers preserve them via their own fallbacks).
 */

import { tokenize, LexError, type Token } from './lexer.js';
import type { ExprNode, PathSeg, TemplatePart } from './ast.js';

export class ParseError extends Error {
  constructor(message: string, public pos?: number) {
    super(message);
    this.name = 'ParseError';
  }
}

const KEYWORDS: Record<string, ExprNode> = {
  true: { kind: 'bool', value: true },
  false: { kind: 'bool', value: false },
  null: { kind: 'null' },
  undefined: { kind: 'undefined' },
};

class Parser {
  private i = 0;
  constructor(private tokens: Token[]) {}

  peek(): Token { return this.tokens[this.i]; }
  next(): Token { return this.tokens[this.i++]; }
  expect<T extends Token['t']>(t: T): Token {
    const tk = this.next();
    if (tk.t !== t) throw new ParseError(`Expected '${t}' but got '${tk.t}'`, tk.pos);
    return tk;
  }

  parseExpr(): ExprNode {
    const tk = this.next();
    switch (tk.t) {
      case 'str': return { kind: 'str', value: tk.v, quote: tk.quote };
      case 'num': return { kind: 'num', value: tk.v, raw: tk.raw };
      case '@': {
        // Tolerated redundant '@' before a call or keyword literal — older
        // FlowForger transformer versions emitted nested '@' (e.g.
        // `@not(@equals(...))`) into stored flows, and the legacy regex
        // engine accepted it. The '@' carries no meaning here; the parsed
        // node is the same as without it (round-trips re-emit canonically).
        //
        // '@' before a string or number literal (@0, @'', @'text') is PA's
        // literal-expression form — accepted and tagged with `at: true` so
        // re-emitting consumers can preserve the prefix. Bare '@ident'
        // remains invalid.
        const inner = this.parseExpr();
        if (inner.kind === 'str' || inner.kind === 'num') {
          return { ...inner, at: true };
        }
        if (inner.kind !== 'call' && inner.kind !== 'bool' && inner.kind !== 'null' && inner.kind !== 'undefined') {
          throw new ParseError(`'@' must be followed by a function call or keyword literal`, tk.pos);
        }
        return inner;
      }
      case 'ident': {
        const kw = KEYWORDS[tk.v.toLowerCase()];
        if (kw) return kw;
        if (this.peek().t === '(') return this.parseCall(tk.v);
        return { kind: 'ident', name: tk.v };
      }
      default:
        throw new ParseError(`Unexpected token '${tk.t}'`, tk.pos);
    }
  }

  parseCall(name: string): ExprNode {
    this.expect('(');
    const args: ExprNode[] = [];
    if (this.peek().t !== ')') {
      for (;;) {
        args.push(this.parseExpr());
        if (this.peek().t === ',') { this.next(); continue; }
        break;
      }
    }
    this.expect(')');
    return { kind: 'call', name, args, path: this.parsePath() };
  }

  parsePath(): PathSeg[] {
    const path: PathSeg[] = [];
    let optional = false;
    for (;;) {
      const tk = this.peek();
      if (tk.t === '?') {
        this.next();
        optional = true;
        continue;
      }
      if (tk.t === '.') {
        this.next();
        if (this.peek().t === '[') continue; // the `.['k']` form — bracket handler picks it up
        const id = this.expect('ident') as Extract<Token, { t: 'ident' }>;
        path.push({ kind: 'prop', name: id.v, optional });
        optional = false;
        continue;
      }
      if (tk.t === '[') {
        this.next();
        const expr = this.parseExpr();
        this.expect(']');
        path.push({ kind: 'index', expr, optional });
        optional = false;
        continue;
      }
      if (optional) throw new ParseError(`Dangling '?' with no path segment`, tk.pos);
      break;
    }
    return path;
  }
}

/** Parse a full expression string (optional leading '@'). Throws ParseError. */
export function parseExpression(input: string): ExprNode {
  const e = input.trim();
  if (!e) throw new ParseError('Empty expression');
  let tokens: Token[];
  try {
    tokens = tokenize(e);
  } catch (err) {
    if (err instanceof LexError) throw new ParseError(err.message, err.pos);
    throw err;
  }
  const p = new Parser(tokens);
  // A leading '@' is handled by parseExpr's '@' case, which enforces that
  // '@foo' / '@123' / "@'str'" are not expressions (legacy consumers treat
  // them verbatim).
  const node = p.parseExpr();
  p.expect('eof');
  return node;
}

const CACHE_MAX = 10_000;
const cache = new Map<string, ExprNode | null>();

/** Cached, non-throwing variant. Returns null on any parse/lex error. */
export function tryParseExpression(input: string): ExprNode | null {
  const hit = cache.get(input);
  if (hit !== undefined) return hit;
  let node: ExprNode | null;
  try {
    node = parseExpression(input);
  } catch {
    node = null;
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(input, node);
  return node;
}

/** A syntax error inside one @{...} template segment. */
export interface TemplateError {
  /** Offset of the segment's '@{' in the input. */
  start: number;
  /** Length of the whole segment including '@{' and '}'. */
  length: number;
  /** Parse error message for the inner expression. */
  message: string;
  /** Absolute offset of the syntax error in the input, when known. */
  pos?: number;
}

/**
 * Split "text @{expr} text" into parts. Non-template strings return one text
 * part. An @{...} whose inner text does not parse yields a text part with the
 * raw '@' + inner (lenient degrade). Never throws. An unterminated '@{'
 * leaves the rest of the string as text.
 */
export function parseTemplate(input: string): TemplatePart[] {
  return scanTemplate(input).parts;
}

/**
 * Strict variant: returns null if any @{...} segment's inner text fails to
 * parse (consumers that need whole-string fidelity fall back to preserving
 * the original verbatim).
 */
export function parseTemplateStrict(input: string): TemplatePart[] | null {
  const { parts, errors } = scanTemplate(input);
  return errors.length > 0 ? null : parts;
}

/**
 * Diagnostics variant: lenient parts plus a positioned error record for every
 * segment whose inner expression failed to parse.
 */
export function parseTemplateWithDiagnostics(input: string): { parts: TemplatePart[]; errors: TemplateError[] } {
  return scanTemplate(input);
}

function scanTemplate(input: string): { parts: TemplatePart[]; errors: TemplateError[] } {
  const parts: TemplatePart[] = [];
  const errors: TemplateError[] = [];
  let i = 0;
  let textStart = 0;

  while (i < input.length) {
    if (input[i] === '@' && input[i + 1] === '{') {
      // Find the matching close brace, ignoring braces inside string literals.
      let j = i + 2;
      let quote: string | null = null;
      let closeIdx = -1;
      while (j < input.length) {
        const c = input[j];
        if (quote) {
          if (c === quote) {
            if (input[j + 1] === quote) { j += 2; continue; } // doubled-quote escape
            quote = null;
          }
          j++;
          continue;
        }
        if (c === "'" || c === '"') { quote = c; j++; continue; }
        if (c === '}') { closeIdx = j; break; }
        j++;
      }
      if (closeIdx === -1) break; // unterminated — rest is text

      if (i > textStart) parts.push({ kind: 'text', text: input.slice(textStart, i) });
      const raw = input.slice(i + 2, closeIdx);
      let node = tryParseExpression('@' + raw);
      // The '@' prepended above is a scanner artifact, not part of the inner
      // expression — a bare literal segment like @{2026} must not come back
      // at-flagged (@{@2026} in the raw text keeps its flag).
      if (
        node &&
        (node.kind === 'str' || node.kind === 'num') &&
        node.at &&
        !raw.trimStart().startsWith('@')
      ) {
        const { at, ...rest } = node;
        node = rest;
      }
      if (node) {
        parts.push({ kind: 'expr', node, raw, start: i });
      } else {
        // Re-parse uncached to capture the error detail with its position.
        let message = 'invalid expression';
        let pos: number | undefined;
        try {
          parseExpression('@' + raw);
        } catch (err) {
          if (err instanceof ParseError) {
            message = err.message;
            // err.pos is relative to '@' + raw; -1 removes the prepended '@',
            // i + 2 shifts to the segment's inner start in the input.
            if (err.pos !== undefined && err.pos > 0) pos = i + 2 + (err.pos - 1);
          } else if (err instanceof Error) {
            message = err.message;
          }
        }
        errors.push({ start: i, length: closeIdx + 1 - i, message, pos });
        parts.push({ kind: 'text', text: '@' + raw });
      }
      i = closeIdx + 1;
      textStart = i;
      continue;
    }
    i++;
  }

  if (textStart < input.length) parts.push({ kind: 'text', text: input.slice(textStart) });
  return { parts, errors };
}
