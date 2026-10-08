/**
 * AST evaluator with a per-function registry.
 *
 * Function implementations live in ./functions/* and self-register via
 * register(). The evaluator applies trailing property paths uniformly after
 * a call returns, so registry entries never deal with paths themselves.
 *
 * tryEvaluate() is the legacy-compatible entry point: it reports ok:false
 * (instead of throwing) for anything it cannot handle — parse errors,
 * unknown functions — so the caller can fall back to the legacy regex chain
 * (during migration) or to the raw expression text.
 */

import type { RunContext } from '../index.js';
import type { ExprNode, PathSeg } from '@flowforger/expressions';
import { walkCalls, tryParseExpression, parseTemplate, KNOWN_FUNCTIONS, argumentCountMessage } from '@flowforger/expressions';
import { ExpressionError, findKey, isPlainObject, toText, typeName } from './values.js';

export interface FnContext {
  ctx: RunContext;
  ev: (node: ExprNode) => any;
}
export type ExprFn = (args: ExprNode[], f: FnContext) => any;

export const registry = new Map<string, ExprFn>(); // keys lowercase

export function register(names: string | string[], fn: ExprFn): void {
  for (const n of Array.isArray(names) ? names : [names]) registry.set(n.toLowerCase(), fn);
}

/** Wrap an impl that wants evaluated arg values (the eager 90% case). */
export function eager(impl: (vals: any[], ctx: RunContext) => any): ExprFn {
  return (args, f) => impl(args.map(f.ev), f.ctx);
}

export class UnknownFunctionError extends Error {
  constructor(public fnName: string) {
    super(`Unknown expression function: ${fnName}`);
    this.name = 'UnknownFunctionError';
  }
}

/** Best-effort source text of a call, for error messages. */
function sourceOf(node: ExprNode): string {
  switch (node.kind) {
    case 'str': return `'${node.value.replace(/'/g, "''")}'`;
    case 'num': return node.raw;
    case 'bool': return String(node.value);
    case 'null': return 'null';
    case 'undefined': return 'undefined';
    case 'ident': return node.name;
    case 'call': {
      let out = `${node.name}(${node.args.map(sourceOf).join(', ')})`;
      for (const seg of node.path) {
        const opt = seg.optional ? '?' : '';
        out += seg.kind === 'prop' ? `${opt}.${seg.name}` : `${opt}[${sourceOf(seg.expr)}]`;
      }
      return out;
    }
  }
}

/** The cloud's error for a function it doesn't define (or one the local engine lacks). */
function unknownFunctionError(name: string): ExpressionError {
  return KNOWN_FUNCTIONS.has(name.toLowerCase())
    ? new ExpressionError(`The template function '${name}' is not supported by the local engine.`)
    : new ExpressionError(`The template function '${name}' is not defined or not valid.`);
}

/**
 * A call with more or fewer arguments than the function takes fails before anything is
 * evaluated, with the cloud's message for that function (conformance/flows/expr-errors.ff.ts).
 */
function checkArity(name: string, count: number): void {
  const message = argumentCountMessage(name, count);
  if (message) throw new ExpressionError(message);
}

export function evaluateNode(node: ExprNode, ctx: RunContext): any {
  switch (node.kind) {
    case 'str': return node.value;
    case 'num': return node.value;
    case 'bool': return node.value;
    case 'null': return null;
    case 'undefined': return undefined;
    case 'ident': return node.name; // legacy resolveValue fallback: bare word → its text
    case 'call': {
      const fn = registry.get(node.name.toLowerCase());
      if (!fn) throw new UnknownFunctionError(node.name); // callers pre-check; belt & braces
      checkArity(node.name, node.args.length);
      const f: FnContext = { ctx, ev: n => evaluateNode(n, ctx) };
      const result = fn(node.args, f);
      return node.path.length ? navigateSegments(result, node.path, ctx, sourceOf(node)) : result;
    }
  }
}

/**
 * Applies a property path the way the cloud does: names match case-insensitively; `?[...]`
 * yields null for a missing property, a null value or an index past the end; plain `[...]`
 * fails on those. Selecting a property of an array or a string fails either way.
 */
export function navigateSegments(value: any, path: PathSeg[], ctx: RunContext, source = ''): any {
  let val = value;
  for (const seg of path) {
    const key = seg.kind === 'prop' ? seg.name : evaluateNode(seg.expr, ctx);
    if (typeof key === 'string' && key.includes('/')) {
      // Power Automate convention: ['body/value'] navigates nested properties.
      for (const part of key.split('/')) {
        val = selectOne(val, part, seg.optional, source);
        if (val === undefined || val === null) break;
      }
    } else {
      val = selectOne(val, key, seg.optional, source);
    }
  }
  return val;
}

