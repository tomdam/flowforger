/**
 * `run --mock <action>=<file.json>`, `--mocks <file.json>` and `--live <action>`:
 * parse the flag values into the engine's `RunOptions.mocks` map, build the
 * `onBeforeExecute` guard that enforces `--live` (deny-by-default for calls
 * that leave the machine), and find which mocks a finished run actually used.
 * Kept out of index.ts so it can be unit-tested without a flow run.
 */
import type { Node } from '@flowforger/ir';
import { isExternalCall } from '@flowforger/cloud-run';
import { ArgError } from './cli-args.js';

export { isExternalCall };

/**
 * Parse one or more `--mock` values. `readJson` reads and parses the file,
 * `hasAction` says whether the flow has an action of that name (a typo would
 * otherwise silently mock nothing). `into` lets the entries join an existing
 * map (from `--mocks`); a name present on both sides is an error.
 */
export function parseMockFlags(
  values: unknown,
  readJson: (file: string) => unknown,
  hasAction: (name: string) => boolean,
  into: Record<string, unknown> = {},
): Record<string, unknown> {
  const list = Array.isArray(values) ? values : [values];
  const mocks = into;
  for (const value of list) {
    if (typeof value !== 'string') {
      throw new ArgError('--mock requires a value of the form <actionName>=<file.json>');
    }
    const eq = value.indexOf('=');
    const action = eq < 0 ? '' : value.slice(0, eq).trim();
    const file = eq < 0 ? '' : value.slice(eq + 1).trim();
    if (!action || !file) {
      throw new ArgError(`--mock: expected <actionName>=<file.json>, got '${value}'`);
    }
    if (!hasAction(action)) {
      throw new ArgError(`--mock: no action named '${action}' in the flow`);
    }
    if (action in mocks) {
      throw new ArgError(`--mock: action '${action}' is mocked more than once`);
    }
    try {
      mocks[action] = readJson(file);
    } catch (err) {
      throw new ArgError(`--mock: could not read ${file} for '${action}': ${(err as Error).message}`);
    }
  }
  return mocks;
}

/**
 * Parse a `--mocks <file.json>` value: one JSON object mapping action names to
 * the outputs to use for them (the same value `--mock` takes from a file each).
 */
export function parseMocksFile(
  value: unknown,
  readJson: (file: string) => unknown,
  hasAction: (name: string) => boolean,
): Record<string, unknown> {
  if (value === true) throw new ArgError('--mocks requires a file path');
  if (Array.isArray(value)) throw new ArgError('--mocks may only be specified once (list every action in the one file)');
  if (typeof value !== 'string') throw new ArgError('--mocks requires a file path');
  let content: unknown;
  try {
    content = readJson(value);
  } catch (err) {
    throw new ArgError(`--mocks: could not read ${value}: ${(err as Error).message}`);
  }
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new ArgError(`--mocks: ${value} must be a JSON object mapping action names to their outputs`);
  }
  const mocks: Record<string, unknown> = {};
  for (const [action, outputs] of Object.entries(content as Record<string, unknown>)) {
    if (!hasAction(action)) throw new ArgError(`--mocks: no action named '${action}' in the flow (${value})`);
    mocks[action] = outputs;
  }
  return mocks;
}

/** The mocks of a run: the `--mocks` file first, then every `--mock` entry (no overlap allowed). */
export function collectMocks(
  args: { mock?: unknown; mocks?: unknown },
  readJson: (file: string) => unknown,
  hasAction: (name: string) => boolean,
): Record<string, unknown> | undefined {
  if (args.mock === undefined && args.mocks === undefined) return undefined;
  const mocks = args.mocks === undefined ? {} : parseMocksFile(args.mocks, readJson, hasAction);
  if (args.mock === undefined) return mocks;
  const fromFile = new Set(Object.keys(mocks));
  const merged = parseMockFlags(args.mock, readJson, (name) => {
    if (fromFile.has(name)) throw new ArgError(`--mock: action '${name}' is already mocked by --mocks`);
    return hasAction(name);
  }, mocks);
  return merged;
}

/**
 * Parse `--live` values (repeatable, comma-separated lists allowed) into the set
 * of actions allowed to call out. An action that is also mocked is a contradiction.
 */
export function parseLiveFlags(
  values: unknown,
  hasAction: (name: string) => boolean,
  mocks: Record<string, unknown> | undefined,
): Set<string> {
  const list = Array.isArray(values) ? values : [values];
  const live = new Set<string>();
  for (const value of list) {
    if (value === true) {
      throw new ArgError('--live requires an action name (repeat the flag, or separate names with commas)');
    }
    if (typeof value !== 'string') throw new ArgError('--live requires an action name');
    for (const raw of value.split(',')) {
      const name = raw.trim();
      if (!name) continue;
      if (!hasAction(name)) throw new ArgError(`--live: no action named '${name}' in the flow`);
      if (mocks && name in mocks) throw new ArgError(`--live: action '${name}' is listed as live but also mocked; drop one of the two`);
      live.add(name);
    }
  }
  return live;
}

export interface RunGuardOptions {
  /** `--stop-before`: end the run before this action. */
  stopBefore?: string;
  /** `--live`: when set (even empty), every external call must be mocked or listed here, else the run ends before it. */
  live?: Set<string>;
  mocks?: Record<string, unknown>;
  /** Whether a mock resolver (`--replay-run` pins) will stand in for the node in this context. */
  isMocked?: (node: Node, ctx: unknown) => boolean;
}

export interface RunGuard {
  hook: (node: Node, ctx: unknown, inputs?: unknown) => 'continue' | 'stop';
  /** The action `--live` refused, once the run has stopped there. */
  deniedLive: () => string | undefined;
}

/**
 * The `onBeforeExecute` hook of `flowforger run`: `--stop-before` first, then
 * the `--live` guard. Mocked actions pass the guard (the engine applies the
 * mock right after this hook, so nothing is sent for them).
 */
export function createRunGuard(opts: RunGuardOptions): RunGuard | undefined {
  if (!opts.stopBefore && !opts.live) return undefined;
  let denied: string | undefined;
  return {
    hook: (node, ctx) => {
      if (opts.stopBefore && node.name === opts.stopBefore) return 'stop';
      const mocked = (opts.mocks !== undefined && node.name in opts.mocks) || (opts.isMocked?.(node, ctx) ?? false);
      if (opts.live && isExternalCall(node) && !opts.live.has(node.name) && !mocked) {
        denied = node.name;
        return 'stop';
      }
      return 'continue';
    },
    deniedLive: () => denied,
  };
}

/** Names of the trace entries (at any depth, loop iterations included) whose outputs were mocked. */
export function mockedActionsInTrace(trace: any[] | undefined): Set<string> {
  const names = new Set<string>();
  const walk = (entries: any[] | undefined) => {
    for (const e of entries ?? []) {
      if (e?.mocked) names.add(e.name);
      walk(e?.children);
      for (const it of e?.iterations ?? []) walk(it?.actions);
    }
  };
  walk(trace);
  return names;
}
