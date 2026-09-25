import type { FlowIR, Node } from '@flowforger/ir';
import type { ValidationIssue } from './index.js';

/**
 * Placement rules — where an action is allowed to sit in the workflow tree.
 *
 * These mirror checks the Logic Apps / Power Automate workflow service performs when a flow is
 * saved or activated; the cloud rejects the definition with `InvalidWorkflowRunAction` /
 * `InvalidTemplate`, so we surface them locally before push. Sources:
 *   - Response: "Your workflow can use the Response action only when the workflow starts with an
 *     HTTP request trigger" and "anywhere except inside Foreach loops, Until loops, including
 *     sequential loops, and parallel branches"
 *     (learn.microsoft.com/azure/logic-apps/logic-apps-workflow-actions-triggers#response-action)
 *   - Terminate: "can't appear inside Foreach and Until loops, including sequential loops"
 *     (same page, #terminate-action). Cloud error: "The workflow run action 'X' has type
 *     'Terminate' that could not be nested under an action of type 'foreach'."
 *   - InitializeVariable: must be top level (already covered by VAR_INIT_NESTED in the IR walk;
 *     the Logic Apps JSON walk adds the same code here).
 *   - Nesting depth: "Actions nesting depth: 8"
 *     (learn.microsoft.com/azure/logic-apps/logic-apps-limits-and-config#definition-limits).
 */

/** Logic Apps enforces at most 8 levels of action nesting. Root actions are depth 1. */
export const MAX_ACTION_NESTING_DEPTH = 8;

/** The only trigger types a Response action may be paired with. */
const REQUEST_TRIGGER_TYPES = new Set(['request', 'manual']);

type LoopKind = 'foreach' | 'until';

interface LoopAncestor {
  kind: LoopKind;
  name: string;
}

/** Normalised runAfter: predecessor name → lower-cased statuses. */
type RunAfterMap = Map<string, Set<string>>;

function normaliseRunAfter(raw: unknown): RunAfterMap {
  const map: RunAfterMap = new Map();
  if (!raw || typeof raw !== 'object') return map;
  for (const [pred, statuses] of Object.entries(raw as Record<string, unknown>)) {
    const set = new Set<string>();
    if (Array.isArray(statuses)) {
      for (const s of statuses) if (typeof s === 'string') set.add(s.toLowerCase());
    } else if (typeof statuses === 'string') {
      set.add(statuses.toLowerCase());
    }
    map.set(pred, set);
  }
  return map;
}

/**
 * Find a sibling that fans out from the same predecessor with an overlapping status, i.e. a
 * sibling that runs *in parallel* with `name`. Two actions that both follow `Try` but on disjoint
 * statuses (`Succeeded` vs `Failed`) are mutually exclusive branches, not parallel ones, and are
 * not reported.
 */
function findParallelSibling(
  name: string,
  siblings: Array<{ name: string; runAfter: RunAfterMap }>,
): { sibling: string; predecessor: string; status: string } | undefined {
  const self = siblings.find((s) => s.name === name);
  if (!self || self.runAfter.size === 0) return undefined;
  for (const other of siblings) {
    if (other.name === name) continue;
    for (const [pred, statuses] of self.runAfter) {
      const otherStatuses = other.runAfter.get(pred);
      if (!otherStatuses) continue;
      for (const status of statuses) {
        if (otherStatuses.has(status)) {
          return { sibling: other.name, predecessor: pred, status };
        }
      }
    }
  }
  return undefined;
}

function describeLoop(loop: LoopAncestor): string {
  return `${loop.kind === 'foreach' ? 'foreach (Apply to each)' : 'until (Do until)'} loop '${loop.name}'`;
}

function nestedInLoopIssue(
  typeLabel: 'Response' | 'Terminate',
  name: string,
  loop: LoopAncestor,
  path: string,
): ValidationIssue {
  const hint =
    typeLabel === 'Response'
      ? `Collect the result in a variable inside the loop and send a single Response after the loop.`
      : `Set a flag variable inside the loop and terminate after it, or filter the items before the loop so the failing case never enters it.`;
  return {
    level: 'error',
    code: typeLabel === 'Response' ? 'RESPONSE_NESTED' : 'TERMINATE_NESTED',
    message:
      `${typeLabel} action '${name}' is nested inside ${describeLoop(loop)}. ` +
      `Power Automate rejects the flow on save: "The workflow run action '${name}' has type '${typeLabel}' that could not be nested under an action of type '${loop.kind}'". ` +
      `${typeLabel} is not allowed inside foreach or until loops (at any depth). ${hint}`,
    path,
  };
}

