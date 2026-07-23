/**
 * FlowForger Debug Runner
 *
 * Manages step-by-step flow execution with breakpoints and pause/resume.
 * Supports child flow debugging via a call stack of DebugFrames.
 */

import type { FlowIR, Node, ActionNode } from '@flowforger/ir';
import type { RunContext, ExecuteNodeResult, ActionOutput, BaseConnector } from '@flowforger/engine';
import { executeNode, evalExpression, run as runEngine } from '@flowforger/engine';
import { HttpConnector, WebContentsConnector } from '@flowforger/connectors-http';
import { SharePointConnector } from '@flowforger/connectors-sharepoint';
import { DataverseConnector } from '@flowforger/connectors-dataverse';
import { Office365Connector } from '@flowforger/connectors-office365';
import { Office365UsersConnector } from '@flowforger/connectors-office365users';
import { WordOnlineConnector } from '@flowforger/connectors-wordonline';
import { ExcelOnlineConnector } from '@flowforger/connectors-excelonline';
import { TeamsConnector } from '@flowforger/connectors-teams';
import { OneDriveConnector } from '@flowforger/connectors-onedrive';
import { transformCode, buildSourceMapFromDsl, buildExpressionScope, evaluateDebugInput } from '@flowforger/dsl-native';
import type { DslSourceMap, ExpressionScope } from '@flowforger/dsl-native';
import * as fs from 'fs';
import * as path from 'path';

export type ResumeAction = 'step' | 'continue' | 'stop';

export interface DebugCallbacks {
  onStopped: (reason: string, nodeId: string) => void;
  onOutput: (text: string, category: string) => void;
  onTerminated: () => void;
}

export interface ConnectorOptions {
  spToken?: string;
  dvUrl?: string;
  dvToken?: string;
  graphToken?: string;
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
 * Each frame has its own IR, source map, file path, context, and step list.
 */
export interface DebugFrame {
  ir: FlowIR;
  sourceMap: DslSourceMap;
  filePath: string;
  ctx: RunContext;
  steps: FlattenedStep[];
  /** Breakpoints for this frame's file: nodeId -> line */
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

export class FlowForgerDebugRunner {
  private ir: FlowIR;
  private sourceMap: DslSourceMap;
  private filePath: string;
  private triggerPayload: any;
  private stopOnEntry: boolean;
  private callbacks: DebugCallbacks;

  // Execution state
  private ctx: RunContext;
  private connectors: Record<string, BaseConnector>;
  private parameterOverrides: Record<string, any>;
  private steps: FlattenedStep[] = [];
  private isRunning = false;
  private isStopped = false;

  // Call stack for child flow debugging
  private callStack: DebugFrame[] = [];

  // Breakpoints per file (normalized path -> Map<nodeId, line>)
  private breakpointsPerFile = new Map<string, Map<string, number>>();
  // Also keep the main file breakpoints as the "active" set for the root frame
  private breakpoints = new Map<string, number>();

  // Pause/resume
  private resumeResolver: ((action: ResumeAction) => void) | null = null;
  private steppingMode: ResumeAction = 'step';

  // Step-in flag: true = F11 (step into child flows), false = F10 (step over)
  private wantStepIn = false;

  // Current state for DAP queries
  private pausedNode: Node | null = null;
  private currentIterationContext: IterationContextInfo | null = null;

  // Expression scopes for DSL evaluation, cached per file (normalized path)
  private expressionScopes = new Map<string, ExpressionScope | null>();

