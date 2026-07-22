/**
 * Main Transformer
 * Orchestrates the transformation of TypeScript native DSL to FlowIR.
 */

import { Project, ClassDeclaration, MethodDeclaration, Statement, SyntaxKind, SourceFile, VariableDeclarationKind, Expression } from 'ts-morph';
import type { FlowIR, Node, TriggerNode, RecurrenceTriggerNode, ConnectionReference, FlowParameter, FlowMetadata, ScopeNode, ActionNode, FlowForgerConfig, ChildFlowDefinition } from '@flowforger/ir';
import { getLoggingConfig } from '@flowforger/ir';
import { resetIdCounter, genTriggerId, genActionId, genScopeId } from '../utils/id-generator.js';
import { createTransformContext, transformExpression } from './expression-transformer.js';
import type { TransformContext } from './expression-transformer.js';
import { VariableTracker, transformValueWithExpressions } from '../analyzers/variable-tracker.js';
import { isActionCall, collectAction, parseActionNameFromJSDoc, parseTypeFromJSDoc, parseRunAfterFromJSDoc, parseParallelFromJSDoc, parseRetryPolicyFromJSDoc, parseTrackedPropertiesFromJSDoc, parseMetadataFromJSDoc, parseDescriptionFromJSDoc, parseValueArrayFormFromJSDoc, getLeadingPlainCommentText, getLeadingPlainCommentTextAt } from '../analyzers/action-collector.js';
import {
  analyzeIfStatement,
  analyzeForOfStatement,
  analyzeSwitchStatement,
  analyzeWhileStatement,
  analyzeDoWhileStatement,
  getLoopVariableName,
  createLoopContext,
} from '../analyzers/control-flow-analyzer.js';

export interface TransformOptions {
  /** File path for the source file */
  filePath?: string;
  /** TypeScript source code (if not loading from file) */
  sourceCode?: string;
  /** FlowForger configuration for controlling behavior */
  config?: FlowForgerConfig;
}

export interface TransformResult {
  /** The generated FlowIR */
  ir: FlowIR;
  /** Any warnings generated during transformation */
  warnings: string[];
  /** Any errors encountered */
  errors: string[];
}

/**
 * Transform a TypeScript file containing native DSL to FlowIR.
 */
export async function transformFile(filePath: string, config?: FlowForgerConfig): Promise<FlowIR> {
  const loggingConfig = getLoggingConfig(config);
  if (loggingConfig.verbose) {
    //console.error('[FlowForger] Converting: DSL → IR');
  }

  const project = new Project({
    tsConfigFilePath: undefined,
    skipAddingFilesFromTsConfig: true,
  });

  const sourceFile = project.addSourceFileAtPath(filePath);
  return transformSourceFile(sourceFile);
}

/**
 * Transform TypeScript source code to FlowIR.
 */
export function transformCode(sourceCode: string, fileName = 'flow.ts', config?: FlowForgerConfig): FlowIR {
  const loggingConfig = getLoggingConfig(config);
  if (loggingConfig.verbose) {
    //console.error('[FlowForger] Converting: DSL → IR');
  }

  const project = new Project({
    tsConfigFilePath: undefined,
    skipAddingFilesFromTsConfig: true,
    useInMemoryFileSystem: true,
  });

  const sourceFile = project.createSourceFile(fileName, sourceCode);
  return transformSourceFile(sourceFile);
}

/**
 * Transform a ts-morph SourceFile to FlowIR.
 */
function transformSourceFile(sourceFile: SourceFile): FlowIR {
  // Reset ID counter for fresh IDs
  resetIdCounter();

  // Find the class with @Flow decorator
  const flowClass = findFlowClass(sourceFile);
  if (!flowClass) {
    throw new Error('No class with @Flow decorator found');
  }

  // Extract flow name and description from decorator
  const flowName = extractFlowName(flowClass);
  const flowDescription = extractFlowDescription(flowClass) || extractClassJSDocDescription(flowClass) || extractFileJSDocDescription(sourceFile);
  const flowWorkflowId = extractFlowWorkflowId(flowClass);

  // Try to extract from constructor first (new style: ctx.flow.*)
  const constructorConfig = extractFromConstructor(flowClass);

  // Fall back to class properties (legacy style: this.*)
  const connectionReferences = constructorConfig.connectionReferences || extractConnectionReferences(flowClass);
  const parameters = constructorConfig.parameters || extractParameters(flowClass);
  const metadata = constructorConfig.metadata || extractMetadata(flowClass);
  const workflowMetadata = constructorConfig.workflowMetadata;
  const outputs = constructorConfig.outputs;
  const staticResults = constructorConfig.staticResults;
  const childFlows = constructorConfig.childFlows;

  // Find trigger method
  const triggerMethod = findTriggerMethod(flowClass);
  if (!triggerMethod) {
    throw new Error('No trigger method found (missing @HttpTrigger, @ManualTrigger, or @RecurrenceTrigger)');
  }

  // Find action method
  const actionMethod = findActionMethod(flowClass);
  if (!actionMethod) {
    throw new Error('No action method found (missing @Action decorator)');
  }

  // Create transform context
  const ctx = createTransformContext();
  const variableTracker = new VariableTracker();

  // Generate trigger node (pass ctx to track parameter references)
  const triggerNode = generateTriggerNode(triggerMethod, ctx);

  // Process action method body
  const actionNodes = processMethodBody(actionMethod, ctx, variableTracker);

  // Assemble FlowIR
  const ir: FlowIR = {
    name: flowName,
    nodes: [triggerNode, ...actionNodes],
  };

  // Add description if present
  if (flowDescription) {
    ir.description = flowDescription;
  }

  // Add workflowId if present
  if (flowWorkflowId) {
    ir.workflowId = flowWorkflowId;
  }

  // Add connection references if present
  if (connectionReferences) {
    ir.connectionReferences = connectionReferences;
  }

  // Add parameters if present
  if (parameters) {
    ir.parameters = parameters;
  }

  // Add metadata if present
  if (metadata) {
    ir.metadata = metadata;
  }

  // Add workflow-level metadata (definition.metadata) if present
  if (workflowMetadata) {
    ir.workflowMetadata = workflowMetadata;
  }

  // Add outputs if present (even if empty, for parity)
  if (outputs !== undefined) {
    ir.outputs = outputs;
  }

  // Add staticResults if present (for testing mock responses)
  if (staticResults !== undefined) {
    ir.staticResults = staticResults;
  }

  // Add childFlows if present
  if (childFlows) {
    ir.childFlows = childFlows;
  }

  // Validate parameter references
  validateParameterReferences(ctx, parameters);

  return ir;
}

/**
 * Validate that all referenced parameters exist in the defined parameters.
 *
 * Some real-world flows reference parameters (`@parameters('X')`) without
 * declaring them in `definition.parameters` — this is invalid PA JSON in spirit
 * but PA tools accept it, so we have to round-trip those flows too. We don't
 * throw on undefined references; the IR keeps the dangling reference and the
 * emitter writes it back verbatim. Diagnostics surface this via DSL015 already.
 */
