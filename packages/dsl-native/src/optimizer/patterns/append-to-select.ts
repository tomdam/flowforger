/**
 * Append-to-Array to Select Optimization
 *
 * Converts patterns where an array is built via append in a loop to a Select action.
 * This enables parallel execution and is significantly faster.
 *
 * Pattern:
 *   let results: any[] = [];
 *   for (const item of ctx.body('GetItems').value) {
 *     results.push({ id: item.id, name: item.title });
 *   }
 *
 * Transforms to:
 *   await ctx.select('results', ctx.body('GetItems').value, {
 *     id: ctx.item().id,
 *     name: ctx.item().title
 *   });
 *
 * Constraints:
 * - The loop body must ONLY contain the append operation (no other actions)
 * - The array must not be read during the loop
 * - The append value must be a transformation of @item()
 */

import type {
  FlowIR,
  Node,
  ActionNode,
  VariableActionInputs,
  DataOperationInputs,
  ForeachNode,
  IfNode,
  ScopeNode,
  SwitchNode,
  DoUntilNode,
} from '@flowforger/ir';
import { isAction, isForeach, isIf, isScope, isSwitch, isDoUntil } from '@flowforger/ir';
import { OptimizationReport, addChange } from '../report.js';

/**
 * Represents a detected append-to-array pattern.
 */
interface AppendPattern {
  /** Index of the initialize variable action */
  initIndex: number;
  /** The initialize variable node */
  initNode: ActionNode;
  /** Index of the foreach node */
  foreachIndex: number;
  /** The foreach node */
  foreachNode: ForeachNode;
  /** The variable name */
  variableName: string;
  /** The append value (what's being pushed) */
  appendValue: any;
}

/**
 * Optimizes append-to-array-in-loop patterns to select actions.
 *
 * @param ir - The FlowIR to optimize
 * @param report - Report to record changes
 * @returns The optimized FlowIR
 */
export function optimizeAppendToSelect(ir: FlowIR, report: OptimizationReport, excludeActions?: Set<string>): FlowIR {
  ir.nodes = processNodeArray(ir.nodes, report, [], excludeActions);
  return ir;
}

/**
 * Processes an array of nodes looking for the append pattern.
 */
function processNodeArray(nodes: Node[], report: OptimizationReport, path: string[], excludeActions?: Set<string>): Node[] {
  // First, find patterns at this level
  let patterns = findAppendPatterns(nodes);

  // Filter out patterns where the init node is excluded
  if (excludeActions) {
    patterns = patterns.filter(p =>
      !excludeActions.has(`${p.initNode.name} + ${p.foreachNode.name}`)
    );
  }

  // Apply optimizations (in reverse order to preserve indices)
  const result = [...nodes];
  for (const pattern of patterns.reverse()) {
    applyOptimization(result, pattern, report, path);
  }

  // Recurse into control flow nodes
  return result.map(node => {
    if (isForeach(node)) {
      return {
        ...node,
        actions: processNodeArray(node.actions, report, [...path, node.name], excludeActions),
      } as ForeachNode;
    }

    if (isIf(node)) {
      return {
        ...node,
        actions: processNodeArray(node.actions, report, [...path, node.name], excludeActions),
        elseActions: node.elseActions
          ? processNodeArray(node.elseActions, report, [...path, node.name], excludeActions)
          : undefined,
      } as IfNode;
    }

    if (isScope(node)) {
      return {
        ...node,
        actions: processNodeArray(node.actions, report, [...path, node.name], excludeActions),
      } as ScopeNode;
    }

    if (isSwitch(node)) {
      return {
        ...node,
        cases: node.cases.map(c => ({
          ...c,
          actions: processNodeArray(c.actions, report, [...path, node.name], excludeActions),
        })),
        defaultActions: node.defaultActions
          ? processNodeArray(node.defaultActions, report, [...path, node.name], excludeActions)
          : undefined,
      } as SwitchNode;
    }

    if (isDoUntil(node)) {
      return {
        ...node,
        actions: processNodeArray(node.actions, report, [...path, node.name], excludeActions),
      } as DoUntilNode;
    }

    return node;
  });
}

/**
 * Finds append-to-array patterns in a node array.
 */
