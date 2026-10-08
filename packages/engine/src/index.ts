import type { FlowIR, TriggerNode, RecurrenceTriggerNode, ActionNode, StepResult, Node } from '@flowforger/ir';
import { evalExpression, evaluateParams, navigatePath } from './expressions.js';
import { executeHttpAction, policyRecord } from './http-action.js';
import { childFlowCallResult, type FlowResponse } from './child-flow.js';
import { runWithConcurrency, type StopSignal } from './concurrency.js';
import {
  type ActionRecordLike,
  type Outcome,
  BLOCK_FAILED,
  conditionInvalid,
  SKIPPED_BY_TERMINATE,
  describeOutcome,
  httpStatusName,
  nodeKind,
  skippedByBranch,
  skippedByParent,
  skippedByRunAfter,
  switchCaseTypeMismatch,
  switchValueInvalid,
} from './action-status.js';
import { toTriggerOutputs, triggerRunInfo, type TriggerRunInfo } from './trigger-outputs.js';
import { ExpressionError, typeName } from './expr/values.js';
import { createTable, TableInputError } from './table.js';
import { parseJsonAction } from './parse-json.js';

export interface ActionOutput extends ActionRecordLike {
  status: StepResult['status'];
  /**
   * Post-expression-evaluation payload the action was invoked with. Recorded
   * only for the kinds where it isn't already visible in `outputs`: connector
   * actions, HTTP actions, and child-flow calls. Undefined elsewhere.
   */
  inputs?: any;
  outputs?: any;
  error?: any;
}

export interface IterationFrame {
  loopName: string;
  index: number;
  item?: any;
}

export interface CurrentActionInfo {
  name: string;
  inputs?: any;
  outputs?: any;
  status?: StepResult['status'];
  startTime?: string;
  endTime?: string;
}

/** One child action's record, as `result(scopedActionName)` lists it. */
export interface ScopedActionResult extends ActionOutput {
  name: string;
}

export interface RunContext {
  variables: Record<string, any>;
  /** Set by the first Response action that runs: what the caller gets back. */
  response?: FlowResponse;
  /** The flow's childFlows: a Workflow action naming a child records its workflowId, as the cloud does. */
  childFlows?: FlowIR['childFlows'];
  actions: Map<string, ActionOutput>; // Track all action outputs
  /** The trigger's outputs, `{ headers, body }` (see toTriggerOutputs). */
  triggerData?: any;
  /** The trigger itself, for trigger(). */
  trigger?: TriggerRunInfo;
  workflowName?: string; // Workflow name
  parameters?: Record<string, any>; // Workflow parameters
  /**
   * Top of `iterationStack`. Set during foreach/until iterations — identifies
   * the innermost loop, its index, and current item (foreach only). Kept in
   * sync with the stack for backwards compatibility.
   */
  iterationInfo?: IterationFrame;
  /**
   * Stack of active loop iteration frames, outermost first. Enables
   * `iterationIndexes(loopName)` to find any enclosing loop's index.
   */
  iterationStack?: IterationFrame[];
  /**
   * Most recently executed action's metadata. Powers the `action()` expression.
   * Set/updated by executeNode as it processes each non-trigger node.
   */
  currentAction?: CurrentActionInfo;
  /**
   * Set while a debugger evaluates console input. action() and listCallbackUrl() answer there,
   * while in a flow the cloud refuses them where they have nothing to read
   * (conformance/flows/expr-errors.ff.ts).
   */
  debugEvaluation?: boolean;
  /**
   * Per-scope accumulated child action results. Keyed by scope/foreach/until/if
   * action name. For loops, results from all iterations are appended in order.
   * Powers the `result(scopedActionName)` expression.
   */
  scopeResults?: Map<string, ScopedActionResult[]>;
  /**
   * Pre-resolved callback URL for the flow's invocation trigger. Powers
   * `listCallbackUrl()`. The host (CLI/web) fetches this from the Power
   * Platform Flow Service API before invoking run() and passes it via
   * RunOptions.callbackUrl. When unset, listCallbackUrl() returns ''.
   */
  callbackUrl?: string;
  /** Environment id for `workflow().tags.environmentName`, when the host knows it. */
  environmentName?: string;
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(event: object): void;
  secrets(name: string): string | undefined;
  connector<T extends BaseConnector>(name: string): T;
  loadChildFlow?: (workflowId: string) => Promise<FlowIR | null>; // Load child workflow by GUID
  /** Collected file artifacts from sentinel-tagged Compose actions (local debug aid). */
  artifacts?: FileArtifact[];
}

/**
 * A connector result that sets the action's status code for this one call, for operations whose
 * cloud status differs per call (an upsert answers 201 when it creates the row and 200 when it
 * updates it) or that record no `outputs.statusCode` at all (`omitStatusCode`: a Dataverse file
 * download, whose code is still PartialContent). Plain JSON, so record/replay keeps it.
 * `connectorResponse()` in @flowforger/connectors-shared builds one.
 */
export interface ConnectorResponse {
  $connectorResponse: true;
  statusCode: number;
  body?: unknown;
  omitStatusCode?: boolean;
}

export function isConnectorResponse(value: unknown): value is ConnectorResponse {
  return !!value && typeof value === 'object' && (value as ConnectorResponse).$connectorResponse === true;
}

export interface BaseConnector {
  /** Resolves to the action's body, or to a ConnectorResponse when the status code is per call. */
  invoke(operation: string, inputs: any, ctx: RunContext): Promise<any>;
  /** The cloud's `outputs.statusCode` for a successful call (default 200; e.g. 201 for a create). */
  successStatusCode?(operation: string): number;
  /**
   * The cloud's `outputs` for a failed call, from the error `invoke` threw, for connectors
   * whose cloud counterpart rewrites the service's errors (default: the HTTP error's
   * status and response body, see connectorErrorOutputs).
   */
  errorOutputs?(operation: string, err: unknown): { statusCode: number; body: unknown } | undefined;
  /**
   * The page behind a result's `@odata.nextLink`, shaped like the first page (`{ value, '@odata.nextLink'? }`).
   * Lets the engine honour an action's pagination policy.
   */
  nextPage?(operation: string, inputs: any, nextLink: string, ctx: RunContext): Promise<any>;
}

/**
 * Follow `@odata.nextLink` until at least `minimumItemCount` items are collected
 * (runtimeConfiguration.paginationPolicy), as the cloud does when "Pagination" is on.
 * Like the cloud (verified by conformance runs): whole pages are kept, so the count can
 * exceed the threshold, and the merged result is `{ value }` alone — no nextLink, no
 * page-level annotations — even when there was only one page.
 */
export async function paginate(conn: BaseConnector, operation: string, inputs: any, first: any, minimumItemCount: number, ctx: RunContext): Promise<any> {
  if (!first || typeof first !== 'object' || !Array.isArray(first.value)) return first;
  const value = [...first.value];
  let next: unknown = first['@odata.nextLink'];
  while (conn.nextPage && value.length < minimumItemCount && typeof next === 'string' && next) {
    const page = await conn.nextPage(operation, inputs, next, ctx);
    if (!page || !Array.isArray(page.value)) break;
    value.push(...page.value);
    next = page['@odata.nextLink'];
  }
  return { value };
}

/**
 * `outputs` of a failed connector call, as the cloud records it: the HTTP status and the
 * error body, so a catch branch can read `outputs('X')?['statusCode']` and `body('X')`.
 * Undefined for failures that never reached the service (no HTTP status on the error).
 */
export function connectorErrorOutputs(conn: BaseConnector, operation: string, err: any): { statusCode: number; body: unknown } | undefined {
  const statusCode = typeof err?.status === 'number' ? err.status : typeof err?.statusCode === 'number' ? err.statusCode : undefined;
  if (statusCode === undefined) return undefined;
  return conn.errorOutputs?.(operation, err) ?? { statusCode, body: err.response ?? err.body };
}

export interface RunOptions {
  mode?: 'mock' | 'live' | 'record' | 'replay';
  input?: any;
  connectors?: Record<string, BaseConnector>;
  logger?: (evt: object) => void;
  secrets?: Record<string, string>;
  variables?: Record<string, any>;
  parameterOverrides?: Record<string, any>; // Override flow parameter defaultValues at runtime
  loadChildFlow?: (workflowId: string) => Promise<FlowIR | null>; // Custom child flow loader
  strictWorkflows?: boolean; // Fail on missing/erroring child workflows
  /** Pre-resolved trigger callback URL for `listCallbackUrl()`. */
  callbackUrl?: string;
  /** Power Platform environment id, for `workflow().tags.environmentName`. */
  environmentName?: string;

