/**
 * Pure primitives shared by the debug DRIVERS (web `engine-wrapper`, VS Code
 * DAP adapter): name-based mapping across recompiles, execution-count rewind,
 * and the restart-based-rewind precondition rules.
 *
 * Mapping is by node NAME — the DSL transformer's auto-generated names are
 * deterministic across recompiles, while node IDs are not (global counter
 * reset).
 */

import type { FlowIR, Node } from '@flowforger/ir';
import type { FastForwardTarget } from './fast-forward.js';

/** Every child list a node can carry (branches, cases, loop bodies). */
function childLists(node: Node): Node[][] {
  const anyNode = node as any;
  const lists: Node[][] = [];
  for (const list of [anyNode.actions, anyNode.elseActions, anyNode.defaultActions]) {
    if (Array.isArray(list)) lists.push(list);
  }
  if (Array.isArray(anyNode.cases)) {
    for (const c of anyNode.cases) if (Array.isArray(c.actions)) lists.push(c.actions);
  }
  return lists;
}

/** nodeId -> Node across all nesting (loop bodies included). */
export function buildNodeIndex(nodes: Node[]): Map<string, Node> {
  const index = new Map<string, Node>();
  const visit = (ns: Node[]) => {
    for (const n of ns) {
      index.set(n.id, n);
      for (const list of childLists(n)) visit(list);
    }
  };
  visit(nodes);
  return index;
}

/** Depth-first search by name across all nesting. */
export function findNodeByName(nodes: Node[], name: string): Node | null {
  for (const node of nodes) {
    if (node.name === name) return node;
    for (const list of childLists(node)) {
      const found = findNodeByName(list, name);
      if (found) return found;
    }
  }
  return null;
}

/** Collect a node's name plus every descendant name. */
function collectNamesDeep(node: Node, out: Set<string>): void {
  out.add(node.name);
  for (const list of childLists(node)) {
    for (const child of list) collectNamesDeep(child, out);
  }
}

/**
 * Rewind execution counts after an in-place jump: every node in the
 * continuation set (and, for control nodes, ALL its descendants including
 * foreach/dountil bodies) may re-execute, and a later apply's fast-forward
 * replays a fresh run in which those nodes run from zero. Deleting their
 * counts keeps the fast-forward hit counts consistent with that fresh run.
 */
export function rewindExecutionCounts(
  resetNodeIds: string[],
  nodeIndex: Map<string, Node>,
  executionCounts: Map<string, number>,
): void {
  const names = new Set<string>();
  for (const id of resetNodeIds) {
    const node = nodeIndex.get(id);
    if (!node) continue;
    collectNamesDeep(node, names);
  }
  for (const name of names) executionCounts.delete(name);
}

/** Map breakpoint node IDs across a recompile: old ID -> name -> new ID. Unmatched names are dropped. */
export function remapBreakpointsByName(
  oldIds: Set<string>,
  oldNodeIndex: Map<string, Node>,
  newIr: FlowIR,
): Set<string> {
  const remapped = new Set<string>();
  for (const oldId of oldIds) {
    const name = oldNodeIndex.get(oldId)?.name;
    if (!name) continue;
    const newNode = findNodeByName(newIr.nodes, name);
    if (newNode) remapped.add(newNode.id);
  }
  return remapped;
}

/**
 * Fast-forward target for the new run, or null when the previous position
 * does not exist in the new IR (deleted/renamed — fast-forward then runs to
 * divergence or completion).
 */
export function computeFastForwardTarget(
  targetName: string | null,
  newIr: FlowIR,
  executionCounts: Map<string, number>,
): FastForwardTarget | null {
  if (!targetName) return null;
  if (!findNodeByName(newIr.nodes, targetName)) return null;
  return { nodeName: targetName, hitCount: executionCounts.get(targetName) ?? 0 };
}

export interface RewindPreconditionInput {
  /** The jump target resolved against the ROOT IR index, if it exists there. */
  node: Node | undefined;
  /** Completed executions of that node in the current run. */
  executionCount: number;
  /** The in-place jump's own rejection message, surfaced when the target is not a root-IR node. */
  inPlaceError: string;
}

export type RewindDecision =
  | { ok: true; nodeName: string; hitCount: number }
  | { ok: false; error: string };

/**
 * Preconditions for the restart-based rewind fallback (used when the in-place
 * jump rejects). Backward-only: the target must already have executed, since a
 * restart cannot "skip". Containers are rejected because execution-boundary
 * markers for a control node's children are recorded BEFORE the container's
 * own marker, so truncating at the container would leave its body's calls
 * replayable instead of live.
 *
 * On success `hitCount` is the pause-before fast-forward target for the most
 * recent execution (`executionCount - 1`); the caller truncates the replay log
 * with `truncateBefore(nodeName, executionCount)`.
 */
export function evaluateRewindPreconditions(input: RewindPreconditionInput): RewindDecision {
  const { node, executionCount, inPlaceError } = input;
  if (!node) return { ok: false, error: inPlaceError };
  if (node.type === 'trigger' || node.type === 'recurrence') {
    return { ok: false, error: 'Cannot jump to a trigger.' };
  }
  if (
    node.type === 'foreach' || node.type === 'dountil' ||
    node.type === 'scope' || node.type === 'if' || node.type === 'switch'
  ) {
    return {
      ok: false,
      error: 'Cannot rewind to a control-flow block from this pause — rewind to a statement inside it (or before it) instead.',
    };
  }
  if (executionCount < 1) {
    return {
      ok: false,
      error: 'Cannot jump to a statement that has not executed yet in this run — only already-executed statements can be rewound to.',
    };
  }
  return { ok: true, nodeName: node.name, hitCount: executionCount - 1 };
}