  constructor(
    ir: FlowIR,
    sourceMap: DslSourceMap,
    filePath: string,
    triggerPayload: any,
    initialVariables: Record<string, any>,
    stopOnEntry: boolean,
    connectorOptions: ConnectorOptions,
    callbacks: DebugCallbacks,
    parameterOverrides?: Record<string, any>,
  ) {
    this.ir = ir;
    this.sourceMap = sourceMap;
    this.filePath = path.resolve(filePath);
    this.triggerPayload = triggerPayload;
    this.stopOnEntry = stopOnEntry;
    this.callbacks = callbacks;

    // Set up connectors
    const httpConnector = new HttpConnector();
    this.connectors = { http: httpConnector } as Record<string, BaseConnector>;

    if (connectorOptions.spToken) {
      this.connectors['sharepoint'] = new SharePointConnector({ token: connectorOptions.spToken }) as any;
    }
    if (connectorOptions.dvUrl && connectorOptions.dvToken) {
      this.connectors['dataverse'] = new DataverseConnector({
        baseUrl: connectorOptions.dvUrl,
        token: connectorOptions.dvToken,
      }) as any;
    }
    if (connectorOptions.graphToken) {
      this.connectors['office365'] = new Office365Connector({ token: connectorOptions.graphToken }) as any;
      this.connectors['office365users'] = new Office365UsersConnector({ token: connectorOptions.graphToken }) as any;
      this.connectors['wordonlinebusiness'] = new WordOnlineConnector({ token: connectorOptions.graphToken }) as any;
      this.connectors['wordonline'] = this.connectors['wordonlinebusiness']; // alias for DSL property name
      this.connectors['excelonlinebusiness'] = new ExcelOnlineConnector({ token: connectorOptions.graphToken }) as any;
      this.connectors['excelonline'] = this.connectors['excelonlinebusiness']; // alias for DSL property name
      this.connectors['teams'] = new TeamsConnector({ token: connectorOptions.graphToken }) as any;
      this.connectors['onedriveforbusiness'] = new OneDriveConnector({ token: connectorOptions.graphToken }) as any;
      this.connectors['onedrive'] = this.connectors['onedriveforbusiness']; // alias
      this.connectors['webcontents'] = new WebContentsConnector({
        dataverseToken: connectorOptions.dvToken,
        sharepointToken: connectorOptions.spToken || connectorOptions.graphToken,
      }) as any;
    }

    // Merge parameter overrides into flow parameters
    this.parameterOverrides = parameterOverrides || {};
    const parameters = { ...(ir.parameters || {}) };
    if (parameterOverrides) {
      for (const [key, value] of Object.entries(parameterOverrides)) {
        if (parameters[key] && typeof parameters[key] === 'object') {
          parameters[key] = { ...parameters[key], defaultValue: value };
        } else {
          parameters[key] = { defaultValue: value, type: 'String' };
        }
      }
    }

    // Create run context with child flow loader for step-over execution
    this.ctx = {
      variables: { ...initialVariables },
      actions: new Map<string, ActionOutput>(),
      triggerData: triggerPayload,
      workflowName: ir.name,
      parameters,
      now: () => new Date(),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      log: (evt) => callbacks.onOutput(JSON.stringify(evt), 'console'),
      secrets: () => undefined,
      connector: (name) => {
        if (this.connectors[name]) return this.connectors[name] as any;
        callbacks.onOutput(`Warning: connector '${name}' not available in debug mode`, 'console');
        return { invoke: async () => ({ statusCode: 200, body: null }) } as any;
      },
      loadChildFlow: (workflowRef: string) => this.loadChildFlowAsIR(workflowRef, this.filePath, this.ir),
    };

    // Flatten nodes for step-by-step execution
    this.steps = this.flattenNodes(ir.nodes);
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
    if (node.type === 'scope' && 'actions' in node && Array.isArray((node as any).actions)) {
      for (const child of (node as any).actions) {
        out.add(child.id);
        this.collectDescendantIds(child, out);
      }
    } else if (node.type === 'if') {
      const ifNode = node as any;
      for (const child of ifNode.actions || []) {
        out.add(child.id);
        this.collectDescendantIds(child, out);
      }
      for (const child of ifNode.elseActions || []) {
        out.add(child.id);
        this.collectDescendantIds(child, out);
      }
    } else if (node.type === 'switch') {
      const switchNode = node as any;
      if (switchNode.cases) {
        for (const c of switchNode.cases) {
          for (const child of c.actions || []) {
            out.add(child.id);
            this.collectDescendantIds(child, out);
          }
        }
      }
      if (switchNode.defaultActions) {
        for (const child of switchNode.defaultActions) {
          out.add(child.id);
          this.collectDescendantIds(child, out);
        }
      }
    }
  }

