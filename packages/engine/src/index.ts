import type { FlowIR, TriggerNode, RecurrenceTriggerNode, ActionNode, StepResult, Node } from '@flowforger/ir';
import { evalExpression, evaluateParams, navigatePath } from './expressions.js';
import { runWithConcurrency, type StopSignal } from './concurrency.js';

export interface ActionOutput {
  status: StepResult['status'];
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

export interface ScopedActionResult {
  name: string;
  inputs?: any;
  outputs?: any;
  status: StepResult['status'];
  startTime?: string;
  endTime?: string;
  error?: any;
}

export interface RunContext {
  variables: Record<string, any>;
  actions: Map<string, ActionOutput>; // Track all action outputs
  triggerData?: any; // Store trigger input/output
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
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(event: object): void;
  secrets(name: string): string | undefined;
  connector<T extends BaseConnector>(name: string): T;
  loadChildFlow?: (workflowId: string) => Promise<FlowIR | null>; // Load child workflow by GUID
  /** Collected file artifacts from sentinel-tagged Compose actions (local debug aid). */
  artifacts?: FileArtifact[];
}

export interface BaseConnector {
  invoke(operation: string, inputs: any, ctx: RunContext): Promise<any>;
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
  outputs?: any;
  error?: any;
  iterations?: IterationTraceEntry[];
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

/**
 * If `value` is a sentinel file object (`@@ff:saveFile === true`) with valid
 * fields, return a normalized FileArtifact; otherwise null. Pure — no I/O.
 */
export function detectFileArtifact(value: any, actionName: string): FileArtifact | null {
  if (!value || typeof value !== 'object' || value['@@ff:saveFile'] !== true) return null;
  const { contentType, content } = value;
  if (typeof contentType !== 'string' || typeof content !== 'string') return null;
  const encoding = value.encoding === 'base64' ? 'base64' : 'utf8';
  const ext = CONTENT_TYPE_EXT[contentType] ?? 'bin';
  const fileName =
    typeof value.fileName === 'string' && value.fileName.length > 0
      ? value.fileName
      : `${actionName}.${ext}`;
  return { fileName, contentType, content, encoding };
}

/**
 * Recursively evaluate expressions in objects and arrays
 */
function deepEvalValue(value: any, ctx: RunContext): any {
  if (typeof value === 'string' && value.startsWith('@')) {
    return evalExpression(value, ctx);
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

  // Track action execution statuses by action name for runAfter evaluation
  const actionStatuses = new Map<string, StepResult['status']>();

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
    triggerData: input,
    workflowName: flow.name,
    parameters,
    iterationStack: [],
    scopeResults: new Map<string, ScopedActionResult[]>(),
    artifacts: [],
    callbackUrl: options.callbackUrl,
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
  actionStatuses.set(trigger.name, 'Succeeded');
  ctx.actions.set(trigger.name, { status: 'Succeeded', outputs: input });

  // Helper function to record action result
  function recordActionResult(name: string, status: StepResult['status'], outputs?: any, error?: any) {
    actionStatuses.set(name, status);
    ctx.actions.set(name, { status, outputs, error });
  }

  // Helper function to check if runAfter conditions are met
  function checkRunAfter(node: any): boolean {
    const runAfter = node.runAfter as Record<string, StepResult['status'][]> | undefined;

    // If no runAfter specified, action can run
    if (!runAfter || Object.keys(runAfter).length === 0) {
      return true;
    }

    // Check each dependency
    for (const [dependencyName, acceptedStatuses] of Object.entries(runAfter)) {
      const dependencyStatus = actionStatuses.get(dependencyName);

      // If dependency hasn't run yet, we can't execute
      if (!dependencyStatus) {
        return false;
      }

      // If dependency status is in accepted statuses, condition is met
      if (acceptedStatuses.includes(dependencyStatus)) {
        return true;
      }
    }

    // None of the dependencies matched the required statuses
    return false;
  }

  // Execute all nodes sequentially, delegating to executeNode for each
  for (const node of flow.nodes as any[]) {
    if (node.type === 'trigger' || node.type === 'recurrence') continue;

    // Check if runAfter conditions are met
    if (!checkRunAfter(node)) {
      trace.push({ nodeId: node.id, name: node.name, status: 'Skipped' });
      recordActionResult(node.name, 'Skipped');
      continue;
    }

    const result = await executeNode(node as Node, ctx, options);

    // For scope/if/switch, child trace entries should appear before the parent in the trace
    // This matches the original runNodes behavior where children were pushed to the same trace array
    if (result._childTrace) {
      for (const childEntry of result._childTrace) {
        trace.push(childEntry);
        // Also record child action results for runAfter tracking
        recordActionResult(childEntry.name, childEntry.status, childEntry.outputs, childEntry.error);
      }
    }

    // Build trace entry from executeNode result
    const entry: TraceEntry = {
      nodeId: node.id,
      name: node.name,
      status: result.status,
      outputs: result.outputs,
      error: result.error,
    };
    if (result.iterations) {
      entry.iterations = result.iterations;
    }
    trace.push(entry);

    // Record action result for runAfter tracking
    recordActionResult(node.name, result.status, result.outputs, result.error);

    // Check for terminate: if the result signals termination, stop processing
    if (result._terminate) {
      return { status: result._terminate as StepResult['status'], trace, artifacts: ctx.artifacts };
    }

    // Propagate failure (either direct failure or child failure within scope/if/switch)
    if (result.status === 'Failed' || result._childFailed) {
      return { status: 'Failed', trace, artifacts: ctx.artifacts };
    }
  }

  return { status: 'Succeeded', trace, artifacts: ctx.artifacts };
}

/**
 * Execute a single node with the given context.
 * This is the single source of truth for executing any node type.
 * Used by both run() for batch execution and directly for step-by-step debugging.
 */
export interface ExecuteNodeResult {
  status: StepResult['status'];
  outputs?: any;
  error?: any;
  variables: Record<string, any>;
  iterations?: IterationTraceEntry[];
  /** @internal Used by run() to detect terminate actions */
  _terminate?: string;
  /** @internal Child trace entries for scope/if/switch that should be flattened into parent trace */
  _childTrace?: TraceEntry[];
  /** @internal Indicates a child node failed, requiring failure propagation even when this node's status is 'Succeeded' */
  _childFailed?: boolean;
}

export async function executeNode(
  node: Node,
  ctx: RunContext,
  options: RunOptions = {}
): Promise<ExecuteNodeResult> {
  const { connectors = {} } = options;

  /**
   * Run an array of child nodes sequentially, calling executeNode recursively.
   * Supports debug hooks, runAfter checking, and trace recording.
   * Returns the overall status and a trace of all child executions.
   */
  async function runChildNodes(
    childNodes: Node[],
    childTrace: TraceEntry[],
    childActionStatuses?: Map<string, StepResult['status']>,
    parentScopeName?: string,
  ): Promise<{ status: StepResult['status']; terminated?: string }> {
    const statuses = childActionStatuses || new Map<string, StepResult['status']>();
    // Collector for `result(scopedActionName)` lookup. Only top-level direct
    // children of the scope are recorded — nested scope's children belong to
    // their own collector, not this one.
    const recordChildResult = (name: string, r: ScopedActionResult) => {
      if (!parentScopeName || !ctx.scopeResults) return;
      const arr = ctx.scopeResults.get(parentScopeName) ?? [];
      arr.push(r);
      ctx.scopeResults.set(parentScopeName, arr);
    };

    for (const childNode of childNodes as any[]) {
      if (childNode.type === 'trigger' || childNode.type === 'recurrence') continue;

      // Check runAfter for child nodes
      const runAfter = childNode.runAfter as Record<string, StepResult['status'][]> | undefined;
      if (runAfter && Object.keys(runAfter).length > 0) {
        let canRun = false;
        for (const [depName, acceptedStatuses] of Object.entries(runAfter)) {
          const depStatus = statuses.get(depName) || (ctx.actions.get(depName)?.status);
          if (depStatus && acceptedStatuses.includes(depStatus)) {
            canRun = true;
            break;
          }
        }
        if (!canRun) {
          childTrace.push({ nodeId: childNode.id, name: childNode.name, status: 'Skipped' });
          statuses.set(childNode.name, 'Skipped');
          ctx.actions.set(childNode.name, { status: 'Skipped' });
          recordChildResult(childNode.name, { name: childNode.name, status: 'Skipped' });
          continue;
        }
      }

      // Call debug hook before child execution
      if (options.onBeforeChildExecute) {
        const action = await options.onBeforeChildExecute(childNode as Node, ctx);
        if (action === 'stop') {
          return { status: 'Failed' };
        }
      }

      try {
        const childResult = await executeNode(childNode as Node, ctx, options);

        // Record in ctx.actions
        ctx.actions.set(childNode.name, {
          status: childResult.status,
          outputs: childResult.outputs,
          error: childResult.error,
        });
        statuses.set(childNode.name, childResult.status);
        recordChildResult(childNode.name, {
          name: childNode.name,
          outputs: childResult.outputs,
          status: childResult.status,
          error: childResult.error,
        });

        // Merge variables back
        ctx.variables = { ...ctx.variables, ...childResult.variables };

        // For scope/if/switch children, flatten their child trace entries before the parent entry
        if (childResult._childTrace) {
          for (const nestedEntry of childResult._childTrace) {
            childTrace.push(nestedEntry);
            statuses.set(nestedEntry.name, nestedEntry.status);
          }
        }

        // Build trace entry
        const entry: TraceEntry = {
          nodeId: childNode.id,
          name: childNode.name,
          status: childResult.status,
          outputs: childResult.outputs,
          error: childResult.error,
        };
        if (childResult.iterations) {
          entry.iterations = childResult.iterations;
        }
        childTrace.push(entry);

        // Call debug hook after child execution
        if (options.onAfterChildExecute) {
          await options.onAfterChildExecute(childNode as Node, childResult, ctx);
        }

        // Handle terminate propagation
        if (childResult._terminate) {
          return { status: childResult.status, terminated: childResult._terminate };
        }

        // Check for child failure propagation (scope/if/switch with failed children)
        if (childResult._childFailed) {
          return { status: 'Failed' };
        }

        if (childResult.status === 'Failed') {
          return { status: 'Failed' };
        }
      } catch (err: any) {
        childTrace.push({
          nodeId: childNode.id,
          name: childNode.name,
          status: 'Failed',
          error: err,
        });
        statuses.set(childNode.name, 'Failed');
        ctx.actions.set(childNode.name, { status: 'Failed', error: err });
        recordChildResult(childNode.name, { name: childNode.name, status: 'Failed', error: err });
        return { status: 'Failed' };
      }
    }
    return { status: 'Succeeded' };
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

        // Support retry policies
        let attempts = 0;
        const policy = action.retryPolicy || { type: 'none' as const };
        const max = policy.type === 'none' ? 1 : (policy.count ?? 3);
        while (attempts < max) {
          try {
            // Evaluate expressions in inputs (e.g. template strings with parameters, variables, etc.)
            const evaluatedInputs = evaluateParams(action.inputs, ctx);
            // HTTP connector returns { statusCode, headers, body } which matches Power Automate's outputs() structure
            const outputs = await http.invoke('request', evaluatedInputs, ctx);
            return {
              status: 'Succeeded',
              outputs,
              variables: { ...ctx.variables },
            };
          } catch (err: any) {
            attempts++;
            if (attempts >= max) {
              return {
                status: 'Failed',
                error: err,
                variables: { ...ctx.variables },
              };
            }
            if (policy.type === 'fixed') {
              await ctx.sleep(policy.interval ?? 500);
            } else if (policy.type === 'exponential') {
              const base = policy.interval ?? 250;
              const delay = base * Math.pow(2, attempts - 1);
              await ctx.sleep(delay);
            }
          }
        }
        // Should not reach here, but just in case
        return {
          status: 'Failed',
          error: new Error('HTTP request failed after retries'),
          variables: { ...ctx.variables },
        };
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
        const value = typeof inputs.value === 'string' && inputs.value.startsWith('@')
          ? evalExpression(inputs.value, ctx)
          : inputs.value;
        ctx.variables[inputs.variableName] = value;
        return {
          status: 'Succeeded',
          outputs: value,
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'setvariable') {
        const inputs = action.inputs as any;
        const value = typeof inputs.value === 'string' && inputs.value.startsWith('@')
          ? evalExpression(inputs.value, ctx)
          : inputs.value;
        ctx.variables[inputs.name] = value;
        return {
          status: 'Succeeded',
          outputs: value,
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
        ctx.variables[inputs.name].push(value);
        return {
          status: 'Succeeded',
          outputs: ctx.variables[inputs.name],
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'appendtostringvariable') {
        const inputs = action.inputs as any;
        // Use deepEvalValue to recursively evaluate expressions in objects/arrays
        const value = deepEvalValue(inputs.value, ctx);
        // Logic Apps implicitly coerces non-string values to JSON strings
        const stringValue = (typeof value === 'object' && value !== null) ? JSON.stringify(value) : String(value);
        ctx.variables[inputs.name] = (ctx.variables[inputs.name] || '') + stringValue;
        return {
          status: 'Succeeded',
          outputs: ctx.variables[inputs.name],
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'join') {
        const inputs = action.inputs as any;
        const from = typeof inputs.from === 'string' && inputs.from.startsWith('@')
          ? evalExpression(inputs.from, ctx)
          : inputs.from;
        const joinWith = inputs.joinWith || ',';
        const result = Array.isArray(from) ? from.join(joinWith) : '';
        return {
          status: 'Succeeded',
          outputs: result,
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'select') {
        const inputs = action.inputs as any;
        const from = typeof inputs.from === 'string' && inputs.from.startsWith('@')
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
            mapped = selectMap.startsWith('@') ? evalExpression(selectMap, ctx) : selectMap;
          } else {
            mapped = {};
            for (const [key, expr] of Object.entries(selectMap ?? {})) {
              mapped[key] = typeof expr === 'string' && (expr as string).startsWith('@')
                ? evalExpression(expr as string, ctx)
                : expr;
            }
          }
          if (prev === undefined) delete ctx.variables['item']; else ctx.variables['item'] = prev;
          return mapped;
        }) : [];
        return {
          status: 'Succeeded',
          outputs: result,
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'filterarray') {
        const inputs = action.inputs as any;
        const from = typeof inputs.from === 'string' && inputs.from.startsWith('@')
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
          outputs: result,
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'parsejson') {
        const inputs = action.inputs as any;
        const content = typeof inputs.from === 'string' && inputs.from.startsWith('@')
          ? evalExpression(inputs.from, ctx)
          : inputs.from;
        try {
          const parsed = typeof content === 'string' ? JSON.parse(content) : content;
          return {
            status: 'Succeeded',
            outputs: parsed,
            variables: { ...ctx.variables },
          };
        } catch (err) {
          return {
            status: 'Failed',
            error: err,
            variables: { ...ctx.variables },
          };
        }
      } else if (action.kind === 'createcsvtable') {
        const inputs = action.inputs as any;
        const from = typeof inputs.from === 'string' && inputs.from.startsWith('@')
          ? evalExpression(inputs.from, ctx)
          : inputs.from;
        const columns = inputs.columns;
        let csvResult = '';
        if (Array.isArray(from) && from.length > 0) {
          if (columns) {
            // Custom columns
            const headers = columns.map((c: any) => c.header).join(',');
            csvResult = headers + '\n';
            from.forEach(item => {
              const prev = ctx.variables['item'];
              ctx.variables['item'] = item;
              const values = columns.map((c: any) => {
                const val = typeof c.value === 'string' && c.value.startsWith('@')
                  ? evalExpression(c.value, ctx)
                  : c.value;
                return JSON.stringify(val);
              });
              csvResult += values.join(',') + '\n';
              if (prev === undefined) delete ctx.variables['item']; else ctx.variables['item'] = prev;
            });
          } else {
            // Auto-generate from object keys
            const keys = Object.keys(from[0]);
            csvResult = keys.join(',') + '\n';
            from.forEach(item => {
              const values = keys.map(k => JSON.stringify(item[k]));
              csvResult += values.join(',') + '\n';
            });
          }
        }
        return {
          status: 'Succeeded',
          outputs: csvResult,
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'createhtmltable') {
        const inputs = action.inputs as any;
        const from = typeof inputs.from === 'string' && inputs.from.startsWith('@')
          ? evalExpression(inputs.from, ctx)
          : inputs.from;
        const columns = inputs.columns;
        let htmlResult = '<table>';
        if (Array.isArray(from) && from.length > 0) {
          if (columns) {
            // Custom columns
            htmlResult += '<thead><tr>';
            columns.forEach((c: any) => { htmlResult += `<th>${c.header}</th>`; });
            htmlResult += '</tr></thead><tbody>';
            from.forEach(item => {
              const prev = ctx.variables['item'];
              ctx.variables['item'] = item;
              htmlResult += '<tr>';
              columns.forEach((c: any) => {
                const val = typeof c.value === 'string' && c.value.startsWith('@')
                  ? evalExpression(c.value, ctx)
                  : c.value;
                htmlResult += `<td>${val}</td>`;
              });
              htmlResult += '</tr>';
              if (prev === undefined) delete ctx.variables['item']; else ctx.variables['item'] = prev;
            });
            htmlResult += '</tbody>';
          } else {
            // Auto-generate from object keys
            const keys = Object.keys(from[0]);
            htmlResult += '<thead><tr>';
            keys.forEach(k => { htmlResult += `<th>${k}</th>`; });
            htmlResult += '</tr></thead><tbody>';
            from.forEach(item => {
              htmlResult += '<tr>';
              keys.forEach(k => { htmlResult += `<td>${item[k]}</td>`; });
              htmlResult += '</tr>';
            });
            htmlResult += '</tbody>';
          }
        }
        htmlResult += '</table>';
        return {
          status: 'Succeeded',
          outputs: htmlResult,
          variables: { ...ctx.variables },
        };
      } else if (action.kind === 'response') {
        const inputs = action.inputs as any;
        const statusCode = inputs.statusCode || 200;
        // Evaluate expressions in the body (supports objects, arrays, and strings)
        const body = deepEvalValue(inputs.body, ctx);
        const headers = inputs.headers || {};
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
        const runError = inputs.runError;
        const terminateStatus = (runStatus === 'Failed' ? 'Failed' : 'Succeeded') as StepResult['status'];
        return {
          status: terminateStatus,
          outputs: undefined,
          error: runError,
          variables: { ...ctx.variables },
          _terminate: runStatus === 'Failed' ? 'Failed' : 'Succeeded',
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
        const until = typeof inputs.until === 'string' && inputs.until.startsWith('@')
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
        // Handle child workflow calls
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

        // Evaluate body if it contains expressions
        let body = inputs.body;
        if (body && typeof body === 'object') {
          const evaluatedBody: any = {};
          for (const [key, value] of Object.entries(body)) {
            evaluatedBody[key] = typeof value === 'string' && value.startsWith('@')
              ? evalExpression(value, ctx)
              : value;
          }
          body = evaluatedBody;
        }

        // Allow debug runner to intercept workflow execution
        if (options.onBeforeWorkflowExecute) {
          const hookResult = await options.onBeforeWorkflowExecute(action, workflowRef, body);
          if (hookResult.handled) {
            return hookResult.result;
          }
        }

        // Try to load and execute child workflow
        if (ctx.loadChildFlow) {
          try {
            const childFlow = await ctx.loadChildFlow(workflowRef);

            if (childFlow) {
              // Execute child workflow with isolated context
              const childResult = await run(childFlow, {
                input: body,
                connectors: options.connectors,
                logger: options.logger,
                secrets: options.secrets,
                variables: {}, // Isolated variables
                loadChildFlow: ctx.loadChildFlow, // Support nested child flows
                strictWorkflows: options.strictWorkflows,
              });

              // Get the body from the last action of the child workflow
              const childFlowBody = childResult.trace[childResult.trace.length - 1]?.outputs;

              // For trace, include full result with metadata
              const traceResult = {
                workflowReferenceName: workflowRef,
                childWorkflowName: childFlow.name,
                status: childResult.status,
                body: childFlowBody,
              };

              // Store just the body as action outputs to match Power Automate behavior
              // So body('WorkflowAction') returns the child flow's response directly
              ctx.actions.set(action.name, { status: childResult.status, outputs: childFlowBody });

              // If child workflow failed, propagate failure
              if (childResult.status === 'Failed') {
                if (options.strictWorkflows) {
                  throw new Error(`Child workflow '${childFlow.name}' failed`);
                }
              }

              return {
                status: childResult.status,
                outputs: traceResult,
                variables: { ...ctx.variables },
              };
            } else {
              // Child workflow not found
              if (options.strictWorkflows) {
                throw new Error(`Child workflow not found: ${workflowRef}`);
              }

              // Fall back to mock behavior in non-strict mode
              const result = {
                workflowReferenceName: workflowRef,
                body,
                status: 'Called (not found)',
                warning: 'Child workflow not found, strict mode disabled'
              };

              ctx.actions.set(action.name, { status: 'Succeeded', outputs: result });

              return {
                status: 'Succeeded',
                outputs: result,
                variables: { ...ctx.variables },
              };
            }
          } catch (error) {
            // Error loading or executing child workflow
            if (options.strictWorkflows) {
              throw error;
            }

            // Log error and continue in non-strict mode
            const result = {
              workflowReferenceName: workflowRef,
              body,
              status: 'Failed',
              error: error instanceof Error ? error.message : String(error)
            };

            return {
              status: 'Failed',
              outputs: result,
              error,
              variables: { ...ctx.variables },
            };
          }
        } else {
          // No child flow loader provided - fall back to placeholder behavior
          const result = {
            workflowReferenceName: workflowRef,
            body,
            status: 'Called (mock)'
          };

          ctx.actions.set(action.name, { status: 'Succeeded', outputs: result });

          return {
            status: 'Succeeded',
            outputs: result,
            variables: { ...ctx.variables },
          };
        }
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

      try {
        // Evaluate expressions in parameters before invoking
        const evaluatedParams = evaluateParams(connAction.params, ctx);
        const rawOutput = await conn.invoke(connAction.operation, evaluatedParams, ctx);
        // For webcontents connector and SharePoint HTTP requests, return the output directly without wrapping
        // (these already return structured responses with statusCode, headers, body)
        // For other connectors, wrap in 'body' property to match Power Automate behavior
        const isHttpRequest = connectorName === 'sharepoint' && (connAction.operation === 'SendHttpRequest' || connAction.operation === 'HttpRequest');
        const outputs = (connectorName === 'webcontents' || isHttpRequest) ? rawOutput : { body: rawOutput };
        ctx.actions.set(connAction.name, { status: 'Succeeded', outputs });
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
      const result = await runChildNodes(scopeNode.actions || [], childTrace, undefined, node.name);

      // Scope itself always records as 'Succeeded', but propagates child failure
      ctx.actions.set(node.name, { status: 'Succeeded', outputs: { scopeStatus: result.status } });

      return {
        status: 'Succeeded',
        outputs: { scopeStatus: result.status },
        variables: { ...ctx.variables },
        _terminate: result.terminated,
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

        let nestedStatus: StepResult['status'] = 'Succeeded';
        let terminateSignal: string | undefined;
        const childTrace: TraceEntry[] = [];

        if (pass) {
          const result = await runChildNodes(ifNode.actions || [], childTrace, undefined, node.name);
          nestedStatus = result.status;
          terminateSignal = result.terminated;
        } else if (ifNode.elseActions) {
          const result = await runChildNodes(ifNode.elseActions || [], childTrace, undefined, node.name);
          nestedStatus = result.status;
          terminateSignal = result.terminated;
        }

        const outputs = { conditionResult: pass, branchTaken: pass ? 'actions' : 'elseActions' };
        ctx.actions.set(node.name, { status: 'Succeeded', outputs });

        return {
          status: 'Succeeded',
          outputs,
          variables: { ...ctx.variables },
          _terminate: terminateSignal,
          _childTrace: childTrace,
          _childFailed: nestedStatus === 'Failed',
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

      try {
        const items = evalExpression(itemsExpr, ctx);
        const itemsArray = Array.isArray(items) ? items : [];
        const prev = ctx.variables[node.name];
        let overallStatus: StepResult['status'] = 'Succeeded';
        const iterations: IterationTraceEntry[] = [];
        let terminateSignal: string | undefined;

        const prevIterationInfo = ctx.iterationInfo;
        const prevIterationStack = ctx.iterationStack ?? [];
        const concurrency = getForeachConcurrency(foreachNode);

        if (concurrency === null) {
          // ── Sequential path ──
          for (let i = 0; i < itemsArray.length; i++) {
            ctx.variables[node.name] = itemsArray[i];
            const frame = { loopName: node.name, index: i, item: itemsArray[i] };
            ctx.iterationInfo = frame;
            ctx.iterationStack = [...(ctx.iterationStack ?? []).filter(f => f.loopName !== node.name), frame];
            const iterationActions: TraceEntry[] = [];
            const result = await runChildNodes(foreachNode.actions || [], iterationActions, undefined, node.name);

            const iterStatus: StepResult['status'] = result.status === 'Failed' ? 'Failed' : 'Succeeded';
            iterations.push({
              index: i,
              item: itemsArray[i],
              status: iterStatus,
              actions: iterationActions,
            });

            if (result.terminated) {
              terminateSignal = result.terminated;
              break;
            }
            if (result.status === 'Failed') {
              overallStatus = 'Failed';
              break;
            }
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
                // Per-iteration scopeResults so concurrent iterations don't race;
                // results are not aggregated back into the parent scope's collector
                // for parallel foreach (matches PA: result() on parallel foreach is
                // documented as undefined for concurrent iterations).
                scopeResults: new Map(ctx.scopeResults),
              };

              const iterationActions: TraceEntry[] = [];
              let iterStatus: StepResult['status'] = 'Succeeded';
              let iterTerminated: string | undefined;
              const childNodes = (foreachNode.actions || []) as any[];

              for (const childNode of childNodes) {
                if (childNode.type === 'trigger' || childNode.type === 'recurrence') continue;

                // Check runAfter for child nodes
                const runAfter = childNode.runAfter as Record<string, StepResult['status'][]> | undefined;
                if (runAfter && Object.keys(runAfter).length > 0) {
                  let canRun = false;
                  for (const [depName, acceptedStatuses] of Object.entries(runAfter)) {
                    const depStatus = iterCtx.actions.get(depName)?.status;
                    if (depStatus && acceptedStatuses.includes(depStatus)) {
                      canRun = true;
                      break;
                    }
                  }
                  if (!canRun) {
                    iterationActions.push({ nodeId: childNode.id, name: childNode.name, status: 'Skipped' });
                    iterCtx.actions.set(childNode.name, { status: 'Skipped' });
                    continue;
                  }
                }

                // Call debug hook before child execution
                if (options.onBeforeChildExecute) {
                  const action = await options.onBeforeChildExecute(childNode as Node, iterCtx);
                  if (action === 'stop') {
                    iterStatus = 'Failed';
                    stopSignal.stopped = true;
                    break;
                  }
                }

                try {
                  const childResult = await executeNode(childNode as Node, iterCtx, options);

                  // Record in iteration context
                  iterCtx.actions.set(childNode.name, {
                    status: childResult.status,
                    outputs: childResult.outputs,
                    error: childResult.error,
                  });

                  // Merge child variables back into iteration context
                  iterCtx.variables = { ...iterCtx.variables, ...childResult.variables };

                  // For scope/if/switch children, flatten their child trace entries
                  // and register in iterCtx.actions for runAfter resolution
                  if (childResult._childTrace) {
                    for (const nestedEntry of childResult._childTrace) {
                      iterationActions.push(nestedEntry);
                      iterCtx.actions.set(nestedEntry.name, {
                        status: nestedEntry.status,
                        outputs: nestedEntry.outputs,
                        error: nestedEntry.error,
                      });
                    }
                  }

                  // Build trace entry
                  const entry: TraceEntry = {
                    nodeId: childNode.id,
                    name: childNode.name,
                    status: childResult.status,
                    outputs: childResult.outputs,
                    error: childResult.error,
                  };
                  if (childResult.iterations) {
                    entry.iterations = childResult.iterations;
                  }
                  iterationActions.push(entry);

                  // Call debug hook after child execution
                  if (options.onAfterChildExecute) {
                    await options.onAfterChildExecute(childNode as Node, childResult, iterCtx);
                  }

                  // Handle terminate propagation
                  if (childResult._terminate) {
                    iterTerminated = childResult._terminate;
                    break;
                  }

                  // Check for child failure propagation
                  if (childResult._childFailed || childResult.status === 'Failed') {
                    iterStatus = 'Failed';
                    break;
                  }
                } catch (err: any) {
                  iterationActions.push({
                    nodeId: childNode.id,
                    name: childNode.name,
                    status: 'Failed',
                    error: err,
                  });
                  iterCtx.actions.set(childNode.name, { status: 'Failed', error: err });
                  iterStatus = 'Failed';
                  break;
                }
              }

              // Write variable mutations back to parent ctx (intentionally unsafe, matching PA behavior)
              for (const [key, value] of Object.entries(iterCtx.variables)) {
                if (key !== node.name) {
                  ctx.variables[key] = value;
                }
              }

              if (iterTerminated) {
                terminateSignal = iterTerminated;
                stopSignal.stopped = true;
              }

              const iterResult = { status: iterStatus, actions: iterationActions, terminated: iterTerminated };

              // If the iteration failed, throw so runWithConcurrency detects it
              // and stops launching new items. Attach the trace data to the error.
              if (iterStatus === 'Failed') {
                const err: any = new Error('Iteration failed');
                err._iterResult = iterResult;
                throw err;
              }

              return iterResult;
            },
            stopSignal,
          );

          // Build iterations trace array in index order from pool results
          for (const pr of poolResults) {
            const idx = pr.index;
            const item = itemsArray[idx];
            if (pr.status === 'fulfilled' && pr.value) {
              iterations.push({
                index: idx,
                item,
                status: pr.value.status,
                actions: pr.value.actions,
              });
              if (pr.value.status === 'Failed') {
                overallStatus = 'Failed';
              }
            } else if (pr.status === 'rejected') {
              // Check if the error carries iteration trace data
              const iterResult = pr.error?._iterResult;
              iterations.push({
                index: idx,
                item,
                status: iterResult?.status ?? 'Failed',
                actions: iterResult?.actions ?? [],
              });
              overallStatus = 'Failed';
            } else {
              // skipped
              iterations.push({
                index: idx,
                item,
                status: 'Skipped',
                actions: [],
              });
            }
          }

          // If any iteration failed, overall is Failed
          if (iterations.some(it => it.status === 'Failed')) {
            overallStatus = 'Failed';
          }
        }

        ctx.iterationInfo = prevIterationInfo;
        ctx.iterationStack = prevIterationStack;
        if (prev === undefined) delete ctx.variables[node.name]; else ctx.variables[node.name] = prev;

        ctx.actions.set(node.name, {
          status: overallStatus,
          outputs: { itemCount: itemsArray.length },
        });

        return {
          status: overallStatus,
          outputs: { itemCount: itemsArray.length },
          variables: { ...ctx.variables },
          iterations,
          _terminate: terminateSignal,
        };
      } catch (err: any) {
        return {
          status: 'Failed',
          error: new Error(`Failed to evaluate foreach items: ${err.message}`),
          variables: { ...ctx.variables },
        };
      }
    }

    if (node.type === 'dountil') {
      const doUntilNode = node as any;
      const limit = doUntilNode.limit || 60;
      let iterationCount = 0;
      let overallStatus: StepResult['status'] = 'Succeeded';
      const iterations: IterationTraceEntry[] = [];
      let terminateSignal: string | undefined;

      const prevIterationInfo = ctx.iterationInfo;
      const prevIterationStack = ctx.iterationStack ?? [];

      while (iterationCount < limit) {
        const frame = { loopName: node.name, index: iterationCount };
        ctx.iterationInfo = frame;
        ctx.iterationStack = [...prevIterationStack, frame];

        const iterationActions: TraceEntry[] = [];
        const result = await runChildNodes(doUntilNode.actions || [], iterationActions, undefined, node.name);

        if (result.terminated) {
          iterations.push({
            index: iterationCount,
            status: 'Succeeded',
            actions: iterationActions,
          });
          terminateSignal = result.terminated;
          break;
        }

        if (result.status === 'Failed') {
          iterations.push({
            index: iterationCount,
            status: 'Failed',
            actions: iterationActions,
          });
          overallStatus = 'Failed';
          break;
        }

        const conditionMet = Boolean(evalExpression(doUntilNode.condition, ctx));
        iterations.push({
          index: iterationCount,
          conditionResult: conditionMet,
          status: 'Succeeded',
          actions: iterationActions,
        });

        iterationCount++;

        if (conditionMet) {
          break;
        }

        if (iterationCount >= limit) {
          const error = new Error(`Do-until loop exceeded limit of ${limit} iterations`);
          ctx.iterationInfo = prevIterationInfo;
          ctx.iterationStack = prevIterationStack;
          ctx.actions.set(node.name, {
            status: 'Failed',
            error,
          });
          return {
            status: 'Failed',
            error,
            variables: { ...ctx.variables },
            iterations,
          };
        }
      }

      ctx.iterationInfo = prevIterationInfo;
      ctx.iterationStack = prevIterationStack;

      ctx.actions.set(node.name, {
        status: overallStatus,
        outputs: { iterations: iterationCount, conditionMet: iterations[iterations.length - 1]?.conditionResult ?? false },
      });

      return {
        status: overallStatus,
        outputs: { iterations: iterationCount, conditionMet: iterations[iterations.length - 1]?.conditionResult ?? false },
        variables: { ...ctx.variables },
        iterations,
        _terminate: terminateSignal,
      };
    }

    if (node.type === 'switch') {
      const switchNode = node as any;
      const switchExpression = switchNode.expression as string;

      try {
        const exprValue = evalExpression(switchExpression, ctx);
        let matched = false;
        let matchedCaseName: string | null = null;
        let nestedStatus: StepResult['status'] = 'Succeeded';
        let terminateSignal: string | undefined;
        const allChildTrace: TraceEntry[] = [];

        // Helper to mark all actions in a case as skipped (with trace entries)
        const markActionsAsSkipped = (actions: Node[]) => {
          for (const a of actions) {
            allChildTrace.push({ nodeId: a.id, name: a.name, status: 'Skipped', outputs: undefined });
            ctx.actions.set(a.name, { status: 'Skipped' });
            // Handle nested actions recursively
            if ('actions' in a && Array.isArray((a as any).actions)) {
              markActionsAsSkipped((a as any).actions);
            }
            if ('elseActions' in a && Array.isArray((a as any).elseActions)) {
              markActionsAsSkipped((a as any).elseActions);
            }
          }
        };

        for (const switchCase of switchNode.cases || []) {
          const caseValue = evalExpression(switchCase.value, ctx);
          if (exprValue === caseValue) {
            matched = true;
            matchedCaseName = switchCase.name;
            const result = await runChildNodes(switchCase.actions || [], allChildTrace, undefined, node.name);
            nestedStatus = result.status;
            if (result.terminated) {
              terminateSignal = result.terminated;
            }
          }
        }

        // Mark non-matching case actions as skipped
        for (const switchCase of switchNode.cases || []) {
          if (switchCase.name !== matchedCaseName && switchCase.actions) {
            markActionsAsSkipped(switchCase.actions);
          }
        }

        // Handle default actions
        if (!matched && switchNode.defaultActions) {
          const result = await runChildNodes(switchNode.defaultActions, allChildTrace, undefined, node.name);
          nestedStatus = result.status;
          if (result.terminated) {
            terminateSignal = result.terminated;
          }
        } else if (matched && switchNode.defaultActions) {
          // Mark default actions as skipped if a case matched
          markActionsAsSkipped(switchNode.defaultActions);
        }

        const outputs = { matched, matchedCase: matchedCaseName, value: exprValue };
        ctx.actions.set(node.name, { status: 'Succeeded', outputs });

        return {
          status: 'Succeeded',
          outputs,
          variables: { ...ctx.variables },
          _terminate: terminateSignal,
          _childTrace: allChildTrace,
          _childFailed: nestedStatus === 'Failed',
        };
      } catch (err: any) {
        return {
          status: 'Failed',
          error: new Error(`Failed to evaluate switch expression: ${err.message}`),
          variables: { ...ctx.variables },
        };
      }
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
export type { WorkflowLoaderConfig } from './workflow-loader.js';
export { evalExpression, evaluateParams, navigatePath } from './expressions.js';
