import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '@flowforger/engine';
import type { FlowIR } from '@flowforger/ir';
import { fetchCloudRun, prepareReplay, type ReplayFlowApi } from '../replay-run.js';
import { createRunGuard } from '../run-mocks.js';

/**
 * `flowforger run --replay-run <runId>`: the cloud run's trigger outputs become the input,
 * every external action it recorded is pinned (per loop iteration), `--live X` unpins X,
 * and the `--live` guard stops the run before anything that is neither pinned nor listed.
 */

const trigger = { id: 'trg_1', type: 'trigger', name: 'manual', kind: 'http', inputs: {} };
const compose = (name: string, value: unknown = 1) => ({ id: `act_${name}`, type: 'action', name, kind: 'compose', inputs: { value } });
const getItems = (name: string, extra: Record<string, unknown> = {}) => ({
  id: `con_${name}`, type: 'connector', name, connector: 'sharepoint', operation: 'GetItems', params: { dataset: 'https://x', table: 't' }, ...extra,
});
const ir = (nodes: any[]): FlowIR => ({ name: 'F', nodes: [trigger, ...nodes] } as unknown as FlowIR);

/** A Flow API answering for one run: links are resolved from `contents` by uri. */
function fakeApi(opts: {
  run: Record<string, unknown>;
  actions: Record<string, { status: string; code?: string; error?: unknown; inputsLink?: string; outputsLink?: string; repetitionCount?: number }>;
  repetitions?: Record<string, Array<{ indexes: Array<{ scopeName: string; itemIndex: number }>; status: string; outputsLink?: string }>>;
  contents: Record<string, unknown>;
}): ReplayFlowApi & { calls: string[] } {
  const link = (uri?: string) => (uri ? { uri } : undefined);
  const api: ReplayFlowApi & { calls: string[] } = {
    calls: [],
    async getRun(environmentId, flowId, runId) {
      api.calls.push(`getRun ${environmentId} ${flowId} ${runId}`);
      return { name: runId, properties: opts.run };
    },
    async fetchLink(l) {
      if (!l?.uri) return undefined;
      api.calls.push(`fetch ${l.uri}`);
      return opts.contents[l.uri];
    },
    async listRunActions() {
      api.calls.push('actions');
      const out: Record<string, any> = {};
      for (const [name, a] of Object.entries(opts.actions)) {
        out[name] = {
          status: a.status,
          ...(a.code !== undefined ? { code: a.code } : {}),
          ...(a.error !== undefined ? { error: a.error } : {}),
          ...(a.repetitionCount !== undefined ? { repetitionCount: a.repetitionCount } : {}),
          ...(a.inputsLink ? { inputs: opts.contents[a.inputsLink] } : {}),
          ...(a.outputsLink ? { outputs: opts.contents[a.outputsLink] } : {}),
        };
      }
      return out;
    },
    async listRepetitions(_e, _f, _r, actionName) {
      api.calls.push(`repetitions ${actionName}`);
      return (opts.repetitions?.[actionName] ?? []).map((rep) => ({
        status: rep.status,
        indexes: rep.indexes,
        ...(rep.outputsLink ? { outputs: opts.contents[rep.outputsLink] } : {}),
      }));
    },
  };
  return api;
}

