/**
 * What the cloud checks in a parsed expression when a flow is saved, beyond the grammar
 * (measured by conformance/save-rules/expressions.mjs). Little is: unknown functions, argument
 * counts and literal argument types are all saved and only fail when the action runs, except
 * - the functions that name an action, loop or variable (the cloud reads them to work out what
 *   an action depends on) must have that name: `body()` fails "must have at least one
 *   parameter", `body(1)` fails "The provided parameters ... are not valid";
 * - string literals must use single quotes: `concat("a")` fails.
 */
import type { ExprNode } from './ast.js';
import { FUNCTION_ARITY } from './arity.js';

export interface ExpressionSaveError {
  code: 'EXPR_ARG_COUNT' | 'EXPR_ARG_TYPE' | 'EXPR_SYNTAX';
  message: string;
  /** The function the error is about (EXPR_ARG_COUNT / EXPR_ARG_TYPE). */
  name?: string;
}

/** Functions whose first argument names an action, loop or variable (lowercase). */
const NAMED_REFERENCE_FUNCTIONS = new Set(['variables', 'body', 'actionbody', 'outputs', 'actionoutputs', 'actions', 'items', 'result']);

/** The errors the cloud would refuse to save this expression for, in source order. */
export function expressionSaveErrors(node: ExprNode): ExpressionSaveError[] {
  const errors: ExpressionSaveError[] = [];
  visit(node, errors);
  return errors;
}

/**
 * The cloud's run-time message for a call with a number of arguments the function does not take
 * (conformance/flows/expr-errors.ff.ts); undefined when the count is fine or not measured.
 */
export function argumentCountMessage(name: string, count: number): string | undefined {
  const entry = FUNCTION_ARITY[name.toLowerCase()];
  if (!entry) return undefined;
  const [min, max, message] = entry;
  if (count >= min && count <= max) return undefined;
  return message.replace('{name}', name).replace('{count}', String(count));
}

export interface ExpressionRuntimeError {
  code: 'EXPR_ARG_COUNT';
  name: string;
  message: string;
}

/**
 * Calls the cloud saves but fails whenever it evaluates them: a wrong number of arguments.
 * A named reference without its name is left out: that one is a save error.
 */
export function expressionRuntimeErrors(node: ExprNode): ExpressionRuntimeError[] {
  const errors: ExpressionRuntimeError[] = [];
  const walk = (n: ExprNode): void => {
    if (n.kind !== 'call') return;
    const lower = n.name.toLowerCase();
    const message = argumentCountMessage(n.name, n.args.length);
    if (message && !(n.args.length === 0 && NAMED_REFERENCE_FUNCTIONS.has(lower))) {
      errors.push({ code: 'EXPR_ARG_COUNT', name: n.name, message });
    }
    for (const arg of n.args) walk(arg);
    for (const seg of n.path) if (seg.kind === 'index') walk(seg.expr);
  };
  walk(node);
  return errors;
}

function visit(node: ExprNode, errors: ExpressionSaveError[]): void {
  if (node.kind === 'str' && node.quote === '"') {
    errors.push({
      code: 'EXPR_SYNTAX',
      message: `the string "${node.value}" is in double quotes; expression strings must be in single quotes`,
    });
    return;
  }
  if (node.kind !== 'call') return;
  if (NAMED_REFERENCE_FUNCTIONS.has(node.name.toLowerCase())) {
    const first = node.args[0];
    if (!first) {
      errors.push({ code: 'EXPR_ARG_COUNT', name: node.name, message: `The template language function '${node.name}' must have at least one parameter.` });
    } else if (first.kind === 'num' || first.kind === 'bool' || first.kind === 'null') {
      errors.push({ code: 'EXPR_ARG_TYPE', name: node.name, message: `The provided parameters for template language function '${node.name}' are not valid.` });
    }
  }
  for (const arg of node.args) visit(arg, errors);
  for (const seg of node.path) if (seg.kind === 'index') visit(seg.expr, errors);
}