  /**
   * Debug hook called before each child node execution inside control flow
   * (foreach, dountil, and any future nested execution like child flows).
   * Return 'continue' to proceed or 'stop' to abort execution.
   */
  onBeforeChildExecute?: (node: Node, ctx: RunContext) => Promise<'continue' | 'stop'>;

  /**
   * Debug hook called after each child node execution inside control flow.
   * Receives the node and its execution result.
   */
  onAfterChildExecute?: (node: Node, result: ExecuteNodeResult, ctx: RunContext) => Promise<void>;

  /**
   * Debug hook called before executing a child workflow action.
   * If the hook returns { handled: true, result }, executeNode uses that result
   * instead of running the child flow itself. This allows the debug runner to
   * intercept workflow execution and debug into child flows.
   */
  onBeforeWorkflowExecute?: (
    node: ActionNode,
    workflowRef: string,
    evaluatedBody: any,
  ) => Promise<{ handled: true; result: ExecuteNodeResult } | { handled: false }>;
}

export interface TraceEntry {
  nodeId: string;
  name: string;
  status: StepResult['status'];
  /** Resolved invocation payload — see ActionOutput.inputs for which kinds set it. */
  inputs?: any;
  outputs?: any;
  error?: any;
  iterations?: IterationTraceEntry[];
  /**
   * Scope/if/switch only: the entries of the actions that ran (or were
   * skipped) inside the block, in execution order. The block's own entry comes
   * first in the trace; its body lives here, the way a loop's lives in `iterations`.
   */
  children?: TraceEntry[];
}

/** Visit each entry and, depth-first, its scope/if/switch `children` (not loop iterations). */
function walkTraceChildren(entries: TraceEntry[], visit: (entry: TraceEntry) => void): void {
  for (const entry of entries) {
    visit(entry);
    if (entry.children) walkTraceChildren(entry.children, visit);
  }
}

/**
 * The entries plus all their scope/if/switch descendants, each block before its
 * body. Loop bodies stay inside `iterations` — they run once per item, so they
 * have no single place in a flat list.
 */
export function flattenTrace(entries: TraceEntry[]): TraceEntry[] {
  const flat: TraceEntry[] = [];
  walkTraceChildren(entries, (entry) => flat.push(entry));
  return flat;
}

export interface IterationTraceEntry {
  index: number;
  item?: any;
  conditionResult?: boolean;
  status: StepResult['status'];
  actions: TraceEntry[];
}

export interface RunResult extends StepResult {
  trace: TraceEntry[];
  artifacts?: FileArtifact[];
  /** What the flow's first Response action answered (a child flow's answer to its parent). */
  response?: FlowResponse;
}

/**
 * A file produced by a sentinel-tagged Compose during a local run. The engine
 * only collects these (pure); the host (CLI/web) decides how to materialize
 * them. In the Maker portal the originating Compose is an ordinary action with
 * no special behavior.
 */
export interface FileArtifact {
  fileName: string;
  contentType: string;
  content: string;
  encoding: 'utf8' | 'base64';
}

/**
 * Evaluate a node's `runAfter` against the statuses recorded so far.
 *
 * Multiple dependencies are **ANDed**, matching Logic Apps: the action runs
 * only once *every* listed dependency has finished in one of its listed
 * statuses. A dependency with no status yet has not finished, so it blocks.
 *
 * This is why `runAfter: { Try: ['Succeeded'], Catch: ['Succeeded'] }` never
 * runs — on the success path Catch is Skipped, on the failure path Try is
 * Failed. Covering both branches of a try/catch takes ONE dependency listing
 * every status it can hold (`{ Catch: ['Succeeded', 'Skipped'] }`).
 *
 * Returns the first dependency that is not satisfied (the one the cloud's skip
 * message names), or undefined when the node may run.
 */
function unmetRunAfter(
  runAfter: Record<string, StepResult['status'][]> | undefined,
  lookupStatus: (name: string) => StepResult['status'] | undefined,
): { name: string; expected: string[]; actual: string | undefined } | undefined {
  for (const [name, expected] of Object.entries(runAfter ?? {})) {
    const actual = lookupStatus(name);
    if (!actual || !expected.includes(actual)) return { name, expected, actual };
  }
  return undefined;
}

/**
 * Names of dependencies whose `Failed` status this node explicitly accepts —
 * i.e. the failures this node is the handler for. Used to decide whether a
 * failure was caught (run continues, overall status can still be Succeeded)
 * or left dangling (run is Failed).
 */
function handledFailures(runAfter: Record<string, StepResult['status'][]> | undefined): string[] {
  if (!runAfter) return [];
  return Object.entries(runAfter)
    .filter(([, statuses]) => statuses.includes('Failed'))
    .map(([name]) => name);
}

const CONTENT_TYPE_EXT: Record<string, string> = {
  'text/xml': 'xml',
  'application/xml': 'xml',
  'application/json': 'json',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/html': 'html',
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/zip': 'zip',
};

/** Content types whose payload is human-readable text (default utf8, not base64). */
function isTextualContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return (
    lower.startsWith('text/') ||
    lower.includes('json') ||
    lower.includes('xml') ||
    lower.includes('html') ||
    lower.includes('csv') ||
    lower.includes('javascript')
  );
}

/** Loose base64 shape check (whitespace tolerated, padding optional). */
function looksLikeBase64(s: string): boolean {
  const compact = s.replace(/\s/g, '');
  return compact.length > 0 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

/**
 * If `value` is a sentinel file object (`@@ff:saveFile === true`) with valid
 * fields, return a normalized FileArtifact; otherwise null. Pure — no I/O.
 */
export function detectFileArtifact(value: any, actionName: string): FileArtifact | null {
  if (!value || typeof value !== 'object' || value['@@ff:saveFile'] !== true) return null;
  let { contentType, content, encoding } = value as {
    contentType?: unknown;
    content?: unknown;
    encoding?: unknown;
  };

  // Power Automate file-content shape ({ "$content": "<base64>", "$content-type": ... }),
  // as returned by e.g. SharePoint GetFileContent — the payload is base64 by
  // definition and carries its own content type, so ctx.saveFile can take the
  // connector result verbatim as `content`.
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    const b64 = obj['$content'];
    if (typeof b64 !== 'string') return null;
    if (typeof contentType !== 'string') {
      const ct = obj['$contentType'] ?? obj['$content-type'];
      contentType = typeof ct === 'string' ? ct : 'application/octet-stream';
    }
    content = b64;
    encoding = 'base64';
  }

  if (typeof contentType !== 'string' || typeof content !== 'string') return null;

  // Explicit encoding wins. Otherwise textual content types default to utf8,
  // while binary ones (pdf, octet-stream, images, …) can only travel through a
  // flow as base64 — so base64-shaped content is decoded rather than written
  // out as the base64 text itself.
  const resolvedEncoding: FileArtifact['encoding'] =
    encoding === 'base64'
      ? 'base64'
      : encoding === 'utf8'
        ? 'utf8'
        : !isTextualContentType(contentType) && looksLikeBase64(content)
          ? 'base64'
          : 'utf8';

  const ext = CONTENT_TYPE_EXT[contentType] ?? 'bin';
  const fileName =
    typeof value.fileName === 'string' && value.fileName.length > 0
      ? value.fileName
      : `${actionName}.${ext}`;
  return { fileName, contentType, content, encoding: resolvedEncoding };
}

/** An array element as the Join action renders it: objects as JSON text, null as nothing. */
function joinText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** `undefined` → `null` throughout a value: a Logic Apps expression that finds nothing is null. */
function missingAsNull(value: any): any {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(missingAsNull);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const result: any = {};
    for (const [key, val] of Object.entries(value)) result[key] = missingAsNull(val);
    return result;
  }
  return value;
}

/**
 * Whether a string value is evaluated: an `@expression`, or text with `@{...}` interpolation
 * anywhere in it (`"Hello @{name}"`). Anything else is a literal.
 */
function isExpressionText(s: string): boolean {
  return s.startsWith('@') || s.includes('@{');
}

/**
 * Recursively evaluate expressions in objects and arrays
 */
