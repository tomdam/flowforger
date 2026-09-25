/**
 * Diagnostics Provider - detects DSL-specific errors and warnings.
 * Uses the symbol index to validate code and report issues.
 */

import ts from 'typescript';
import {
  buildSymbolIndex,
  findUnusedVariables,
  findInvalidActionReferences,
  findInvalidParameterReferences,
  findInvalidConnectionReferences,
  getAllParameterNames,
  getAllConnectionReferenceNames,
  type SymbolIndex,
} from '../analyzer/symbol-index.js';
import {
  parseSource,
  getNodeRange,
  findFlowClass,
  findActionMethod,
  findTriggerMethod,
  hasDecorator,
  getDecoratorArgument,
  type SourceRange,
} from '../analyzer/dsl-parser.js';
import { findDuplicateActions } from '../analyzer/action-finder.js';
import { findDuplicateVariables } from '../analyzer/variable-finder.js';
import { DiagnosticCodes, type DiagnosticSeverity } from '../data/diagnostic-codes.js';
import { flowContextMethods } from '../data/flow-context-methods.js';
import {
  parseExpression,
  parseTemplateWithDiagnostics,
  walkCalls,
  KNOWN_FUNCTIONS,
  ParseError,
  type ExprNode,
} from '@flowforger/expressions';
import { getPositionFromOffset } from '../analyzer/dsl-parser.js';

/**
 * A diagnostic message with location information.
 */
export interface Diagnostic {
  /** Diagnostic code (e.g., DSL001) */
  code: string;
  /** Severity level */
  severity: DiagnosticSeverity;
  /** Human-readable message */
  message: string;
  /** Location in the source */
  range: SourceRange;
  /** Source identifier */
  source: string;
}

/**
 * Options for diagnostic analysis.
 */
export interface DiagnosticsOptions {
  /** Check for missing @Flow decorator */
  checkFlowDecorator?: boolean;
  /** Check for missing trigger */
  checkTrigger?: boolean;
  /** Check for missing @Action */
  checkAction?: boolean;
  /** Check for invalid action references */
  checkActionReferences?: boolean;
  /** Check for invalid variable references */
  checkVariableReferences?: boolean;
  /** Check for invalid parameter references */
  checkParameterReferences?: boolean;
  /** Check for invalid connection reference usages */
  checkConnectionReferences?: boolean;
  /** Check for unused variables */
  checkUnusedVariables?: boolean;
  /** Check for duplicate action names */
  checkDuplicateActions?: boolean;
  /** Check for duplicate variable declarations */
  checkDuplicateVariables?: boolean;
  /** Check for variable initialization inside control structures */
  checkNestedVariableInit?: boolean;
  /** Check for missing await on action calls */
  checkMissingAwait?: boolean;
  /** Check for return/throw/try/break/continue and const variables in @Action method */
  checkActionMethodBody?: boolean;
  /** Check for multiple @Action methods in a single class */
  checkMultipleActionMethods?: boolean;
  /** Check @runAfter annotations for invalid status values and action references */
  checkRunAfterAnnotations?: boolean;
  /** Check for empty @Flow name */
  checkFlowName?: boolean;
  /** Check @type and JSON annotations (@metadata, @retryPolicy, etc.) in JSDoc */
  checkJSDocAnnotations?: boolean;
  /** Check for unrecognized ctx method calls */
  checkUnknownCtxMethods?: boolean;
  /** Check for quoted spread operator like '...varName' in array literals */
  checkQuotedSpread?: boolean;
  /** Check for self-referential array reassignment like `x = [...x, value]` */
  checkSelfRefArrayReassign?: boolean;
  /** Check Power Automate expressions inside ctx.eval(`...`) literals (DSL033, DSL034) */
  checkEvalExpressions?: boolean;
  /** Check comments (future action descriptions) for Power Automate template syntax (DSL035, DSL036) */
  checkDescriptionComments?: boolean;
  /** Check ctx.response()/ctx.terminate() placement: not inside loops (DSL037), response needs a request trigger (DSL038) */
  checkActionPlacement?: boolean;
  /** Check definition limits: name length, action/switch-case/variable counts (DSL039-DSL042) */
  checkLimits?: boolean;
  /** Check response kind vs trigger (DSL044) and @RecurrenceTrigger options (DSL045, DSL046) */
  checkTriggerOptions?: boolean;
}

const defaultOptions: DiagnosticsOptions = {
  checkFlowDecorator: true,
  checkTrigger: true,
  checkAction: true,
  checkActionReferences: true,
  checkVariableReferences: true,
  checkParameterReferences: true,
  checkConnectionReferences: true,
  checkUnusedVariables: true, // Now enabled - improved detection handles variables in expressions
  checkDuplicateActions: true,
  checkDuplicateVariables: true,
  checkNestedVariableInit: true,
  checkMissingAwait: true,
  checkActionMethodBody: true,
  checkMultipleActionMethods: true,
  checkRunAfterAnnotations: true,
  checkFlowName: true,
  checkJSDocAnnotations: true,
  checkUnknownCtxMethods: true,
  checkQuotedSpread: true,
  checkSelfRefArrayReassign: true,
  checkEvalExpressions: true,
  checkDescriptionComments: true,
  checkActionPlacement: true,
  checkLimits: true,
  checkTriggerOptions: true,
};

/**
 * Analyze source code and return diagnostics.
 */
export function getDiagnostics(
  code: string,
  options: DiagnosticsOptions = {}
): Diagnostic[] {
  const opts = { ...defaultOptions, ...options };
  const diagnostics: Diagnostic[] = [];

  // Build symbol index
  const index = buildSymbolIndex(code);
  const sourceFile = index.sourceFile;

  // Check flow structure
  if (opts.checkFlowDecorator || opts.checkTrigger || opts.checkAction) {
    diagnostics.push(...checkFlowStructure(sourceFile, index, opts));
  }

  // Check action references
  if (opts.checkActionReferences) {
    diagnostics.push(...checkActionReferences(index));
  }

  // Check variable references
  if (opts.checkVariableReferences) {
    diagnostics.push(...checkVariableReferences(sourceFile, index));
  }

  // Check parameter references
  if (opts.checkParameterReferences) {
    diagnostics.push(...checkParameterReferences(index));
  }

  // Check connection reference usages
  if (opts.checkConnectionReferences) {
    diagnostics.push(...checkConnectionReferences(index));
  }

  // Check for unused symbols
  if (opts.checkUnusedVariables) {
    diagnostics.push(...checkUnusedVariables(index));
  }

  // Check for duplicates
  if (opts.checkDuplicateActions) {
    diagnostics.push(...checkDuplicateActions(index));
  }

  // Check for duplicate variable declarations (DSL030)
  if (opts.checkDuplicateVariables) {
    diagnostics.push(...checkDuplicateVariables(code));
  }

  // Check for variable initialization inside control structures
  if (opts.checkNestedVariableInit) {
    diagnostics.push(...checkNestedVariableInitialization(sourceFile));
  }

  // Check for missing await on action calls
  if (opts.checkMissingAwait) {
    diagnostics.push(...checkMissingAwait(sourceFile));
  }

  // Check for return/throw/try/break/continue and const variables in @Action method (DSL018, DSL020, DSL025)
  if (opts.checkActionMethodBody) {
    diagnostics.push(...checkActionMethodBody(sourceFile));
  }

  // Check for multiple @Action methods (DSL019)
  if (opts.checkMultipleActionMethods) {
    diagnostics.push(...checkMultipleActionMethods(sourceFile));
  }

  // Check @runAfter annotations (DSL021, DSL022)
  if (opts.checkRunAfterAnnotations) {
    diagnostics.push(...checkRunAfterAnnotations(sourceFile, index));
  }

  // Check for empty @Flow name (DSL023)
  if (opts.checkFlowName) {
    diagnostics.push(...checkFlowName(sourceFile));
  }

  // Check @type and JSON annotations in JSDoc (DSL024, DSL027)
  if (opts.checkJSDocAnnotations) {
    diagnostics.push(...checkJSDocAnnotations(sourceFile));
  }

  // Check for unrecognized ctx method calls (DSL026)
  if (opts.checkUnknownCtxMethods) {
    diagnostics.push(...checkUnknownCtxMethods(sourceFile));
  }

  // Check Power Automate expressions inside ctx.eval literals (DSL033, DSL034)
  if (opts.checkEvalExpressions) {
    diagnostics.push(...checkEvalExpressions(sourceFile));
  }

  // Check comments for "@{...}" / leading "@" that would break the description in the cloud (DSL035, DSL036)
  if (opts.checkDescriptionComments) {
    diagnostics.push(...checkDescriptionComments(sourceFile));
  }

  // Check Response/Terminate placement: not inside loops, Response needs a request trigger (DSL037, DSL038)
  if (opts.checkActionPlacement) {
    diagnostics.push(...checkActionPlacement(sourceFile));
  }

  // Check definition limits (DSL039-DSL042)
  if (opts.checkLimits) {
    diagnostics.push(...checkLimits(sourceFile, index));
  }

  // Check response kind vs trigger and @RecurrenceTrigger options (DSL044-DSL046)
  if (opts.checkTriggerOptions) {
    diagnostics.push(...checkTriggerOptions(sourceFile));
  }

  // Check for quoted spread / self-referential array reassignment (DSL028, DSL029)
  if (opts.checkQuotedSpread || opts.checkSelfRefArrayReassign) {
    diagnostics.push(...checkArrayAntiPatterns(sourceFile, index, opts));
  }

  return diagnostics;
}

/**
 * Check flow structure (decorators, trigger, action method).
 */
