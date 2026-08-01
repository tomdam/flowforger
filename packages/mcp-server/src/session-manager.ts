/**
 * The single live debug session and everything around it: start/stop,
 * pause-await with a per-call timeout, breakpoint address resolution,
 * cassette wiring, connector budget, and snapshot construction.
 *
 * At most one session exists at a time — debug_start stops any predecessor.
 */

import * as path from 'path';
import type { Node, FlowIR } from '@flowforger/ir';
import type { BaseConnector, RunContext } from '@flowforger/engine';
import type { DslSourceMap } from '@flowforger/dsl-native';
import {
  DebugSession,
  ConnectorCallLog,
  wrapConnectorsForRecording,
  wrapConnectorsForReplay,
  computeVolatileInputPaths,
  buildNodeIndex,
  findNodeByName,
} from '@flowforger/debug-core';
import { NodeDebugHost, buildConnectors, type ConnectorOptions } from '@flowforger/debug-node';
import { preview, fitToBudget, resolvePath, MAX_RESULT_BYTES, type PathResult } from './summarize.js';
import { loadCassette, saveCassette } from './cassettes.js';
import { wrapConnectorsWithBudget } from './budget.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_BUDGET = 200;
export const IDLE_STOP_MS = 600_000;
const SNAPSHOT_VAR_CAP = 40;
const OUTPUT_LINE_CAP = 20;
const OUTPUT_BYTE_CAP = 2048;

export type BreakpointSpec = { line: number } | { nodeId: string } | { action: string };

export interface ResolvedBreakpoint {
  requested: BreakpointSpec;
  nodeId: string | null;
  name: string | null;
  line: number | null;
  verified: boolean;
}

export type ScopeName = 'variables' | 'actions' | 'trigger' | 'parameters';

export interface Snapshot {
  state: 'paused' | 'terminated' | 'running';
  reason?: 'entry' | 'breakpoint' | 'step';
  node?: { id: string; name: string; type: string };
  file?: string;
  line?: number | null;
  flow?: string;
  stackDepth?: number;
  iteration?: { loop: string; index: number; total?: number };
  variables?: Record<string, unknown>;
  lastAction?: { name: string; status: string; outputs: unknown };
  status?: string;
  error?: string;
  actionsRun?: number;
  budget: { used: number; limit: number };
  replay: { replayed: number; live: number };
  output: string[];
}

export interface StartOptions {
  file: string;
  triggerPayload?: unknown;
  variables?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  breakpoints?: BreakpointSpec[];
  stopOnEntry?: boolean;
  mode?: 'replay' | 'live';
  budget?: number;
  timeoutMs?: number;
}

export interface SessionManagerDeps {
  connectorOptions: ConnectorOptions;
  /** Override the cassette directory (tests pass a temp dir). */
  cassetteRoot?: string;
  defaultBudget?: number;
  /** Resolve tokens lazily on first start; returns extra connector options. */
  resolveAuth?: (ir: FlowIR) => Promise<ConnectorOptions>;
}

interface LiveSession {
  session: DebugSession;
  host: NodeDebugHost;
  rootFile: string;
  recordingLog: ConnectorCallLog;
  budgetUsed: () => number;
  budgetLimit: number;
  replayed: number;
  live: number;
  terminated: boolean;
  terminalError?: string;
  /** Whether this run was asked to stop before its first node. */
  stopOnEntry: boolean;
  /**
   * True once the first pause has been reported to the caller. DebugSession's
   * own `onStopped` reason is only ever 'breakpoint' or 'step' — it has no
   * concept of "entry". The manager derives 'entry' itself: the very first
   * non-breakpoint pause of a stopOnEntry run.
   */
  entryReported: boolean;
  /** The IR the session is actually running — stashed so a mid-session DSL edit on disk can't desync breakpoint node ids from a fresh recompile. */
  rootIr: FlowIR;
  /** The last reason reported via buildPaused, for status() to reuse without guessing 'step'. */
  lastReason?: Snapshot['reason'];
  /** Call count of the cassette this session was seeded from (0 if none). */
  previousCallCount: number;
  /** Live phase, tracked independently of DebugSession's own state so status() never reports a stale pause. */
  phase: 'paused' | 'running' | 'terminated';
}

