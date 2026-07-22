/**
 * Control Flow Analyzer
 * Analyzes if/for/switch statements and maps them to IR control flow nodes.
 */

import {
  IfStatement,
  ForOfStatement,
  ForInStatement,
  SwitchStatement,
  WhileStatement,
  DoStatement,
  Statement,
  Block,
  SyntaxKind,
  Expression,
  VariableDeclarationKind,
  Node as TsMorphNode,
} from 'ts-morph';
import type { Node, IfNode, ForeachNode, SwitchNode, DoUntilNode, ScopeNode } from '@flowforger/ir';
import { genIfId, genForeachId, genSwitchId, genDoUntilId, genScopeId } from '../utils/id-generator.js';
import { transformCondition, transformItemsExpression, transformExpression } from '../transformer/expression-transformer.js';
import type { TransformContext } from '../transformer/expression-transformer.js';
import { parseRunAfterFromJSDoc, parseActionNameFromJSDoc, parseParallelFromJSDoc, parseLimitFromJSDoc, parseDescriptionFromJSDoc, parseMetadataFromJSDoc, parseTrackedPropertiesFromJSDoc, parseConditionFormatFromJSDoc } from './action-collector.js';

export interface ControlFlowResult {
  node: Node;
  /** If the control flow contains nested statements that need processing */
  nestedStatements?: {
    then?: Statement[];
    else?: Statement[];
    loop?: Statement[];
    cases?: Array<{ statements: Statement[]; value?: any }>;
    default?: Statement[];
  };
}

/**
 * Analyze an if statement and create an IfNode structure.
 */
export function analyzeIfStatement(
  statement: IfStatement,
  ctx: TransformContext
): ControlFlowResult {
  const condition = transformCondition(statement.getExpression(), ctx);

  // Try to get name from @action JSDoc tag, fallback to auto-generated name
  const jsDocName = parseActionNameFromJSDoc(statement);
  const conditionName = jsDocName || generateConditionName(statement.getExpression());

  const thenStatement = statement.getThenStatement();
  const elseStatement = statement.getElseStatement();

  const thenStatements = getStatementsFromBlock(thenStatement);
  const elseStatements = elseStatement ? getStatementsFromBlock(elseStatement) : undefined;

  // Parse runAfter from JSDoc
  const runAfter = parseRunAfterFromJSDoc(statement);

  // Parse @parallel from JSDoc
  const runtimeConfiguration = parseParallelFromJSDoc(statement);

  // Parse @description from JSDoc
  const description = parseDescriptionFromJSDoc(statement);

  // Parse @metadata from JSDoc
  const metadata = parseMetadataFromJSDoc(statement);

  // Parse @trackedProperties from JSDoc
  const trackedProperties = parseTrackedPropertiesFromJSDoc(statement);

  // Parse @conditionFormat from JSDoc (for parity preservation)
  const conditionFormat = parseConditionFormatFromJSDoc(statement);

  const ifNode: IfNode = {
    id: genIfId(),
    type: 'if',
    name: conditionName,
    description,
    condition,
    conditionFormat,
    actions: [], // Will be populated by the transformer
    elseActions: elseStatements ? [] : undefined,
    runAfter,
    runtimeConfiguration,
    metadata,
    trackedProperties,
  };

  return {
    node: ifNode,
    nestedStatements: {
      then: thenStatements,
      else: elseStatements,
    },
  };
}

/**
 * Analyze a for...of statement and create a ForeachNode structure.
 */
