import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runDiff, type DiffClient } from '../diff.js';
import { PushError } from '../flow-target.js';

const ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER_ID = 'bbbbbbbb-1111-2222-3333-444444444444';

function definition(inputs: unknown): string {
  return JSON.stringify({
    properties: {
      connectionReferences: {},
      definition: {
        $schema: 'x',
        contentVersion: '1.0.0.0',
        parameters: {},
        triggers: { manual: { type: 'Request', kind: 'Http', inputs: {} } },
        actions: { Compose: { type: 'Compose', runAfter: {}, inputs } },
      },
    },
    schemaVersion: '1.0.0.0',
  });
}

interface Recorder {
  client: DiffClient;
  lookups: string[];
  fetched: string[];
  logs: string[];
}

function makeClient(
  flows: Record<string, { name: string; clientdata?: string | null }>,
  opts: { named?: string; ambiguous?: boolean } = {},
): Recorder {
  const rec: Recorder = { client: null as any, lookups: [], fetched: [], logs: [] };
  rec.client = {
    async findFlowByName(name) {
      rec.lookups.push(name);
      const id = opts.named && flows[opts.named]?.name === name ? opts.named : undefined;
      if (!id) return { match: null, ambiguous: false };
      return { match: { workflowid: id, clientdata: flows[id].clientdata }, ambiguous: !!opts.ambiguous };
    },
    async getFlow(id) {
      rec.fetched.push(id);
      const f = flows[id];
      return f ? { workflowid: id, name: f.name, clientdata: f.clientdata } : null;
    },
  };
  return rec;
}

describe('runDiff — resolution', () => {
  it('uses --id without a name lookup and reports identical', async () => {
    const rec = makeClient({ [ID]: { name: 'Live Name', clientdata: definition(1) } });
    const out = await runDiff(rec.client, { clientdata: definition(1), explicitId: ID, flowName: 'Local Name', isDsl: true });
    assert.equal(out.workflowId, ID);
    assert.equal(out.flowName, 'Live Name');
    assert.equal(out.report.identical, true);
    assert.deepEqual(rec.lookups, []);
    assert.deepEqual(rec.fetched, [ID]);
  });

  it('uses the decorator workflowId, and --id wins over it with a warning', async () => {
    const rec = makeClient({ [ID]: { name: 'A', clientdata: definition(1) }, [OTHER_ID]: { name: 'B', clientdata: definition(2) } });
    const byDecorator = await runDiff(rec.client, { clientdata: definition(1), decoratorWorkflowId: ID, isDsl: true });
    assert.equal(byDecorator.workflowId, ID);

    const byId = await runDiff(
      rec.client,
      { clientdata: definition(1), explicitId: OTHER_ID, decoratorWorkflowId: ID, isDsl: true },
      (m) => rec.logs.push(m),
    );
    assert.equal(byId.workflowId, OTHER_ID);
    assert.equal(byId.report.identical, false);
    assert.ok(rec.logs.some((l) => l.includes('WARNING') && l.includes(ID)));
  });

  it('looks the flow up by name and logs the match', async () => {
    const rec = makeClient({ [ID]: { name: 'My Flow', clientdata: definition(1) } }, { named: ID });
    const out = await runDiff(rec.client, { clientdata: definition(1), flowName: 'My Flow', isDsl: true }, (m) => rec.logs.push(m));
    assert.equal(out.workflowId, ID);
    assert.deepEqual(rec.lookups, ['My Flow']);
    assert.ok(rec.logs.some((l) => l.includes("Matched existing flow 'My Flow'")));
  });

  it('refuses an ambiguous name', async () => {
    const rec = makeClient({ [ID]: { name: 'My Flow', clientdata: definition(1) } }, { named: ID, ambiguous: true });
    await assert.rejects(
      runDiff(rec.client, { clientdata: definition(1), flowName: 'My Flow', isDsl: true }),
      (err: unknown) => err instanceof PushError && /Multiple flows named 'My Flow'/.test((err as Error).message),
    );
  });

  it('fails when no flow of that name exists', async () => {
    const rec = makeClient({});
    await assert.rejects(
      runDiff(rec.client, { clientdata: definition(1), flowName: 'Nope', isDsl: true }),
      (err: unknown) => err instanceof PushError && /No flow named 'Nope'/.test((err as Error).message),
    );
  });

  it('fails for a JSON source without --id or --name', async () => {
    const rec = makeClient({});
    await assert.rejects(
      runDiff(rec.client, { clientdata: definition(1), isDsl: false }),
      (err: unknown) => err instanceof PushError && /--name/.test((err as Error).message),
    );
  });

  it('fails when the live flow has no clientdata', async () => {
    const rec = makeClient({ [ID]: { name: 'Empty', clientdata: null } });
    await assert.rejects(
      runDiff(rec.client, { clientdata: definition(1), explicitId: ID, isDsl: true }),
      (err: unknown) => err instanceof PushError && /no clientdata/.test((err as Error).message),
    );
  });

  it('fails when the id does not exist', async () => {
    const rec = makeClient({});
    await assert.rejects(
      runDiff(rec.client, { clientdata: definition(1), explicitId: ID, isDsl: true }),
      (err: unknown) => err instanceof PushError && /was not found/.test((err as Error).message),
    );
  });
});

describe('runDiff — report', () => {
  it('reports the changed action live → local', async () => {
    const rec = makeClient({ [ID]: { name: 'F', clientdata: definition({ a: 1 }) } });
    const out = await runDiff(rec.client, { clientdata: definition({ a: 2 }), explicitId: ID, isDsl: true });
    assert.equal(out.report.identical, false);
    assert.deepEqual(out.report.actions, [
      {
        name: 'Compose',
        status: 'changed',
        container: { live: '', local: '' },
        type: { live: 'Compose', local: 'Compose' },
        kinds: ['inputs'],
        changes: [{ path: 'inputs.a', live: 1, local: 2 }],
      },
    ]);
  });
});
