/**
 * Single-Set Variable to Compose Optimization
 *
 * Converts variables that are initialized but never modified to compose actions.
 * Compose actions are ~2x faster than variable operations in Power Automate.
 *
 * Pattern:
 *   let status: string = 'active';
 *   // ... status is never modified via setVariable, increment, append, etc.
 *   ctx.variables('status')
 *
 * Transforms to:
 *   await ctx.compose('status', 'active');
 *   // ... references change from @variables('status') to @outputs('status')
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
 * Information about a variable in the flow.
 */
interface VariableInfo {
  /** The name of the variable */
  name: string;
  /** The node where the variable is initialized */
  initNode: ActionNode;
  /** Path to the initialization node */
  initPath: string[];
  /** Whether the variable is mutated after initialization */
  isMutated: boolean;
  /** Names of actions that reference this variable */
  referencedBy: string[];
}

/**
 * Optimizes single-set variables to compose actions.
 *
 * @param ir - The FlowIR to optimize
 * @param report - Report to record changes
 * @returns The optimized FlowIR
 */
export function optimizeSingleSetVariables(ir: FlowIR, report: OptimizationReport, excludeActions?: Set<string>): FlowIR {
  // Step 1: Collect all variable information
  const variables = collectVariableInfo(ir.nodes, []);

  // Step 2: Find variables that are never mutated (and not excluded)
  const optimizableVars = Array.from(variables.values()).filter(v =>
    !v.isMutated && (!excludeActions || !excludeActions.has(v.initNode.name))
  );

  if (optimizableVars.length === 0) {
    return ir;
  }

  // Step 3: Transform the IR
  // Create a map of variable names to their new compose action names
  const varToCompose = new Map<string, string>();
  for (const varInfo of optimizableVars) {
    varToCompose.set(varInfo.name, varInfo.initNode.name);
  }

  // Transform nodes
  ir.nodes = transformNodes(ir.nodes, varToCompose, report, []);

  return ir;
}

/**
 * Collects information about all variables in the flow.
 * Pass existing variables map to detect mutations of outer-scope variables.
 */
function collectVariableInfo(
  nodes: Node[],
  path: string[],
  existingVariables?: Map<string, VariableInfo>
): Map<string, VariableInfo> {
  const variables = existingVariables || new Map<string, VariableInfo>();

  for (const node of nodes) {
    if (isAction(node)) {
      if (node.kind === 'initializevariable') {
        const inputs = node.inputs as VariableActionInputs;
        const varName = inputs.variableName;
        if (varName && !variables.has(varName)) {
          variables.set(varName, {
            name: varName,
            initNode: node,
            initPath: [...path],
            isMutated: false,
            referencedBy: [],
          });
        }
      } else if (MUTATION_KINDS.has(node.kind)) {
        // This is a mutation operation - mark the variable as mutated
        const inputs = node.inputs as VariableActionInputs;
        const varName = inputs.name || inputs.variableName;
        if (varName && variables.has(varName)) {
          variables.get(varName)!.isMutated = true;
        }
      }

      // Check for variable references in expressions
      collectVariableReferences(node, variables);
    }

    // Recurse into control flow nodes, passing the SAME variables map
    // so mutations inside loops/conditions update outer-scope variables
    const childNodes = getChildNodes(node);
    for (const children of childNodes) {
      const childPath = [...path, node.name];
      collectVariableInfo(children, childPath, variables);
    }
  }

  return variables;
}

/**
 * Collects variable references from a node's expressions.
 */
function collectVariableReferences(node: ActionNode, variables: Map<string, VariableInfo>): void {
  const nodeStr = JSON.stringify(node.inputs);

  // Find all @variables('name') patterns
  const regex = /@variables\(['"]([^'"]+)['"]\)/g;
  let match;
  while ((match = regex.exec(nodeStr)) !== null) {
    const varName = match[1];
    if (variables.has(varName)) {
      variables.get(varName)!.referencedBy.push(node.name);
    }
  }
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
 * Transforms nodes, converting initializevariable to compose and updating references.
 */
function transformNodes(
  nodes: Node[],
  varToCompose: Map<string, string>,
  report: OptimizationReport,
  path: string[]
): Node[] {
  return nodes.map(node => {
    if (isAction(node)) {
      if (node.kind === 'initializevariable') {
        const inputs = node.inputs as VariableActionInputs;
        const varName = inputs.variableName;

        if (varName && varToCompose.has(varName)) {
          // Convert to compose action
          const composeName = varToCompose.get(varName)!;

          addChange(report, {
            type: 'single_set_variable_to_compose',
            originalAction: node.name,
            newAction: composeName,
            location: path,
            description: `Converted variable '${varName}' to compose (never mutated after initialization)`,
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

    // Recurse into control flow nodes
    if (isForeach(node)) {
      return {
        ...node,
        actions: transformNodes(node.actions, varToCompose, report, [...path, node.name]),
        itemsExpression: replaceVariableRefs(node.itemsExpression, varToCompose),
      } as ForeachNode;
    }

    if (isIf(node)) {
      return {
        ...node,
        condition: replaceVariableRefs(node.condition, varToCompose),
        actions: transformNodes(node.actions, varToCompose, report, [...path, node.name]),
        elseActions: node.elseActions
          ? transformNodes(node.elseActions, varToCompose, report, [...path, node.name])
          : undefined,
      } as IfNode;
    }

    if (isScope(node)) {
      return {
        ...node,
        actions: transformNodes(node.actions, varToCompose, report, [...path, node.name]),
      } as ScopeNode;
    }

    if (isSwitch(node)) {
      return {
        ...node,
        expression: replaceVariableRefs(node.expression, varToCompose),
        cases: node.cases.map(c => ({
          ...c,
          actions: transformNodes(c.actions, varToCompose, report, [...path, node.name]),
        })),
        defaultActions: node.defaultActions
          ? transformNodes(node.defaultActions, varToCompose, report, [...path, node.name])
          : undefined,
      } as SwitchNode;
    }

    if (isDoUntil(node)) {
      return {
        ...node,
        condition: replaceVariableRefs(node.condition, varToCompose),
        actions: transformNodes(node.actions, varToCompose, report, [...path, node.name]),
      } as DoUntilNode;
    }

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
 * Handles multiple formats:
 * - @variables('name') - standard expression
 * - @{variables('name')} - embedded expression in string
 * - variables('name') - nested function call
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
    // Be careful to not replace if preceded by @ (already handled above)
    const nestedPattern = new RegExp(`(?<!@)variables\\(['"]${escapedVarName}['"]\\)`, 'g');
    result = result.replace(nestedPattern, `outputs('${composeName}')`);
  }

  return result;
}

/**
 * Escapes special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