  // --- Child flow resolution ---

  /**
   * Resolve a child flow's .ff.ts file path given a workflow reference name.
   * 1. Check ir.childFlows[name].dslPath (resolve relative to parent file)
   * 2. Convention fallback: {name}.ff.ts in same directory as parent
   */
  private resolveChildFlowFile(workflowRef: string, parentFilePath: string, ir: FlowIR): string | null {
    const parentDir = path.dirname(parentFilePath);

    // Check childFlows config for dslPath
    if (ir.childFlows) {
      const def = ir.childFlows[workflowRef];
      if (def?.dslPath) {
        const resolved = path.resolve(parentDir, def.dslPath);
        if (fs.existsSync(resolved)) {
          return resolved;
        }
        this.callbacks.onOutput(`Warning: dslPath '${def.dslPath}' not found at ${resolved}`, 'console');
      }

      // Also check by workflowId — the ref might be a GUID
      for (const [name, childDef] of Object.entries(ir.childFlows)) {
        if (childDef.workflowId === workflowRef && childDef.dslPath) {
          const resolved = path.resolve(parentDir, childDef.dslPath);
          if (fs.existsSync(resolved)) {
            return resolved;
          }
        }
      }
    }

    // Convention fallback: {workflowRef}.ff.ts in same directory
    const conventionPath = path.resolve(parentDir, `${workflowRef}.ff.ts`);
    if (fs.existsSync(conventionPath)) {
      return conventionPath;
    }

    return null;
  }

  /**
   * Load a child flow as IR (for step-over / non-debug execution).
   */
  private async loadChildFlowAsIR(workflowRef: string, parentFilePath: string, ir: FlowIR): Promise<FlowIR | null> {
    const childFile = this.resolveChildFlowFile(workflowRef, parentFilePath, ir);
    if (!childFile) return null;

    try {
      const sourceContent = fs.readFileSync(childFile, 'utf-8');
      return transformCode(sourceContent);
    } catch (err: any) {
      this.callbacks.onOutput(`Error compiling child flow '${childFile}': ${err.message}`, 'stderr');
      return null;
    }
  }

  /**
   * Compile a child flow .ff.ts file and return IR + source map.
   */
  private compileChildFlow(childFilePath: string): { ir: FlowIR; sourceMap: DslSourceMap } | null {
    try {
      const sourceContent = fs.readFileSync(childFilePath, 'utf-8');
      const ir = transformCode(sourceContent);
      const sourceMap = buildSourceMapFromDsl(sourceContent, ir);
      return { ir, sourceMap };
    } catch (err: any) {
      this.callbacks.onOutput(`Error compiling child flow '${childFilePath}': ${err.message}`, 'stderr');
      return null;
    }
  }

  // --- Execution ---

  /** Start the async execution loop. Does not block — returns immediately. */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isStopped = false;

    try {
      // Handle trigger (pass-through)
      const triggerNode = this.ir.nodes.find(
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

      await this.executeSteps(this.steps, this.ctx, this.ir, this.sourceMap, this.filePath);

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
    ir: FlowIR,
    sourceMap: DslSourceMap,
    filePath: string,
  ): Promise<ExecuteNodeResult | null> {
    const breakpoints = this.getBreakpointsForFile(filePath);
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

      // Check if we should pause BEFORE executing
      if (this.shouldPauseAt(node, i, breakpoints)) {
        this.pausedNode = node;
        const reason = breakpoints.has(node.id) ? 'breakpoint' : 'step';
        this.callbacks.onStopped(reason, node.id);

        const action = await this.waitForResume();
        if (action === 'stop') {
          this.isStopped = true;
          break;
        }
        this.steppingMode = action;
      }

      // Execute the node
      this.callbacks.onOutput(`Executing: ${node.name} (${node.type})`, 'console');

      try {
        const result = await this.executeStepNode(node, ctx, ir, sourceMap, filePath);
        lastResult = result;

        ctx.actions.set(node.name, {
          status: result.status,
          outputs: result.outputs,
          error: result.error,
        });
        ctx.variables = result.variables;
        handledIds.add(node.id);

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
      }
    }

    return lastResult;
  }