function validateParameterReferences(
  _ctx: TransformContext,
  _definedParameters: Record<string, FlowParameter> | undefined
): void {
  // No-op for parity. See doc-comment.
}

/**
 * Find the class with @Flow decorator in the source file.
 */
function findFlowClass(sourceFile: SourceFile): ClassDeclaration | undefined {
  const classes = sourceFile.getClasses();

  for (const cls of classes) {
    const decorators = cls.getDecorators();
    for (const decorator of decorators) {
      if (decorator.getName() === 'Flow') {
        return cls;
      }
    }
  }

  return undefined;
}

/**
 * Extract the flow name from the @Flow decorator.
 * Supports both string and object formats:
 * - @Flow("name")
 * - @Flow({ name: "name", description: "desc" })
 */
function extractFlowName(flowClass: ClassDeclaration): string {
  const decorators = flowClass.getDecorators();

  for (const decorator of decorators) {
    if (decorator.getName() === 'Flow') {
      const args = decorator.getArguments();
      if (args.length > 0) {
        const firstArg = args[0];
        if (firstArg.getKind() === SyntaxKind.StringLiteral) {
          return firstArg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
        }
        // Handle object literal: @Flow({ name: "...", description: "..." })
        if (firstArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
          const obj = firstArg.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
          for (const prop of obj.getProperties()) {
            if (prop.getKind() === SyntaxKind.PropertyAssignment) {
              const assignment = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
              if (assignment.getName() === 'name') {
                const value = assignment.getInitializer();
                if (value && value.getKind() === SyntaxKind.StringLiteral) {
                  return value.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
                }
              }
            }
          }
        }
      }
    }
  }

  // Fallback to class name
  return flowClass.getName() || 'UnnamedFlow';
}

/**
 * Extract the flow description from the @Flow decorator.
 * Only works with object format: @Flow({ name: "name", description: "desc" })
 */
function extractFlowDescription(flowClass: ClassDeclaration): string | undefined {
  const decorators = flowClass.getDecorators();

  for (const decorator of decorators) {
    if (decorator.getName() === 'Flow') {
      const args = decorator.getArguments();
      if (args.length > 0) {
        const firstArg = args[0];
        // Handle object literal: @Flow({ name: "...", description: "..." })
        if (firstArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
          const obj = firstArg.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
          for (const prop of obj.getProperties()) {
            if (prop.getKind() === SyntaxKind.PropertyAssignment) {
              const assignment = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
              if (assignment.getName() === 'description') {
                const value = assignment.getInitializer();
                if (value && value.getKind() === SyntaxKind.StringLiteral) {
                  return value.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
                }
              }
            }
          }
        }
      }
    }
  }

  return undefined;
}

/**
 * Extract the flow workflowId from the @Flow decorator.
 * Only works with object format: @Flow({ name: "...", workflowId: "..." })
 * Throws if workflowId is present but not a string literal.
 */
function extractFlowWorkflowId(flowClass: ClassDeclaration): string | undefined {
  const decorators = flowClass.getDecorators();

  for (const decorator of decorators) {
    if (decorator.getName() === 'Flow') {
      const args = decorator.getArguments();
      if (args.length > 0) {
        const firstArg = args[0];
        if (firstArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
          const obj = firstArg.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
          for (const prop of obj.getProperties()) {
            if (prop.getKind() === SyntaxKind.PropertyAssignment) {
              const assignment = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
              if (assignment.getName() === 'workflowId') {
                const value = assignment.getInitializer();
                if (value && value.getKind() === SyntaxKind.StringLiteral) {
                  return value.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
                }
                throw new Error('@Flow.workflowId must be a string literal GUID');
              }
            }
          }
        }
      }
    }
  }

  return undefined;
}

/**
 * Extract the flow description from the class-level JSDoc comment.
 * Strips JSDoc artifacts (/ **, * /, leading * ) and trims.
 */
function extractClassJSDocDescription(flowClass: ClassDeclaration): string | undefined {
  const jsDocs = flowClass.getJsDocs();
  if (jsDocs.length === 0) return undefined;

  const jsDoc = jsDocs[0];
  const fullText = jsDoc.getText();

  // Strip /** and */ delimiters, then clean each line
  const lines = fullText
    .replace(/^\/\*\*\s*/, '')
    .replace(/\s*\*\/\s*$/, '')
    .split('\n')
    .map(line => line.replace(/^\s*\*? ?/, ''));

  const result = lines.join('\n').trim();
  return result || undefined;
}

/**
 * Extract description from a file-level JSDoc comment (above imports).
 * Falls back to this when no class-level JSDoc exists.
 */
function extractFileJSDocDescription(sourceFile: SourceFile): string | undefined {
  const firstStatement = sourceFile.getStatements()[0];
  if (!firstStatement) return undefined;

  const leadingCommentRanges = firstStatement.getLeadingCommentRanges();
  for (const range of leadingCommentRanges) {
    const text = range.getText();
    if (text.startsWith('/**')) {
      // Same cleanup as extractClassJSDocDescription
      const lines = text
        .replace(/^\/\*\*\s*/, '')
        .replace(/\s*\*\/\s*$/, '')
        .split('\n')
        .map(line => line.replace(/^\s*\*? ?/, ''));

      const result = lines.join('\n').trim();
      return result || undefined;
    }
  }

  return undefined;
}

/**
 * Extract connection references from the class property `connectionReferences`.
 */
function extractConnectionReferences(flowClass: ClassDeclaration): Record<string, ConnectionReference> | undefined {
  // Look for a property named 'connectionReferences'
  const properties = flowClass.getProperties();

  for (const prop of properties) {
    if (prop.getName() === 'connectionReferences') {
      const initializer = prop.getInitializer();
      if (initializer && initializer.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const obj = initializer.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
        const result: Record<string, ConnectionReference> = {};

        for (const propNode of obj.getProperties()) {
          if (propNode.getKind() === SyntaxKind.PropertyAssignment) {
            const assignment = propNode.asKindOrThrow(SyntaxKind.PropertyAssignment);
            const refName = assignment.getName();
            // Handle string literal keys (e.g., 'shared_sharepointonline')
            const actualName = refName.startsWith("'") || refName.startsWith('"')
              ? refName.slice(1, -1)
              : refName;

            const valueNode = assignment.getInitializer();
            if (valueNode && valueNode.getKind() === SyntaxKind.ObjectLiteralExpression) {
              const valueObj = parseObjectLiteralArg(valueNode);
              result[actualName] = {
                apiId: valueObj.apiId || '',
                ...(valueObj.connectionReferenceLogicalName && { connectionReferenceLogicalName: valueObj.connectionReferenceLogicalName }),
                ...(valueObj.connectionName && { connectionName: valueObj.connectionName }),
                ...(valueObj.runtimeSource && { runtimeSource: valueObj.runtimeSource }),
                ...(valueObj.impersonation && { impersonation: valueObj.impersonation }),
              };
            }
          }
        }

        if (Object.keys(result).length > 0) {
          return result;
        }
      }
    }
  }

  return undefined;
}

