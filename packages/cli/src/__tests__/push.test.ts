import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPush, PushError, type PushClient, type PushInput } from '../push.js';

const EXISTING_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const NEW_ID = 'bbbbbbbb-1111-2222-3333-444444444444';

interface Recorder {
  client: PushClient;
  patched: Array<{ id: string; clientdata: string }>;
  created: Array<{ payload: any; opts: any }>;
  lookups: string[];
  logs: string[];
}

/**
 * A fake client. `existing` is the flow name that findFlowByName should
 * match; pass `{ ambiguous: true }` to simulate two flows sharing that name.
 */
function makeClient(existing?: string, opts: { ambiguous?: boolean } = {}): Recorder {
  const rec: Recorder = { client: null as any, patched: [], created: [], lookups: [], logs: [] };
  rec.client = {
    async findFlowByName(name) {
      rec.lookups.push(name);
      if (existing !== name) return { match: null, ambiguous: false };
      return { match: { workflowid: EXISTING_ID }, ambiguous: !!opts.ambiguous };
    },
    async patchFlow(id, payload) {
      rec.patched.push({ id, clientdata: payload.clientdata });
      return null;
    },
    async createFlow(payload, opts) {
      rec.created.push({ payload, opts });
      return { workflowid: NEW_ID };
    },
  };
  return rec;
}

function input(overrides: Partial<PushInput> = {}): PushInput {
  return { clientdata: '{"definition":1}', flowName: 'My Flow', isDsl: true, ...overrides };
}

describe('runPush — update paths', () => {
  it('patches the explicit --id without any name lookup', async () => {
    const rec = makeClient('My Flow');
    const result = await runPush(rec.client, input({ explicitId: EXISTING_ID }), (m) => rec.logs.push(m));

    assert.deepEqual(result, { action: 'patched', workflowId: EXISTING_ID, matchedByName: false });
    assert.deepEqual(rec.patched, [{ id: EXISTING_ID, clientdata: '{"definition":1}' }]);
    assert.equal(rec.lookups.length, 0, 'must not look up by name when an id is given');
    assert.equal(rec.created.length, 0);
  });

  it('patches the decorator workflowId without any name lookup', async () => {
    const rec = makeClient('My Flow');
    const result = await runPush(rec.client, input({ decoratorWorkflowId: EXISTING_ID }));

    assert.equal(result.action, 'patched');
    assert.equal(rec.patched[0].id, EXISTING_ID);
    assert.equal(rec.lookups.length, 0);
  });

  it('warns when --id disagrees with the decorator workflowId', async () => {
    const rec = makeClient();
    await runPush(
      rec.client,
      input({ explicitId: EXISTING_ID, decoratorWorkflowId: NEW_ID }),
      (m) => rec.logs.push(m),
    );

    assert.equal(rec.patched[0].id, EXISTING_ID, '--id wins');
    assert.ok(rec.logs.some((l) => l.includes('WARNING') && l.includes(NEW_ID)));
  });

  it('patches the flow it finds by name and says so', async () => {
    const rec = makeClient('My Flow');
    const result = await runPush(rec.client, input(), (m) => rec.logs.push(m));

    assert.deepEqual(result, { action: 'patched', workflowId: EXISTING_ID, matchedByName: true });
    assert.deepEqual(rec.lookups, ['My Flow']);
    assert.equal(rec.patched[0].id, EXISTING_ID);
    assert.ok(rec.logs.some((l) => l.includes("Matched existing flow 'My Flow'")));
  });

  it('warns that --solution is ignored when updating (matched by name)', async () => {
    const rec = makeClient('My Flow');
    await runPush(rec.client, input({ solution: 'MySolution' }), (m) => rec.logs.push(m));

    assert.ok(rec.logs.some((l) => l.includes('WARNING') && l.includes('--solution')));
  });

  it('warns that --solution is ignored when updating via explicit --id', async () => {
    const rec = makeClient();
    await runPush(rec.client, input({ explicitId: EXISTING_ID, solution: 'MySolution' }), (m) => rec.logs.push(m));

    assert.ok(rec.logs.some((l) => l.includes('WARNING') && l.includes('--solution')));
  });

  it('does not warn when --id and the decorator workflowId agree', async () => {
    const rec = makeClient();
    await runPush(
      rec.client,
      input({ explicitId: EXISTING_ID, decoratorWorkflowId: EXISTING_ID }),
      (m) => rec.logs.push(m),
    );

    assert.equal(rec.patched[0].id, EXISTING_ID);
    assert.ok(!rec.logs.some((l) => l.includes('WARNING')));
  });
});