export function analyzeForOfStatement(
  statement: ForOfStatement,
  ctx: TransformContext
): ControlFlowResult {
  const initializer = statement.getInitializer();
  const itemsExpr = statement.getExpression();
  const body = statement.getStatement();

  // Get the loop variable name
  let loopVariableName = 'item';
  if (initializer.getKind() === SyntaxKind.VariableDeclarationList) {
    const declList = initializer.asKindOrThrow(SyntaxKind.VariableDeclarationList);
    const decls = declList.getDeclarations();
    if (decls.length > 0) {
      const nameNode = decls[0].getNameNode();
      if (nameNode.getKind() === SyntaxKind.Identifier) {
        loopVariableName = nameNode.getText();
      }
    }
  }

  const itemsExpression = transformItemsExpression(itemsExpr, ctx);

  // Try to get name from @action JSDoc tag, fallback to auto-generated name
  const jsDocName = parseActionNameFromJSDoc(statement);
  const loopName = jsDocName || `ForEach_${loopVariableName}`;

  // Parse runAfter from JSDoc
  const runAfter = parseRunAfterFromJSDoc(statement);

  // Parse @parallel from JSDoc
  const runtimeConfiguration = parseParallelFromJSDoc(statement);

  // Parse @description from JSDoc
  const description = parseDescriptionFromJSDoc(statement);

  // Parse @metadata from JSDoc
  const metadata = parseMetadataFromJSDoc(statement);

  // Parse @trackedProperties from JSDoc
  const trackedProperties = parseTrackedPropertiesFromJSDoc(statement);

  // Parse @typeCase from JSDoc — preserves source's casing of the foreach type field
  // (e.g. "foreach" vs "Foreach"). Format: @typeCase "foreach"
  const jsDocText = statement.getSourceFile().getFullText().substring(
    Math.max(0, statement.getStart() - 500),
    statement.getStart()
  );
  const typeCaseMatch = jsDocText.match(/@typeCase\s+"([^"]+)"/);
  const typeCase = typeCaseMatch ? typeCaseMatch[1] : undefined;

  const foreachNode: ForeachNode = {
    id: genForeachId(),
    type: 'foreach',
    name: loopName,
    itemsExpression,
    description,
    actions: [], // Will be populated by the transformer
    runAfter,
    runtimeConfiguration,
    metadata,
    trackedProperties,
  };
  if (typeCase) {
    (foreachNode as any).typeCase = typeCase;
  }

  return {
    node: foreachNode,
    nestedStatements: {
      loop: getStatementsFromBlock(body),
    },
  };
}

/**
 * Analyze a switch statement and create a SwitchNode structure.
 */
export function analyzeSwitchStatement(
  statement: SwitchStatement,
  ctx: TransformContext
): ControlFlowResult {
  const expression = transformCondition(statement.getExpression(), ctx);
  const caseBlock = statement.getCaseBlock();
  const clauses = caseBlock.getClauses();

  const cases: Array<{ statements: Statement[]; value?: any; name: string }> = [];
  let defaultStatements: Statement[] | undefined;

  for (const clause of clauses) {
    if (clause.getKind() === SyntaxKind.CaseClause) {
      const caseClause = clause.asKindOrThrow(SyntaxKind.CaseClause);
      const caseExpr = caseClause.getExpression();
      const caseValue = getCaseValue(caseExpr, ctx);
      const statements = caseClause.getStatements().filter(s => s.getKind() !== SyntaxKind.BreakStatement);

      // Try to get case name from JSDoc comment before the case clause
      // The JSDoc is in the format: /** @action CaseName @type case */
      // Case names may contain spaces (e.g. "Case 2"), so capture until next @<word> or */
      let caseName = `Case_${String(caseValue)}`;
      const leadingComments = clause.getLeadingCommentRanges();
      for (const comment of leadingComments) {
        const commentText = comment.getText();
        const actionMatch = commentText.match(/@action\s+([\s\S]+?)(?=\s+@[a-zA-Z]|\s*\*\/|$)/);
        if (actionMatch) {
          caseName = actionMatch[1].trim();
          break;
        }
      }

      cases.push({
        statements: statements as Statement[],
        value: caseValue,
        name: caseName,
      });
    } else if (clause.getKind() === SyntaxKind.DefaultClause) {
      const defaultClause = clause.asKindOrThrow(SyntaxKind.DefaultClause);
      defaultStatements = defaultClause.getStatements().filter(
        s => s.getKind() !== SyntaxKind.BreakStatement
      ) as Statement[];
    }
  }

  // Parse runAfter from JSDoc
  const runAfter = parseRunAfterFromJSDoc(statement);

  // Parse @parallel from JSDoc
  const runtimeConfiguration = parseParallelFromJSDoc(statement);

  // Parse @description from JSDoc
  const description = parseDescriptionFromJSDoc(statement);

  // Parse @metadata from JSDoc
  const metadata = parseMetadataFromJSDoc(statement);

  // Parse @trackedProperties from JSDoc
  const trackedProperties = parseTrackedPropertiesFromJSDoc(statement);

  // Try to get name from @action JSDoc tag, fallback to default name
  const jsDocName = parseActionNameFromJSDoc(statement);
  const switchName = jsDocName || 'Switch';

  const switchNode: SwitchNode = {
    id: genSwitchId(),
    type: 'switch',
    name: switchName,
    description,
    expression,
    cases: cases.map(c => ({
      name: c.name,
      value: c.value,
      actions: [], // Will be populated by transformer
    })),
    defaultActions: defaultStatements ? [] : undefined,
    runAfter,
    runtimeConfiguration,
    metadata,
    trackedProperties,
  };

  return {
    node: switchNode,
    nestedStatements: {
      cases: cases.map(c => ({ statements: c.statements, value: c.value })),
      default: defaultStatements,
    },
  };
}

