/**
 * Expression Scope Builder
 *
 * Derives the identifier bindings needed to evaluate DSL (TypeScript)
 * expressions in a debug console: flow variables and foreach loop variables.
 * Used by the VS Code extension's debug runner to translate console/watch
 * input via transformExpression before engine evaluation.
 */

import { Project, ScriptTarget, SyntaxKind, type Expression } from 'ts-morph';
import type { FlowIR, Node } from '@flowforger/ir';
import type { DslSourceMap } from './source-map-builder.js';
import { collectAllNodes, sanitizeVarName } from './source-map-builder.js';
import { transformExpression, createTransformContext } from './transformer/expression-transformer.js';
import { transformCode } from './transformer/index.js';

export interface ExpressionScope {
  /** Sanitized DSL identifier -> original PA variable name */
  variables: Map<string, string>;
  /** Loop variable identifier -> foreach action name */
  loopVariables: Map<string, string>;
}

const FOR_OF_RE = /for\s+(?:await\s+)?\(\s*(?:const|let|var)\s+([\p{L}_$][\p{L}\p{N}_$]*)\s+of/u;

/** How many lines below a foreach's mapped start line to scan for its `for (... of ...)` header. */
const FOR_HEADER_SCAN_LINES = 3;

export function buildExpressionScope(
  dslCode: string,
  ir: FlowIR,
  sourceMap: DslSourceMap,
): ExpressionScope {
  const variables = new Map<string, string>();
  const loopVariables = new Map<string, string>();
  const lines = dslCode.split('\n');

  for (const node of collectAllNodes(ir.nodes)) {
    if (node.type === 'action' && (node as any).kind === 'initializevariable') {
      const original = (node as any).inputs?.variableName || (node as any).inputs?.name;
      if (typeof original === 'string' && original) {
        variables.set(sanitizeVarName(original), original);
      }
    }

    if (node.type === 'foreach') {
      const entry = sourceMap.nodeIdToLines.get(node.id);
      if (!entry) continue;
      // The mapped range may start at a preceding JSDoc; scan a few lines for the for-of header.
      const from = entry.startLine - 1;
      const to = Math.min(from + FOR_HEADER_SCAN_LINES, entry.endLine - 1, lines.length - 1);
      for (let i = from; i <= to; i++) {
        const m = lines[i].match(FOR_OF_RE);
        if (m) {
          loopVariables.set(m[1], node.name);
          break;
        }
      }
    }
  }

  return { variables, loopVariables };
}

// Reused across calls — creating a ts-morph Project is expensive.
let evalProject: Project | null = null;

function getEvalProject(): Project {
  if (!evalProject) {
    evalProject = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { target: ScriptTarget.ES2022 },
    });
  }
  return evalProject;
}

/**
 * Parse input as a standalone expression via `const __expr = (input);`.
 * Returns the expression node, or null if it does not parse cleanly.
 */
function parseAsExpression(input: string): Expression | null {
  const project = getEvalProject();
  const existing = project.getSourceFile('__eval__.ts');
  if (existing) existing.delete();
  const sf = project.createSourceFile('__eval__.ts', `const __expr = (${input});`);
  // Syntax errors don't always prevent parsing — TS error-recovers garbage like
  // `%%%` into a partial AST. parseDiagnostics catches those cheaply (no type check).
  const parseDiagnostics = (sf.compilerNode as any).parseDiagnostics as unknown[] | undefined;
  if (parseDiagnostics && parseDiagnostics.length > 0) return null;
  const decl = sf.getVariableDeclaration('__expr');
  const paren = decl?.getInitializer()?.asKind(SyntaxKind.ParenthesizedExpression);
  const expr = paren?.getExpression();
  // Parse failures surface as a missing/partial initializer or extra statements
  // (e.g. `for (` never closes the parenthesized wrapper).
  if (!expr || sf.getStatements().length !== 1) return null;
  return expr;
}

/**
 * Translate a DSL (TypeScript) expression typed into a debug console into a
 * Power Automate expression string, using the compiler's expression transformer.
 * Throws if the input is not a parseable TypeScript expression.
 */
export function dslExpressionToPA(expression: string, scope: ExpressionScope): string {
  if (!expression.trim()) {
    throw new Error('Empty expression');
  }

  const expr = parseAsExpression(expression);
  if (!expr) {
    throw new Error(`Not a valid DSL expression: ${expression}`);
  }

  const tctx = createTransformContext();
  tctx.trackedVariables = new Set(scope.variables.keys());
  tctx.variableOriginalNames = new Map(scope.variables);
  tctx.loopVariables = new Map(scope.loopVariables);

  let pa = transformExpression(expr, tctx, true);

  // transformIdentifier emits variables('<sanitized>'); rewrite to the original
  // PA variable name where they differ (names with spaces etc.).
  for (const [sanitized, original] of scope.variables) {
    if (sanitized !== original) {
      pa = pa.split(`variables('${sanitized}')`).join(`variables('${original}')`);
    }
  }

  if (!pa.startsWith('@')) pa = '@' + pa;
  return pa;
}

