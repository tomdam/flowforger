import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FlowApiClient, FlowApiError, findEnvironmentForDataverse } from '../flow-api.js';

/** A fake fetch keyed by URL (query string included); a `text` route answers as non-JSON. */
function fakeFetch(routes: Record<string, unknown | { status: number; text: string; type?: string }>) {
  const calls: Array<{ url: string; auth?: string }> = [];
  const impl = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, auth: init?.headers?.Authorization });
    const route = routes[url];
    if (route === undefined) return new Response('not found', { status: 404, statusText: 'Not Found' });
    if (route && typeof route === 'object' && 'status' in (route as any) && 'text' in (route as any)) {
      const r = route as { status: number; text: string; type?: string };
      return new Response(r.text, { status: r.status, headers: { 'content-type': r.type ?? 'text/plain' } });
    }
    return new Response(JSON.stringify(route), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const BASE = 'https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple';
const ENV = 'env-1';
const FLOW = 'flow-1';

describe('FlowApiClient', () => {
  it('lists environments with their linked Dataverse URL and sends the bearer token', async () => {
    const f = fakeFetch({
      [`${BASE}/environments?api-version=2016-11-01`]: {
        value: [
          { name: 'Default-t', properties: { displayName: 'Default', isDefault: true, linkedEnvironmentMetadata: { instanceUrl: 'https://orgdef.crm.dynamics.com/' } } },
          { name: 'env-1', properties: { displayName: 'Dev', isDefault: false, linkedEnvironmentMetadata: { instanceUrl: 'https://orgdev.crm.dynamics.com/' } } },
        ],
      },
    });
    const client = new FlowApiClient({ token: 'tok', fetchImpl: f.impl });
    const envs = await client.listEnvironments();
    assert.deepEqual(envs, [
      { id: 'Default-t', displayName: 'Default', instanceUrl: 'https://orgdef.crm.dynamics.com/', isDefault: true },
      { id: 'env-1', displayName: 'Dev', instanceUrl: 'https://orgdev.crm.dynamics.com/', isDefault: false },
    ]);
    assert.equal(f.calls[0].auth, 'Bearer tok');
    assert.equal(findEnvironmentForDataverse(envs, 'https://ORGDEV.crm.dynamics.com')?.id, 'env-1');
    assert.equal(findEnvironmentForDataverse(envs, 'https://nowhere.crm.dynamics.com'), undefined);
  });

  it('lists runs with $top and a status filter', async () => {
    const f = fakeFetch({
      [`${BASE}/environments/${ENV}/flows/${FLOW}/runs?$top=5&$filter=status eq 'Failed'&api-version=2016-11-01`]: {
        value: [{ name: 'run-a', properties: { status: 'Failed', startTime: 't1', endTime: 't2', trigger: { name: 'manual' }, error: { code: 'ActionFailed' } } }],
      },
    });
    const client = new FlowApiClient({ token: 'tok', fetchImpl: f.impl });
    const runs = await client.listRuns(ENV, FLOW, { top: 5, status: 'Failed' });
    assert.deepEqual(runs, [{ runId: 'run-a', status: 'Failed', startTime: 't1', endTime: 't2', trigger: 'manual', error: { code: 'ActionFailed' } }]);
  });

  it('follows nextLink for actions and resolves inputs/outputs links without the bearer token', async () => {
    const actionsUrl = `${BASE}/environments/${ENV}/flows/${FLOW}/runs/run-a/actions?api-version=2016-11-01`;
    const nextUrl = `${BASE}/environments/${ENV}/flows/${FLOW}/runs/run-a/actions?api-version=2016-11-01&$skiptoken=abc`;
    const f = fakeFetch({
      [actionsUrl]: { value: [{ name: 'A', properties: { status: 'Succeeded', code: 'OK', inputsLink: { uri: 'https://blob/a-in' }, outputsLink: { uri: 'https://blob/a-out' } } }], nextLink: nextUrl },
      [nextUrl]: { value: [{ name: 'B', properties: { status: 'Skipped', code: 'ActionSkipped', repetitionCount: 3 } }] },
      'https://blob/a-in': { x: 1 },
      'https://blob/a-out': { status: 200, text: '', type: 'application/json' },
    });
    const client = new FlowApiClient({ token: 'tok', fetchImpl: f.impl });
    const actions = await client.listRunActions(ENV, FLOW, 'run-a');
    assert.deepEqual(actions, {
      A: { status: 'Succeeded', code: 'OK', inputs: { x: 1 }, outputs: null },
      B: { status: 'Skipped', code: 'ActionSkipped', repetitionCount: 3 },
    });
    assert.equal(f.calls.find((c) => c.url === 'https://blob/a-in')?.auth, undefined, 'pre-signed links carry no bearer token');
  });

  it('reads repetitions with their loop indexes and binary content as { $content-type, $content }', async () => {
    const url = `${BASE}/environments/${ENV}/flows/${FLOW}/runs/run-a/actions/Title/repetitions?api-version=2016-11-01`;
    const f = fakeFetch({
      [url]: { value: [{ name: '000000', properties: { status: 'Succeeded', repetitionIndexes: [{ scopeName: 'Each', itemIndex: 0 }], outputsLink: { uri: 'https://blob/t0' } } }] },
      'https://blob/t0': { status: 200, text: 'hi', type: 'text/plain' },
    });
    const client = new FlowApiClient({ token: 'tok', fetchImpl: f.impl });
    const reps = await client.listRepetitions(ENV, FLOW, 'run-a', 'Title');
    assert.deepEqual(reps, [{ status: 'Succeeded', outputs: { '$content-type': 'text/plain', $content: Buffer.from('hi').toString('base64') }, indexes: [{ scopeName: 'Each', itemIndex: 0 }] }]);
  });

  it('throws a FlowApiError with the status for a failed request', async () => {
    const f = fakeFetch({});
    const client = new FlowApiClient({ token: 'tok', fetchImpl: f.impl });
    await assert.rejects(client.getRun(ENV, FLOW, 'nope'), (e: unknown) => e instanceof FlowApiError && e.status === 404 && /Flow API 404/.test((e as Error).message));
  });
});