describe('runPush — create path', () => {
  it('creates the flow when no id and no name match exist', async () => {
    const rec = makeClient();
    const result = await runPush(rec.client, input({ description: 'A demo flow' }));

    assert.deepEqual(result, { action: 'created', workflowId: NEW_ID, name: 'My Flow', solution: undefined, lookedUp: true });
    assert.equal(rec.patched.length, 0);
    assert.equal(rec.created.length, 1);
    assert.deepEqual(rec.created[0].payload, {
      name: 'My Flow',
      clientdata: '{"definition":1}',
      description: 'A demo flow',
    });
  });

  it('omits description from the createFlow payload when none was given', async () => {
    const rec = makeClient();
    await runPush(rec.client, input());

    assert.deepEqual(rec.created[0].payload, {
      name: 'My Flow',
      clientdata: '{"definition":1}',
    });
    assert.ok(!('description' in rec.created[0].payload));
  });

  it('forwards --solution to createFlow', async () => {
    const rec = makeClient();
    const result = await runPush(rec.client, input({ solution: 'MySolution' }));

    assert.equal(rec.created[0].opts.solutionUniqueName, 'MySolution');
    assert.equal(result.action === 'created' && result.solution, 'MySolution');
  });

  it('--create skips the name lookup entirely', async () => {
    const rec = makeClient('My Flow'); // a match exists, but --create ignores it
    const result = await runPush(rec.client, input({ create: true }));

    assert.equal(result.action, 'created');
    assert.equal(rec.lookups.length, 0);
    assert.equal(rec.patched.length, 0);
    assert.equal(result.action === 'created' && result.lookedUp, false, '--create never looked, so it cannot claim to');
  });

  it('marks the create result as looked-up when it fell through a name-lookup miss', async () => {
    const rec = makeClient(); // no match
    const result = await runPush(rec.client, input());

    assert.equal(result.action, 'created');
    assert.equal(result.action === 'created' && result.lookedUp, true);
  });
});

describe('runPush — errors', () => {
  async function expectPushError(inp: PushInput, pattern: RegExp, existing?: string) {
    const rec = makeClient(existing);
    await assert.rejects(() => runPush(rec.client, inp), (err: unknown) => {
      assert.ok(err instanceof PushError, `expected PushError, got ${err}`);
      assert.match((err as Error).message, pattern);
      return true;
    });
    return rec;
  }

  it('rejects --create together with --no-create', async () => {
    await expectPushError(input({ create: true, noCreate: true }), /cannot be used together/);
  });

  it('rejects --create when an --id is present', async () => {
    await expectPushError(input({ create: true, explicitId: EXISTING_ID }), /--create cannot be combined with --id/);
  });

  it('rejects --create when the decorator carries a workflowId', async () => {
    await expectPushError(
      input({ create: true, decoratorWorkflowId: EXISTING_ID }),
      /--create cannot be combined with the workflowId/,
    );
  });

  it('--no-create turns a lookup miss into an error and creates nothing', async () => {
    const rec = await expectPushError(input({ noCreate: true }), /No flow named 'My Flow'/);
    assert.equal(rec.created.length, 0);
  });

  it('requires --name for a JSON file with no id', async () => {
    await expectPushError(
      input({ flowName: undefined, isDsl: false }),
      /--name/,
    );
  });

  it('reports a missing DSL flow name distinctly', async () => {
    await expectPushError(
      input({ flowName: undefined, isDsl: true }),
      /from the DSL/,
    );
  });

  it('refuses an ambiguous name match: no patch, no create, tells the user to pass --id', async () => {
    const rec = makeClient('My Flow', { ambiguous: true });
    await assert.rejects(() => runPush(rec.client, input()), (err: unknown) => {
      assert.ok(err instanceof PushError);
      assert.match((err as Error).message, /Multiple flows named 'My Flow'/);
      assert.match((err as Error).message, /--id/);
      return true;
    });
    assert.equal(rec.patched.length, 0);
    assert.equal(rec.created.length, 0);
  });

  it('--create bypasses an ambiguous name match too (never looks it up)', async () => {
    const rec = makeClient('My Flow', { ambiguous: true });
    const result = await runPush(rec.client, input({ create: true }));

    assert.equal(result.action, 'created');
    assert.equal(rec.lookups.length, 0);
  });
});
