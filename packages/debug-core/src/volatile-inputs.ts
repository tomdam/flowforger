/**
 * Expression-derived volatile-input masking for edit-and-continue replay.
 *
 * A connector input built from utcNow()/guid()/rand()/ticks() evaluates to a
 * different value on every run, so strict input matching cache-misses on every
 * apply — a spurious live re-call plus a divergence pause. The mask is computed
 * from the ACTIVE IR's expression text (per node name; names are deterministic
 * across recompiles) and the matcher compares inputs with masked paths deleted
 * from both sides. Volatile values that travel through variables are NOT
 * detected (documented v2 limitation — the "match by name only" toggle remains
 * in the backlog). The map covers the root IR only; child-flow calls fall back
 * to strict matching.
 */

import type { FlowIR, Node } from '@flowforger/ir';

const VOLATILE_FN = /\b(utcNow|guid|rand|ticks)\s*\(/i;

/** nodeName -> dotted JSON paths (arrays by index) of inputs whose expression text is volatile. */
export function computeVolatileInputPaths(ir: FlowIR): Map<string, string[]> {
  const masks = new Map<string, string[]>();
  const visit = (nodes: Node[]) => {
    for (const node of nodes) {
      const anyNode = node as any;
      const raw =
        node.type === 'connector' ? anyNode.params :
        node.type === 'action' ? anyNode.inputs :
        null;
      if (raw && typeof raw === 'object') {
        const paths: string[] = [];
        collectVolatilePaths(raw, [], paths);
        if (paths.length > 0) masks.set(node.name, paths);
      }
      for (const list of [anyNode.actions, anyNode.elseActions, anyNode.defaultActions]) {
        if (Array.isArray(list)) visit(list);
      }
      if (Array.isArray(anyNode.cases)) {
        for (const c of anyNode.cases) if (Array.isArray(c.actions)) visit(c.actions);
      }
    }
  };
  visit(ir.nodes);
  return masks;
}

function collectVolatilePaths(value: unknown, path: Array<string | number>, out: string[]): void {
  if (typeof value === 'string') {
    if (VOLATILE_FN.test(value)) out.push(path.join('.'));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectVolatilePaths(v, [...path, i], out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectVolatilePaths(v, [...path, k], out);
  }
}

/**
 * Deep-clone `inputs` with the masked paths deleted. Returns `inputs`
 * unchanged (same reference) when there is nothing to mask or the value
 * cannot be JSON-cloned (non-plain inputs then match strictly).
 */
export function maskInputs(inputs: unknown, paths: string[] | undefined): unknown {
  if (!paths || paths.length === 0) return inputs;
  let clone: unknown;
  try {
    clone = JSON.parse(JSON.stringify(inputs));
  } catch {
    return inputs;
  }
  for (const path of paths) deleteAtPath(clone, path.split('.'));
  return clone;
}

function deleteAtPath(value: unknown, segments: string[]): void {
  let cur: any = value;
  for (let i = 0; i < segments.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return;
    cur = cur[segments[i]];
  }
  if (cur != null && typeof cur === 'object') delete cur[segments[segments.length - 1]];
}