/**
 * Extract parameters from the class property `parameters`.
 */
function extractParameters(flowClass: ClassDeclaration): Record<string, FlowParameter> | undefined {
  const properties = flowClass.getProperties();

  for (const prop of properties) {
    if (prop.getName() === 'parameters') {
      const initializer = prop.getInitializer();
      if (initializer && initializer.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const obj = initializer.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
        const result: Record<string, FlowParameter> = {};

        for (const propNode of obj.getProperties()) {
          if (propNode.getKind() === SyntaxKind.PropertyAssignment) {
            const assignment = propNode.asKindOrThrow(SyntaxKind.PropertyAssignment);
            const paramName = assignment.getName();
            // Handle string literal keys
            const actualName = paramName.startsWith("'") || paramName.startsWith('"')
              ? paramName.slice(1, -1)
              : paramName;

            const valueNode = assignment.getInitializer();
            if (valueNode && valueNode.getKind() === SyntaxKind.ObjectLiteralExpression) {
              const valueObj = parseObjectLiteralArg(valueNode);
              result[actualName] = {
                type: valueObj.type || 'String',
                defaultValue: valueObj.defaultValue,
                allowedValues: valueObj.allowedValues,
                metadata: valueObj.metadata,
              };
            }
          }
        }

        if (Object.keys(result).length > 0) {
          return result;
        }
      }
    }
  }

  return undefined;
}

/**
 * Extract metadata from the class property `metadata`.
 */
function extractMetadata(flowClass: ClassDeclaration): FlowMetadata | undefined {
  const properties = flowClass.getProperties();

  for (const prop of properties) {
    if (prop.getName() === 'metadata') {
      const initializer = prop.getInitializer();
      if (initializer && initializer.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const valueObj = parseObjectLiteralArg(initializer);
        const result: FlowMetadata = {};

        if (valueObj.schemaVersion) result.schemaVersion = valueObj.schemaVersion;
        if (valueObj.contentVersion) result.contentVersion = valueObj.contentVersion;
        if (valueObj.$schema) result.$schema = valueObj.$schema;

        if (Object.keys(result).length > 0) {
          return result;
        }
      }
    }
  }

  return undefined;
}

/**
 * Result of extracting flow configuration from constructor.
 */
interface ConstructorConfig {
  metadata?: FlowMetadata;
  workflowMetadata?: Record<string, any>;
  connectionReferences?: Record<string, ConnectionReference>;
  parameters?: Record<string, FlowParameter>;
  outputs?: Record<string, any>;
  staticResults?: Record<string, any>;
  childFlows?: Record<string, ChildFlowDefinition>;
}

/**
 * Extract flow configuration from the constructor.
 * Looks for assignments like:
 *   ctx.flow.metadata = { ... }
 *   ctx.flow.connectionReferences = { ... }
 *   ctx.flow.parameters = { ... }
 */
function extractFromConstructor(flowClass: ClassDeclaration): ConstructorConfig {
  const result: ConstructorConfig = {};

  // Find the constructor
  const constructors = flowClass.getConstructors();
  if (constructors.length === 0) {
    return result;
  }

  const constructor = constructors[0];
  const body = constructor.getBody();
  if (!body || body.getKind() !== SyntaxKind.Block) {
    return result;
  }

  // Get the parameter name (usually 'ctx')
  const params = constructor.getParameters();
  if (params.length === 0) {
    return result;
  }
  const ctxParamName = params[0].getName();

  const block = body.asKindOrThrow(SyntaxKind.Block);
  const statements = block.getStatements();

  for (const stmt of statements) {
    if (stmt.getKind() !== SyntaxKind.ExpressionStatement) {
      continue;
    }

    const exprStmt = stmt.asKindOrThrow(SyntaxKind.ExpressionStatement);
    const expr = exprStmt.getExpression();

    if (expr.getKind() !== SyntaxKind.BinaryExpression) {
      continue;
    }

    const binary = expr.asKindOrThrow(SyntaxKind.BinaryExpression);
    const operator = binary.getOperatorToken().getKind();

    if (operator !== SyntaxKind.EqualsToken) {
      continue;
    }

    const left = binary.getLeft();
    const right = binary.getRight();

    // Check for ctx.flow.* pattern
    const leftText = left.getText();

    if (leftText === `${ctxParamName}.flow.metadata`) {
      if (right.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const valueObj = parseObjectLiteralArg(right);
        const metadata: FlowMetadata = {};
        if (valueObj.schemaVersion) metadata.schemaVersion = valueObj.schemaVersion;
        if (valueObj.contentVersion) metadata.contentVersion = valueObj.contentVersion;
        if (valueObj.$schema) metadata.$schema = valueObj.$schema;
        if (Object.keys(metadata).length > 0) {
          result.metadata = metadata;
        }
      }
    } else if (leftText === `${ctxParamName}.flow.workflowMetadata`) {
      if (right.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const valueObj = parseObjectLiteralArg(right);
        if (Object.keys(valueObj).length > 0) {
          result.workflowMetadata = valueObj;
        }
      }
    } else if (leftText === `${ctxParamName}.flow.connectionReferences`) {
      if (right.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const obj = right.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
        const refs: Record<string, ConnectionReference> = {};

        for (const propNode of obj.getProperties()) {
          if (propNode.getKind() === SyntaxKind.PropertyAssignment) {
            const assignment = propNode.asKindOrThrow(SyntaxKind.PropertyAssignment);
            let refName = assignment.getName();
            // Handle string literal keys
            if (refName.startsWith("'") || refName.startsWith('"')) {
              refName = refName.slice(1, -1);
            }

            const valueNode = assignment.getInitializer();
            if (valueNode && valueNode.getKind() === SyntaxKind.ObjectLiteralExpression) {
              const valueObj = parseObjectLiteralArg(valueNode);
              refs[refName] = {
                apiId: valueObj.apiId || '',
                ...(valueObj.connectionReferenceLogicalName && { connectionReferenceLogicalName: valueObj.connectionReferenceLogicalName }),
                ...(valueObj.connectionName && { connectionName: valueObj.connectionName }),
                ...(valueObj.runtimeSource && { runtimeSource: valueObj.runtimeSource }),
                ...(valueObj.impersonation && { impersonation: valueObj.impersonation }),
              };
            }
          }
        }

        if (Object.keys(refs).length > 0) {
          result.connectionReferences = refs;
        }
      }
    } else if (leftText === `${ctxParamName}.flow.parameters`) {
      if (right.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const obj = right.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
        const params: Record<string, FlowParameter> = {};

        for (const propNode of obj.getProperties()) {
          if (propNode.getKind() === SyntaxKind.PropertyAssignment) {
            const assignment = propNode.asKindOrThrow(SyntaxKind.PropertyAssignment);
            let paramName = assignment.getName();
            // Handle string literal keys
            if (paramName.startsWith("'") || paramName.startsWith('"')) {
              paramName = paramName.slice(1, -1);
            }

            const valueNode = assignment.getInitializer();
            if (valueNode && valueNode.getKind() === SyntaxKind.ObjectLiteralExpression) {
              const valueObj = parseObjectLiteralArg(valueNode);
              params[paramName] = {
                type: valueObj.type || 'String',
                defaultValue: valueObj.defaultValue,
                allowedValues: valueObj.allowedValues,
                metadata: valueObj.metadata,
              };
            }
          }
        }

        if (Object.keys(params).length > 0) {
          result.parameters = params;
        }
      }
    } else if (leftText === `${ctxParamName}.flow.outputs`) {
      if (right.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const obj = right.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
        const outputs: Record<string, any> = {};

        for (const propNode of obj.getProperties()) {
          if (propNode.getKind() === SyntaxKind.PropertyAssignment) {
            const assignment = propNode.asKindOrThrow(SyntaxKind.PropertyAssignment);
            let outputName = assignment.getName();
            // Handle string literal keys
            if (outputName.startsWith("'") || outputName.startsWith('"')) {
              outputName = outputName.slice(1, -1);
            }

            const valueNode = assignment.getInitializer();
            if (valueNode) {
              const valueObj = parseObjectLiteralArg(valueNode);
              outputs[outputName] = valueObj;
            }
          }
        }

        // Always set outputs, even if empty (for parity)
        result.outputs = outputs;
      }
    } else if (leftText === `${ctxParamName}.flow.staticResults`) {
      if (right.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const obj = right.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
        const staticResults: Record<string, any> = {};

        for (const propNode of obj.getProperties()) {
          if (propNode.getKind() === SyntaxKind.PropertyAssignment) {
            const assignment = propNode.asKindOrThrow(SyntaxKind.PropertyAssignment);
            let resultName = assignment.getName();
            // Handle string literal keys
            if (resultName.startsWith("'") || resultName.startsWith('"')) {
              resultName = resultName.slice(1, -1);
            }

            const valueNode = assignment.getInitializer();
            if (valueNode) {
              const valueObj = parseObjectLiteralArg(valueNode);
              staticResults[resultName] = valueObj;
            }
          }
        }

        // Always set staticResults, even if empty (for parity)
        result.staticResults = staticResults;
      }
    } else if (leftText === `${ctxParamName}.flow.childFlows`) {
      if (right.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const obj = right.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
        const childFlows: Record<string, ChildFlowDefinition> = {};

        for (const propNode of obj.getProperties()) {
          if (propNode.getKind() === SyntaxKind.PropertyAssignment) {
            const assignment = propNode.asKindOrThrow(SyntaxKind.PropertyAssignment);
            let flowName = assignment.getName();
            if (flowName.startsWith("'") || flowName.startsWith('"')) {
              flowName = flowName.slice(1, -1);
            }

            const valueNode = assignment.getInitializer();
            if (valueNode && valueNode.getKind() === SyntaxKind.ObjectLiteralExpression) {
              const valueObj = parseObjectLiteralArg(valueNode);
              const def: ChildFlowDefinition = {
                workflowId: valueObj.workflowId || '',
              };
              if (valueObj.description) def.description = valueObj.description;
              if (valueObj.parameters) def.parameters = valueObj.parameters;
              childFlows[flowName] = def;
            }
          }
        }

        if (Object.keys(childFlows).length > 0) {
          result.childFlows = childFlows;
        }
      }
    }
  }

  return result;
}