export class SessionManager {
  private deps: SessionManagerDeps;
  private current: LiveSession | null = null;
  private outputBuffer: string[] = [];
  private pendingStop: Promise<Snapshot> | null = null;
  private resolveStop: ((snap: Snapshot) => void) | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private authCache: ConnectorOptions | null = null;
  /** A stop that arrived while no caller was waiting; the next call claims it. */
  private lastUnclaimed: Snapshot | null = null;

  constructor(deps: SessionManagerDeps) {
    this.deps = deps;
  }

  // --- lifecycle -----------------------------------------------------------

  async start(opts: StartOptions): Promise<Snapshot> {
    await this.stop();
    this.outputBuffer = [];
    this.lastUnclaimed = null;

    const rootFile = path.resolve(opts.file);
    const host = new NodeDebugHost((text) => this.pushOutput(text));
    const source = host.compileFile(rootFile);
    if (!source) throw new Error(`Failed to compile flow '${rootFile}' — check the DSL for parse errors.`);

    let connectorOptions = this.deps.connectorOptions;
    if (this.deps.resolveAuth) {
      this.authCache ??= await this.deps.resolveAuth(source.ir);
      connectorOptions = { ...connectorOptions, ...this.authCache };
    }

    const budgetLimit = opts.budget ?? this.deps.defaultBudget ?? DEFAULT_BUDGET;
    const budgeted = wrapConnectorsWithBudget(buildConnectors(connectorOptions), budgetLimit);

    const recordingLog = new ConnectorCallLog();
    // Replay (default) layers OVER the budget proxy, so replayed calls are free.
    const previousLog = opts.mode === 'live' ? null : loadCassette(rootFile, this.deps.cassetteRoot);
    const live: LiveSession = {
      session: null as unknown as DebugSession,
      host,
      rootFile,
      recordingLog,
      budgetUsed: budgeted.used,
      budgetLimit,
      replayed: 0,
      live: 0,
      terminated: false,
      stopOnEntry: opts.stopOnEntry ?? true,
      entryReported: false,
      rootIr: source.ir,
      previousCallCount: previousLog?.calls.length ?? 0,
      phase: 'running',
    };

    const volatileMasks = computeVolatileInputPaths(source.ir);
    const getNodeName = () => live.session?.getCurrentExecutingNodeName() ?? null;

    const connectors: Record<string, BaseConnector> = previousLog
      ? wrapConnectorsForReplay(
          budgeted.connectors,
          previousLog,
          recordingLog,
          {
            onReplayed: () => { live.replayed++; },
            onDivergence: (connector, operation) => {
              live.live++;
              this.pushOutput(`Divergence: ${connector}.${operation} inputs changed — executed live.`);
            },
          },
          { volatileMasks, getNodeName },
        )
      : wrapConnectorsForRecording(budgeted.connectors, recordingLog, getNodeName);

    const session = new DebugSession(
      source,
      host,
      connectors,
      opts.triggerPayload ?? {},
      (opts.variables ?? {}) as Record<string, any>,
      opts.stopOnEntry ?? true,
      {
        onStopped: (reason, nodeId) => {
          if (this.current !== live) return; // a superseded session's late event
          live.phase = 'paused';
          this.settle(this.buildPaused(reason, nodeId));
        },
        onOutput: (text) => {
          if (this.current !== live) return;
          this.pushOutput(text);
        },
        onTerminated: () => {
          if (this.current !== live) return; // ditto — must not settle the new session
          live.terminated = true;
          live.phase = 'terminated';
          this.settle(this.buildTerminated());
        },
      },
      (opts.parameters ?? {}) as Record<string, any>,
    );
    live.session = session;
    this.current = live;

    if (opts.breakpoints?.length) this.setBreakpoints({ breakpoints: opts.breakpoints });

    const stop = this.armStop();
    void session.start().catch((err: any) => {
      if (this.current !== live) return; // a superseded session's late rejection
      live.terminalError = err?.message ?? String(err);
      live.terminated = true;
      this.settle(this.buildTerminated());
    });
    return this.race(stop, opts.timeoutMs);
  }

