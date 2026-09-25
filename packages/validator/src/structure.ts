import type { FlowIR, Node } from '@flowforger/ir';
import { tryParseExpression, parseTemplateStrict, type ExprNode } from '@flowforger/expressions';
import type { ValidationIssue } from './index.js';

/**
 * Structural rules — documented save-time checks and definition limits of the Power Automate /
 * Logic Apps workflow service that go beyond schema shape and action placement (placement.ts).
 *
 * Sources:
 *   - Limits: learn.microsoft.com/power-automate/limits-and-config (#definition-limits) and
 *     learn.microsoft.com/azure/logic-apps/logic-apps-limits-and-config (#workflow-limits)
 *   - Schema reference (required attributes, Until limit, Terminate runError, runAfter statuses,
 *     Recurrence ranges): learn.microsoft.com/azure/logic-apps/logic-apps-workflow-actions-triggers
 *   - Design-time error codes (DuplicateActionName, InvalidTemplate for undefined action /
 *     repetition references): learn.microsoft.com/power-automate/error-reference
 *
 * Both formats are normalised into the same record model so every rule exists exactly once.
 */

export const LIMITS = {
  /** Actions per workflow. */
  actionsPerFlow: 500,
  /** Trigger or action name length. */
  nameLength: 80,
  /** Cases per Switch action. */
  switchCases: 25,
  /** Variables per workflow. */
  variablesPerFlow: 250,
  /** Foreach concurrency (runtimeConfiguration.concurrency.repetitions). */
  foreachConcurrency: { min: 1, max: 50 },
  /** Trigger concurrency (runtimeConfiguration.concurrency.runs). */
  triggerConcurrency: { min: 1, max: 100 },
  /** Until loop iteration count. */
  untilCount: { min: 1, max: 5000 },
  /** Retry policy attempts. */
  retryCount: { min: 1, max: 90 },
  /** Retry policy interval in milliseconds: PT5S .. P1D. */
  retryIntervalMs: { min: 5_000, max: 86_400_000 },
  /** Characters in a single expression. */
  expressionLength: 8192,
  /** Parameters per workflow (Consumption). */
  parametersPerFlow: 50,
  /** Recurrence interval maximum per frequency (minimum is always 1). */
  recurrenceIntervalMax: { Month: 16, Day: 500, Hour: 12_000, Minute: 72_000, Second: 9_999_999 } as Record<string, number>,
} as const;

const RUN_AFTER_STATUSES = new Set(['succeeded', 'failed', 'skipped', 'timedout']);
const RETRY_TYPES = new Set(['none', 'fixed', 'exponential']);
const RECURRENCE_FREQUENCIES = new Set(['second', 'minute', 'hour', 'day', 'week', 'month', 'year']);
const TERMINATE_STATUSES = new Set(['succeeded', 'cancelled', 'failed']);
const VARIABLE_TYPES = new Set(['string', 'integer', 'float', 'boolean', 'array', 'object']);
/** Parameters the Power Automate runtime always provides. */
const IMPLICIT_PARAMETERS = new Set(['$connections', '$authentication']);
/** Expression functions whose first argument names an action. */
const ACTION_REF_FUNCTIONS = new Set(['outputs', 'body', 'actions', 'actionoutputs', 'actionbody', 'result']);
/** Expression functions whose first argument names an enclosing loop. */
const LOOP_REF_FUNCTIONS = new Set(['items', 'iterationindexes']);

// ---------------------------------------------------------------------------------------------
// Normalised model
// ---------------------------------------------------------------------------------------------

type RecKind =
  | 'response' | 'terminate' | 'foreach' | 'until' | 'switch' | 'if' | 'scope'
  | 'initializevariable' | 'setvariable' | 'incrementvariable' | 'decrementvariable'
  | 'appendtoarrayvariable' | 'appendtostringvariable' | 'connector' | 'other';

interface Rec {
  name: string;
  path: string;
  kind: RecKind;
  /** Explicit runAfter as authored (undefined = "not specified"). */
  runAfter?: unknown;
  /** Names of enclosing foreach/until loops, outermost first. */
  loopAncestors: Array<{ name: string; kind: 'foreach' | 'until' }>;
  /** Values that may contain expressions (inputs, conditions, ...). */
  scanValue: unknown;
  retryPolicy?: unknown;
  foreachConcurrency?: unknown;
  caseCount?: number;
  until?: { actionCount: number; hasLimit: boolean; count?: unknown; timeout?: unknown };
  terminate?: { runStatus?: unknown; hasRunError: boolean };
  responseKind?: string;
  /** Variables this InitializeVariable defines (name + type). */
  defines?: Array<{ name: string; type?: unknown }>;
  /** Variable a Set/Increment/Decrement/Append action targets. */
  targets?: string;
  /** OpenApiConnection connectionName (Logic Apps JSON only). */
  connectionName?: string;
  /** Select / Filter array / Table: item() refers to the current element of `from`, no loop needed. */
  allowsItem?: boolean;
}