/**
 * Find the method with a trigger decorator.
 */
function findTriggerMethod(flowClass: ClassDeclaration): MethodDeclaration | undefined {
  const methods = flowClass.getMethods();

  for (const method of methods) {
    const decorators = method.getDecorators();
    for (const decorator of decorators) {
      const name = decorator.getName();
      if (['HttpTrigger', 'ManualTrigger', 'RecurrenceTrigger', 'ConnectorTrigger'].includes(name)) {
        return method;
      }
    }
  }

  return undefined;
}

/**
 * Find the method with @Action decorator.
 */
function findActionMethod(flowClass: ClassDeclaration): MethodDeclaration | undefined {
  const methods = flowClass.getMethods();

  for (const method of methods) {
    const decorators = method.getDecorators();
    for (const decorator of decorators) {
      if (decorator.getName() === 'Action') {
        return method;
      }
    }
  }

  return undefined;
}

/**
 * Parse value from method body, converting ctx.* calls to PA expressions.
 * @param node The AST node to parse
 * @param ctx Optional transform context for tracking parameter references
 */
function parseValueWithCtxConversion(node: any, ctx?: TransformContext): any {
  if (!node) return undefined;

  const kind = node.getKind();

  // Handle ctx.parameters('name') -> "@parameters('name')"
  // Handle ctx.triggerBody() -> "@triggerBody()"
  // etc.
  if (kind === SyntaxKind.CallExpression) {
    const callExpr = node.asKindOrThrow(SyntaxKind.CallExpression);
    const exprText = callExpr.getExpression().getText();

    // Check for ctx.* patterns - use transformExpression for proper handling
    if (exprText.startsWith('ctx.')) {
      const transformCtx = ctx || createTransformContext();
      const result = transformExpression(node, transformCtx);
      // Ensure it starts with @ for PA expressions
      if (result && !result.startsWith('@') && !result.includes('@{')) {
        return `@${result}`;
      }
      return result;
    }
  }

  // Handle string literals
  if (kind === SyntaxKind.StringLiteral) {
    return node.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
  }

  // Handle numeric literals
  if (kind === SyntaxKind.NumericLiteral) {
    const text = node.getText();
    return text.includes('.') ? parseFloat(text) : parseInt(text, 10);
  }

  // Handle boolean literals
  if (kind === SyntaxKind.TrueKeyword) return true;
  if (kind === SyntaxKind.FalseKeyword) return false;
  if (kind === SyntaxKind.NullKeyword) return null;

  // Handle object literals
  if (kind === SyntaxKind.ObjectLiteralExpression) {
    const obj = node.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
    const result: Record<string, any> = {};

    for (const prop of obj.getProperties()) {
      if (prop.getKind() === SyntaxKind.PropertyAssignment) {
        const assignment = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
        let propName = assignment.getName();
        // Handle quoted property names
        if (propName.startsWith("'") || propName.startsWith('"')) {
          propName = propName.slice(1, -1);
        }
        const initializer = assignment.getInitializer();
        result[propName] = parseValueWithCtxConversion(initializer, ctx);
      }
    }
    return result;
  }

  // Handle array literals
  if (kind === SyntaxKind.ArrayLiteralExpression) {
    const arr = node.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
    return arr.getElements().map((el: any) => parseValueWithCtxConversion(el, ctx));
  }

  // For complex expressions containing ctx.* (like binary expressions, comparisons),
  // transform them back to PA format
  const text = node.getText();
  if (text.includes('ctx.')) {
    // Use already imported transformExpression to convert ctx.* expressions to PA format
    // Pass the shared context to track parameter references
    const transformCtx = ctx || createTransformContext();
    const result = transformExpression(node, transformCtx);
    // Ensure it starts with @ for PA expressions
    if (result && !result.startsWith('@') && !result.includes('@{')) {
      return `@${result}`;
    }
    return result;
  }

  // Fallback: return the text as-is
  return text;
}