function checkFlowStructure(
  sourceFile: ts.SourceFile,
  index: SymbolIndex,
  opts: DiagnosticsOptions
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // Find any class declarations
  let hasClass = false;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isClassDeclaration(node)) {
      hasClass = true;
    }
  });

  // If there's a class but no @Flow decorator
  if (hasClass && opts.checkFlowDecorator && !index.flow.exists) {
    // Find the class to get its range
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isClassDeclaration(node)) {
        const range = getNodeRange(sourceFile, node);
        diagnostics.push({
          code: DiagnosticCodes.DSL001.code,
          severity: DiagnosticCodes.DSL001.severity,
          message: DiagnosticCodes.DSL001.format!(),
          range: {
            start: range.start,
            end: { line: range.start.line, character: range.start.character + 5 },
          },
          source: 'flowforger',
        });
      }
    });
  }

  // If @Flow exists but no trigger
  if (index.flow.exists && opts.checkTrigger && !index.flow.hasTrigger) {
    const flowClass = findFlowClass(sourceFile);
    if (flowClass) {
      const range = getNodeRange(sourceFile, flowClass);
      diagnostics.push({
        code: DiagnosticCodes.DSL002.code,
        severity: DiagnosticCodes.DSL002.severity,
        message: DiagnosticCodes.DSL002.format!(),
        range: {
          start: range.start,
          end: { line: range.start.line, character: range.start.character + 10 },
        },
        source: 'flowforger',
      });
    }
  }

  // If @Flow exists but no @Action method
  if (index.flow.exists && opts.checkAction && !index.flow.hasAction) {
    const flowClass = findFlowClass(sourceFile);
    if (flowClass) {
      const range = getNodeRange(sourceFile, flowClass);
      diagnostics.push({
        code: DiagnosticCodes.DSL003.code,
        severity: DiagnosticCodes.DSL003.severity,
        message: DiagnosticCodes.DSL003.format!(),
        range: {
          start: range.start,
          end: { line: range.start.line, character: range.start.character + 10 },
        },
        source: 'flowforger',
      });
    }
  }

  return diagnostics;
}

/**
 * Check for invalid action references.
 */
function checkActionReferences(index: SymbolIndex): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const invalidRefs = findInvalidActionReferences(index);

  for (const ref of invalidRefs) {
    diagnostics.push({
      code: DiagnosticCodes.DSL004.code,
      severity: DiagnosticCodes.DSL004.severity,
      message: DiagnosticCodes.DSL004.format!(ref.name),
      range: ref.range,
      source: 'flowforger',
    });
  }

  return diagnostics;
}

/**
 * Find all comment ranges in the source file.
 * Returns an array of [start, end] positions for each comment.
 */
function findCommentRanges(sourceText: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  // Match single-line comments (// ...) and multi-line comments (/* ... */ including JSDoc)
  const commentPattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  let match;
  while ((match = commentPattern.exec(sourceText)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }

  return ranges;
}

/**
 * Check if a position is inside any comment range.
 */
function isInComment(position: number, commentRanges: Array<[number, number]>): boolean {
  return commentRanges.some(([start, end]) => position >= start && position < end);
}

/**
 * Check for invalid variable references (case-insensitive, matching Logic Apps behavior).
 * Skips references inside JSDoc comments (e.g., @description containing PA expressions).
 */
function checkVariableReferences(
  sourceFile: ts.SourceFile,
  index: SymbolIndex
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // Use `sourceFile.text` (raw input), not `getText()`. The latter strips leading
  // detached trivia (e.g., file-level JSDoc), which shifts regex match offsets
  // relative to the line map and produces diagnostics on wrong lines.
  const sourceText = sourceFile.text;
  // Build case-insensitive lookup set from TypeScript variable names
  const validNames = new Set(
    index.variables.filter((v) => v.isInitialDeclaration).map((v) => v.name.toLowerCase())
  );

  // Also include original PA names from @originalName JSDoc annotations.
  // e.g., /** @originalName "Activity FetchXML Filter" */ let Activity_FetchXML_Filter = ...
  // The original name is used in appendToStringVariable(), variables(), etc.
  const originalNamePattern = /@originalName\s+"([^"]+)"/g;
  let origMatch;
  while ((origMatch = originalNamePattern.exec(sourceText)) !== null) {
    validNames.add(origMatch[1].toLowerCase());
  }

  // Find all comment ranges to skip matches inside comments
  const commentRanges = findCommentRanges(sourceText);

  // Find variables() calls
  const pattern = /variables\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;

  while ((match = pattern.exec(sourceText)) !== null) {
    // Skip matches inside comments (e.g., JSDoc @description with PA expressions)
    if (isInComment(match.index, commentRanges)) {
      continue;
    }

    const name = match[1];
    const matchLine = sourceFile.getLineAndCharacterOfPosition(match.index).line;

    // Skip if this is inside a ctx.eval() or ctx.braced() call (contains raw PA expressions)
    // Look backwards from match to find if we're inside one of these
    const beforeMatch = sourceText.substring(0, match.index);

    // Check for ctx.eval(`...`)
    const lastEvalStart = beforeMatch.lastIndexOf('ctx.eval(`');
    const lastBacktick = beforeMatch.lastIndexOf('`)');
    if (lastEvalStart !== -1 && (lastBacktick === -1 || lastBacktick < lastEvalStart)) {
      continue;
    }

    // Check for ctx.braced(...) - can contain variables() calls with original names
    const lastBracedStart = beforeMatch.lastIndexOf('ctx.braced(');
    const lastCloseParen = beforeMatch.lastIndexOf(')');
    // Count parentheses to find matching close
    if (lastBracedStart !== -1) {
      let parenCount = 1;
      let pos = lastBracedStart + 'ctx.braced('.length;
      while (pos < beforeMatch.length && parenCount > 0) {
        if (beforeMatch[pos] === '(') parenCount++;
        if (beforeMatch[pos] === ')') parenCount--;
        pos++;
      }
      // If we haven't closed all parens yet, we're inside ctx.braced()
      if (parenCount > 0) {
        continue;
      }
    }

    // Check if variable exists and is declared before this reference (case-insensitive)
    const lowerName = name.toLowerCase();
    const variable = index.variables.find(
      (v) => v.name.toLowerCase() === lowerName && v.isInitialDeclaration && v.line < matchLine
    );

    if (!variable && !validNames.has(lowerName)) {
      const startPos = sourceFile.getLineAndCharacterOfPosition(match.index);
      const endPos = sourceFile.getLineAndCharacterOfPosition(
        match.index + match[0].length
      );

      diagnostics.push({
        code: DiagnosticCodes.DSL005.code,
        severity: DiagnosticCodes.DSL005.severity,
        message: DiagnosticCodes.DSL005.format!(name),
        range: { start: startPos, end: endPos },
        source: 'flowforger',
      });
    }
  }

  // Also check methods that take a variable name as parameter
  // (e.g., ctx.appendToStringVariable('varName', value))
  const varNameMethods = /(?:appendToStringVariable)\s*\(\s*['"]([^'"]+)['"]/g;
  let varMethodMatch;

  while ((varMethodMatch = varNameMethods.exec(sourceText)) !== null) {
    if (isInComment(varMethodMatch.index, commentRanges)) {
      continue;
    }

    const name = varMethodMatch[1];
    const lowerName = name.toLowerCase();

    if (!validNames.has(lowerName)) {
      // Highlight just the variable name string argument
      const nameArgOffset = varMethodMatch.index + varMethodMatch[0].indexOf(name) - 1; // include the quote
      const startPos = sourceFile.getLineAndCharacterOfPosition(nameArgOffset);
      const endPos = sourceFile.getLineAndCharacterOfPosition(nameArgOffset + name.length + 2); // include both quotes

      diagnostics.push({
        code: DiagnosticCodes.DSL005.code,
        severity: DiagnosticCodes.DSL005.severity,
        message: DiagnosticCodes.DSL005.format!(name),
        range: { start: startPos, end: endPos },
        source: 'flowforger',
      });
    }
  }

  // Check bare-identifier assignments: `x = value` where x was never declared with `let`.
  // variable-finder only indexes reassignments when a prior `let` exists, so these slip
  // past the push/variables() regexes above.
  const assignedButUndeclared = new Set<string>();
  function visitAssignments(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const name = node.left.text;
      const lower = name.toLowerCase();
      // Skip 'ctx' and common JS globals to avoid noise.
      if (name === 'ctx' || name === 'console' || name === 'window' || name === 'globalThis') {
        // no-op
      } else if (!validNames.has(lower) && !assignedButUndeclared.has(name)) {
        assignedButUndeclared.add(name);
        const nameStart = node.left.getStart(sourceFile);
        const startPos = sourceFile.getLineAndCharacterOfPosition(nameStart);
        const endPos = sourceFile.getLineAndCharacterOfPosition(node.left.getEnd());
        diagnostics.push({
          code: DiagnosticCodes.DSL005.code,
          severity: DiagnosticCodes.DSL005.severity,
          message: DiagnosticCodes.DSL005.format!(name),
          range: { start: startPos, end: endPos },
          source: 'flowforger',
        });
      }
    }
    ts.forEachChild(node, visitAssignments);
  }
  visitAssignments(sourceFile);

  // Check array.push() calls — generates AppendToArrayVariable, so the array must be declared.
  // Match standalone identifiers before .push( — exclude chained access like ctx.something.push(
  const pushPattern = /(?<![.\w])([a-zA-Z_$][\w$]*)\.push\s*\(/g;
  let pushMatch;

  while ((pushMatch = pushPattern.exec(sourceText)) !== null) {
    if (isInComment(pushMatch.index, commentRanges)) {
      continue;
    }

    const name = pushMatch[1];
    const lowerName = name.toLowerCase();

    // Skip known non-variable identifiers
    if (name === 'ctx' || name === 'Array' || name === 'console') {
      continue;
    }

    if (!validNames.has(lowerName)) {
      const startPos = sourceFile.getLineAndCharacterOfPosition(pushMatch.index);
      const endPos = sourceFile.getLineAndCharacterOfPosition(
        pushMatch.index + name.length
      );

      diagnostics.push({
        code: DiagnosticCodes.DSL005.code,
        severity: DiagnosticCodes.DSL005.severity,
        message: DiagnosticCodes.DSL005.format!(name),
        range: { start: startPos, end: endPos },
        source: 'flowforger',
      });
    }
  }

  return diagnostics;
}

/**
 * Check for invalid parameter references.
 */