interface Group {
  path: string;
  recs: Rec[];
}

interface TriggerInfo {
  name: string;
  path: string;
  /** Lower-cased Logic Apps kind (http, button, powerappv2, virtualagent, ...) when known. */
  kind?: string;
  recurrence?: any;
  concurrencyRuns?: unknown;
  retryPolicy?: unknown;
  scanValue: unknown;
  connectionName?: string;
}

interface Model {
  recs: Rec[];
  groups: Group[];
  trigger?: TriggerInfo;
  triggerCount: number;
  /** Defined parameter names (undefined = the definition carries no parameters section). */
  parameters?: Set<string>;
  parameterCount: number;
  /** Connection reference names (undefined = the document carries none). */
  connectionReferences?: Set<string>;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const lower = (s: string) => s.toLowerCase();

/** Parse an ISO 8601 duration (P[nW][nD][T[nH][nM][nS]]) to milliseconds; undefined if malformed. */
export function parseIsoDurationMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = value.match(/^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!m || value.length < 3) return undefined;
  const [, w, d, h, min, s] = m;
  if (!w && !d && !h && !min && !s) return undefined;
  return (
    (Number(w || 0) * 7 + Number(d || 0)) * 86_400_000 +
    Number(h || 0) * 3_600_000 +
    Number(min || 0) * 60_000 +
    Number(s || 0) * 1000
  );
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function* walkCallNodes(node: ExprNode): Generator<Extract<ExprNode, { kind: 'call' }>> {
  if (node.kind !== 'call') return;
  yield node;
  for (const a of node.args) yield* walkCallNodes(a);
  for (const seg of node.path) {
    if (seg.kind === 'index') yield* walkCallNodes(seg.expr);
  }
}

/** Every parsed expression in a value tree, with the path of the string it came from. */
function* expressionsIn(value: unknown, path: string): Generator<{ node: ExprNode; path: string; raw: string }> {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('@') && !trimmed.startsWith('@{') && !trimmed.startsWith('@@')) {
      const node = tryParseExpression(trimmed);
      if (node) yield { node, path, raw: trimmed };
    } else if (value.includes('@{')) {
      const parts = parseTemplateStrict(value);
      if (parts) for (const p of parts) if (p.kind === 'expr') yield { node: p.node, path, raw: p.raw };
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* expressionsIn(value[i], `${path}[${i}]`);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* expressionsIn(v, `${path}.${k}`);
  }
}

function stringArg(call: Extract<ExprNode, { kind: 'call' }>, i = 0): string | undefined {
  const a = call.args[i];
  return a && a.kind === 'str' ? a.value : undefined;
}

// ---------------------------------------------------------------------------------------------
// Rules (format-independent)
// ---------------------------------------------------------------------------------------------

