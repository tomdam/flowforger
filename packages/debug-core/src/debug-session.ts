/**
 * FlowForger Debug Session (host-agnostic core)
 *
 * Manages step-by-step flow execution with breakpoints and pause/resume.
 * Supports child flow debugging via a call stack of DebugFrames.
 * Host specifics (file access, child flow resolution, connectors) are
 * injected via DebugHost and the connectors record.
 */

import type { FlowIR, Node, ActionNode } from '@flowforger/ir';
import type { RunContext, ExecuteNodeResult, ActionOutput, BaseConnector } from '@flowforger/engine';
import { executeNode, evalExpression, run as runEngine } from '@flowforger/engine';
import { buildExpressionScope, evaluateDebugInput } from '@flowforger/dsl-native';
import type { DslSourceMap, ExpressionScope } from '@flowforger/dsl-native';
import type { DebugFlowSource, DebugHost } from './host.js';
import { computeContinuationSet, collectInlinedDescendantIds } from './jump.js';

export type ResumeAction = 'step' | 'continue' | 'stop' | 'jump';

/** Result of a set-next-statement request. `resetNodeIds` = the continuation set (nodes that may now re-execute). */
export type JumpResult =
  | { ok: true; resetNodeIds: string[] }
  | { ok: false; error: string };

export interface DebugCallbacks {
  onStopped: (reason: string, nodeId: string) => void;
  onOutput: (text: string, category: string) => void;
  onTerminated: () => void;
  /**
   * Fired after each node executes (top-level and nested children), with the
   * engine result and the key of the frame it ran in. Not fired for nodes the
   * engine skipped (non-taken branches). Optional — the DAP adapter ignores it;
   * the web driver uses it to maintain its ExecutionTrace.
   */
  onNodeExecuted?: (node: Node, result: ExecuteNodeResult, frameKey: string) => void;
}

export interface DebugSessionOptions {
  /**
   * Consulted before every node execution (top-level and nested children).
   * Return true to pause before the node runs (reason 'step').
   * Used by the fast-forward controller for edit-and-continue.
   */
  shouldPauseBefore?: (node: Node) => boolean;
  /** When returning true, breakpoint-triggered pauses are disabled (fast-forward). */
  suppressBreakpoints?: () => boolean;
}

export interface IterationContextInfo {
  parentNodeId: string;
  parentNodeName: string;
  iterationIndex: number;
  totalIterations: number;
}

interface FlattenedStep {
  node: Node;
}

/**
 * A debug frame represents one level in the child flow call stack.
 * Each frame has its own source (IR + optional source map/DSL), context,
 * and step list.
 */
export interface DebugFrame {
  source: DebugFlowSource;
  ctx: RunContext;
  steps: FlattenedStep[];
  /** Breakpoints for this frame's source: nodeId -> line */
  breakpoints: Map<string, number>;
  /** The node ID in the parent flow that triggered this child flow */
  callerNodeId?: string;
}

const COMPOSE_LOG_MAX_LEN = 500;

function formatComposeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  let str: string;
  if (typeof value === 'string') {
    str = value;
  } else {
    try {
      str = JSON.stringify(value, null, 2);
    } catch {
      str = String(value);
    }
  }
  if (str.length > COMPOSE_LOG_MAX_LEN) {
    const remaining = str.length - COMPOSE_LOG_MAX_LEN;
    return `${str.substring(0, COMPOSE_LOG_MAX_LEN)}… (${remaining} more chars — inspect via Variables panel)`;
  }
  return str;
}

export class DebugSession {
  private root: DebugFlowSource;
  private host: DebugHost;
  private triggerPayload: any;
  private stopOnEntry: boolean;
  private callbacks: DebugCallbacks;
  private options?: DebugSessionOptions;

  // Execution state
  private ctx: RunContext;
  private connectors: Record<string, BaseConnector>;
  private parameterOverrides: Record<string, any>;
  private steps: FlattenedStep[] = [];
  private isRunning = false;
  private isStopped = false;

  // Call stack for child flow debugging
  private callStack: DebugFrame[] = [];

  // Breakpoints per source (normalized key -> Map<nodeId, line>)
  private breakpointsPerKey = new Map<string, Map<string, number>>();

  // Pause/resume
  private resumeResolver: ((action: ResumeAction) => void) | null = null;
  // Serializes pause/resume cycles across concurrent execution lanes (parallel
  // foreach): resumeResolver is a single slot, so a pause may only begin once
  // the previous one has fully resumed. Lanes queue on this promise chain; a
  // lane that acquires the gate after stop() re-checks isStopped and never
  // pauses, so no lane can be stranded on an overwritten resolver.
  private pauseGate: Promise<void> = Promise.resolve();
  private steppingMode: ResumeAction = 'step';

