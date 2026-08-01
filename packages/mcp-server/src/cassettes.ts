/**
 * On-disk cassettes: the last completed run's connector calls for a flow,
 * so a later debug_start can replay them instead of hitting live services.
 *
 * Self-warming — a replay miss executes live and is re-recorded, and the
 * fresh log is written back at session end.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConnectorCallLog, type RecordedCall } from '@flowforger/debug-core';

export const CASSETTE_VERSION = 1;

export interface CassetteFile {
  version: number;
  flowPath: string;
  recordedAt: string;
  /** True when calls were dropped at save time because they aren't JSON-safe. */
  partial: boolean;
  calls: RecordedCall[];
}

function defaultRoot(): string {
  return path.join(os.homedir(), '.flowforger', 'cassettes');
}

/** Deterministic per-flow filename; the absolute path is normalized first. */
export function cassettePath(flowPath: string, root: string = defaultRoot()): string {
  const normalized = process.platform === 'win32'
    ? path.resolve(flowPath).toLowerCase()
    : path.resolve(flowPath);
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return path.join(root, `${hash}.json`);
}

/**
 * True when `value` contains binary data anywhere in its structure. A JSON
 * round-trip silently turns typed arrays into plain index-keyed objects
 * (`{"0":1,"1":2}`), which survives an equality check but is corrupt on
 * reload — so binary has to be detected structurally, not by round-tripping.
 * Cycle-safe: connector payloads are not guaranteed acyclic.
 */
function containsBinary(value: unknown, seen: Set<unknown> = new Set()): boolean {
  if (value === null || typeof value !== 'object') return false;
  // ArrayBuffer.isView covers every typed array plus DataView.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((v) => containsBinary(v, seen));
  if (value instanceof Map) {
    for (const [k, v] of value) if (containsBinary(k, seen) || containsBinary(v, seen)) return true;
    return false;
  }
  if (value instanceof Set) {
    for (const v of value) if (containsBinary(v, seen)) return true;
    return false;
  }
  return Object.values(value as Record<string, unknown>).some((v) => containsBinary(v, seen));
}

/**
 * A call survives persistence only if it holds no binary and round-trips
 * through JSON unchanged. Anything else is dropped and the cassette is marked
 * partial — those calls simply run live next session.
 */
function isJsonSafe(call: RecordedCall): boolean {
  for (const part of [call.inputs, call.response]) {
    if (part === undefined) continue;
    if (containsBinary(part)) return false;
    try {
      const json = JSON.stringify(part);
      if (json === undefined) return false;
      if (JSON.stringify(JSON.parse(json)) !== json) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Load the cassette for a flow, or null when absent, corrupt, or a different version. */
export function loadCassette(flowPath: string, root: string = defaultRoot()): ConnectorCallLog | null {
  const file = cassettePath(flowPath, root);
  let parsed: CassetteFile;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as CassetteFile;
  } catch {
    return null;
  }
  if (parsed?.version !== CASSETTE_VERSION || !Array.isArray(parsed.calls)) return null;

  // The filename is only a 64-bit hash prefix; confirm the payload really is
  // this flow's before replaying it.
  const normalize = (p: string) =>
    process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  if (typeof parsed.flowPath !== 'string' || normalize(parsed.flowPath) !== normalize(flowPath)) {
    return null;
  }

  const log = new ConnectorCallLog();
  for (const call of parsed.calls) {
    log.record(call.connector, call.operation, call.inputs, call.response, call.nodeName ?? null);
  }
  return log;
}

/** Persist a run's calls, dropping any that cannot survive a JSON round-trip. */
export function saveCassette(
  flowPath: string,
  log: ConnectorCallLog,
  root: string = defaultRoot(),
): { saved: number; skipped: number; partial: boolean } {
  const keep = log.calls.filter((call) => !call.oversized && isJsonSafe(call));
  const skipped = log.calls.length - keep.length;
  const payload: CassetteFile = {
    version: CASSETTE_VERSION,
    flowPath: path.resolve(flowPath),
    recordedAt: new Date().toISOString(),
    partial: skipped > 0,
    calls: keep,
  };
  fs.mkdirSync(root, { recursive: true });
  const file = cassettePath(flowPath, root);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
  fs.renameSync(tmp, file);
  return { saved: keep.length, skipped, partial: skipped > 0 };
}