describe('fetchCloudRun', () => {
  it('fetches the run, resolves the trigger links and nests the actions by the live definition', async () => {
    const api = fakeApi({
      run: {
        status: 'Succeeded', startTime: '2026-10-17T10:00:00Z', endTime: '2026-10-17T10:00:02Z',
        trigger: { name: 'manual', status: 'Succeeded', inputsLink: { uri: 'u:tin' }, outputsLink: { uri: 'u:tout' } },
      },
      actions: {
        Get_items: { status: 'Succeeded', code: 'OK', inputsLink: 'u:gin', outputsLink: 'u:gout' },
        Count: { status: 'Succeeded', code: 'OK', outputsLink: 'u:cout' },
      },
      contents: {
        'u:tin': { method: 'POST' },
        'u:tout': { headers: { 'Content-Type': 'application/json' }, body: { id: 7 } },
        'u:gin': { host: {}, parameters: {} },
        'u:gout': { statusCode: 200, body: { value: [1, 2] } },
        'u:cout': 2,
      },
    });
    const cloud = await fetchCloudRun(api, 'env-1', 'flow-1', 'run-1', ir([getItems('Get_items'), compose('Count')]));
    assert.equal(cloud.runId, 'run-1');
    assert.equal(cloud.status, 'Succeeded');
    assert.equal(cloud.startTime, '2026-10-17T10:00:00Z');
    assert.deepEqual(cloud.trace[0], {
      nodeId: 'trg_1', name: 'manual', status: 'Succeeded', trigger: true,
      inputs: { method: 'POST' }, outputs: { headers: { 'Content-Type': 'application/json' }, body: { id: 7 } },
    });
    assert.deepEqual(cloud.trace.slice(1).map((t) => [t.name, t.status, t.outputs]), [
      ['Get_items', 'Succeeded', { statusCode: 200, body: { value: [1, 2] } }],
      ['Count', 'Succeeded', 2],
    ]);
    assert.ok(api.calls.includes('getRun env-1 flow-1 run-1'));
  });

  it('keeps the run error', async () => {
    const api = fakeApi({ run: { status: 'Failed', error: { code: 'FFC_TERMINATED', message: 'stop' }, trigger: { name: 'manual', status: 'Succeeded' } }, actions: {}, contents: {} });
    const cloud = await fetchCloudRun(api, 'e', 'f', 'r', ir([]));
    assert.equal(cloud.status, 'Failed');
    assert.deepEqual(cloud.error, { code: 'FFC_TERMINATED', message: 'stop' });
  });
});