/**
 * Parse trigger configuration from method body return statement.
 * @param method The trigger method to parse
 * @param ctx Optional transform context for tracking parameter references
 */
function parseTriggerMethodBody(method: MethodDeclaration, ctx?: TransformContext): Record<string, any> | undefined {
  const body = method.getBody();
  if (!body || body.getKind() !== SyntaxKind.Block) {
    return undefined;
  }

  const block = body.asKindOrThrow(SyntaxKind.Block);
  const statements = block.getStatements();

  // Look for return statement
  for (const stmt of statements) {
    if (stmt.getKind() === SyntaxKind.ReturnStatement) {
      const returnStmt = stmt.asKindOrThrow(SyntaxKind.ReturnStatement);
      const expression = returnStmt.getExpression();

      if (expression && expression.getKind() === SyntaxKind.ObjectLiteralExpression) {
        return parseValueWithCtxConversion(expression, ctx);
      }
    }
  }

  return undefined;
}

/**
 * Parse trigger name from JSDoc comment.
 * Format: @trigger TriggerName
 * Example: @trigger My_Custom_Trigger
 */
function parseTriggerNameFromJSDoc(method: MethodDeclaration): string | undefined {
  const sourceFile = method.getSourceFile();
  const fullText = sourceFile.getFullText();
  const start = method.getStart();

  // Look for JSDoc comment before the method
  const textBefore = fullText.substring(0, start);
  const lastJSDocMatch = textBefore.match(/\/\*\*([^*]|\*(?!\/))*\*\/\s*$/);

  if (lastJSDocMatch) {
    const jsDocText = lastJSDocMatch[0];
    // Allow `@` inside the captured name (trigger keys can contain `@`, e.g.
    // shared-mailbox addresses). Stop at the next whitespace; downstream tags
    // are separated by whitespace + `@<word>` so this is unambiguous.
    const triggerMatch = jsDocText.match(/@trigger\s+([^\s*]+)/);
    return triggerMatch ? triggerMatch[1].trim() : undefined;
  }

  return undefined;
}

/**
 * Parse trigger description from JSDoc comment.
 * Format: @description Some description text
 * Note: Description can contain @ and * characters (e.g., expressions like @{variables('x')}).
 */
function parseTriggerDescriptionFromJSDoc(method: MethodDeclaration): string | undefined {
  const sourceFile = method.getSourceFile();
  const fullText = sourceFile.getFullText();
  const start = method.getStart();

  // Look for JSDoc comment before the method
  const textBefore = fullText.substring(0, start);
  const lastJSDocMatch = textBefore.match(/\/\*\*([^*]|\*(?!\/))*\*\/\s*$/);

  if (lastJSDocMatch && lastJSDocMatch.index !== undefined) {
    const jsDocText = lastJSDocMatch[0];
    // Match @description followed by text until the next known annotation or end of comment
    // Uses negative lookahead to stop at known JSDoc tags (not expressions like @{...})
    const descriptionMatch = jsDocText.match(
      /@description\s+([\s\S]*?)(?=\s*@(?:metadata|runAfter|action|type|parallel|limit|originalName|retryPolicy|runtimeConfig|conditionFormat|varType|trackedProperties|operationOptions|paramsOmitted|valueArrayForm|varNameCase)\b|\*\/|$)/
    );
    if (descriptionMatch) return descriptionMatch[1].trim();
    // JSDoc lacks @description tag — look for plain comments above the JSDoc.
    return getLeadingPlainCommentTextAt(fullText, lastJSDocMatch.index);
  }

  // No JSDoc — fall back to plain // or block comments so trigger comments round-trip.
  return getLeadingPlainCommentText(method);
}

/**
 * Parse trigger metadata from JSDoc comment.
 * Format: @metadata {...json...}
 */
function parseTriggerMetadataFromJSDoc(method: MethodDeclaration): Record<string, any> | undefined {
  const sourceFile = method.getSourceFile();
  const fullText = sourceFile.getFullText();
  const start = method.getStart();

  // Look for JSDoc comment before the method
  const textBefore = fullText.substring(0, start);
  const lastJSDocMatch = textBefore.match(/\/\*\*([^*]|\*(?!\/))*\*\/\s*$/);

  if (lastJSDocMatch) {
    const jsDocText = lastJSDocMatch[0];
    const metadataStart = jsDocText.indexOf('@metadata');
    if (metadataStart !== -1) {
      const jsonStart = jsDocText.indexOf('{', metadataStart);
      if (jsonStart !== -1) {
        // Find matching closing brace
        let depth = 0;
        let jsonEnd = jsonStart;
        for (let i = jsonStart; i < jsDocText.length; i++) {
          if (jsDocText[i] === '{') depth++;
          else if (jsDocText[i] === '}') {
            depth--;
            if (depth === 0) {
              jsonEnd = i;
              break;
            }
          }
        }
        const jsonStr = jsDocText.substring(jsonStart, jsonEnd + 1);
        try {
          return JSON.parse(jsonStr);
        } catch {
          return undefined;
        }
      }
    }
  }

  return undefined;
}

/**
 * Generate a trigger node from the trigger method.
 * @param method The trigger method to process
 * @param ctx Optional transform context for tracking parameter references
 */