  async resume(action: 'continue' | 'step', opts: { into?: boolean; timeoutMs?: number }): Promise<Snapshot> {
    const live = this.require();
    if (live.terminated) return this.buildTerminated();

    // A stop arrived while nobody was waiting. Deliver it and do NOT resume —
    // the agent has not seen this position yet and must be able to inspect it.
    // Its next call resumes from here as normal.
    if (this.lastUnclaimed) {
      const parked = this.lastUnclaimed;
      this.lastUnclaimed = null;
      return parked;
    }

    live.session.setWantStepIn(action === 'step' && opts.into === true);
    const stop = this.armStop();
    live.phase = 'running';
    live.session.resume(action);
    return this.race(stop, opts.timeoutMs);
  }

  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const live = this.current;
    if (!live) return;
    try {
      live.session.stop();
    } catch {
      /* already finished */
    }
    // Only persist a cassette that is at least as complete as the one we
    // loaded. An agent that pauses early and restarts must not truncate a
    // good cassette to the prefix it happened to execute.
    const recorded = live.recordingLog.calls.length;
    if (recorded > 0 && (live.terminated || recorded >= live.previousCallCount)) {
      try {
        saveCassette(live.rootFile, live.recordingLog, this.deps.cassetteRoot);
      } catch (err: any) {
        this.pushOutput(`Warning: could not write cassette — ${err?.message ?? err}`);
      }
    }
    this.current = null;
    this.pendingStop = null;
    this.resolveStop = null;
    this.lastUnclaimed = null;
  }

  status(): { active: boolean; snapshot?: Snapshot; pendingStop?: boolean } {
    const live = this.current;
    if (!live) return { active: false };
    const pendingStop = this.lastUnclaimed != null;
    if (live.phase === 'terminated') return { active: true, snapshot: this.buildTerminated(false), pendingStop };
    if (live.phase === 'running') return { active: true, snapshot: this.buildRunning(false), pendingStop };
    return { active: true, snapshot: this.buildPausedFromState(live.lastReason ?? 'step', undefined, false), pendingStop };
  }

  // --- breakpoints ---------------------------------------------------------

  setBreakpoints(args: { file?: string; breakpoints: BreakpointSpec[] }): ResolvedBreakpoint[] {
    const live = this.require();
    const key = args.file ? path.resolve(args.file) : live.session.getRootKey();
    const source = this.sourceForKey(key);
    const ir = source?.ir ?? null;
    const index = ir ? buildNodeIndex(ir.nodes) : new Map<string, Node>();
    const sourceMap = source?.sourceMap ?? null;

    const resolved: ResolvedBreakpoint[] = [];
    const entries: Array<{ nodeId: string; line: number }> = [];

    if (!source) {
      return args.breakpoints.map((spec) => ({
        requested: spec,
        nodeId: null,
        name: null,
        line: null,
        verified: false,
      }));
    }

    for (const spec of args.breakpoints) {
      let node: Node | undefined;
      let line: number | null = null;

      if ('nodeId' in spec) {
        node = index.get(spec.nodeId);
        line = this.lineForNode(sourceMap, node);
      } else if ('action' in spec) {
        node = ir ? (findNodeByName(ir.nodes, spec.action) ?? undefined) : undefined;
        line = this.lineForNode(sourceMap, node);
      } else {
        const snapped = live.session.findNearestBreakpointableLine(spec.line, sourceMap ?? undefined);
        line = snapped;
        node = snapped != null ? this.nodeForLine(sourceMap, index, snapped) : undefined;
      }

      const verified = !!node && line != null;
      resolved.push({
        requested: spec,
        nodeId: node?.id ?? null,
        name: (node as any)?.name ?? null,
        line,
        verified,
      });
      if (verified) entries.push({ nodeId: node!.id, line: line! });
    }

    // Full-list semantics per source, matching the DAP adapter.
    live.session.setBreakpointsForSource(key, entries);
    return resolved;
  }

  // --- inspection ----------------------------------------------------------

  getScope(args: { scope: ScopeName | 'all'; frameIndex?: number; depth?: number }): { value: any; note?: string } {
    const ctx = this.frameContext(args.frameIndex ?? 0);
    const depth = args.depth ?? 1;
    if (args.scope !== 'all') {
      const fitted = fitToBudget(this.scopeRoot(ctx, args.scope), depth);
      return { value: fitted.preview, note: fitted.note };
    }
    // Each scope is budgeted independently — running the combined object back
    // through fitToBudget/preview would re-one-line each already-rendered
    // scope (preview() renders a nested object's children at depth-1, and
    // those children are already-rendered objects, not raw values), which is
    // the exact bug this fix removes. So the combined check is a byte-size
    // check only, never a re-preview.
    const scopes: ScopeName[] = ['variables', 'actions', 'trigger', 'parameters'];
    const value: Record<string, unknown> = {};
    const notes: string[] = [];
    for (const name of scopes) {
      const fitted = fitToBudget(this.scopeRoot(ctx, name), depth);
      value[name] = fitted.preview;
      if (fitted.note) notes.push(`${name}: ${fitted.note}`);
    }
    let outValue: unknown = value;
    const json = JSON.stringify(value) ?? '';
    if (new TextEncoder().encode(json).length > MAX_RESULT_BYTES) {
      outValue = `${json.slice(0, 1000)}… (truncated to fit the ${MAX_RESULT_BYTES}-byte ceiling)`;
      notes.push(`Combined result exceeded ${MAX_RESULT_BYTES} bytes even after per-scope budgeting and was hard-truncated.`);
    }
    return { value: outValue, note: notes.filter(Boolean).join(' ') || undefined };
  }

  getValue(args: { scope: ScopeName; path: string; frameIndex?: number; depth?: number }): PathResult & { note?: string } {
    const ctx = this.frameContext(args.frameIndex ?? 0);
    const found = resolvePath(this.scopeRoot(ctx, args.scope), args.path);
    if (!found.ok) return found;
    const fitted = fitToBudget(found.value, args.depth ?? 2);
    return { ok: true, value: fitted.preview, note: fitted.note };
  }

  evaluate(expression: string): { result: string; value?: unknown } {
    const live = this.require();
    const outcome = live.session.evaluate(expression);
    return { result: outcome.result, value: preview(outcome.value, 1) };
  }

  callStack(): Array<{ index: number; flow: string; file: string; iteration?: Snapshot['iteration'] }> {
    const live = this.require();
    const frames = this.logicalFrames();
    const iteration = this.iterationInfo();
    return frames.map((frame, index) => ({
      index,
      flow: frame.name,
      file: live.host.displayName(frame.key),
      ...(index === 0 && iteration ? { iteration } : {}),
    }));
  }

  // --- internals -----------------------------------------------------------

  private require(): LiveSession {
    if (!this.current) throw new Error('No active session — call debug_start first.');
    this.touchIdle();
    return this.current;
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.stop(); }, IDLE_STOP_MS);
    this.idleTimer.unref?.();
  }

  /** Create (or reuse) the deferred that the next onStopped/onTerminated resolves. */
  private armStop(): Promise<Snapshot> {
    if (!this.pendingStop) {
      this.pendingStop = new Promise<Snapshot>((resolve) => { this.resolveStop = resolve; });
    }
    return this.pendingStop;
  }

  private settle(snapshot: Snapshot): void {
    const resolve = this.resolveStop;
    this.pendingStop = null;
    this.resolveStop = null;
    if (resolve) resolve(snapshot);
    else this.lastUnclaimed = snapshot; // hold it rather than dropping it
  }

  /**
   * Race the next stop against a timeout. On expiry the caller gets `running`
   * and ownership of the pending stop transfers to `lastUnclaimed`, so the
   * next call receives it rather than the event being dropped.
   */
  private async race(stop: Promise<Snapshot>, timeoutMs?: number): Promise<Snapshot> {
    this.touchIdle();
    const limit = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (limit === 0) {
      this.detach(stop);
      return this.buildRunning();
    }
    const TIMEOUT = Symbol('timeout');
    let timer: NodeJS.Timeout | undefined;
    const running = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), limit);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([stop, running]);
      if (outcome === TIMEOUT) {
        this.detach(stop);
        return this.buildRunning();
      }
      return outcome as Snapshot;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Nobody awaits this stop any more — park its result for the next call. */
  private detach(stop: Promise<Snapshot>): void {
    void stop.then((snap) => {
      this.lastUnclaimed = snap;
    });
  }

  private pushOutput(text: string): void {
    this.outputBuffer.push(text);
    if (this.outputBuffer.length > OUTPUT_LINE_CAP * 4) {
      this.outputBuffer.splice(0, this.outputBuffer.length - OUTPUT_LINE_CAP * 4);
    }
  }

  private collectOutput(drain: boolean): string[] {
    const recent = this.outputBuffer.slice(-OUTPUT_LINE_CAP);
    const picked: string[] = [];
    let bytes = 0;
    // Newest-first so a large early line cannot evict later ones.
    for (let i = recent.length - 1; i >= 0; i--) {
      bytes += recent[i].length;
      if (bytes > OUTPUT_BYTE_CAP && picked.length > 0) break;
      picked.push(recent[i]);
    }
    picked.reverse();
    if (drain) this.outputBuffer = [];
    return picked;
  }

  private counters(): Pick<Snapshot, 'budget' | 'replay'> {
    const live = this.current;
    return {
      budget: { used: live?.budgetUsed() ?? 0, limit: live?.budgetLimit ?? 0 },
      replay: { replayed: live?.replayed ?? 0, live: live?.live ?? 0 },
    };
  }

  /** IR + source map for a key: the live root, or a freshly compiled child. */
  private sourceForKey(key: string): { ir: FlowIR; sourceMap: DslSourceMap | null } | null {
    const live = this.current;
    if (!live) return null;
    if (live.host.normalizeKey(key) === live.host.normalizeKey(live.session.getRootKey())) {
      return { ir: live.rootIr, sourceMap: live.session.getRootSourceMap() };
    }
    const fromSession = live.session.getSourceMapForKey(key);
    const compiled = live.host.compileFile(key);
    if (!compiled) return null;
    return { ir: compiled.ir, sourceMap: fromSession ?? compiled.sourceMap };
  }

  /** DslSourceMap.nodeIdToLines maps node id -> { startLine, endLine } (1-based). */
  private lineForNode(sourceMap: DslSourceMap | null, node: Node | undefined): number | null {
    if (!node || !sourceMap) return null;
    return sourceMap.nodeIdToLines.get(node.id)?.startLine ?? null;
  }

  /** DslSourceMap.lineToNodeId is the inverse index, so a snapped line resolves directly. */
  private nodeForLine(sourceMap: DslSourceMap | null, index: Map<string, Node>, line: number): Node | undefined {
    const nodeId = sourceMap?.lineToNodeId.get(line);
    return nodeId ? index.get(nodeId) : undefined;
  }

  private logicalFrames(): Array<{ ctx: RunContext; key: string; name: string }> {
    const live = this.require();
    const stack = live.session.getCallStack();
    const frames: Array<{ ctx: RunContext; key: string; name: string }> = [];
    // getCallStack() holds child frames only; innermost first, root appended last.
    for (let i = stack.length - 1; i >= 0; i--) {
      frames.push({ ctx: stack[i].ctx, key: stack[i].source.key, name: stack[i].source.ir.name });
    }
    frames.push({
      ctx: live.session.getRootContext(),
      key: live.session.getRootKey(),
      name: live.session.getRootFlowName(),
    });
    return frames;
  }

  private frameContext(frameIndex: number): RunContext {
    const frames = this.logicalFrames();
    const frame = frames[frameIndex];
    if (!frame) throw new Error(`No frame at index ${frameIndex} — the stack has ${frames.length} frame(s).`);
    return frame.ctx;
  }

  private actionsView(ctx: RunContext): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, action] of ctx.actions) {
      const inputs = (action as any).inputs;
      out[name] = {
        status: (action as any).status,
        // Only connector/HTTP/child-flow actions resolve an invocation payload;
        // omitted elsewhere so the view stays as terse as it was.
        ...(inputs !== undefined ? { inputs } : {}),
        outputs: (action as any).outputs,
        error: (action as any).error,
      };
    }
    return out;
  }

  private scopeRoot(ctx: RunContext, scope: ScopeName): unknown {
    switch (scope) {
      case 'variables': return ctx.variables;
      case 'actions': return this.actionsView(ctx);
      case 'trigger': return ctx.triggerData;
      case 'parameters': return ctx.parameters;
    }
  }

  private iterationInfo(): Snapshot['iteration'] {
    const info = this.current?.session.getIterationContext();
    if (!info) return undefined;
    // debug-core hard-codes totalIterations: 0 — the engine does not expose a
    // loop's length (see debug-session.ts, updateIterationContext). Omit the
    // field rather than reporting a misleading "of 0"; if the engine ever does
    // expose it, this starts populating automatically.
    return {
      loop: info.parentNodeName,
      index: info.iterationIndex,
      ...(info.totalIterations > 0 ? { total: info.totalIterations } : {}),
    };
  }

  private snapshotVariables(): Record<string, unknown> {
    const live = this.current;
    if (!live) return {};
    const ctx = live.session.getContext();
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [key, value] of Object.entries(ctx.variables)) {
      if (n++ >= SNAPSHOT_VAR_CAP) {
        out['…'] = `${Object.keys(ctx.variables).length - SNAPSHOT_VAR_CAP} more variables`;
        break;
      }
      out[key] = preview(value, 0);
    }
    return out;
  }

  private lastAction(): Snapshot['lastAction'] {
    const ctx = this.current?.session.getContext();
    if (!ctx) return undefined;
    let last: { name: string; entry: any } | null = null;
    for (const [name, entry] of ctx.actions) last = { name, entry };
    if (!last) return undefined;
    return { name: last.name, status: last.entry.status, outputs: preview(last.entry.outputs, 0) };
  }

  /**
   * DebugSession's own reason is only ever 'breakpoint' or 'step' — see the
   * LiveSession.entryReported doc comment. The manager relabels the first
   * non-breakpoint pause of a stopOnEntry run as 'entry'.
   */
  private buildPaused(reason: string, nodeId: string): Snapshot {
    const live = this.current;
    let effective: Snapshot['reason'];
    if (reason === 'breakpoint') {
      effective = 'breakpoint';
    } else if (live && live.stopOnEntry && !live.entryReported) {
      effective = 'entry';
    } else {
      effective = 'step';
    }
    if (live) {
      live.entryReported = true;
      live.lastReason = effective;
    }
    return this.buildPausedFromState(effective, nodeId);
  }

  private buildPausedFromState(reason: Snapshot['reason'] = 'step', nodeId?: string, drain: boolean = true): Snapshot {
    const live = this.current!;
    const node = live.session.getCurrentNode();
    const sourceMap = live.session.getActiveSourceMap();
    const activeKey = live.session.getActiveKey();
    return {
      state: 'paused',
      reason,
      node: node
        ? { id: node.id, name: (node as any).name ?? node.id, type: node.type }
        : nodeId
          ? { id: nodeId, name: nodeId, type: 'unknown' }
          : undefined,
      file: live.host.displayName(activeKey),
      line: this.lineForNode(sourceMap, node ?? undefined),
      flow: live.session.getRootFlowName(),
      stackDepth: live.session.getCallStackDepth(),
      iteration: this.iterationInfo(),
      variables: this.snapshotVariables(),
      lastAction: this.lastAction(),
      ...this.counters(),
      output: this.collectOutput(drain),
    };
  }

  private buildTerminated(drain: boolean = true): Snapshot {
    const live = this.current;
    const ctx = live?.session.getRootContext();
    let failed = false;
    if (ctx) for (const [, entry] of ctx.actions) if ((entry as any).status === 'Failed') failed = true;
    return {
      state: 'terminated',
      status: live?.terminalError ? 'Failed' : failed ? 'Failed' : 'Succeeded',
      error: live?.terminalError,
      actionsRun: ctx ? ctx.actions.size : 0,
      ...this.counters(),
      output: this.collectOutput(drain),
    };
  }

  private buildRunning(drain: boolean = true): Snapshot {
    return {
      state: 'running',
      ...this.counters(),
      output: this.collectOutput(drain),
    };
  }
}