function parallelIssue(
  name: string,
  hit: { sibling: string; predecessor: string; status: string },
  path: string,
): ValidationIssue {
  return {
    level: 'warning',
    code: 'RESPONSE_PARALLEL',
    message:
      `Response action '${name}' runs in a parallel branch: it and '${hit.sibling}' both run after '${hit.predecessor}' (${hit.status}). ` +
      `Logic Apps does not allow a Response action inside parallel branches. ` +
      `Join the branches first (an action whose @runAfter lists every branch) and respond after the join.`,
    path,
  };
}

function depthIssue(name: string, depth: number, path: string): ValidationIssue {
  return {
    level: 'warning',
    code: 'NESTING_DEPTH',
    message:
      `Action '${name}' is nested ${depth} levels deep; Logic Apps limits action nesting depth to ${MAX_ACTION_NESTING_DEPTH}. ` +
      `Flatten the control flow or move the inner part into a child flow.`,
    path,
  };
}

function triggerIssue(name: string, triggerLabel: string, path: string): ValidationIssue {
  return {
    level: 'error',
    code: 'RESPONSE_TRIGGER',
    message:
      `Response action '${name}' requires a request trigger (HTTP request, manual/button, Power Apps or Copilot trigger), but this flow starts with ${triggerLabel}. ` +
      `Power Automate rejects the flow on save. Remove the Response (there is no caller to respond to) or change the trigger.`,
    path,
  };
}

// ---------------------------------------------------------------------------------------------
// Flow IR
// ---------------------------------------------------------------------------------------------

function irTriggerLabel(ir: FlowIR): { isRequest: boolean; label: string } | undefined {
  const trigger = ir.nodes.find((n) => n.type === 'trigger' || n.type === 'recurrence') as any;
  if (!trigger) return undefined;
  if (trigger.type === 'recurrence') return { isRequest: false, label: `a recurrence trigger ('${trigger.name}')` };
  if (trigger.kind === 'connector') {
    const inputs = trigger.inputs || {};
    return {
      isRequest: false,
      label: `a connector trigger ('${trigger.name}': ${inputs.connector ?? '?'} ${inputs.operation ?? ''}`.trim() + ')',
    };
  }
  return { isRequest: true, label: `a request trigger ('${trigger.name}')` };
}

/**
 * Effective runAfter of IR siblings. The emitter chains an action without an explicit runAfter
 * to the previous sibling (Succeeded); `{}` means "first action". Mirrors
 * packages/emitter-logicapps/src/index.ts.
 */
function irSiblingRunAfter(nodes: Node[]): Array<{ name: string; runAfter: RunAfterMap }> {
  const out: Array<{ name: string; runAfter: RunAfterMap }> = [];
  let prev: string | undefined;
  for (const n of nodes) {
    if (n.type === 'trigger' || n.type === 'recurrence') continue;
    const explicit = (n as any).runAfter;
    const runAfter =
      explicit !== undefined
        ? normaliseRunAfter(explicit)
        : normaliseRunAfter(prev ? { [prev]: ['Succeeded'] } : {});
    out.push({ name: n.name, runAfter });
    prev = n.name;
  }
  return out;
}