function runRules(m: Model): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (code: string, message: string, path?: string) => issues.push({ level: 'error', code, message, path });
  const warn = (code: string, message: string, path?: string) => issues.push({ level: 'warning', code, message, path });

  // --- names -----------------------------------------------------------------------------------
  const byLowerName = new Map<string, Rec[]>();
  for (const r of m.recs) {
    const key = lower(r.name);
    byLowerName.set(key, [...(byLowerName.get(key) || []), r]);
  }
  for (const [, recs] of byLowerName) {
    if (recs.length > 1) {
      err('ACTION_NAME_DUPLICATE',
        `Action name '${recs[0].name}' is used ${recs.length} times (${recs.map((r) => r.path).join(', ')}). ` +
        `Action names must be unique across the whole flow, including inside scopes, loops and switch cases, and the comparison is case-insensitive (DuplicateActionName).`,
        recs[1].path);
    }
  }
  const nameTargets: Array<{ name: string; path: string; what: string }> = m.recs.map((r) => ({ name: r.name, path: r.path, what: 'Action' }));
  if (m.trigger) nameTargets.push({ name: m.trigger.name, path: m.trigger.path, what: 'Trigger' });
  for (const t of nameTargets) {
    if (t.name.length > LIMITS.nameLength) {
      err('ACTION_NAME_LENGTH', `${t.what} name '${t.name.slice(0, 40)}…' is ${t.name.length} characters; the limit is ${LIMITS.nameLength}.`, t.path);
    }
  }

  // --- counts ----------------------------------------------------------------------------------
  if (m.recs.length > LIMITS.actionsPerFlow) {
    err('ACTION_COUNT', `Flow has ${m.recs.length} actions; the limit is ${LIMITS.actionsPerFlow} per flow. Split the work into child flows.`);
  }
  if (m.triggerCount > 1) {
    err('TRIGGER_COUNT', `Definition has ${m.triggerCount} triggers; Power Automate flows must have exactly one.`, 'definition.triggers');
  }
  const definedVars = new Map<string, Rec>();
  let variableCount = 0;
  for (const r of m.recs) {
    for (const v of r.defines || []) {
      variableCount++;
      if (!definedVars.has(lower(v.name))) definedVars.set(lower(v.name), r);
      if (v.type !== undefined && !(typeof v.type === 'string' && VARIABLE_TYPES.has(lower(v.type)))) {
        err('VARIABLE_TYPE', `Variable '${v.name}' has type '${String(v.type)}'; allowed types are String, Integer, Float, Boolean, Array and Object.`, r.path);
      }
    }
  }
  if (variableCount > LIMITS.variablesPerFlow) {
    err('VARIABLE_COUNT', `Flow initializes ${variableCount} variables; the limit is ${LIMITS.variablesPerFlow} per flow.`);
  }
  if (m.parameterCount > LIMITS.parametersPerFlow) {
    warn('PARAMETER_COUNT', `Definition has ${m.parameterCount} parameters; the documented limit is ${LIMITS.parametersPerFlow} per flow.`);
  }

  // --- per action ------------------------------------------------------------------------------
  for (const r of m.recs) {
    if (r.kind === 'switch' && (r.caseCount ?? 0) > LIMITS.switchCases) {
      err('SWITCH_CASES', `Switch '${r.name}' has ${r.caseCount} cases; the limit is ${LIMITS.switchCases}.`, r.path);
    }
    if (r.kind === 'foreach' && r.foreachConcurrency !== undefined) {
      const n = r.foreachConcurrency;
      if (!isInt(n) || n < LIMITS.foreachConcurrency.min || n > LIMITS.foreachConcurrency.max) {
        err('FOREACH_CONCURRENCY', `Foreach '${r.name}' sets concurrency repetitions to ${JSON.stringify(n)}; allowed range is ${LIMITS.foreachConcurrency.min}-${LIMITS.foreachConcurrency.max}.`, r.path);
      }
    }
    if (r.kind === 'until' && r.until) {
      if (r.until.actionCount === 0) {
        err('UNTIL_EMPTY', `Until loop '${r.name}' has no actions; an Until loop must contain at least one action.`, r.path);
      }
      if (!r.until.hasLimit) {
        err('UNTIL_LIMIT', `Until loop '${r.name}' has no limit; define limit.count and/or limit.timeout.`, r.path);
      }
      if (r.until.count !== undefined && (!isInt(r.until.count) || r.until.count < LIMITS.untilCount.min || r.until.count > LIMITS.untilCount.max)) {
        err('UNTIL_COUNT', `Until loop '${r.name}' has limit.count ${JSON.stringify(r.until.count)}; allowed range is ${LIMITS.untilCount.min}-${LIMITS.untilCount.max}.`, r.path);
      }
      if (r.until.timeout !== undefined && parseIsoDurationMs(r.until.timeout) === undefined) {
        warn('UNTIL_TIMEOUT', `Until loop '${r.name}' has limit.timeout ${JSON.stringify(r.until.timeout)}, which is not an ISO 8601 duration (e.g. 'PT1H', 'P1D').`, r.path);
      }
    }
    if (r.kind === 'terminate' && r.terminate) {
      const status = r.terminate.runStatus;
      if (typeof status !== 'string' || !TERMINATE_STATUSES.has(lower(status))) {
        err('TERMINATE_STATUS', `Terminate '${r.name}' has runStatus ${JSON.stringify(status)}; allowed values are Succeeded, Cancelled and Failed.`, r.path);
      } else if (r.terminate.hasRunError && lower(status) !== 'failed') {
        err('TERMINATE_RUNERROR', `Terminate '${r.name}' sets runError with runStatus '${status}'; runError is only allowed with runStatus 'Failed'.`, r.path);
      }
    }
    if (r.kind === 'response' && r.responseKind && m.trigger) {
      const rk = lower(r.responseKind);
      const tk = m.trigger.kind;
      if (rk === 'powerapp' && tk !== undefined && !['button', 'powerapp', 'powerappv2'].includes(tk)) {
        warn('RESPONSE_KIND', `Response '${r.name}' is a PowerApp response ("Respond to a Power App or flow") but the trigger kind is '${tk}'; it pairs with a manual (Button), PowerApp or PowerAppV2 trigger.`, r.path);
      }
      if (rk === 'virtualagent' && tk !== undefined && !['virtualagent', 'skills'].includes(tk)) {
        warn('RESPONSE_KIND', `Response '${r.name}' is a VirtualAgent (Copilot) response but the trigger kind is '${tk}'; it pairs with a VirtualAgent trigger.`, r.path);
      }
    }
    if (r.targets !== undefined && !definedVars.has(lower(r.targets))) {
      warn('VARIABLE_UNINITIALIZED', `Action '${r.name}' modifies variable '${r.targets}', but no InitializeVariable action defines it.`, r.path);
    }
    if (r.retryPolicy !== undefined) issues.push(...retryPolicyIssues(r.retryPolicy, r.name, r.path));
    if (r.connectionName !== undefined && m.connectionReferences && !m.connectionReferences.has(r.connectionName)) {
      err('CONNECTION_REF_MISSING', `Action '${r.name}' uses connection reference '${r.connectionName}', which is not defined in connectionReferences (${[...m.connectionReferences].join(', ') || 'none'}).`, r.path);
    }
  }

  // --- trigger ---------------------------------------------------------------------------------
  if (m.trigger) {
    const t = m.trigger;
    if (t.concurrencyRuns !== undefined) {
      const n = t.concurrencyRuns;
      if (!isInt(n) || n < LIMITS.triggerConcurrency.min || n > LIMITS.triggerConcurrency.max) {
        err('TRIGGER_CONCURRENCY', `Trigger '${t.name}' sets concurrency runs to ${JSON.stringify(n)}; allowed range is ${LIMITS.triggerConcurrency.min}-${LIMITS.triggerConcurrency.max}.`, t.path);
      }
    }
    if (t.retryPolicy !== undefined) issues.push(...retryPolicyIssues(t.retryPolicy, t.name, t.path));
    if (t.recurrence !== undefined) issues.push(...recurrenceIssues(t.recurrence, t.name, t.path));
    if (t.connectionName !== undefined && m.connectionReferences && !m.connectionReferences.has(t.connectionName)) {
      err('CONNECTION_REF_MISSING', `Trigger '${t.name}' uses connection reference '${t.connectionName}', which is not defined in connectionReferences.`, t.path);
    }
  }

  // --- runAfter (per sibling group) -----------------------------------------------------------
  for (const g of m.groups) {
    const siblings = new Map(g.recs.map((r) => [lower(r.name), r]));
    const edges = new Map<string, string[]>(); // name → predecessors (lower)
    for (const r of g.recs) {
      if (r.runAfter === undefined) continue;
      if (!r.runAfter || typeof r.runAfter !== 'object' || Array.isArray(r.runAfter)) {
        err('RUNAFTER_SHAPE', `Action '${r.name}' has a runAfter that is not an object.`, r.path);
        continue;
      }
      const preds: string[] = [];
      for (const [target, statuses] of Object.entries(r.runAfter as Record<string, unknown>)) {
        if (lower(target) === lower(r.name)) {
          err('RUNAFTER_SELF', `Action '${r.name}' runs after itself.`, r.path);
        } else if (!siblings.has(lower(target))) {
          const elsewhere = byLowerName.get(lower(target));
          err('RUNAFTER_UNKNOWN',
            `Action '${r.name}' runs after '${target}', which is not an action in the same scope` +
            (elsewhere ? ` (it exists at ${elsewhere[0].path}, but runAfter can only reference siblings)` : ' (no such action)') + '.',
            r.path);
        } else {
          preds.push(lower(target));
        }
        const list = Array.isArray(statuses) ? statuses : [statuses];
        for (const s of list) {
          if (typeof s !== 'string' || !RUN_AFTER_STATUSES.has(lower(s))) {
            err('RUNAFTER_STATUS', `Action '${r.name}' runs after '${target}' with status ${JSON.stringify(s)}; allowed statuses are Succeeded, Failed, Skipped and TimedOut.`, r.path);
          }
        }
      }
      edges.set(lower(r.name), preds);
    }
    // cycle detection over explicit edges
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (n: string, stack: string[]): string[] | undefined => {
      if (state.get(n) === 'done') return undefined;
      if (state.get(n) === 'visiting') return [...stack.slice(stack.indexOf(n)), n];
      state.set(n, 'visiting');
      for (const p of edges.get(n) || []) {
        const cyc = visit(p, [...stack, n]);
        if (cyc) return cyc;
      }
      state.set(n, 'done');
      return undefined;
    };
    for (const n of edges.keys()) {
      const cyc = visit(n, []);
      if (cyc) {
        const names = cyc.map((x) => siblings.get(x)?.name ?? x);
        err('RUNAFTER_CYCLE', `runAfter dependencies form a cycle: ${names.join(' → ')}.`, siblings.get(cyc[0])?.path ?? g.path);
        break;
      }
    }
  }

  // --- expression references -------------------------------------------------------------------
  const actionNames = new Set(byLowerName.keys());
  const scanTargets: Array<{ name: string; path: string; scanValue: unknown; loops: Rec['loopAncestors']; allowsItem: boolean }> =
    m.recs.map((r) => ({ name: r.name, path: r.path, scanValue: r.scanValue, loops: r.loopAncestors, allowsItem: !!r.allowsItem }));
  if (m.trigger) scanTargets.push({ name: m.trigger.name, path: m.trigger.path, scanValue: m.trigger.scanValue, loops: [], allowsItem: false });

  for (const t of scanTargets) {
    const reported = new Set<string>();
    const once = (key: string, fn: () => void) => { if (!reported.has(key)) { reported.add(key); fn(); } };
    for (const { node, path, raw } of expressionsIn(t.scanValue, t.path)) {
      if (raw.length > LIMITS.expressionLength) {
        once(`len:${path}`, () => warn('EXPR_LENGTH', `Expression in '${t.name}' is ${raw.length} characters; the limit is ${LIMITS.expressionLength} per expression.`, path));
      }
      for (const call of walkCallNodes(node)) {
        const fn = lower(call.name);
        if (ACTION_REF_FUNCTIONS.has(fn)) {
          const target = stringArg(call);
          if (target !== undefined && !actionNames.has(lower(target))) {
            once(`act:${target}`, () => err('EXPR_UNKNOWN_ACTION', `'${t.name}' references ${call.name}('${target}'), but no action named '${target}' exists. Power Automate rejects the flow on save (InvalidTemplate).`, path));
          }
        } else if (LOOP_REF_FUNCTIONS.has(fn)) {
          const target = stringArg(call);
          if (target !== undefined && !t.loops.some((l) => lower(l.name) === lower(target))) {
            const exists = actionNames.has(lower(target));
            once(`loop:${target}`, () => err('EXPR_LOOP_REFERENCE',
              `'${t.name}' references ${call.name}('${target}'), but it is not inside a loop named '${target}'` +
              (exists ? ` ('${target}' exists but does not enclose this action)` : ` (no such loop)`) +
              `. Power Automate rejects the flow on save ("repetition actions referenced by inputs are not defined").`, path));
          }
        } else if (fn === 'item' && call.args.length === 0) {
          if (!t.allowsItem && !t.loops.some((l) => l.kind === 'foreach')) {
            once('item', () => err('EXPR_LOOP_REFERENCE', `'${t.name}' uses item(), but it is not inside a foreach loop.`, path));
          }
        } else if (fn === 'parameters' && m.parameters) {
          const target = stringArg(call);
          if (target !== undefined && !m.parameters.has(target) && !IMPLICIT_PARAMETERS.has(target)) {
            once(`param:${target}`, () => err('EXPR_UNKNOWN_PARAMETER', `'${t.name}' references parameters('${target}'), but no parameter named '${target}' is defined.`, path));
          }
        } else if (fn === 'variables') {
          const target = stringArg(call);
          if (target !== undefined && !definedVars.has(lower(target))) {
            once(`var:${target}`, () => warn('VARIABLE_UNDEFINED', `'${t.name}' references variables('${target}'), but no InitializeVariable action defines it.`, path));
          }
        }
      }
    }
  }

  return issues;
}