  // Step-in flag: true = F11 (step into child flows), false = F10 (step over)
  private wantStepIn = false;

  // Current state for DAP queries
  private pausedNode: Node | null = null;
  private currentIterationContext: IterationContextInfo | null = null;

  // Innermost node currently executing (stack: top-level node, then nested
  // children via the engine hooks). Read by the recording/replay proxies to
  // stamp connector calls with their originating node (null = console call).
  private executingNodeStack: Node[] = [];

  // Set-next-statement: true while suspended at an executeSteps pause (the
  // frame's own step loop), false during engine iteration pauses raised via
  // onBeforeChildExecute. jumpTo is only valid in the former.
  private pausedAtStepLoop = false;
  // Pending jump, consumed by the executeSteps loop when resume('jump') lands.
  private pendingJump: { targetIndex: number; continuationIds: Set<string> } | null = null;

  // Expression scopes for DSL evaluation, cached per source (normalized key)
  private expressionScopes = new Map<string, ExpressionScope | null>();

  // Sources by normalized key, for expression-scope lookup
  private sources = new Map<string, DebugFlowSource>();

  constructor(
    root: DebugFlowSource,
    host: DebugHost,
    connectors: Record<string, BaseConnector>,
    triggerPayload: any,
    initialVariables: Record<string, any>,
    stopOnEntry: boolean,
    callbacks: DebugCallbacks,
    parameterOverrides?: Record<string, any>,
    options?: DebugSessionOptions,
  ) {
    this.root = root;
    this.host = host;
    this.connectors = connectors;
    this.triggerPayload = triggerPayload;
    this.stopOnEntry = stopOnEntry;
    this.callbacks = callbacks;
    this.options = options;
    this.sources.set(host.normalizeKey(root.key), root);

    // Merge parameter overrides into flow parameters
    this.parameterOverrides = parameterOverrides || {};
    const parameters = { ...(root.ir.parameters || {}) };
    if (parameterOverrides) {
      for (const [key, value] of Object.entries(parameterOverrides)) {
        if (parameters[key] && typeof parameters[key] === 'object') {
          parameters[key] = { ...parameters[key], defaultValue: value };
        } else {
          parameters[key] = { defaultValue: value, type: 'String' };
        }
      }
    }

    this.ctx = {
      variables: { ...initialVariables },
      actions: new Map<string, ActionOutput>(),
      triggerData: triggerPayload,
      workflowName: root.ir.name,
      parameters,
      iterationStack: [],
      artifacts: [],
      now: () => new Date(),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      log: (evt) => callbacks.onOutput(JSON.stringify(evt), 'console'),
      secrets: () => undefined,
      connector: (name) => {
        if (this.connectors[name]) return this.connectors[name] as any;
        callbacks.onOutput(`Warning: connector '${name}' not available in debug mode`, 'console');
        return { invoke: async () => ({ statusCode: 200, body: null }) } as any;
      },
      loadChildFlow: (workflowRef: string) => this.loadChildFlowAsIR(workflowRef, this.root),
    };

    this.steps = this.flattenNodes(root.ir.nodes);
  }

  /**
   * Flatten IR nodes into a sequential step list.
   * Scope/if/switch children are inlined (the engine returns immediately for these).
   * Foreach/dountil children are NOT inlined (the engine handles them internally via hooks).
   */
  private flattenNodes(nodes: Node[]): FlattenedStep[] {
    const result: FlattenedStep[] = [];
    for (const node of nodes) {
      result.push({ node });

      if (node.type === 'foreach' || node.type === 'dountil') continue;

      if (node.type === 'scope' && 'actions' in node && Array.isArray((node as any).actions)) {
        result.push(...this.flattenNodes((node as any).actions));
      }
      if (node.type === 'if') {
        if ('actions' in node && Array.isArray((node as any).actions)) {
          result.push(...this.flattenNodes((node as any).actions));
        }
        if ('elseActions' in node && Array.isArray((node as any).elseActions)) {
          result.push(...this.flattenNodes((node as any).elseActions));
        }
      }
      if (node.type === 'switch') {
        const switchNode = node as any;
        if (switchNode.cases) {
          for (const c of switchNode.cases) {
            if (c.actions) result.push(...this.flattenNodes(c.actions));
          }
        }
        if (switchNode.defaultActions) {
          result.push(...this.flattenNodes(switchNode.defaultActions));
        }
      }
    }
    return result;
  }

