/**
 * OData Filter Parser (generator direction)
 * Parses OData $filter strings and generates ctx.odata.* builder code.
 *
 * Pipeline: tokenizer + recursive-descent parser (../odata/) → AST →
 * ctx.odata.* emission (odata-emitter.ts) → ROUND-TRIP VERIFICATION: the
 * emitted code is fed through the actual production transformer
 * (transformODataCall) and must reproduce the source filter byte-for-byte;
 * otherwise the filter is preserved verbatim via ctx.odata.raw.
 *
 * The guard heuristics predate the verifier and are kept as cheap early
 * outs; the verifier is the systematic net behind them. Byte-exact
 * round-trip fidelity (DSL → IR → Logic Apps JSON identical to the source
 * JSON) is the contract; readable builder code is best-effort on top.
 */

import { Project, SyntaxKind } from 'ts-morph';
import { isODataCall, transformODataCall } from '../transformer/odata-transformer.js';
import { parseODataFilterString } from '../odata/parser.js';
import { emitODataFilter, escapeForStringLiteral } from './odata-emitter.js';

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
  // These are explicitly handled by the parser.
  const supported = new Set(['contains', 'startswith', 'endswith']);
  return !supported.has(fn);
}

/**
 * Detect a `@{...}` PA template appearing as a standalone clause after `and`/`or`
 * (rather than as the value of a `field op value` triple). Standalone template
 * operands have no builder representation, so fall back to raw when present.
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
 * (e.g. `(@{variables('X')}AH_ID eq '1')`). No faithful builder representation.
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
 * The transformer re-quotes bare values on emit, breaking parity. Source flows
 * that rely on unquoted dates need raw fallback to preserve the form.
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
 * Sources sometimes have stray quotes; raw preservation keeps the source form
 * byte-exact.
 */
function hasUnbalancedSingleQuotes(filter: string): boolean {
  let count = 0;
  let i = 0;
  while (i < filter.length) {
    if (filter[i] === "'") {
      if (filter[i + 1] === "'") {
        i += 2;
        continue;
      }
      count++;
    }
    i++;
  }
  return count % 2 !== 0;
}

let verifyProject: Project | undefined;

/**
 * True iff `code`, parsed as a ctx.odata.* expression and re-serialized by the
 * production transformer, reproduces `original` byte-for-byte. This is the
 * exact operation the DSL→IR transform performs on the generated file later,
 * so passing here guarantees JSON round-trip parity for this filter.
 */
function roundTripsExactly(code: string, original: string): boolean {
  try {
    verifyProject ??= new Project({ useInMemoryFileSystem: true });
    const sf = verifyProject.createSourceFile('__odata_verify__.ts', `const __f = ${code};`, {
      overwrite: true,
    });
    const init = sf.getVariableDeclarationOrThrow('__f').getInitializerOrThrow();
    if (!isODataCall(init)) return false;
    return transformODataCall(init.asKindOrThrow(SyntaxKind.CallExpression)) === original;
  } catch {
    return false;
  }
}

/**
 * Parse an OData filter string and generate ctx.odata.* builder code.
 */
export function parseODataFilter(filter: string): string {
  if (!filter || filter.trim() === '') {
    return '""';
  }

  const raw = `ctx.odata.raw("${escapeForStringLiteral(filter)}")`;

  // Verbatim-preservation guards: cheap detectors for source forms known not
  // to survive a structured round-trip.
  if (
    hasParenthesizedConditions(filter) ||
    hasQuotedExpressions(filter) ||
    hasSignificantWhitespace(filter) ||
    hasUnsupportedFunction(filter) ||
    hasTemplateAfterAndOr(filter) ||
    hasTemplateInsideStringWithPrefix(filter) ||
    hasTemplateFollowedByLetter(filter) ||
    hasTranslatableTemplate(filter) ||
    hasUnquotedDate(filter) ||
    hasNoSpaceCommaInFunc(filter) ||
    hasUnbalancedSingleQuotes(filter) ||
    hasNonCanonicalParenWhitespace(filter)
  ) {
    return raw;
  }

  try {
    const ast = parseODataFilterString(filter);
    const code = emitODataFilter(ast, '      ');
    return roundTripsExactly(code, filter) ? code : raw;
  } catch {
    // ODataLexError, ODataParseError, ODataEmitBailout, expression-parser
    // failures — all degrade to verbatim preservation.
    return raw;
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