function deepEvalValue(value: any, ctx: RunContext): any {
  if (typeof value === 'string' && isExpressionText(value)) {
    // A Logic Apps expression never yields "undefined": `body('X')?['missing']` is null,
    // so a Compose keeps the key with null where JS would drop it.
    const result = evalExpression(value, ctx);
    return result === undefined ? null : result;
  } else if (Array.isArray(value)) {
    return value.map(item => deepEvalValue(item, ctx));
  } else if (value !== null && typeof value === 'object') {
    const result: any = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = deepEvalValue(val, ctx);
    }
    return result;
  }
  return value;
}

/**
 * Copy arrays and plain objects (recursively) so a value the engine stores
 * never shares structure with anything else. Variables are the only state the
 * engine mutates in place (AppendToArrayVariable pushes), so without this:
 * - an initializer literal is the flow IR's own object, and appending grows
 *   the IR itself: a second run of the same in-memory flow (debugger restart,
 *   Edit & Continue, web re-run) starts from the previous run's items;
 * - a variable initialized from `outputs('X')` would grow action X's outputs;
 * - every trace entry would alias the live array and show its final state.
 * Non-plain objects (Buffers, typed arrays, Dates) are returned as-is.
 */
function copyValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copyValue) as T;
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const result: any = {};
      for (const [key, val] of Object.entries(value)) result[key] = copyValue(val);
      return result;
    }
  }
  return value;
}

const MAX_PARALLEL_CONCURRENCY = 50;
const DEFAULT_PARALLEL_CONCURRENCY = 20;

function getForeachConcurrency(node: any): number | null {
  if (node.parallel === false) {
    return null; // explicit sequential override
  }
  if (!node.parallel && !node.runtimeConfiguration?.concurrency?.repetitions) {
    return null; // sequential
  }
  const repetitions = node.runtimeConfiguration?.concurrency?.repetitions;
  if (repetitions !== undefined && repetitions <= 1) {
    return null; // explicit sequential
  }
  const degree = repetitions ?? DEFAULT_PARALLEL_CONCURRENCY;
  return Math.min(degree, MAX_PARALLEL_CONCURRENCY);
}

export async function run(flow: FlowIR, options: RunOptions = {}): Promise<RunResult> {
  const { connectors = {}, logger, secrets = {}, input, variables = {}, parameterOverrides, loadChildFlow } = options;

  const trace: TraceEntry[] = [];

  // Merge parameter overrides into flow parameters (update defaultValue for each override)
  const parameters = { ...(flow.parameters || {}) };
  if (parameterOverrides) {
    for (const [key, value] of Object.entries(parameterOverrides)) {
      if (parameters[key] && typeof parameters[key] === 'object') {
        parameters[key] = { ...parameters[key], defaultValue: value };
      } else {
        parameters[key] = { defaultValue: value, type: 'String' };
      }
    }
  }

  const ctx: RunContext = {
    variables: { ...variables },
    actions: new Map<string, ActionOutput>(),
    triggerData: toTriggerOutputs(input),
    trigger: triggerRunInfo(flow, new Date()),
    workflowName: flow.name,
    parameters,
    childFlows: flow.childFlows,
    iterationStack: [],
    scopeResults: new Map<string, ScopedActionResult[]>(),
    artifacts: [],
    callbackUrl: options.callbackUrl,
    environmentName: options.environmentName,
    now: () => new Date(),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    log: (evt) => logger?.(evt),
    secrets: (name) => secrets[name],
    connector: (name) => connectors[name] as any,
    loadChildFlow,
  };

  const trigger = (flow.nodes as any[]).find((n: any) => n.type === 'trigger' || n.type === 'recurrence') as TriggerNode | RecurrenceTriggerNode | undefined;
  if (!trigger) {
    return { status: 'Failed', error: new Error('No trigger found'), trace };
  }
  // For now, treat trigger as pass-through of provided input
  // For recurrence triggers, the engine validates the schedule but doesn't wait
  trace.push({ nodeId: trigger.id, name: trigger.name, status: 'Succeeded', outputs: input });
  ctx.actions.set(trigger.name, { status: 'Succeeded', outputs: input });

  // Execute all nodes sequentially, delegating to executeNode for each
  const top = new TopLevelRun(ctx);
  for (const node of flow.nodes as Node[]) {
    if (isTriggerNode(node)) continue;

    const skipped = top.skip(node);
    if (skipped) {
      trace.push(skipped);
      continue;
    }

    const result = await executeNode(node, ctx, options);

    // Build trace entry from executeNode result
    const entry: TraceEntry = {
      nodeId: node.id,
      name: node.name,
      status: result.status,
      ...(result.inputs !== undefined ? { inputs: result.inputs } : {}),
      outputs: result.outputs,
      error: result.error,
    };
    if (result.iterations) {
      entry.iterations = result.iterations;
    }
    if (result._childTrace) {
      entry.children = result._childTrace;
    }
    trace.push(entry);
    top.finished(node, result);
  }

  return { ...top.outcome(), trace, artifacts: ctx.artifacts, ...(ctx.response ? { response: ctx.response } : {}) };
}

/**
 * The bookkeeping of running a flow's top-level actions in order: runAfter skips, which
 * failures a later action handles, Terminate, and the run's final status. Shared by run() and
 * hosts that drive the top level themselves (the debug session), so both follow the cloud.
 * Statuses are read from `ctx.actions`, which also holds the actions nested in blocks.
 */
export class TopLevelRun {
  /** Top-level actions that failed and that no later action has (yet) handled. */
  private unhandledFailures = new Set<string>();
  private terminatedWith?: { status: StepResult['status']; error?: any };

  constructor(private ctx: RunContext) {}

  /** Whether a Terminate has ended the run. */
  get terminated(): boolean {
    return this.terminatedWith !== undefined;
  }

  /**
   * Call before running a node. When a Terminate has ended the run, or the node's runAfter is
   * not met, records the node (and everything inside it) as Skipped with the cloud's reason and
   * returns its trace entry: the node must not run. Otherwise returns undefined.
   */
  skip(node: Node): TraceEntry | undefined {
    if (this.terminatedWith) return skipNode(node, SKIPPED_BY_TERMINATE, this.ctx);
    const unmet = unmetRunAfter((node as any).runAfter, name => this.ctx.actions.get(name)?.status);
    if (!unmet) return undefined;
    return skipNode(node, skippedByRunAfter(node.name, unmet.name, unmet.expected, unmet.actual), this.ctx);
  }

  /** Call after a node ran: records its result and notes a failure or a Terminate. */
  finished(node: Node, result: ExecuteNodeResult): void {
    // This node ran *because of* the earlier failures its runAfter accepts: those are caught.
    for (const handled of handledFailures((node as any).runAfter)) this.unhandledFailures.delete(handled);
    // A debugger can run a node again (Set Next Statement): only its latest result counts.
    this.unhandledFailures.delete(node.name);
    this.ctx.actions.set(node.name, recordOf(result));
    if (result._terminate) {
      this.terminatedWith = { status: result._terminate as StepResult['status'], error: result._runError };
    } else if (result.status === 'Failed' || result._childFailed) {
      // A failure does not end the run on its own: a later node whose runAfter accepts it (a
      // catch scope) still gets its turn, and nodes that only accept Succeeded are skipped.
      this.unhandledFailures.add(node.name);
    }
  }

  /** The run's status: a Terminate's (with its runError), else Failed while a failure is uncaught. */
  outcome(): { status: StepResult['status']; error?: any } {
    if (this.terminatedWith) {
      const { status, error } = this.terminatedWith;
      return error !== undefined ? { status, error } : { status };
    }
    return { status: this.unhandledFailures.size > 0 ? 'Failed' : 'Succeeded' };
  }
}

/**
 * `result()` of a foreach: one entry per child action, holding that child's record from every
 * iteration (as `outputs` in the cloud's shape), Failed when any iteration's was.
 */
function aggregateLoopRecords(perIteration: (ScopedActionResult[] | undefined)[]): ScopedActionResult[] {
  const byName = new Map<string, ScopedActionResult[]>();
  for (const records of perIteration) {
    for (const r of records ?? []) {
      if (!byName.has(r.name)) byName.set(r.name, []);
      byName.get(r.name)!.push(r);
    }
  }
  return [...byName].map(([name, reps]) => ({
    name,
    status: reps.some(r => r.status === 'Failed') ? 'Failed' : reps.every(r => r.status === 'Skipped') ? 'Skipped' : 'Succeeded',
    code: 'NotSpecified',
    repetitions: reps,
    repetitionCount: reps.length,
    startTime: reps[0].startTime,
    endTime: reps[reps.length - 1].endTime,
    trackingId: crypto.randomUUID(),
  }));
}