  /** Execute a single node, with debug hooks for nested children and child flow interception. */
  private async executeStepNode(
    node: Node,
    ctx: RunContext,
    ir: FlowIR,
    sourceMap: DslSourceMap,
    filePath: string,
  ): Promise<ExecuteNodeResult> {
    let childDebugMode: ResumeAction = this.steppingMode;
    const breakpoints = this.getBreakpointsForFile(filePath);

    const onBeforeChildExecute = async (childNode: Node, _ctx: RunContext): Promise<'continue' | 'stop'> => {
      if (this.isStopped) return 'stop';

      const hasBreakpoint = breakpoints.has(childNode.id);
      if (childDebugMode === 'step' || hasBreakpoint) {
        this.pausedNode = childNode;
        const reason = hasBreakpoint ? 'breakpoint' : 'step';
        this.callbacks.onStopped(reason, childNode.id);

        const action = await this.waitForResume();
        if (action === 'stop') return 'stop';
        childDebugMode = action;
        this.steppingMode = action;
      }
      return 'continue';
    };

    const onAfterChildExecute = async (childNode: Node, childResult: ExecuteNodeResult, _ctx: RunContext): Promise<void> => {
      ctx.variables = { ...childResult.variables };
      this.logComposeOutput(childNode, childResult);
    };

    // Hook to intercept child workflow execution for debugging
    const onBeforeWorkflowExecute = async (
      workflowNode: ActionNode,
      workflowRef: string,
      evaluatedBody: any,
    ): Promise<{ handled: true; result: ExecuteNodeResult } | { handled: false }> => {
      // Check if we should step into this child flow
      const shouldStepIn = this.wantStepIn && this.steppingMode === 'step';
      const childFile = this.resolveChildFlowFile(workflowRef, filePath, ir);

      // Check if child file has breakpoints set
      const childHasBreakpoints = childFile ? this.hasBreakpointsForFile(childFile) : false;

      if (childFile && (shouldStepIn || childHasBreakpoints)) {
        // Debug into the child flow
        const compiled = this.compileChildFlow(childFile);
        if (compiled) {
          this.callbacks.onOutput(`Stepping into child flow: ${compiled.ir.name} (${path.basename(childFile)})`, 'console');
          const result = await this.executeChildFlowDebug(
            compiled.ir,
            compiled.sourceMap,
            childFile,
            evaluatedBody,
            workflowRef,
            workflowNode.id,
          );
          return { handled: true, result };
        }
      }

      // Step over: execute child flow without debugging (via engine's run())
      if (childFile) {
        const childIR = await this.loadChildFlowAsIR(workflowRef, filePath, ir);
        if (childIR) {
          try {
            const childResult = await runEngine(childIR, {
              input: evaluatedBody,
              connectors: this.connectors,
              variables: {},
              parameterOverrides: this.parameterOverrides,
              loadChildFlow: (ref: string) => this.loadChildFlowAsIR(ref, childFile, childIR),
              strictWorkflows: false,
            });

            const childFlowBody = childResult.trace[childResult.trace.length - 1]?.outputs;
            const result: ExecuteNodeResult = {
              status: childResult.status,
              outputs: {
                workflowReferenceName: workflowRef,
                childWorkflowName: childIR.name,
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
              result: {
                status: 'Failed',
                error: err,
                variables: { ...ctx.variables },
              },
            };
          }
        }
      }

      // No child file found — let executeNode handle it (mock or loadChildFlow)
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
    childIR: FlowIR,
    childSourceMap: DslSourceMap,
    childFilePath: string,
    triggerInput: any,
    workflowRef: string,
    callerNodeId?: string,
  ): Promise<ExecuteNodeResult> {
    // Create isolated context for child flow, applying parameter overrides
    const childParameters = { ...(childIR.parameters || {}) };
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
      workflowName: childIR.name,
      parameters: childParameters,
      now: () => new Date(),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      log: (evt) => this.callbacks.onOutput(JSON.stringify(evt), 'console'),
      secrets: () => undefined,
      connector: (name) => {
        if (this.connectors[name]) return this.connectors[name] as any;
        this.callbacks.onOutput(`Warning: connector '${name}' not available in debug mode`, 'console');
        return { invoke: async () => ({ statusCode: 200, body: null }) } as any;
      },
      loadChildFlow: (ref: string) => this.loadChildFlowAsIR(ref, childFilePath, childIR),
    };

    // Handle trigger
    const triggerNode = childIR.nodes.find(
      (n) => n.type === 'trigger' || n.type === 'recurrence',
    );
    if (triggerNode) {
      childCtx.actions.set(triggerNode.name, {
        status: 'Succeeded',
        outputs: triggerInput,
      });
    }

    // Flatten child steps
    const childSteps = this.flattenNodes(childIR.nodes);

    // Push frame onto call stack
    const frame: DebugFrame = {
      ir: childIR,
      sourceMap: childSourceMap,
      filePath: childFilePath,
      ctx: childCtx,
      steps: childSteps,
      breakpoints: this.getBreakpointsForFile(childFilePath),
      callerNodeId,
    };
    this.callStack.push(frame);

    try {
      // Execute child flow steps with debugging
      const lastResult = await this.executeSteps(childSteps, childCtx, childIR, childSourceMap, childFilePath);

      // Build result from last action output
      const lastAction = childSteps
        .filter(s => s.node.type !== 'trigger' && s.node.type !== 'recurrence')
        .map(s => childCtx.actions.get(s.node.name))
        .filter(Boolean)
        .pop();

      const childFlowBody = lastAction?.outputs;
      const status = lastResult?.status || 'Succeeded';

      this.callbacks.onOutput(`Returned from child flow: ${childIR.name}`, 'console');

      return {
        status,
        outputs: {
          workflowReferenceName: workflowRef,
          childWorkflowName: childIR.name,
          status,
          body: childFlowBody,
        },
        variables: { ...this.getActiveContext().variables },
      };
    } catch (err: any) {
      this.callbacks.onOutput(`Child flow '${childIR.name}' failed: ${err.message}`, 'stderr');
      return {
        status: 'Failed',
        error: err,
        outputs: {
          workflowReferenceName: workflowRef,
          childWorkflowName: childIR.name,
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

  private shouldPauseAt(node: Node, stepIndex: number, breakpoints: Map<string, number>): boolean {
    if (this.stopOnEntry && stepIndex === 0 && this.callStack.length === 0) return true;
    if (this.steppingMode === 'step') return true;
    if (breakpoints.has(node.id)) return true;
    return false;
  }

  private waitForResume(): Promise<ResumeAction> {
    return new Promise<ResumeAction>((resolve) => {
      this.resumeResolver = resolve;
    });
  }

  // --- Breakpoint helpers ---

  /**
   * Get the live breakpoint map for a file, creating and storing it if missing.
   * The returned map is mutated in place by setBreakpointsForFile so that
   * references captured by running execution loops see mid-run updates.
   */
  private getBreakpointsForFile(filePath: string): Map<string, number> {
    const norm = this.normalizePath(filePath);
    let bps = this.breakpointsPerFile.get(norm);
    if (!bps) {
      bps = new Map();
      this.breakpointsPerFile.set(norm, bps);
    }
    return bps;
  }

  private hasBreakpointsForFile(filePath: string): boolean {
    const bps = this.getBreakpointsForFile(filePath);
    return bps.size > 0;
  }

  private normalizePath(p: string): string {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  // --- Public API for DAP adapter ---

  resume(action: ResumeAction): void {
    if (this.resumeResolver) {
      const resolver = this.resumeResolver;
      this.resumeResolver = null;
      resolver(action);
    }
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

  getSourceMap(): DslSourceMap {
    return this.sourceMap;
  }

  getCurrentNode(): Node | null {
    return this.pausedNode;
  }

  getContext(): RunContext {
    return this.getActiveContext();
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

  /** Get the active (top) file path. */
  getActiveFilePath(): string {
    if (this.callStack.length > 0) {
      return this.callStack[this.callStack.length - 1].filePath;
    }
    return this.filePath;
  }

  /** Get the active source map (for the current frame). */
  getActiveSourceMap(): DslSourceMap {
    if (this.callStack.length > 0) {
      return this.callStack[this.callStack.length - 1].sourceMap;
    }
    return this.sourceMap;
  }

  /** Get the root file path. */
  getRootFilePath(): string {
    return this.filePath;
  }

  /** Get the root flow name. */
  getRootFlowName(): string {
    return this.ir.name;
  }

  /** Whether we're currently inside a child flow. */
  isInChildFlow(): boolean {
    return this.callStack.length > 0;
  }

  /** Get call stack depth (0 = root flow). */
  getCallStackDepth(): number {
    return this.callStack.length;
  }

  // --- Breakpoint management ---

  /**
   * Set breakpoints for a specific file. Called by the adapter for each file
   * that has breakpoints, not just the main file.
   */
  setBreakpointsForFile(filePath: string, breakpointEntries: Array<{ nodeId: string; line: number }>): void {
    // Mutate the existing map in place — never replace it. Execution loops
    // capture a reference to this map at start; replacing it would leave them
    // checking a stale snapshot and skip breakpoints added mid-run.
    const bpMap = this.getBreakpointsForFile(filePath);
    bpMap.clear();
    for (const bp of breakpointEntries) {
      bpMap.set(bp.nodeId, bp.line);
    }

    // Also update the legacy breakpoints map if this is the main file
    if (this.normalizePath(filePath) === this.normalizePath(this.filePath)) {
      this.breakpoints = bpMap;
    }
  }

  /**
   * Clear breakpoints for a specific file.
   */
  clearBreakpointsForFile(filePath: string): void {
    this.getBreakpointsForFile(filePath).clear();
  }

  // Legacy single-file API (still used by adapter for main file)
  setBreakpoint(nodeId: string, line: number): void {
    const bps = this.getBreakpointsForFile(this.filePath);
    bps.set(nodeId, line);
    this.breakpoints = bps;
  }

  clearBreakpoints(): void {
    const bps = this.getBreakpointsForFile(this.filePath);
    bps.clear();
    this.breakpoints = bps;
  }

  getBreakpointCount(): number {
    return this.breakpoints.size;
  }

  findNearestBreakpointableLine(requestedLine: number, sourceMap?: DslSourceMap): number | null {
    const sm = sourceMap || this.sourceMap;
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
   * Try to get the source map for a given file path.
   * If it's the main file, return the main source map.
   * If it's a child flow file, compile it on-the-fly for breakpoint validation.
   */
  getSourceMapForFile(filePath: string): DslSourceMap | null {
    const norm = this.normalizePath(filePath);
    if (norm === this.normalizePath(this.filePath)) {
      return this.sourceMap;
    }

    // Check if this file is currently in the call stack
    for (const frame of this.callStack) {
      if (this.normalizePath(frame.filePath) === norm) {
        return frame.sourceMap;
      }
    }

    // Try to compile on-the-fly for breakpoint validation
    if (fs.existsSync(filePath) && filePath.endsWith('.ff.ts')) {
      const compiled = this.compileChildFlow(filePath);
      if (compiled) {
        return compiled.sourceMap;
      }
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
   * Build (and cache) the DSL expression scope for the active frame's file.
   * Returns null if the source can't be read — DSL evaluation is then skipped.
   */
  private getExpressionScope(): ExpressionScope | null {
    const filePath = this.getActiveFilePath();
    const norm = this.normalizePath(filePath);
    if (this.expressionScopes.has(norm)) {
      return this.expressionScopes.get(norm)!;
    }
    let scope: ExpressionScope | null = null;
    try {
      const source = fs.readFileSync(filePath, 'utf-8');
      const ir = this.callStack.length > 0 ? this.callStack[this.callStack.length - 1].ir : this.ir;
      scope = buildExpressionScope(source, ir, this.getActiveSourceMap());
    } catch {
      scope = null;
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