function checkParameterReferences(index: SymbolIndex): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const invalidRefs = findInvalidParameterReferences(index);
  const definedParams = getAllParameterNames(index);
  const definedList = definedParams.length > 0 ? definedParams.join(', ') : undefined;

  for (const ref of invalidRefs) {
    diagnostics.push({
      code: DiagnosticCodes.DSL015.code,
      severity: DiagnosticCodes.DSL015.severity,
      message: DiagnosticCodes.DSL015.format!(ref.name, definedList),
      range: ref.range,
      source: 'flowforger',
    });
  }

  return diagnostics;
}

/**
 * Check for invalid connection reference usages.
 */
function checkConnectionReferences(index: SymbolIndex): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const invalidRefs = findInvalidConnectionReferences(index);
  const definedRefs = getAllConnectionReferenceNames(index);
  const definedList = definedRefs.length > 0 ? definedRefs.join(', ') : undefined;

  for (const ref of invalidRefs) {
    diagnostics.push({
      code: DiagnosticCodes.DSL016.code,
      severity: DiagnosticCodes.DSL016.severity,
      message: DiagnosticCodes.DSL016.format!(ref.name, definedList),
      range: ref.range,
      source: 'flowforger',
    });
  }

  return diagnostics;
}

/**
 * Check for unused variables.
 */
function checkUnusedVariables(index: SymbolIndex): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const unused = findUnusedVariables(index);

  for (const variable of unused) {
    diagnostics.push({
      code: DiagnosticCodes.DSL007.code,
      severity: DiagnosticCodes.DSL007.severity,
      message: DiagnosticCodes.DSL007.format!(variable.name),
      range: variable.nameRange,
      source: 'flowforger',
    });
  }

  return diagnostics;
}

/**
 * Check for duplicate action names.
 */
function checkDuplicateActions(index: SymbolIndex): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const duplicateGroups = findDuplicateActions(index.actions);

  for (const group of duplicateGroups) {
    // Skip the first one (it's the original), report the duplicates
    for (let i = 1; i < group.length; i++) {
      const duplicate = group[i];
      const original = group[0];

      diagnostics.push({
        code: DiagnosticCodes.DSL008.code,
        severity: DiagnosticCodes.DSL008.severity,
        message: DiagnosticCodes.DSL008.format!(
          duplicate.name,
          String(original.line + 1)
        ),
        range: duplicate.nameRange,
        source: 'flowforger',
      });
    }
  }

  return diagnostics;
}

/**
 * Check for duplicate variable declarations (case-sensitive).
 * Each `let x` becomes a Power Automate InitializeVariable action, and PA
 * requires unique variable names. The transformer also throws on this, but
 * surfacing it as an LSP diagnostic shows the error in the Problems panel
 * before the user tries to compile/run.
 *
 * Re-walks the source via `findDuplicateVariables` because the symbol index
 * collapses second `let x` and reassignment `x = ...` into the same shape.
 */
function checkDuplicateVariables(code: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const groups = findDuplicateVariables(code);

  for (const group of groups) {
    // First declaration is the original; flag every subsequent one.
    const original = group[0];
    for (let i = 1; i < group.length; i++) {
      const duplicate = group[i];
      diagnostics.push({
        code: DiagnosticCodes.DSL030.code,
        severity: DiagnosticCodes.DSL030.severity,
        message: DiagnosticCodes.DSL030.format!(
          duplicate.name,
          String(original.line + 1)
        ),
        range: duplicate.nameRange,
        source: 'flowforger',
      });
    }
  }

  return diagnostics;
}

/**
 * Check for variable initialization inside control structures.
 * In Logic Apps, InitializeVariable can only be at the root level.
 */
function checkNestedVariableInitialization(sourceFile: ts.SourceFile): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  function isControlStructure(node: ts.Node): boolean {
    return (
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isTryStatement(node)
    );
  }

  function visit(node: ts.Node, insideControlStructure: boolean): void {
    // Check if we're entering a control structure
    if (isControlStructure(node)) {
      insideControlStructure = true;
    }

    // Check for 'let' variable declarations inside control structures
    if (ts.isVariableStatement(node) && insideControlStructure) {
      const declList = node.declarationList;

      // Only check 'let' declarations (not const)
      if (declList.flags & ts.NodeFlags.Let) {
        for (const decl of declList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const varName = decl.name.text;
            const startPos = sourceFile.getLineAndCharacterOfPosition(decl.getStart(sourceFile));
            const endPos = sourceFile.getLineAndCharacterOfPosition(decl.getEnd());

            diagnostics.push({
              code: DiagnosticCodes.DSL014.code,
              severity: DiagnosticCodes.DSL014.severity,
              message: DiagnosticCodes.DSL014.format!(varName),
              range: { start: startPos, end: endPos },
              source: 'flowforger',
            });
          }
        }
      }
    }

    // Continue traversing
    ts.forEachChild(node, (child) => visit(child, insideControlStructure));
  }

  visit(sourceFile, false);

  return diagnostics;
}

/**
 * Action methods on ctx that produce IR nodes and require 'await'.
 */
const AWAITABLE_ACTION_METHODS = new Set([
  'http',
  'compose',
  'saveFile',
  'expression',
  'response',
  'terminate',
  'delay',
  'delayUntil',
  'callWorkflow',
  'parseJson',
  'join',
  'select',
  'filter',
  'filterArray',
  'createCsvTable',
  'createHtmlTable',
  'appendToStringVariable',
  'connector',
  'connectorWebhook',
]);

/**
 * Check if a call expression is a ctx action call that requires await.
 * Returns a descriptive string (e.g., "ctx.http(...)") if it is, undefined otherwise.
 */
function getCtxActionCallText(call: ts.CallExpression): string | undefined {
  const expr = call.expression;

  // Pattern: ctx.method(...)
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'ctx' &&
    AWAITABLE_ACTION_METHODS.has(expr.name.text)
  ) {
    return `ctx.${expr.name.text}(...)`;
  }

  // Pattern: ctx.connectors.<connector>.<operation>(...) — all dot notation
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isPropertyAccessExpression(expr.expression.expression) &&
    ts.isIdentifier(expr.expression.expression.expression) &&
    expr.expression.expression.expression.text === 'ctx' &&
    expr.expression.expression.name.text === 'connectors'
  ) {
    return `ctx.connectors.${expr.expression.name.text}.${expr.name.text}(...)`;
  }

  // Pattern: ctx.connectors['connector'].<operation>(...) — bracket on connector
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isElementAccessExpression(expr.expression) &&
    ts.isPropertyAccessExpression(expr.expression.expression) &&
    ts.isIdentifier(expr.expression.expression.expression) &&
    expr.expression.expression.expression.text === 'ctx' &&
    expr.expression.expression.name.text === 'connectors'
  ) {
    return `ctx.connectors[...].${expr.name.text}(...)`;
  }

  // Pattern: ctx.connectors.<connector>['operation'](...) — bracket on operation
  if (
    ts.isElementAccessExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isPropertyAccessExpression(expr.expression.expression) &&
    ts.isIdentifier(expr.expression.expression.expression) &&
    expr.expression.expression.expression.text === 'ctx' &&
    expr.expression.expression.name.text === 'connectors'
  ) {
    return `ctx.connectors.${expr.expression.name.text}[...](...)`;
  }

  // Pattern: ctx.connectors['connector']['operation'](...) — full bracket
  if (
    ts.isElementAccessExpression(expr) &&
    ts.isElementAccessExpression(expr.expression) &&
    ts.isPropertyAccessExpression(expr.expression.expression) &&
    ts.isIdentifier(expr.expression.expression.expression) &&
    expr.expression.expression.expression.text === 'ctx' &&
    expr.expression.expression.name.text === 'connectors'
  ) {
    return `ctx.connectors[...][...](...)`;
  }

  return undefined;
}

/**
 * Check for action calls missing 'await'.
 * Without await, action calls are silently omitted from the compiled flow.
 */
function checkMissingAwait(sourceFile: ts.SourceFile): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // Only check inside the @Action method
  const flowClass = findFlowClass(sourceFile);
  if (!flowClass) return diagnostics;

  const actionMethod = findActionMethod(flowClass);
  if (!actionMethod || !actionMethod.body) return diagnostics;

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callText = getCtxActionCallText(node);
      if (callText && (!node.parent || node.parent.kind !== ts.SyntaxKind.AwaitExpression)) {
        const startPos = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile)
        );
        const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

        diagnostics.push({
          code: DiagnosticCodes.DSL017.code,
          severity: DiagnosticCodes.DSL017.severity,
          message: DiagnosticCodes.DSL017.format!(callText),
          range: { start: startPos, end: endPos },
          source: 'flowforger',
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(actionMethod.body);

  return diagnostics;
}

/** ctx reference-read methods whose result cannot be captured in a `const` (use `let`, or reference inline). */
const CTX_REFERENCE_READ_METHODS = new Set([
  'body',
  'outputs',
  'actions',
  'triggerBody',
  'triggerOutputs',
  'variables',
  'item',
  'items',
]);

/**
 * True if `expr` is a call whose callee chain roots at the `ctx` identifier —
 * e.g. `ctx.http(...)` or `ctx.connectors.dataverse.ListRecords(...)`.
 */
function isCtxRootedCall(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) return false;
  let cur: ts.Expression = expr.expression;
  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    cur = cur.expression;
  }
  return ts.isIdentifier(cur) && cur.text === 'ctx';
}

/** True if `call` is a direct ctx reference read (`ctx.body(...)`, `ctx.variables(...)`, etc.). */
function isCtxReferenceRead(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'ctx') return false;
  return CTX_REFERENCE_READ_METHODS.has(callee.name.text);
}

/**
 * Check for return statements (DSL018), unsupported statements (DSL020),
 * const variable declarations (DSL025), and action-result bindings (DSL032)
 * inside the @Action method body.
 */