function retryPolicyIssues(policy: unknown, name: string, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!policy || typeof policy !== 'object') {
    issues.push({ level: 'error', code: 'RETRY_POLICY', message: `'${name}' has a retryPolicy that is not an object.`, path });
    return issues;
  }
  const p = policy as Record<string, unknown>;
  const type = typeof p.type === 'string' ? lower(p.type) : undefined;
  if (type === undefined || !RETRY_TYPES.has(type)) {
    issues.push({ level: 'error', code: 'RETRY_POLICY', message: `'${name}' has retryPolicy.type ${JSON.stringify(p.type)}; allowed values are none, fixed and exponential.`, path });
  }
  if (type === 'none') return issues;
  if (p.count !== undefined && (!isInt(p.count) || p.count < LIMITS.retryCount.min || p.count > LIMITS.retryCount.max)) {
    issues.push({ level: 'error', code: 'RETRY_POLICY', message: `'${name}' has retryPolicy.count ${JSON.stringify(p.count)}; allowed range is ${LIMITS.retryCount.min}-${LIMITS.retryCount.max}.`, path });
  }
  for (const key of ['interval', 'minimumInterval', 'maximumInterval'] as const) {
    if (p[key] === undefined) continue;
    const ms = parseIsoDurationMs(p[key]);
    if (ms === undefined) {
      issues.push({ level: 'error', code: 'RETRY_POLICY', message: `'${name}' has retryPolicy.${key} ${JSON.stringify(p[key])}, which is not an ISO 8601 duration (e.g. 'PT20S').`, path });
    } else if (ms < LIMITS.retryIntervalMs.min || ms > LIMITS.retryIntervalMs.max) {
      issues.push({ level: 'error', code: 'RETRY_POLICY', message: `'${name}' has retryPolicy.${key} '${p[key]}'; allowed range is PT5S to P1D.`, path });
    }
  }
  return issues;
}

