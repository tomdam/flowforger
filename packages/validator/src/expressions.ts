/**
 * Expression validation — walks any value tree (IR nodes, Logic Apps
 * definition), finds strings that are expressions (`@...`) or templates
 * (`...@{...}...`), and reports:
 *   - EXPR_SYNTAX (error): the string does not parse against the shared grammar
 *   - EXPR_UNKNOWN_FUNCTION (warning): a call references a function that is
 *     neither engine-implemented nor a documented cloud function (the cloud
 *     saves it and fails at run time)
 *   - EXPR_ARG_COUNT / EXPR_ARG_TYPE (error): body(), variables(), items(), ...
 *     without a name or with a non-text literal name, and EXPR_SYNTAX for a
 *     double-quoted string: what the cloud refuses to save beyond the grammar
 *     (`expressionSaveErrors`, measured by conformance/save-rules/expressions)
 *   - EXPR_ARG_COUNT (warning): any other call with a number of arguments the
 *     function does not take; the cloud saves it and fails it at run time
 *     (`expressionRuntimeErrors`, conformance/flows/expr-errors.ff.ts)
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
  expressionSaveErrors,
  expressionRuntimeErrors,
  type ExprNode,
} from '@flowforger/expressions';
import type { ValidationIssue } from './index.js';

const MAX_EXPR_IN_MESSAGE = 120;

function truncate(s: string): string {
  return s.length > MAX_EXPR_IN_MESSAGE ? s.slice(0, MAX_EXPR_IN_MESSAGE) + '…' : s;
}

/**
 * Check every expression in `value`: a Logic Apps `definition` or an IR `nodes` array.
 *
 * The `description` of the definition, a trigger or an action is a note, not an expression: the
 * cloud saves "@word", "@{" and invalid syntax there as is (conformance/save-rules/descriptions.mjs),
 * so it is skipped. A `description` anywhere else (inside inputs, a JSON schema) is still checked.
 */
export function collectExpressionIssues(value: unknown, basePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walk(value, basePath, issues, Array.isArray(value) ? 'list' : 'node');
  return issues;
}

/**
 * Where a value sits in the definition tree: a trigger/action/definition (`node`), a Logic Apps
 * name → node map (`map`), an IR node array (`list`), an else/default/case body holding `actions`
 * (`branch`), a Logic Apps case map (`casemap`) or IR case array (`caselist`), or anything else.
 */
type Role = 'node' | 'map' | 'list' | 'branch' | 'casemap' | 'caselist' | 'other';

function childRole(role: Role, key: string, child: unknown): Role {
  const isArray = Array.isArray(child);
  const isObject = !!child && typeof child === 'object' && !isArray;
  switch (role) {
    case 'map':
      return 'node';
    case 'casemap':
      return 'branch';
    case 'node':
      if ((key === 'actions' || key === 'triggers') && isObject) return 'map';
      if ((key === 'actions' || key === 'elseActions' || key === 'defaultActions') && isArray) return 'list';
      if ((key === 'else' || key === 'default') && isObject) return 'branch';
      if (key === 'cases') return isArray ? 'caselist' : isObject ? 'casemap' : 'other';
      return 'other';
    case 'branch':
      if (key === 'actions') return isArray ? 'list' : isObject ? 'map' : 'other';
      return 'other';
    default:
      return 'other';
  }
}

function walk(value: unknown, path: string, issues: ValidationIssue[], role: Role = 'other'): void {
  if (typeof value === 'string') {
    checkString(value, path, issues);
    return;
  }
  if (Array.isArray(value)) {
    const itemRole: Role = role === 'list' ? 'node' : role === 'caselist' ? 'branch' : 'other';
    value.forEach((v, i) => walk(v, `${path}[${i}]`, issues, itemRole));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (role === 'node' && k === 'description') continue;
      walk(v, `${path}.${k}`, issues, childRole(role, k, v));
    }
  }
}

function checkString(s: string, path: string, issues: ValidationIssue[]): void {
  const trimmed = s.trim();

  // Full expression: starts with '@' (but not the '@{' template form and not
  // the '@@' literal escape).
  // A lone '@' is saved as text (conformance/save-rules/expressions: syntax-at-alone).
  if (trimmed.startsWith('@') && !trimmed.startsWith('@{') && !trimmed.startsWith('@@') && trimmed !== '@') {
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
    reportSaveErrors(node, trimmed, path, issues);
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
      if (part.kind !== 'expr') continue;
      reportUnknownFunctions(part.node, path, issues);
      reportSaveErrors(part.node, s, path, issues);
    }
  }
}

/** What the cloud refuses to save beyond the grammar: unnamed references, double quotes. */
function reportSaveErrors(node: ExprNode, text: string, path: string, issues: ValidationIssue[]): void {
  for (const e of expressionSaveErrors(node)) {
    const message =
      e.code === 'EXPR_SYNTAX' ? `Invalid expression: ${e.message}: ${truncate(text)}` : `${e.message} (${truncate(text)})`;
    issues.push({ level: 'error', code: e.code, message, path });
  }
  // Saved by the cloud, but the call fails whenever it is evaluated.
  for (const e of expressionRuntimeErrors(node)) {
    issues.push({ level: 'warning', code: e.code, message: `${e.message} The flow saves, but this fails when it runs (${truncate(text)})`, path });
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
