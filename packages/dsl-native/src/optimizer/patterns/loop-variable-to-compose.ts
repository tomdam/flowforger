/**
 * Loop Variable to Compose Optimization
 *
 * Converts variables declared inside loops to compose actions when they
 * are only used within that iteration (not referenced after the loop).
 *
 * Pattern:
 *   for (const item of items) {
 *     let itemStatus: string = item.status;
 *     // itemStatus used only in this iteration
 *   }
 *
 * Transforms to:
 *   for (const item of items) {
 *     await ctx.compose('itemStatus', item.status);
 *     // references change from @variables('itemStatus') to @outputs('itemStatus')
 *   }
 */

import type {
  FlowIR,
  Node,
  ActionNode,
  VariableActionInputs,
  ForeachNode,
  IfNode,
  ScopeNode,
  SwitchNode,
  DoUntilNode,
} from '@flowforger/ir';
import { isAction, isForeach, isIf, isScope, isSwitch, isDoUntil } from '@flowforger/ir';
import { OptimizationReport, addChange } from '../report.js';

/**
 * Variable mutation kinds that prevent optimization.
 */
const MUTATION_KINDS = new Set([
  'setvariable',
  'incrementvariable',
  'decrementvariable',
  'appendtoarrayvariable',
  'appendtostringvariable',
]);

/**
 * Information about a variable declared inside a loop.
 */
interface LoopVariableInfo {
  /** The name of the variable */
  name: string;
  /** The node where the variable is initialized */
  initNode: ActionNode;
  /** The loop name where it's declared */
  loopName: string;
  /** Whether it's referenced outside the loop */
  referencedOutsideLoop: boolean;
  /** Whether it's mutated after initialization */
  isMutated: boolean;
}

/**
 * Optimizes loop variables to compose actions.
 *
 * @param ir - The FlowIR to optimize
 * @param report - Report to record changes
 * @returns The optimized FlowIR
 */
export function optimizeLoopVariables(ir: FlowIR, report: OptimizationReport, excludeActions?: Set<string>): FlowIR {
  // Process top-level nodes
  ir.nodes = processNodes(ir.nodes, report, [], new Set(), excludeActions);

  return ir;
}

/**
 * Processes nodes recursively, looking for foreach loops with optimizable variables.
 */
function processNodes(
  nodes: Node[],
  report: OptimizationReport,
  path: string[],
  outerLoopVars: Set<string>,
  excludeActions?: Set<string>
): Node[] {
  return nodes.map(node => {
    if (isForeach(node)) {
      return optimizeForeachNode(node, report, path, outerLoopVars, excludeActions);
    }

    // Recurse into other control flow nodes
    if (isIf(node)) {
      return {
        ...node,
        actions: processNodes(node.actions, report, [...path, node.name], outerLoopVars, excludeActions),
        elseActions: node.elseActions
          ? processNodes(node.elseActions, report, [...path, node.name], outerLoopVars, excludeActions)
          : undefined,
      } as IfNode;
    }

    if (isScope(node)) {
      return {
        ...node,
        actions: processNodes(node.actions, report, [...path, node.name], outerLoopVars, excludeActions),
      } as ScopeNode;
    }

    if (isSwitch(node)) {
      return {
        ...node,
        cases: node.cases.map(c => ({
          ...c,
          actions: processNodes(c.actions, report, [...path, node.name], outerLoopVars, excludeActions),
        })),
        defaultActions: node.defaultActions
          ? processNodes(node.defaultActions, report, [...path, node.name], outerLoopVars, excludeActions)
          : undefined,
      } as SwitchNode;
    }

    if (isDoUntil(node)) {
      return {
        ...node,
        actions: processNodes(node.actions, report, [...path, node.name], outerLoopVars, excludeActions),
      } as DoUntilNode;
    }

    return node;
  });
}

/**
 * Optimizes a foreach node's loop variables.
 */
function optimizeForeachNode(
  node: ForeachNode,
  report: OptimizationReport,
  path: string[],
  outerLoopVars: Set<string>,
  excludeActions?: Set<string>
): ForeachNode {
  // Step 1: Find variables declared inside this loop
  const loopVars = findLoopVariables(node.actions, node.name);

  // Step 2: Check which are referenced outside the loop
  // (We need to track these so we don't optimize them)
  // For now, we optimize only vars that are:
  // - Declared inside the loop
  // - Not mutated after init
  // - Not already in outerLoopVars (not passed from outer scope)
  // - Not in the excludeActions set

  const optimizableVars = loopVars.filter(v =>
    !v.isMutated &&
    !v.referencedOutsideLoop &&
    !outerLoopVars.has(v.name) &&
    (!excludeActions || !excludeActions.has(v.initNode.name))
  );

  if (optimizableVars.length === 0) {
    // Still need to process nested loops
    return {
      ...node,
      actions: processNodes(node.actions, report, [...path, node.name], outerLoopVars, excludeActions),
    };
  }

  // Step 3: Transform the loop actions
  const varToCompose = new Map<string, string>();
  for (const varInfo of optimizableVars) {
    varToCompose.set(varInfo.name, varInfo.initNode.name);
  }

  // Transform the loop's actions
  const transformedActions = transformLoopActions(
    node.actions,
    varToCompose,
    report,
    [...path, node.name]
  );

  // Continue processing nested loops with updated outer vars
  const newOuterVars = new Set(outerLoopVars);
  for (const v of loopVars) {
    newOuterVars.add(v.name);
  }

  const processedActions = processNodes(transformedActions, report, [...path, node.name], newOuterVars, excludeActions);

  return {
    ...node,
    actions: processedActions,
  };
}

