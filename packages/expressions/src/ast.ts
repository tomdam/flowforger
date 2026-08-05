/**
 * AST for the Logic Apps / Power Automate expression language.
 *
 * The grammar is tiny and operator-free: everything is a function call,
 * a literal, or a property path hanging off a call.
 *
 * Source-fidelity fields (`quote` on strings, `raw` on numbers, `at` on
 * literals written as @-prefixed expressions like @0 / @'text') exist for
 * consumers that re-emit source text (the DSL generator) — evaluating
 * consumers (the engine) can ignore them.
 */

export type PathSeg =
  | { kind: 'prop'; name: string; optional: boolean }
  | { kind: 'index'; expr: ExprNode; optional: boolean };

export type ExprNode =
  | { kind: 'str'; value: string; quote: "'" | '"'; at?: true }
  | { kind: 'num'; value: number; raw: string; at?: true }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'undefined' }
  | { kind: 'ident'; name: string }
  | { kind: 'call'; name: string; args: ExprNode[]; path: PathSeg[] };

export type TemplatePart =
  | { kind: 'text'; text: string }
  | { kind: 'expr'; node: ExprNode; raw: string; start: number };
// `start` = offset of the part's opening '@{' in the template input —
// lets diagnostics point at the exact segment.

/** Yields every call name in the tree (incl. nested args and index exprs). */
export function* walkCalls(node: ExprNode): Generator<string> {
  if (node.kind !== 'call') return;
  yield node.name;
  for (const a of node.args) yield* walkCalls(a);
  for (const seg of node.path) {
    if (seg.kind === 'index') yield* walkCalls(seg.expr);
  }
}
