/**
 * Pins: replaying a cloud run locally. Every leaf action the run recorded becomes a pin —
 * keyed by its name and the enclosing loops' item indexes — carrying the cloud's outputs
 * (or its failure). Pinned actions do not run: the engine takes the recorded result through
 * `pinsToMockResolver`; unpinned actions run live, and everything the pins do not cover
 * (Composes, variables, conditions, an action the run never reached) recomputes.
 *
 * By default the actions that call out (connector, HTTP, child flow) are pinned and the rest
 * are not. A pin is unavailable when the cloud recorded nothing to replay: a Skipped action,
 * a Succeeded action whose outputs were not downloadable (secure outputs), or an action
 * the local flow no longer has.
 */
import type { FlowIR, Node } from '@flowforger/ir';
import { loopIndexes, type LoopIndex, type MockResolver, type MockResult } from '@flowforger/engine';
import type { CloudTraceEntry } from './cloud-trace.js';

/**
 * Why a pin cannot replay: the action was Skipped (nothing recorded), an external action's outputs
 * were not downloadable (secure outputs), a non-external action recorded none (a Terminate), or the
 * local flow has no action of that name — or (restored from a saved scenario) its outputs were
 * deferred and never downloaded before the save.
 */
export type PinUnavailableReason = 'skipped' | 'secure' | 'no-outputs' | 'not-in-flow' | 'not-downloaded';

export interface CloudPin {
  name: string;
  /** The enclosing loops' item indexes, outermost first; empty at top level. */
  iterationPath: LoopIndex[];
  /** The cloud's status. */
  status: string;
  outputs?: unknown;
  /**
   * The outputs exist in the cloud but were not fetched yet (a host defers a local action's
   * outputs until the pin is checked). The pin is available and unpinned until they arrive.
   */
  outputsDeferred?: true;
  error?: unknown;
  code?: string;
  /** A connector, HTTP or child-flow action (in the local flow). */
  external: boolean;
  /** Whether the pin can stand in for the action. */
  available: boolean;
  unavailableReason?: PinUnavailableReason;
  /** Replay this pin (default: external and available). Unpinned actions run live. */
  pinned: boolean;
}

export interface CloudRunPins {
  /** The trigger's recorded outputs (`{ headers, body }`), usable whole as the run input. */
  triggerOutputs?: unknown;
  pins: CloudPin[];
}

/** An action that reaches a service outside this machine: a connector call, an HTTP action, or a child flow. */
export function isExternalCall(node: Node): boolean {
  if (node.type === 'connector') return true;
  const kind = (node as any).kind;
  return node.type === 'action' && (kind === 'http' || kind === 'workflow');
}

const BLOCK_TYPES = new Set(['scope', 'if', 'switch', 'foreach', 'dountil']);

/** Every node of the flow by name, at any depth. */
function nodesByName(ir: FlowIR): Map<string, Node> {
  const map = new Map<string, Node>();
  const visit = (nodes: Node[] | undefined) => {
    for (const node of nodes ?? []) {
      map.set(node.name, node);
      const n = node as any;
      visit(n.actions);
      visit(n.elseActions);
      for (const c of n.cases ?? []) visit(c.actions);
      visit(n.defaultActions);
    }
  };
  visit(ir.nodes);
  return map;
}

/** The key a pin is looked up by: the action name plus its iteration path. */
export function pinKey(name: string, iterationPath: LoopIndex[]): string {
  return iterationPath.length === 0
    ? name
    : `${name}@${iterationPath.map((i) => `${i.scopeName}[${i.itemIndex}]`).join('/')}`;
}

/**
 * The pins of a cloud run (`buildCloudTrace`), classified against `ir` — the flow the pins
 * will be applied to, so an action the run recorded but the flow no longer has is reported
 * as such rather than silently ignored.
 *
 * `options.deferredOutputs(name, iterationPath)` says whether a non-external pin that has no
 * outputs yet will get them later (the host fetches local actions' outputs lazily): such a pin
 * is marked `outputsDeferred` and stays available instead of becoming `no-outputs`.
 */
export interface CloudRunToPinsOptions {
  deferredOutputs?: (name: string, iterationPath: LoopIndex[]) => boolean;
}

