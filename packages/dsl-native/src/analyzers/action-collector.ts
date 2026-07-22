/**
 * Action Collector
 * Collects ctx.* method calls and converts them to action nodes.
 */

import {
  CallExpression,
  SyntaxKind,
  Expression,
  ObjectLiteralExpression,
  Node,
  Statement,
} from 'ts-morph';
import type { ActionNode, ConnectorActionNode, StepResultStatus } from '@flowforger/ir';
import { genActionId, genConnectorId } from '../utils/id-generator.js';
import { transformExpression, transformTemplateStringInline } from '../transformer/expression-transformer.js';
import type { TransformContext } from '../transformer/expression-transformer.js';
import { isODataCall, transformODataCall, isODataTaggedTemplate, transformODataTaggedTemplate } from '../transformer/odata-transformer.js';
import { flattenParams, needsFlattening } from '../utils/params-transform.js';

/**
 * Extract JSDoc comment text from before a statement.
 * Returns the JSDoc text or undefined if none found.
 */
function getJSDocText(statement: Statement | Node): string | undefined {
  const sourceFile = statement.getSourceFile();
  const fullText = sourceFile.getFullText();
  const start = statement.getStart();

  // Look for JSDoc comment before the statement
  // We need to search backwards from the statement to find the comment
  const textBefore = fullText.substring(0, start);
  const lastJSDocMatch = textBefore.match(/\/\*\*([^*]|\*(?!\/))*\*\/\s*$/);

  return lastJSDocMatch ? lastJSDocMatch[0] : undefined;
}

/**
 * Extract plain (non-JSDoc) leading comment text ending immediately before `anchorPos`
 * within `fullText`. Recognizes a single block comment (slash-star ... star-slash,
 * excluding JSDoc which begins with slash-star-star) or a sequence of consecutive //
 * line comments joined with newlines. Returns undefined if no plain comment is found.
 */
export function getLeadingPlainCommentTextAt(fullText: string, anchorPos: number): string | undefined {
  const textBefore = fullText.substring(0, anchorPos);

  // Try block comment immediately before the anchor: /* ... */ but NOT /** ... */
  const blockEndMatch = textBefore.match(/\*\/\s*$/);
  if (blockEndMatch && blockEndMatch.index !== undefined) {
    const blockEnd = blockEndMatch.index;
    const blockStart = textBefore.lastIndexOf('/*', blockEnd - 1);
    if (blockStart !== -1 && textBefore.substring(blockStart, blockStart + 3) !== '/**') {
      const inner = textBefore.substring(blockStart + 2, blockEnd);
      const cleaned = inner
        .split('\n')
        .map(line => line.replace(/^\s*\*\s?/, '').trim())
        .join('\n')
        .trim();
      return cleaned || undefined;
    }
  }

  // Try contiguous // line comments immediately before the anchor.
  const lines = textBefore.split(/\r?\n/);
  let i = lines.length - 1;
  // Drop trailing whitespace-only line (where the anchor begins).
  if (i >= 0 && /^\s*$/.test(lines[i])) i--;

  const collected: string[] = [];
  while (i >= 0) {
    const m = lines[i].match(/^\s*\/\/(.*)$/);
    if (!m) break;
    // Strip a single leading space (the conventional space after //) but keep further indentation.
    collected.unshift(m[1].replace(/^[ \t]/, '').trimEnd());
    i--;
  }

  if (collected.length === 0) return undefined;
  const joined = collected.join('\n').trim();
  return joined || undefined;
}

/**
 * Extract plain (non-JSDoc) leading comment text immediately above a statement.
 *
 * Used as a fallback to preserve regular TypeScript comments as action descriptions
 * so they survive the DSL → IR → Logic Apps JSON → IR → DSL round-trip.
 */
export function getLeadingPlainCommentText(statement: Statement | Node): string | undefined {
  const sourceFile = statement.getSourceFile();
  const fullText = sourceFile.getFullText();
  return getLeadingPlainCommentTextAt(fullText, statement.getStart());
}

/**
 * Parse @action name from a JSDoc comment.
 * Returns the action name or undefined if not specified.
 *
 * Format: @action ActionName
 * Example: @action Check_If_User_Exists
 */
export function parseActionNameFromJSDoc(statement: Statement | Node): string | undefined {
  const jsDocText = getJSDocText(statement);
  if (!jsDocText) {
    return undefined;
  }

  // Parse @action tag
  // Format: @action ActionName (may contain spaces, e.g. "Case 2"; stops at next @<word> tag or */)
  const actionMatch = jsDocText.match(/@action\s+([\s\S]+?)(?=\s+@[a-zA-Z]|\s*\*\/|$)/);
  return actionMatch ? actionMatch[1].trim() : undefined;
}

/**
 * Parse @type from a JSDoc comment.
 * Returns the type or undefined if not specified.
 *
 * Format: @type TypeName
 * Example: @type scope
 */
export function parseTypeFromJSDoc(statement: Statement | Node): string | undefined {
  const jsDocText = getJSDocText(statement);
  if (!jsDocText) {
    return undefined;
  }

  // Parse @type tag
  // Format: @type TypeName (stops at next @ or whitespace or *)
  const typeMatch = jsDocText.match(/@type\s+([^\s@*]+)/);
  return typeMatch ? typeMatch[1].trim() : undefined;
}

/**
 * Parse @originalName from a JSDoc comment.
 * Returns the original name or undefined if not specified.
 *
 * Format: @originalName "Original Name With Spaces"
 * Example: @originalName "Email Column"
 */
export function parseOriginalNameFromJSDoc(statement: Statement | Node): string | undefined {
  const jsDocText = getJSDocText(statement);
  if (!jsDocText) {
    return undefined;
  }

  // Parse @originalName tag - expects quoted string
  // Format: @originalName "Name With Spaces"
  const match = jsDocText.match(/@originalName\s+"([^"]+)"/);
  return match ? match[1] : undefined;
}