function recurrenceIssues(rec: unknown, name: string, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!rec || typeof rec !== 'object') {
    issues.push({ level: 'error', code: 'RECURRENCE', message: `Trigger '${name}' has a recurrence that is not an object.`, path });
    return issues;
  }
  const r = rec as Record<string, any>;
  const freq = typeof r.frequency === 'string' ? r.frequency : undefined;
  if (freq === undefined || !RECURRENCE_FREQUENCIES.has(lower(freq))) {
    issues.push({ level: 'error', code: 'RECURRENCE', message: `Trigger '${name}' has recurrence.frequency ${JSON.stringify(r.frequency)}; allowed values are Second, Minute, Hour, Day, Week, Month and Year.`, path });
  }
  if (r.interval !== undefined || freq !== undefined) {
    const max = freq ? LIMITS.recurrenceIntervalMax[freq.charAt(0).toUpperCase() + lower(freq).slice(1)] : undefined;
    if (!isInt(r.interval) || r.interval < 1 || (max !== undefined && r.interval > max)) {
      issues.push({ level: 'error', code: 'RECURRENCE', message: `Trigger '${name}' has recurrence.interval ${JSON.stringify(r.interval)}; it must be an integer from 1 to ${max ?? '…'} for frequency '${freq ?? '?'}'.`, path });
    }
  }
  const schedule = r.schedule;
  if (schedule && typeof schedule === 'object' && freq) {
    const f = lower(freq);
    if ((schedule.hours !== undefined || schedule.minutes !== undefined) && f !== 'day' && f !== 'week') {
      issues.push({ level: 'warning', code: 'RECURRENCE_SCHEDULE', message: `Trigger '${name}' sets schedule.hours/minutes with frequency '${freq}'; these are only honoured for Day and Week.`, path });
    }
    if (schedule.weekDays !== undefined && f !== 'week') {
      issues.push({ level: 'warning', code: 'RECURRENCE_SCHEDULE', message: `Trigger '${name}' sets schedule.weekDays with frequency '${freq}'; weekDays is only honoured for Week.`, path });
    }
    if (schedule.monthDays !== undefined && f !== 'month') {
      issues.push({ level: 'warning', code: 'RECURRENCE_SCHEDULE', message: `Trigger '${name}' sets schedule.monthDays with frequency '${freq}'; monthDays is only honoured for Month.`, path });
    }
  }
  if (r.startTime !== undefined && (typeof r.startTime !== 'string' || Number.isNaN(Date.parse(r.startTime)))) {
    issues.push({ level: 'error', code: 'RECURRENCE', message: `Trigger '${name}' has recurrence.startTime ${JSON.stringify(r.startTime)}, which is not a parseable date-time (e.g. '2026-01-01T08:00:00Z').`, path });
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------
// Flow IR → model
// ---------------------------------------------------------------------------------------------

const VAR_TARGET_KINDS = new Set(['setvariable', 'incrementvariable', 'decrementvariable', 'appendtoarrayvariable', 'appendtostringvariable']);

function irModel(ir: FlowIR): Model {
  const recs: Rec[] = [];
  const groups: Group[] = [];
  let trigger: TriggerInfo | undefined;
  let triggerCount = 0;

  function walk(nodes: Node[], path: string, loops: Rec['loopAncestors']) {
    const group: Group = { path, recs: [] };
    for (const n of nodes) {
      const anyN = n as any;
      if (n.type === 'trigger' || n.type === 'recurrence') {
        triggerCount++;
        if (!trigger) {
          const inputs = anyN.inputs || {};
          let kind: string | undefined;
          if (n.type === 'trigger') {
            if (anyN.kind === 'http') kind = lower(inputs.triggerKind || 'Http');
            else if (anyN.kind === 'manual') kind = lower(inputs.triggerKind || 'Button');
          }
          trigger = {
            name: n.name,
            path: `nodes.${n.name}`,
            kind,
            recurrence: n.type === 'recurrence' ? inputs : undefined,
            concurrencyRuns: anyN.runtimeConfiguration?.concurrency?.runs,
            retryPolicy: inputs.retryPolicy,
            scanValue: n.type === 'trigger' && anyN.kind === 'connector' ? inputs.params : undefined,
          };
        }
        continue;
      }
      const nodePath = `nodes.${n.name}`;
      const rec: Rec = {
        name: n.name,
        path: nodePath,
        kind: 'other',
        runAfter: anyN.runAfter,
        loopAncestors: loops,
        scanValue: undefined,
        retryPolicy: anyN.retryPolicy,
      };
      if (n.type === 'action') {
        const k = anyN.kind as string;
        rec.scanValue = anyN.inputs;
        if (k === 'select' || k === 'filterarray' || k === 'createcsvtable' || k === 'createhtmltable') rec.allowsItem = true;
        if (k === 'response') { rec.kind = 'response'; rec.responseKind = anyN.inputs?.kind; }
        else if (k === 'terminate') { rec.kind = 'terminate'; rec.terminate = { runStatus: anyN.inputs?.runStatus, hasRunError: anyN.inputs?.runError !== undefined }; }
        else if (k === 'initializevariable') {
          rec.kind = 'initializevariable';
          const vn = anyN.inputs?.variableName;
          rec.defines = typeof vn === 'string' ? [{ name: vn, type: anyN.inputs?.variableType }] : [];
        } else if (VAR_TARGET_KINDS.has(k)) {
          rec.kind = k as RecKind;
          const target = anyN.inputs?.name ?? anyN.inputs?.variableName;
          if (typeof target === 'string') rec.targets = target;
        }
      } else if (n.type === 'connector' || n.type === 'connectorwebhook') {
        rec.kind = 'connector';
        rec.scanValue = anyN.params;
      } else if (n.type === 'foreach') {
        rec.kind = 'foreach';
        rec.scanValue = { itemsExpression: anyN.itemsExpression };
        rec.foreachConcurrency = anyN.runtimeConfiguration?.concurrency?.repetitions;
      } else if (n.type === 'dountil') {
        rec.kind = 'until';
        rec.scanValue = { condition: anyN.condition };
        // The emitter defaults count (60) and timeout (PT1H), so only explicit values are checked.
        rec.until = { actionCount: (anyN.actions || []).length, hasLimit: true, count: anyN.limit, timeout: anyN.timeout };
      } else if (n.type === 'if') {
        rec.kind = 'if';
        rec.scanValue = { condition: anyN.condition };
      } else if (n.type === 'switch') {
        rec.kind = 'switch';
        rec.scanValue = { expression: anyN.expression };
        rec.caseCount = (anyN.cases || []).length;
      } else if (n.type === 'scope') {
        rec.kind = 'scope';
      }
      recs.push(rec);
      group.recs.push(rec);

      const childLoops: Rec['loopAncestors'] =
        n.type === 'foreach' ? [...loops, { name: n.name, kind: 'foreach' }]
        : n.type === 'dountil' ? [...loops, { name: n.name, kind: 'until' }]
        : loops;
      if (n.type === 'foreach' || n.type === 'dountil' || n.type === 'scope') {
        walk(anyN.actions || [], `${nodePath}.actions`, childLoops);
      } else if (n.type === 'if') {
        walk(anyN.actions || [], `${nodePath}.actions`, childLoops);
        walk(anyN.elseActions || [], `${nodePath}.elseActions`, childLoops);
      } else if (n.type === 'switch') {
        (anyN.cases || []).forEach((c: any, i: number) => walk(c.actions || [], `${nodePath}.cases[${i}].actions`, childLoops));
        walk(anyN.defaultActions || [], `${nodePath}.defaultActions`, childLoops);
      }
    }
    groups.push(group);
  }
  walk(ir.nodes, 'nodes', []);

  const paramNames = ir.parameters ? Object.keys(ir.parameters) : undefined;
  return {
    recs,
    groups,
    trigger,
    triggerCount,
    parameters: paramNames ? new Set(paramNames) : undefined,
    parameterCount: paramNames?.length ?? 0,
    connectionReferences: undefined,
  };
}

export function collectIrStructureIssues(ir: FlowIR): ValidationIssue[] {
  return runRules(irModel(ir));
}

// ---------------------------------------------------------------------------------------------
// Logic Apps JSON → model
// ---------------------------------------------------------------------------------------------

const LA_CONTAINER_KEYS = new Set(['actions', 'else', 'cases', 'default', 'description', 'metadata', 'runAfter', 'type', 'kind', 'trackedProperties', 'operationOptions', 'runtimeConfiguration']);

function laScanValue(action: any): unknown {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(action)) if (!LA_CONTAINER_KEYS.has(k)) out[k] = v;
  return out;
}