export function cloudRunToPins(trace: CloudTraceEntry[], ir: FlowIR, options: CloudRunToPinsOptions = {}): CloudRunPins {
  const nodes = nodesByName(ir);
  const result: CloudRunPins = { pins: [] };

  const visit = (entries: CloudTraceEntry[], path: LoopIndex[]) => {
    for (const e of entries) {
      if (e.trigger) {
        if (path.length === 0 && result.triggerOutputs === undefined) result.triggerOutputs = e.outputs;
        continue;
      }
      if (e.children) {
        visit(e.children, path);
        continue;
      }
      if (e.iterations) {
        for (const it of e.iterations) visit(it.actions, [...path, { scopeName: e.name, itemIndex: it.index }]);
        continue;
      }
      const node = nodes.get(e.name);
      // A block the run recorded without a body (nothing inside it ran) is still a block, not a pin.
      if (node && BLOCK_TYPES.has(node.type)) continue;
      const external = node ? isExternalCall(node) : false;
      const pin: CloudPin = {
        name: e.name,
        iterationPath: path,
        status: e.status,
        ...(e.outputs !== undefined ? { outputs: e.outputs } : {}),
        ...(e.error !== undefined ? { error: e.error } : {}),
        ...(e.code !== undefined ? { code: e.code } : {}),
        external,
        available: true,
        pinned: false,
      };
      const noOutputsYet = e.status !== 'Failed' && e.outputs === undefined;
      const deferred = noOutputsYet && !!node && !external && e.status !== 'Skipped' && (options.deferredOutputs?.(e.name, path) ?? false);
      if (deferred) pin.outputsDeferred = true;
      const reason: PinUnavailableReason | undefined = !node
        ? 'not-in-flow'
        : e.status === 'Skipped'
          ? 'skipped'
          : noOutputsYet && !deferred
            ? external ? 'secure' : 'no-outputs'
            : undefined;
      if (reason) {
        pin.available = false;
        pin.unavailableReason = reason;
      }
      pin.pinned = pin.available && external;
      result.pins.push(pin);
    }
  };
  visit(trace, []);
  return result;
}

/**
 * Pins loaded into a flow they were not derived from (restored from a saved scenario): recompute
 * `external`, `available` and the reason against `ir`; `pinned` is kept where the pin is still
 * available, and cleared where it is not.
 */
export function reclassifyPins(pins: CloudPin[], ir: FlowIR): CloudPin[] {
  const nodes = nodesByName(ir);
  return pins.map((p) => {
    const node = nodes.get(p.name);
    const external = node ? isExternalCall(node) : false;
    const reason: PinUnavailableReason | undefined = !node
      ? 'not-in-flow'
      : p.status === 'Skipped'
        ? 'skipped'
        : p.status !== 'Failed' && p.outputs === undefined
          // A deferred pin restored from a save can no longer be loaded (its content link was never saved).
          ? p.outputsDeferred ? 'not-downloaded' : external ? 'secure' : 'no-outputs'
          : undefined;
    const { unavailableReason: _dropped, ...rest } = p;
    return {
      ...rest,
      external,
      available: reason === undefined,
      ...(reason ? { unavailableReason: reason } : {}),
      pinned: reason === undefined && p.pinned,
    };
  });
}

/** The pin for `name` at `iterationPath`, when there is one and it is pinned. */
export function pinnedAt(pins: CloudPin[], name: string, iterationPath: LoopIndex[]): CloudPin | undefined {
  const key = pinKey(name, iterationPath);
  return pins.find((p) => p.pinned && p.available && pinKey(p.name, p.iterationPath) === key);
}

/**
 * The engine's `RunOptions.mocks` resolver for a set of pins: a pinned, available pin at the
 * node's name and current iteration path answers with the cloud's result (a Failed pin as a
 * failure, with its code and error); anything else runs. `pins` is read at call time, so a
 * host may toggle `pinned` while a session is paused.
 */
export function pinsToMockResolver(pins: CloudPin[]): MockResolver {
  return (node, ctx) => {
    const pin = pinnedAt(pins, node.name, loopIndexes(ctx));
    if (!pin) return undefined;
    const mock: MockResult = { outputs: pin.outputs, status: pin.status === 'Failed' ? 'Failed' : 'Succeeded' };
    if (pin.code !== undefined) mock.code = pin.code;
    if (pin.error !== undefined) mock.error = pin.error;
    return mock;
  };
}
