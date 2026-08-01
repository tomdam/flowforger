/**
 * Set-next-statement continuation-set computation.
 *
 * The debug step loop flattens if/scope/switch children inline (foreach and
 * dountil bodies stay engine-owned and are NOT in the flat list). After a
 * jump, the loop's handled-set is rebuilt wholesale: every inlined descendant
 * in the frame is marked handled, then the "continuation set" computed here
 * is unmarked — the target, its following siblings within its own branch,
 * and, walking up the ancestor chain to top level, each ancestor's following
 * siblings — each together with its own inlined descendants. That one
 * algorithm yields Visual Studio jump semantics in both directions and at
 * any nesting depth: the jumped-into branch runs to its end, sibling
 * branches are skipped, and execution continues after the parent.
 */

import type { Node } from '@flowforger/ir';

/** Child lists a control node inlines into the flat step list (mirrors DebugSession.flattenNodes). */
function inlinedChildLists(node: Node): Node[][] {
  const anyNode = node as any;
  const lists: Node[][] = [];
  if (node.type === 'scope' && Array.isArray(anyNode.actions)) lists.push(anyNode.actions);
  if (node.type === 'if') {
    if (Array.isArray(anyNode.actions)) lists.push(anyNode.actions);
    if (Array.isArray(anyNode.elseActions)) lists.push(anyNode.elseActions);
  }
  if (node.type === 'switch') {
    for (const c of anyNode.cases ?? []) if (Array.isArray(c.actions)) lists.push(c.actions);
    if (Array.isArray(anyNode.defaultActions)) lists.push(anyNode.defaultActions);
  }
  return lists;
}

/** Collect every inlined descendant id of `node` into `out` (foreach/dountil bodies excluded). */
export function collectInlinedDescendantIds(node: Node, out: Set<string>): void {
  for (const list of inlinedChildLists(node)) {
    for (const child of list) {
      out.add(child.id);
      collectInlinedDescendantIds(child, out);
    }
  }
}

/** Ancestor path [top-level node, ..., target] through inlined child lists, or null. */
function findPathToNode(nodes: Node[], targetId: string): Node[] | null {
  for (const node of nodes) {
    if (node.id === targetId) return [node];
    for (const list of inlinedChildLists(node)) {
      const sub = findPathToNode(list, targetId);
      if (sub) return [node, ...sub];
    }
  }
  return null;
}

/**
 * The node ids that may (re-)execute after a jump to `targetId`, or null when
 * the target is not reachable through inlined child lists (unknown id, or a
 * node inside an engine-owned foreach/dountil body).
 */
export function computeContinuationSet(frameNodes: Node[], targetId: string): Set<string> | null {
  const path = findPathToNode(frameNodes, targetId);
  if (!path) return null;

  const out = new Set<string>();
  let container = frameNodes;
  for (let depth = 0; depth < path.length; depth++) {
    const isTargetLevel = depth === path.length - 1;
    const idx = container.indexOf(path[depth]);
    // Ancestors already ran (or were skipped past): only their FOLLOWING
    // siblings continue. The target itself is included at the deepest level.
    for (let j = isTargetLevel ? idx : idx + 1; j < container.length; j++) {
      out.add(container[j].id);
      collectInlinedDescendantIds(container[j], out);
    }
    if (!isTargetLevel) {
      const next = path[depth + 1];
      container = inlinedChildLists(path[depth]).find((list) => list.includes(next))!;
    }
  }
  return out;
}