function checkActionMethodBody(sourceFile: ts.SourceFile): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  const flowClass = findFlowClass(sourceFile);
  if (!flowClass) return diagnostics;

  const actionMethod = findActionMethod(flowClass);
  if (!actionMethod || !actionMethod.body) return diagnostics;

  const unsupportedStatements: Record<number, string> = {
    [ts.SyntaxKind.ThrowStatement]: 'throw',
    [ts.SyntaxKind.TryStatement]: 'try/catch',
    [ts.SyntaxKind.BreakStatement]: 'break',
    [ts.SyntaxKind.ContinueStatement]: 'continue',
  };

  function visit(node: ts.Node): void {
    // DSL018: return statement
    if (ts.isReturnStatement(node)) {
      const startPos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      diagnostics.push({
        code: DiagnosticCodes.DSL018.code,
        severity: DiagnosticCodes.DSL018.severity,
        message: DiagnosticCodes.DSL018.format!(),
        range: { start: startPos, end: endPos },
        source: 'flowforger',
      });
    }

    // DSL020: unsupported statements
    const stmtName = unsupportedStatements[node.kind];
    if (stmtName) {
      const startPos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      diagnostics.push({
        code: DiagnosticCodes.DSL020.code,
        severity: DiagnosticCodes.DSL020.severity,
        message: DiagnosticCodes.DSL020.format!(stmtName),
        range: { start: startPos, end: endPos },
        source: 'flowforger',
      });
    }

    // DSL032 (action result binding) and DSL025 (const won't generate InitializeVariable)
    if (ts.isVariableStatement(node)) {
      const declList = node.declarationList;
      const isConst = (declList.flags & ts.NodeFlags.Const) !== 0;
      for (const decl of declList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer;
        // No initializer (const x;) is a TS error anyway — skip
        if (!init) continue;

        const varName = decl.name.text;
        const startPos = sourceFile.getLineAndCharacterOfPosition(decl.getStart(sourceFile));
        const endPos = sourceFile.getLineAndCharacterOfPosition(decl.getEnd());

        // DSL032: const/let x = await ctx.<action>(...) — the await IS the action call;
        // the binding is dropped and any use of `x` compiles to a broken '@x' reference.
        // Applies to both const and let (neither can capture an action result).
        if (ts.isAwaitExpression(init) && isCtxRootedCall(init.expression)) {
          diagnostics.push({
            code: DiagnosticCodes.DSL032.code,
            severity: DiagnosticCodes.DSL032.severity,
            message: DiagnosticCodes.DSL032.format!(varName),
            range: { start: startPos, end: endPos },
            source: 'flowforger',
          });
          continue;
        }

        // Remaining checks only concern `const`. A `let` bound to a reference read or a
        // simple value is valid — it becomes an InitializeVariable action.
        if (!isConst) continue;

        // DSL025: const bound to a ctx reference read (ctx.body/outputs/variables/...) —
        // const is not tracked as a variable, so `x` leaks as '@x'. `let` works here.
        if (ts.isCallExpression(init) && isCtxReferenceRead(init)) {
          diagnostics.push({
            code: DiagnosticCodes.DSL025.code,
            severity: DiagnosticCodes.DSL025.severity,
            message: DiagnosticCodes.DSL025.format!(varName),
            range: { start: startPos, end: endPos },
            source: 'flowforger',
          });
          continue;
        }

        // DSL025: const bound to a simple value (literal/object/array/...) that should be a
        // `let` InitializeVariable. Other expressions (helpers, odata builders) are left alone.
        const isSimpleValue =
          ts.isNumericLiteral(init) ||
          ts.isStringLiteral(init) ||
          ts.isNoSubstitutionTemplateLiteral(init) ||
          ts.isArrayLiteralExpression(init) ||
          ts.isObjectLiteralExpression(init) ||
          ts.isTemplateExpression(init) ||
          init.kind === ts.SyntaxKind.TrueKeyword ||
          init.kind === ts.SyntaxKind.FalseKeyword ||
          init.kind === ts.SyntaxKind.NullKeyword ||
          ts.isPrefixUnaryExpression(init); // e.g., -1
        if (!isSimpleValue) continue;

        diagnostics.push({
          code: DiagnosticCodes.DSL025.code,
          severity: DiagnosticCodes.DSL025.severity,
          message: DiagnosticCodes.DSL025.format!(varName),
          range: { start: startPos, end: endPos },
          source: 'flowforger',
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(actionMethod.body);
  return diagnostics;
}

/**
 * Check for multiple @Action methods in a single class (DSL019).
 */
function checkMultipleActionMethods(sourceFile: ts.SourceFile): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  const flowClass = findFlowClass(sourceFile);
  if (!flowClass) return diagnostics;

  const actionMethods: ts.MethodDeclaration[] = [];
  for (const member of flowClass.members) {
    if (ts.isMethodDeclaration(member) && hasDecorator(member, 'Action')) {
      actionMethods.push(member);
    }
  }

  if (actionMethods.length > 1) {
    const firstName = actionMethods[0].name && ts.isIdentifier(actionMethods[0].name)
      ? actionMethods[0].name.text
      : 'run';

    // Report on the 2nd and subsequent @Action methods
    for (let i = 1; i < actionMethods.length; i++) {
      const method = actionMethods[i];
      const startPos = sourceFile.getLineAndCharacterOfPosition(method.getStart(sourceFile));
      const endPos = sourceFile.getLineAndCharacterOfPosition(method.getEnd());
      diagnostics.push({
        code: DiagnosticCodes.DSL019.code,
        severity: DiagnosticCodes.DSL019.severity,
        message: DiagnosticCodes.DSL019.format!(firstName),
        range: {
          start: startPos,
          end: { line: startPos.line, character: startPos.character + 20 },
        },
        source: 'flowforger',
      });
    }
  }

  return diagnostics;
}

/**
 * Valid @runAfter status values.
 */
const VALID_RUN_AFTER_STATUSES = new Set(['succeeded', 'failed', 'skipped', 'timedout']);

/**
 * Check @runAfter annotations for invalid statuses (DSL021) and
 * non-existent action references (DSL022).
 */
function checkRunAfterAnnotations(sourceFile: ts.SourceFile, index: SymbolIndex): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const sourceText = sourceFile.text;

  // Build set of declared action names (case-insensitive)
  const declaredActions = new Set(
    index.actions.map(a => a.name.toLowerCase())
  );

  // Also include auto-generated variable initialization action names.
  // `let x = 0` generates an InitializeVariable action named "Initialize_x" (or a JSDoc @action override).
  for (const variable of index.variables) {
    if (variable.isInitialDeclaration) {
      declaredActions.add(`initialize_${variable.name}`.toLowerCase());
    }
  }

  // Also include auto-generated variable mutation action names.
  // Reassignments like `x = value` generate "Set_x" (or "Increment_x" / "Decrement_x"
  // for self-referencing patterns like `x = x + 1`). Multiple mutations to the same
  // variable get counter suffixes: Set_x, Set_x_2, Set_x_3, etc.
  // We add all possible prefixes since the language service cannot determine the exact
  // mutation type without full compiler analysis.
  const mutationCounters = new Map<string, number>();
  for (const variable of index.variables) {
    if (!variable.isInitialDeclaration) {
      const name = variable.name.toLowerCase();
      const current = mutationCounters.get(name) || 0;
      const next = current + 1;
      mutationCounters.set(name, next);
      const suffix = next === 1 ? '' : `_${next}`;

      declaredActions.add(`set_${name}${suffix}`);
      declaredActions.add(`increment_${name}${suffix}`);
      declaredActions.add(`decrement_${name}${suffix}`);
      declaredActions.add(`append_${name}${suffix}`);
    }
  }

  // Also scan ALL JSDoc comments for @action annotations. The action-finder only extracts
  // @action from control structures and ctx.method() calls, but @action can appear on any
  // statement (variable assignments, expression statements, etc.).
  const actionAnnotationPattern = /\/\*\*[\s\S]*?@[Aa]ction\s+([^\s@*]+)[\s\S]*?\*\//g;
  let actionAnnotationMatch;
  while ((actionAnnotationMatch = actionAnnotationPattern.exec(sourceText)) !== null) {
    declaredActions.add(actionAnnotationMatch[1].trim().toLowerCase());
  }

  // Scan for @runAfter in JSDoc comments
  const jsDocPattern = /\/\*\*[\s\S]*?\*\//g;
  let jsDocMatch;

  while ((jsDocMatch = jsDocPattern.exec(sourceText)) !== null) {
    const jsDocText = jsDocMatch[0];
    const jsDocStart = jsDocMatch.index;

    // Parse @runAfter entries within this JSDoc
    // Format: @runAfter ActionName: Status1, Status2
    // or:     @runAfter "ActionName:With:Colons": Status1, Status2
    const runAfterRegex = /@runAfter\s+(?:"([^"]+)"|([^:@\s]+)):\s*([^@*\n]+)/g;
    let raMatch;

    while ((raMatch = runAfterRegex.exec(jsDocText)) !== null) {
      const actionName = (raMatch[1] || raMatch[2]).trim();
      const statusesStr = raMatch[3].trim();
      const statuses = statusesStr.split(',').map(s => s.trim()).filter(s => s.length > 0);

      // DSL022: Check if action exists
      if (actionName !== 'trigger' && actionName !== 'first' &&
          !declaredActions.has(actionName.toLowerCase())) {
        const absOffset = jsDocStart + raMatch.index + raMatch[0].indexOf(actionName);
        const startPos = sourceFile.getLineAndCharacterOfPosition(absOffset);
        const endPos = sourceFile.getLineAndCharacterOfPosition(absOffset + actionName.length);
        diagnostics.push({
          code: DiagnosticCodes.DSL022.code,
          severity: DiagnosticCodes.DSL022.severity,
          message: DiagnosticCodes.DSL022.format!(actionName),
          range: { start: startPos, end: endPos },
          source: 'flowforger',
        });
      }

      // DSL021: Check status values
      for (const status of statuses) {
        if (!VALID_RUN_AFTER_STATUSES.has(status.toLowerCase())) {
          const statusOffset = jsDocStart + raMatch.index +
            raMatch[0].indexOf(status, raMatch[0].indexOf(':'));
          const startPos = sourceFile.getLineAndCharacterOfPosition(statusOffset);
          const endPos = sourceFile.getLineAndCharacterOfPosition(statusOffset + status.length);
          diagnostics.push({
            code: DiagnosticCodes.DSL021.code,
            severity: DiagnosticCodes.DSL021.severity,
            message: DiagnosticCodes.DSL021.format!(status),
            range: { start: startPos, end: endPos },
            source: 'flowforger',
          });
        }
      }
    }
  }

  return diagnostics;
}

/**
 * Check for empty @Flow name (DSL023).
 */
function checkFlowName(sourceFile: ts.SourceFile): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  const flowClass = findFlowClass(sourceFile);
  if (!flowClass) return diagnostics;

  // Find the @Flow decorator
  for (const decorator of (flowClass.modifiers ?? [])) {
    if (!ts.isDecorator(decorator)) continue;
    const expr = decorator.expression;
    if (!ts.isCallExpression(expr)) continue;
    const callee = expr.expression;
    if (!ts.isIdentifier(callee) || callee.text !== 'Flow') continue;

    const args = expr.arguments;
    if (args.length === 0) {
      // @Flow() with no arguments — class name is used as fallback, but worth flagging
      break;
    }

    const firstArg = args[0];

    // @Flow('') — empty string
    if (ts.isStringLiteral(firstArg) && firstArg.text.trim() === '') {
      const startPos = sourceFile.getLineAndCharacterOfPosition(firstArg.getStart(sourceFile));
      const endPos = sourceFile.getLineAndCharacterOfPosition(firstArg.getEnd());
      diagnostics.push({
        code: DiagnosticCodes.DSL023.code,
        severity: DiagnosticCodes.DSL023.severity,
        message: DiagnosticCodes.DSL023.format!(),
        range: { start: startPos, end: endPos },
        source: 'flowforger',
      });
    }

    // @Flow({ name: '' }) — empty string in object literal
    if (ts.isObjectLiteralExpression(firstArg)) {
      for (const prop of firstArg.properties) {
        if (ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.name) &&
            prop.name.text === 'name' &&
            ts.isStringLiteral(prop.initializer) &&
            prop.initializer.text.trim() === '') {
          const startPos = sourceFile.getLineAndCharacterOfPosition(prop.initializer.getStart(sourceFile));
          const endPos = sourceFile.getLineAndCharacterOfPosition(prop.initializer.getEnd());
          diagnostics.push({
            code: DiagnosticCodes.DSL023.code,
            severity: DiagnosticCodes.DSL023.severity,
            message: DiagnosticCodes.DSL023.format!(),
            range: { start: startPos, end: endPos },
            source: 'flowforger',
          });
        }
      }
    }

    break; // Only check first @Flow decorator
  }

  return diagnostics;
}