function generateTriggerNode(method: MethodDeclaration, ctx?: TransformContext): TriggerNode | RecurrenceTriggerNode {
  const decorators = method.getDecorators();

  // First, try to parse configuration from method body
  const bodyConfig = parseTriggerMethodBody(method, ctx);

  for (const decorator of decorators) {
    const name = decorator.getName();
    const args = decorator.getArguments();

    switch (name) {
      case 'HttpTrigger': {
        const decoratorOpts = args.length > 0 ? parseObjectLiteralArg(args[0]) : {};
        // Prefer body config over decorator options
        const options = { ...decoratorOpts, ...bodyConfig };
        const jsDocDescription = parseTriggerDescriptionFromJSDoc(method);
        const node: TriggerNode = {
          id: genTriggerId(),
          type: 'trigger',
          kind: 'http',
          name: 'manual', // Standard name for HTTP trigger
          inputs: {
            // Preserve method only when DSL had it explicitly. Source flows that omit
            // method (POST default) keep it absent so the round-trip stays byte-exact.
            ...(options.method !== undefined ? { method: options.method } : {}),
            path: options.path,
            schema: options.schema,
            headersSchema: options.headersSchema,
            triggerKind: options.triggerKind,
            triggerAuthenticationType: options.triggerAuthenticationType,
          },
        };
        // Add description if present
        if (jsDocDescription) {
          node.description = jsDocDescription;
        }
        // Add conditions if present
        if (options.conditions && Array.isArray(options.conditions)) {
          node.conditions = options.conditions;
        }
        // Add correlation if present
        if (options.correlation !== undefined) {
          node.correlation = options.correlation;
        }
        // Add runtimeConfiguration if present
        if (options.runtimeConfiguration) {
          node.runtimeConfiguration = options.runtimeConfiguration;
        }
        return node;
      }

      case 'ManualTrigger': {
        const decoratorOpts = args.length > 0 ? parseObjectLiteralArg(args[0]) : {};
        const options = { ...decoratorOpts, ...bodyConfig };
        const jsDocDescription = parseTriggerDescriptionFromJSDoc(method);
        const node: TriggerNode = {
          id: genTriggerId(),
          type: 'trigger',
          kind: 'manual',
          name: 'manual',
          inputs: {
            schema: options.schema,
            headersSchema: options.headersSchema,
            triggerKind: options.triggerKind,
            triggerAuthenticationType: options.triggerAuthenticationType,
          },
        };
        // Add description if present
        if (jsDocDescription) {
          node.description = jsDocDescription;
        }
        // Add conditions if present
        if (options.conditions && Array.isArray(options.conditions)) {
          node.conditions = options.conditions;
        }
        // Add correlation if present
        if (options.correlation !== undefined) {
          node.correlation = options.correlation;
        }
        // Add runtimeConfiguration if present
        if (options.runtimeConfiguration) {
          node.runtimeConfiguration = options.runtimeConfiguration;
        }
        return node;
      }

      case 'RecurrenceTrigger': {
        const decoratorOpts = args.length > 0 ? parseObjectLiteralArg(args[0]) : {};
        const options = { ...decoratorOpts, ...bodyConfig };
        // Try to get trigger name and description from JSDoc comment
        const jsDocTriggerName = parseTriggerNameFromJSDoc(method);
        const jsDocDescription = parseTriggerDescriptionFromJSDoc(method);
        const node: RecurrenceTriggerNode = {
          id: genTriggerId(),
          type: 'recurrence',
          name: jsDocTriggerName || 'Recurrence',
          inputs: {
            frequency: options.frequency || 'Day',
            interval: options.interval || 1,
            timeZone: options.timeZone,
            startTime: options.startTime,
            schedule: options.schedule,
          },
        };
        // Add description if present
        if (jsDocDescription) {
          node.description = jsDocDescription;
        }
        // Add conditions if present
        if (options.conditions && Array.isArray(options.conditions)) {
          node.conditions = options.conditions;
        }
        // Add correlation if present
        if (options.correlation !== undefined) {
          node.correlation = options.correlation;
        }
        // Add runtimeConfiguration if present
        if (options.runtimeConfiguration) {
          node.runtimeConfiguration = options.runtimeConfiguration;
        }
        // Add evaluatedRecurrence if present (Power Automate's effective schedule)
        if (options.evaluatedRecurrence) {
          node.evaluatedRecurrence = {
            frequency: options.evaluatedRecurrence.frequency || 'Day',
            interval: options.evaluatedRecurrence.interval || 1,
            timeZone: options.evaluatedRecurrence.timeZone,
            startTime: options.evaluatedRecurrence.startTime,
            endTime: options.evaluatedRecurrence.endTime,
            schedule: options.evaluatedRecurrence.schedule,
          };
        }
        return node;
      }

      case 'ConnectorTrigger': {
        const decoratorOpts = args.length > 0 ? parseObjectLiteralArg(args[0]) : {};
        const options = { ...decoratorOpts, ...bodyConfig };
        // Try to get trigger name, description, and metadata from JSDoc comment
        const jsDocTriggerName = parseTriggerNameFromJSDoc(method);
        const jsDocDescription = parseTriggerDescriptionFromJSDoc(method);
        const jsDocMetadata = parseTriggerMetadataFromJSDoc(method);
        const node: TriggerNode = {
          id: genTriggerId(),
          type: 'trigger',
          kind: 'connector',
          name: jsDocTriggerName || options.operation || 'ConnectorTrigger',
          inputs: {
            connector: options.connector,
            operation: options.operation,
            params: options.params || {},
            connectionReferenceName: options.connectionReferenceName,
            splitOn: options.splitOn,
            recurrence: options.recurrence,
            triggerType: options.triggerType,
            authentication: options.authentication,
            retryPolicy: options.retryPolicy,
          },
        };
        // Add description if present
        if (jsDocDescription) {
          node.description = jsDocDescription;
        }
        // Add conditions if present
        if (options.conditions && Array.isArray(options.conditions)) {
          node.conditions = options.conditions;
        }
        // Add correlation if present
        if (options.correlation !== undefined) {
          node.correlation = options.correlation;
        }
        // Add runtimeConfiguration if present
        if (options.runtimeConfiguration) {
          node.runtimeConfiguration = options.runtimeConfiguration;
        }
        // Add metadata if present
        if (jsDocMetadata) {
          node.metadata = jsDocMetadata;
        }
        return node;
      }
    }
  }

  // Default to HTTP trigger
  return {
    id: genTriggerId(),
    type: 'trigger',
    kind: 'http',
    name: 'manual',
    inputs: { method: 'POST' },
  } as TriggerNode;
}

/**
 * Process the body of the action method and generate action nodes.
 */
function processMethodBody(
  method: MethodDeclaration,
  ctx: TransformContext,
  variableTracker: VariableTracker
): Node[] {
  const body = method.getBody();
  if (!body || body.getKind() !== SyntaxKind.Block) {
    return [];
  }

  const block = body.asKindOrThrow(SyntaxKind.Block);
  const statements = block.getStatements();

  return processStatements(statements as Statement[], ctx, variableTracker);
}

/**
 * Process a list of statements and generate nodes.
 */