/**
 * Statement-intent inputs must not silently fall back to the expression path:
 * assignments and awaited calls are things the user wants EXECUTED, so their
 * transform errors should surface rather than be shadowed by a secondary
 * "not a valid expression" error.
 */
function isStatementIntent(expr: Expression): boolean {
  if (expr.getKind() === SyntaxKind.AwaitExpression) return true;
  const bin = expr.asKind(SyntaxKind.BinaryExpression);
  return !!bin && bin.getOperatorToken().getKind() === SyntaxKind.EqualsToken;
}

/**
 * Resolve a typed variable name against the scope the way Power Automate
 * does: variable names are case-insensitive. Matches the sanitized DSL
 * identifier or the original PA name, preferring exact matches.
 */
function resolveScopeVariable(
  scope: ExpressionScope | null,
  name: string,
): { sanitized: string; original: string } | null {
  if (!scope) return null;
  const exact = scope.variables.get(name);
  if (exact !== undefined) return { sanitized: name, original: exact };
  for (const [sanitized, original] of scope.variables) {
    if (original === name) return { sanitized, original };
  }
  const lower = name.toLowerCase();
  for (const [sanitized, original] of scope.variables) {
    if (sanitized.toLowerCase() === lower || original.toLowerCase() === lower) {
      return { sanitized, original };
    }
  }
  return null;
}

/**
 * Normalize a plain-identifier assignment for the wrapper flow:
 * - a name that resolves to a session variable (case-insensitively, per PA
 *   semantics) is rewritten to its sanitized identifier so the transformer
 *   emits SetVariable for the EXISTING variable instead of initializing a
 *   case-variant duplicate the flow's own expressions would never read;
 * - a truly unknown name is promoted to `let` so Initialize is emitted.
 */
function normalizeAssignment(statement: string, scope: ExpressionScope | null): string {
  const expr = parseAsExpression(statement);
  const bin = expr?.asKind(SyntaxKind.BinaryExpression);
  if (!bin || bin.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) return statement;
  const left = bin.getLeft().asKind(SyntaxKind.Identifier);
  if (!left) return statement;
  const name = left.getText();
  if (scope?.variables.has(name) || scope?.loopVariables.has(name)) return statement;
  const resolved = resolveScopeVariable(scope, name);
  if (resolved) {
    // The identifier is the first token of the (trimmed) statement; splice in
    // the canonical sanitized identifier.
    return statement.startsWith(name)
      ? resolved.sanitized + statement.slice(name.length)
      : statement;
  }
  return `let ${statement}`;
}

/**
 * Transform a single DSL statement typed into a debug console into executable
 * IR nodes, using the real DSL compiler on a synthetic wrapper flow. Returns
 * null when the input is a pure expression (caller falls back to
 * evaluateDebugInput). Throws for statement-intent input that fails to
 * transform. Shared by the web debug console (and later the VS Code adapter).
 */