function findAppendPatterns(nodes: Node[]): AppendPattern[] {
  const patterns: AppendPattern[] = [];

  // Track array variables initialized to empty arrays
  const emptyArrayVars = new Map<string, { index: number; node: ActionNode }>();

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    if (isAction(node) && node.kind === 'initializevariable') {
      const inputs = node.inputs as VariableActionInputs;
      if (
        inputs.variableName &&
        inputs.variableType?.toLowerCase() === 'array' &&
        isEmptyArray(inputs.value)
      ) {
        emptyArrayVars.set(inputs.variableName, { index: i, node });
      }
    }

    if (isForeach(node)) {
      // Check if this loop only contains a single appendtoarrayvariable
      const appendInfo = getLoopAppendInfo(node);

      if (appendInfo && emptyArrayVars.has(appendInfo.variableName)) {
        const varInfo = emptyArrayVars.get(appendInfo.variableName)!;

        // Check that the variable isn't used between init and loop
        // and isn't used inside the loop (except for the append)
        if (isPatternValid(nodes, varInfo.index, i, appendInfo.variableName)) {
          patterns.push({
            initIndex: varInfo.index,
            initNode: varInfo.node,
            foreachIndex: i,
            foreachNode: node,
            variableName: appendInfo.variableName,
            appendValue: appendInfo.appendValue,
          });
        }
      }
    }
  }

  return patterns;
}

/**
 * Checks if a value is an empty array.
 */
function isEmptyArray(value: any): boolean {
  return Array.isArray(value) && value.length === 0;
}

/**
 * Gets append info from a foreach loop if it only contains a single append.
 */
function getLoopAppendInfo(node: ForeachNode): { variableName: string; appendValue: any } | null {
  // The loop must have exactly one action that is appendtoarrayvariable
  if (node.actions.length !== 1) {
    return null;
  }

  const action = node.actions[0];
  if (!isAction(action) || action.kind !== 'appendtoarrayvariable') {
    return null;
  }

  const inputs = action.inputs as VariableActionInputs;
  if (!inputs.name || inputs.value === undefined) {
    return null;
  }

  return {
    variableName: inputs.name,
    appendValue: inputs.value,
  };
}

/**
 * Validates that the pattern is safe to optimize.
 */
function isPatternValid(nodes: Node[], initIndex: number, foreachIndex: number, varName: string): boolean {
  // Check nodes between init and foreach for variable usage
  for (let i = initIndex + 1; i < foreachIndex; i++) {
    if (nodeReferencesVariable(nodes[i], varName)) {
      return false;
    }
  }

  return true;
}

/**
 * Checks if a node references a variable.
 */
function nodeReferencesVariable(node: Node, varName: string): boolean {
  const nodeStr = JSON.stringify(node);
  const pattern = new RegExp(`@variables\\(['"]${escapeRegex(varName)}['"]\\)`, 'g');
  return pattern.test(nodeStr);
}

/**
 * Applies the optimization, replacing init + foreach with a select action.
 */
function applyOptimization(
  nodes: Node[],
  pattern: AppendPattern,
  report: OptimizationReport,
  path: string[]
): void {
  // Create the select action
  const selectAction: ActionNode = {
    id: pattern.initNode.id,
    name: pattern.initNode.name.replace(/^Initialize_?/i, '') || pattern.variableName,
    type: 'action',
    kind: 'select',
    inputs: {
      from: pattern.foreachNode.itemsExpression,
      select: pattern.appendValue,
    } as DataOperationInputs,
  };

  // Copy runAfter from the init node if it exists
  if (pattern.initNode.runAfter) {
    selectAction.runAfter = pattern.initNode.runAfter;
  }

  // Record the change
  addChange(report, {
    type: 'append_to_select',
    originalAction: `${pattern.initNode.name} + ${pattern.foreachNode.name}`,
    newAction: selectAction.name,
    location: path,
    description: `Converted loop+append pattern for '${pattern.variableName}' to Select action (enables parallelism)`,
  });

  // Remove the foreach node (must do first since index is higher)
  nodes.splice(pattern.foreachIndex, 1);

  // Replace the init node with the select action
  nodes[pattern.initIndex] = selectAction;

  // Update references from @variables('varName') to @body('selectName')
  updateReferencesInNodes(nodes, pattern.variableName, selectAction.name);

  // Rewrite runAfter dependencies that pointed at the removed foreach or the
  // renamed init action, so later actions don't reference deleted nodes
  updateRunAfterReferences(nodes, [pattern.foreachNode.name, pattern.initNode.name], selectAction.name);
}