function processStatements(
  statements: Statement[],
  ctx: TransformContext,
  variableTracker: VariableTracker
): Node[] {
  const nodes: Node[] = [];
  let previousActionName: string | undefined;

  for (const statement of statements) {
    const statementNodes = processStatement(statement, ctx, variableTracker);

    // For each generated node, if it doesn't have explicit runAfter and we have a previous action,
    // set runAfter to the previous action with ['Succeeded'] (default sequential behavior)
    for (const node of statementNodes) {
      const nodeWithRunAfter = node as any;

      // Dedup action name across the entire flow. PA requires unique action
      // names; auto-generators (e.g. generateConditionName -> `Check_ctx`) can
      // collide between siblings. Children inside this node's actions/etc. have
      // already been registered by the recursive processStatements call, so the
      // Set is up-to-date when we get here.
      if (nodeWithRunAfter.name) {
        const original: string = nodeWithRunAfter.name;
        if (ctx.usedActionNames.has(original)) {
          let n = 2;
          while (ctx.usedActionNames.has(`${original}_${n}`)) n++;
          nodeWithRunAfter.name = `${original}_${n}`;
        }
        ctx.usedActionNames.add(nodeWithRunAfter.name);
      }

      // Only set runAfter if:
      // 1. runAfter is undefined (no explicit runAfter in JSDoc)
      // 2. We have a previous action to depend on
      // Note: runAfter: {} means parallel execution (explicit "first" in container), so we preserve it
      if (previousActionName && nodeWithRunAfter.runAfter === undefined) {
        nodeWithRunAfter.runAfter = { [previousActionName]: ['Succeeded'] };
      }
      nodes.push(node);
      // Update previous action name for next iteration
      if (nodeWithRunAfter.name) {
        previousActionName = nodeWithRunAfter.name;
      }
    }
  }

  return nodes;
}

/**
 * Process a single statement and generate nodes.
 */
function processStatement(
  statement: Statement,
  ctx: TransformContext,
  variableTracker: VariableTracker
): Node[] {
  const kind = statement.getKind();

  switch (kind) {
    case SyntaxKind.VariableStatement: {
      // Variable declarations: let x = 0
      const varStatement = statement.asKindOrThrow(SyntaxKind.VariableStatement);
      const declList = varStatement.getDeclarationList();
      const nodes: Node[] = [];

      // Track let and var declarations (not const, which are typically action results)
      const declKind = declList.getDeclarationKind();
      const isTrackable = declKind === VariableDeclarationKind.Let || declKind === VariableDeclarationKind.Var;

      for (const decl of declList.getDeclarations()) {
        // Check if this is an await expression (action result)
        const initializer = decl.getInitializer();
        if (initializer && initializer.getKind() === SyntaxKind.AwaitExpression) {
          // This is an action call assignment
          const awaitExpr = initializer.asKindOrThrow(SyntaxKind.AwaitExpression);
          const call = awaitExpr.getExpression();
          if (call.getKind() === SyntaxKind.CallExpression && isActionCall(call.asKindOrThrow(SyntaxKind.CallExpression))) {
            const actionNode = collectAction(call.asKindOrThrow(SyntaxKind.CallExpression), ctx, statement);
            if (actionNode) {
              nodes.push(actionNode);
            }
          }
        } else if (isTrackable) {
          // Variable declaration
          const varNode = variableTracker.processDeclaration(decl, ctx);
          if (varNode) {
            nodes.push(varNode);
          }
        }
      }

      return nodes;
    }

    case SyntaxKind.ExpressionStatement: {
      // Expression statements: await ctx.http(...) or x = 5
      const exprStatement = statement.asKindOrThrow(SyntaxKind.ExpressionStatement);
      const expression = exprStatement.getExpression();

      // Check for await expression
      if (expression.getKind() === SyntaxKind.AwaitExpression) {
        const awaitExpr = expression.asKindOrThrow(SyntaxKind.AwaitExpression);
        const innerExpr = awaitExpr.getExpression();

        if (innerExpr.getKind() === SyntaxKind.CallExpression) {
          const call = innerExpr.asKindOrThrow(SyntaxKind.CallExpression);
          if (isActionCall(call)) {
            const actionNode = collectAction(call, ctx, statement);
            if (actionNode) {
              return [actionNode];
            }
          }
        }
      }

      // Check for assignment expression: x = 5
      if (expression.getKind() === SyntaxKind.BinaryExpression) {
        const binary = expression.asKindOrThrow(SyntaxKind.BinaryExpression);
        const operator = binary.getOperatorToken().getKind();

        if (
          operator === SyntaxKind.EqualsToken ||
          operator === SyntaxKind.PlusEqualsToken ||
          operator === SyntaxKind.MinusEqualsToken
        ) {
          const varNode = variableTracker.processAssignment(binary, ctx);
          if (varNode) {
            return [varNode];
          }
        }
      }

      // Check for increment/decrement: x++ or ++x
      if (
        expression.getKind() === SyntaxKind.PostfixUnaryExpression ||
        expression.getKind() === SyntaxKind.PrefixUnaryExpression
      ) {
        const unary = expression as any;
        const varNode = variableTracker.processUnaryMutation(unary, ctx);
        if (varNode) {
          return [varNode];
        }
      }

      // Check for array.push(...) pattern - AppendToArrayVariable
      if (expression.getKind() === SyntaxKind.CallExpression) {
        const callExpr = expression.asKindOrThrow(SyntaxKind.CallExpression);
        const calleeExpr = callExpr.getExpression();

        // Check if it's a property access: arrayName.push
        if (calleeExpr.getKind() === SyntaxKind.PropertyAccessExpression) {
          const propAccess = calleeExpr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
          const methodName = propAccess.getName();

          // Check if the method is 'push'
          if (methodName === 'push') {
            const arrayExpr = propAccess.getExpression();
            const args = callExpr.getArguments();

            // Get the array variable name
            let arrayName: string | undefined;
            if (arrayExpr.getKind() === SyntaxKind.Identifier) {
              arrayName = arrayExpr.getText();
            }

            // Get the value being pushed
            if (arrayName && args.length > 0) {
              const valueExpr = args[0];
              // Transform the expression, handling object literals with expressions properly
              const arrayFormHint = parseValueArrayFormFromJSDoc(statement);
              const valueExpression = transformValueWithExpressions(valueExpr as Expression, ctx, arrayFormHint);

              // Try to get action name from JSDoc comment
              const jsDocName = parseActionNameFromJSDoc(statement);
              // Shared counter with Set/Increment/Decrement on the same variable
              // so repeated pushes get unique suffixes: Append_to_x, Append_to_x_2, ...
              // Only applied when there's no explicit @action override.
              const suffix = jsDocName ? '' : variableTracker.nextMutationSuffix(arrayName);
              const actionName = jsDocName || `Append_to_${arrayName}${suffix}`;

              // Parse runAfter, description, and metadata from JSDoc if present
              const runAfter = parseRunAfterFromJSDoc(statement);
              const description = parseDescriptionFromJSDoc(statement);
              const metadata = parseMetadataFromJSDoc(statement);

              // Get the original variable name (may have spaces, etc.)
              const originalArrayName = ctx.variableOriginalNames?.get(arrayName) || arrayName;

              // Create AppendToArrayVariable action
              const appendNode: ActionNode = {
                id: genActionId(),
                type: 'action',
                kind: 'appendtoarrayvariable',
                name: actionName,
                inputs: {
                  name: originalArrayName,
                  value: valueExpression,
                },
              };

              // Only set runAfter if explicitly specified in JSDoc
              if (runAfter) {
                appendNode.runAfter = runAfter;
              }
              if (description) {
                appendNode.description = description;
              }
              if (metadata) {
                appendNode.metadata = metadata;
              }

              return [appendNode];
            }
          }
        }

      }

      return [];
    }

    case SyntaxKind.IfStatement: {
      // If statement: if (condition) { ... } else { ... }
      const ifStatement = statement.asKindOrThrow(SyntaxKind.IfStatement);
      const result = analyzeIfStatement(ifStatement, ctx);

      // Process nested statements
      if (result.nestedStatements) {
        const ifNode = result.node as any;

        if (result.nestedStatements.then) {
          ifNode.actions = processStatements(result.nestedStatements.then, ctx, variableTracker);
        }

        if (result.nestedStatements.else) {
          ifNode.elseActions = processStatements(result.nestedStatements.else, ctx, variableTracker);
        }
      }

      return [result.node];
    }

    case SyntaxKind.ForOfStatement: {
      // For...of loop: for (const item of items) { ... }
      const forOfStatement = statement.asKindOrThrow(SyntaxKind.ForOfStatement);
      const result = analyzeForOfStatement(forOfStatement, ctx);

      // Create loop context with loop variable
      const loopVarName = getLoopVariableName(forOfStatement);
      const foreachNode = result.node as any;
      const loopCtx = createLoopContext(ctx, loopVarName, foreachNode.name);

      // Process nested statements with loop context
      if (result.nestedStatements?.loop) {
        foreachNode.actions = processStatements(result.nestedStatements.loop, loopCtx, variableTracker);
      }

      return [result.node];
    }

    case SyntaxKind.SwitchStatement: {
      // Switch statement
      const switchStatement = statement.asKindOrThrow(SyntaxKind.SwitchStatement);
      const result = analyzeSwitchStatement(switchStatement, ctx);
      const switchNode = result.node as any;

      // Process case statements
      if (result.nestedStatements?.cases) {
        for (let i = 0; i < result.nestedStatements.cases.length; i++) {
          const caseInfo = result.nestedStatements.cases[i];
          switchNode.cases[i].actions = processStatements(caseInfo.statements, ctx, variableTracker);
        }
      }

      // Process default case
      if (result.nestedStatements?.default) {
        switchNode.defaultActions = processStatements(result.nestedStatements.default, ctx, variableTracker);
      }

      return [result.node];
    }

    case SyntaxKind.WhileStatement: {
      // While loop: while (condition) { ... }
      const whileStatement = statement.asKindOrThrow(SyntaxKind.WhileStatement);
      const result = analyzeWhileStatement(whileStatement, ctx);

      if (result.nestedStatements?.loop) {
        (result.node as any).actions = processStatements(result.nestedStatements.loop, ctx, variableTracker);
      }

      return [result.node];
    }

    case SyntaxKind.DoStatement: {
      // Do...while loop: do { ... } while (condition)
      const doStatement = statement.asKindOrThrow(SyntaxKind.DoStatement);
      const result = analyzeDoWhileStatement(doStatement, ctx);

      if (result.nestedStatements?.loop) {
        (result.node as any).actions = processStatements(result.nestedStatements.loop, ctx, variableTracker);
      }

      return [result.node];
    }

    case SyntaxKind.ReturnStatement: {
      // Return statements are typically ignored in flow context
      return [];
    }

    case SyntaxKind.Block: {
      // Check if this block has @type scope JSDoc - if so, create a ScopeNode
      const blockType = parseTypeFromJSDoc(statement);
      if (blockType === 'scope') {
        const scopeName = parseActionNameFromJSDoc(statement) || 'Scope';
        const runAfter = parseRunAfterFromJSDoc(statement);
        const runtimeConfiguration = parseParallelFromJSDoc(statement);
        const trackedProperties = parseTrackedPropertiesFromJSDoc(statement);
        const metadata = parseMetadataFromJSDoc(statement);
        const description = parseDescriptionFromJSDoc(statement);
        const block = statement.asKindOrThrow(SyntaxKind.Block);
        const innerStatements = block.getStatements() as Statement[];
        const innerNodes = processStatements(innerStatements, ctx, variableTracker);

        const scopeNode: ScopeNode = {
          id: genScopeId(),
          type: 'scope',
          name: scopeName,
          description,
          actions: innerNodes,
          runAfter,
          runtimeConfiguration,
          trackedProperties,
          metadata,
        };

        return [scopeNode];
      }

      // Regular nested block - process statements inside (flatten)
      const block = statement.asKindOrThrow(SyntaxKind.Block);
      return processStatements(block.getStatements() as Statement[], ctx, variableTracker);
    }

    default:
      // Unknown statement type
      return [];
  }
}

