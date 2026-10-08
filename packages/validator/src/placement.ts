import type { FlowIR, Node } from '@flowforger/ir';
import type { ValidationIssue } from './index.js';

/**
 * Placement rules — where an action is allowed to sit in the workflow tree.
 *
 * These mirror checks the Logic Apps / Power Automate workflow service performs when a flow is
 * saved or activated; the cloud rejects the definition with `InvalidWorkflowRunAction` /
 * `InvalidTemplate`, so we surface them locally before push. Sources:
 *   - Response: "anywhere except inside Foreach loops, Until loops"
 *     (learn.microsoft.com/azure/logic-apps/logic-apps-workflow-actions-triggers#response-action).
 *     The docs also ask for an HTTP request trigger, but what the cloud rejects is a trigger with a
 *     `recurrence` ("The workflow with 'Response' action type should not have triggers with
 *     'recurrence' property defined"): the Recurrence trigger and polling connector triggers. A
 *     webhook connector trigger is accepted.
 *     The same page also forbids parallel branches, but the cloud saves and activates a Response in
 *     a parallel branch (conformance/save-rules/placement.mjs), so that is not checked.
 *   - Terminate: "can't appear inside Foreach and Until loops, including sequential loops"
 *     (same page, #terminate-action). Cloud error: "The workflow run action 'X' has type
 *     'Terminate' that could not be nested under an action of type 'foreach'."
 *   - InitializeVariable: must be top level (already covered by VAR_INIT_NESTED in the IR walk;
 *     the Logic Apps JSON walk adds the same code here).
 *   - Nesting depth: "The template actions 'X' are nested at level '9' which exceeds the maximum
 *     nesting limit of '8'", where top-level actions are level 0.
 *   - Response schemas: Response actions with the same status code that both declare a schema
 *     must declare the same one (key order aside): "The schema definition for action with status
 *     code '200' is not valid. The schema definitions for actions with same status code must
 *     match." A Response without a schema, or with another status code, is not compared.
 *
 * Each rule is measured against the cloud in conformance/save-rules/placement.mjs.
 */

/** The deepest nesting level the cloud accepts. Top-level actions are level 0. */
export const MAX_ACTION_NESTING_DEPTH = 8;

type LoopKind = 'foreach' | 'until';

