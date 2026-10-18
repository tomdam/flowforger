/**
 * Create-vs-update resolution for `flowforger push`.
 *
 * Kept out of index.ts so it can be unit-tested against a fake client with no
 * network. The client is described by the local `PushClient` interface rather
 * than imported from @flowforger/dataverse-sdk — DataverseClient satisfies it
 * structurally, and staying import-free keeps this module cheap to test.
 * Which live flow is targeted is decided by `resolveFlowTarget`
 * (./flow-target.ts), shared with `flowforger diff`.
 */
import type { FlowForgerConfig } from '@flowforger/ir';
import { resolveFlowTarget, PushError, type FlowLookupClient } from './flow-target.js';
import { diffDefinitions, liveOnlyNames } from './definition-diff.js';

export { PushError };

export interface PushClient extends FlowLookupClient {
  patchFlow(workflowId: string, payload: { clientdata: string }): Promise<unknown>;
  createFlow(
    payload: { name: string; clientdata: string; description?: string },
    opts?: { solutionUniqueName?: string },
  ): Promise<{ workflowid: string }>;
  /** Only needed for --expect-clean (reads the live definition before patching). */
  getFlow?(workflowId: string): Promise<{ clientdata?: string | null } | null>;
}

export interface PushInput {
  /** Compiled Logic Apps JSON to upload. */
  clientdata: string;
  /** IR name for a .ts source, or --name for a .json source. */
  flowName?: string;
  /** Flow-level description, used only when creating. */
  description?: string;
  explicitId?: string;
  decoratorWorkflowId?: string;
  create?: boolean;
  noCreate?: boolean;
  solution?: string;
  /** True when --file was a .ts source; changes the wording of name errors. */
  isDsl: boolean;
  /**
   * Refuse to update a flow that has actions, triggers or parameters the
   * local file lacks — the detectable half of "someone changed it in the
   * designer since you pulled". A changed action cannot be told apart from
   * a local edit, so it is not checked.
   */
  expectClean?: boolean;
  /** Normalization config for --expect-clean's comparison. */
  config?: FlowForgerConfig;
}

export type PushResult =
  | { action: 'patched'; workflowId: string; matchedByName: boolean }
  | { action: 'created'; workflowId: string; name: string; solution?: string; lookedUp: boolean };

const SOLUTION_IGNORED = 'WARNING: --solution is ignored when updating an existing flow';

/**
 * Resolve the target flow and push to it.
 *
 * Order: explicit --id, then the decorator workflowId, then a lookup by name.
 * A lookup miss creates the flow unless --no-create was passed.
 */
export async function runPush(
  client: PushClient,
  input: PushInput,
  log: (msg: string) => void = () => {},
): Promise<PushResult> {
  const { clientdata, flowName, description, explicitId, decoratorWorkflowId, solution } = input;

  if (input.create && input.noCreate) {
    throw new PushError('--create and --no-create cannot be used together');
  }

  const id = explicitId || decoratorWorkflowId;

  if (input.create && id) {
    throw new PushError(
      explicitId
        ? '--create cannot be combined with --id; drop --id to create a new flow'
        : '--create cannot be combined with the workflowId in your @Flow decorator; ' +
          'remove it to create a new flow'
    );
  }

  if (!id && !flowName) {
    throw new PushError(
      input.isDsl
        ? 'Could not determine the flow name from the DSL. Add a name to @Flow({...}) or pass --id.'
        : 'Required: --id, or --name <flowName> to look up or create the flow ' +
          '(JSON files carry no flow name)'
    );
  }

  // --create skips the lookup and goes straight to creating.
  const target = input.create ? null : await resolveFlowTarget(client, input, log);

  if (target) {
    if (solution) log(SOLUTION_IGNORED);
    if (input.expectClean) await assertLiveIsClean(client, target.workflowId, input);
    await client.patchFlow(target.workflowId, { clientdata });
    return { action: 'patched', workflowId: target.workflowId, matchedByName: target.matchedByName };
  }

  if (input.noCreate) {
    throw new PushError(
      `No flow named '${flowName}' found in this environment, and --no-create was passed`
    );
  }

  const created = await client.createFlow(
    { name: flowName!, clientdata, ...(description ? { description } : {}) },
    { solutionUniqueName: solution },
  );
  return { action: 'created', workflowId: created.workflowid, name: flowName!, solution, lookedUp: !input.create };
}

/** `--expect-clean`: throw when the live flow holds something the local file lacks. */
async function assertLiveIsClean(client: PushClient, workflowId: string, input: PushInput): Promise<void> {
  if (!client.getFlow) throw new Error('--expect-clean needs a client that can read flows');
  const live = await client.getFlow(workflowId);
  if (!live?.clientdata) return; // nothing live to lose
  let liveJson: unknown;
  try {
    liveJson = JSON.parse(live.clientdata);
  } catch {
    throw new PushError(`--expect-clean: the live flow's clientdata is not valid JSON; compare with flowforger diff`);
  }
  const report = diffDefinitions(liveJson, JSON.parse(input.clientdata), { config: input.config });
  const missing = liveOnlyNames(report);
  if (missing.length === 0) return;
  throw new PushError(
    `--expect-clean: the live flow has ${missing.length} item${missing.length === 1 ? '' : 's'} the local file lacks: ` +
    `${missing.join(', ')}. Pull it first (flowforger pull --id ${workflowId} --auth) and merge, ` +
    `run flowforger diff to see every difference, or push without --expect-clean to overwrite.`
  );
}

/**
 * One line describing a workflow record's state after a push, so a flow that
 * is (still) Draft is never mistaken for a running one. statecode: 0 Draft,
 * 1 Activated, 2 Suspended; statuscode: 1 Draft, 2 Activated, 3 Suspended.
 */
export function flowStateSummary(
  statecode: number | undefined,
  statuscode: number | undefined,
  workflowId: string,
): { active: boolean; text: string } {
  const codes = `statecode ${statecode ?? '?'}, statuscode ${statuscode ?? '?'}`;
  if (statecode === 1) return { active: true, text: `State: Activated (${codes})` };
  if (statecode === 2) {
    return { active: false, text: `State: Suspended (${codes}) — not running! Reactivate: flowforger activate --id ${workflowId} --auth --state 1 --status 2` };
  }
  if (statecode === 0) {
    return { active: false, text: `State: Draft (${codes}) — not running! Activate: flowforger activate --id ${workflowId} --auth --state 1 --status 2` };
  }
  return { active: false, text: `State: unknown (${codes})` };
}
