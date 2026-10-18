/**
 * `flowforger diff`: compare a local flow with the live one.
 *
 * Resolves the live flow exactly like `push` (--id, then the decorator
 * workflowId, then a lookup by name that refuses an ambiguous match), reads
 * its clientdata and diffs it against the locally compiled definition. The
 * client is a structural interface so this can be tested with a fake.
 */
import type { FlowForgerConfig } from '@flowforger/ir';
import { resolveFlowTarget, PushError, type FlowLookupClient, type FlowTargetInput } from './flow-target.js';
import { diffDefinitions, type FlowDiffReport } from './definition-diff.js';

export interface DiffClient extends FlowLookupClient {
  getFlow(workflowId: string): Promise<{ workflowid?: string; name?: string; clientdata?: string | null } | null>;
}

export interface DiffInput extends FlowTargetInput {
  /** Compiled Logic Apps JSON of the local file (what push would send). */
  clientdata: string;
  config?: FlowForgerConfig;
}

export interface DiffOutcome {
  workflowId: string;
  /** The live record's name (the local name when the record has none). */
  flowName: string;
  report: FlowDiffReport;
}

export async function runDiff(
  client: DiffClient,
  input: DiffInput,
  log: (msg: string) => void = () => {},
): Promise<DiffOutcome> {
  const target = await resolveFlowTarget(client, input, log);
  if (!target) {
    throw new PushError(`No flow named '${input.flowName}' found in this environment (nothing to compare against)`);
  }
  const live = await client.getFlow(target.workflowId);
  if (!live) throw new PushError(`Flow ${target.workflowId} was not found in this environment`);
  if (!live.clientdata) throw new PushError(`Flow ${target.workflowId} has no clientdata (definition) to compare against`);

  let liveJson: unknown;
  try {
    liveJson = JSON.parse(live.clientdata);
  } catch (err) {
    throw new PushError(`The live flow's clientdata is not valid JSON: ${(err as Error).message}`);
  }
  let localJson: unknown;
  try {
    localJson = JSON.parse(input.clientdata);
  } catch (err) {
    throw new PushError(`The local file is not valid JSON: ${(err as Error).message}`);
  }

  const report = diffDefinitions(liveJson, localJson, { config: input.config });
  return { workflowId: target.workflowId, flowName: live.name || input.flowName || target.workflowId, report };
}
