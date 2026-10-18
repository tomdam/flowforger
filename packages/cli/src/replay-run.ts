/**
 * `flowforger run --replay-run <runId>`: replay a cloud run locally. The run's trigger outputs
 * become the input, every external action the run recorded (connector, HTTP, child flow) is
 * pinned to the outputs the cloud recorded — per loop iteration, a failure as a failure — and
 * everything else (Composes, variables, conditions) recomputes. `--live X` unpins X so it
 * calls out; the `--live` guard (safe mode, implied) stops the run before any external action
 * that is neither pinned nor listed. Kept out of index.ts so it can be tested with a fake
 * Flow API (`fetchCloudRun`) and without one (`prepareReplay`).
 */
import type { FlowIR, Node } from '@flowforger/ir';
import { loopIndexes, type MockResolver, type RunContext } from '@flowforger/engine';
import {
  buildCloudTrace,
  cloudRunToPins,
  pinKey,
  pinnedAt,
  pinsToMockResolver,
  type CloudActionRecord,
  type CloudPin,
  type CloudRepetition,
  type CloudTraceEntry,
} from '@flowforger/cloud-run';

/** The part of `FlowApiClient` a replay needs (structural, so tests can fake it). */
export interface ReplayFlowApi {
  getRun(environmentId: string, flowId: string, runId: string): Promise<any>;
  fetchLink(link: { uri?: string } | undefined): Promise<unknown>;
  listRunActions(environmentId: string, flowId: string, runId: string): Promise<Record<string, CloudActionRecord>>;
  listRepetitions(environmentId: string, flowId: string, runId: string, actionName: string): Promise<CloudRepetition[]>;
}

/** A cloud run in the local trace shape (what `run-show` prints). */
export interface CloudRun {
  runId: string;
  status: string;
  startTime?: string;
  endTime?: string;
  error?: unknown;
  trace: CloudTraceEntry[];
}

/** Fetch one run and shape it like the local trace, nesting by `liveIr` (the deployed definition's IR). */
export async function fetchCloudRun(api: ReplayFlowApi, environmentId: string, flowId: string, runId: string, liveIr: FlowIR): Promise<CloudRun> {
  const run = await api.getRun(environmentId, flowId, runId);
  const p = run?.properties ?? {};
  const t = p.trigger ?? {};
  const trigger = {
    name: t.name as string | undefined,
    status: t.status as string | undefined,
    inputs: await api.fetchLink(t.inputsLink),
    outputs: await api.fetchLink(t.outputsLink),
    ...(t.error !== undefined ? { error: t.error } : {}),
  };
  const actions = await api.listRunActions(environmentId, flowId, runId);
  const trace = await buildCloudTrace(liveIr, { trigger, actions, repetitions: (name) => api.listRepetitions(environmentId, flowId, runId, name) });
  return {
    runId,
    status: p.status as string,
    ...(p.startTime !== undefined ? { startTime: p.startTime } : {}),
    ...(p.endTime !== undefined ? { endTime: p.endTime } : {}),
    ...(p.error !== undefined ? { error: p.error } : {}),
    trace,
  };
}

export interface ReplayOptions {
  /** `--live`: actions unpinned so they call out. */
  live: Set<string>;
  /** `--in`: replaces the run's trigger outputs as the input. */
  input?: unknown;
  /** `--mock` / `--mocks`: a mock by name wins over the pin at every iteration. */
  mockMap?: Record<string, unknown>;
}

export interface Replay {
  /** The run input: `--in` when given, else the trigger outputs the cloud recorded (`{ headers, body }`). */
  input: unknown;
  pins: CloudPin[];
  /** The engine's `RunOptions.mocks`. */
  mocks: MockResolver;
  /** For the `--live` guard: whether a pin or mock stands in for the node here. */
  isMocked: (node: Node, ctx: unknown) => boolean;
  /** Pins that cannot replay and are worth telling the user about. */
  warnings: string[];
}

/** Pins of `cloud` classified against the local flow, with `--live`, `--in` and `--mock` applied. */
export function prepareReplay(cloud: CloudRun, localIr: FlowIR, opts: ReplayOptions): Replay {
  const { triggerOutputs, pins } = cloudRunToPins(cloud.trace, localIr);
  for (const pin of pins) if (opts.live.has(pin.name)) pin.pinned = false;

  const warnings: string[] = [];
  for (const pin of pins) {
    if (pin.available) continue;
    const where = pin.iterationPath.length ? ` (${pinKey(pin.name, pin.iterationPath)})` : '';
    if (pin.unavailableReason === 'secure') {
      warnings.push(`[WARN] --replay-run: '${pin.name}'${where} has no replayable outputs (secure outputs are not downloadable); it is not pinned`);
    } else if (pin.unavailableReason === 'not-in-flow') {
      warnings.push(`[WARN] --replay-run: '${pin.name}' is in the cloud run but not in this flow; its recorded outputs are ignored`);
    }
  }

  const mockMap = opts.mockMap;
  const fromPins = pinsToMockResolver(pins);
  const mocks: MockResolver = (node, ctx, inputs) => {
    if (mockMap && Object.prototype.hasOwnProperty.call(mockMap, node.name)) return { outputs: mockMap[node.name] };
    return fromPins(node, ctx, inputs);
  };
  const isMocked = (node: Node, ctx: unknown) =>
    (mockMap !== undefined && Object.prototype.hasOwnProperty.call(mockMap, node.name)) ||
    pinnedAt(pins, node.name, loopIndexes(ctx as RunContext)) !== undefined;

  return {
    input: opts.input !== undefined ? opts.input : triggerOutputs,
    pins,
    mocks,
    isMocked,
    warnings,
  };
}

/** A one-line summary of what a replay pins, for the terminal. */
export function describeReplay(cloud: CloudRun, replay: Replay): string {
  const pinned = replay.pins.filter((p) => p.pinned);
  const names = new Set(pinned.map((p) => p.name));
  const iterated = pinned.filter((p) => p.iterationPath.length > 0).length;
  const parts = [`${pinned.length} action${pinned.length === 1 ? '' : 's'} pinned`];
  if (iterated) parts.push(`${iterated} inside loops, per iteration`);
  parts.push(`${names.size} distinct name${names.size === 1 ? '' : 's'}`);
  return `Replaying cloud run ${cloud.runId} (${cloud.status}): ${parts.join(', ')}; trigger outputs from the run; safe mode on (unpinned external actions stop the run)`;
}