/**
 * Valid @type values for JSDoc annotations.
 */
const VALID_JSDOC_TYPES = new Set(['scope', 'if', 'foreach', 'switch', 'until', 'dountil', 'case']);

/**
 * JSDoc annotations that expect JSON values.
 */
const JSON_JSDOC_ANNOTATIONS = ['metadata', 'retryPolicy', 'trackedProperties', 'runtimeConfig'];

/**
 * Check @type values (DSL024) and JSON annotation syntax (DSL027) in JSDoc comments.
 */
function checkJSDocAnnotations(sourceFile: ts.SourceFile): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const sourceText = sourceFile.text;

  const jsDocPattern = /\/\*\*[\s\S]*?\*\//g;
  let jsDocMatch;

  while ((jsDocMatch = jsDocPattern.exec(sourceText)) !== null) {
    const jsDocText = jsDocMatch[0];
    const jsDocStart = jsDocMatch.index;

    // DSL024: Check @type values
    const typeMatch = jsDocText.match(/@type\s+([^\s@*]+)/);
    if (typeMatch) {
      const typeValue = typeMatch[1].trim();
      if (!VALID_JSDOC_TYPES.has(typeValue)) {
        const absOffset = jsDocStart + typeMatch.index! + typeMatch[0].indexOf(typeValue);
        const startPos = sourceFile.getLineAndCharacterOfPosition(absOffset);
        const endPos = sourceFile.getLineAndCharacterOfPosition(absOffset + typeValue.length);
        diagnostics.push({
          code: DiagnosticCodes.DSL024.code,
          severity: DiagnosticCodes.DSL024.severity,
          message: DiagnosticCodes.DSL024.format!(typeValue),
          range: { start: startPos, end: endPos },
          source: 'flowforger',
        });
      }
    }

    // DSL027: Check JSON annotations
    for (const annotation of JSON_JSDOC_ANNOTATIONS) {
      const annotationRegex = new RegExp(`@${annotation}\\s+(\\{[\\s\\S]*?\\})(?=\\s*(?:@|\\*\\/|\\*\\s*@))`, 'g');
      let annMatch;

      while ((annMatch = annotationRegex.exec(jsDocText)) !== null) {
        const jsonStr = annMatch[1];
        const absOffset = jsDocStart + annMatch.index;
        const range = {
          start: sourceFile.getLineAndCharacterOfPosition(absOffset),
          end: sourceFile.getLineAndCharacterOfPosition(absOffset + annMatch[0].length),
        };
        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          diagnostics.push({
            code: DiagnosticCodes.DSL027.code,
            severity: DiagnosticCodes.DSL027.severity,
            message: DiagnosticCodes.DSL027.format!(annotation),
            range,
            source: 'flowforger',
          });
          continue;
        }
        // DSL043: the JSON parsed — check the values against Power Automate's limits
        for (const detail of annotationValueProblems(annotation, parsed)) {
          diagnostics.push({
            code: DiagnosticCodes.DSL043.code,
            severity: DiagnosticCodes.DSL043.severity,
            message: DiagnosticCodes.DSL043.format!(annotation, detail),
            range,
            source: 'flowforger',
          });
        }
      }
    }

    // DSL043: @limit on a loop — `@limit 100` or `@limit {"count":100,"timeout":"PT1H"}`
    const limitMatch = jsDocText.match(/@limit\s+(\{[^}]*\}|\d+)/);
    if (limitMatch) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(limitMatch[1]);
      } catch {
        parsed = undefined; // malformed JSON is not this rule's concern
      }
      if (parsed !== undefined) {
        const absOffset = jsDocStart + limitMatch.index!;
        const range = {
          start: sourceFile.getLineAndCharacterOfPosition(absOffset),
          end: sourceFile.getLineAndCharacterOfPosition(absOffset + limitMatch[0].length),
        };
        for (const detail of annotationValueProblems('limit', parsed)) {
          diagnostics.push({
            code: DiagnosticCodes.DSL043.code,
            severity: DiagnosticCodes.DSL043.severity,
            message: DiagnosticCodes.DSL043.format!('limit', detail),
            range,
            source: 'flowforger',
          });
        }
      }
    }
  }

  return diagnostics;
}

/** Power Automate definition limits (learn.microsoft.com/power-automate/limits-and-config). */
const PA_LIMITS = {
  nameLength: 80,
  actionsPerFlow: 500,
  switchCases: 25,
  variablesPerFlow: 250,
  foreachConcurrency: { min: 1, max: 50 },
  untilCount: { min: 1, max: 5000 },
  retryCount: { min: 1, max: 90 },
  retryIntervalMs: { min: 5_000, max: 86_400_000 }, // PT5S .. P1D
  recurrenceIntervalMax: { month: 16, day: 500, hour: 12_000, minute: 72_000, second: 9_999_999 } as Record<string, number>,
};

/** Parse an ISO 8601 duration (P[nW][nD][T[nH][nM][nS]]) to milliseconds; undefined if malformed. */
function isoDurationMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = value.match(/^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!m) return undefined;
  const [, w, d, h, min, s] = m;
  if (!w && !d && !h && !min && !s) return undefined;
  return (Number(w || 0) * 7 + Number(d || 0)) * 86_400_000 + Number(h || 0) * 3_600_000 + Number(min || 0) * 60_000 + Number(s || 0) * 1000;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * Value checks for parsed JSDoc annotations (DSL043): @runtimeConfig concurrency, @retryPolicy
 * type/count/interval, @limit count/timeout. Returns one human-readable problem per finding.
 */
function annotationValueProblems(annotation: string, value: unknown): string[] {
  const problems: string[] = [];
  const obj = value && typeof value === 'object' ? (value as Record<string, any>) : undefined;
  if (annotation === 'runtimeConfig') {
    const reps = obj?.concurrency?.repetitions;
    if (reps !== undefined && (!isInt(reps) || reps < PA_LIMITS.foreachConcurrency.min || reps > PA_LIMITS.foreachConcurrency.max)) {
      problems.push(`concurrency.repetitions is ${JSON.stringify(reps)}; allowed range is ${PA_LIMITS.foreachConcurrency.min}-${PA_LIMITS.foreachConcurrency.max}.`);
    }
    const runs = obj?.concurrency?.runs;
    if (runs !== undefined && (!isInt(runs) || runs < 1 || runs > 100)) {
      problems.push(`concurrency.runs is ${JSON.stringify(runs)}; allowed range is 1-100.`);
    }
  } else if (annotation === 'retryPolicy') {
    if (!obj) return ['retryPolicy must be a JSON object.'];
    const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : undefined;
    if (type === undefined || !['none', 'fixed', 'exponential'].includes(type)) {
      problems.push(`type is ${JSON.stringify(obj.type)}; allowed values are none, fixed and exponential.`);
    }
    if (type !== 'none') {
      if (obj.count !== undefined && (!isInt(obj.count) || obj.count < PA_LIMITS.retryCount.min || obj.count > PA_LIMITS.retryCount.max)) {
        problems.push(`count is ${JSON.stringify(obj.count)}; allowed range is ${PA_LIMITS.retryCount.min}-${PA_LIMITS.retryCount.max}.`);
      }
      for (const key of ['interval', 'minimumInterval', 'maximumInterval']) {
        if (obj[key] === undefined) continue;
        const ms = isoDurationMs(obj[key]);
        if (ms === undefined) problems.push(`${key} is ${JSON.stringify(obj[key])}, which is not an ISO 8601 duration (e.g. "PT20S").`);
        else if (ms < PA_LIMITS.retryIntervalMs.min || ms > PA_LIMITS.retryIntervalMs.max) problems.push(`${key} is "${obj[key]}"; allowed range is PT5S to P1D.`);
      }
    }
  } else if (annotation === 'limit') {
    const count = isInt(value) ? value : obj?.count;
    if (count !== undefined && (!isInt(count) || count < PA_LIMITS.untilCount.min || count > PA_LIMITS.untilCount.max)) {
      problems.push(`count is ${JSON.stringify(count)}; allowed range is ${PA_LIMITS.untilCount.min}-${PA_LIMITS.untilCount.max}.`);
    }
    if (obj?.timeout !== undefined && isoDurationMs(obj.timeout) === undefined) {
      problems.push(`timeout is ${JSON.stringify(obj.timeout)}, which is not an ISO 8601 duration (e.g. "PT1H").`);
    }
  }
  return problems;
}