export function collectIrPlacementIssues(ir: FlowIR): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const trigger = irTriggerLabel(ir);

  function walk(nodes: Node[], loops: LoopAncestor[], depth: number) {
    const siblings = irSiblingRunAfter(nodes);
    for (const n of nodes) {
      if (n.type === 'trigger' || n.type === 'recurrence') continue;
      const path = `nodes.${n.name}`;
      const innermostLoop = loops[loops.length - 1];

      if (n.type === 'action' && (n.kind === 'response' || n.kind === 'terminate')) {
        const label = n.kind === 'response' ? 'Response' : 'Terminate';
        if (innermostLoop) issues.push(nestedInLoopIssue(label, n.name, innermostLoop, path));
      }
      if (n.type === 'action' && n.kind === 'response') {
        if (trigger && !trigger.isRequest) issues.push(triggerIssue(n.name, trigger.label, path));
        const hit = findParallelSibling(n.name, siblings);
        if (hit) issues.push(parallelIssue(n.name, hit, path));
      }
      if (depth > MAX_ACTION_NESTING_DEPTH) issues.push(depthIssue(n.name, depth, path));

      const children = (n as any).actions as Node[] | undefined;
      if (n.type === 'foreach') {
        walk(children || [], [...loops, { kind: 'foreach', name: n.name }], depth + 1);
      } else if (n.type === 'dountil') {
        walk(children || [], [...loops, { kind: 'until', name: n.name }], depth + 1);
      } else if (n.type === 'scope') {
        walk(children || [], loops, depth + 1);
      } else if (n.type === 'if') {
        walk(children || [], loops, depth + 1);
        walk(((n as any).elseActions as Node[]) || [], loops, depth + 1);
      } else if (n.type === 'switch') {
        for (const c of (n as any).cases || []) walk(c.actions || [], loops, depth + 1);
        walk(((n as any).defaultActions as Node[]) || [], loops, depth + 1);
      }
    }
  }
  walk(ir.nodes, [], 1);
  return issues;
}

// ---------------------------------------------------------------------------------------------
// Logic Apps JSON
// ---------------------------------------------------------------------------------------------

function laTriggerLabel(triggers: Record<string, any>): { isRequest: boolean; label: string } | undefined {
  const entries = Object.entries(triggers || {});
  if (entries.length === 0) return undefined;
  const [name, trigger] = entries[0];
  const type = String(trigger?.type ?? '');
  if (REQUEST_TRIGGER_TYPES.has(type.toLowerCase())) return { isRequest: true, label: `a request trigger ("${name}")` };
  const detail = trigger?.inputs?.host?.operationId ? `: ${trigger.inputs.host.operationId}` : '';
  return { isRequest: false, label: `a '${type || 'unknown'}' trigger ("${name}"${detail})` };
}

export function collectLogicAppsPlacementIssues(definition: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const trigger = laTriggerLabel(definition?.triggers);

  function walk(actions: any, path: string, loops: LoopAncestor[], depth: number) {
    if (!actions || typeof actions !== 'object') return;
    const siblings = Object.entries<any>(actions)
      .filter(([, a]) => a && typeof a === 'object')
      .map(([name, a]) => ({ name, runAfter: normaliseRunAfter(a.runAfter) }));

    for (const [name, action] of Object.entries<any>(actions)) {
      if (!action || typeof action !== 'object') continue;
      const actionPath = `${path}.${name}`;
      const type = String(action.type ?? '').toLowerCase();
      const innermostLoop = loops[loops.length - 1];

      if (type === 'response' || type === 'terminate') {
        const label = type === 'response' ? 'Response' : 'Terminate';
        if (innermostLoop) issues.push(nestedInLoopIssue(label, name, innermostLoop, actionPath));
      }
      if (type === 'response') {
        if (trigger && !trigger.isRequest) issues.push(triggerIssue(name, trigger.label, actionPath));
        const hit = findParallelSibling(name, siblings);
        if (hit) issues.push(parallelIssue(name, hit, actionPath));
      }
      if (type === 'initializevariable' && depth > 1) {
        issues.push({
          level: 'error',
          code: 'VAR_INIT_NESTED',
          message: `Variable initialization '${name}' cannot be inside a control structure (if, scope, foreach, switch, until). Move it to the root level.`,
          path: actionPath,
        });
      }
      if (depth > MAX_ACTION_NESTING_DEPTH) issues.push(depthIssue(name, depth, actionPath));

      const childLoops: LoopAncestor[] =
        type === 'foreach' ? [...loops, { kind: 'foreach', name }]
        : type === 'until' ? [...loops, { kind: 'until', name }]
        : loops;
      walk(action.actions, `${actionPath}.actions`, childLoops, depth + 1);
      walk(action.else?.actions, `${actionPath}.else.actions`, childLoops, depth + 1);
      walk(action.default?.actions, `${actionPath}.default.actions`, childLoops, depth + 1);
      if (action.cases && typeof action.cases === 'object') {
        for (const [caseName, c] of Object.entries<any>(action.cases)) {
          walk(c?.actions, `${actionPath}.cases.${caseName}.actions`, childLoops, depth + 1);
        }
      }
    }
  }
  walk(definition?.actions, 'definition.actions', [], 1);
  return issues;
}