/** A block node's child lists in definition order: then/else, cases, then default. */
function childLists(node: any): Node[][] {
  const lists: Node[][] = [];
  if (Array.isArray(node.actions)) lists.push(node.actions);
  if (Array.isArray(node.elseActions)) lists.push(node.elseActions);
  for (const c of node.cases ?? []) if (Array.isArray(c.actions)) lists.push(c.actions);
  if (Array.isArray(node.defaultActions)) lists.push(node.defaultActions);
  return lists;
}

function isTriggerNode(n: any): boolean {
  return n.type === 'trigger' || n.type === 'recurrence';
}

/**
 * Record a node that did not run, and, like the cloud, everything inside it: each child is
 * skipped because its block was (or, after a Terminate, because the run ended). Returns the
 * node's trace entry, with its body under `children`.
 */
function skipNode(node: any, outcome: Outcome, ctx: RunContext): TraceEntry {
  const now = ctx.now().toISOString();
  ctx.actions.set(node.name, {
    status: 'Skipped',
    kind: nodeKind(node),
    ...outcome,
    startTime: now,
    endTime: now,
    trackingId: crypto.randomUUID(),
  });
  const entry: TraceEntry = { nodeId: node.id, name: node.name, status: 'Skipped' };
  const children = childLists(node).flat().filter(c => !isTriggerNode(c));
  if (children.length) {
    entry.children = children.map(child =>
      skipNode(
        child,
        outcome === SKIPPED_BY_TERMINATE ? SKIPPED_BY_TERMINATE : skippedByParent(child.name, node.name, 'Skipped', outcome.code),
        ctx,
      ),
    );
    ctx.scopeResults?.set(node.name, children.map(c => ({ name: c.name, ...ctx.actions.get(c.name)! })));
  }
  return entry;
}

/**
 * Mark a list of children as not run because their block did not take them (an If branch or
 * Switch case not chosen), or because it failed before running them. Returns their trace entries.
 */
function skipChildren(
  children: Node[],
  outcomeFor: (child: Node) => Outcome,
  ctx: RunContext,
  scopeName: string,
): TraceEntry[] {
  const records = ctx.scopeResults?.get(scopeName);
  return children.filter(c => !isTriggerNode(c)).map(child => {
    const entry = skipNode(child, outcomeFor(child), ctx);
    records?.push({ name: child.name, ...ctx.actions.get(child.name)! });
    return entry;
  });
}

/**
 * Execute a single node with the given context.
 * This is the single source of truth for executing any node type.
 * Used by both run() for batch execution and directly for step-by-step debugging.
 */
export interface ExecuteNodeResult {
  status: StepResult['status'];
  /** Resolved invocation payload — see ActionOutput.inputs for which kinds set it. */
  inputs?: any;
  outputs?: any;
  error?: any;
  variables: Record<string, any>;
  iterations?: IterationTraceEntry[];
  /** @internal Used by run() to detect terminate actions */
  _terminate?: string;
  /** @internal Child trace entries for scope/if/switch; the caller nests them as the entry's `children` */
  _childTrace?: TraceEntry[];
  /** @internal Indicates a child node failed, requiring failure propagation even when this node's status is 'Succeeded' */
  _childFailed?: boolean;
  /** @internal Terminate only: the runError it ends the run with */
  _runError?: any;
  /** The cloud's code/error for `actions()` / `result()` (see action-status.ts); set by executeNode */
  code?: string;
  cloudError?: Outcome['cloudError'];
  kind?: string;
  startTime?: string;
  endTime?: string;
  trackingId?: string;
}

/** The record `ctx.actions` / `result()` keep for an executed node. */
export function recordOf(result: ExecuteNodeResult): ActionOutput {
  const rec: ActionOutput = { status: result.status };
  if (result.inputs !== undefined) rec.inputs = result.inputs;
  rec.outputs = result.outputs;
  rec.error = result.error;
  for (const key of ['kind', 'code', 'cloudError', 'startTime', 'endTime', 'trackingId'] as const) {
    if (result[key] !== undefined) (rec as any)[key] = result[key];
  }
  return rec;
}

/**
 * Stamp the resolved invocation payload onto the in-flight action record so the
 * `action()` expression can surface `action().inputs`. Called from the same
 * three branches that put `inputs` on the ExecuteNodeResult.
 */
function recordCurrentActionInputs(ctx: RunContext, inputs: any): void {
  if (ctx.currentAction) ctx.currentAction.inputs = inputs;
}

export async function executeNode(
  node: Node,
  ctx: RunContext,
  options: RunOptions = {}
): Promise<ExecuteNodeResult> {
  const startTime = ctx.now().toISOString();
  const result = await executeNodeInner(node, ctx, options);
  return {
    ...result,
    ...describeOutcome(node, result),
    kind: nodeKind(node),
    startTime,
    endTime: ctx.now().toISOString(),
    trackingId: crypto.randomUUID(),
  };
}

/** Result of running a block's children. */
interface ChildRunResult {
  status: StepResult['status'];
  terminated?: string;
  runError?: any;
  /** A debug hook asked to stop. */
  stopped?: boolean;
  /** The direct children's records, in order (what `result()` of the block lists). */
  records: ScopedActionResult[];
}

