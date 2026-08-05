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
import { walkCalls, tryParseExpression, parseTemplate } from '@flowforger/expressions';

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
      const f: FnContext = { ctx, ev: n => evaluateNode(n, ctx) };
      const result = fn(node.args, f);
      return navigateSegments(result, node.path, ctx);
    }
  }
}

export function navigateSegments(value: any, path: PathSeg[], ctx: RunContext): any {
  let val = value;
  for (const seg of path) {
    if (seg.kind === 'prop') {
      val = val?.[seg.name];
      continue;
    }
    const key = evaluateNode(seg.expr, ctx);
    if (typeof key === 'string' && key.includes('/')) {
      // Power Automate convention: ['body/value'] navigates nested properties.
      for (const part of key.split('/')) {
        val = val?.[part];
        if (val === undefined || val === null) break;
      }
    } else {
      val = val?.[key as any];
    }
  }
  return val;
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

/** @{...} whole-string stringification rule (legacy lines: null/undefined pass through). */
function stringifyWhole(v: any): any {
  if (v === null || v === undefined) return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Template-part stringification rule (legacy evaluateTemplateString: null/undefined → ''). */
function stringifyPart(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
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
  if (unknown) return { ok: false, reason: `unknown-function:${unknown}` };
  try {
    return { ok: true, value: evaluateNode(node, ctx) };
  } catch (err) {
    return { ok: false, reason: `eval-error: ${err instanceof Error ? err.message : String(err)}`, error: err };
  }
}

function evaluateTemplate(e: string, ctx: RunContext): TryResult {
  // An expr part referencing an unknown function degrades to '@' + raw text
  // (the legacy evaluateTemplateString shape), never fails the whole template.
  const parts = parseTemplate(e).map(part => {
    if (part.kind === 'expr' && hasUnknownFunction(part.node)) {
      console.warn(`Failed to evaluate template expression: @{${part.raw}} (unknown function)`);
      return { kind: 'text' as const, text: '@' + part.raw };
    }
    return part;
  });

  // Whole-string single expression: @{expr} → stringified value (may be
  // null/undefined). A throw here propagates like legacy's inline @{...}.
  if (parts.length === 1 && parts[0].kind === 'expr') {
    try {
      return { ok: true, value: stringifyWhole(evaluateNode(parts[0].node, ctx)) };
    } catch (err) {
      return { ok: false, reason: `eval-error: ${err instanceof Error ? err.message : String(err)}`, error: err };
    }
  }

  let out = '';
  for (const part of parts) {
    if (part.kind === 'text') {
      out += part.text;
      continue;
    }
    try {
      out += stringifyPart(evaluateNode(part.node, ctx));
    } catch (error) {
      // Legacy shape: a failing segment degrades to '@' + inner text with a warning.
      console.warn(`Failed to evaluate template expression: @{${part.raw}}`, error);
      out += '@' + part.raw;
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