/**
 * Definition limits that are visible in the source (DSL039-DSL042): action name length, number
 * of actions, cases per switch, number of variables.
 */
function checkLimits(sourceFile: ts.SourceFile, index: SymbolIndex): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const flowClass = findFlowClass(sourceFile);
  const flowRange = flowClass?.name ? getNodeRange(sourceFile, flowClass.name) : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

  for (const action of index.actions) {
    if (action.name.length > PA_LIMITS.nameLength) {
      diagnostics.push({
        code: DiagnosticCodes.DSL039.code,
        severity: DiagnosticCodes.DSL039.severity,
        message: DiagnosticCodes.DSL039.format!(action.name, String(action.name.length)),
        range: action.nameRange,
        source: 'flowforger',
      });
    }
  }

  if (index.actions.length > PA_LIMITS.actionsPerFlow) {
    diagnostics.push({
      code: DiagnosticCodes.DSL040.code,
      severity: DiagnosticCodes.DSL040.severity,
      message: DiagnosticCodes.DSL040.format!(String(index.actions.length)),
      range: flowRange,
      source: 'flowforger',
    });
  }

  const variableCount = index.variables.filter((v) => v.isInitialDeclaration).length;
  if (variableCount > PA_LIMITS.variablesPerFlow) {
    diagnostics.push({
      code: DiagnosticCodes.DSL042.code,
      severity: DiagnosticCodes.DSL042.severity,
      message: DiagnosticCodes.DSL042.format!(String(variableCount)),
      range: flowRange,
      source: 'flowforger',
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isSwitchStatement(node)) {
      const cases = node.caseBlock.clauses.filter((c) => ts.isCaseClause(c)).length;
      if (cases > PA_LIMITS.switchCases) {
        diagnostics.push({
          code: DiagnosticCodes.DSL041.code,
          severity: DiagnosticCodes.DSL041.severity,
          message: DiagnosticCodes.DSL041.format!(String(cases)),
          range: getNodeRange(sourceFile, node.expression),
          source: 'flowforger',
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return diagnostics;
}

/** The object-literal argument of a decorator on a class member, if any. */
function decoratorObjectArgument(member: ts.Node, decoratorName: string): ts.ObjectLiteralExpression | undefined {
  const decorators = ts.canHaveDecorators(member) ? ts.getDecorators(member) : undefined;
  for (const d of decorators || []) {
    if (!ts.isCallExpression(d.expression)) continue;
    const callee = d.expression.expression;
    if (!ts.isIdentifier(callee) || callee.text !== decoratorName) continue;
    const arg = d.expression.arguments[0];
    return arg && ts.isObjectLiteralExpression(arg) ? arg : undefined;
  }
  return undefined;
}

function literalProperty(obj: ts.ObjectLiteralExpression | undefined, name: string): ts.Expression | undefined {
  if (!obj) return undefined;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) {
      return p.initializer;
    }
  }
  return undefined;
}

/**
 * Response kind vs trigger (DSL044) and @RecurrenceTrigger option ranges (DSL045, DSL046).
 * Only literal values are checked; anything computed is left alone.
 */
function checkTriggerOptions(sourceFile: ts.SourceFile): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const flowClass = findFlowClass(sourceFile);
  if (!flowClass) return diagnostics;

  let triggerName: string | undefined;
  let triggerOptions: ts.ObjectLiteralExpression | undefined;
  for (const member of flowClass.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    for (const name of ['HttpTrigger', 'ManualTrigger', 'RecurrenceTrigger', 'ConnectorTrigger']) {
      if (hasDecorator(member, name)) {
        triggerName = name;
        triggerOptions = decoratorObjectArgument(member, name);
      }
    }
  }
  if (!triggerName) return diagnostics;

  // DSL044 — ctx.response(name, status, body, headers, schema, kind)
  const triggerKindLit = literalProperty(triggerOptions, 'triggerKind');
  const triggerKind = triggerKindLit && ts.isStringLiteralLike(triggerKindLit) ? triggerKindLit.text : undefined;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'ctx' &&
      node.expression.name.text === 'response'
    ) {
      const kindArg = node.arguments[5];
      const kind = kindArg && ts.isStringLiteralLike(kindArg) ? kindArg.text : undefined;
      let expected: string | undefined;
      let ok = true;
      if (kind === 'PowerApp') {
        expected = '@ManualTrigger (Power Apps / button / child-flow trigger)';
        ok = triggerName === 'ManualTrigger';
      } else if (kind === 'VirtualAgent') {
        expected = "@HttpTrigger({ triggerKind: 'VirtualAgent' })";
        ok = triggerName === 'HttpTrigger' && triggerKind === 'VirtualAgent';
      }
      if (expected && !ok) {
        const actual = `@${triggerName}` + (triggerKind ? `({ triggerKind: '${triggerKind}' })` : '');
        diagnostics.push({
          code: DiagnosticCodes.DSL044.code,
          severity: DiagnosticCodes.DSL044.severity,
          message: DiagnosticCodes.DSL044.format!(kind!, expected, actual),
          range: getNodeRange(sourceFile, kindArg!),
          source: 'flowforger',
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(flowClass);

  // DSL045 / DSL046 — @RecurrenceTrigger({ frequency, interval, schedule })
  if (triggerName === 'RecurrenceTrigger' && triggerOptions) {
    const push = (code: 'DSL045' | 'DSL046', node: ts.Node, detail: string) =>
      diagnostics.push({
        code: DiagnosticCodes[code].code,
        severity: DiagnosticCodes[code].severity,
        message: DiagnosticCodes[code].format!(detail),
        range: getNodeRange(sourceFile, node),
        source: 'flowforger',
      });
    const freqLit = literalProperty(triggerOptions, 'frequency');
    const freq = freqLit && ts.isStringLiteralLike(freqLit) ? freqLit.text : undefined;
    const freqLower = freq?.toLowerCase();
    if (freqLit && freq !== undefined && !['second', 'minute', 'hour', 'day', 'week', 'month', 'year'].includes(freqLower!)) {
      push('DSL045', freqLit, `frequency '${freq}' is not one of Second, Minute, Hour, Day, Week, Month, Year.`);
    }
    const intervalLit = literalProperty(triggerOptions, 'interval');
    if (intervalLit) {
      const text = intervalLit.getText(sourceFile);
      const n = ts.isNumericLiteral(intervalLit) ? Number(intervalLit.text) : ts.isPrefixUnaryExpression(intervalLit) ? Number(text) : undefined;
      const max = freqLower ? PA_LIMITS.recurrenceIntervalMax[freqLower] : undefined;
      if (n !== undefined && (!Number.isInteger(n) || n < 1 || (max !== undefined && n > max))) {
        push('DSL045', intervalLit, `interval ${text} must be an integer from 1 to ${max ?? '…'} for frequency '${freq ?? '?'}'.`);
      }
    }
    const scheduleLit = literalProperty(triggerOptions, 'schedule');
    if (scheduleLit && ts.isObjectLiteralExpression(scheduleLit) && freqLower) {
      const has = (k: string) => literalProperty(scheduleLit, k);
      const hoursOrMinutes = has('hours') ?? has('minutes');
      if (hoursOrMinutes && freqLower !== 'day' && freqLower !== 'week') {
        push('DSL046', hoursOrMinutes, `hours/minutes only apply to frequency Day or Week (this trigger uses '${freq}').`);
      }
      const weekDays = has('weekDays');
      if (weekDays && freqLower !== 'week') push('DSL046', weekDays, `weekDays only applies to frequency Week (this trigger uses '${freq}').`);
      const monthDays = has('monthDays');
      if (monthDays && freqLower !== 'month') push('DSL046', monthDays, `monthDays only applies to frequency Month (this trigger uses '${freq}').`);
    }
  }

  return diagnostics;
}

/**
 * Build set of all known ctx method names for DSL026.
 * Combines methods from flow-context-methods.ts, expression-transformer cases,
 * and action methods.
 */
const KNOWN_CTX_METHODS = new Set([
  // From flowContextMethods (dynamically populated below)
  ...flowContextMethods.map(m => m.name),
  // Action methods (require await)
  ...AWAITABLE_ACTION_METHODS,
  // Expression-transformer explicit cases not in flowContextMethods
  'eval', 'braced', 'atTrue', 'atFalse', 'atNumber', 'null',
  'result', 'parseDateTime', 'bool', 'and', 'or', 'int', 'float',
  'rand', 'coalesce', 'empty', 'contains', 'first', 'last',
  'skip', 'take', 'concat', 'sort',
  'json', 'string', 'base64', 'base64ToString', 'base64ToBinary',
  'binary', 'dataUri', 'dataUriToBinary', 'dataUriToString', 'decodeDataUri',
  'uriComponent', 'uriComponentToString', 'uriComponentToBinary', 'decodeUriComponent',
  'xml',
  'includes',
  // Common Power Automate expression functions (valid passthrough)
  'indexOf', 'lastIndexOf', 'nthIndexOf', 'substring', 'replace',
  'toLower', 'toUpper', 'trim', 'split', 'startsWith', 'endsWith',
  'length', 'equals', 'greater', 'less', 'greaterOrEquals', 'lessOrEquals',
  'not', 'if', 'add', 'sub', 'mul', 'div', 'mod', 'min', 'max',
  'abs', 'ceil', 'floor', 'round',
  'createArray', 'range', 'union', 'intersection',
  'setProperty', 'removeProperty', 'addProperty', 'xpath',
  'decodeBase64', 'encodeUriComponent', 'encodeURIComponent',
  'slice', 'chunk', 'reverse',
  'array', 'decimal', 'isFloat', 'isInt',
  'dateDifference', 'subtractFromTime', 'addToTime',
  'getFutureTime', 'getPastTime',
  'ticks', 'dayOfMonth', 'dayOfWeek', 'dayOfYear',
  'startOfDay', 'startOfHour', 'startOfMonth',
  'convertFromUtc', 'convertToUtc', 'convertTimeZone',
  'uriHost', 'uriPath', 'uriPathAndQuery', 'uriPort', 'uriQuery', 'uriScheme',
  'formDataValue', 'formDataMultiValues', 'multipartBody',
  'triggerFormDataValue', 'triggerFormDataMultiValues', 'triggerMultipartBody',
  'action', 'actionBody', 'iterationIndexes', 'listCallbackUrl',
  // Property-like access (not methods but accessed on ctx)
  'flow', 'connectors',
]);

/**
 * Check for unrecognized ctx method calls (DSL026).
 */
function checkUnknownCtxMethods(sourceFile: ts.SourceFile): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  const flowClass = findFlowClass(sourceFile);
  if (!flowClass) return diagnostics;

  const actionMethod = findActionMethod(flowClass);
  if (!actionMethod || !actionMethod.body) return diagnostics;

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      // Only check ctx.xxx() direct calls (not ctx.connectors.*.* etc.)
      if (ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text === 'ctx') {
        const methodName = expr.name.text;
        if (!KNOWN_CTX_METHODS.has(methodName)) {
          const startPos = sourceFile.getLineAndCharacterOfPosition(expr.name.getStart(sourceFile));
          const endPos = sourceFile.getLineAndCharacterOfPosition(expr.name.getEnd());
          diagnostics.push({
            code: DiagnosticCodes.DSL026.code,
            severity: DiagnosticCodes.DSL026.severity,
            message: DiagnosticCodes.DSL026.format!(methodName),
            range: { start: startPos, end: endPos },
            source: 'flowforger',
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(actionMethod.body);
  return diagnostics;
}

/**
 * Check for two array anti-patterns that compile to silently-broken flows:
 *   DSL028: `x = ['...x', value]` — quoted spread; the string is taken literally,
 *           overwriting x with a 2-element array on every iteration.
 *   DSL029: `x = [...x, value]` / `x = x.concat(value)` — generates SetVariable
 *           rather than AppendToArrayVariable; idiomatic fix is `x.push(value)`.
 */
function checkArrayAntiPatterns(
  sourceFile: ts.SourceFile,
  index: SymbolIndex,
  opts: DiagnosticsOptions
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // Only run inside the @Action method body — matches scope of other flow-only checks
  // and prevents false positives on UI-label arrays like `let labels = ['...loading']`
  // that might appear outside flow code.
  const flowClass = findFlowClass(sourceFile);
  if (!flowClass) return diagnostics;
  const actionMethod = findActionMethod(flowClass);
  if (!actionMethod || !actionMethod.body) return diagnostics;

  // Case-insensitive lookup of declared DSL variable names (matches the rest of this file).
  const declaredVars = new Set(
    index.variables
      .filter((v) => v.isInitialDeclaration)
      .map((v) => v.name.toLowerCase())
  );

  function visit(node: ts.Node): void {
    // DSL028: string literal of the form "...ident" inside an array literal.
    // The regex itself (exact "..." + identifier, nothing else) is tight enough
    // to avoid firing on strings like "...loading" or "...foo bar".
    if (opts.checkQuotedSpread && ts.isArrayLiteralExpression(node)) {
      for (const elem of node.elements) {
        if (!ts.isStringLiteral(elem) && !ts.isNoSubstitutionTemplateLiteral(elem)) continue;
        const text = elem.text;
        const m = /^\.\.\.([a-zA-Z_$][\w$]*)$/.exec(text);
        if (!m) continue;
        const ident = m[1];

        const startPos = sourceFile.getLineAndCharacterOfPosition(elem.getStart(sourceFile));
        const endPos = sourceFile.getLineAndCharacterOfPosition(elem.getEnd());
        diagnostics.push({
          code: DiagnosticCodes.DSL028.code,
          severity: DiagnosticCodes.DSL028.severity,
          message: DiagnosticCodes.DSL028.format!(ident),
          range: { start: startPos, end: endPos },
          source: 'flowforger',
        });
      }
    }

    // DSL029: assignment `x = <expr>` where <expr> references x itself, and x
    // is a known DSL variable. Matches: [...x, v], [v, ...x], x.concat(v).
    if (
      opts.checkSelfRefArrayReassign &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const lhsName = node.left.text;
      if (declaredVars.has(lhsName.toLowerCase()) && referencesIdentifier(node.right, lhsName)) {
        const startPos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
        diagnostics.push({
          code: DiagnosticCodes.DSL029.code,
          severity: DiagnosticCodes.DSL029.severity,
          message: DiagnosticCodes.DSL029.format!(lhsName),
          range: { start: startPos, end: endPos },
          source: 'flowforger',
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(actionMethod.body);
  return diagnostics;
}

/**
 * True if `expr` is one of the self-referential shapes we warn about:
 *   [...name, ...], [..., ...name], name.concat(...)
 */
function referencesIdentifier(expr: ts.Expression, name: string): boolean {
  // [...name, ...]  or  [..., ...name]
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.some(
      (e) =>
        ts.isSpreadElement(e) &&
        ts.isIdentifier(e.expression) &&
        e.expression.text === name
    );
  }
  // name.concat(...)
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === name &&
    expr.expression.name.text === 'concat'
  ) {
    return true;
  }
  return false;
}

/**
 * Quick check if code has any structural issues (for fast feedback).
 */
export function hasStructuralIssues(code: string): boolean {
  const index = buildSymbolIndex(code);

  // Check if there's a class but missing required elements
  if (code.includes('class ')) {
    if (!index.flow.exists) return true;
    if (!index.flow.hasTrigger) return true;
    if (!index.flow.hasAction) return true;
  }

  return false;
}

/**
 * Get diagnostic count by severity.
 */
export function getDiagnosticCounts(
  diagnostics: Diagnostic[]
): Record<DiagnosticSeverity, number> {
  const counts: Record<DiagnosticSeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
    hint: 0,
  };

  for (const d of diagnostics) {
    counts[d.severity]++;
  }

  return counts;
}

/**
 * Check Power Automate expressions inside ctx.eval(`...`) / ctx.eval('...')
 * literals (DSL033 syntax error, DSL034 unknown function).
 *
 * Substitution templates (`...${x}...`) are skipped — their content is
 * dynamic. When the literal contains escape sequences (cooked text differs
 * from raw source text), inner offsets would be misaligned, so findings fall
 * back to squiggling the whole literal.
 */
/**
 * Structural JSDoc tags the transformer strips from descriptions. Mirrors the tag list in
 * `parseDescriptionFromJSDoc` (@flowforger/dsl-native) plus `@trigger`.
 */
const STRUCTURAL_JSDOC_TAGS =
  'metadata|runAfter|action|type|parallel|limit|originalName|retryPolicy|runtimeConfig|conditionFormat|varType|trackedProperties|operationOptions|paramsOmitted|valueArrayForm|varNameCase|trigger';

interface CommentInfo {
  pos: number;
  end: number;
  text: string;
  kind: 'line' | 'block' | 'jsdoc';
}

/**
 * Collect every real comment in the file via the AST's trivia (never regex over the raw text,
 * which would mistake `//` or `@{` inside string/template literals for a comment).
 */
function collectComments(sourceFile: ts.SourceFile): CommentInfo[] {
  const text = sourceFile.text;
  const seen = new Set<number>();
  const out: CommentInfo[] = [];

  const add = (ranges: ts.CommentRange[] | undefined) => {
    for (const r of ranges ?? []) {
      if (seen.has(r.pos)) continue;
      seen.add(r.pos);
      const commentText = text.slice(r.pos, r.end);
      const kind =
        r.kind === ts.SyntaxKind.SingleLineCommentTrivia
          ? 'line'
          : commentText.startsWith('/**')
            ? 'jsdoc'
            : 'block';
      out.push({ pos: r.pos, end: r.end, text: commentText, kind });
    }
  };

  const visit = (node: ts.Node) => {
    // Leading ranges skip same-line comments after the previous token; trailing ranges catch those.
    add(ts.getLeadingCommentRanges(text, node.pos));
    add(ts.getTrailingCommentRanges(text, node.pos));
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);

  return out.sort((a, b) => a.pos - b.pos);
}

/**
 * The part of a comment that the transformer turns into a description, as
 * `{ offset, prose }` where `offset` is the index inside `comment.text` at which the
 * prose starts. Returns undefined when nothing from this comment becomes a description.
 *
 * Mirrors the transformer:
 * - `//` comments and plain block comments: the whole text.
 * - JSDoc with `@description`: the text after the tag, up to the next structural tag.
 * - JSDoc directly above the flow class (or above the imports): the whole text.
 * - Any other JSDoc (structural tags only): nothing — free prose there is dropped.
 */
function descriptionProse(
  comment: CommentInfo,
  sourceText: string,
): { offset: number; prose: string } | undefined {
  const { text, kind } = comment;
  if (kind === 'line') {
    return { offset: 2, prose: text.slice(2) };
  }
  const innerOffset = kind === 'jsdoc' ? 3 : 2;
  const inner = text.slice(innerOffset, text.endsWith('*/') ? -2 : undefined);
  if (kind === 'block') {
    return { offset: innerOffset, prose: inner.replace(/^\s*\*\s?/gm, '') };
  }
  const descMatch = inner.match(
    new RegExp(`@description\\s+([\\s\\S]*?)(?=\\s*@(?:${STRUCTURAL_JSDOC_TAGS})\\b|$)`),
  );
  if (descMatch && descMatch.index !== undefined) {
    const proseStart = descMatch.index + descMatch[0].indexOf(descMatch[1]);
    return { offset: innerOffset + proseStart, prose: descMatch[1] };
  }
  // Class-level (or file-level) JSDoc: the transformer keeps the whole block as the flow description.
  const following = sourceText.slice(comment.end).replace(/^\s+/, '');
  if (/^(@Flow\b|export\b|class\b|abstract\b|import\b)/.test(following)) {
    return { offset: innerOffset, prose: inner.replace(/^\s*\*? ?/gm, '') };
  }
  return undefined;
}

/**
 * Check comments — which become action / trigger / flow descriptions in the emitted
 * Logic Apps JSON — for Power Automate template syntax the cloud would try to parse:
 *
 * - DSL035 (error): "@{" anywhere in a comment. Flagged in every comment, even ones that
 *   don't currently become a description, so the file never carries the hazard.
 * - DSL036 (warning): a description that starts with "@" (but not "@@").
 */
/**
 * Placement of ctx.response() / ctx.terminate().
 *
 * Logic Apps rejects a Response or Terminate action nested (at any depth) under a Foreach or
 * Until action — the DSL's `for...of`, `while` and `do...while` — with
 * "The workflow run action 'X' has type 'Response' that could not be nested under an action of
 * type 'foreach'" (DSL037). A Response action is also only valid when the workflow starts with a
 * Request-type trigger: @HttpTrigger / @ManualTrigger, never @RecurrenceTrigger or
 * @ConnectorTrigger (DSL038). Mirrors RESPONSE_NESTED / TERMINATE_NESTED / RESPONSE_TRIGGER in
 * @flowforger/validator.
 */
function checkActionPlacement(sourceFile: ts.SourceFile): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // Which trigger decorator the flow uses (undefined when there is none — DSL002 covers that)
  let triggerDecorator: string | undefined;
  const flowClass = findFlowClass(sourceFile);
  if (flowClass) {
    for (const member of flowClass.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      for (const name of ['HttpTrigger', 'ManualTrigger', 'RecurrenceTrigger', 'ConnectorTrigger']) {
        if (hasDecorator(member, name)) triggerDecorator = name;
      }
    }
  }
  const triggerAllowsResponse =
    triggerDecorator === undefined || triggerDecorator === 'HttpTrigger' || triggerDecorator === 'ManualTrigger';

  function loopLabel(node: ts.Node): string | undefined {
    if (ts.isForOfStatement(node)) return 'for...of loop (foreach / Apply to each)';
    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) return 'while / do...while loop (until)';
    return undefined;
  }

  function ctxMethodName(node: ts.Node): string | undefined {
    if (!ts.isCallExpression(node)) return undefined;
    const expr = node.expression;
    if (
      ts.isPropertyAccessExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === 'ctx'
    ) {
      return expr.name.text;
    }
    return undefined;
  }

  function visit(node: ts.Node, enclosingLoop: string | undefined): void {
    const loop = loopLabel(node) ?? enclosingLoop;

    const method = ctxMethodName(node);
    if (method === 'response' || method === 'terminate') {
      const range = getNodeRange(sourceFile, node);
      if (enclosingLoop) {
        diagnostics.push({
          code: DiagnosticCodes.DSL037.code,
          severity: DiagnosticCodes.DSL037.severity,
          message: DiagnosticCodes.DSL037.format!(method, enclosingLoop),
          range,
          source: 'flowforger',
        });
      }
      if (method === 'response' && !triggerAllowsResponse) {
        diagnostics.push({
          code: DiagnosticCodes.DSL038.code,
          severity: DiagnosticCodes.DSL038.severity,
          message: DiagnosticCodes.DSL038.format!(triggerDecorator!),
          range,
          source: 'flowforger',
        });
      }
    }

    ts.forEachChild(node, (child) => visit(child, loop));
  }

  visit(sourceFile, undefined);
  return diagnostics;
}

function checkDescriptionComments(sourceFile: ts.SourceFile): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const sourceText = sourceFile.text;
  const comments = collectComments(sourceFile);

  const push = (code: 'DSL035' | 'DSL036', snippet: string, start: number, end: number) => {
    diagnostics.push({
      code: DiagnosticCodes[code].code,
      severity: DiagnosticCodes[code].severity,
      message: DiagnosticCodes[code].format!(snippet),
      range: {
        start: sourceFile.getLineAndCharacterOfPosition(start),
        end: sourceFile.getLineAndCharacterOfPosition(end),
      },
      source: 'flowforger',
    });
  };

  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i];

    // DSL035: every "@{" in the comment.
    const interpolation = /@\{/g;
    let m: RegExpExecArray | null;
    while ((m = interpolation.exec(comment.text)) !== null) {
      const start = comment.pos + m.index;
      // Squiggle through the closing brace when it sits on the same line, else just "@{".
      const lineEnd = comment.text.indexOf('\n', m.index);
      const sameLine = comment.text.slice(m.index, lineEnd === -1 ? undefined : lineEnd);
      const close = sameLine.indexOf('}');
      const snippet = close === -1 ? '@{' : sameLine.slice(0, close + 1);
      push('DSL035', snippet.length > 40 ? snippet.slice(0, 37) + '…' : snippet, start, start + snippet.length);
    }

    // DSL036: description text starting with "@". A `//` line that continues a run of `//`
    // lines is joined into the previous one, so only the first line of a run can "start".
    if (comment.kind === 'line' && i > 0) {
      const prev = comments[i - 1];
      const between = sourceText.slice(prev.end, comment.pos);
      if (prev.kind === 'line' && /^[ \t]*\r?\n[ \t]*$/.test(between)) continue;
    }
    // A trailing `//` comment after code on the same line never becomes a description.
    if (comment.kind === 'line') {
      const lineStart = sourceText.lastIndexOf('\n', comment.pos - 1) + 1;
      if (/\S/.test(sourceText.slice(lineStart, comment.pos))) continue;
    }
    const desc = descriptionProse(comment, sourceText);
    if (!desc) continue;
    const leading = desc.prose.match(/^\s*(@(?!@)\S*)/);
    if (!leading) continue;
    const token = leading[1];
    const atIndex = comment.text.indexOf('@', desc.offset);
    if (atIndex === -1) continue;
    const start = comment.pos + atIndex;
    push('DSL036', token, start, start + token.length);
  }

  return diagnostics;
}

function checkEvalExpressions(sourceFile: ts.SourceFile): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'ctx' &&
      node.expression.name.text === 'eval' &&
      node.arguments.length > 0
    ) {
      const arg = node.arguments[0];
      if (ts.isNoSubstitutionTemplateLiteral(arg) || ts.isStringLiteral(arg)) {
        checkEvalLiteral(sourceFile, arg, diagnostics);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return diagnostics;
}

function checkEvalLiteral(
  sourceFile: ts.SourceFile,
  arg: ts.NoSubstitutionTemplateLiteral | ts.StringLiteral,
  diagnostics: Diagnostic[]
): void {
  const content = arg.text; // cooked (escapes processed)
  const literalStart = arg.getStart(sourceFile);
  const literalRange: SourceRange = {
    start: getPositionFromOffset(sourceFile, literalStart),
    end: getPositionFromOffset(sourceFile, arg.getEnd()),
  };
  // Raw text includes the two delimiters; any difference beyond that means
  // escape sequences shifted the offsets — fall back to the whole literal.
  const exactOffsets = arg.getText(sourceFile).length - 2 === content.length;
  const contentStart = literalStart + 1;

  const rangeAt = (offset: number, length: number): SourceRange => {
    if (!exactOffsets) return literalRange;
    const startOff = contentStart + offset;
    return {
      start: getPositionFromOffset(sourceFile, startOff),
      end: getPositionFromOffset(sourceFile, startOff + Math.max(1, length)),
    };
  };

  const pushSyntax = (detail: string, offset: number, length: number) => {
    diagnostics.push({
      code: DiagnosticCodes.DSL033.code,
      severity: DiagnosticCodes.DSL033.severity,
      message: DiagnosticCodes.DSL033.format(detail),
      range: rangeAt(offset, length),
      source: 'flowforger',
    });
  };

  const pushUnknowns = (node: ExprNode) => {
    const seen = new Set<string>();
    for (const name of walkCalls(node)) {
      const lower = name.toLowerCase();
      if (KNOWN_FUNCTIONS.has(lower) || seen.has(lower)) continue;
      seen.add(lower);
      const idx = content.indexOf(name);
      diagnostics.push({
        code: DiagnosticCodes.DSL034.code,
        severity: DiagnosticCodes.DSL034.severity,
        message: DiagnosticCodes.DSL034.format(name),
        range: idx >= 0 ? rangeAt(idx, name.length) : literalRange,
        source: 'flowforger',
      });
    }
  };

  const trimmed = content.trim();
  const leadWs = content.length - content.trimStart().length;

  // Full expression form: @... (not the @{...} template, not the @@ escape)
  if (trimmed.startsWith('@') && !trimmed.startsWith('@{') && !trimmed.startsWith('@@')) {
    try {
      pushUnknowns(parseExpression(trimmed));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const pos = err instanceof ParseError && err.pos !== undefined ? leadWs + err.pos : 0;
      pushSyntax(message, pos, content.length - pos);
    }
    return;
  }

  // Template form: text with embedded @{...} segments
  if (content.includes('@{')) {
    const { parts, errors } = parseTemplateWithDiagnostics(content);
    for (const e of errors) {
      const offset = e.pos ?? e.start;
      pushSyntax(e.message, offset, e.start + e.length - offset);
    }
    for (const part of parts) {
      if (part.kind === 'expr') pushUnknowns(part.node);
    }
  }
}
