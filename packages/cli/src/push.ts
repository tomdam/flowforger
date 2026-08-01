/**
 * Create-vs-update resolution for `flowforger push`.
 *
 * Kept out of index.ts so it can be unit-tested against a fake client with no
 * network. The client is described by the local `PushClient` interface rather
 * than imported from @flowforger/dataverse-sdk — DataverseClient satisfies it
 * structurally, and staying import-free keeps this module cheap to test.
 */

/** A push failure that the CLI should report and exit 2 on, not a crash. */
export class PushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushError';
  }
}

export interface PushClient {
  findFlowByName(name: string): Promise<{ match: { workflowid: string } | null; ambiguous: boolean }>;
  patchFlow(workflowId: string, payload: { clientdata: string }): Promise<unknown>;
  createFlow(
    payload: { name: string; clientdata: string; description?: string },
    opts?: { solutionUniqueName?: string },
  ): Promise<{ workflowid: string }>;
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

  if (explicitId && decoratorWorkflowId && explicitId !== decoratorWorkflowId) {
    log(`WARNING: --id ${explicitId} overrides decorator workflowId ${decoratorWorkflowId}`);
  }

  // 1 & 2: a known id — straight update
  if (id) {
    if (solution) log(SOLUTION_IGNORED);
    await client.patchFlow(id, { clientdata });
    return { action: 'patched', workflowId: id, matchedByName: false };
  }

  if (!flowName) {
    throw new PushError(
      input.isDsl
        ? 'Could not determine the flow name from the DSL. Add a name to @Flow({...}) or pass --id.'
        : 'Required: --id, or --name <flowName> to look up or create the flow ' +
          '(JSON files carry no flow name)'
    );
  }

  // 3: resolve by name, unless --create says skip straight to creating
  if (!input.create) {
    const { match, ambiguous } = await client.findFlowByName(flowName);
    if (ambiguous) {
      throw new PushError(
        `Multiple flows named '${flowName}' exist in this environment — pass --id to disambiguate which one to update`
      );
    }
    if (match) {
      if (solution) log(SOLUTION_IGNORED);
      log(`Matched existing flow '${flowName}' (${match.workflowid})`);
      await client.patchFlow(match.workflowid, { clientdata });
      return { action: 'patched', workflowId: match.workflowid, matchedByName: true };
    }
    if (input.noCreate) {
      throw new PushError(
        `No flow named '${flowName}' found in this environment, and --no-create was passed`
      );
    }
  }

  const created = await client.createFlow(
    { name: flowName, clientdata, ...(description ? { description } : {}) },
    { solutionUniqueName: solution },
  );
  return { action: 'created', workflowId: created.workflowid, name: flowName, solution, lookedUp: !input.create };
}