interface LoopAncestor {
  kind: LoopKind;
  name: string;
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

function depthIssue(name: string, level: number, path: string): ValidationIssue {
  return {
    level: 'error',
    code: 'NESTING_DEPTH',
    message:
      `Action '${name}' is nested at level ${level} (top-level actions are level 0, so it sits inside ${level} blocks). ` +
      `Power Automate rejects the flow on save: "The template actions '${name}' are nested at level '${level}' which exceeds the maximum nesting limit of '${MAX_ACTION_NESTING_DEPTH}'". ` +
      `Flatten the control flow or move the inner part into a child flow.`,
    path,
  };
}

function triggerIssue(name: string, triggerLabel: string, path: string): ValidationIssue {
  return {
    level: 'error',
    code: 'RESPONSE_TRIGGER',
    message:
      `Response action '${name}' cannot be used with ${triggerLabel}, which runs on a recurrence. ` +
      `Power Automate rejects the flow on save ("The workflow with 'Response' action type should not have triggers with 'recurrence' property defined"). ` +
      `Remove the Response (there is no caller to respond to) or use a request, manual or webhook trigger.`,
    path,
  };
}

interface ResponseSchema {
  name: string;
  statusCode: unknown;
  schema: unknown;
  path: string;
}

/** Deep equality of two JSON values, ignoring the order of object keys. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => sameJson(v, bb[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in (b as object) && sameJson((a as any)[k], (b as any)[k]));
}

/** RESPONSE_SCHEMA_MISMATCH for each Response whose schema differs from an earlier one with its status code. */
function responseSchemaIssues(responses: ResponseSchema[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const firstByStatus = new Map<string, ResponseSchema>();
  for (const r of responses) {
    // An expression status code is only known at run time.
    if (r.schema === undefined || r.schema === null || typeof r.statusCode === 'string' && r.statusCode.startsWith('@')) continue;
    const status = String(r.statusCode ?? 200);
    const first = firstByStatus.get(status);
    if (!first) {
      firstByStatus.set(status, r);
      continue;
    }
    if (!sameJson(first.schema, r.schema)) {
      issues.push({
        level: 'error',
        code: 'RESPONSE_SCHEMA_MISMATCH',
        message:
          `Response actions '${first.name}' and '${r.name}' both answer status ${status} with different schemas. ` +
          `Power Automate rejects the flow on save: "The schema definition for action with status code '${status}' is not valid. The schema definitions for actions with same status code must match." ` +
          `Give both the same schema (the same outputs with the same types), or answer with different status codes.`,
        path: r.path,
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------
// Flow IR
// ---------------------------------------------------------------------------------------------

/** The trigger, when it has a recurrence (a Response is then rejected). */
function irRecurringTrigger(ir: FlowIR): { label: string } | undefined {
  const trigger = ir.nodes.find((n) => n.type === 'trigger' || n.type === 'recurrence') as any;
  if (!trigger) return undefined;
  if (trigger.type === 'recurrence') return { label: `a recurrence trigger ('${trigger.name}')` };
  const inputs = trigger.inputs || {};
  if (trigger.kind === 'connector' && inputs.recurrence) {
    return { label: `a polling connector trigger ('${trigger.name}': ${`${inputs.connector ?? '?'} ${inputs.operation ?? ''}`.trim()})` };
  }
  return undefined;
}

export function collectIrPlacementIssues(ir: FlowIR): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const recurring = irRecurringTrigger(ir);
  const responses: ResponseSchema[] = [];

  function walk(nodes: Node[], loops: LoopAncestor[], level: number) {
    for (const n of nodes) {
      if (n.type === 'trigger' || n.type === 'recurrence') continue;
      const path = `nodes.${n.name}`;
      const innermostLoop = loops[loops.length - 1];

      if (n.type === 'action' && (n.kind === 'response' || n.kind === 'terminate')) {
        const label = n.kind === 'response' ? 'Response' : 'Terminate';
        if (innermostLoop) issues.push(nestedInLoopIssue(label, n.name, innermostLoop, path));
      }
      if (n.type === 'action' && n.kind === 'response') {
        if (recurring) issues.push(triggerIssue(n.name, recurring.label, path));
        const inputs = (n as any).inputs ?? {};
        responses.push({ name: n.name, statusCode: inputs.statusCode, schema: inputs.schema, path });
      }
      if (level > MAX_ACTION_NESTING_DEPTH) {
        // Like the cloud, name only the outermost action past the limit.
        issues.push(depthIssue(n.name, level, path));
        continue;
      }

      const children = (n as any).actions as Node[] | undefined;
      if (n.type === 'foreach') {
        walk(children || [], [...loops, { kind: 'foreach', name: n.name }], level + 1);
      } else if (n.type === 'dountil') {
        walk(children || [], [...loops, { kind: 'until', name: n.name }], level + 1);
      } else if (n.type === 'scope') {
        walk(children || [], loops, level + 1);
      } else if (n.type === 'if') {
        walk(children || [], loops, level + 1);
        walk(((n as any).elseActions as Node[]) || [], loops, level + 1);
      } else if (n.type === 'switch') {
        for (const c of (n as any).cases || []) walk(c.actions || [], loops, level + 1);
        walk(((n as any).defaultActions as Node[]) || [], loops, level + 1);
      }
    }
  }
  walk(ir.nodes, [], 0);
  issues.push(...responseSchemaIssues(responses));
  return issues;
}

// ---------------------------------------------------------------------------------------------
// Logic Apps JSON
// ---------------------------------------------------------------------------------------------

/** The first trigger, when it has a recurrence (a Response is then rejected). */
function laRecurringTrigger(triggers: Record<string, any>): { label: string } | undefined {
  const entries = Object.entries(triggers || {});
  if (entries.length === 0) return undefined;
  const [name, trigger] = entries[0];
  if (!trigger || typeof trigger !== 'object' || trigger.recurrence === undefined) return undefined;
  const type = String(trigger.type ?? '');
  if (type.toLowerCase() === 'recurrence') return { label: `a recurrence trigger ("${name}")` };
  const detail = trigger.inputs?.host?.operationId ? `: ${trigger.inputs.host.operationId}` : '';
  return { label: `a polling '${type || 'unknown'}' trigger ("${name}"${detail})` };
}

export function collectLogicAppsPlacementIssues(definition: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const recurring = laRecurringTrigger(definition?.triggers);
  const responses: ResponseSchema[] = [];

  function walk(actions: any, path: string, loops: LoopAncestor[], level: number) {
    if (!actions || typeof actions !== 'object') return;

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
        if (recurring) issues.push(triggerIssue(name, recurring.label, actionPath));
        responses.push({ name, statusCode: action.inputs?.statusCode, schema: action.inputs?.schema, path: actionPath });
      }
      if (type === 'initializevariable' && level > 0) {
        issues.push({
          level: 'error',
          code: 'VAR_INIT_NESTED',
          message: `Variable initialization '${name}' cannot be inside a control structure (if, scope, foreach, switch, until). Move it to the root level.`,
          path: actionPath,
        });
      }
      if (level > MAX_ACTION_NESTING_DEPTH) {
        issues.push(depthIssue(name, level, actionPath));
        continue;
      }

      const childLoops: LoopAncestor[] =
        type === 'foreach' ? [...loops, { kind: 'foreach', name }]
        : type === 'until' ? [...loops, { kind: 'until', name }]
        : loops;
      walk(action.actions, `${actionPath}.actions`, childLoops, level + 1);
      walk(action.else?.actions, `${actionPath}.else.actions`, childLoops, level + 1);
      walk(action.default?.actions, `${actionPath}.default.actions`, childLoops, level + 1);
      if (action.cases && typeof action.cases === 'object') {
        for (const [caseName, c] of Object.entries<any>(action.cases)) {
          walk(c?.actions, `${actionPath}.cases.${caseName}.actions`, childLoops, level + 1);
        }
      }
    }
  }
  walk(definition?.actions, 'definition.actions', [], 0);
  issues.push(...responseSchemaIssues(responses));
  return issues;
}