/**
 * Parse @runAfter tags from a JSDoc comment.
 * Returns a map of action names to status arrays.
 *
 * Format: @runAfter ActionName: Status1, Status2
 * Example: @runAfter ProcessData: Failed, TimedOut
 * Special: @runAfter trigger (means parallel execution at top level - runAfter: {})
 * Special: @runAfter first (means first action in nested container - runAfter: {})
 */
export function parseRunAfterFromJSDoc(statement: Statement | Node): Record<string, StepResultStatus[]> | undefined {
  const jsDocText = getJSDocText(statement);
  if (!jsDocText) {
    return undefined;
  }

  // Check for special case: @runAfter trigger (means parallel execution at top level)
  if (/@runAfter\s+trigger\b/.test(jsDocText)) {
    return {};
  }

  // Check for special case: @runAfter first (means first action in nested container)
  if (/@runAfter\s+first\b/.test(jsDocText)) {
    return {};
  }

  // Parse @runAfter tags
  // Format: @runAfter ActionName: Status1, Status2
  // or:     @runAfter "ActionName:With:Colons": Status1, Status2
  // The regex handles both quoted and unquoted action names
  const runAfterRegex = /@runAfter\s+(?:"([^"]+)"|([^:@\s]+)):\s*([^@*]+)/g;
  const runAfter: Record<string, StepResultStatus[]> = {};
  let match;

  while ((match = runAfterRegex.exec(jsDocText)) !== null) {
    // match[1] = quoted action name, match[2] = unquoted action name, match[3] = statuses
    const actionName = (match[1] || match[2]).trim();
    const statusesStr = match[3].trim();
    const statuses = statusesStr
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0) as StepResultStatus[];

    if (actionName && statuses.length > 0) {
      runAfter[actionName] = statuses;
    }
  }

  return Object.keys(runAfter).length > 0 ? runAfter : undefined;
}

/**
 * Parse @runtimeConfig annotation from JSDoc comment.
 * Returns runtimeConfiguration object if present, undefined otherwise.
 * Format: @runtimeConfig {...} - full runtimeConfiguration as JSON
 */
