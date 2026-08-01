/**
 * Connector call recording & replay for edit-and-continue fast-forward.
 *
 * Every debug run records (connector, operation, inputs) -> response at the
 * connector layer via a Proxy wrapper. On "apply changes & continue", a new
 * session runs with replay wrappers: a matching recorded call returns the
 * recorded response with no network I/O; a miss executes live and signals
 * divergence. Matching at the request level (not the action level) means
 * renamed actions still replay correctly.
 */

import type { BaseConnector } from '@flowforger/engine';
import { maskInputs } from './volatile-inputs.js';

/** Recording bounds: beyond these, replay coverage degrades gracefully to live re-runs. */
export const MAX_RECORDED_CALLS = 1000;
export const MAX_RECORDED_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface RecordedCall {
  connector: string;
  operation: string;
  inputs: any;
  response: any;
  /** IR node that made the call; null = console/immediate-window (excluded from replay). */
  nodeName: string | null;
  /** Response exceeded the size cap and was not retained; can never match on replay. */
  oversized?: boolean;
}

/** Deterministic JSON with recursively sorted object keys, for input matching. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'undefined';
}

/** FNV-1a over the bytes — cheap content fingerprint so equal-size binaries don't false-match. */
function bytesTag(name: string, bytes: Uint8Array): unknown {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return { __ff: name, size: bytes.byteLength, hash: h >>> 0 };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return { __ff: 'Date', iso: value.toISOString() };
  if (value instanceof Map) {
    return { __ff: 'Map', entries: [...value.entries()].map(sortKeys) };
  }
  if (value instanceof Set) return { __ff: 'Set', values: [...value.values()].map(sortKeys) };
  if (value instanceof ArrayBuffer) return bytesTag('ArrayBuffer', new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return bytesTag(value.constructor.name, new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return { __ff: 'Blob', size: value.size, contentType: value.type };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Rough serialized size; 0 (never oversized) when the value cannot be stringified. */
function byteEstimate(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function deepClone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }
}

/** Log length snapshot taken right after a node execution completed. */
interface ExecutionBoundary {
  nodeName: string;
  hit: number;
  callCount: number;
}

/** Ordered log of connector calls made during one debug run. */
export class ConnectorCallLog {
  readonly calls: RecordedCall[] = [];
  private markers: ExecutionBoundary[] = [];
  /** True once the entry cap was hit — later calls were NOT recorded. */
  incomplete = false;

  record(connector: string, operation: string, inputs: any, response: any, nodeName: string | null = null): void {
    if (this.calls.length >= MAX_RECORDED_CALLS) {
      this.incomplete = true;
      return;
    }
    const oversized = byteEstimate(response) > MAX_RECORDED_RESPONSE_BYTES;
    this.calls.push({
      connector,
      operation,
      inputs: deepClone(inputs),
      response: oversized ? undefined : deepClone(response),
      nodeName,
      ...(oversized ? { oversized: true as const } : {}),
    });
  }

  /** Snapshot the log length after a node execution (driver calls this from onNodeExecuted). */
  markBoundary(nodeName: string, hit: number): void {
    this.markers.push({ nodeName, hit, callCount: this.calls.length });
  }

  /**
   * Cut the log so every call made from `nodeName`'s `hit`-numbered execution
   * onward is gone (markers record post-execution lengths, so the cut point is
   * the PREVIOUS marker's callCount — the log length when that execution
   * began). Returns false (log untouched) when no such boundary was recorded.
   */
  truncateBefore(nodeName: string, hit: number): boolean {
    const idx = this.markers.findIndex((m) => m.nodeName === nodeName && m.hit === hit);
    if (idx < 0) return false;
    const cut = idx === 0 ? 0 : this.markers[idx - 1].callCount;
    this.calls.length = cut;
    this.markers.length = idx;
    return true;
  }
}

/** Proxy a connector so `invoke` is intercepted but every other member passes through. */
function proxyInvoke(
  connector: BaseConnector,
  invoke: BaseConnector['invoke'],
): BaseConnector {
  return new Proxy(connector, {
    get(target, prop, receiver) {
      if (prop === 'invoke') return invoke;
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Wrap every connector to record successful calls into `log`. Failures rethrow unrecorded. */
export function wrapConnectorsForRecording(
  connectors: Record<string, BaseConnector>,
  log: ConnectorCallLog,
  getNodeName?: () => string | null,
): Record<string, BaseConnector> {
  const wrapped: Record<string, BaseConnector> = {};
  for (const [name, connector] of Object.entries(connectors)) {
    wrapped[name] = proxyInvoke(connector, async (operation, inputs, ctx) => {
      const response = await connector.invoke(operation, inputs, ctx);
      log.record(name, operation, inputs, response, getNodeName?.() ?? null);
      return response;
    });
  }
  return wrapped;
}

export interface ReplayEvents {
  /** A recorded response was reused (no network call). */
  onReplayed?: (call: RecordedCall) => void;
  /** No recorded call matched — the request executes live. */
  onDivergence?: (connector: string, operation: string, inputs: any) => void;
}

export interface ReplayOptions {
  /** nodeName -> volatile input paths (computeVolatileInputPaths on the ACTIVE IR). */
  volatileMasks?: Map<string, string[]>;
  /**
   * Innermost executing node for the incoming call; null = console/immediate-
   * window call, which never matches, never consumes, and never signals
   * divergence. When absent entirely, all calls match (legacy hosts).
   */
  getNodeName?: () => string | null;
}

/**
 * Wrap connectors for a fast-forward run: matching recorded calls return the
 * recorded response without touching the network; misses execute live after
 * signaling divergence. Every call (hit or live) is re-recorded into `newLog`
 * so a subsequent apply replays against the new run.
 */
export function wrapConnectorsForReplay(
  connectors: Record<string, BaseConnector>,
  previousLog: ConnectorCallLog,
  newLog: ConnectorCallLog,
  events?: ReplayEvents,
  options?: ReplayOptions,
): Record<string, BaseConnector> {
  const trackNodes = typeof options?.getNodeName === 'function';
  const masks = options?.volatileMasks;

  const keyFor = (connector: string, operation: string, inputs: any, nodeName: string | null): string =>
    `${connector}|${operation}|${stableStringify(maskInputs(inputs, nodeName ? masks?.get(nodeName) : undefined))}`;

  // FIFO queues of unconsumed log indices per match key — preserves the
  // original "first unconsumed match in log order" semantics at O(1) a match
  // instead of an O(n) rescan per call (O(n²) per fast-forward).
  const queues = new Map<string, number[]>();
  for (let i = 0; i < previousLog.calls.length; i++) {
    const call = previousLog.calls[i];
    if (trackNodes && call.nodeName === null) continue; // console-originated: never replayed
    if (call.oversized) continue; // stub without a response: can never match
    const key = keyFor(call.connector, call.operation, call.inputs, call.nodeName);
    let q = queues.get(key);
    if (!q) queues.set(key, (q = []));
    q.push(i);
  }

  const wrapped: Record<string, BaseConnector> = {};
  for (const [name, connector] of Object.entries(connectors)) {
    wrapped[name] = proxyInvoke(connector, async (operation, inputs, ctx) => {
      const nodeName = trackNodes ? options!.getNodeName!() : null;
      const isConsoleCall = trackNodes && nodeName === null;
      if (!isConsoleCall) {
        const idx = queues.get(keyFor(name, operation, inputs, nodeName))?.shift();
        if (idx !== undefined) {
          const call = previousLog.calls[idx];
          newLog.record(name, operation, inputs, call.response, nodeName);
          events?.onReplayed?.(call);
          return deepClone(call.response);
        }
        events?.onDivergence?.(name, operation, inputs);
      }
      const response = await connector.invoke(operation, inputs, ctx);
      newLog.record(name, operation, inputs, response, nodeName);
      return response;
    });
  }
  return wrapped;
}