/**
 * Renames runAfter keys that reference removed/renamed actions.
 */
function updateRunAfterReferences(nodes: Node[], oldNames: string[], newName: string): void {
  for (const node of nodes) {
    const runAfter = (node as { runAfter?: Record<string, string[]> }).runAfter;
    if (!runAfter) continue;

    for (const oldName of oldNames) {
      if (oldName === newName || !(oldName in runAfter)) continue;
      const statuses = runAfter[oldName];
      delete runAfter[oldName];
      // Merge with an existing dependency on the new name if present
      runAfter[newName] = Array.from(new Set([...(runAfter[newName] ?? []), ...statuses]));
    }
  }
}

/**
 * Updates variable references in all nodes after optimization.
 */
function updateReferencesInNodes(nodes: Node[], varName: string, composeName: string): void {
  for (let i = 0; i < nodes.length; i++) {
    nodes[i] = updateNodeReferences(nodes[i], varName, composeName);
  }
}

/**
 * Updates variable references in a single node.
 */
function updateNodeReferences(node: Node, varName: string, composeName: string): Node {
  if (isAction(node)) {
    const inputsStr = JSON.stringify(node.inputs);
    const updatedStr = replaceVariableRefs(inputsStr, varName, composeName);

    if (inputsStr !== updatedStr) {
      return {
        ...node,
        inputs: JSON.parse(updatedStr),
      };
    }
    return node;
  }

  if (isForeach(node)) {
    return {
      ...node,
      itemsExpression: replaceVariableRefs(node.itemsExpression, varName, composeName),
      actions: node.actions.map(n => updateNodeReferences(n, varName, composeName)),
    } as ForeachNode;
  }

  if (isIf(node)) {
    return {
      ...node,
      condition: replaceVariableRefs(node.condition, varName, composeName),
      actions: node.actions.map(n => updateNodeReferences(n, varName, composeName)),
      elseActions: node.elseActions?.map(n => updateNodeReferences(n, varName, composeName)),
    } as IfNode;
  }

  if (isScope(node)) {
    return {
      ...node,
      actions: node.actions.map(n => updateNodeReferences(n, varName, composeName)),
    } as ScopeNode;
  }

  if (isSwitch(node)) {
    return {
      ...node,
      expression: replaceVariableRefs(node.expression, varName, composeName),
      cases: node.cases.map(c => ({
        ...c,
        actions: c.actions.map(n => updateNodeReferences(n, varName, composeName)),
      })),
      defaultActions: node.defaultActions?.map(n => updateNodeReferences(n, varName, composeName)),
    } as SwitchNode;
  }

  if (isDoUntil(node)) {
    return {
      ...node,
      condition: replaceVariableRefs(node.condition, varName, composeName),
      actions: node.actions.map(n => updateNodeReferences(n, varName, composeName)),
    } as DoUntilNode;
  }

  return node;
}

/**
 * Replaces @variables('name') with @body('composeName').
 */
function replaceVariableRefs(str: string, varName: string, composeName: string): string {
  let result = str;
  const escapedVarName = escapeRegex(varName);

  // Replace @variables('varName') with @body('composeName')
  const atVarPattern = new RegExp(`@variables\\(['"]${escapedVarName}['"]\\)`, 'g');
  result = result.replace(atVarPattern, `@body('${composeName}')`);

  // Replace @{variables('varName')} with @{body('composeName')} (embedded expressions)
  const embeddedPattern = new RegExp(`@\\{variables\\(['"]${escapedVarName}['"]\\)`, 'g');
  result = result.replace(embeddedPattern, `@{body('${composeName}')`);

  // Replace variables('varName') without @ prefix (nested in other functions)
  const nestedPattern = new RegExp(`(?<!@)variables\\(['"]${escapedVarName}['"]\\)`, 'g');
  result = result.replace(nestedPattern, `body('${composeName}')`);

  return result;
}

/**
 * Escapes special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