/**
 * Analyze a while statement and create a DoUntilNode structure.
 * Note: while(condition) { ... } becomes do { ... } until(!condition)
 */
export function analyzeWhileStatement(
  statement: WhileStatement,
  ctx: TransformContext
): ControlFlowResult {
  const conditionExpr = statement.getExpression();
  // Negate the condition: while(x) -> until(!x)
  const condition = `@not(${transformCondition(conditionExpr, ctx).replace(/^@/, '')})`;
  const body = statement.getStatement();

  // Parse runAfter from JSDoc
  const runAfter = parseRunAfterFromJSDoc(statement);

  // Parse @parallel from JSDoc
  const runtimeConfiguration = parseParallelFromJSDoc(statement);

  // Parse @limit from JSDoc for while/until count and timeout
  const parsedLimit = parseLimitFromJSDoc(statement);
  let limit: number | undefined;
  let timeout: string | undefined;
  if (typeof parsedLimit === 'number') {
    limit = parsedLimit;
  } else if (parsedLimit && typeof parsedLimit === 'object') {
    limit = (parsedLimit as any).count;
    timeout = (parsedLimit as any).timeout;
  }

  // Parse @description from JSDoc
  const description = parseDescriptionFromJSDoc(statement);

  // Parse @metadata from JSDoc
  const metadata = parseMetadataFromJSDoc(statement);

  // Parse @trackedProperties from JSDoc
  const trackedProperties = parseTrackedPropertiesFromJSDoc(statement);

  // Try to get name from @action JSDoc tag, fallback to default name
  const jsDocName = parseActionNameFromJSDoc(statement);
  const loopName = jsDocName || 'DoUntil';

  const doUntilNode: DoUntilNode = {
    id: genDoUntilId(),
    type: 'dountil',
    name: loopName,
    description,
    condition,
    limit,
    timeout,
    actions: [],
    runAfter,
    runtimeConfiguration,
    metadata,
    trackedProperties,
  };

  return {
    node: doUntilNode,
    nestedStatements: {
      loop: getStatementsFromBlock(body),
    },
  };
}

/**
 * Analyze a do...while statement and create a DoUntilNode structure.
 */
export function analyzeDoWhileStatement(
  statement: DoStatement,
  ctx: TransformContext
): ControlFlowResult {
  const conditionExpr = statement.getExpression();

  // Convert do-while to do-until:
  // - do-while(X) means "continue while X is true"
  // - do-until(X) means "continue until X is true" (i.e., while X is false)
  // So: do-while(C) = do-until(!C)
  //
  // The generator produces: do { } while (!(untilCondition))
  // So when we see: do { } while (!X), the until condition is X (unwrap the negation)
  // When we see: do { } while (X), the until condition is !X (negate it)
  let condition: string;
  if (TsMorphNode.isPrefixUnaryExpression(conditionExpr) &&
      conditionExpr.getOperatorToken() === SyntaxKind.ExclamationToken) {
    // While condition is !X, so until condition is X (unwrap the negation)
    const innerExpr = conditionExpr.getOperand();
    condition = transformCondition(innerExpr, ctx);
  } else {
    // While condition is X, so until condition is !X (negate it)
    condition = `@not(${transformCondition(conditionExpr, ctx).replace(/^@/, '')})`;
  }
  const body = statement.getStatement();

  // Parse runAfter from JSDoc
  const runAfter = parseRunAfterFromJSDoc(statement);

  // Parse @parallel from JSDoc
  const runtimeConfiguration = parseParallelFromJSDoc(statement);

  // Parse @limit from JSDoc for do-until count and timeout
  const parsedLimit = parseLimitFromJSDoc(statement);
  let limit: number | undefined;
  let timeout: string | undefined;
  if (typeof parsedLimit === 'number') {
    limit = parsedLimit;
  } else if (parsedLimit && typeof parsedLimit === 'object') {
    limit = (parsedLimit as any).count;
    timeout = (parsedLimit as any).timeout;
  }

  // Parse @description from JSDoc
  const description = parseDescriptionFromJSDoc(statement);

  // Parse @metadata from JSDoc
  const metadata = parseMetadataFromJSDoc(statement);

  // Parse @trackedProperties from JSDoc
  const trackedProperties = parseTrackedPropertiesFromJSDoc(statement);

  // Try to get name from @action JSDoc tag, fallback to default name
  const jsDocName = parseActionNameFromJSDoc(statement);
  const loopName = jsDocName || 'DoUntil';

  const doUntilNode: DoUntilNode = {
    id: genDoUntilId(),
    type: 'dountil',
    name: loopName,
    description,
    condition,
    limit,
    timeout,
    actions: [],
    runAfter,
    runtimeConfiguration,
    metadata,
    trackedProperties,
  };

  return {
    node: doUntilNode,
    nestedStatements: {
      loop: getStatementsFromBlock(body),
    },
  };
}

