/**
 * Expression validation — walks any value tree (IR nodes, Logic Apps
 * definition), finds strings that are expressions (`@...`) or templates
 * (`...@{...}...`), and reports:
 *   - EXPR_SYNTAX (error): the string does not parse against the shared grammar
 *   - EXPR_UNKNOWN_FUNCTION (warning): a call references a function that is
 *     neither engine-implemented nor a documented cloud function
 *
 * Object keys are never checked (Dataverse payloads legitimately use keys
 * like '@odata.type'). '@@' escapes and plain strings are ignored — the
 * discovery rule mirrors the engine's evaluateParams dispatch.
 */

import {
  tryParseExpression,
  parseTemplateStrict,
  walkCalls,
  KNOWN_FUNCTIONS,
  type ExprNode,
} from '@flowforger/expressions';
import type { ValidationIssue } from './index.js';

const MAX_EXPR_IN_MESSAGE = 120;

function truncate(s: string): string {
  return s.length > MAX_EXPR_IN_MESSAGE ? s.slice(0, MAX_EXPR_IN_MESSAGE) + '…' : s;
}

export function collectExpressionIssues(value: unknown, basePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walk(value, basePath, issues);
  return issues;
}

function walk(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value === 'string') {
    checkString(value, path, issues);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, issues));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      walk(v, `${path}.${k}`, issues);
    }
  }
}

function checkString(s: string, path: string, issues: ValidationIssue[]): void {
  const trimmed = s.trim();

  // Full expression: starts with '@' (but not the '@{' template form and not
  // the '@@' literal escape).
  if (trimmed.startsWith('@') && !trimmed.startsWith('@{') && !trimmed.startsWith('@@')) {
    const node = tryParseExpression(trimmed);
    if (!node) {
      issues.push({
        level: 'error',
        code: 'EXPR_SYNTAX',
        message: `Invalid expression: ${truncate(trimmed)}`,
        path,
      });
      return;
    }
    reportUnknownFunctions(node, path, issues);
    return;
  }

  // Template string with embedded @{...} segments.
  if (s.includes('@{')) {
    const parts = parseTemplateStrict(s);
    if (!parts) {
      issues.push({
        level: 'error',
        code: 'EXPR_SYNTAX',
        message: `Invalid expression inside @{...} template: ${truncate(s)}`,
        path,
      });
      return;
    }
    for (const part of parts) {
      if (part.kind === 'expr') reportUnknownFunctions(part.node, path, issues);
    }
  }
}

function reportUnknownFunctions(node: ExprNode, path: string, issues: ValidationIssue[]): void {
  const seen = new Set<string>();
  for (const name of walkCalls(node)) {
    const lower = name.toLowerCase();
    if (!KNOWN_FUNCTIONS.has(lower) && !seen.has(lower)) {
      seen.add(lower);
      issues.push({
        level: 'warning',
        code: 'EXPR_UNKNOWN_FUNCTION',
        message: `Unknown expression function '${name}' — not implemented by the local engine and not a documented cloud function`,
        path,
      });
    }
  }
}
