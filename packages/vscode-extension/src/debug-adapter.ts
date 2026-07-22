/**
 * FlowForger DAP Debug Adapter
 *
 * Implements the VS Code Debug Adapter Protocol for .ff.ts files.
 * Compiles DSL to IR, builds a source map, and uses FlowForgerDebugRunner
 * for step-by-step execution with breakpoints.
 * Supports multi-file debugging for child flow step-in.
 */

import {
  DebugSession,
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
import { FlowForgerDebugRunner, type ConnectorOptions } from './debug-runner.js';

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

/** Normalize a file path for comparison (case-insensitive on Windows). */
function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

class FlowForgerDebugSession extends DebugSession {
  private runner: FlowForgerDebugRunner | null = null;
  private sourceFile = '';
  private sourceFileNorm = '';

  // Expandable variable references
  private nextVarRef = 100;
  private expandableVars = new Map<number, any>();

  // Pending breakpoints per source file (set before launch completes)
  private pendingBreakpoints = new Map<string, number[]>();

  // Compiled source maps for child flow files (cached for breakpoint validation)
  private childSourceMaps = new Map<string, DslSourceMap>();

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

    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
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

      // Connector options
      const connectorOptions: ConnectorOptions = {
        spToken: args.spToken,
        dvUrl: args.dvUrl,
        dvToken: args.dvToken,
        graphToken: args.graphToken,
      };

      // Create the debug runner (now with filePath)
      this.runner = new FlowForgerDebugRunner(
        ir,
        sourceMap,
        this.sourceFile,
        triggerPayload,
        args.variables || {},
        args.stopOnEntry || false,
        connectorOptions,
        {
          onStopped: (reason: string, _nodeId: string) => {
            // Clear expandable vars on each stop for clean state
            this.expandableVars.clear();
            this.nextVarRef = 100;
            this.sendEvent(new StoppedEvent(reason, THREAD_ID));
          },
          onOutput: (text: string, category: string) => {
            this.sendEvent(new OutputEvent(text + '\n', category));
          },
          onTerminated: () => {
            this.sendEvent(new TerminatedEvent());
          },
        },
        args.parameters,
      );

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
      return this.runner.getSourceMap();
    }

    // Check runner (may have it from call stack or compilation)
    if (this.runner) {
      const sm = this.runner.getSourceMapForFile(filePath);
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
    if (fs.existsSync(filePath) && filePath.endsWith('.ff.ts')) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const ir = transformCode(content);
        const sm = buildSourceMapFromDsl(content, ir);
        this.childSourceMaps.set(norm, sm);
        return sm;
      } catch {
        return null;
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
    this.runner.setBreakpointsForFile(path.resolve(filePath), breakpointEntries);

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
        const activeFilePath = this.runner.getActiveFilePath();
        const entry = activeSourceMap.nodeIdToLines.get(currentNode.id);
        const line = entry?.startLine || 1;
        const src = new Source(path.basename(activeFilePath), activeFilePath);

        frames.push(new StackFrame(0, currentNode.name, src, line, 1));

        // If inside a foreach/dountil iteration, add iteration frame
        const iterCtx = this.runner.getIterationContext();
        if (iterCtx) {
          const parentEntry = activeSourceMap.nodeIdToLines.get(iterCtx.parentNodeId);
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
          const parentFilePath = i > 0 ? callStack[i - 1].filePath : this.runner.getRootFilePath();
          const parentSourceMap = i > 0 ? callStack[i - 1].sourceMap : this.runner.getSourceMap();
          const parentSrc = new Source(path.basename(parentFilePath), parentFilePath);

          // Look up the callWorkflow line in the parent's source map
          let callerLine = 1;
          if (frame.callerNodeId && parentSourceMap) {
            const entry = parentSourceMap.nodeIdToLines.get(frame.callerNodeId);
            if (entry) {
              callerLine = entry.startLine;
            }
          }

          const label = i > 0 ? `[child flow] ${callStack[i - 1].ir.name}` : `[root] ${this.runner.getSourceMap() ? this.runner.getRootFlowName() || 'Flow' : 'Flow'}`;
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

  protected continueRequest(
    response: DebugProtocol.ContinueResponse,
    _args: DebugProtocol.ContinueArguments,
  ): void {
    if (this.runner) {
      this.runner.setWantStepIn(false);
      this.runner.resume('continue');
    }
    response.body = { allThreadsContinued: true };
    this.sendResponse(response);
  }

  protected nextRequest(
    response: DebugProtocol.NextResponse,
    _args: DebugProtocol.NextArguments,
  ): void {
    if (this.runner) {
      // F10: Step over — don't step into child flows
      this.runner.setWantStepIn(false);
      this.runner.resume('step');
    }
    this.sendResponse(response);
  }

  protected stepInRequest(
    response: DebugProtocol.StepInResponse,
    _args: DebugProtocol.StepInArguments,
  ): void {
    if (this.runner) {
      // F11: Step in — step into child flows if on a workflow action
      this.runner.setWantStepIn(true);
      this.runner.resume('step');
    }
    this.sendResponse(response);
  }

  protected stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    _args: DebugProtocol.StepOutArguments,
  ): void {
    if (this.runner) {
      // Shift+F11: Step out — if in child flow, run to completion and return to parent
      this.runner.setWantStepIn(false);
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

  protected terminateRequest(
    response: DebugProtocol.TerminateResponse,
    _args: DebugProtocol.TerminateArguments,
  ): void {
    this.runner?.stop();
    this.sendResponse(response);
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    _args: DebugProtocol.DisconnectArguments,
  ): void {
    this.runner?.stop();
    this.sendResponse(response);
  }
}