/**
 * Create a scope node for grouping statements.
 */
export function createScopeNode(name: string): ScopeNode {
  return {
    id: genScopeId(),
    type: 'scope',
    name,
    actions: [],
  };
}

// Helper functions

function getStatementsFromBlock(statement: Statement): Statement[] {
  if (statement.getKind() === SyntaxKind.Block) {
    return statement.asKindOrThrow(SyntaxKind.Block).getStatements() as Statement[];
  }
  // Single statement
  return [statement];
}

function generateConditionName(expression: Expression): string {
  const text = expression.getText();

  // Try to generate a meaningful name from the expression
  if (text.includes('===') || text.includes('==')) {
    // Prefer the string arg of a ctx.fn('arg') call: more descriptive than the
    // literal `ctx` identifier, which would otherwise collide for every if that
    // tests a ctx.outputs/body/variables expression.
    const ctxMatch = text.match(/ctx\.\w+\(\s*['"]([\w\s.-]+)['"]\s*\)/);
    if (ctxMatch) {
      return `Check_${ctxMatch[1].replace(/\s+/g, '_')}`;
    }
    // Equality check
    const match = text.match(/(\w+)(?:\(['"](\w+)['"]\))?.*(?:===|==)/);
    if (match) {
      return `Check_${match[2] || match[1]}`;
    }
  }

  if (text.includes('>') || text.includes('<')) {
    return 'Compare_Values';
  }

  if (text.includes('&&')) {
    return 'Check_And';
  }

  if (text.includes('||')) {
    return 'Check_Or';
  }

  // Default name
  return 'Condition';
}

function getCaseValue(expression: Expression, ctx: TransformContext): string | number {
  const kind = expression.getKind();

  switch (kind) {
    case SyntaxKind.StringLiteral:
      return expression.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();

    case SyntaxKind.NumericLiteral:
      return Number(expression.getText());

    case SyntaxKind.TrueKeyword:
      return 'true';

    case SyntaxKind.FalseKeyword:
      return 'false';

    default:
      // Non-literal case values (e.g. `case ctx.parameters('X'):`) need to be
      // converted back to PA expression form rather than emitted as raw DSL.
      return transformExpression(expression, ctx);
  }
}

/**
 * Get the loop variable name from a for...of initializer.
 */
export function getLoopVariableName(statement: ForOfStatement): string {
  const initializer = statement.getInitializer();

  if (initializer.getKind() === SyntaxKind.VariableDeclarationList) {
    const declList = initializer.asKindOrThrow(SyntaxKind.VariableDeclarationList);
    const decls = declList.getDeclarations();
    if (decls.length > 0) {
      const nameNode = decls[0].getNameNode();
      if (nameNode.getKind() === SyntaxKind.Identifier) {
        return nameNode.getText();
      }
    }
  }

  return 'item';
}

/**
 * Create a new transform context for a loop body with the loop variable.
 * Preserves outer loop variables so nested loops can reference them.
 */
export function createLoopContext(
  parentCtx: TransformContext,
  loopVariableName: string,
  loopName: string
): TransformContext {
  // Build map of all enclosing loop variables (outer + current parent)
  const loopVariables = new Map(parentCtx.loopVariables);
  if (parentCtx.loopVariable && parentCtx.loopName) {
    loopVariables.set(parentCtx.loopVariable, parentCtx.loopName);
  }

  return {
    ...parentCtx,
    loopVariable: loopVariableName,
    loopName,
    loopVariables,
    trackedVariables: new Set(parentCtx.trackedVariables),
  };
}