/**
 * Parse an object literal argument from a decorator.
 */
function parseObjectLiteralArg(node: any): Record<string, any> {
  if (node.getKind() !== SyntaxKind.ObjectLiteralExpression) {
    return {};
  }

  const obj = node.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
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
        result[name] = getLiteralValue(init);
      }
    }
  }

  return result;
}

/**
 * Get literal value from an expression.
 * For complex expressions (like ctx.* calls), transforms them back to PA format.
 */
function getLiteralValue(node: any): any {
  const kind = node.getKind();

  switch (kind) {
    case SyntaxKind.StringLiteral:
      return node.getLiteralValue();

    case SyntaxKind.NumericLiteral:
      return Number(node.getText());

    case SyntaxKind.TrueKeyword:
      return true;

    case SyntaxKind.FalseKeyword:
      return false;

    case SyntaxKind.NullKeyword:
      return null;

    case SyntaxKind.ArrayLiteralExpression: {
      const elements = node.getElements();
      return elements.map((el: any) => getLiteralValue(el));
    }

    case SyntaxKind.ObjectLiteralExpression: {
      return parseObjectLiteralArg(node);
    }

    case SyntaxKind.NoSubstitutionTemplateLiteral: {
      // Template literal without expressions - unescape \$ and \` sequences
      const text = node.getText().slice(1, -1); // Remove backticks
      return text.replace(/\\\$/g, '$').replace(/\\`/g, '`').replace(/\\\\/g, '\\');
    }

    case SyntaxKind.TemplateExpression: {
      // Template literal with expressions - use transformExpression which handles unescaping
      const transformCtx = createTransformContext();
      return transformExpression(node, transformCtx);
    }

    default: {
      // For complex expressions (like ctx.* calls in conditions),
      // transform them back to PA format
      const text = node.getText();
      if (text.includes('ctx.')) {
        // Use already imported transformExpression to convert ctx.* expressions to PA format
        const transformCtx = createTransformContext();
        const result = transformExpression(node, transformCtx);
        // Ensure it starts with @ for PA expressions
        if (result && !result.startsWith('@') && !result.includes('@{')) {
          return `@${result}`;
        }
        return result;
      }
      return text;
    }
  }
}

// Re-export types and functions
export { transformExpression, createTransformContext } from './expression-transformer.js';
export type { TransformContext } from './expression-transformer.js';
