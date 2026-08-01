/**
 * FlowForger DAP Debug Adapter
 *
 * Implements the VS Code Debug Adapter Protocol for .ff.ts files.
 * Compiles DSL to IR, builds a source map, and uses the shared
 * @flowforger/debug-core DebugSession for step-by-step execution with breakpoints.
 * Supports multi-file debugging for child flow step-in.
 */

import {
  DebugSession as VsCodeDebugSession,
  InitializedEvent,
  StoppedEvent,
  TerminatedEvent,
  OutputEvent,
  Thread,
  StackFrame,
  Scope,
  Source,
  Breakpoint,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { transformCode, buildSourceMapFromDsl } from '@flowforger/dsl-native';
import type { DslSourceMap } from '@flowforger/dsl-native';
import {
  DebugSession,
  ConnectorCallLog,
  wrapConnectorsForRecording,
  wrapConnectorsForReplay,
  computeVolatileInputPaths,
  computeFastForwardTarget,
  buildNodeIndex,
  rewindExecutionCounts,
  evaluateRewindPreconditions,
  FastForwardController,
  type DebugFlowSource,
  type FastForwardTarget,
} from '@flowforger/debug-core';
import type { Node, FlowIR } from '@flowforger/ir';
import type { BaseConnector } from '@flowforger/engine';
import { NodeDebugHost, buildConnectors, type ConnectorOptions } from '@flowforger/debug-node';
import { chooseRestartMode, resolveNodeIdAtLine, isSourceDirty } from './debug-adapter-helpers.js';

const THREAD_ID = 1;

// Scope reference IDs
const SCOPE_VARIABLES = 1;
const SCOPE_ACTIONS = 2;
const SCOPE_TRIGGER = 3;
const SCOPE_PARAMETERS = 4;

interface LaunchArgs extends DebugProtocol.LaunchRequestArguments {
  program: string;
  triggerPayload?: any;
  variables?: Record<string, any>;
  parameters?: Record<string, any>;
  stopOnEntry?: boolean;
  spToken?: string;
  dvUrl?: string;
  dvToken?: string;
  graphToken?: string;
  config?: string;
}

export class FlowForgerDebugAdapterFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  createDebugAdapterDescriptor(
    _session: vscode.DebugSession,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(
      new FlowForgerDebugSession(),
    );
  }
}

/**
 * Reported when a jump targets the root file while paused inside a child flow
 * and the target is not a rewindable statement in the root IR. An in-place jump
 * resolves within the ACTIVE (child) frame, so it is never attempted there.
 */
const CHILD_FRAME_JUMP_ERROR =
  'Cannot jump inside a child flow — jump to a statement in the root flow instead.';

/** Normalize a file path for comparison (case-insensitive on Windows). */
function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

class FlowForgerDebugSession extends VsCodeDebugSession {
  private runner: DebugSession | null = null;
  private host: NodeDebugHost | null = null;
  private sourceFile = '';
  private sourceFileNorm = '';

  // Expandable variable references
  private nextVarRef = 100;
  private expandableVars = new Map<number, any>();

  // Pending breakpoints per source file (set before launch completes)
  private pendingBreakpoints = new Map<string, number[]>();

  /** Every setBreakpoints request seen, by normalized path — re-applied after a relaunch. */
  private requestedBreakpoints = new Map<string, { filePath: string; lines: number[] }>();

  // Compiled source maps for child flow files (cached for breakpoint validation)
  private childSourceMaps = new Map<string, DslSourceMap>();

  // --- Edit & Continue / rewind state (mirrors the web driver's per-run state) ---
  /** Unwrapped connector instances, reused across every relaunch. */
  private rawConnectors: Record<string, BaseConnector> = {};
  /** Calls recorded by the CURRENT run; becomes the replay source on the next restart/rewind. */
  private recordingLog = new ConnectorCallLog();
  /** Recording (normal run) or replay (post-restart fast-forward) wrap over rawConnectors. */
  private connectors: Record<string, BaseConnector> = {};
  /** Completed root-frame executions by node name — supplies fast-forward hit counts. */
  private executionCounts = new Map<string, number>();
  /** nodeId -> Node for the ROOT flow of the running session. */
  private rootNodeIndex = new Map<string, Node>();
  /** The root IR of the running session (rewind relaunches reuse it unchanged). */
  private rootIr: FlowIR | null = null;
  /** True while the session is suspended (any pause site). */
  private paused = false;
  /** The DSL text the running session was compiled from (dirty-gate baseline). */
  private sourceContent = '';
  /** The launch configuration, replayed on restart. */
  private launchArgs: LaunchArgs | null = null;
  /** The trigger payload the running session was launched with. */
  private triggerPayload: any = {};

  /**
   * Runners whose TerminatedEvent is suppressed (restart/rewind relaunch),
   * mapped to the resolver that unblocks the teardown await (null once the
   * await has moved on but the event must still be swallowed). Keyed per
   * runner — never a single shared slot — so a second restart inside a
   * still-open teardown window cannot overwrite the first runner's entry and
   * let its late termination kill the healthy successor.
   */
  private silencedRunners = new WeakMap<DebugSession, (() => void) | null>();

  /** Active only while a post-restart/rewind session fast-forwards. */
  private ffController: FastForwardController | null = null;
  /**
   * Whether the active ffController has a reachable target. When the previous
   * position was renamed/deleted the controller can never "arrive", so
   * breakpoint suppression must not key off `active` alone.
   */
  private ffHasTarget = false;

  /** Serializes restart and goto — both tear the session down and relaunch. */
  private busy = false;