export function parseParallelFromJSDoc(statement: Statement | Node): Record<string, any> | undefined {
  const jsDocText = getJSDocText(statement);
  if (!jsDocText) {
    return undefined;
  }

  // Parse @runtimeConfig tag
  // Format: @runtimeConfig {...json...}
  // Need to match balanced braces for nested JSON
  const runtimeConfigStart = jsDocText.indexOf('@runtimeConfig');
  if (runtimeConfigStart !== -1) {
    const jsonStart = jsDocText.indexOf('{', runtimeConfigStart);
    if (jsonStart !== -1) {
      // Find matching closing brace
      let depth = 0;
      let jsonEnd = jsonStart;
      for (let i = jsonStart; i < jsDocText.length; i++) {
        if (jsDocText[i] === '{') depth++;
        if (jsDocText[i] === '}') {
          depth--;
          if (depth === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }

      const jsonStr = jsDocText.substring(jsonStart, jsonEnd);
      try {
        return JSON.parse(jsonStr);
      } catch (e) {
        // Ignore parse errors
        return undefined;
      }
    }
  }

  return undefined;
}
/**
 * Parse @retryPolicy annotation from JSDoc comment.
 * Returns retryPolicy object if present, undefined otherwise.
 * Format: @retryPolicy {...} - full retryPolicy as JSON
 */
export function parseRetryPolicyFromJSDoc(statement: Statement | Node): Record<string, any> | undefined {
  const jsDocText = getJSDocText(statement);
  if (!jsDocText) {
    return undefined;
  }

  // Parse @retryPolicy tag
  // Format: @retryPolicy {...json...}
  // Need to match balanced braces for nested JSON
  const retryPolicyStart = jsDocText.indexOf('@retryPolicy');
  if (retryPolicyStart !== -1) {
    const jsonStart = jsDocText.indexOf('{', retryPolicyStart);
    if (jsonStart !== -1) {
      // Find matching closing brace
      let depth = 0;
      let jsonEnd = jsonStart;
      for (let i = jsonStart; i < jsDocText.length; i++) {
        if (jsDocText[i] === '{') depth++;
        if (jsDocText[i] === '}') {
          depth--;
          if (depth === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }

      const jsonStr = jsDocText.substring(jsonStart, jsonEnd);
      try {
        return JSON.parse(jsonStr);
      } catch (e) {
        // Ignore parse errors
        return undefined;
      }
    }
  }

  return undefined;
}

/**
 * Parse @trackedProperties annotation from JSDoc comment.
 * Returns trackedProperties object if present, undefined otherwise.
 * Format: @trackedProperties {...} - full trackedProperties as JSON
 */
export function parseTrackedPropertiesFromJSDoc(statement: Statement | Node): Record<string, string> | undefined {
  const jsDocText = getJSDocText(statement);
  if (!jsDocText) {
    return undefined;
  }

  // Parse @trackedProperties tag
  // Format: @trackedProperties {...json...}
  // Need to match balanced braces for nested JSON
  const trackedStart = jsDocText.indexOf('@trackedProperties');
  if (trackedStart !== -1) {
    const jsonStart = jsDocText.indexOf('{', trackedStart);
    if (jsonStart !== -1) {
      // Find matching closing brace
      let depth = 0;
      let jsonEnd = jsonStart;
      for (let i = jsonStart; i < jsDocText.length; i++) {
        if (jsDocText[i] === '{') depth++;
        if (jsDocText[i] === '}') {
          depth--;
          if (depth === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }

      const jsonStr = jsDocText.substring(jsonStart, jsonEnd);
      try {
        return JSON.parse(jsonStr);
      } catch (e) {
        // Ignore parse errors
        return undefined;
      }
    }
  }

  return undefined;
}

/**
 * Parse @paramsOmitted marker from JSDoc comment. Boolean tag, no value.
 * Indicates the source connector action had no `parameters` key.
 */
export function parseParamsOmittedFromJSDoc(statement: Statement | Node): boolean {
  const jsDocText = getJSDocText(statement);
  if (!jsDocText) return false;
  return /@paramsOmitted\b/.test(jsDocText);
}

/**
 * Parse @varNameCase annotation from JSDoc comment.
 * Format: @varNameCase "vcreatedByName"
 *
 * Preserves the source's case for the variable name when it differs from the
 * canonical (declared) casing. Used for setVariable / appendToArrayVariable etc.
 * to keep parity with PA exports byte-for-byte even though PA treats variable
 * names case-insensitively at runtime.
 */
export function parseVarNameCaseFromJSDoc(statement: Statement | Node): string | undefined {
  const jsDocText = getJSDocText(statement);
  if (!jsDocText) return undefined;
  const m = jsDocText.match(/@varNameCase\s+"((?:[^"\\]|\\.)*)"/);
  if (!m) return undefined;
  return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/**
 * Parse @valueArrayForm annotation from JSDoc comment.
 * Format: @valueArrayForm array | @valueArrayForm createArrayString
 *
 * Overrides the default array↔createArray heuristic for variable actions where
 * the source form (literal array vs `@createArray(...)` string) doesn't round-trip
 * cleanly through the default behavior.
 */
export function parseValueArrayFormFromJSDoc(statement: Statement | Node): 'array' | 'createArrayString' | undefined {
  const jsDocText = getJSDocText(statement);
  if (!jsDocText) return undefined;
  const m = jsDocText.match(/@valueArrayForm\s+(array|createArrayString)\b/);
  return m ? (m[1] as 'array' | 'createArrayString') : undefined;
}

/**
 * Parse @operationOptions annotation from JSDoc comment.
 * Format: @operationOptions "Asynchronous"
 */
export function parseOperationOptionsFromJSDoc(statement: Statement | Node): string | undefined {
  const jsDocText = getJSDocText(statement);
  if (!jsDocText) return undefined;

  const tagStart = jsDocText.indexOf('@operationOptions');
  if (tagStart === -1) return undefined;

  // Find the JSON-encoded string starting at the first " after the tag
  const quoteStart = jsDocText.indexOf('"', tagStart);
  if (quoteStart === -1) return undefined;

  // Find the matching closing quote, respecting JSON string escapes
  let i = quoteStart + 1;
  while (i < jsDocText.length) {
    if (jsDocText[i] === '\\') { i += 2; continue; }
    if (jsDocText[i] === '"') break;
    i++;
  }
  if (i >= jsDocText.length) return undefined;

  try {
    return JSON.parse(jsDocText.substring(quoteStart, i + 1));
  } catch {
    return undefined;
  }
}

/**
 * Parse @limit annotation from JSDoc comment.
 * Returns limit object or number if present, undefined otherwise.
 * Format: @limit 60 (number for do-until count)
 * Format: @limit {...} (object for action timeout like {"timeout":"PT2M"})
 */
export function parseLimitFromJSDoc(statement: Statement | Node): number | { timeout?: string } | undefined {
  const jsDocText = getJSDocText(statement);
  if (!jsDocText) {
    return undefined;
  }

  // Parse @limit tag
  const limitMatch = jsDocText.match(/@limit\s+(\S+)/);
  if (limitMatch) {
    const value = limitMatch[1];
    // Check if it's a JSON object (starts with {)
    if (value.startsWith('{')) {
      // Find matching closing brace for nested JSON
      const jsonStart = jsDocText.indexOf(value);
      let depth = 0;
      let jsonEnd = jsonStart;
      for (let i = jsonStart; i < jsDocText.length; i++) {
        if (jsDocText[i] === '{') depth++;
        if (jsDocText[i] === '}') {
          depth--;
          if (depth === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }
      const jsonStr = jsDocText.substring(jsonStart, jsonEnd);
      try {
        return JSON.parse(jsonStr);
      } catch (e) {
        return undefined;
      }
    } else {
      // It's a number
      const num = parseInt(value, 10);
      if (!isNaN(num)) {
        return num;
      }
    }
  }

  return undefined;
}

/**
 * Parse @varType annotation from JSDoc comment.
 * Returns the variable type string if present (e.g., 'float'), undefined otherwise.
 * This is used to preserve Power Automate variable types that differ from TypeScript inferred types.
 * Format: @varType float
 */
export function parseVarTypeFromJSDoc(statement: Statement | Node): string | undefined {
  const jsDocText = getJSDocText(statement);
  if (!jsDocText) {
    return undefined;
  }

  const match = jsDocText.match(/@varType\s+(\w+)/);
  if (match) {
    return match[1].toLowerCase();
  }

  return undefined;
}

/**
 * Parse @description annotation from JSDoc comment.
 * Returns the description string if present, undefined otherwise.
 * Format: @description Some description text
 * Note: Description can contain @ and * characters (e.g., expressions like @{variables('x')}).
 */
export function parseDescriptionFromJSDoc(statement: Statement | Node): string | undefined {
  const jsDocText = getJSDocText(statement);
  if (jsDocText) {
    // Match @description followed by text until the next known annotation or end of comment
    // Uses negative lookahead to stop at known JSDoc tags (not expressions like @{...})
    // Known tags: @metadata, @runAfter, @action, @type, @parallel, @limit, @originalName,
    //             @retryPolicy, @runtimeConfig, @conditionFormat, @varType, @trackedProperties,
    //             @operationOptions, @paramsOmitted, @valueArrayForm
    const match = jsDocText.match(
      /@description\s+([\s\S]*?)(?=\s*@(?:metadata|runAfter|action|type|parallel|limit|originalName|retryPolicy|runtimeConfig|conditionFormat|varType|trackedProperties|operationOptions|paramsOmitted|valueArrayForm|varNameCase)\b|\*\/|$)/
    );
    if (match) {
      // Trim whitespace - trailing spaces can't round-trip correctly due to JSDoc format
      return match[1].trim();
    }
    // JSDoc lacks an explicit @description tag (only structural tags like @runAfter,
    // @action, etc.) — look for plain comments ABOVE the JSDoc as the description.
    // This keeps `// note\n/** @runAfter X */\nctx.action(...)` round-tripping in
    // 'lineComment' descriptionStyle mode.
    const sourceFile = statement.getSourceFile();
    const fullText = sourceFile.getFullText();
    const stmtStart = statement.getStart();
    const jsDocPos = fullText.lastIndexOf(jsDocText, stmtStart);
    if (jsDocPos !== -1) {
      return getLeadingPlainCommentTextAt(fullText, jsDocPos);
    }
    return undefined;
  }

  // No JSDoc above the statement — fall back to plain // or block comments so that
  // ordinary TypeScript code comments round-trip via Logic Apps' action-level description field.
  return getLeadingPlainCommentText(statement);
}

/**
 * Parse @conditionFormat annotation from JSDoc comment.
 * Returns the condition format ('string' or 'object') if present, undefined otherwise.
 * This is used to preserve Power Automate condition format for parity.
 * Format: @conditionFormat string
 * Format: @conditionFormat object
 */
export function parseConditionFormatFromJSDoc(statement: Statement | Node): 'string' | 'object' | undefined {
  const jsDocText = getJSDocText(statement);
  if (!jsDocText) {
    return undefined;
  }

  const match = jsDocText.match(/@conditionFormat\s+(string|object)/);
  if (match) {
    return match[1] as 'string' | 'object';
  }

  return undefined;
}

/**
 * Parse @metadata annotation from JSDoc comment.
 * Returns metadata object if present, undefined otherwise.
 * Format: @metadata {...} - full metadata as JSON
 */
export function parseMetadataFromJSDoc(statement: Statement | Node): Record<string, any> | undefined {
  const jsDocText = getJSDocText(statement);
  if (!jsDocText) {
    return undefined;
  }

  // Parse @metadata tag
  // Format: @metadata {...json...}
  // Need to match balanced braces for nested JSON
  const metadataStart = jsDocText.indexOf('@metadata');
  if (metadataStart !== -1) {
    const jsonStart = jsDocText.indexOf('{', metadataStart);
    if (jsonStart !== -1) {
      // Find matching closing brace
      let depth = 0;
      let jsonEnd = jsonStart;
      for (let i = jsonStart; i < jsDocText.length; i++) {
        if (jsDocText[i] === '{') depth++;
        if (jsDocText[i] === '}') {
          depth--;
          if (depth === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }

      const jsonStr = jsDocText.substring(jsonStart, jsonEnd);
      try {
        return JSON.parse(jsonStr);
      } catch (e) {
        // Ignore parse errors
        return undefined;
      }
    }
  }

  return undefined;
}

/**
 * Check if a call expression is a ctx.* action method call.
 * Supports both direct calls (ctx.http) and typed connector calls (ctx.connectors.office365.SendEmailV2)
 * Also supports bracket notation for operations with invalid identifiers: ctx.connectors.powerappsforappmakers['Get-App']()
 */
export function isActionCall(node: CallExpression): boolean {
  const expression = node.getExpression();

  // Check for bracket notation: ctx.connectors.<connector>['operation']()
  if (expression.getKind() === SyntaxKind.ElementAccessExpression) {
    const typedConnectorInfo = parseTypedConnectorCall(node);
    return typedConnectorInfo !== null;
  }

  if (expression.getKind() !== SyntaxKind.PropertyAccessExpression) {
    return false;
  }

  const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const obj = propAccess.getExpression();

  // Check for typed connector pattern: ctx.connectors.<connector>.<operation>()
  // Also handles: ctx.connectors['connector'].Operation() (bracket notation for connector)
  if (obj.getKind() === SyntaxKind.PropertyAccessExpression ||
      obj.getKind() === SyntaxKind.ElementAccessExpression) {
    const typedConnectorInfo = parseTypedConnectorCall(node);
    return typedConnectorInfo !== null;
  }

  // Check for direct ctx.method() pattern
  if (obj.getKind() !== SyntaxKind.Identifier || obj.getText() !== 'ctx') {
    return false;
  }

  const methodName = propAccess.getName();

  // List of action methods (not reference methods)
  const actionMethods = [
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
  ];

  return actionMethods.includes(methodName);
}

/**
 * Parse a typed connector call pattern: ctx.connectors.<connector>.<operation>()
 * Also handles bracket notation for both connector and operation:
 * - ctx.connectors.connector.Operation()
 * - ctx.connectors.connector['Operation']()
 * - ctx.connectors['connector'].Operation()
 * - ctx.connectors['connector']['Operation']()
 * Returns { connector, operation } if valid, null otherwise.
 */
function parseTypedConnectorCall(node: CallExpression): { connector: string; operation: string } | null {
  const expression = node.getExpression();
  let operation: string;
  let connectorAccess: Expression;

  // Handle both dot notation and bracket notation for the operation
  if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
    // Dot notation for operation: ...connector.Operation()
    const operationAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    operation = operationAccess.getName();
    connectorAccess = operationAccess.getExpression();
  } else if (expression.getKind() === SyntaxKind.ElementAccessExpression) {
    // Bracket notation for operation: ...connector['Operation']()
    const operationAccess = expression.asKindOrThrow(SyntaxKind.ElementAccessExpression);
    const argument = operationAccess.getArgumentExpression();
    if (!argument || argument.getKind() !== SyntaxKind.StringLiteral) {
      return null;
    }
    operation = argument.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
    connectorAccess = operationAccess.getExpression();
  } else {
    return null;
  }

  // Handle both dot notation and bracket notation for the connector
  let connector: string;
  let connectorsAccess: Expression;

  if (connectorAccess.getKind() === SyntaxKind.PropertyAccessExpression) {
    // Dot notation for connector: ctx.connectors.connector
    const connectorPropAccess = connectorAccess.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    connector = connectorPropAccess.getName();
    connectorsAccess = connectorPropAccess.getExpression();
  } else if (connectorAccess.getKind() === SyntaxKind.ElementAccessExpression) {
    // Bracket notation for connector: ctx.connectors['connector']
    const connectorElementAccess = connectorAccess.asKindOrThrow(SyntaxKind.ElementAccessExpression);
    const connectorArg = connectorElementAccess.getArgumentExpression();
    if (!connectorArg || connectorArg.getKind() !== SyntaxKind.StringLiteral) {
      return null;
    }
    connector = connectorArg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
    connectorsAccess = connectorElementAccess.getExpression();
  } else {
    return null;
  }

  // Verify we have ctx.connectors
  if (connectorsAccess.getKind() !== SyntaxKind.PropertyAccessExpression) {
    return null;
  }

  const connectorsPropAccess = connectorsAccess.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  if (connectorsPropAccess.getName() !== 'connectors') {
    return null;
  }

  const ctxAccess = connectorsPropAccess.getExpression();
  if (ctxAccess.getKind() !== SyntaxKind.Identifier || ctxAccess.getText() !== 'ctx') {
    return null;
  }

  return { connector, operation };
}

/**
 * Convert a ctx.* call to an action node.
 * @param parentStatement Optional parent statement for parsing @runAfter JSDoc tags
 */
export function collectAction(
  node: CallExpression,
  ctx: TransformContext,
  parentStatement?: Statement
): ActionNode | ConnectorActionNode | null {
  const expression = node.getExpression();

  // Allow PropertyAccessExpression (dot notation) or ElementAccessExpression (bracket notation)
  if (expression.getKind() !== SyntaxKind.PropertyAccessExpression &&
      expression.getKind() !== SyntaxKind.ElementAccessExpression) {
    return null;
  }

  // Parse runAfter, runtimeConfiguration, retryPolicy, limit, trackedProperties, description, metadata, operationOptions, paramsOmitted from JSDoc if parent statement provided
  const runAfter = parentStatement ? parseRunAfterFromJSDoc(parentStatement) : undefined;
  const runtimeConfiguration = parentStatement ? parseParallelFromJSDoc(parentStatement) : undefined;
  const retryPolicy = parentStatement ? parseRetryPolicyFromJSDoc(parentStatement) : undefined;
  const limit = parentStatement ? parseLimitFromJSDoc(parentStatement) : undefined;
  const trackedProperties = parentStatement ? parseTrackedPropertiesFromJSDoc(parentStatement) : undefined;
  const description = parentStatement ? parseDescriptionFromJSDoc(parentStatement) : undefined;
  const metadata = parentStatement ? parseMetadataFromJSDoc(parentStatement) : undefined;
  const operationOptions = parentStatement ? parseOperationOptionsFromJSDoc(parentStatement) : undefined;
  const paramsOmitted = parentStatement ? parseParamsOmittedFromJSDoc(parentStatement) : false;

  // Check for typed connector pattern first: ctx.connectors.<connector>.<operation>()
  const typedConnectorInfo = parseTypedConnectorCall(node);
  if (typedConnectorInfo) {
    const args = node.getArguments() as Expression[];
    const actionNode = collectTypedConnectorAction(typedConnectorInfo.connector, typedConnectorInfo.operation, args, ctx);
    if (actionNode) {
      if (runAfter) actionNode.runAfter = runAfter;
      if (runtimeConfiguration) actionNode.runtimeConfiguration = runtimeConfiguration;
      if (retryPolicy) (actionNode as any).retryPolicy = retryPolicy;
      if (trackedProperties) (actionNode as any).trackedProperties = trackedProperties;
      if (description) actionNode.description = description;
      if (metadata) actionNode.metadata = metadata;
      if (operationOptions) (actionNode as any).operationOptions = operationOptions;
      if (paramsOmitted) (actionNode as any).paramsOmitted = true;
      // Apply limit if present (object for action timeout)
      if (limit && typeof limit === 'object') actionNode.limit = limit;
    }
    return actionNode;
  }

  const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const methodName = propAccess.getName();
  const args = node.getArguments() as Expression[];

  let actionNode: ActionNode | ConnectorActionNode | null = null;

  // Built-in actions
  switch (methodName) {
    case 'http':
      actionNode = collectHttpAction(args, ctx);
      break;

    case 'compose':
      actionNode = collectComposeAction(args, ctx);
      break;

    case 'saveFile':
      actionNode = collectSaveFileAction(args, ctx);
      break;

    case 'expression':
      actionNode = collectExpressionAction(args, ctx);
      break;

    case 'response':
      actionNode = collectResponseAction(args, ctx);
      break;

    case 'terminate':
      actionNode = collectTerminateAction(args, ctx);
      break;

    case 'delay':
      actionNode = collectDelayAction(args, ctx);
      break;

    case 'delayUntil':
      actionNode = collectDelayUntilAction(args, ctx);
      break;

    case 'callWorkflow':
      actionNode = collectWorkflowAction(args, ctx);
      break;

    case 'parseJson':
      actionNode = collectParseJsonAction(args, ctx);
      break;

    case 'join':
      actionNode = collectJoinAction(args, ctx);
      break;

    case 'select':
      actionNode = collectSelectAction(args, ctx);
      break;

    case 'filter':
    case 'filterArray':
      actionNode = collectFilterArrayAction(args, ctx);
      break;

    case 'createCsvTable':
      actionNode = collectCreateTableAction(args, ctx, 'Csv');
      break;

    case 'createHtmlTable':
      actionNode = collectCreateTableAction(args, ctx, 'Html');
      break;

    case 'appendToStringVariable': {
      const varName = getStringArg(args[0]);
      const value = transformValue(args[1], ctx);
      // Try to get action name from JSDoc, otherwise generate default
      const jsDocName = parentStatement ? parseActionNameFromJSDoc(parentStatement) : undefined;
      actionNode = {
        id: genActionId(),
        type: 'action',
        kind: 'appendtostringvariable',
        name: jsDocName || `Append_${varName}`,
        inputs: {
          name: varName,
          value,
        },
      };
      break;
    }

    case 'connector':
      actionNode = collectGenericConnectorAction(args, ctx);
      break;

    case 'connectorWebhook':
      actionNode = collectConnectorWebhookAction(args, ctx);
      break;
  }

  // Add runAfter, runtimeConfiguration, retryPolicy, limit, trackedProperties, description, metadata, operationOptions to the action node if present
  if (actionNode) {
    if (runAfter) actionNode.runAfter = runAfter;
    if (runtimeConfiguration) actionNode.runtimeConfiguration = runtimeConfiguration;
    if (retryPolicy) (actionNode as any).retryPolicy = retryPolicy;
    if (trackedProperties) (actionNode as any).trackedProperties = trackedProperties;
    if (description) actionNode.description = description;
    if (metadata) actionNode.metadata = metadata;
    if (operationOptions) (actionNode as any).operationOptions = operationOptions;
    // Apply limit if present (for connector/webhook/workflow actions with timeout)
    if (limit && typeof limit === 'object') {
      const nodeType = (actionNode as any).type;
      const nodeKind = (actionNode as any).kind;
      if (nodeType === 'connector' || nodeType === 'connectorwebhook' || (nodeType === 'action' && nodeKind === 'workflow')) {
        (actionNode as any).limit = limit;
      }
    }
  }

  return actionNode;
}

function collectHttpAction(args: Expression[], ctx: TransformContext): ActionNode {
  const name = getStringArg(args[0]);
  const inputs = getObjectArg(args[1], ctx);

  const actionInputs: any = {
    method: inputs.method,
    url: inputs.url,
    headers: inputs.headers,
    body: inputs.body,
  };
  // Optional fields (query string parameters, cookies)
  if (inputs.queries) {
    actionInputs.queries = inputs.queries;
  }
  if (inputs.cookie !== undefined) {
    actionInputs.cookie = inputs.cookie;
  }
  // Preserve authentication if present (OAuth, API Key, etc.)
  if (inputs.authentication) {
    actionInputs.authentication = inputs.authentication;
  }

  return {
    id: genActionId(),
    type: 'action',
    kind: 'http',
    name,
    inputs: actionInputs,
  } as ActionNode;
}

function collectComposeAction(args: Expression[], ctx: TransformContext): ActionNode {
  const name = getStringArg(args[0]);
  const value = transformValue(args[1], ctx);

  return {
    id: genActionId(),
    type: 'action',
    kind: 'compose',
    name,
    inputs: { value },
  } as ActionNode;
}

/**
 * ctx.saveFile('name', { contentType, content, fileName?, encoding? })
 * compiles to a plain Compose whose value carries the `@@ff:saveFile` sentinel.
 * In the Maker portal this is an ordinary Compose; the FlowForger engine/hosts
 * recognize the sentinel locally to write/download the file.
 */
function collectSaveFileAction(args: Expression[], ctx: TransformContext): ActionNode {
  const name = getStringArg(args[0]);
  const opts = getObjectArg(args[1], ctx) as {
    contentType?: any;
    content?: any;
    fileName?: any;
    encoding?: any;
  };

  const value: Record<string, any> = {
    '@@ff:saveFile': true,
    contentType: opts.contentType,
    content: opts.content,
  };
  if (opts.fileName !== undefined) value.fileName = opts.fileName;
  if (opts.encoding !== undefined) value.encoding = opts.encoding;

  return {
    id: genActionId(),
    type: 'action',
    kind: 'compose',
    name,
    inputs: { value },
  } as ActionNode;
}

function collectExpressionAction(args: Expression[], ctx: TransformContext): ActionNode {
  // ctx.expression("name", "expressionKind", { ...inputs })
  const name = getStringArg(args[0]);
  const expressionKind = getStringArg(args[1]);
  const restInputs = args[2] ? getObjectArg(args[2], ctx) : {};

  return {
    id: genActionId(),
    type: 'action',
    kind: 'expression',
    name,
    inputs: {
      expressionKind,
      ...restInputs,
    },
  } as ActionNode;
}

function collectResponseAction(args: Expression[], ctx: TransformContext): ActionNode {
  const name = getStringArg(args[0]);
  const statusCode = args[1] ? getNumericArg(args[1]) : 200;
  // Check for undefined identifier before transforming body
  const body = args[2] && args[2].getText() !== 'undefined' ? transformValue(args[2], ctx) : undefined;
  // Check for undefined identifier before calling getObjectArg
  const headers = args[3] && args[3].getText() !== 'undefined' ? getObjectArg(args[3], ctx) : undefined;
  const schema = args[4] && args[4].getText() !== 'undefined' ? getObjectArg(args[4], ctx) : undefined;
  const kind = args[5] ? getStringArg(args[5]) as 'VirtualAgent' | 'PowerApp' | undefined : undefined;

  const inputs: any = {
    statusCode,
  };

  // Only add body if present (not undefined)
  if (body !== undefined) {
    inputs.body = body;
  }

  // Only add headers if present
  if (headers !== undefined) {
    inputs.headers = headers;
  }

  // Add schema for Power Apps/Virtual Agents responses
  if (schema !== undefined) {
    inputs.schema = schema;
  }

  // Add kind for VirtualAgent/PowerApp responses
  if (kind === 'VirtualAgent' || kind === 'PowerApp') {
    inputs.kind = kind;
  }

  return {
    id: genActionId(),
    type: 'action',
    kind: 'response',
    name,
    inputs,
  } as ActionNode;
}

function collectTerminateAction(args: Expression[], ctx: TransformContext): ActionNode {
  const name = getStringArg(args[0]);
  const runStatus = getStringArg(args[1]) as 'Succeeded' | 'Cancelled' | 'Failed';
  const runError = args[2] ? getObjectArg(args[2], ctx) : undefined;

  return {
    id: genActionId(),
    type: 'action',
    kind: 'terminate',
    name,
    inputs: {
      runStatus,
      runError,
    },
  } as ActionNode;
}

function collectDelayAction(args: Expression[], ctx: TransformContext): ActionNode {
  const name = getStringArg(args[0]);
  // Use transformValue to handle both numbers and expressions (e.g., rand(1,360))
  const count = transformValue(args[1], ctx);
  const unit = getStringArg(args[2]);

  return {
    id: genActionId(),
    type: 'action',
    kind: 'delay',
    name,
    inputs: {
      interval: { count, unit },
    },
  } as ActionNode;
}

function collectDelayUntilAction(args: Expression[], ctx: TransformContext): ActionNode {
  const name = getStringArg(args[0]);
  const until = transformValue(args[1], ctx);

  return {
    id: genActionId(),
    type: 'action',
    kind: 'delayuntil',
    name,
    inputs: { until },
  } as ActionNode;
}

function collectWorkflowAction(args: Expression[], ctx: TransformContext): ActionNode {
  const name = getStringArg(args[0]);
  const workflowReferenceName = getStringArg(args[1]);
  const body = args[2] ? transformValue(args[2], ctx) : undefined;
  const headers = args[3] ? getObjectArg(args[3], ctx) : undefined;

  return {
    id: genActionId(),
    type: 'action',
    kind: 'workflow',
    name,
    inputs: {
      workflowReferenceName,
      body,
      headers,
    },
  } as ActionNode;
}

function collectParseJsonAction(args: Expression[], ctx: TransformContext): ActionNode {
  const name = getStringArg(args[0]);
  const from = transformValue(args[1], ctx);
  // Schema is typically a JSON Schema object, but real-world flows occasionally
  // use an array literal there (PA tools accept it). Preserve the source shape
  // rather than wrapping arrays in `{ value: "@createArray(...)" }`.
  let schema: any = undefined;
  if (args[2]) {
    schema = args[2].getKind() === SyntaxKind.ArrayLiteralExpression
      ? getArrayArg(args[2], ctx)
      : getObjectArg(args[2], ctx);
  }

  return {
    id: genActionId(),
    type: 'action',
    kind: 'parsejson',
    name,
    inputs: { from, schema },
  } as ActionNode;
}

function collectJoinAction(args: Expression[], ctx: TransformContext): ActionNode {
  const name = getStringArg(args[0]);
  const from = transformValue(args[1], ctx);
  const joinWith = getStringArg(args[2]);

  return {
    id: genActionId(),
    type: 'action',
    kind: 'join',
    name,
    inputs: { from, joinWith },
  } as ActionNode;
}

function collectSelectAction(args: Expression[], ctx: TransformContext): ActionNode {
  const name = getStringArg(args[0]);
  const from = transformValue(args[1], ctx);
  const select = transformValue(args[2], ctx);

  return {
    id: genActionId(),
    type: 'action',
    kind: 'select',
    name,
    inputs: { from, select },
  } as ActionNode;
}

function collectFilterArrayAction(args: Expression[], ctx: TransformContext): ActionNode {
  const name = getStringArg(args[0]);
  const from = transformValue(args[1], ctx);
  // The where-clause accepts either a literal PA expression string
  // (e.g. "@and(equals(item()?['type'], 'x'), ...)") OR a real TypeScript
  // expression that the transformer converts (e.g.
  // ctx.item()?.['type'] === 'x' && ctx.item()?.['isEnabled']). For a string
  // literal, transformValue returns the literal as-is; for a call/binary
  // expression it returns the "@..."-prefixed PA expression.
  const whereValue = transformValue(args[2], ctx);
  const where = typeof whereValue === 'string' ? whereValue : String(whereValue);

  return {
    id: genActionId(),
    type: 'action',
    kind: 'filterarray',
    name,
    inputs: { from, where },
  } as ActionNode;
}

function collectCreateTableAction(
  args: Expression[],
  ctx: TransformContext,
  format: 'Csv' | 'Html'
): ActionNode {
  const name = getStringArg(args[0]);
  const from = transformValue(args[1], ctx);
  const columns = args[2] ? getArrayArg(args[2], ctx) : undefined;

  return {
    id: genActionId(),
    type: 'action',
    kind: format === 'Csv' ? 'createcsvtable' : 'createhtmltable',
    name,
    inputs: { from, columns },
  } as ActionNode;
}

function collectGenericConnectorAction(args: Expression[], ctx: TransformContext): ConnectorActionNode {
  const name = getStringArg(args[0]);
  const connector = getStringArg(args[1]);
  const operation = getStringArg(args[2]);
  const rawParams = getObjectArg(args[3], ctx);
  // Flatten nested objects to "parent/child" format for Power Automate compatibility
  const params = needsFlattening(rawParams) ? flattenParams(rawParams) : rawParams;
  const connectionReferenceName = args[4] && args[4].getText() !== 'undefined' ? getStringArg(args[4]) : undefined;
  // Parse 6th argument as authentication
  const authentication = args[5] ? transformValue(args[5], ctx) : undefined;

  const node: ConnectorActionNode = {
    id: genConnectorId(),
    type: 'connector',
    name,
    connector,
    operation,
    params,
    connectionReferenceName,
  };
  if (authentication) (node as any).authentication = authentication;
  return node;
}

/**
 * Collect a typed connector action: ctx.connectors.<connector>.<operation>(name, params, connRef?)
 */
function collectTypedConnectorAction(
  connector: string,
  operation: string,
  args: Expression[],
  ctx: TransformContext
): ConnectorActionNode {
  const name = getStringArg(args[0]);
  const rawParams = getObjectArg(args[1], ctx);
  // Flatten nested objects to "parent/child" format for Power Automate compatibility
  const params = needsFlattening(rawParams) ? flattenParams(rawParams) : rawParams;
  const connectionReferenceName = args[2] && args[2].getText() !== 'undefined' ? getStringArg(args[2]) : undefined;
  // Parse 4th argument as authentication (e.g., ctx.parameters('$authentication'))
  const authentication = args[3] ? transformValue(args[3], ctx) : undefined;

  const node: ConnectorActionNode = {
    id: genConnectorId(),
    type: 'connector',
    name,
    connector,
    operation,
    params,
    connectionReferenceName,
  };
  if (authentication) (node as any).authentication = authentication;
  return node;
}

function collectConnectorWebhookAction(args: Expression[], ctx: TransformContext): any {
  const name = getStringArg(args[0]);
  const connector = getStringArg(args[1]);
  const operation = getStringArg(args[2]);
  const rawParams = getObjectArg(args[3], ctx);
  // Flatten nested objects to "parent/child" format for Power Automate compatibility
  const params = needsFlattening(rawParams) ? flattenParams(rawParams) : rawParams;
  const connectionReferenceName = args[4] && args[4].getText() !== 'undefined' ? getStringArg(args[4]) : undefined;
  // Parse 6th argument as authentication
  const authentication = args[5] ? transformValue(args[5], ctx) : undefined;

  const node: any = {
    id: genConnectorId(),
    type: 'connectorwebhook',
    name,
    connector,
    operation,
    params,
    connectionReferenceName,
  };
  if (authentication) node.authentication = authentication;
  return node;
}

// Helper functions

function getStringArg(arg: Expression): string {
  if (arg.getKind() === SyntaxKind.StringLiteral) {
    return arg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
  }
  // Fallback: strip quotes
  const text = arg.getText();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1);
  }
  return text;
}

function getNumericArg(arg: Expression): number {
  if (arg.getKind() === SyntaxKind.NumericLiteral) {
    return Number(arg.getText());
  }
  return Number(arg.getText());
}

function getObjectArg(arg: Expression, ctx: TransformContext): Record<string, any> {
  if (arg.getKind() === SyntaxKind.ObjectLiteralExpression) {
    return parseObjectLiteral(arg.asKindOrThrow(SyntaxKind.ObjectLiteralExpression), ctx);
  }
  // Return as expression
  return { value: transformExpression(arg, ctx) };
}

function getArrayArg(arg: Expression, ctx: TransformContext): any[] {
  if (arg.getKind() === SyntaxKind.ArrayLiteralExpression) {
    const arr = arg.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
    return arr.getElements().map(el => transformValue(el, ctx));
  }
  return [];
}

function parseObjectLiteral(
  obj: ObjectLiteralExpression,
  ctx: TransformContext
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const prop of obj.getProperties()) {
    if (prop.getKind() === SyntaxKind.PropertyAssignment) {
      const assignment = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
      // Use the name node so string-literal keys decode escape sequences
      // (e.g. `"Accept\n"` → "Accept" + newline rather than literal backslash+n).
      const nameNode = assignment.getNameNode();
      let name: string;
      if (nameNode.getKind() === SyntaxKind.StringLiteral) {
        name = nameNode.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
      } else {
        name = assignment.getName();
        if ((name.startsWith("'") && name.endsWith("'")) || (name.startsWith('"') && name.endsWith('"'))) {
          name = name.slice(1, -1);
        }
      }
      const init = assignment.getInitializer();

      if (init) {
        result[name] = transformValue(init, ctx);
      }
    } else if (prop.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
      const shorthand = prop.asKindOrThrow(SyntaxKind.ShorthandPropertyAssignment);
      const name = shorthand.getName();
      result[name] = transformExpression(shorthand.getNameNode(), ctx);
    } else if (prop.getKind() === SyntaxKind.SpreadAssignment) {
      // Spread: { ...other }
      const spread = prop.asKindOrThrow(SyntaxKind.SpreadAssignment);
      const spreadExpr = transformExpression(spread.getExpression(), ctx);
      result['...'] = spreadExpr;
    }
  }

  return result;
}

function transformValue(node: Expression, ctx: TransformContext): any {
  const kind = node.getKind();

  switch (kind) {
    case SyntaxKind.StringLiteral:
      return node.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();

    case SyntaxKind.NumericLiteral:
      return Number(node.getText());

    case SyntaxKind.TrueKeyword:
      return true;

    case SyntaxKind.FalseKeyword:
      return false;

    case SyntaxKind.NullKeyword:
      return null;

    case SyntaxKind.ObjectLiteralExpression:
      return parseObjectLiteral(node.asKindOrThrow(SyntaxKind.ObjectLiteralExpression), ctx);

    case SyntaxKind.ArrayLiteralExpression: {
      const arr = node.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
      return arr.getElements().map(el => transformValue(el, ctx));
    }

    case SyntaxKind.TemplateExpression:
    case SyntaxKind.NoSubstitutionTemplateLiteral: {
      // Template literals use inline @{...} format for string values
      return transformTemplateStringInline(node, ctx);
    }

    case SyntaxKind.TaggedTemplateExpression: {
      // Check for ctx.odata`...` tagged templates
      if (isODataTaggedTemplate(node)) {
        return transformODataTaggedTemplate(node.asKindOrThrow(SyntaxKind.TaggedTemplateExpression));
      }
      // Fall through to default for other tagged templates
    }
    // eslint-disable-next-line no-fallthrough
    case SyntaxKind.CallExpression: {
      // Check for ctx.odata.* calls
      if (isODataCall(node)) {
        return transformODataCall(node.asKindOrThrow(SyntaxKind.CallExpression));
      }
      // Fall through to default for other call expressions
    }
    // eslint-disable-next-line no-fallthrough
    default: {
      // For complex expressions, transform to PA expression
      const expr = transformExpression(node, ctx);
      // Ensure expression starts with @ for Power Automate
      // But don't add @ prefix if:
      // - Expression already starts with @
      // - Expression contains @{...} template markers (mixed string)
      if (expr && !expr.startsWith('@') && !expr.includes('@{')) {
        return `@${expr}`;
      }
      return expr;
    }
  }
}