describe('prepareReplay', () => {
  const loopFlow = ir([
    getItems('Get_items'),
    { id: 'fe_1', type: 'foreach', name: 'Each', itemsExpression: "@body('Get_items')?['value']", runtimeConfiguration: { concurrency: { repetitions: 1 } }, actions: [getItems('Get_one'), compose('Title', "@items('Each')")], runAfter: { Get_items: ['Succeeded'] } },
    { ...getItems('Create_summary'), runAfter: { Each: ['Succeeded'] } },
    { ...compose('Done', "@outputs('Create_summary')?['statusCode']"), runAfter: { Create_summary: ['Succeeded'] } },
  ]);

  async function loopRun() {
    const api = fakeApi({
      run: { status: 'Succeeded', trigger: { name: 'manual', status: 'Succeeded', outputsLink: { uri: 'u:tout' } } },
      actions: {
        Get_items: { status: 'Succeeded', code: 'OK', outputsLink: 'u:items' },
        Each: { status: 'Succeeded', repetitionCount: 2 },
        Get_one: { status: 'Succeeded', code: 'OK', outputsLink: 'u:one1' },
        Title: { status: 'Succeeded', code: 'OK', outputsLink: 'u:title1' },
        Create_summary: { status: 'Succeeded', code: 'Created', outputsLink: 'u:created' },
        Done: { status: 'Succeeded', code: 'OK', outputsLink: 'u:done' },
      },
      repetitions: {
        Get_one: [
          { indexes: [{ scopeName: 'Each', itemIndex: 0 }], status: 'Succeeded', outputsLink: 'u:one0' },
          { indexes: [{ scopeName: 'Each', itemIndex: 1 }], status: 'Succeeded', outputsLink: 'u:one1' },
        ],
        Title: [
          { indexes: [{ scopeName: 'Each', itemIndex: 0 }], status: 'Succeeded', outputsLink: 'u:title0' },
          { indexes: [{ scopeName: 'Each', itemIndex: 1 }], status: 'Succeeded', outputsLink: 'u:title1' },
        ],
      },
      contents: {
        'u:tout': { headers: { 'Content-Type': 'application/json' }, body: { who: 'cloud' } },
        'u:items': { statusCode: 200, body: { value: ['a', 'b'] } },
        'u:one0': { statusCode: 200, body: { Title: 'cloud-a' } },
        'u:one1': { statusCode: 200, body: { Title: 'cloud-b' } },
        'u:title0': 'a',
        'u:title1': 'b',
        'u:created': { statusCode: 201, body: { Id: 99 } },
        'u:done': 201,
      },
    });
    return fetchCloudRun(api, 'e', 'f', 'r', loopFlow);
  }

  it('pins every external action per iteration, uses the trigger outputs as input, and replays without a connector', async () => {
    const cloud = await loopRun();
    const replay = prepareReplay(cloud, loopFlow, { live: new Set() });
    assert.deepEqual(replay.input, { headers: { 'Content-Type': 'application/json' }, body: { who: 'cloud' } });
    assert.deepEqual(replay.pins.filter((p) => p.pinned).map((p) => [p.name, p.iterationPath.map((i) => i.itemIndex)]), [
      ['Get_items', []], ['Get_one', [0]], ['Get_one', [1]], ['Create_summary', []],
    ]);
    assert.deepEqual(replay.warnings, []);
    const guard = createRunGuard({ live: new Set(), isMocked: replay.isMocked })!;
    const r = await run(loopFlow, { input: replay.input, mocks: replay.mocks, onBeforeExecute: guard.hook as any });
    assert.equal(r.status, 'Succeeded');
    assert.equal(r.stopped, undefined);
    const each = r.trace.find((t) => t.name === 'Each')!;
    assert.deepEqual(each.iterations!.map((it) => [it.actions[0].mocked, it.actions[0].outputs.body.Title, it.actions[1].mocked ?? false, it.actions[1].outputs]), [
      [true, 'cloud-a', false, 'a'],
      [true, 'cloud-b', false, 'b'],
    ], 'the Compose inside the loop is recomputed from the pinned items');
    assert.equal(r.trace.find((t) => t.name === 'Done')!.outputs, 201);
  });

  it('--live unpins an action (every iteration) so it calls out, and --in replaces the trigger outputs', async () => {
    const cloud = await loopRun();
    const replay = prepareReplay(cloud, loopFlow, { live: new Set(['Get_one']), input: { who: 'me' } });
    assert.deepEqual(replay.input, { who: 'me' });
    assert.deepEqual(replay.pins.filter((p) => p.name === 'Get_one').map((p) => p.pinned), [false, false]);
    const seen: string[] = [];
    const sharepoint = { async invoke(_op: string, inputs: any) { seen.push(inputs.table); return { Title: 'live' }; } };
    const guard = createRunGuard({ live: new Set(['Get_one']), isMocked: replay.isMocked })!;
    const r = await run(loopFlow, { input: replay.input, connectors: { sharepoint }, mocks: replay.mocks, onBeforeExecute: guard.hook as any });
    assert.equal(r.status, 'Succeeded');
    assert.equal(seen.length, 2, 'Get_one ran live twice');
    assert.equal(r.trace.find((t) => t.name === 'Get_items')!.mocked, true, 'the others stay pinned');
  });

  it('safe mode: an external action the run has no pin for stops the run before it', async () => {
    const cloud = await loopRun();
    // The local flow gained an action the cloud run never had.
    const localFlow = ir([
      getItems('Get_items'),
      { ...getItems('Get_extra'), runAfter: { Get_items: ['Succeeded'] } },
    ]);
    const replay = prepareReplay(cloud, localFlow, { live: new Set() });
    const guard = createRunGuard({ live: new Set(), isMocked: replay.isMocked })!;
    const r = await run(localFlow, { input: replay.input, mocks: replay.mocks, onBeforeExecute: guard.hook as any });
    assert.equal(r.stopped, true);
    assert.equal(r.stoppedBefore?.name, 'Get_extra');
    assert.equal(guard.deniedLive(), 'Get_extra');
  });

  it('warns about pins that cannot replay: secure outputs and actions not in this flow', async () => {
    const api = fakeApi({
      run: { status: 'Succeeded', trigger: { name: 'manual', status: 'Succeeded' } },
      actions: {
        Secret: { status: 'Succeeded', code: 'OK' },
        Old_action: { status: 'Succeeded', code: 'OK', outputsLink: 'u:old' },
        Skipped_one: { status: 'Skipped', code: 'ActionSkipped' },
      },
      contents: { 'u:old': { statusCode: 200, body: 1 } },
    });
    const liveFlow = ir([getItems('Secret'), getItems('Old_action'), getItems('Skipped_one')]);
    const localFlow = ir([getItems('Secret'), getItems('Skipped_one')]);
    const cloud = await fetchCloudRun(api, 'e', 'f', 'r', liveFlow);
    const replay = prepareReplay(cloud, localFlow, { live: new Set() });
    assert.equal(replay.input === undefined || typeof replay.input === 'object', true);
    assert.deepEqual(replay.pins.map((p) => [p.name, p.pinned, p.unavailableReason]), [
      ['Secret', false, 'secure'],
      ['Old_action', false, 'not-in-flow'],
      ['Skipped_one', false, 'skipped'],
    ]);
    assert.equal(replay.warnings.length, 2, 'secure and not-in-flow are worth a warning; a skipped action is not');
    assert.match(replay.warnings[0], /Secret/);
    assert.match(replay.warnings[0], /secure/i);
    assert.match(replay.warnings[1], /Old_action/);
    assert.match(replay.warnings[1], /not in this flow/i);
  });

  it('a --mock for an action wins over its pin at every iteration', async () => {
    const cloud = await loopRun();
    const replay = prepareReplay(cloud, loopFlow, { live: new Set(), mockMap: { Get_one: { statusCode: 200, body: { Title: 'from --mock' } } } });
    const guard = createRunGuard({ live: new Set(), isMocked: replay.isMocked })!;
    const r = await run(loopFlow, { input: replay.input, mocks: replay.mocks, onBeforeExecute: guard.hook as any });
    assert.equal(r.status, 'Succeeded');
    const each = r.trace.find((t) => t.name === 'Each')!;
    assert.deepEqual(each.iterations!.map((it) => it.actions[0].outputs.body.Title), ['from --mock', 'from --mock']);
  });

  it('replays a failed run: the failed action fails locally and the catch path runs', async () => {
    const flow = ir([
      { id: 'scp_t', type: 'scope', name: 'Try', actions: [getItems('Get_missing'), { ...compose('After', 1), runAfter: { Get_missing: ['Succeeded'] } }] },
      { id: 'scp_c', type: 'scope', name: 'Catch', runAfter: { Try: ['Failed'] }, actions: [compose('Report', "@actions('Get_missing')?['code']")] },
      { id: 'act_term', type: 'action', name: 'Stop', kind: 'terminate', inputs: { runStatus: 'Failed', runError: { code: 'FFC_TERMINATED', message: 'reproduced' } }, runAfter: { Catch: ['Succeeded'] } },
    ]);
    const api = fakeApi({
      run: { status: 'Failed', error: { code: 'FFC_TERMINATED', message: 'reproduced' }, trigger: { name: 'manual', status: 'Succeeded', outputsLink: { uri: 'u:t' } } },
      actions: {
        Try: { status: 'Failed', code: 'ActionFailed' },
        Get_missing: { status: 'Failed', code: 'NotFound', outputsLink: 'u:missing' },
        After: { status: 'Skipped', code: 'ActionSkipped' },
        Catch: { status: 'Succeeded' },
        Report: { status: 'Succeeded', code: 'OK', outputsLink: 'u:report' },
        Stop: { status: 'Succeeded' },
      },
      contents: {
        'u:t': { headers: {}, body: {} },
        'u:missing': { statusCode: 404, body: { status: 404, message: 'Item Not Found' } },
        'u:report': 'NotFound',
      },
    });
    const cloud = await fetchCloudRun(api, 'e', 'f', 'r', flow);
    const replay = prepareReplay(cloud, flow, { live: new Set() });
    const r = await run(flow, { input: replay.input, mocks: replay.mocks });
    assert.equal(r.status, 'Failed');
    assert.deepEqual(r.error, { code: 'FFC_TERMINATED', message: 'reproduced' });
    const report = r.trace.find((t) => t.name === 'Catch')!.children!.find((c) => c.name === 'Report')!;
    assert.equal(report.outputs, 'NotFound');
  });
});
