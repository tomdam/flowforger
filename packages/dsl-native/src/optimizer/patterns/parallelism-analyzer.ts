/**
 * Parallelism Analyzer
 *
 * Detects variable usage patterns that would disable parallel execution in loops.
 * This analyzer emits warnings only (no auto-fix) because:
 * - The user may intentionally want sequential execution
 * - Some patterns can't be safely converted automatically
 *
 * Warning triggers:
 * - SetVariable inside a foreach loop
 * - IncrementVariable / DecrementVariable inside a foreach loop
 * - AppendToArrayVariable inside a foreach loop (if not optimized to Select)
 * - AppendToStringVariable inside a foreach loop
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
import { OptimizationReport, addWarning } from '../report.js';

/**
 * Variable mutation kinds that disable parallelism in loops.
 */
const PARALLELISM_BLOCKING_KINDS = new Set([
  'setvariable',
  'incrementvariable',
  'decrementvariable',
  'appendtoarrayvariable',
  'appendtostringvariable',
]);

/**
 * Information about a variable mutation in a loop.
 */
interface LoopMutation {
  /** The foreach node containing the mutation */
  loopNode: ForeachNode;
  /** The action node that mutates the variable */
  mutationNode: ActionNode;
  /** The variable name being mutated */
  variableName: string;
  /** The kind of mutation */
  mutationKind: string;
  /** Path to the mutation */
  path: string[];
}

/**
 * Analyzes the flow for parallelism-blocking patterns and emits warnings.
 *
 * @param ir - The FlowIR to analyze
 * @param report - Report to add warnings to
 */
export function analyzeParallelismIssues(ir: FlowIR, report: OptimizationReport): void {
  // Find all variables declared outside loops
  const outerVariables = findOuterVariables(ir.nodes);

  // Find mutations of those variables inside loops
  const mutations = findLoopMutations(ir.nodes, outerVariables, [], null);

  // Group mutations by loop
  const mutationsByLoop = groupMutationsByLoop(mutations);

  // Emit warnings
  for (const [loopName, loopMutations] of mutationsByLoop) {
    const variableNames = [...new Set(loopMutations.map(m => m.variableName))];
    const path = loopMutations[0]?.path || [];

    // Check if the loop already has parallel: false
    const loopNode = loopMutations[0].loopNode;
    if (loopNode.parallel === false) {
      // Loop is already sequential, no warning needed
      continue;
    }

    const suggestions = getSuggestions(loopMutations);

    addWarning(report, {
      type: 'parallelism_warning',
      location: path,
      message: `Variables [${variableNames.join(', ')}] are mutated in loop '${loopName}', which disables parallel execution`,
      suggestion: suggestions.join('; '),
      affectedVariables: variableNames,
    });
  }
}

/**
 * Finds all variables declared at the outer scope (not inside loops).
 */
function findOuterVariables(nodes: Node[]): Set<string> {
  const variables = new Set<string>();

  for (const node of nodes) {
    if (isAction(node) && node.kind === 'initializevariable') {
      const inputs = node.inputs as VariableActionInputs;
      if (inputs.variableName) {
        variables.add(inputs.variableName);
      }
    }

    // Recurse into non-loop control flow
    // Variables declared in if/scope/switch are still outer to any nested loops
    if (isIf(node)) {
      const thenVars = findOuterVariables(node.actions);
      const elseVars = node.elseActions ? findOuterVariables(node.elseActions) : new Set<string>();
      for (const v of thenVars) variables.add(v);
      for (const v of elseVars) variables.add(v);
    }

    if (isScope(node)) {
      const scopeVars = findOuterVariables(node.actions);
      for (const v of scopeVars) variables.add(v);
    }

    if (isSwitch(node)) {
      for (const c of node.cases) {
        const caseVars = findOuterVariables(c.actions);
        for (const v of caseVars) variables.add(v);
      }
      if (node.defaultActions) {
        const defaultVars = findOuterVariables(node.defaultActions);
        for (const v of defaultVars) variables.add(v);
      }
    }

    // Don't recurse into foreach - variables there are loop-local
  }

  return variables;
}

/**
 * Finds all mutations of outer variables inside loops.
 */
function findLoopMutations(
  nodes: Node[],
  outerVariables: Set<string>,
  path: string[],
  currentLoop: ForeachNode | null
): LoopMutation[] {
  const mutations: LoopMutation[] = [];

  for (const node of nodes) {
    if (isForeach(node)) {
      // Enter a new loop context
      const loopMutations = findLoopMutations(
        node.actions,
        outerVariables,
        [...path, node.name],
        node
      );
      mutations.push(...loopMutations);
      continue;
    }

    if (currentLoop && isAction(node) && PARALLELISM_BLOCKING_KINDS.has(node.kind)) {
      const inputs = node.inputs as VariableActionInputs;
      const varName = inputs.name || inputs.variableName;

      if (varName && outerVariables.has(varName)) {
        mutations.push({
          loopNode: currentLoop,
          mutationNode: node,
          variableName: varName,
          mutationKind: node.kind,
          path: [...path],
        });
      }
    }

    // Recurse into control flow within the current loop context
    if (isIf(node)) {
      mutations.push(...findLoopMutations(node.actions, outerVariables, [...path, node.name], currentLoop));
      if (node.elseActions) {
        mutations.push(...findLoopMutations(node.elseActions, outerVariables, [...path, node.name], currentLoop));
      }
    }

    if (isScope(node)) {
      mutations.push(...findLoopMutations(node.actions, outerVariables, [...path, node.name], currentLoop));
    }

    if (isSwitch(node)) {
      for (const c of node.cases) {
        mutations.push(...findLoopMutations(c.actions, outerVariables, [...path, node.name], currentLoop));
      }
      if (node.defaultActions) {
        mutations.push(...findLoopMutations(node.defaultActions, outerVariables, [...path, node.name], currentLoop));
      }
    }

    if (isDoUntil(node)) {
      mutations.push(...findLoopMutations(node.actions, outerVariables, [...path, node.name], currentLoop));
    }
  }

  return mutations;
}

/**
 * Groups mutations by their containing loop.
 */
function groupMutationsByLoop(mutations: LoopMutation[]): Map<string, LoopMutation[]> {
  const grouped = new Map<string, LoopMutation[]>();

  for (const mutation of mutations) {
    const loopName = mutation.loopNode.name;
    if (!grouped.has(loopName)) {
      grouped.set(loopName, []);
    }
    grouped.get(loopName)!.push(mutation);
  }

  return grouped;
}

/**
 * Generates suggestions based on the types of mutations found.
 */
function getSuggestions(mutations: LoopMutation[]): string[] {
  const suggestions: string[] = [];
  const kinds = new Set(mutations.map(m => m.mutationKind));

  if (kinds.has('appendtoarrayvariable')) {
    suggestions.push('Consider using Select action instead of loop+append');
  }

  if (kinds.has('incrementvariable') || kinds.has('decrementvariable')) {
    suggestions.push('Consider using length() on the source array instead of counter');
  }

  if (kinds.has('setvariable')) {
    suggestions.push('Consider restructuring to avoid setting variables in the loop');
  }

  if (kinds.has('appendtostringvariable')) {
    suggestions.push('Consider using concat() or join() outside the loop');
  }

  if (suggestions.length === 0) {
    suggestions.push('Consider restructuring to enable parallel execution');
  }

  return suggestions;
}
