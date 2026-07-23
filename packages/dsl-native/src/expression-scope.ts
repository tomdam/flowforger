/**
 * Expression Scope Builder
 *
 * Derives the identifier bindings needed to evaluate DSL (TypeScript)
 * expressions in a debug console: flow variables and foreach loop variables.
 * Used by the VS Code extension's debug runner to translate console/watch
 * input via transformExpression before engine evaluation.
 */

import { Project, SyntaxKind, ScriptTarget } from 'ts-morph';
import type { FlowIR } from '@flowforger/ir';
import type { DslSourceMap } from './source-map-builder.js';
import { collectAllNodes, sanitizeVarName } from './source-map-builder.js';
import { transformExpression, createTransformContext } from './transformer/expression-transformer.js';

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

/**
 * Translate a DSL (TypeScript) expression typed into a debug console into a
 * Power Automate expression string, using the compiler's expression transformer.
 * Throws if the input is not a parseable TypeScript expression.
 */
export function dslExpressionToPA(expression: string, scope: ExpressionScope): string {
  if (!expression.trim()) {
    throw new Error('Empty expression');
  }
  if (!evalProject) {
    evalProject = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { target: ScriptTarget.ES2022 },
    });
  }
  const existing = evalProject.getSourceFile('__eval__.ts');
  if (existing) existing.delete();

  const sf = evalProject.createSourceFile('__eval__.ts', `const __expr = (${expression});`);
  // Syntax errors don't always prevent parsing — TS error-recovers garbage like
  // `%%%` into a partial AST. parseDiagnostics catches those cheaply (no type check).
  const parseDiagnostics = (sf.compilerNode as any).parseDiagnostics as unknown[] | undefined;
  if (parseDiagnostics && parseDiagnostics.length > 0) {
    throw new Error(`Not a valid DSL expression: ${expression}`);
  }
  const decl = sf.getVariableDeclaration('__expr');
  const paren = decl?.getInitializer()?.asKind(SyntaxKind.ParenthesizedExpression);
  const expr = paren?.getExpression();
  // Parse failures surface as a missing/partial initializer or extra statements
  // (e.g. `for (` never closes the parenthesized wrapper).
  if (!expr || sf.getStatements().length !== 1) {
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
    // The token may be the sanitized DSL identifier or the original PA
    // variable name (what appears inside ctx.variables('...')).
    const original =
      scope.variables.get(name) ??
      ([...scope.variables.values()].includes(name) ? name : undefined);
    if (original !== undefined) {
      if (!hadQuotes) return null;
      try {
        const value = evalFn(`@variables('${original}')`, ctx);
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