  /**
   * DAP goto target id -> the file it was resolved in plus the node id,
   * populated by gotoTargetsRequest. The file key is part of the entry because
   * node ids are unique only per compile (`transformCode` restarts its
   * counter), so a child flow and the root both contain `act_2`, `act_3`, …
   */
  private gotoTargetTable = new Map<number, { key: string; nodeId: string }>();
  private nextGotoTargetId = 1;
  /** Set while an in-place jump is in flight so the next pause reports reason 'goto'. */
  private jumpInFlight = false;

  /**
   * Whether `this.runner` has not yet terminated. `DebugSession.stop()` only
   * fires `onTerminated` from the run loop's `finally`, so stopping an
   * already-finished session never completes the teardown handshake — a
   * restart would stall on its 2s timeout. Nothing to tear down means skip it.
   */
  private runnerAlive = false;

  /** Set once the client terminates/disconnects — no relaunch may outlive it. */
  private disposed = false;

  constructor() {
    super();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
  }

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    _args: DebugProtocol.InitializeRequestArguments,
  ): void {
    response.body = response.body || {};
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsFunctionBreakpoints = false;
    response.body.supportsConditionalBreakpoints = false;
    response.body.supportsEvaluateForHovers = true;
    response.body.supportsStepBack = false;
    response.body.supportsSetVariable = false;
    response.body.supportsRestartFrame = false;
    response.body.supportsTerminateRequest = true;
    response.body.supportsRestartRequest = true;
    response.body.supportsGotoTargetsRequest = true;

    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  /**
   * Construct and wire one DebugSession against the current adapter state.
   * Used by the initial launch and by every restart/rewind relaunch. Does NOT
   * start it — `configurationDone` starts the initial run, relaunches start
   * it directly.
   */
  private createRunner(source: DebugFlowSource, stopOnEntry: boolean): DebugSession {
    const onOutput = (text: string, category: string) =>
      this.sendEvent(new OutputEvent(text + '\n', category));

    let runner: DebugSession;
    runner = new DebugSession(
      source,
      this.host!,
      this.connectors,
      this.triggerPayload,
      this.launchArgs?.variables || {},
      stopOnEntry,
      {
        onStopped: (reason: string, _nodeId: string) => {
          this.expandableVars.clear();
          this.nextVarRef = 100;
          this.paused = true;
          // An in-place jump re-pauses before the target; report it to the
          // client as 'goto' so the UI reads "jumped", not "stepped".
          const effective = this.jumpInFlight ? 'goto' : reason;
          this.jumpInFlight = false;
          this.sendEvent(new StoppedEvent(effective, THREAD_ID));
        },
        onOutput,
        onTerminated: () => {
          // Adapter-level run state belongs to the runner the adapter still
          // owns. A runner that terminates LATE (after restartClean's teardown
          // timed out and already relaunched) must not mark its healthy
          // successor as dead, nor flip a genuinely paused successor to
          // running — that would silently degrade the next restart hot->clean
          // and make a jump reject with "Can only jump while paused."
          if (this.runner === runner) {
            this.runnerAlive = false;
            this.paused = false;
          }
          // Silent teardown (a restart/rewind stopping the previous session):
          // publish nothing and let the successor own the session. The lookup
          // is keyed on THIS runner, so a teardown can only ever silence the
          // runner it was requested for.
          if (this.silencedRunners.has(runner)) {
            const resolve = this.silencedRunners.get(runner);
            this.silencedRunners.delete(runner);
            resolve?.();
            return;
          }
          // Natural termination while a fast-forward was still searching: the
          // previous position was never reached, so say so and disarm.
          if (this.ffController?.active) {
            this.sendEvent(new OutputEvent(
              'Note: the previous position was not reached (execution path changed); run continued to completion.\n',
              'console',
            ));
            this.ffController = null;
            this.ffHasTarget = false;
          }
          this.sendEvent(new TerminatedEvent());
        },
        onNodeExecuted: (node) => {
          // A dead runner finishing its in-flight node must not pollute the
          // successor's counts or write a bogus boundary into its recording.
          if (this.runner !== runner) return;
          // Child-frame nodes are not part of the root run's counts.
          if (runner.getCallStackDepth() > 0) return;
          const hit = (this.executionCounts.get(node.name) ?? 0) + 1;
          this.executionCounts.set(node.name, hit);
          this.recordingLog.markBoundary(node.name, hit);
        },
      },
      this.launchArgs?.parameters,
      {
        shouldPauseBefore: (n) => this.ffController?.shouldPauseBefore(n) ?? false,
        suppressBreakpoints: () => (this.ffController?.active ?? false) && this.ffHasTarget,
      },
    );
    this.runnerAlive = true;
    return runner;
  }

  protected launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchArgs,
  ): void {
    try {
      this.sourceFile = path.resolve(args.program);
      this.sourceFileNorm = normalizePath(this.sourceFile);
      const sourceContent = fs.readFileSync(this.sourceFile, 'utf-8');

      // Compile DSL to IR
      this.sendEvent(new OutputEvent('Compiling DSL...\n', 'console'));
      const ir = transformCode(sourceContent);

      // Build source map
      const sourceMap = buildSourceMapFromDsl(sourceContent, ir);
      this.sendEvent(
        new OutputEvent(
          `Compiled '${ir.name}' — ${sourceMap.breakpointableLines.size} breakpointable lines\n`,
          'console',
        ),
      );

      // Parse trigger payload
      let triggerPayload = args.triggerPayload || {};
      if (typeof triggerPayload === 'string') {
        // Resolve relative paths against the source file's directory
        const resolved = path.isAbsolute(triggerPayload)
          ? triggerPayload
          : path.resolve(path.dirname(this.sourceFile), triggerPayload);
        if (fs.existsSync(resolved)) {
          triggerPayload = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
        } else {
          try {
            triggerPayload = JSON.parse(triggerPayload);
          } catch {
            triggerPayload = {};
          }
        }
      }

      this.launchArgs = args;
      this.triggerPayload = triggerPayload;
      this.sourceContent = sourceContent;

      const connectorOptions: ConnectorOptions = {
        spToken: args.spToken,
        dvUrl: args.dvUrl,
        dvToken: args.dvToken,
        graphToken: args.graphToken,
      };

      const onOutput = (text: string, category: string) =>
        this.sendEvent(new OutputEvent(text + '\n', category));
      this.host = new NodeDebugHost(onOutput);

      this.rawConnectors = buildConnectors(connectorOptions);
      this.recordingLog = new ConnectorCallLog();
      this.connectors = wrapConnectorsForRecording(
        this.rawConnectors,
        this.recordingLog,
        () => this.runner?.getCurrentExecutingNodeName() ?? null,
      );
      this.executionCounts = new Map();
      this.rootNodeIndex = buildNodeIndex(ir.nodes);
      this.rootIr = ir;

      const root: DebugFlowSource = {
        key: this.sourceFile,
        ir,
        sourceMap,
        dslCode: sourceContent,
      };
      this.runner = this.createRunner(root, args.stopOnEntry || false);

      // Apply any pending breakpoints that were set before launch
      for (const [fileNorm, lines] of this.pendingBreakpoints.entries()) {
        if (fileNorm === this.sourceFileNorm) {
          this.applyBreakpointsForFile(this.sourceFile, lines, sourceMap);
        } else {
          // Child flow file — try to compile for breakpoint validation
          this.applyPendingChildBreakpoints(fileNorm, lines);
        }
      }
      this.pendingBreakpoints.clear();

      this.sendResponse(response);
    } catch (err: any) {
      this.sendEvent(new OutputEvent(`Compilation error: ${err.message}\n`, 'stderr'));
      this.sendErrorResponse(response, 1001, `Failed to launch: ${err.message}`);
    }
  }

  protected setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): void {
    const sourcePath = args.source?.path || '';
    const sourcePathNorm = sourcePath ? normalizePath(sourcePath) : '';
    const requestedLines = args.breakpoints?.map((bp) => bp.line) || [];

    if (sourcePathNorm) {
      this.requestedBreakpoints.set(sourcePathNorm, { filePath: sourcePath, lines: requestedLines });
    }

    if (!this.runner) {
      // Runner not yet created — store pending per source file (normalized)
      if (sourcePathNorm) {
        this.pendingBreakpoints.set(sourcePathNorm, requestedLines);
      }
      response.body = {
        breakpoints: requestedLines.map(
          (line) => new Breakpoint(true, line),
        ),
      };
      this.sendResponse(response);
      return;
    }

    // Get or compile source map for this file
    const sourceMap = this.getSourceMapForFile(sourcePath);

    if (!sourceMap) {
      // Unknown file — mark all breakpoints as unverified
      response.body = {
        breakpoints: requestedLines.map(
          (line) => new Breakpoint(false, line),
        ),
      };
      this.sendResponse(response);
      return;
    }

    const confirmed = this.applyBreakpointsForFile(sourcePath, requestedLines, sourceMap);
    response.body = { breakpoints: confirmed };
    this.sendResponse(response);
  }

  /**
   * Get the source map for a file. For the main file, returns the main source map.
   * For child flow files, compiles on-the-fly and caches.
   */
  private getSourceMapForFile(filePath: string): DslSourceMap | null {
    const norm = normalizePath(filePath);

    // Main file
    if (norm === this.sourceFileNorm && this.runner) {
      return this.runner.getRootSourceMap();
    }

    // Check runner (may have it from call stack or compilation)
    if (this.runner) {
      const sm = this.runner.getSourceMapForKey(filePath);
      if (sm) {
        this.childSourceMaps.set(norm, sm);
        return sm;
      }
    }

    // Check cache
    if (this.childSourceMaps.has(norm)) {
      return this.childSourceMaps.get(norm)!;
    }

    // Try to compile for breakpoint validation
    if (this.host && fs.existsSync(filePath) && filePath.endsWith('.ff.ts')) {
      const compiled = this.host.compileFile(filePath);
      if (compiled?.sourceMap) {
        this.childSourceMaps.set(norm, compiled.sourceMap);
        return compiled.sourceMap;
      }
    }
    return null;
  }

  /**
   * Apply breakpoints for a specific file and register them with the runner.
   */
  private applyBreakpointsForFile(
    filePath: string,
    requestedLines: number[],
    sourceMap: DslSourceMap,
  ): DebugProtocol.Breakpoint[] {
    if (!this.runner) return [];

    const confirmed: DebugProtocol.Breakpoint[] = [];
    const src = new Source(path.basename(filePath), path.resolve(filePath));
    const breakpointEntries: Array<{ nodeId: string; line: number }> = [];

    for (const line of requestedLines) {
      // Check exact line
      if (sourceMap.breakpointableLines.has(line)) {
        const nodeId = sourceMap.lineToNodeId.get(line);
        if (nodeId) {
          breakpointEntries.push({ nodeId, line });
          confirmed.push(new Breakpoint(true, line, undefined, src));
          continue;
        }
      }

      // Try nearest breakpointable line
      const nearest = this.runner.findNearestBreakpointableLine(line, sourceMap);
      if (nearest) {
        const nodeId = sourceMap.lineToNodeId.get(nearest);
        if (nodeId) {
          breakpointEntries.push({ nodeId, line: nearest });
          confirmed.push(new Breakpoint(true, nearest, undefined, src));
          continue;
        }
      }

      // Unverified
      confirmed.push(new Breakpoint(false, line));
    }

    // Register with runner
    this.runner.setBreakpointsForSource(path.resolve(filePath), breakpointEntries);

    return confirmed;
  }

  /**
   * Apply pending breakpoints for a child flow file (before it's been stepped into).
   */
  private applyPendingChildBreakpoints(fileNorm: string, lines: number[]): void {
    // Find the actual file path from the normalized path
    // On Windows, we need to find a matching .ff.ts file
    // For now, try to find it by checking common locations
    const sourceMap = this.getSourceMapForFile(fileNorm);
    if (sourceMap && this.runner) {
      this.applyBreakpointsForFile(fileNorm, lines, sourceMap);
    }
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    _args: DebugProtocol.ConfigurationDoneArguments,
  ): void {
    this.sendResponse(response);
    // Start execution asynchronously
    this.runner?.start();
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = { threads: [new Thread(THREAD_ID, 'Flow Execution')] };
    this.sendResponse(response);
  }

  protected stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    _args: DebugProtocol.StackTraceArguments,
  ): void {
    const frames: StackFrame[] = [];

    if (this.runner) {
      const currentNode = this.runner.getCurrentNode();
      const callStack = this.runner.getCallStack();

      if (currentNode) {
        // Active frame (top of stack) — this is where execution is paused
        const activeSourceMap = this.runner.getActiveSourceMap();
        const activeFilePath = this.runner.getActiveKey();
        const entry = activeSourceMap?.nodeIdToLines.get(currentNode.id);
        const line = entry?.startLine || 1;
        const src = new Source(path.basename(activeFilePath), activeFilePath);

        frames.push(new StackFrame(0, currentNode.name, src, line, 1));

        // If inside a foreach/dountil iteration, add iteration frame
        const iterCtx = this.runner.getIterationContext();
        if (iterCtx) {
          const parentEntry = activeSourceMap?.nodeIdToLines.get(iterCtx.parentNodeId);
          frames.push(
            new StackFrame(
              1,
              `${iterCtx.parentNodeName} (iteration ${iterCtx.iterationIndex + 1}/${iterCtx.totalIterations || '?'})`,
              src,
              parentEntry?.startLine || 1,
              1,
            ),
          );
        }

        // Add parent frames from the call stack showing the call site in each parent.
        // callStack[0] is the first child, callStack[1] is a child of that child, etc.
        // We iterate from deepest to shallowest.
        for (let i = callStack.length - 1; i >= 0; i--) {
          const frame = callStack[i];
          // The parent is the previous callStack frame, or the root flow for callStack[0]
          const parentFilePath = i > 0 ? callStack[i - 1].source.key : this.runner.getRootKey();
          const parentSourceMap = i > 0 ? callStack[i - 1].source.sourceMap : this.runner.getRootSourceMap();
          const parentSrc = new Source(path.basename(parentFilePath), parentFilePath);

          // Look up the callWorkflow line in the parent's source map
          let callerLine = 1;
          if (frame.callerNodeId && parentSourceMap) {
            const entry = parentSourceMap?.nodeIdToLines.get(frame.callerNodeId);
            if (entry) {
              callerLine = entry.startLine;
            }
          }

          const label = i > 0 ? `[child flow] ${callStack[i - 1].source.ir.name}` : `[root] ${this.runner.getRootFlowName() || 'Flow'}`;
          frames.push(
            new StackFrame(
              frames.length,
              label,
              parentSrc,
              callerLine,
              1,
            ),
          );
        }
      }
    }

    response.body = { stackFrames: frames, totalFrames: frames.length };
    this.sendResponse(response);
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    _args: DebugProtocol.ScopesArguments,
  ): void {
    response.body = {
      scopes: [
        new Scope('Variables', SCOPE_VARIABLES, false),
        new Scope('Action Outputs', SCOPE_ACTIONS, false),
        new Scope('Trigger Data', SCOPE_TRIGGER, false),
        new Scope('Parameters', SCOPE_PARAMETERS, false),
      ],
    };
    this.sendResponse(response);
  }

  protected variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): void {
    const variables: DebugProtocol.Variable[] = [];

    if (!this.runner) {
      response.body = { variables };
      this.sendResponse(response);
      return;
    }

    // getContext() returns the active frame's context (child flow if in one)
    const ctx = this.runner.getContext();

    if (args.variablesReference === SCOPE_VARIABLES) {
      for (const [name, value] of Object.entries(ctx.variables)) {
        variables.push(this.createVariable(name, value));
      }
    } else if (args.variablesReference === SCOPE_ACTIONS) {
      for (const [name, output] of ctx.actions.entries()) {
        variables.push(this.createVariable(name, output));
      }
    } else if (args.variablesReference === SCOPE_TRIGGER) {
      if (ctx.triggerData && typeof ctx.triggerData === 'object') {
        for (const [key, value] of Object.entries(ctx.triggerData)) {
          variables.push(this.createVariable(key, value));
        }
      } else if (ctx.triggerData !== undefined) {
        variables.push(this.createVariable('triggerData', ctx.triggerData));
      }
    } else if (args.variablesReference === SCOPE_PARAMETERS) {
      if (ctx.parameters && typeof ctx.parameters === 'object') {
        for (const [name, def] of Object.entries(ctx.parameters)) {
          const value = def && typeof def === 'object' && 'defaultValue' in def ? def.defaultValue : def;
          variables.push(this.createVariable(name, value));
        }
      }
    } else if (this.expandableVars.has(args.variablesReference)) {
      const obj = this.expandableVars.get(args.variablesReference);
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          variables.push(this.createVariable(`[${i}]`, obj[i]));
        }
      } else if (obj && typeof obj === 'object') {
        for (const [key, value] of Object.entries(obj)) {
          variables.push(this.createVariable(key, value));
        }
      }
    }

    response.body = { variables };
    this.sendResponse(response);
  }

  private createVariable(name: string, value: any): DebugProtocol.Variable {
    if (value === null || value === undefined) {
      return { name, value: String(value), variablesReference: 0 };
    }
    if (typeof value === 'object') {
      const ref = this.nextVarRef++;
      this.expandableVars.set(ref, value);
      const preview = Array.isArray(value)
        ? `Array(${value.length})`
        : `{${Object.keys(value).slice(0, 3).join(', ')}${Object.keys(value).length > 3 ? ', ...' : ''}}`;
      return { name, value: preview, variablesReference: ref };
    }
    return { name, value: String(value), variablesReference: 0 };
  }

  protected evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments,
  ): void {
    if (!this.runner) {
      this.sendErrorResponse(response, 2001, 'No active debug session');
      return;
    }

    const { result, value } = this.runner.evaluate(args.expression);

    let variablesReference = 0;
    if (value && typeof value === 'object') {
      variablesReference = this.nextVarRef++;
      this.expandableVars.set(variablesReference, value);
    }

    response.body = { result, variablesReference };
    this.sendResponse(response);
  }

  // --- Execution control ---

  // Every movement control below drops the request while a restart/jump is in
  // flight: during the teardown/relaunch gap the adapter still looks paused to
  // the client, so an unguarded press would drive the already-stopped old
  // runner (resuming or mis-terminating it for nothing).
  protected continueRequest(
    response: DebugProtocol.ContinueResponse,
    _args: DebugProtocol.ContinueArguments,
  ): void {
    if (this.busy) {
      response.body = { allThreadsContinued: true };
      this.sendResponse(response);
      return;
    }
    if (this.runner) {
      this.runner.setWantStepIn(false);
      this.paused = false;
      this.runner.resume('continue');
    }
    response.body = { allThreadsContinued: true };
    this.sendResponse(response);
  }

  protected nextRequest(
    response: DebugProtocol.NextResponse,
    _args: DebugProtocol.NextArguments,
  ): void {
    if (this.busy) {
      this.sendResponse(response);
      return;
    }
    if (this.runner) {
      // F10: Step over — don't step into child flows
      this.runner.setWantStepIn(false);
      this.paused = false;
      this.runner.resume('step');
    }
    this.sendResponse(response);
  }

  protected stepInRequest(
    response: DebugProtocol.StepInResponse,
    _args: DebugProtocol.StepInArguments,
  ): void {
    if (this.busy) {
      this.sendResponse(response);
      return;
    }
    if (this.runner) {
      // F11: Step in — step into child flows if on a workflow action
      this.runner.setWantStepIn(true);
      this.paused = false;
      this.runner.resume('step');
    }
    this.sendResponse(response);
  }

  protected stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    _args: DebugProtocol.StepOutArguments,
  ): void {
    if (this.busy) {
      this.sendResponse(response);
      return;
    }
    if (this.runner) {
      // Shift+F11: Step out — if in child flow, run to completion and return to parent
      this.runner.setWantStepIn(false);
      this.paused = false;
      this.runner.resume('continue');
    }
    this.sendResponse(response);
  }

  protected pauseRequest(
    response: DebugProtocol.PauseResponse,
    _args: DebugProtocol.PauseArguments,
  ): void {
    this.runner?.requestPause();
    this.sendResponse(response);
  }

  // --- Restart (Edit & Continue / clean) ---

  /** The DSL text to compile: the open editor buffer (saved or not) if any, else disk. */
  private currentSourceText(): string {
    const doc = vscode.workspace.textDocuments.find(
      (d) => normalizePath(d.uri.fsPath) === this.sourceFileNorm,
    );
    return doc ? doc.getText() : fs.readFileSync(this.sourceFile, 'utf-8');
  }

  /** Re-register every requested breakpoint against the current runner's source maps. */
  private reapplyBreakpoints(): void {
    for (const { filePath, lines } of this.requestedBreakpoints.values()) {
      const sm = this.getSourceMapForFile(filePath);
      if (sm) this.applyBreakpointsForFile(filePath, lines, sm);
    }
  }

  /**
   * Shared restart/rewind relaunch: silent teardown of the current runner
   * (with timeout), state reset against spec.source, recording->replay swap,
   * fast-forward controller, relaunch in continue mode. The caller does the
   * mode-specific prep first (recompile for a hot restart; replay-log
   * truncation for a rewind).
   */
  private async relaunchWithReplay(spec: {
    source: DebugFlowSource;
    target: FastForwardTarget | null;
    mode: 'apply' | 'rewind';
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const old = this.runner;
    if (!old) return { ok: false, error: 'No active debug session.' };

    // Silent teardown with a timeout: stop() unblocks synchronously while
    // paused (the resume resolver is set), so the timeout only fires if that
    // invariant is broken — an explicit error beats a silent hang. A runner
    // that already terminated has nothing to tear down (and would never
    // complete the handshake), so it counts as torn down immediately.
    const tornDown = !this.runnerAlive
      ? true
      : await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            // Aborting without relaunching: drop the silencer so a late
            // termination correctly ends this (dead) session.
            this.silencedRunners.delete(old);
            resolve(false);
          }, 2000);
          this.silencedRunners.set(old, () => {
            clearTimeout(timer);
            resolve(true);
          });
          this.paused = false;
          old.stop();
        });
    if (!tornDown) {
      return { ok: false, error: 'Debug session teardown timed out — stop the session and start debugging again.' };
    }
    if (this.disposed) {
      return { ok: false, error: 'Debug session was terminated.' };
    }

    if (this.recordingLog.incomplete) {
      this.sendEvent(new OutputEvent(
        'Note: the recording hit its size limit — calls beyond the recorded window will re-execute live.\n',
        'console',
      ));
    }

    // Reset per-run state against the (possibly recompiled) source.
    this.executionCounts = new Map();
    this.rootNodeIndex = buildNodeIndex(spec.source.ir.nodes);
    this.rootIr = spec.source.ir;
    this.sourceContent = spec.source.dslCode ?? this.sourceContent;
    this.childSourceMaps.clear();
    // Ids are deterministic per compile, so a target cached against the
    // previous compile would still resolve — to a possibly DIFFERENT
    // statement. Drop them (this also bounds the map's growth).
    this.gotoTargetTable.clear();

    // Swap recording -> replay (the new run re-records into a fresh log).
    const previousLog = this.recordingLog;
    this.recordingLog = new ConnectorCallLog();
    this.connectors = wrapConnectorsForReplay(
      this.rawConnectors,
      previousLog,
      this.recordingLog,
      {
        onReplayed: (call) =>
          this.sendEvent(new OutputEvent(`(replayed) ${call.connector}.${call.operation}\n`, 'console')),
        onDivergence: (connector, operation) => {
          if (this.ffController?.active) {
            const nodeName = this.runner?.getCurrentExecutingNodeName();
            this.sendEvent(new OutputEvent(
              `Divergence: ${nodeName ? `${nodeName} (${connector}.${operation})` : `${connector}.${operation}`} inputs changed — executed live.\n`,
              'console',
            ));
          }
          this.ffController?.noteDivergence();
        },
      },
      {
        volatileMasks: computeVolatileInputPaths(spec.source.ir),
        getNodeName: () => this.runner?.getCurrentExecutingNodeName() ?? null,
      },
    );

    this.ffHasTarget = spec.target !== null;
    this.ffController = new FastForwardController(spec.target, {
      countOf: (name) => this.executionCounts.get(name) ?? 0,
      isRootFrame: () => (this.runner?.getCallStackDepth() ?? 0) === 0,
      onArrived: (reason) => {
        this.sendEvent(new OutputEvent(
          reason === 'target'
            ? spec.mode === 'rewind'
              ? '— rewound to previous position —\n'
              : '— resumed at previous position —\n'
            : '— stopped at first divergence —\n',
          'console',
        ));
      },
    });

    this.runner = this.createRunner(spec.source, false);
    this.reapplyBreakpoints();
    void this.runner.start();
    return { ok: true };
  }

  protected async restartRequest(
    response: DebugProtocol.RestartResponse,
    _args: DebugProtocol.RestartArguments,
  ): Promise<void> {
    if (this.busy) {
      this.sendErrorResponse(response, 1010, 'A restart or jump is already in progress.');
      return;
    }
    // A failed launch leaves no host and no connectors — there is nothing a
    // relaunch could run.
    if (!this.host || !this.launchArgs) {
      this.sendErrorResponse(response, 1014, 'Nothing to restart — start a debug session first.');
      return;
    }
    this.busy = true;
    try {
      const mode = chooseRestartMode({ hasRunner: !!this.runner, paused: this.paused });

      // Recompile from the editor buffer (or disk). A compile failure — or an
      // unreadable program file — aborts before anything is torn down: the old
      // session stays paused. Reading the source is inside the try so a deleted
      // file cannot throw out of this async handler (the DAP dispatcher ignores
      // the returned promise, so that would hang the request with no response).
      let sourceContent: string;
      let ir: FlowIR;
      let sourceMap: DslSourceMap;
      try {
        sourceContent = this.currentSourceText();
        ir = transformCode(sourceContent);
        sourceMap = buildSourceMapFromDsl(sourceContent, ir);
      } catch (err: any) {
        this.sendEvent(new OutputEvent(`Compilation error: ${err.message}\n`, 'stderr'));
        this.sendErrorResponse(response, 1011, `Restart failed to compile: ${err.message}`);
        return;
      }
      const source: DebugFlowSource = { key: this.sourceFile, ir, sourceMap, dslCode: sourceContent };

      if (mode === 'clean') {
        this.sendEvent(new OutputEvent('Restarting (clean run)…\n', 'console'));
        await this.restartClean(source);
        this.sendResponse(response);
        return;
      }

      // Hot restart: target the paused position (or, inside a child flow, the
      // root-frame caller action — v1 semantics).
      const stack = this.runner!.getCallStack();
      const targetName = stack.length > 0
        ? (stack[0].callerNodeId ? this.rootNodeIndex.get(stack[0].callerNodeId)?.name ?? null : null)
        : (this.runner!.getCurrentNode()?.name ?? null);
      const target = computeFastForwardTarget(targetName, ir, this.executionCounts);

      this.sendEvent(new OutputEvent('— applied changes, fast-forwarding —\n', 'console'));
      if (targetName && !target) {
        this.sendEvent(new OutputEvent(
          `Note: previous position '${targetName}' no longer exists; running to next divergence, breakpoint, or completion.\n`,
          'console',
        ));
      }

      const relaunched = await this.relaunchWithReplay({ source, target, mode: 'apply' });
      if (!relaunched.ok) {
        this.sendEvent(new OutputEvent(`${relaunched.error}\n`, 'stderr'));
        this.sendErrorResponse(response, 1012, relaunched.error);
        return;
      }
      this.sendResponse(response);
    } catch (err: any) {
      // Anything past the compile gate (createRunner, buildNodeIndex, …): the
      // DAP dispatcher ignores this handler's promise, so an escaping throw
      // would leave the request unanswered and surface as an unhandled
      // rejection.
      this.sendEvent(new OutputEvent(`Restart failed: ${err.message}\n`, 'stderr'));
      this.sendErrorResponse(response, 1013, `Restart failed: ${err.message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Clean restart: silent teardown, fresh recording proxies, honor stopOnEntry. */
  private async restartClean(source: DebugFlowSource): Promise<void> {
    const old = this.runner;
    // Skip the handshake for a runner that already terminated: stop() would
    // never fire onTerminated again, so this would just stall 2s.
    if (old && this.runnerAlive) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          // Unlike relaunchWithReplay (which aborts on timeout, so a late
          // TerminatedEvent correctly ends the dead session), a clean restart
          // relaunches anyway — so `old` stays registered as silenced (with a
          // null resolver): if it terminates late its event must still be
          // swallowed, or it would kill the healthy new session.
          this.silencedRunners.set(old, null);
          resolve();
        }, 2000);
        this.silencedRunners.set(old, () => {
          clearTimeout(timer);
          resolve();
        });
        this.paused = false;
        old.stop();
      });
    }
    // A disconnect/terminate during the teardown await must not be followed by
    // a brand-new run into a dead adapter.
    if (this.disposed) return;
    this.ffController = null;
    this.ffHasTarget = false;
    this.executionCounts = new Map();
    this.rootNodeIndex = buildNodeIndex(source.ir.nodes);
    this.rootIr = source.ir;
    this.sourceContent = source.dslCode ?? this.sourceContent;
    this.childSourceMaps.clear();
    // See relaunchWithReplay: stale ids resolve to a different statement.
    this.gotoTargetTable.clear();
    this.recordingLog = new ConnectorCallLog();
    this.connectors = wrapConnectorsForRecording(
      this.rawConnectors,
      this.recordingLog,
      () => this.runner?.getCurrentExecutingNodeName() ?? null,
    );
    this.runner = this.createRunner(source, this.launchArgs?.stopOnEntry || false);
    this.reapplyBreakpoints();
    void this.runner.start();
  }

  // --- Set Next Statement (goto) ---

  /**
   * Offer the clicked line as a jump target. Feasibility is NOT decided here:
   * VS Code caches targets, so a target that is legal now can be illegal by
   * the time the user picks it — `gotoRequest` is the single arbiter.
   */
  protected gotoTargetsRequest(
    response: DebugProtocol.GotoTargetsResponse,
    args: DebugProtocol.GotoTargetsArguments,
  ): void {
    const sourcePath = args.source?.path || '';
    const sourceMap = sourcePath ? this.getSourceMapForFile(sourcePath) : null;
    const nodeId = sourceMap ? resolveNodeIdAtLine(sourceMap, args.line) : null;
    if (!sourceMap || !nodeId) {
      response.body = { targets: [] };
      this.sendResponse(response);
      return;
    }
    const line = sourceMap.nodeIdToLines.get(nodeId)?.startLine ?? args.line;
    const id = this.nextGotoTargetId++;
    this.gotoTargetTable.set(id, { key: normalizePath(sourcePath), nodeId });
    response.body = { targets: [{ id, label: `Jump here (line ${line})`, line }] };
    this.sendResponse(response);
  }

  /**
   * Resolve a node id to its name within the ACTIVE frame. `rootNodeIndex`
   * only covers the root flow, and ids collide across compiles, so looking a
   * child-frame id up there would print an unrelated root node's name.
   */
  private activeFrameNodeName(nodeId: string): string {
    const visit = (nodes: Node[]): string | null => {
      for (const n of nodes) {
        if (n.id === nodeId) return n.name;
        const anyNode = n as any;
        for (const list of [anyNode.actions, anyNode.elseActions, anyNode.defaultActions]) {
          if (Array.isArray(list)) {
            const found = visit(list);
            if (found) return found;
          }
        }
        if (Array.isArray(anyNode.cases)) {
          for (const c of anyNode.cases) {
            if (Array.isArray(c.actions)) {
              const found = visit(c.actions);
              if (found) return found;
            }
          }
        }
      }
      return null;
    };
    const stack = this.runner?.getCallStack() ?? [];
    const top = stack.length > 0 ? stack[stack.length - 1] : null;
    if (top) return visit(top.source.ir.nodes) ?? nodeId;
    return this.rootNodeIndex.get(nodeId)?.name ?? nodeId;
  }

  /**
   * Move the execution point. The in-place jump is preferred because it keeps
   * the live context (including variables changed from the debug console);
   * only when the runner rejects it does the restart-based rewind take over,
   * which replays recorded calls and therefore loses console edits.
   */
  protected async gotoRequest(
    response: DebugProtocol.GotoResponse,
    args: DebugProtocol.GotoArguments,
  ): Promise<void> {
    try {
      if (this.busy) {
        this.sendErrorResponse(response, 1013, 'A restart or jump is already in progress.');
        return;
      }
      // Explicit, rather than relying on disposed implying !paused.
      if (this.disposed) {
        this.sendErrorResponse(response, 1013, 'The debug session has been terminated.');
        return;
      }
      const entry = this.gotoTargetTable.get(args.targetId);
      if (!entry || !this.runner) {
        this.sendErrorResponse(response, 1014, 'No jump target available.');
        return;
      }
      if (!this.paused) {
        this.sendErrorResponse(response, 1015, 'Can only jump while paused.');
        return;
      }
      // Where the target lives decides which jump mechanism applies. Node ids
      // are unique only per compile (`transformCode` resets the id counter), so
      // a child flow can contain the same `act_3` as the root — a target from
      // the wrong file would silently move the execution point somewhere the
      // user never clicked.
      //   - active file  → in-place jump first, restart-based rewind as fallback
      //   - root file    → rewind only (reached only when the active frame is a
      //                    child; the rewind restarts the ROOT run, so it is
      //                    correct from any frame)
      //   - anything else → refuse
      const inActiveFile = entry.key === normalizePath(this.runner.getActiveKey());
      const inRootFile = entry.key === normalizePath(this.sourceFile);
      if (!inActiveFile && !inRootFile) {
        this.sendErrorResponse(
          response,
          1015,
          'Can only jump within the file the debugger is currently paused in.',
        );
        return;
      }
      const nodeId = entry.nodeId;
      // Dirty gate: the editor lines the target was resolved from must still be
      // the lines the running session compiled. Reading the source can throw
      // (program deleted) — this handler's promise is ignored by the DAP
      // dispatcher, so it must never escape as an unanswered request.
      let dirty: boolean;
      try {
        dirty = isSourceDirty(this.currentSourceText(), this.sourceContent);
      } catch (err: any) {
        this.sendErrorResponse(
          response,
          1016,
          `Cannot jump: the flow source could not be read (${err.message}).`,
        );
        return;
      }
      if (dirty) {
        this.sendErrorResponse(
          response,
          1016,
          'Apply your edits first (Restart) or revert them — the editor lines no longer match the running flow.',
        );
        return;
      }

      // Preferred: in-place jump — keeps the live context, including variables
      // changed from the debug console. Only attempted for a target in the
      // ACTIVE file; a root-file target while paused in a child frame goes
      // straight to the rewind (see the dispatch above).
      const inPlace = inActiveFile ? this.runner.jumpTo(nodeId) : null;
      if (inPlace?.ok) {
        // Root frame only: `executionCounts` covers the root run alone
        // (onNodeExecuted skips child frames), and child ids can collide with
        // root ids — resolving them against the ROOT index would delete
        // unrelated root counts, corrupting a later hot restart's
        // fast-forward hit and duplicating (name, hit) recording markers.
        if (this.runner.getCallStackDepth() === 0) {
          rewindExecutionCounts(inPlace.resetNodeIds, this.rootNodeIndex, this.executionCounts);
        }
        const name = this.activeFrameNodeName(nodeId);
        this.sendEvent(new OutputEvent(`— jumped to ${name} —\n`, 'console'));
        this.paused = false;
        this.jumpInFlight = true;
        this.sendResponse(response);
        return;
      }

      // Fallback: restart-based rewind (backward only, already-executed
      // non-container root-IR statements).
      const node = this.rootNodeIndex.get(nodeId);
      const decision = evaluateRewindPreconditions({
        node,
        executionCount: node ? (this.executionCounts.get(node.name) ?? 0) : 0,
        // Only surfaces when the target is not in the root IR at all; on the
        // root-file-from-a-child-frame path there is no in-place error to
        // report, so explain why the in-place jump was never attempted.
        inPlaceError: inPlace ? inPlace.error : CHILD_FRAME_JUMP_ERROR,
      });
      if (!decision.ok) {
        this.sendErrorResponse(response, 1017, decision.error);
        return;
      }

      this.busy = true;
      try {
        const hits = decision.hitCount + 1;
        if (!this.recordingLog.truncateBefore(decision.nodeName, hits)) {
          this.sendErrorResponse(
            response,
            1018,
            'Cannot rewind: the recording for this run has no boundary for the target (recording limit reached?).',
          );
          return;
        }
        this.sendEvent(new OutputEvent(
          `— rewinding to ${decision.nodeName} (restarting: recorded calls replay, then ${decision.nodeName} runs live; console variable edits are not preserved) —\n`,
          'console',
        ));
        // Rewind reuses the CURRENTLY RUNNING root source unchanged — no
        // recompile, so node ids, breakpoints and the source map all stay valid.
        const source: DebugFlowSource = {
          key: this.sourceFile,
          ir: this.rootIr!,
          sourceMap: this.runner.getRootSourceMap(),
          dslCode: this.sourceContent,
        };
        const relaunched = await this.relaunchWithReplay({
          source,
          target: { nodeName: decision.nodeName, hitCount: decision.hitCount },
          mode: 'rewind',
        });
        if (!relaunched.ok) {
          this.sendEvent(new OutputEvent(`${relaunched.error}\n`, 'stderr'));
          this.sendErrorResponse(response, 1019, relaunched.error);
          return;
        }
        this.sendResponse(response);
      } finally {
        this.busy = false;
      }
    } catch (err: any) {
      // Same reasoning as restartRequest: an escaping throw would leave the
      // request unanswered and surface as an unhandled rejection. Every path
      // above answers exactly once and returns, so this can only run before a
      // response was sent.
      this.sendEvent(new OutputEvent(`Jump failed: ${err.message}\n`, 'stderr'));
      this.sendErrorResponse(response, 1020, `Jump failed: ${err.message}`);
    }
  }

  // Terminate/disconnect are never dropped, even mid-restart: they set
  // `disposed`, which both relaunch paths check right after their teardown
  // await so a restart in flight cannot start a run into a dead adapter.
  protected terminateRequest(
    response: DebugProtocol.TerminateResponse,
    _args: DebugProtocol.TerminateArguments,
  ): void {
    this.disposed = true;
    this.paused = false;
    this.runner?.stop();
    this.sendResponse(response);
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    _args: DebugProtocol.DisconnectArguments,
  ): void {
    this.disposed = true;
    this.paused = false;
    this.runner?.stop();
    this.sendResponse(response);
  }
}
