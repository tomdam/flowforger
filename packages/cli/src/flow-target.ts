/**
 * Which live flow a local file refers to — shared by `push` and `diff`.
 *
 * Order: explicit --id, then the decorator workflowId, then a lookup by name.
 * Kept import-free (the client is a structural interface) so it can be
 * unit-tested against a fake client with no network.
 */

/** A push/diff failure that the CLI should report and exit 2 on, not a crash. */
export class PushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushError';
  }
}

export interface FlowLookupClient {
  findFlowByName(name: string): Promise<{ match: { workflowid: string; clientdata?: string | null } | null; ambiguous: boolean }>;
}

export interface FlowTargetInput {
  flowName?: string;
  explicitId?: string;
  decoratorWorkflowId?: string;
  /** True when --file was a .ts source; changes the wording of name errors. */
  isDsl: boolean;
}

export interface FlowTarget {
  workflowId: string;
  matchedByName: boolean;
  /** The record the name lookup returned, when the flow was found by name. */
  record?: { workflowid: string; clientdata?: string | null };
}

/**
 * Resolve the live flow a local file targets. Returns null when no id is
 * known and no flow of that name is visible (push then creates). Throws a
 * PushError when the name is missing or ambiguous.
 */
export async function resolveFlowTarget(
  client: FlowLookupClient,
  input: FlowTargetInput,
  log: (msg: string) => void = () => {},
): Promise<FlowTarget | null> {
  const { explicitId, decoratorWorkflowId, flowName } = input;

  if (explicitId && decoratorWorkflowId && explicitId !== decoratorWorkflowId) {
    log(`WARNING: --id ${explicitId} overrides decorator workflowId ${decoratorWorkflowId}`);
  }

  const id = explicitId || decoratorWorkflowId;
  if (id) return { workflowId: id, matchedByName: false };

  if (!flowName) {
    throw new PushError(
      input.isDsl
        ? 'Could not determine the flow name from the DSL. Add a name to @Flow({...}) or pass --id.'
        : 'Required: --id, or --name <flowName> to look up the flow by name (JSON files carry no flow name)',
    );
  }

  const { match, ambiguous } = await client.findFlowByName(flowName);
  if (ambiguous) {
    throw new PushError(
      `Multiple flows named '${flowName}' exist in this environment — pass --id to disambiguate which one to use`,
    );
  }
  if (!match) return null;
  log(`Matched existing flow '${flowName}' (${match.workflowid})`);
  return { workflowId: match.workflowid, matchedByName: true, record: match };
}
