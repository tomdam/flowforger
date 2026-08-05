/**
 * AST → TypeScript emitter for the DSL generator.
 *
 * Visits @flowforger/expressions AST nodes and emits the TypeScript the
 * generator writes into .ff.ts files. The emission mappings (equals → ===,
 * body → ctx.body, toLower → .toLowerCase(), …) are ported case-for-case
 * from the legacy string-scanning implementation; round-trip fidelity is
 * the prime directive.
 *
 * Throwing EmitBailout asks the caller to fall back to preserving the
 * expression verbatim via ctx.eval(`...`) — used by the canonical-casing
 * guards where regeneration would lose the source's casing.
 */

import type { ExprNode, PathSeg } from '@flowforger/expressions';

export interface EmitContext {
  /** Present for API symmetry; the legacy implementation threaded it but never read it. */
  variableMap?: unknown;
  /** Loop name → loop variable name (foreach); items('X') emits the variable. */
  loopMap?: Map<string, string>;
  /** Innermost foreach loop variable; item() emits it directly. */
  currentLoopVar?: string;
}

export class EmitBailout extends Error {
  constructor(message = 'emit bailout — preserve expression verbatim') {
    super(message);
    this.name = 'EmitBailout';
  }
}

/** Re-encode a decoded string value in its source quote style with TS escaping. */
function emitString(value: string, quote: "'" | '"'): string {
  let processed = value.replace(/\\/g, '\\\\');
  if (quote === "'") processed = processed.replace(/'/g, "\\'");
  else processed = processed.replace(/"/g, '\\"');
  return `${quote}${processed}${quote}`;
}

/**
 * Check if an emitted expression is fully wrapped in a single pair of
 * parentheses, e.g., "(a === b)" but not "(a + b) * (c + d)".
 */
function isFullyParenthesized(expr: string): boolean {
  if (!expr.startsWith('(') || !expr.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < expr.length - 1; i++) {
    if (expr[i] === '(') depth++;
    if (expr[i] === ')') depth--;
    if (depth === 0) return false;
  }
  return true;
}

function isPrimitiveLiteral(s: string): boolean {
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  if (/^'[^']*'$/.test(s)) return true;
  if (/^"[^"]*"$/.test(s)) return true;
  return false;
}

/**
 * PA comparisons are loose-typed but TypeScript's === is strict; cast the
 * left side to any when the operand types clearly differ (prevents TS2367).
 */
function looksLikeCrossTypeComparison(left: string, right: string): boolean {
  const boolLiterals = new Set(['true', 'false']);
  const leftIsBool = boolLiterals.has(left);
  const rightIsBool = boolLiterals.has(right);
  const leftIsNull = left === 'null';
  const rightIsNull = right === 'null';

  if (leftIsBool !== rightIsBool) return true;
  if (leftIsNull && !rightIsNull && right !== 'undefined') return true;
  if (rightIsNull && !leftIsNull && left !== 'undefined') return true;
  if (isPrimitiveLiteral(left) && isPrimitiveLiteral(right) && left !== right) return true;
  return false;
}

/** Functions whose emission requires the source to use canonical casing —
 *  otherwise the round-trip would re-emit canonical and lose the original. */
const CASING_GUARDS: Record<string, string> = {
  replace: 'replace',
  tolower: 'toLower',
  toupper: 'toUpper',
  trim: 'trim',
  split: 'split',
  range: 'range',
  if: 'if',
  coalesce: 'coalesce',
  decodeuricomponent: 'decodeUriComponent',
};

/** Date/time functions emitted as ctx.<sourceName>(...) passthroughs. */
const DATETIME_FNS = new Set([
  'utcnow', 'adddays', 'addhours', 'addminutes', 'addseconds', 'addtotime',
  'convertfromutc', 'converttimezone', 'converttoutc', 'dayofmonth',
  'dayofweek', 'dayofyear', 'formatdatetime', 'getfuturetime', 'getpasttime',
  'startofday', 'startofhour', 'startofmonth', 'ticks',
]);

function emitComparison(op: string, args: ExprNode[], ec: EmitContext): string {
  const left = emitNode(args[0], ec);
  const right = emitNode(args[1], ec);
  const leftExpr = looksLikeCrossTypeComparison(left, right) ? `(${left} as any)` : left;
  return `(${leftExpr} ${op} ${right})`;
}

function ctxCall(methodName: string, args: ExprNode[], ec: EmitContext): string {
  const argStrs = args.map(a => emitNode(a, ec));
  return argStrs.length > 0 ? `ctx.${methodName}(${argStrs.join(', ')})` : `ctx.${methodName}()`;
}

function emitCall(node: Extract<ExprNode, { kind: 'call' }>, ec: EmitContext): string {
  const funcName = node.name;
  const lower = funcName.toLowerCase();
  const args = node.args;

  const guard = CASING_GUARDS[lower];
  if (guard && funcName !== guard) throw new EmitBailout(`non-canonical casing: ${funcName}`);

  switch (lower) {
    // Comparison operators (2 args; other arities fall through to the default ctx call)
    case 'equals':
      if (args.length === 2) return emitComparison('===', args, ec);
      break;
    case 'greater':
      if (args.length === 2) return emitComparison('>', args, ec);
      break;
    case 'less':
      if (args.length === 2) return emitComparison('<', args, ec);
      break;
    case 'greaterorequals':
      if (args.length === 2) return emitComparison('>=', args, ec);
      break;
    case 'lessorequals':
      if (args.length === 2) return emitComparison('<=', args, ec);
      break;

    // Logical operators
    case 'and':
      if (args.length >= 2) return `(${args.map(a => emitNode(a, ec)).join(' && ')})`;
      if (args.length === 1) return `ctx.and(${emitNode(args[0], ec)})`;
      break;
    case 'or':
      if (args.length >= 2) return `(${args.map(a => emitNode(a, ec)).join(' || ')})`;
      if (args.length === 1) return `ctx.or(${emitNode(args[0], ec)})`;
      break;
    case 'not':
      if (args.length === 1) {
        const inner = emitNode(args[0], ec);
        return isFullyParenthesized(inner) ? `!${inner}` : `!(${inner})`;
      }
      break;

    // Reference functions — canonical ctx methods. The zero-arg forms drop
    // any (invalid) source args, matching legacy.
    case 'body': return ctxCall('body', args, ec);
    case 'outputs': return ctxCall('outputs', args, ec);
    case 'actions': return ctxCall('actions', args, ec);
    case 'triggerbody': return ctxCall('triggerBody', [], ec);
    case 'triggeroutputs': return ctxCall('triggerOutputs', [], ec);
    case 'trigger': return ctxCall('trigger', [], ec);
    case 'workflow': return ctxCall('workflow', [], ec);
    case 'parameters': return ctxCall('parameters', args, ec);

    case 'variables':
      // String-literal name: preserve the source name in the DSL — the
      // transformer round-trips it unchanged when it isn't in the map.
      if (args.length > 0 && args[0].kind === 'str') {
        return `ctx.variables(${emitString(args[0].value, "'")})`;
      }
      return ctxCall('variables', args, ec);

    case 'item':
      if (ec.currentLoopVar) return ec.currentLoopVar;
      return ctxCall('item', [], ec);

    case 'items':
      if (ec.loopMap && args.length > 0 && args[0].kind === 'str') {
        const loopVar = ec.loopMap.get(args[0].value);
        if (loopVar) return loopVar;
      }
      return ctxCall('items', args, ec);

    // ctx passthroughs (canonical name) — preserved for round-trip fidelity
    case 'concat': return ctxCall('concat', args, ec);
    case 'substring': return ctxCall('substring', args, ec);
    case 'contains': return ctxCall('contains', args, ec);
    case 'empty':
      if (args.length === 1) return ctxCall('empty', args, ec);
      break;
    case 'first': return ctxCall('first', args, ec);
    case 'last': return ctxCall('last', args, ec);
    case 'skip': return ctxCall('skip', args, ec);
    case 'take': return ctxCall('take', args, ec);
    case 'range':
      if (args.length === 2) return ctxCall('range', args, ec);
      break;
    case 'int':
      if (args.length === 1) return ctxCall('int', args, ec);
      break;
    case 'float':
      if (args.length === 1) return ctxCall('float', args, ec);
      break;
    case 'rand':
      if (args.length === 2) return ctxCall('rand', args, ec);
      break;
    case 'string':
      if (args.length === 1) return ctxCall('string', args, ec);
      break;
    case 'json':
      if (args.length === 1) return ctxCall('json', args, ec);
      break;
    case 'bool':
      if (args.length === 1) return ctxCall('bool', args, ec);
      break;

    // JS-method emissions
    case 'replace':
      if (args.length === 3) {
        return `${emitNode(args[0], ec)}.replace(${emitNode(args[1], ec)}, ${emitNode(args[2], ec)})`;
      }
      break;
    case 'tolower':
      if (args.length === 1) return `${emitNode(args[0], ec)}.toLowerCase()`;
      break;
    case 'toupper':
      if (args.length === 1) return `${emitNode(args[0], ec)}.toUpperCase()`;
      break;
    case 'trim':
      if (args.length === 1) return `${emitNode(args[0], ec)}.trim()`;
      break;
    case 'split':
      if (args.length === 2) return `${emitNode(args[0], ec)}.split(${emitNode(args[1], ec)})`;
      break;
    case 'join':
      if (args.length === 2) return `${emitNode(args[0], ec)}.join(${emitNode(args[1], ec)})`;
      break;
    case 'indexof':
      if (args.length === 2) return `${emitNode(args[0], ec)}.indexOf(${emitNode(args[1], ec)})`;
      break;
    case 'lastindexof':
      if (args.length === 2) return `${emitNode(args[0], ec)}.lastIndexOf(${emitNode(args[1], ec)})`;
      break;
    case 'startswith':
      if (args.length === 2) return `${emitNode(args[0], ec)}.startsWith(${emitNode(args[1], ec)})`;
      break;
    case 'endswith':
      if (args.length === 2) return `${emitNode(args[0], ec)}.endsWith(${emitNode(args[1], ec)})`;
      break;
    case 'length':
      if (args.length === 1) return `${emitNode(args[0], ec)}.length`;
      break;

    case 'createarray':
      return `[${args.map(a => emitNode(a, ec)).join(', ')}]`;

    // Math
    case 'add':
      if (args.length === 2) return `(${emitNode(args[0], ec)} + ${emitNode(args[1], ec)})`;
      break;
    case 'sub':
      if (args.length === 2) return `(${emitNode(args[0], ec)} - ${emitNode(args[1], ec)})`;
      break;
    case 'mul':
      if (args.length === 2) return `(${emitNode(args[0], ec)} * ${emitNode(args[1], ec)})`;
      break;
    case 'div':
      if (args.length === 2) return `(${emitNode(args[0], ec)} / ${emitNode(args[1], ec)})`;
      break;
    case 'mod':
      if (args.length === 2) return `(${emitNode(args[0], ec)} % ${emitNode(args[1], ec)})`;
      break;
    case 'abs':
      if (args.length === 1) return `Math.abs(${emitNode(args[0], ec)})`;
      break;
    case 'min':
      return `Math.min(${args.map(a => emitNode(a, ec)).join(', ')})`;
    case 'max':
      return `Math.max(${args.map(a => emitNode(a, ec)).join(', ')})`;

    // Conditional
    case 'if':
      if (args.length === 3) {
        return `(${emitNode(args[0], ec)} ? ${emitNode(args[1], ec)} : ${emitNode(args[2], ec)})`;
      }
      break;
    case 'coalesce':
      if (args.length === 1) return ctxCall('coalesce', args, ec);
      return `(${args.map(a => emitNode(a, ec)).join(' ?? ')})`;

    case 'guid':
      return 'ctx.guid()';

    // Base64 / URI — canonical ctx methods
    case 'base64':
      if (args.length === 1) return ctxCall('base64', args, ec);
      break;
    case 'base64tostring':
      if (args.length === 1) return ctxCall('base64ToString', args, ec);
      break;
    case 'uricomponent':
      if (args.length === 1) return ctxCall('uriComponent', args, ec);
      break;
    case 'uricomponenttostring':
      if (args.length === 1) return ctxCall('uriComponentToString', args, ec);
      break;
    case 'decodeuricomponent':
      if (args.length === 1) return ctxCall('decodeUriComponent', args, ec);
      break;

    // XML/XPath — ctx passthrough with SOURCE casing (typed ctx method so the
    // transformer recursively transforms args and applies @ prefix at root)
    case 'xml':
    case 'xpath':
      return ctxCall(funcName, args, ec);
  }

  // Date/time passthroughs and the default: ctx.<sourceName>(...)
  if (DATETIME_FNS.has(lower)) {
    return ctxCall(funcName, args, ec);
  }
  return ctxCall(funcName, args, ec);
}

export function emitPath(path: PathSeg[], ec: EmitContext): string {
  let out = '';
  for (const seg of path) {
    if (seg.kind === 'prop') {
      out += seg.optional ? `?.${seg.name}` : `.${seg.name}`;
      continue;
    }
    const key = emitNode(seg.expr, ec);
    out += seg.optional ? `?.[${key}]` : `[${key}]`;
  }
  return out;
}

export function emitNode(node: ExprNode, ec: EmitContext): string {
  switch (node.kind) {
    // @-prefixed literals (@'text', @0) round-trip via ctx.atString/ctx.atNumber,
    // which the transformer maps back to the @'...' / @n literal-expression form.
    case 'str': return node.at ? `ctx.atString(${emitString(node.value, node.quote)})` : emitString(node.value, node.quote);
    case 'num': return node.at ? `ctx.atNumber(${node.raw})` : node.raw;
    case 'bool': return node.value ? 'true' : 'false';
    case 'null': return 'null';
    case 'undefined': return 'undefined';
    case 'ident': return node.name;
    case 'call': return emitCall(node, ec) + emitPath(node.path, ec);
  }
}