function laKind(type: string): RecKind {
  switch (type) {
    case 'response': case 'terminate': case 'foreach': case 'until': case 'switch': case 'if': case 'scope':
    case 'initializevariable': case 'setvariable': case 'incrementvariable': case 'decrementvariable':
    case 'appendtoarrayvariable': case 'appendtostringvariable':
      return type;
    case 'openapiconnection': case 'openapiconnectionwebhook': case 'openapiconnectionnotification': case 'apiconnection': case 'apiconnectionwebhook':
      return 'connector';
    default:
      return 'other';
  }
}

function laModel(def: any, definition: any): Model {
  const recs: Rec[] = [];
  const groups: Group[] = [];

  function walk(actions: any, path: string, loops: Rec['loopAncestors']) {
    if (!actions || typeof actions !== 'object') return;
    const group: Group = { path, recs: [] };
    for (const [name, action] of Object.entries<any>(actions)) {
      if (!action || typeof action !== 'object') continue;
      const actionPath = `${path}.${name}`;
      const type = lower(String(action.type ?? ''));
      const rec: Rec = {
        name,
        path: actionPath,
        kind: laKind(type),
        runAfter: action.runAfter,
        loopAncestors: loops,
        scanValue: laScanValue(action),
        retryPolicy: action.inputs?.retryPolicy,
      };
      if (type === 'select' || type === 'query' || type === 'table') rec.allowsItem = true;
      if (type === 'response') rec.responseKind = typeof action.kind === 'string' ? action.kind : undefined;
      if (type === 'terminate') rec.terminate = { runStatus: action.inputs?.runStatus, hasRunError: action.inputs?.runError !== undefined };
      if (type === 'initializevariable') {
        const vars = Array.isArray(action.inputs?.variables) ? action.inputs.variables : [];
        rec.defines = vars.filter((v: any) => v && typeof v.name === 'string').map((v: any) => ({ name: v.name, type: v.type }));
      }
      if (VAR_TARGET_KINDS.has(type) && typeof action.inputs?.name === 'string') rec.targets = action.inputs.name;
      if (type === 'foreach') rec.foreachConcurrency = action.runtimeConfiguration?.concurrency?.repetitions;
      if (type === 'switch') rec.caseCount = action.cases && typeof action.cases === 'object' ? Object.keys(action.cases).length : 0;
      if (type === 'until') {
        const limit = action.limit && typeof action.limit === 'object' ? action.limit : undefined;
        rec.until = {
          actionCount: action.actions && typeof action.actions === 'object' ? Object.keys(action.actions).length : 0,
          hasLimit: !!limit && (limit.count !== undefined || limit.timeout !== undefined),
          count: limit?.count,
          timeout: limit?.timeout,
        };
      }
      if (rec.kind === 'connector' && typeof action.inputs?.host?.connectionName === 'string') rec.connectionName = action.inputs.host.connectionName;
      recs.push(rec);
      group.recs.push(rec);

      const childLoops: Rec['loopAncestors'] =
        type === 'foreach' ? [...loops, { name, kind: 'foreach' }]
        : type === 'until' ? [...loops, { name, kind: 'until' }]
        : loops;
      walk(action.actions, `${actionPath}.actions`, childLoops);
      walk(action.else?.actions, `${actionPath}.else.actions`, childLoops);
      walk(action.default?.actions, `${actionPath}.default.actions`, childLoops);
      if (action.cases && typeof action.cases === 'object') {
        for (const [caseName, c] of Object.entries<any>(action.cases)) walk(c?.actions, `${actionPath}.cases.${caseName}.actions`, childLoops);
      }
    }
    groups.push(group);
  }
  walk(definition?.actions, 'definition.actions', []);

  const triggerEntries = Object.entries<any>(definition?.triggers || {}).filter(([, t]) => t && typeof t === 'object');
  let trigger: TriggerInfo | undefined;
  if (triggerEntries.length > 0) {
    const [name, t] = triggerEntries[0];
    const type = lower(String(t.type ?? ''));
    trigger = {
      name,
      path: `definition.triggers.${name}`,
      kind: type === 'request' || type === 'manual' ? lower(String(t.kind ?? 'Http')) : undefined,
      recurrence: type === 'recurrence' ? t.recurrence : undefined,
      concurrencyRuns: t.runtimeConfiguration?.concurrency?.runs,
      retryPolicy: t.inputs?.retryPolicy,
      scanValue: laScanValue(t),
      connectionName: typeof t.inputs?.host?.connectionName === 'string' ? t.inputs.host.connectionName : undefined,
    };
  }

  const params = definition?.parameters && typeof definition.parameters === 'object' ? Object.keys(definition.parameters) : undefined;
  const connRefs = def?.properties?.connectionReferences ?? def?.connectionReferences;
  return {
    recs,
    groups,
    trigger,
    triggerCount: triggerEntries.length,
    parameters: params ? new Set(params) : undefined,
    parameterCount: params?.length ?? 0,
    connectionReferences: connRefs && typeof connRefs === 'object' ? new Set(Object.keys(connRefs)) : undefined,
  };
}

/** `def` is the whole document (for connectionReferences); `definition` the workflow definition inside it. */
export function collectLogicAppsStructureIssues(def: any, definition: any): ValidationIssue[] {
  return runRules(laModel(def, definition));
}