export function dslStatementToNodes(
  input: string,
  scope: ExpressionScope | null,
  takenActionNames: Set<string> = new Set(),
): { nodes: Node[] } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const statement = normalizeAssignment(trimmed, scope);
  const declaredIdentifiers = scope ? [...scope.variables.keys()] : [];
  const decls = declaredIdentifiers.map((v) => `    let ${v}: any = null;`).join('\n');

  const wrapper = `@Flow('__console__')
class __Console__ {
  @ManualTrigger()
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
${decls}
    ${statement}
  }
}
`;

  let ir: FlowIR;
  try {
    ir = transformCode(wrapper, '__console__.ts');
  } catch (err) {
    // Expression-looking input is owned by the expression path; statement-intent
    // input surfaces its transform error.
    const asExpr = parseAsExpression(trimmed);
    if (asExpr && !isStatementIntent(asExpr)) return null;
    throw new Error(
      `Could not transform statement: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Drop the trigger, then the Initialize nodes emitted by our pre-declarations.
  const declared = new Set(declaredIdentifiers);
  let nodes = ir.nodes.slice(1);
  let skip = 0;
  while (skip < nodes.length) {
    const n = nodes[skip] as any;
    if (n.type === 'action' && n.kind === 'initializevariable' && declared.has(n.inputs?.variableName)) {
      skip++;
    } else {
      break;
    }
  }
  nodes = nodes.slice(skip);
  if (nodes.length === 0) {
    // transformCode error-recovers unparseable garbage (e.g. `%%%`), and also
    // silently drops calls it doesn't recognize (e.g. an awaited call to a
    // nonexistent ctx method), into an otherwise-empty flow rather than
    // throwing. So an empty result here is ambiguous: a legitimate no-op
    // expression statement (`counter`, `counter > 3`, an un-awaited
    // `ctx.outputs(...)` call) vs statement-intent input (await / assignment)
    // that produced nothing, vs input that isn't valid syntax at all. Mirror
    // the catch block below: only a non-statement-intent expression reads as
    // "treat as expression" — everything else must surface as an error.
    const asExpr = parseAsExpression(trimmed);
    if (asExpr && !isStatementIntent(asExpr)) return null;
    throw new Error(`Could not transform statement: ${trimmed}`);
  }

  // Rewrite sanitized identifiers back to original PA variable names, both in
  // expression strings and in variable-targeting input fields.
  const rewrites = scope ? [...scope.variables].filter(([s, o]) => s !== o) : [];
  if (rewrites.length > 0) {
    nodes = nodes.map((node) => {
      let json = JSON.stringify(node);
      for (const [sanitized, original] of rewrites) {
        json = json.split(`variables('${sanitized}')`).join(`variables('${original}')`);
      }
      const parsed = JSON.parse(json) as Node;
      const inputs = (parsed as any).inputs;
      if (inputs) {
        for (const [sanitized, original] of rewrites) {
          if (inputs.name === sanitized) inputs.name = original;
          if (inputs.variableName === sanitized) inputs.variableName = original;
        }
      }
      return parsed;
    });
  }

  // Never let an ad-hoc action overwrite a recorded flow action's output.
  const used = new Set(takenActionNames);
  for (const node of nodes) {
    const base = node.name;
    let name = base;
    let i = 2;
    while (used.has(name)) name = `${base}_${i++}`;
    node.name = name;
    used.add(name);
  }

  return { nodes };
}

export interface DebugEvalOutcome {
  result: string;
  value?: any;
  error?: string;
}

/** The subset of the engine RunContext the dispatch needs; the full context is passed through to evalFn. */
export interface DebugEvalContext {
  actions: Map<string, { status: string; outputs?: any; error?: any }>;
}

function formatEvalResult(value: any): string {
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

/**
 * Resolve a hover/watch token that names a variable or an executed action.
 * Handles the quote debris editors produce ('AllTasks, 'highPriority).
 * Flow/loop variables take precedence over actions:
 * - quoted variable name -> resolved here (the DSL path can't parse quotes)
 * - bare variable name -> null, the DSL path resolves it as usual
 * - action name (quoted or bare) -> the action's recorded output
 */
function tryResolveNameToken(
  input: string,
  scope: ExpressionScope | null,
  ctx: DebugEvalContext,
  evalFn: (expr: string, ctx: any) => any,
): DebugEvalOutcome | null {
  const trimmed = input.trim();
  const name = trimmed.replace(/^['"]/, '').replace(/['"]$/, '').trim();
  if (!name) return null;
  const hadQuotes = name !== trimmed;

  if (scope) {
    // The token may be the sanitized DSL identifier, the original PA variable
    // name, or a case-variant of either (PA variable names are
    // case-insensitive).
    const resolved = resolveScopeVariable(scope, name);
    if (resolved) {
      // A bare exact sanitized identifier is left for the DSL path (which
      // yields the same variables() lookup); quoted tokens and case/name
      // variants must resolve here — the DSL path only knows exact
      // sanitized identifiers and would mistranslate them.
      if (!hadQuotes && resolved.sanitized === name) return null;
      try {
        const value = evalFn(`@variables('${resolved.original}')`, ctx);
        return { result: formatEvalResult(value), value };
      } catch {
        return null;
      }
    }
    if (scope.loopVariables.has(name)) return null;
  }

  const entry = ctx.actions.get(name);
  if (!entry) return null;

  if (entry.outputs === undefined) {
    return { result: `(no output — status: ${entry.status})` };
  }
  return { result: formatEvalResult(entry.outputs), value: entry.outputs };
}

/**
 * Shared debug-console dispatch used by the VS Code debug adapter and the web
 * app's immediate window: name-token resolution, then DSL-to-PA translation,
 * then the raw Power Automate path. evalFn is the engine's evalExpression,
 * injected so this package does not depend on @flowforger/engine.
 */
export function evaluateDebugInput(
  input: string,
  scope: ExpressionScope | null,
  ctx: DebugEvalContext,
  evalFn: (expr: string, ctx: any) => any,
): DebugEvalOutcome {
  const trimmed = input.trim();

  if (!trimmed.startsWith('@')) {
    // Name-token path: hover/watch over an action name or a (quoted) variable
    // name shows its value/output directly.
    const resolved = tryResolveNameToken(trimmed, scope, ctx, evalFn);
    if (resolved) return resolved;

    // DSL path: on any failure fall through to the legacy PA path so existing
    // inputs keep working.
    if (scope) {
      try {
        const paExpr = dslExpressionToPA(trimmed, scope);
        const value = evalFn(paExpr, ctx);
        return { result: formatEvalResult(value), value };
      } catch {
        // fall through
      }
    }
  }

  try {
    const expr = trimmed.startsWith('@') ? trimmed : '@' + trimmed;
    const value = evalFn(expr, ctx);
    return { result: formatEvalResult(value), value };
  } catch (err: any) {
    return { result: `Error: ${err.message}`, error: err.message };
  }
}
