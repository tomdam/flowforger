import type { RunContext } from './index.js';
import { tryEvaluate } from './expr/evaluator.js';
import './expr/functions/index.js';

/**
 * Navigate through an object using a path that may contain dot notation and bracket notation
 * Examples: .body.name, ['body/name'], .body['field'], ?['optional/field']
 * Note: ['body/name'] is treated as nested path ['body']['name']
 */
export function navigatePath(obj: any, pathExpr: string): any {
  if (!pathExpr) return obj;

  let val = obj;
  let remaining = pathExpr;

  // Handle optional chaining operator ?
  const isOptional = remaining.startsWith('?');
  if (isOptional) {
    remaining = remaining.substring(1);
  }

  // Parse the path expression
  while (remaining.length > 0) {
    // Handle bracket notation with quotes ['key'] or ["key"]
    const bracketMatch = remaining.match(/^\[['"]([^'"]+)['"]\](.*)/);
    if (bracketMatch) {
      const key = bracketMatch[1];
      // If key contains slashes, treat as nested path (Power Automate convention)
      if (key.includes('/')) {
        const parts = key.split('/');
        for (const part of parts) {
          val = val?.[part];
          if (val === undefined || val === null) break;
        }
      } else {
        val = val?.[key];
      }
      remaining = bracketMatch[2];
      continue;
    }

    // Handle bracket notation with numeric index [0], [1], etc.
    const numericBracketMatch = remaining.match(/^\[(\d+)\](.*)/);
    if (numericBracketMatch) {
      const index = parseInt(numericBracketMatch[1], 10);
      val = val?.[index];
      remaining = numericBracketMatch[2];
      continue;
    }

    // Handle optional chaining mid-path ?['key'] or ?.key
    if (remaining.startsWith('?')) {
      remaining = remaining.substring(1); // strip the ?, let next handler pick it up
      continue;
    }

    // Handle dot followed by bracket notation .['key'] or .["key"]
    if (remaining.startsWith('.[')) {
      remaining = remaining.substring(1); // strip the dot, let bracket handler pick it up
      continue;
    }

    // Handle dot notation .key
    const dotMatch = remaining.match(/^\.([A-Za-z_][\w]*)(.*)/);
    if (dotMatch) {
      const key = dotMatch[1];
      val = val?.[key];
      remaining = dotMatch[2];
      continue;
    }

    // If we can't parse, break
    break;
  }

  return val;
}

/**
 * Main expression evaluator — parses the expression to an AST and evaluates
 * it against the function registry (see ./expr/). Handles full expressions
 * (@fn(...)), whole-string @{...} interpolation, mixed templates, and bare
 * literals.
 *
 * Legacy-compatible fallback: an expression that cannot be parsed or that
 * references an unknown function is returned verbatim (trimmed) rather than
 * throwing. Errors thrown BY expression functions (e.g. addProperty on a
 * duplicate key, json() on invalid input) propagate to the caller.
 */
export function evalExpression(expression: string, ctx: RunContext): any {
  if (!expression) return undefined;
  const attempt = tryEvaluate(String(expression), ctx);
  if (attempt.ok) return attempt.value;
  if (attempt.error !== undefined) throw attempt.error;
  return String(expression).trim();
}

/**
 * Recursively evaluate expressions in parameter values
 */
export function evaluateParams(params: any, ctx: RunContext): any {
  if (params === null || params === undefined) return params;

  // If it's a string, check for expressions
  if (typeof params === 'string') {
    const trimmed = params.trim();

    // If it starts with @ (but not @{), evaluate as full expression
    if (trimmed.startsWith('@') && !trimmed.startsWith('@{')) {
      return evalExpression(params, ctx);
    }

    // If it contains @{...} template expressions, evaluate those
    if (params.includes('@{')) {
      const r = tryEvaluate(params, ctx);
      if (r.ok) return r.value;
      if (r.error !== undefined) throw r.error;
      return params;
    }

    // Otherwise return as-is
    return params;
  }

  // If it's an array, evaluate each element
  if (Array.isArray(params)) {
    return params.map(item => evaluateParams(item, ctx));
  }

  // If it's an object, evaluate each property
  if (typeof params === 'object') {
    const result: any = {};
    for (const key in params) {
      result[key] = evaluateParams(params[key], ctx);
    }
    return result;
  }

  // For other types (numbers, booleans, etc.), return as-is
  return params;
}