function selectOne(val: any, key: any, optional: boolean, source: string): any {
  const cannot = (why = '') =>
    new ExpressionError(
      `The template language expression '${source}' cannot be evaluated because property '${key}' cannot be selected.${why}`,
    );
  if (val === null || val === undefined) {
    if (optional) return undefined;
    throw cannot();
  }
  if (Array.isArray(val)) {
    const index = typeof key === 'number' ? key : typeof key === 'string' && /^\d+$/.test(key) ? Number(key) : NaN;
    if (!Number.isInteger(index)) throw cannot(' Array elements can only be selected using an integer index.');
    if (index < 0 || index >= val.length) {
      if (optional) return undefined;
      throw new ExpressionError(
        `The template language expression '${source}' cannot be evaluated because array index '${index}' is outside bounds (0, ${val.length - 1}) of array.`,
      );
    }
    return val[index];
  }
  if (isPlainObject(val)) {
    const found = findKey(val, String(key));
    if (found !== undefined) return val[found];
    if (optional) return undefined;
    throw new ExpressionError(
      `The template language expression '${source}' cannot be evaluated because property '${key}' doesn't exist, available properties are '${Object.keys(val).join(', ')}'.`,
    );
  }
  throw cannot(` Property selection is not supported on values of type '${typeName(val)}'.`);
}

export type TryResult =
  | { ok: true; value: any }
  | { ok: false; reason: string; error?: unknown };

function hasUnknownFunction(node: ExprNode): string | null {
  for (const name of walkCalls(node)) {
    if (!registry.has(name.toLowerCase())) return name;
  }
  return null;
}

let warnedEmptyRegistry = false;

function evaluateExpressionString(e: string, ctx: RunContext): TryResult {
  if (registry.size === 0 && !warnedEmptyRegistry) {
    warnedEmptyRegistry = true;
    console.error(
      `FlowForger engine: expression function registry is empty — the function modules in expr/functions/ were never loaded ` +
      `(likely stripped by bundler tree-shaking; see "sideEffects" in @flowforger/engine's package.json). ` +
      `All expressions will fall back to their raw text.`
    );
  }
  const node = tryParseExpression(e);
  if (!node) return { ok: false, reason: 'parse-error' };
  const unknown = hasUnknownFunction(node);
  if (unknown) return { ok: false, reason: `unknown-function:${unknown}`, error: unknownFunctionError(unknown) };
  try {
    return { ok: true, value: evaluateNode(node, ctx) };
  } catch (err) {
    return { ok: false, reason: `eval-error: ${err instanceof Error ? err.message : String(err)}`, error: err };
  }
}

function evaluateTemplate(e: string, ctx: RunContext): TryResult {
  // `@@{` is an escaped `@{`: evaluate the pieces around it and join them with a literal '@{'.
  const pieces = e.split('@@{');
  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    if (i > 0) out += '@{';
    const r = pieces[i].includes('@{') ? evaluateTemplatePiece(pieces[i], ctx) : { ok: true as const, value: pieces[i] };
    if (!r.ok) return r;
    out += r.value;
  }
  return { ok: true, value: out };
}

/** Interpolation always yields text (null → '', true → 'True'). */
function evaluateTemplatePiece(e: string, ctx: RunContext): TryResult {
  const parts = parseTemplate(e);
  for (const part of parts) {
    if (part.kind !== 'expr') continue;
    const unknown = hasUnknownFunction(part.node);
    if (unknown) return { ok: false, reason: `unknown-function:${unknown}`, error: unknownFunctionError(unknown) };
  }
  let out = '';
  for (const part of parts) {
    if (part.kind === 'text') {
      out += part.text;
      continue;
    }
    try {
      out += toText(evaluateNode(part.node, ctx));
    } catch (err) {
      return { ok: false, reason: `eval-error: ${err instanceof Error ? err.message : String(err)}`, error: err };
    }
  }
  return { ok: true, value: out };
}

/**
 * Legacy-compatible evaluation entry: expressions, whole-string @{...},
 * mixed templates, and bare literals. ok:false means "not handled — fall back".
 */
export function tryEvaluate(expression: string, ctx: RunContext): TryResult {
  const e = String(expression).trim();
  if (!e) return { ok: false, reason: 'empty' };
  // A leading '@@' escapes the '@': the rest is literal text.
  if (e.startsWith('@@')) return { ok: true, value: e.slice(1) };

  if (e.startsWith('@{')) {
    return evaluateTemplate(e, ctx);
  }
  if (e.startsWith('@')) {
    return evaluateExpressionString(e, ctx);
  }
  // No leading '@': mixed template, bare call (legacy accepts calls without '@'),
  // or a literal. Mirrors evaluateParams' dispatch.
  if (e.includes('@{')) {
    return evaluateTemplate(e, ctx);
  }
  return evaluateExpressionString(e, ctx);
}