  /**
   * Walk a control-flow node's descendants and collect every node id into `out`.
   * Mirrors `flattenNodes` for the same node types — so after a parent if/scope/
   * switch runs, every inlined descendant gets skipped by the top-level loop.
   * Foreach/dountil bodies aren't in the flat list, so they're intentionally
   * excluded here too.
   */
  private collectDescendantIds(node: Node, out: Set<string>): void {
    collectInlinedDescendantIds(node, out);
  }

  /** Find a node by name in a node tree (loop names are unique per flow). */
  private findNodeByName(nodes: Node[], name: string): Node | null {
    for (const node of nodes) {
      if (node.name === name) return node;
      const anyNode = node as any;
      for (const list of [anyNode.actions, anyNode.elseActions, anyNode.defaultActions]) {
        if (Array.isArray(list)) {
          const found = this.findNodeByName(list, name);
          if (found) return found;
        }
      }
      if (Array.isArray(anyNode.cases)) {
        for (const c of anyNode.cases) {
          if (Array.isArray(c.actions)) {
            const found = this.findNodeByName(c.actions, name);
            if (found) return found;
          }
        }
      }
    }
    return null;
  }

  /** Derive the paused-iteration info from the engine's iteration stack, if any. */
  private updateIterationContext(childCtx: RunContext, source: DebugFlowSource): void {
    const stack = childCtx.iterationStack;
    const top = stack && stack.length > 0 ? stack[stack.length - 1] : undefined;
    if (!top) {
      this.currentIterationContext = null;
      return;
    }
    const loopNode = this.findNodeByName(source.ir.nodes, top.loopName);
    this.currentIterationContext = {
      parentNodeId: loopNode?.id ?? top.loopName,
      parentNodeName: top.loopName,
      iterationIndex: top.index,
      totalIterations: 0, // engine does not expose the total; adapter renders '?'
    };
  }

  // --- Child flow resolution ---

  /** Resolve a child flow source via the host, caching it for scope/breakpoint lookup. */
  private async resolveChild(ref: string, parent: DebugFlowSource): Promise<DebugFlowSource | null> {
    const child = await this.host.resolveChildFlow(ref, parent);
    if (child) this.sources.set(this.host.normalizeKey(child.key), child);
    return child;
  }

  /** Load a child flow as IR (for step-over / non-debug execution). */
  private async loadChildFlowAsIR(workflowRef: string, parent: DebugFlowSource): Promise<FlowIR | null> {
    const child = await this.resolveChild(workflowRef, parent);
    return child?.ir ?? null;
  }

  // --- Execution ---

  /** Start the async execution loop. Does not block — returns immediately. */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isStopped = false;