async function executeNodeInner(
  node: Node,
  ctx: RunContext,
  options: RunOptions = {}
): Promise<ExecuteNodeResult> {
  const { connectors = {} } = options;

  /**
   * Run an array of child nodes sequentially, calling executeNode recursively.
   * Supports debug hooks, runAfter checking, and trace recording. `c` is the
   * context to run in (a parallel foreach iteration passes its own).
   * With `parentScopeName`, the children's records are also collected for
   * `result(parentScopeName)`.
   */
  async function runChildNodes(
    childNodes: Node[],
    childTrace: TraceEntry[],
    childActionStatuses?: Map<string, StepResult['status']>,
    parentScopeName?: string,
    c: RunContext = ctx,
  ): Promise<ChildRunResult> {
    const statuses = childActionStatuses || new Map<string, StepResult['status']>();
    // Children that failed and have not (yet) been caught by a later sibling
    // whose runAfter accepts their `Failed` status.
    const unhandledFailures = new Set<string>();
    const records: ScopedActionResult[] = [];
    // Collector for `result(scopedActionName)` lookup. Only top-level direct
    // children of the scope are recorded — nested scope's children belong to
    // their own collector, not this one.
    const recordChildResult = (r: ScopedActionResult) => {
      records.push(r);
      if (!parentScopeName || !c.scopeResults) return;
      const arr = c.scopeResults.get(parentScopeName) ?? [];
      arr.push(r);
      c.scopeResults.set(parentScopeName, arr);
    };
    const skip = (childNode: any, outcome: Outcome) => {
      const entry = skipNode(childNode, outcome, c);
      childTrace.push(entry);
      statuses.set(childNode.name, 'Skipped');
      if (entry.children) walkTraceChildren(entry.children, e => statuses.set(e.name, e.status));
      recordChildResult({ name: childNode.name, ...c.actions.get(childNode.name)! });
    };

    const runnable = (childNodes as any[]).filter(n => !isTriggerNode(n));
    for (let i = 0; i < runnable.length; i++) {
      const childNode = runnable[i];

      // Check runAfter for child nodes
      const runAfter = childNode.runAfter as Record<string, StepResult['status'][]> | undefined;
      const unmet = unmetRunAfter(runAfter, name => statuses.get(name) || c.actions.get(name)?.status);
      if (unmet) {
        skip(childNode, skippedByRunAfter(childNode.name, unmet.name, unmet.expected, unmet.actual));
        continue;
      }

      // This child runs *because of* a sibling's failure — that failure is caught.
      for (const handled of handledFailures(runAfter)) unhandledFailures.delete(handled);

      // Call debug hook before child execution
      if (options.onBeforeChildExecute) {
        const action = await options.onBeforeChildExecute(childNode as Node, c);
        if (action === 'stop') {
          return { status: 'Failed', stopped: true, records };
        }
      }

      try {
        const childResult = await executeNode(childNode as Node, c, options);

        // Record in c.actions
        const record = recordOf(childResult);
        c.actions.set(childNode.name, record);
        statuses.set(childNode.name, childResult.status);
        recordChildResult({ name: childNode.name, ...record });

        // Merge variables back
        c.variables = { ...c.variables, ...childResult.variables };

        // Record scope/if/switch descendants for runAfter tracking
        if (childResult._childTrace) {
          walkTraceChildren(childResult._childTrace, (nestedEntry) => statuses.set(nestedEntry.name, nestedEntry.status));
        }

        // Build trace entry
        const entry: TraceEntry = {
          nodeId: childNode.id,
          name: childNode.name,
          status: childResult.status,
          ...(childResult.inputs !== undefined ? { inputs: childResult.inputs } : {}),
          outputs: childResult.outputs,
          error: childResult.error,
        };
        if (childResult.iterations) {
          entry.iterations = childResult.iterations;
        }
        if (childResult._childTrace) {
          entry.children = childResult._childTrace;
        }
        childTrace.push(entry);

        // Call debug hook after child execution
        if (options.onAfterChildExecute) {
          await options.onAfterChildExecute(childNode as Node, childResult, c);
        }

        // Terminate: the rest of this block is skipped, and the block reports Cancelled.
        if (childResult._terminate) {
          for (const rest of runnable.slice(i + 1)) skip(rest, SKIPPED_BY_TERMINATE);
          return { status: 'Cancelled', terminated: childResult._terminate, runError: childResult._runError, records };
        }

        // A failed child does not abort its siblings: later siblings whose
        // runAfter accepts the failure (a catch scope) still need to run, and
        // those that only accept Succeeded are skipped by the check above.
        // The scope is Failed only if nothing downstream caught the failure.
        if (childResult._childFailed || childResult.status === 'Failed') {
          unhandledFailures.add(childNode.name);
        }
      } catch (err: any) {
        childTrace.push({
          nodeId: childNode.id,
          name: childNode.name,
          status: 'Failed',
          error: err,
        });
        statuses.set(childNode.name, 'Failed');
        const record: ActionOutput = { status: 'Failed', error: err, kind: nodeKind(childNode), ...describeOutcome(childNode, { status: 'Failed', error: err }) };
        c.actions.set(childNode.name, record);
        recordChildResult({ name: childNode.name, ...record });
        unhandledFailures.add(childNode.name);
      }
    }
    return { status: unhandledFailures.size > 0 ? 'Failed' : 'Succeeded', records };
  }

  /** A block's own result after running children: Cancelled (with the terminate signal) or its children's status. */
  function blockResult(child: ChildRunResult): Pick<ExecuteNodeResult, 'status' | '_terminate' | '_runError' | 'code' | 'cloudError'> {
    if (child.terminated) {
      return { status: 'Cancelled', _terminate: child.terminated, _runError: child.runError, ...SKIPPED_BY_TERMINATE };
    }
    return { status: child.status };
  }

  try {
    if (node.type === 'trigger' || node.type === 'recurrence') {
      // Triggers just pass through the input
      return {
        status: 'Succeeded',
        outputs: ctx.triggerData,
        variables: { ...ctx.variables },
      };
    }

    // Track the most recently entered non-trigger node. Powers the `action()`
    // expression. Live status/outputs are read from ctx.actions at lookup time
    // so we don't need to update this record after execution completes.
    ctx.currentAction = {
      name: node.name,
      startTime: ctx.now().toISOString(),
    };

    if (node.type === 'action') {
      const action = node as ActionNode;

      if (action.kind === 'http') {
        const http = connectors['http'];
        if (!http) {
          return {
            status: 'Failed',
            error: new Error('HTTP connector not available'),
            variables: { ...ctx.variables },
          };
        }

        return await executeHttpAction(action, ctx, http);
      } else if (action.kind === 'compose') {
        const value = (action.inputs as any).value;
        const result = deepEvalValue(value, ctx);
        const artifact = detectFileArtifact(result, action.name);
        if (artifact) ctx.artifacts?.push(artifact);
        return {
          status: 'Succeeded',
          outputs: result,
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'initializevariable') {
        const inputs = action.inputs as any;
        const value = typeof inputs.value === 'string' && isExpressionText(inputs.value)
          ? evalExpression(inputs.value, ctx)
          : inputs.value;
        ctx.variables[inputs.variableName] = copyValue(value);
        return {
          status: 'Succeeded',
          outputs: copyValue(ctx.variables[inputs.variableName]),
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'setvariable') {
        const inputs = action.inputs as any;
        const value = typeof inputs.value === 'string' && isExpressionText(inputs.value)
          ? evalExpression(inputs.value, ctx)
          : inputs.value;
        ctx.variables[inputs.name] = copyValue(value);
        return {
          status: 'Succeeded',
          outputs: copyValue(ctx.variables[inputs.name]),
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'incrementvariable') {
        const inputs = action.inputs as any;
        const increment = typeof inputs.value === 'number' ? inputs.value : 1;
        ctx.variables[inputs.name] = (ctx.variables[inputs.name] || 0) + increment;
        return {
          status: 'Succeeded',
          outputs: ctx.variables[inputs.name],
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'decrementvariable') {
        const inputs = action.inputs as any;
        const decrement = typeof inputs.value === 'number' ? inputs.value : 1;
        ctx.variables[inputs.name] = (ctx.variables[inputs.name] || 0) - decrement;
        return {
          status: 'Succeeded',
          outputs: ctx.variables[inputs.name],
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'appendtoarrayvariable') {
        const inputs = action.inputs as any;
        // Use deepEvalValue to recursively evaluate expressions in objects/arrays
        const value = deepEvalValue(inputs.value, ctx);
        if (!Array.isArray(ctx.variables[inputs.name])) {
          ctx.variables[inputs.name] = [];
        }
        ctx.variables[inputs.name].push(copyValue(value));
        return {
          status: 'Succeeded',
          // Snapshot: later appends must not rewrite this step's recorded output.
          // Shallow is enough: the engine never mutates array elements in place.
          outputs: [...ctx.variables[inputs.name]],
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'appendtostringvariable') {
        const inputs = action.inputs as any;
        // Use deepEvalValue to recursively evaluate expressions in objects/arrays
        const value = deepEvalValue(inputs.value, ctx);
        // Logic Apps implicitly coerces non-string values to JSON strings
        const stringValue = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
        ctx.variables[inputs.name] = (ctx.variables[inputs.name] || '') + stringValue;
        return {
          status: 'Succeeded',
          outputs: ctx.variables[inputs.name],
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'join') {
        const inputs = action.inputs as any;
        const from = typeof inputs.from === 'string' && isExpressionText(inputs.from)
          ? evalExpression(inputs.from, ctx)
          : inputs.from;
        const joinWith = inputs.joinWith || ',';
        // Objects join as their JSON text (the cloud's rendering), not "[object Object]".
        const result = Array.isArray(from) ? from.map(joinText).join(joinWith) : '';
        return {
          status: 'Succeeded',
          outputs: { body: result },
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'select') {
        const inputs = action.inputs as any;
        const from = typeof inputs.from === 'string' && isExpressionText(inputs.from)
          ? evalExpression(inputs.from, ctx)
          : inputs.from;
        const selectMap = inputs.select;
        const result = Array.isArray(from) ? from.map((item: any) => {
          const prev = ctx.variables['item'];
          ctx.variables['item'] = item;
          let mapped: any;
          if (typeof selectMap === 'string') {
            // Text-mode map (Select's "Map" as a single expression): the
            // result is an array of scalars, not objects.
            mapped = isExpressionText(selectMap) ? evalExpression(selectMap, ctx) : selectMap;
          } else {
            mapped = {};
            for (const [key, expr] of Object.entries(selectMap ?? {})) {
              mapped[key] = typeof expr === 'string' && isExpressionText(expr as string)
                ? evalExpression(expr as string, ctx)
                : expr;
            }
          }
          if (prev === undefined) delete ctx.variables['item']; else ctx.variables['item'] = prev;
          return mapped;
        }) : [];
        return {
          status: 'Succeeded',
          outputs: { body: result },
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'filterarray') {
        const inputs = action.inputs as any;
        const from = typeof inputs.from === 'string' && isExpressionText(inputs.from)
          ? evalExpression(inputs.from, ctx)
          : inputs.from;
        const whereExpr = inputs.where;
        const result = Array.isArray(from) ? from.filter((item: any) => {
          const prev = ctx.variables['item'];
          ctx.variables['item'] = item;
          const pass = Boolean(evalExpression(whereExpr, ctx));
          if (prev === undefined) delete ctx.variables['item']; else ctx.variables['item'] = prev;
          return pass;
        }) : [];
        return {
          status: 'Succeeded',
          outputs: { body: result },
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'parsejson') {
        const inputs = action.inputs as any;
        return {
          ...parseJsonAction(deepEvalValue(inputs.from, ctx), deepEvalValue(inputs.schema, ctx)),
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'createcsvtable' || action.kind === 'createhtmltable') {
        const inputs = action.inputs as any;
        const evalInput = (v: unknown) => (typeof v === 'string' && isExpressionText(v) ? evalExpression(v, ctx) : v);
        const columns = Array.isArray(inputs.columns)
          ? inputs.columns.map((c: any) => ({
              header: evalInput(c.header),
              cell: (item: unknown) => {
                const prev = ctx.variables['item'];
                ctx.variables['item'] = item;
                try {
                  return evalInput(c.value);
                } finally {
                  if (prev === undefined) delete ctx.variables['item']; else ctx.variables['item'] = prev;
                }
              },
            }))
          : undefined;
        try {
          const body = createTable(action.kind === 'createcsvtable' ? 'CSV' : 'HTML', evalInput(inputs.from), columns);
          return { status: 'Succeeded', outputs: { body }, variables: { ...ctx.variables } };
        } catch (err) {
          if (!(err instanceof TableInputError)) throw err;
          return {
            status: 'Failed',
            error: err,
            code: 'BadRequest',
            cloudError: { code: 'BadRequest', message: err.message, messageTemplate: err.messageTemplate },
            variables: { ...ctx.variables },
          };
        }
      } else if (action.kind === 'response') {
        const inputs = action.inputs as any;
        const statusCode = Number(deepEvalValue(inputs.statusCode ?? 200, ctx));
        // Evaluate expressions in the body (supports objects, arrays, and strings)
        const body = deepEvalValue(inputs.body, ctx);
        const headers = deepEvalValue(inputs.headers ?? {}, ctx) ?? {};
        // The first Response is what the caller (a parent flow, the HTTP client) gets.
        ctx.response ??= {
          statusCode,
          headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])),
          ...(body !== undefined ? { body } : {}),
        };
        // Return just the body to match Power Automate behavior
        // In Power Automate, the response action outputs only the body content
        return {
          status: 'Succeeded',
          outputs: body,
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'terminate') {
        const inputs = action.inputs as any;
        const runStatus = inputs.runStatus || 'Cancelled';
        // The action itself succeeds; the run ends with its runStatus (and runError).
        return {
          status: 'Succeeded',
          outputs: undefined,
          variables: { ...ctx.variables },
          _terminate: runStatus,
          _runError: inputs.runError,
        };
      } else if (action.kind === 'delay') {
        const inputs = action.inputs as any;
        if (inputs.interval) {
          const { count, unit } = inputs.interval;
          let ms = count * 1000; // Default: seconds
          if (unit === 'Minute') ms = count * 60 * 1000;
          else if (unit === 'Hour') ms = count * 60 * 60 * 1000;
          else if (unit === 'Day') ms = count * 24 * 60 * 60 * 1000;
          else if (unit === 'Week') ms = count * 7 * 24 * 60 * 60 * 1000;
          else if (unit === 'Month') ms = count * 30 * 24 * 60 * 60 * 1000;
          await ctx.sleep(ms);
        }
        return {
          status: 'Succeeded',
          outputs: undefined,
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'delayuntil') {
        const inputs = action.inputs as any;
        const until = typeof inputs.until === 'string' && isExpressionText(inputs.until)
          ? evalExpression(inputs.until, ctx)
          : inputs.until;
        const targetTime = new Date(until).getTime();
        const now = Date.now();
        if (targetTime > now) {
          await ctx.sleep(targetTime - now);
        }
        return {
          status: 'Succeeded',
          outputs: undefined,
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'workflow') {
        // "Run a Child Flow": the outcome is the child's Response (see child-flow.ts).
        const inputs = action.inputs as any;
        // Support multiple formats: DSL uses workflowReferenceName, Logic Apps uses host.workflowReferenceName
        const workflowRef = inputs.workflowReferenceName || inputs.host?.workflowReferenceName || inputs.workflowId;

        if (!workflowRef) {
          const error = new Error('No workflow reference specified');
          return {
            status: 'Failed',
            error: error,
            variables: { ...ctx.variables },
          };
        }

        const body = deepEvalValue(inputs.body, ctx);
        const headers = inputs.headers === undefined ? undefined : deepEvalValue(inputs.headers, ctx);
        // The invocation payload as the cloud records it (actions('X')?['inputs']).
        const workflowId = ctx.childFlows?.[workflowRef]?.workflowId || workflowRef;
        const resolvedInputs: Record<string, any> = { host: { workflowReferenceName: workflowId } };
        if (action.retryPolicy) resolvedInputs.retryPolicy = policyRecord(action.retryPolicy);
        if (body !== undefined) resolvedInputs.body = body;
        if (headers !== undefined) resolvedInputs.headers = headers;
        recordCurrentActionInputs(ctx, resolvedInputs);

        // Allow debug runner to intercept workflow execution
        if (options.onBeforeWorkflowExecute) {
          const hookResult = await options.onBeforeWorkflowExecute(action, workflowRef, body);
          if (hookResult.handled) {
            // The debug session runs the child itself; it has no view of the
            // resolved body, so stamp it on the way out.
            return { ...hookResult.result, inputs: resolvedInputs };
          }
        }

        let loaded: FlowIR | null = null;
        try {
          loaded = ctx.loadChildFlow ? await ctx.loadChildFlow(workflowRef) : null;
        } catch (error) {
          if (options.strictWorkflows) throw error;
          return { status: 'Failed', inputs: resolvedInputs, error, variables: { ...ctx.variables } };
        }

        if (loaded) {
          const childResult = await run(loaded, {
            input: body,
            connectors: options.connectors,
            logger: options.logger,
            secrets: options.secrets,
            variables: {}, // Isolated variables
            // Env-var-backed overrides apply environment-wide: a child flow
            // reading the same env var must see the same value the parent does
            // (parameter names embed the env var schema name, so cross-flow
            // name matches identify the same variable).
            parameterOverrides: options.parameterOverrides,
            loadChildFlow: ctx.loadChildFlow, // Support nested child flows
            strictWorkflows: options.strictWorkflows,
            environmentName: options.environmentName,
          });

          // Child saveFile artifacts surface in the parent's single collection
          if (childResult.artifacts?.length) ctx.artifacts?.push(...childResult.artifacts);

          const { status, outputs } = childFlowCallResult(childResult.response, workflowId);
          if (status === 'Failed' && options.strictWorkflows) {
            throw new Error(`Child workflow '${loaded.name}' failed`);
          }
          return {
            status,
            inputs: resolvedInputs,
            outputs,
            ...(status === 'Failed' ? { error: new Error(`Child flow '${loaded.name}' answered ${outputs.statusCode}`) } : {}),
            variables: { ...ctx.variables },
          };
        }

        // Child flow not found (or no loader): strict mode fails, otherwise a simulated success.
        if (options.strictWorkflows) {
          throw new Error(`Child workflow not found: ${workflowRef}`);
        }
        const result = {
          workflowReferenceName: workflowRef,
          body,
          status: ctx.loadChildFlow ? 'Called (not found)' : 'Called (mock)',
          ...(ctx.loadChildFlow ? { warning: 'Child workflow not found, strict mode disabled' } : {}),
        };
        return {
          status: 'Succeeded',
          inputs: resolvedInputs,
          outputs: result,
          variables: { ...ctx.variables },
        };
      } else {
        // Unknown action kind - skip
        return {
          status: 'Skipped',
          outputs: undefined,
          variables: { ...ctx.variables },
        };
      }
    }

    if (node.type === 'connector') {
      const connAction = node as any;
      const connectorName = connAction.connector;
      const conn = connectors[connectorName];

      if (!conn) {
        return {
          status: 'Failed',
          error: new Error(`Connector '${connectorName}' not provided`),
          variables: { ...ctx.variables },
        };
      }

      // Declared outside the try so a failed invoke still reports what was sent.
      let evaluatedParams: any;
      try {
        // Evaluate expressions in parameters before invoking. Like the cloud, a parameter whose
        // expression finds nothing is sent as null (which clears a column), not left out.
        evaluatedParams = missingAsNull(evaluateParams(connAction.params, ctx));
        recordCurrentActionInputs(ctx, evaluatedParams);
        const minimumItemCount = Number((connAction as any).runtimeConfiguration?.paginationPolicy?.minimumItemCount);
        let rawOutput = await conn.invoke(connAction.operation, evaluatedParams, ctx);
        if (minimumItemCount > 0) {
          rawOutput = await paginate(conn, connAction.operation, evaluatedParams, rawOutput, minimumItemCount, ctx);
        }
        // For webcontents connector and SharePoint HTTP requests, return the output directly without wrapping
        // (these already return structured responses with statusCode, headers, body)
        // For other connectors, wrap in 'body' property to match Power Automate behavior
        const isHttpRequest = connectorName === 'sharepoint' && (connAction.operation === 'SendHttpRequest' || connAction.operation === 'HttpRequest');
        let outputs: any;
        let code: string | undefined;
        if (isConnectorResponse(rawOutput)) {
          outputs = {
            ...(rawOutput.omitStatusCode ? {} : { statusCode: rawOutput.statusCode }),
            ...(rawOutput.body === undefined ? {} : { body: rawOutput.body }),
          };
          if (rawOutput.omitStatusCode) code = httpStatusName(rawOutput.statusCode);
        } else {
          outputs = (connectorName === 'webcontents' || isHttpRequest)
            ? rawOutput
            : { statusCode: conn.successStatusCode?.(connAction.operation) ?? 200, body: rawOutput };
        }
        ctx.actions.set(connAction.name, { status: 'Succeeded', inputs: evaluatedParams, outputs });
        return {
          status: 'Succeeded',
          inputs: evaluatedParams,
          outputs,
          ...(code !== undefined ? { code } : {}),
          variables: { ...ctx.variables },
        };
      } catch (err: any) {
        return {
          status: 'Failed',
          inputs: evaluatedParams,
          outputs: connectorErrorOutputs(conn, connAction.operation, err),
          error: err,
          variables: { ...ctx.variables },
        };
      }
    }

    if (node.type === 'connectorwebhook') {
      const c = (node as any);
      const conn = connectors[c.connector];
      if (!conn) {
        // For webhooks, if connector not available, log a warning but continue (simulated success)
        ctx.log({ type: 'webhook-simulation', connector: c.connector, operation: c.operation, message: 'Webhook action simulated (connector not provided)' });
        const simOutput = { body: { simulated: true, message: 'Webhook action cannot be executed locally' } };
        return {
          status: 'Succeeded',
          outputs: simOutput,
          variables: { ...ctx.variables },
        };
      }
      try {
        const rawOutput = await conn.invoke(c.operation, c.params, ctx);
        // Wrap in 'body' property to match Power Automate behavior
        const outputs = { body: rawOutput };
        return {
          status: 'Succeeded',
          outputs,
          variables: { ...ctx.variables },
        };
      } catch (err: any) {
        return {
          status: 'Failed',
          error: err,
          variables: { ...ctx.variables },
        };
      }
    }

    // Control flow nodes

    if (node.type === 'scope') {
      const scopeNode = node as any;
      const childTrace: TraceEntry[] = [];
      ctx.scopeResults?.set(node.name, []);
      const result = await runChildNodes(scopeNode.actions || [], childTrace, undefined, node.name);

      // The scope takes its children's status: a scope with an uncaught child
      // failure is Failed, which is what a catch scope's
      // `runAfter: { TryBlock: ['Failed'] }` keys off.
      const own = blockResult(result);
      ctx.actions.set(node.name, { status: own.status, outputs: { scopeStatus: own.status } });

      return {
        ...own,
        outputs: { scopeStatus: own.status },
        variables: { ...ctx.variables },
        _childTrace: childTrace,
        _childFailed: result.status === 'Failed',
      };
    }

    if (node.type === 'if') {
      const ifNode = node as any;
      const condition = ifNode.condition as string;

      try {
        const conditionResult = evalExpression(condition, ctx);
        const pass = Boolean(conditionResult);

        const childTrace: TraceEntry[] = [];
        ctx.scopeResults?.set(node.name, []);
        // Like the cloud, the branch not taken is recorded as Skipped, in definition order.
        if (!pass) childTrace.push(...skipChildren(ifNode.actions || [], c => skippedByBranch(c.name), ctx, node.name));
        const result = await runChildNodes((pass ? ifNode.actions : ifNode.elseActions) || [], childTrace, undefined, node.name);
        if (pass) childTrace.push(...skipChildren(ifNode.elseActions || [], c => skippedByBranch(c.name), ctx, node.name));

        const own = blockResult(result);
        const outputs = { conditionResult: pass, branchTaken: pass ? 'actions' : 'elseActions' };
        ctx.actions.set(node.name, { status: own.status, outputs });

        return {
          ...own,
          outputs,
          variables: { ...ctx.variables },
          _childTrace: childTrace,
          _childFailed: result.status === 'Failed',
        };
      } catch (err: any) {
        return {
          status: 'Failed',
          error: new Error(`Failed to evaluate condition: ${err.message}`),
          variables: { ...ctx.variables },
        };
      }
    }

    if (node.type === 'foreach') {
      const foreachNode = node as any;
      const itemsExpr = foreachNode.itemsExpression as string;

      let items: any;
      try {
        items = evalExpression(itemsExpr, ctx);
      } catch (err: any) {
        return {
          status: 'Failed',
          error: new Error(`Failed to evaluate foreach items: ${err.message}`),
          variables: { ...ctx.variables },
        };
      }
      const itemsArray = Array.isArray(items) ? items : [];
      const prev = ctx.variables[node.name];
      const iterations: IterationTraceEntry[] = [];
      // Each iteration's child records, by item index, for result().
      const iterationRecords: ScopedActionResult[][] = [];
      let terminateSignal: string | undefined;
      let runError: any;

      const prevIterationInfo = ctx.iterationInfo;
      const prevIterationStack = ctx.iterationStack ?? [];
      const concurrency = getForeachConcurrency(foreachNode);

      // Like the cloud, a failed iteration does not stop the loop: the others still run,
      // and the loop is Failed afterwards.
      if (concurrency === null) {
        // ── Sequential path ──
        for (let i = 0; i < itemsArray.length; i++) {
          ctx.variables[node.name] = itemsArray[i];
          const frame = { loopName: node.name, index: i, item: itemsArray[i] };
          ctx.iterationInfo = frame;
          ctx.iterationStack = [...(ctx.iterationStack ?? []).filter(f => f.loopName !== node.name), frame];
          const iterationActions: TraceEntry[] = [];
          const result = await runChildNodes(foreachNode.actions || [], iterationActions);
          iterationRecords[i] = result.records;
          iterations.push({
            index: i,
            item: itemsArray[i],
            status: result.status === 'Failed' ? 'Failed' : 'Succeeded',
            actions: iterationActions,
          });
          if (result.terminated) {
            terminateSignal = result.terminated;
            runError = result.runError;
            break;
          }
          if (result.stopped) break;
        }
      } else {
        // ── Parallel path ──
        const stopSignal: StopSignal = { stopped: false };

        const poolResults = await runWithConcurrency(
          itemsArray.map((item, index) => ({ item, index })),
          concurrency,
          async ({ item, index }) => {
            // Create per-iteration context with isolated variables and actions
            const frame: IterationFrame = { loopName: node.name, index, item };
            const iterCtx: RunContext = {
              ...ctx,
              variables: { ...ctx.variables, [node.name]: item },
              actions: new Map(ctx.actions),
              iterationInfo: frame,
              iterationStack: [...prevIterationStack, frame],
              // Per-iteration scopeResults so concurrent iterations don't race.
              scopeResults: new Map(ctx.scopeResults),
            };

            const iterationActions: TraceEntry[] = [];
            const result = await runChildNodes(foreachNode.actions || [], iterationActions, undefined, undefined, iterCtx);

            // Write variable mutations back to parent ctx (intentionally unsafe, matching PA behavior)
            for (const [key, value] of Object.entries(iterCtx.variables)) {
              if (key !== node.name) {
                ctx.variables[key] = value;
              }
            }

            if (result.stopped) stopSignal.stopped = true;
            if (result.terminated) {
              terminateSignal = result.terminated;
              runError = result.runError;
              stopSignal.stopped = true;
            }
            const status: StepResult['status'] = result.status === 'Failed' ? 'Failed' : 'Succeeded';
            return { status, actions: iterationActions, records: result.records };
          },
          stopSignal,
        );

        // Build iterations trace array in index order from pool results
        for (const pr of poolResults) {
          const idx = pr.index;
          const item = itemsArray[idx];
          if (pr.status === 'fulfilled' && pr.value) {
            iterations.push({ index: idx, item, status: pr.value.status, actions: pr.value.actions });
            iterationRecords[idx] = pr.value.records;
          } else if (pr.status === 'rejected') {
            iterations.push({ index: idx, item, status: 'Failed', actions: [] });
          } else {
            // not started: a debug stop or a terminate
            iterations.push({ index: idx, item, status: 'Skipped', actions: [] });
          }
        }
      }

      ctx.iterationInfo = prevIterationInfo;
      ctx.iterationStack = prevIterationStack;
      if (prev === undefined) delete ctx.variables[node.name]; else ctx.variables[node.name] = prev;

      ctx.scopeResults?.set(node.name, aggregateLoopRecords(iterationRecords));
      const status: StepResult['status'] = iterations.some(it => it.status === 'Failed') ? 'Failed' : 'Succeeded';
      const outputs = { itemCount: itemsArray.length };
      ctx.actions.set(node.name, { status, outputs });

      return {
        status,
        outputs,
        variables: { ...ctx.variables },
        iterations,
        ...(terminateSignal ? { status: 'Cancelled' as const, _terminate: terminateSignal, _runError: runError, ...SKIPPED_BY_TERMINATE } : {}),
      };
    }

    if (node.type === 'dountil') {
      const doUntilNode = node as any;
      const limit = doUntilNode.limit || 60;
      const iterations: IterationTraceEntry[] = [];
      let lastRecords: ScopedActionResult[] = [];
      let lastStatus: StepResult['status'] = 'Succeeded';
      let terminateSignal: string | undefined;
      let runError: any;

      const prevIterationInfo = ctx.iterationInfo;
      const prevIterationStack = ctx.iterationStack ?? [];
      const restore = () => {
        ctx.iterationInfo = prevIterationInfo;
        ctx.iterationStack = prevIterationStack;
      };

      // Like the cloud: the body runs before the first check, a failed iteration does not
      // stop the loop, the loop takes the status of its last iteration, and reaching the
      // count limit ends it without failing it.
      for (let index = 0; index < limit; index++) {
        const frame = { loopName: node.name, index };
        ctx.iterationInfo = frame;
        ctx.iterationStack = [...prevIterationStack, frame];

        const iterationActions: TraceEntry[] = [];
        const result = await runChildNodes(doUntilNode.actions || [], iterationActions);
        lastRecords = result.records;
        lastStatus = result.status === 'Failed' ? 'Failed' : 'Succeeded';

        if (result.terminated || result.stopped) {
          iterations.push({ index, status: lastStatus, actions: iterationActions });
          terminateSignal = result.terminated;
          runError = result.runError;
          break;
        }

        let conditionMet: boolean;
        try {
          conditionMet = Boolean(evalExpression(doUntilNode.condition, ctx));
        } catch (err: any) {
          iterations.push({ index, status: lastStatus, actions: iterationActions });
          restore();
          // The iteration that ran still shows in result(); the Until fails as a template error.
          ctx.scopeResults?.set(node.name, lastRecords.map(r => ({ ...r, repetitionCount: iterations.length })));
          const outcome = err instanceof ExpressionError || err?.name === 'ExpressionError' ? conditionInvalid(node.name, err.message) : {};
          return { status: 'Failed', error: err, ...outcome, variables: { ...ctx.variables }, iterations };
        }
        iterations.push({ index, conditionResult: conditionMet, status: lastStatus, actions: iterationActions });
        if (conditionMet) break;
      }
      restore();

      // result() of an Until lists the last iteration's children, each with the repetition count.
      ctx.scopeResults?.set(node.name, lastRecords.map(r => ({ ...r, repetitionCount: iterations.length })));
      const outputs = { iterations: iterations.length, conditionMet: iterations[iterations.length - 1]?.conditionResult ?? false };
      ctx.actions.set(node.name, { status: lastStatus, outputs });

      return {
        status: lastStatus,
        outputs,
        variables: { ...ctx.variables },
        iterations,
        ...(terminateSignal ? { status: 'Cancelled' as const, _terminate: terminateSignal, _runError: runError, ...SKIPPED_BY_TERMINATE } : {}),
      };
    }

    if (node.type === 'switch') {
      const switchNode = node as any;
      const switchExpression = switchNode.expression as string;
      const cases: any[] = switchNode.cases || [];
      const defaultActions: Node[] = switchNode.defaultActions || [];
      const branches: Node[][] = [...cases.map(c => c.actions || []), defaultActions];

      const exprValue = evalExpression(switchExpression, ctx);
      const allChildTrace: TraceEntry[] = [];
      ctx.scopeResults?.set(node.name, []);
      const valueType = typeName(exprValue);

      // The cloud switches on strings and integers only; anything else fails the Switch
      // and skips every branch.
      if (valueType !== 'String' && valueType !== 'Integer') {
        const outcome = switchValueInvalid(node.name, switchExpression, exprValue);
        for (const branch of branches) {
          allChildTrace.push(...skipChildren(branch, c => skippedByParent(c.name, node.name, 'Failed', outcome.code), ctx, node.name));
        }
        return {
          status: 'Failed',
          error: new Error(outcome.cloudError!.message),
          ...outcome,
          variables: { ...ctx.variables },
          _childTrace: allChildTrace,
        };
      }

      // Cases compare type-strictly (strongEquals): a case of another type makes every
      // branch action fail, and the Switch with them.
      // Case values are constants: '2' is the string, not the number (an '@' one is still evaluated).
      const caseValues = cases.map(c =>
        typeof c.value === 'string' && c.value.trim().startsWith('@') ? evalExpression(c.value, ctx) : c.value,
      );
      const mismatch = caseValues.find(v => typeName(v) !== valueType);
      if (mismatch !== undefined) {
        const records = ctx.scopeResults?.get(node.name);
        for (const child of branches.flat().filter(c => !isTriggerNode(c)) as any[]) {
          const outcome = switchCaseTypeMismatch(child.name, valueType, typeName(mismatch));
          const now = ctx.now().toISOString();
          const record: ActionOutput = {
            status: 'Failed',
            kind: nodeKind(child),
            ...outcome,
            startTime: now,
            endTime: now,
            trackingId: crypto.randomUUID(),
          };
          ctx.actions.set(child.name, record);
          records?.push({ name: child.name, ...record });
          const entry: TraceEntry = { nodeId: child.id, name: child.name, status: 'Failed', error: new Error(outcome.cloudError!.message) };
          const inner = childLists(child).flat();
          if (inner.length) {
            ctx.scopeResults?.set(child.name, []);
            entry.children = skipChildren(inner, c => skippedByParent(c.name, child.name, 'Failed', outcome.code), ctx, child.name);
          }
          allChildTrace.push(entry);
        }
        return { status: 'Failed', ...BLOCK_FAILED, variables: { ...ctx.variables }, _childTrace: allChildTrace };
      }

      const matchedIndex = caseValues.findIndex(v => v === exprValue);
      let result: ChildRunResult | undefined;
      for (let i = 0; i < cases.length; i++) {
        if (i === matchedIndex) result = await runChildNodes(cases[i].actions || [], allChildTrace, undefined, node.name);
        else allChildTrace.push(...skipChildren(cases[i].actions || [], c => skippedByBranch(c.name), ctx, node.name));
      }
      if (matchedIndex < 0) result = await runChildNodes(defaultActions, allChildTrace, undefined, node.name);
      else allChildTrace.push(...skipChildren(defaultActions, c => skippedByBranch(c.name), ctx, node.name));

      const own = blockResult(result!);
      const outputs = { matched: matchedIndex >= 0, matchedCase: cases[matchedIndex]?.name ?? null, value: exprValue };
      ctx.actions.set(node.name, { status: own.status, outputs });

      return {
        ...own,
        outputs,
        variables: { ...ctx.variables },
        _childTrace: allChildTrace,
        _childFailed: result!.status === 'Failed',
      };
    }

    // Fallback for unsupported node types
    return {
      status: 'Succeeded',
      outputs: { message: `Node type '${(node as any).type}' executed (no-op in step mode)` },
      variables: { ...ctx.variables },
    };
  } catch (error: any) {
    return {
      status: 'Failed',
      error,
      variables: { ...ctx.variables },
    };
  }
}

export const Engine = { run };
export { WorkflowLoader } from './workflow-loader.js';
export { requestTriggerOutputs, toTriggerOutputs, triggerRunInfo, triggerRecord, type TriggerRunInfo } from './trigger-outputs.js';
export type { WorkflowLoaderConfig } from './workflow-loader.js';
export { evalExpression, evaluateParams, navigatePath } from './expressions.js';
export { childFlowCallResult, type FlowResponse } from './child-flow.js';
export { httpInputsRecord, policyRecord, retryDelayMs } from './http-action.js';