/**
 * Finds variables declared inside a loop.
 */
function findLoopVariables(actions: Node[], loopName: string): LoopVariableInfo[] {
  const variables: LoopVariableInfo[] = [];

  function scanNodes(nodes: Node[]): void {
    for (const node of nodes) {
      if (isAction(node)) {
        if (node.kind === 'initializevariable') {
          const inputs = node.inputs as VariableActionInputs;
          const varName = inputs.variableName;
          if (varName) {
            variables.push({
              name: varName,
              initNode: node,
              loopName,
              referencedOutsideLoop: false, // Will be updated by caller if needed
              isMutated: false,
            });
          }
        } else if (MUTATION_KINDS.has(node.kind)) {
          const inputs = node.inputs as VariableActionInputs;
          const varName = inputs.name || inputs.variableName;
          if (varName) {
            const existing = variables.find(v => v.name === varName);
            if (existing) {
              existing.isMutated = true;
            }
          }
        }
      }

      // Recurse into nested control flow
      const children = getChildNodes(node);
      for (const childActions of children) {
        scanNodes(childActions);
      }
    }
  }

  scanNodes(actions);
  return variables;
}

/**
 * Transforms loop actions, converting initializevariable to compose.
 */
function transformLoopActions(
  actions: Node[],
  varToCompose: Map<string, string>,
  report: OptimizationReport,
  path: string[]
): Node[] {
  return actions.map(node => {
    if (isAction(node)) {
      if (node.kind === 'initializevariable') {
        const inputs = node.inputs as VariableActionInputs;
        const varName = inputs.variableName;

        if (varName && varToCompose.has(varName)) {
          const composeName = varToCompose.get(varName)!;

          addChange(report, {
            type: 'loop_variable_to_compose',
            originalAction: node.name,
            newAction: composeName,
            location: path,
            description: `Converted loop variable '${varName}' to compose (loop-local, never mutated)`,
          });

          return {
            ...node,
            kind: 'compose',
            inputs: {
              value: inputs.value,
            },
          } as ActionNode;
        }
      }

      // Update variable references in other actions
      return updateVariableReferences(node, varToCompose);
    }

    // Recurse into nested control flow within the loop
    if (isIf(node)) {
      return {
        ...node,
        condition: replaceVariableRefs(node.condition, varToCompose),
        actions: transformLoopActions(node.actions, varToCompose, report, [...path, node.name]),
        elseActions: node.elseActions
          ? transformLoopActions(node.elseActions, varToCompose, report, [...path, node.name])
          : undefined,
      } as IfNode;
    }

    if (isScope(node)) {
      return {
        ...node,
        actions: transformLoopActions(node.actions, varToCompose, report, [...path, node.name]),
      } as ScopeNode;
    }

    if (isSwitch(node)) {
      return {
        ...node,
        expression: replaceVariableRefs(node.expression, varToCompose),
        cases: node.cases.map(c => ({
          ...c,
          actions: transformLoopActions(c.actions, varToCompose, report, [...path, node.name]),
        })),
        defaultActions: node.defaultActions
          ? transformLoopActions(node.defaultActions, varToCompose, report, [...path, node.name])
          : undefined,
      } as SwitchNode;
    }

    // Don't recurse into nested foreach here - let processNodes handle it
    return node;
  });
}

/**
 * Updates variable references in an action node's inputs.
 */
function updateVariableReferences(node: ActionNode, varToCompose: Map<string, string>): ActionNode {
  const inputsStr = JSON.stringify(node.inputs);
  const updatedStr = replaceVariableRefs(inputsStr, varToCompose);

  if (inputsStr !== updatedStr) {
    return {
      ...node,
      inputs: JSON.parse(updatedStr),
    };
  }

  return node;
}

/**
 * Replaces @variables('name') with @outputs('name') for optimized variables.
 * Compose results live directly in outputs — body() fails on Compose in Power Automate.
 */
function replaceVariableRefs(str: string, varToCompose: Map<string, string>): string {
  let result = str;

  for (const [varName, composeName] of varToCompose) {
    const escapedVarName = escapeRegex(varName);

    // Replace @variables('varName') with @outputs('composeName')
    const atVarPattern = new RegExp(`@variables\\(['"]${escapedVarName}['"]\\)`, 'g');
    result = result.replace(atVarPattern, `@outputs('${composeName}')`);

    // Replace @{variables('varName')} with @{outputs('composeName')} (embedded expressions)
    const embeddedPattern = new RegExp(`@\\{variables\\(['"]${escapedVarName}['"]\\)`, 'g');
    result = result.replace(embeddedPattern, `@{outputs('${composeName}')`);

    // Replace variables('varName') without @ prefix (nested in other functions)
    const nestedPattern = new RegExp(`(?<!@)variables\\(['"]${escapedVarName}['"]\\)`, 'g');
    result = result.replace(nestedPattern, `outputs('${composeName}')`);
  }

  return result;
}

/**
 * Gets all child node arrays from a control flow node.
 */
function getChildNodes(node: Node): Node[][] {
  if (isForeach(node)) {
    return [node.actions];
  }
  if (isIf(node)) {
    const result = [node.actions];
    if (node.elseActions) {
      result.push(node.elseActions);
    }
    return result;
  }
  if (isScope(node)) {
    return [node.actions];
  }
  if (isSwitch(node)) {
    const result = node.cases.map(c => c.actions);
    if (node.defaultActions) {
      result.push(node.defaultActions);
    }
    return result;
  }
  if (isDoUntil(node)) {
    return [node.actions];
  }
  return [];
}

/**
 * Escapes special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