    try {
      // Handle trigger (pass-through)
      const triggerNode = this.root.ir.nodes.find(
        (n) => n.type === 'trigger' || n.type === 'recurrence',
      );
      if (triggerNode) {
        this.ctx.actions.set(triggerNode.name, {
          status: 'Succeeded',
          outputs: this.triggerPayload,
        });
        this.callbacks.onOutput(`Trigger '${triggerNode.name}' executed`, 'console');
      }

      this.steppingMode = this.stopOnEntry ? 'step' : 'continue';

      await this.executeSteps(this.steps, this.ctx, this.root);

      if (!this.isStopped) {
        this.callbacks.onOutput('Flow execution completed', 'console');
      }
    } catch (err: any) {
      this.callbacks.onOutput(`Fatal error: ${err.message}`, 'stderr');
    } finally {
      this.isRunning = false;
      this.pausedNode = null;
      this.callStack = [];
      this.callbacks.onTerminated();
    }
  }

  /**
   * Execute a list of steps, supporting nested child flow debugging.
   * This is the core execution loop, called both for the main flow and child flows.
   */
  private async executeSteps(
    steps: FlattenedStep[],
    ctx: RunContext,
    source: DebugFlowSource,
  ): Promise<ExecuteNodeResult | null> {
    const breakpoints = this.getBreakpointsForKey(source.key);
    let lastResult: ExecuteNodeResult | null = null;

    // Track which inlined steps have already been handled by a parent control-
    // flow node so we don't re-run them at the top level. Tracked by node.id
    // (unique) rather than node.name — duplicate auto-generated names (e.g. two
    // `Check_ctx` ifs) would otherwise cause one if to be silently skipped and
    // its child branches to leak into the top-level execution.
    const handledIds = new Set<string>();

    for (let i = 0; i < steps.length; i++) {
      if (this.isStopped) break;

      const { node } = steps[i];

      // Skip triggers (already handled)
      if (node.type === 'trigger' || node.type === 'recurrence') continue;

      // Skip nodes already executed (or marked Skipped) by a parent control-flow node
      if (handledIds.has(node.id)) continue;

      // Check if we should pause BEFORE executing. The stateful part is
      // evaluated exactly ONCE, before the gate: the fast-forward controller's
      // shouldPauseBefore deactivates itself when it fires, so consulting it
      // again under the gate would silently drop the arrival pause.
      const pauseBefore = this.options?.shouldPauseBefore?.(node) ?? false;
      const hasBreakpoint = breakpoints.has(node.id) && !this.options?.suppressBreakpoints?.();
      const entryPause = this.stopOnEntry && i === 0 && this.callStack.length === 0;
      if (pauseBefore || entryPause || hasBreakpoint || this.steppingMode === 'step') {
        // Gated like the engine-hook pause: a child-flow debugged inside a
        // parallel foreach lane pauses through THIS loop while sibling lanes
        // pause through onBeforeChildExecute — both must share the single
        // resumeResolver one cycle at a time.
        const release = await this.acquirePauseGate();
        let action: ResumeAction | null = null;
        try {
          if (this.isStopped) {
            action = 'stop';
          } else if (pauseBefore || entryPause || hasBreakpoint || this.steppingMode === 'step') {
            // Only steppingMode is re-read under the gate: a resume that
            // happened while this pause was queued may have cleared step mode.
            this.currentIterationContext = null;
            this.pausedNode = node;
            const reason = hasBreakpoint ? 'breakpoint' : 'step';
            this.pausedAtStepLoop = true;
            this.callbacks.onStopped(reason, node.id);

            action = await this.waitForResume();
            this.pausedAtStepLoop = false;
          }
        } finally {
          release();
        }
        if (action === 'stop') {
          this.isStopped = true;
          break;
        }
        if (action === 'jump') {
          // Jump-then-pause: move the execution point and re-pause before the
          // target on the next loop iteration (steppingMode 'step'). Nothing
          // executes on the jump itself.
          this.steppingMode = 'step';
          const jump = this.pendingJump;
          this.pendingJump = null;
          if (jump) {
            // Rebuild handledIds wholesale: the flat list inlines if/switch
            // branch children, so clearing "everything after the target" would
            // leak the OTHER branch's steps into the top-level loop once the
            // jumped-into branch finishes. Instead mark every inlined
            // descendant in the frame, then unmark the continuation set.
            handledIds.clear();
            for (const step of steps) this.collectDescendantIds(step.node, handledIds);
            for (const id of jump.continuationIds) handledIds.delete(id);
            i = jump.targetIndex - 1; // the loop's i++ lands on the target
            continue;
          }
          // resume('jump') without a jumpTo() (host misuse): behave like a plain step
        } else if (action) {
          // null = the pause was skipped under the gate; steppingMode is
          // whatever the resume that cleared it set.
          this.steppingMode = action;
        }
      }

      // Execute the node
      this.callbacks.onOutput(`Executing: ${node.name} (${node.type})`, 'console');

      const stackDepthBefore = this.executingNodeStack.length;
      this.executingNodeStack.push(node);
      try {
        const result = await this.executeStepNode(node, ctx, source);
        lastResult = result;

        ctx.actions.set(node.name, {
          status: result.status,
          // Omitted rather than set to undefined: only connector/HTTP/child-flow
          // nodes capture a resolved invocation payload.
          ...(result.inputs !== undefined ? { inputs: result.inputs } : {}),
          outputs: result.outputs,
          error: result.error,
        });
        ctx.variables = result.variables;
        handledIds.add(node.id);
        this.callbacks.onNodeExecuted?.(node, result, source.key);
        this.currentIterationContext = null;

        // The engine executed children of if/scope/switch internally via
        // runChildNodes; mark every descendant id so the flat-list loop skips
        // both the taken-branch (already-run) and the non-taken-branch (Skipped)
        // children. Covers all nesting depth.
        if (node.type === 'if' || node.type === 'scope' || node.type === 'switch') {
          this.collectDescendantIds(node, handledIds);
        }

        // Handle if node: mark skipped branch steps in ctx.actions (kept for
        // engine-visible run status; the loop dedup itself is id-based above).
        if (node.type === 'if' && result.outputs?.branchTaken) {
          const ifNode = node as any;
          const skippedBranch = result.outputs.branchTaken === 'actions' ? 'elseActions' : 'actions';
          const skippedNodes = ifNode[skippedBranch] || [];
          for (const skipped of skippedNodes) {
            ctx.actions.set(skipped.name, { status: 'Skipped' });
          }
        }

        // Handle switch node: mark non-matching case steps as skipped
        if (node.type === 'switch' && result.outputs) {
          const switchNode = node as any;
          const matchedCase = result.outputs.matchedCase;
          const matched = result.outputs.matched;
          if (switchNode.cases) {
            for (const c of switchNode.cases) {
              if (matched && c.name === matchedCase) continue;
              for (const child of c.actions || []) {
                ctx.actions.set(child.name, { status: 'Skipped' });
              }
            }
            if (matched && switchNode.defaultActions) {
              for (const child of switchNode.defaultActions) {
                ctx.actions.set(child.name, { status: 'Skipped' });
              }
            }
          }
        }

        if (result.status === 'Failed') {
          this.callbacks.onOutput(`Action '${node.name}' failed: ${result.error}`, 'stderr');
        }

        this.logComposeOutput(node, result);
      } catch (err: any) {
        this.callbacks.onOutput(`Error executing '${node.name}': ${err.message}`, 'stderr');
        ctx.actions.set(node.name, { status: 'Failed', error: err.message });
      } finally {
        this.executingNodeStack.length = stackDepthBefore;
      }
    }

    return lastResult;
  }

  /** Execute a single node, with debug hooks for nested children and child flow interception. */
  private async executeStepNode(
    node: Node,
    ctx: RunContext,
    source: DebugFlowSource,
  ): Promise<ExecuteNodeResult> {
    let childDebugMode: ResumeAction = this.steppingMode;
    const breakpoints = this.getBreakpointsForKey(source.key);

    const onBeforeChildExecute = async (childNode: Node, childCtx: RunContext): Promise<'continue' | 'stop'> => {
      if (this.isStopped) return 'stop';

      // Stateful part evaluated exactly ONCE, before the gate (see the same
      // pattern in executeSteps): the fast-forward controller's
      // shouldPauseBefore deactivates itself when it fires.
      const hasBreakpoint = breakpoints.has(childNode.id) && !this.options?.suppressBreakpoints?.();
      const pauseBefore = this.options?.shouldPauseBefore?.(childNode) ?? false;
      if (childDebugMode === 'step' || hasBreakpoint || pauseBefore) {
        // Parallel foreach lanes reach this hook concurrently, so the pause is
        // serialized through the gate: one lane owns the pause/resume cycle
        // while the others queue. Without it, a second lane's waitForResume
        // would overwrite the first lane's resolver and strand that lane
        // forever — hanging the whole session (Stop and Continue alike).
        const release = await this.acquirePauseGate();
        try {
          // Re-checked under the gate: while this lane was queued, the session
          // may have been stopped, or another lane's 'continue' may have
          // cleared step mode (only childDebugMode is re-read).
          if (this.isStopped) return 'stop';
          if (childDebugMode === 'step' || hasBreakpoint || pauseBefore) {
            this.updateIterationContext(childCtx, source);
            this.pausedNode = childNode;
            const reason = hasBreakpoint ? 'breakpoint' : 'step';
            this.callbacks.onStopped(reason, childNode.id);

            const action = await this.waitForResume();
            if (action === 'stop') return 'stop';
            const effective = action === 'jump' ? 'step' : action;
            childDebugMode = effective;
            this.steppingMode = effective;
          }
        } finally {
          release();
        }
      }
      this.executingNodeStack.push(childNode);
      return 'continue';
    };

    const onAfterChildExecute = async (childNode: Node, childResult: ExecuteNodeResult, _ctx: RunContext): Promise<void> => {
      const top = this.executingNodeStack[this.executingNodeStack.length - 1];
      if (top && top.id === childNode.id) this.executingNodeStack.pop();
      ctx.variables = { ...childResult.variables };
      this.logComposeOutput(childNode, childResult);
      this.callbacks.onNodeExecuted?.(childNode, childResult, source.key);
    };

    // Hook to intercept child workflow execution for debugging
    const onBeforeWorkflowExecute = async (
      workflowNode: ActionNode,
      workflowRef: string,
      evaluatedBody: any,
    ): Promise<{ handled: true; result: ExecuteNodeResult } | { handled: false }> => {
      const shouldStepIn = this.wantStepIn && this.steppingMode === 'step';
      const child = await this.resolveChild(workflowRef, source);
      const childHasBreakpoints = child ? this.hasBreakpointsForKey(child.key) : false;

      if (child && (shouldStepIn || childHasBreakpoints)) {
        this.callbacks.onOutput(
          `Stepping into child flow: ${child.ir.name} (${this.host.displayName(child.key)})`,
          'console',
        );
        const result = await this.executeChildFlowDebug(child, evaluatedBody, workflowRef, workflowNode.id);
        return { handled: true, result };
      }

      // Step over: execute child flow without debugging (via engine's run())
      if (child) {
        try {
          const childResult = await runEngine(child.ir, {
            input: evaluatedBody,
            connectors: this.connectors,
            variables: {},
            parameterOverrides: this.parameterOverrides,
            loadChildFlow: (ref: string) => this.loadChildFlowAsIR(ref, child),
            strictWorkflows: false,
          });

          // Child saveFile artifacts funnel into the root collector, matching
          // the step-in path and the engine's own nested-run behavior.
          if (childResult.artifacts?.length) this.ctx.artifacts?.push(...childResult.artifacts);

          const childFlowBody = childResult.trace[childResult.trace.length - 1]?.outputs;
          const result: ExecuteNodeResult = {
            status: childResult.status,
            outputs: {
              workflowReferenceName: workflowRef,
              childWorkflowName: child.ir.name,
              status: childResult.status,
              body: childFlowBody,
            },
            variables: { ...ctx.variables },
          };
          return { handled: true, result };
        } catch (err: any) {
          this.callbacks.onOutput(`Child flow '${workflowRef}' failed: ${err.message}`, 'stderr');
          return {
            handled: true,
            result: { status: 'Failed', error: err, variables: { ...ctx.variables } },
          };
        }
      }

      // No child source found — let executeNode handle it (mock or loadChildFlow)
      return { handled: false };
    };

    return executeNode(node, ctx, {
      connectors: this.connectors,
      onBeforeChildExecute,
      onAfterChildExecute,
      onBeforeWorkflowExecute,
    });
  }

  /**
   * Execute a child flow with full debug support (breakpoints, stepping).
   * Pushes a frame onto the call stack, runs through child steps, then pops.
   */
  private async executeChildFlowDebug(
    child: DebugFlowSource,
    triggerInput: any,
    workflowRef: string,
    callerNodeId?: string,
  ): Promise<ExecuteNodeResult> {
    // Create isolated context for child flow, applying parameter overrides
    const childParameters = { ...(child.ir.parameters || {}) };
    for (const [key, value] of Object.entries(this.parameterOverrides)) {
      if (childParameters[key] && typeof childParameters[key] === 'object') {
        childParameters[key] = { ...childParameters[key], defaultValue: value };
      } else if (childParameters[key] !== undefined) {
        childParameters[key] = { defaultValue: value, type: 'String' };
      }
    }

    const childCtx: RunContext = {
      variables: {},
      actions: new Map<string, ActionOutput>(),
      triggerData: triggerInput,
      workflowName: child.ir.name,
      parameters: childParameters,
      iterationStack: [],
      // Child artifacts funnel into the root collector so a child's saveFile
      // surfaces in the host's single Files list.
      artifacts: this.ctx.artifacts,
      now: () => new Date(),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      log: (evt) => this.callbacks.onOutput(JSON.stringify(evt), 'console'),
      secrets: () => undefined,
      connector: (name) => {
        if (this.connectors[name]) return this.connectors[name] as any;
        this.callbacks.onOutput(`Warning: connector '${name}' not available in debug mode`, 'console');
        return { invoke: async () => ({ statusCode: 200, body: null }) } as any;
      },
      loadChildFlow: (ref: string) => this.loadChildFlowAsIR(ref, child),
    };

    // Handle trigger
    const triggerNode = child.ir.nodes.find(
      (n) => n.type === 'trigger' || n.type === 'recurrence',
    );
    if (triggerNode) {
      childCtx.actions.set(triggerNode.name, {
        status: 'Succeeded',
        outputs: triggerInput,
      });
    }

    // Flatten child steps
    const childSteps = this.flattenNodes(child.ir.nodes);

    // Push frame onto call stack
    const frame: DebugFrame = {
      source: child,
      ctx: childCtx,
      steps: childSteps,
      breakpoints: this.getBreakpointsForKey(child.key),
      callerNodeId,
    };
    this.callStack.push(frame);

    try {
      // Execute child flow steps with debugging
      const lastResult = await this.executeSteps(childSteps, childCtx, child);

      // Build result from last action output
      const lastAction = childSteps
        .filter(s => s.node.type !== 'trigger' && s.node.type !== 'recurrence')
        .map(s => childCtx.actions.get(s.node.name))
        .filter(Boolean)
        .pop();

      const childFlowBody = lastAction?.outputs;
      const status = lastResult?.status || 'Succeeded';

      this.callbacks.onOutput(`Returned from child flow: ${child.ir.name}`, 'console');

      return {
        status,
        outputs: {
          workflowReferenceName: workflowRef,
          childWorkflowName: child.ir.name,
          status,
          body: childFlowBody,
        },
        variables: { ...this.getActiveContext().variables },
      };
    } catch (err: any) {
      this.callbacks.onOutput(`Child flow '${child.ir.name}' failed: ${err.message}`, 'stderr');
      return {
        status: 'Failed',
        error: err,
        outputs: {
          workflowReferenceName: workflowRef,
          childWorkflowName: child.ir.name,
          status: 'Failed',
          error: err.message,
        },
        variables: { ...this.getActiveContext().variables },
      };
    } finally {
      // Pop frame
      this.callStack.pop();
    }
  }

  private waitForResume(): Promise<ResumeAction> {
    return new Promise<ResumeAction>((resolve) => {
      this.resumeResolver = resolve;
    });
  }

  /**
   * Acquire the pause gate: resolves once every earlier acquirer has released,
   * returning the function that releases it for the next in line. Held only
   * for the duration of one pause/resume cycle — never across node execution,
   * so sequential runs are unaffected and re-entry cannot deadlock.
   */
  private acquirePauseGate(): Promise<() => void> {
    const prev = this.pauseGate;
    let release!: () => void;
    this.pauseGate = new Promise<void>((res) => (release = res));
    return prev.then(() => release);
  }

  // --- Breakpoint helpers ---

  private getBreakpointsForKey(key: string): Map<string, number> {
    const norm = this.host.normalizeKey(key);
    let bps = this.breakpointsPerKey.get(norm);
    if (!bps) {
      bps = new Map();
      this.breakpointsPerKey.set(norm, bps);
    }
    return bps;
  }

  private hasBreakpointsForKey(key: string): boolean {
    return this.getBreakpointsForKey(key).size > 0;
  }

  setBreakpointsForSource(key: string, breakpointEntries: Array<{ nodeId: string; line: number }>): void {
    // Mutate the existing map in place — never replace it. Execution loops
    // capture a reference to this map at start; replacing it would leave them
    // checking a stale snapshot and skip breakpoints added mid-run.
    const bpMap = this.getBreakpointsForKey(key);
    bpMap.clear();
    for (const bp of breakpointEntries) {
      bpMap.set(bp.nodeId, bp.line);
    }
  }

  clearBreakpointsForSource(key: string): void {
    this.getBreakpointsForKey(key).clear();
  }

  // --- Public API for DAP adapter ---

  resume(action: ResumeAction): void {
    if (this.resumeResolver) {
      const resolver = this.resumeResolver;
      this.resumeResolver = null;
      resolver(action);
    }
  }

  /**
   * Set Next Statement: move the execution point to `nodeId` within the
   * active frame and re-pause before it — nothing executes on the jump
   * itself; execution happens when the user then steps/continues, live,
   * against the preserved current context. Valid only while suspended at the
   * frame's own step loop; pauses raised by the engine while a control node
   * executes its children — a foreach/dountil iteration or an if/scope/switch
   * branch child — are rejected. Backward = re-execute, forward = skip
   * (skipped nodes keep their stale ctx.actions entries). Returns the
   * continuation set's node ids so hosts can rewind their trace display;
   * `resetNodeIds` ordering is unspecified (Set insertion order — hosts must
   * not depend on it).
   */
  jumpTo(nodeId: string): JumpResult {
    if (!this.resumeResolver) {
      return { ok: false, error: 'Cannot jump: the session is not paused.' };
    }
    if (!this.pausedAtStepLoop) {
      return {
        ok: false,
        error:
          'Cannot jump while paused inside a control-flow block (if/scope/switch branch or loop iteration) — jump is available when paused at the flow\'s own statements.',
      };
    }
    const top = this.callStack.length > 0 ? this.callStack[this.callStack.length - 1] : null;
    const frameSteps = top ? top.steps : this.steps;
    const frameNodes = top ? top.source.ir.nodes : this.root.ir.nodes;

    const targetIndex = frameSteps.findIndex((s) => s.node.id === nodeId);
    if (targetIndex < 0) {
      return { ok: false, error: `Cannot jump: no jumpable statement '${nodeId}' in the current frame (loop bodies are not jumpable).` };
    }
    const target = frameSteps[targetIndex].node;
    if (target.type === 'trigger' || target.type === 'recurrence') {
      return { ok: false, error: 'Cannot jump to a trigger.' };
    }
    const continuationIds = computeContinuationSet(frameNodes, nodeId);
    if (!continuationIds) {
      // Unreachable when targetIndex >= 0 (same traversal); kept as a guard.
      return { ok: false, error: `Cannot jump: node '${nodeId}' not found in the current frame.` };
    }

    this.pendingJump = { targetIndex, continuationIds };
    this.resume('jump');
    return { ok: true, resetNodeIds: [...continuationIds] };
  }

  /** True while suspended at the active frame's own step loop — the only pauses jumpTo accepts. */
  isPausedAtStepLoop(): boolean {
    return this.pausedAtStepLoop;
  }

  /** Set step-in mode (F11): will step into child flows */
  setWantStepIn(value: boolean): void {
    this.wantStepIn = value;
  }

  requestPause(): void {
    this.steppingMode = 'step';
  }

  stop(): void {
    this.isStopped = true;
    if (this.resumeResolver) {
      this.resume('stop');
    }
  }

  getCurrentNode(): Node | null {
    return this.pausedNode;
  }

  /**
   * Name of the innermost node currently executing, or null between nodes —
   * including while PAUSED (resumeResolver set): a pause always sits between
   * executions, and any connector call made then is a console/immediate-window
   * call that must not be stamped as flow-originated.
   */
  getCurrentExecutingNodeName(): string | null {
    if (this.resumeResolver) return null;
    const top = this.executingNodeStack[this.executingNodeStack.length - 1];
    return top?.name ?? null;
  }

  getContext(): RunContext {
    return this.getActiveContext();
  }

  /** Root frame context (the main flow's ctx, regardless of call stack depth). */
  getRootContext(): RunContext {
    return this.ctx;
  }

  /** Get the context for the currently active frame (top of stack, or root). */
  private getActiveContext(): RunContext {
    if (this.callStack.length > 0) {
      return this.callStack[this.callStack.length - 1].ctx;
    }
    return this.ctx;
  }

  getIterationContext(): IterationContextInfo | null {
    return this.currentIterationContext;
  }

  /** Get the full call stack for stack trace display. */
  getCallStack(): DebugFrame[] {
    return [...this.callStack];
  }

  getRootSourceMap(): DslSourceMap | null {
    return this.root.sourceMap;
  }

  getActiveSourceMap(): DslSourceMap | null {
    if (this.callStack.length > 0) {
      return this.callStack[this.callStack.length - 1].source.sourceMap;
    }
    return this.root.sourceMap;
  }

  getActiveKey(): string {
    if (this.callStack.length > 0) {
      return this.callStack[this.callStack.length - 1].source.key;
    }
    return this.root.key;
  }

  getRootKey(): string {
    return this.root.key;
  }

  getSourceMapForKey(key: string): DslSourceMap | null {
    const source = this.sources.get(this.host.normalizeKey(key));
    return source?.sourceMap ?? null;
  }

  /** Get the root flow name. */
  getRootFlowName(): string {
    return this.root.ir.name;
  }

  /** Whether we're currently inside a child flow. */
  isInChildFlow(): boolean {
    return this.callStack.length > 0;
  }

  /** Get call stack depth (0 = root flow). */
  getCallStackDepth(): number {
    return this.callStack.length;
  }

  findNearestBreakpointableLine(requestedLine: number, sourceMap?: DslSourceMap): number | null {
    const sm = sourceMap || this.root.sourceMap;
    if (!sm) return null;
    const lines = [...sm.breakpointableLines].sort((a, b) => a - b);
    for (const line of lines) {
      if (line >= requestedLine) return line;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i] <= requestedLine) return lines[i];
    }
    return null;
  }

  /**
   * Log a Compose action's output to the debug console. No-op for non-Compose nodes
   * or failed executions. Mirrors what Power Automate portal surfaces in run history.
   */
  private logComposeOutput(node: Node, result: ExecuteNodeResult): void {
    if (node.type !== 'action') return;
    if ((node as any).kind !== 'compose') return;
    if (result.status !== 'Succeeded') return;

    const formatted = formatComposeValue(result.outputs);
    this.callbacks.onOutput(`[Compose] ${node.name} = ${formatted}`, 'console');
  }

  /**
   * Build (and cache) the DSL expression scope for the active frame's source.
   * Returns null when the source has no DSL text or source map — DSL-syntax
   * evaluation is then skipped and PA-syntax evaluation still works.
   */
  private getExpressionScope(): ExpressionScope | null {
    return this.getExpressionScopeForKey(this.getActiveKey());
  }

  /** Expression scope for an arbitrary source key (cached; null when no DSL). */
  getExpressionScopeForKey(key: string): ExpressionScope | null {
    const norm = this.host.normalizeKey(key);
    if (this.expressionScopes.has(norm)) return this.expressionScopes.get(norm)!;
    let scope: ExpressionScope | null = null;
    const source = this.sources.get(norm);
    if (source?.dslCode && source.sourceMap) {
      try {
        scope = buildExpressionScope(source.dslCode, source.ir, source.sourceMap);
      } catch {
        scope = null;
      }
    }
    this.expressionScopes.set(norm, scope);
    return scope;
  }

  /** Evaluate a DSL (TypeScript) or Power Automate expression in the current context. */
  evaluate(expression: string): { result: string; value?: any } {
    const outcome = evaluateDebugInput(
      expression,
      this.getExpressionScope(),
      this.getActiveContext(),
      evalExpression,
    );
    return { result: outcome.result, value: outcome.value };
  }
}
