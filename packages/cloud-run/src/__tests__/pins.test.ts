import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR } from '@flowforger/ir';
import { run, flattenTrace, type BaseConnector, type RunContext } from '@flowforger/engine';
import { cloudRunToPins, pinsToMockResolver, pinKey, isExternalCall, reclassifyPins, type CloudTraceEntry } from '../index.js';

/**
 * Pins: one per leaf action of a cloud run (per loop iteration), carrying what the cloud
 * recorded for it; the external ones (connector, HTTP, child flow) are pinned by default and
 * replay through `pinsToMockResolver`, everything else recomputes.
 */

const trigger = { id: 'trg_1', type: 'trigger', name: 'manual', kind: 'http', inputs: {} };
const compose = (name: string, value: unknown = 1) => ({ id: `act_${name}`, type: 'action', name, kind: 'compose', inputs: { value } });
const getItems = (name: string) => ({ id: `con_${name}`, type: 'connector', name, connector: 'sharepoint', operation: 'GetItems', params: { dataset: 'https://x', table: 't' } });
const http = (name: string) => ({ id: `act_${name}`, type: 'action', name, kind: 'http', inputs: { method: 'GET', uri: 'https://example.invalid' } });
const ir = (nodes: any[]): FlowIR => ({ name: 'F', nodes: [trigger, ...nodes] } as unknown as FlowIR);

const entry = (name: string, status: string, rest: Partial<CloudTraceEntry> = {}): CloudTraceEntry => ({ nodeId: `n_${name}`, name, status, ...rest });

describe('cloudRunToPins', () => {
  it('takes the trigger outputs and one pin per leaf action, external ones pinned by default', () => {
    const trace: CloudTraceEntry[] = [
      entry('manual', 'Succeeded', { trigger: true, outputs: { headers: { 'Content-Type': 'application/json' }, body: { id: 7 } } }),
      entry('Get_items', 'Succeeded', { code: 'OK', inputs: { host: {}, parameters: {} }, outputs: { statusCode: 200, body: { value: [1, 2] } } }),
      entry('Count', 'Succeeded', { code: 'OK', outputs: 2 }),
      entry('Try', 'Succeeded', {
        children: [entry('Call', 'Succeeded', { code: 'OK', outputs: { statusCode: 200, headers: {}, body: 'x' } })],
      }),
    ];
    const flow = ir([getItems('Get_items'), compose('Count'), { id: 'scp_1', type: 'scope', name: 'Try', actions: [http('Call')] }]);
    const { triggerOutputs, pins } = cloudRunToPins(trace, flow);
    assert.deepEqual(triggerOutputs, { headers: { 'Content-Type': 'application/json' }, body: { id: 7 } });
    assert.deepEqual(
      pins.map((p) => [p.name, p.iterationPath, p.external, p.available, p.pinned]),
      [
        ['Get_items', [], true, true, true],
        ['Count', [], false, true, false],
        ['Call', [], true, true, true],
      ],
      'blocks are not pins; a Compose is listed but not pinned',
    );
    assert.deepEqual(pins[0].outputs, { statusCode: 200, body: { value: [1, 2] } });
    assert.equal(pins[0].status, 'Succeeded');
    assert.equal(pins[0].code, 'OK');
  });

  it('keys loop children by their iteration path, nested and until loops included', () => {
    const trace: CloudTraceEntry[] = [
      entry('manual', 'Succeeded', { trigger: true, outputs: { headers: {}, body: null } }),
      entry('Outer', 'Succeeded', {
        iterations: [
          {
            index: 0,
            status: 'Succeeded',
            actions: [
              entry('Inner', 'Succeeded', {
                iterations: [
                  { index: 0, status: 'Succeeded', actions: [entry('Get', 'Succeeded', { outputs: { statusCode: 200, body: 'a0' } })] },
                  { index: 1, status: 'Succeeded', actions: [entry('Get', 'Succeeded', { outputs: { statusCode: 200, body: 'a1' } })] },
                ],
              }),
            ],
          },
          {
            index: 1,
            status: 'Succeeded',
            actions: [entry('Inner', 'Succeeded', { iterations: [{ index: 0, status: 'Succeeded', actions: [entry('Get', 'Succeeded', { outputs: { statusCode: 200, body: 'b0' } })] }] })],
          },
        ],
      }),
      entry('Until', 'Succeeded', {
        iterations: [
          { index: 0, status: 'Succeeded', actions: [entry('Poll', 'Succeeded', { outputs: { statusCode: 200, body: 'p0' } })] },
          { index: 1, status: 'Succeeded', actions: [entry('Poll', 'Succeeded', { outputs: { statusCode: 200, body: 'p1' } })] },
        ],
      }),
    ];
    const flow = ir([
      { id: 'fe_o', type: 'foreach', name: 'Outer', itemsExpression: '@createArray(1,2)', actions: [{ id: 'fe_i', type: 'foreach', name: 'Inner', itemsExpression: '@createArray(1)', actions: [getItems('Get')] }] },
      { id: 'du_1', type: 'dountil', name: 'Until', condition: '@true', limit: 5, actions: [getItems('Poll')] },
    ]);
    const { pins } = cloudRunToPins(trace, flow);
    assert.deepEqual(
      pins.map((p) => [pinKey(p.name, p.iterationPath), p.outputs.body]),
      [
        [pinKey('Get', [{ scopeName: 'Outer', itemIndex: 0 }, { scopeName: 'Inner', itemIndex: 0 }]), 'a0'],
        [pinKey('Get', [{ scopeName: 'Outer', itemIndex: 0 }, { scopeName: 'Inner', itemIndex: 1 }]), 'a1'],
        [pinKey('Get', [{ scopeName: 'Outer', itemIndex: 1 }, { scopeName: 'Inner', itemIndex: 0 }]), 'b0'],
        [pinKey('Poll', [{ scopeName: 'Until', itemIndex: 0 }]), 'p0'],
        [pinKey('Poll', [{ scopeName: 'Until', itemIndex: 1 }]), 'p1'],
      ],
    );
  });

  it('marks what cannot be replayed: skipped actions, secure outputs, names not in this flow', () => {
    const trace: CloudTraceEntry[] = [
      entry('manual', 'Succeeded', { trigger: true, outputs: { headers: {}, body: {} } }),
      entry('Skipped_one', 'Skipped', { code: 'ActionSkipped' }),
      entry('Secret', 'Succeeded', { code: 'OK' }),
      entry('Gone', 'Succeeded', { code: 'OK', outputs: { statusCode: 200, body: 1 } }),
      entry('Broken', 'Failed', { code: 'BadRequest', error: { code: 'InvalidTemplate', message: 'boom' } }),
      entry('Stop', 'Succeeded', { code: 'NotSpecified' }),
    ];
    const flow = ir([getItems('Skipped_one'), getItems('Secret'), compose('Broken'), { id: 'act_Stop', type: 'action', name: 'Stop', kind: 'terminate', inputs: { runStatus: 'Succeeded' } }]);
    const { pins } = cloudRunToPins(trace, flow);
    assert.deepEqual(
      pins.map((p) => [p.name, p.available, p.unavailableReason, p.pinned, p.external]),
      [
        ['Skipped_one', false, 'skipped', false, true],
        ['Secret', false, 'secure', false, true],
        ['Gone', false, 'not-in-flow', false, false],
        ['Broken', true, undefined, false, false],
        ['Stop', false, 'no-outputs', false, false],
      ],
      'only an external action without outputs had them secured; a Terminate simply has none',
    );
    assert.equal(pins[3].status, 'Failed');
    assert.deepEqual(pins[3].error, { code: 'InvalidTemplate', message: 'boom' });
  });
});

describe('cloudRunToPins with deferredOutputs', () => {
  const trace: CloudTraceEntry[] = [
    entry('manual', 'Succeeded', { trigger: true, outputs: { headers: {}, body: {} } }),
    entry('Get_items', 'Succeeded', { code: 'OK', outputs: { statusCode: 200, body: { value: [] } } }),
    entry('Total', 'Succeeded', { code: 'OK' }),
    entry('Secret', 'Succeeded', { code: 'OK' }),
  ];
  const flow = ir([getItems('Get_items'), compose('Total'), getItems('Secret')]);

  it('marks a local pin without outputs as deferred and available when the predicate says so', () => {
    const { pins } = cloudRunToPins(trace, flow, { deferredOutputs: (name) => name === 'Total' });
    const total = pins.find((p) => p.name === 'Total')!;
    assert.equal(total.outputsDeferred, true);
    assert.equal(total.available, true);
    assert.equal(total.unavailableReason, undefined);
    assert.equal(total.pinned, false);
  });

  it('still reports no-outputs when the predicate is false', () => {
    const { pins } = cloudRunToPins(trace, flow, { deferredOutputs: () => false });
    const total = pins.find((p) => p.name === 'Total')!;
    assert.equal(total.outputsDeferred, undefined);
    assert.equal(total.available, false);
    assert.equal(total.unavailableReason, 'no-outputs');
  });

  it('never defers an external pin', () => {
    const { pins } = cloudRunToPins(trace, flow, { deferredOutputs: () => true });
    const secret = pins.find((p) => p.name === 'Secret')!;
    assert.equal(secret.outputsDeferred, undefined);
    assert.equal(secret.unavailableReason, 'secure');
  });

  it('hands the predicate the iteration path', () => {
    const seen: Array<[string, number[]]> = [];
    const loopTrace: CloudTraceEntry[] = [
      entry('Loop', 'Succeeded', { iterations: [{ index: 0, actions: [entry('Note', 'Succeeded')] }, { index: 1, actions: [entry('Note', 'Succeeded')] }] }),
    ];
    const loopFlow = ir([{ id: 'fe_1', type: 'foreach', name: 'Loop', foreach: '@createArray(1,2)', actions: [compose('Note')] }]);
    cloudRunToPins(loopTrace, loopFlow, { deferredOutputs: (name, path) => { seen.push([name, path.map((i) => i.itemIndex)]); return true; } });
    assert.deepEqual(seen, [['Note', [0]], ['Note', [1]]]);
  });
});

describe('reclassifyPins', () => {
  it('turns a deferred pin with no outputs into not-downloaded, and keeps one whose outputs arrived', () => {
    const pins = [
      { name: 'Note', iterationPath: [], status: 'Succeeded', external: false, available: true, pinned: false, outputsDeferred: true as const },
      { name: 'Note2', iterationPath: [], status: 'Succeeded', outputs: 5, external: false, available: true, pinned: true, outputsDeferred: true as const },
    ];
    const out = reclassifyPins(pins, ir([compose('Note'), compose('Note2')]));
    assert.deepEqual(out.map((p) => [p.name, p.available, p.unavailableReason, p.pinned]), [
      ['Note', false, 'not-downloaded', false],
      ['Note2', true, undefined, true],
    ]);
    assert.equal(out[0].outputsDeferred, true, 'the flag is kept so the pane can explain the row');
  });

  it('recomputes external/available against another flow and keeps the pinned choice where it still can', () => {
    const pins = [
      { name: 'Get', iterationPath: [], status: 'Succeeded', outputs: { statusCode: 200, body: 1 }, external: false, available: true, pinned: false },
      { name: 'Gone', iterationPath: [], status: 'Succeeded', outputs: 1, external: true, available: true, pinned: true },
      { name: 'Note', iterationPath: [], status: 'Succeeded', outputs: 'x', external: true, available: true, pinned: true },
      { name: 'Skip', iterationPath: [], status: 'Skipped', external: true, available: true, pinned: true },
    ];
    const out = reclassifyPins(pins, ir([getItems('Get'), compose('Note'), getItems('Skip')]));
    assert.deepEqual(out.map((p) => [p.name, p.external, p.available, p.unavailableReason, p.pinned]), [
      ['Get', true, true, undefined, false],
      ['Gone', false, false, 'not-in-flow', false],
      ['Note', false, true, undefined, true],
      ['Skip', true, false, 'skipped', false],
    ]);
  });
});

describe('pinsToMockResolver', () => {
  class SpyConnector implements BaseConnector {
    readonly seen: string[] = [];
    async invoke(_op: string, inputs: any, _ctx: RunContext): Promise<any> {
      this.seen.push(inputs.table);
      return { value: ['live'] };
    }
  }

  it('replays pinned actions per iteration, runs unpinned ones live, and replays a failure as a failure', async () => {
    const flow: FlowIR = {
      name: 'F',
      nodes: [
        trigger,
        { id: 'fe_1', type: 'foreach', name: 'Each', itemsExpression: '@createArray(1, 2, 3)', runtimeConfiguration: { concurrency: { repetitions: 1 } }, actions: [getItems('Get')] },
        { id: 'scp_t', type: 'scope', name: 'Try', actions: [getItems('Missing')], runAfter: { Each: ['Succeeded'] } },
        { id: 'scp_c', type: 'scope', name: 'Catch', runAfter: { Try: ['Failed'] }, actions: [compose('Report', "@actions('Missing')?['code']")] },
      ],
    } as any;
    const trace: CloudTraceEntry[] = [
      entry('manual', 'Succeeded', { trigger: true, outputs: { headers: {}, body: { x: 1 } } }),
      entry('Each', 'Succeeded', {
        iterations: [
          { index: 0, status: 'Succeeded', actions: [entry('Get', 'Succeeded', { outputs: { statusCode: 200, body: { value: ['cloud-0'] } } })] },
          { index: 1, status: 'Succeeded', actions: [entry('Get', 'Succeeded', { outputs: { statusCode: 200, body: { value: ['cloud-1'] } } })] },
        ],
      }),
      entry('Try', 'Failed', { children: [entry('Missing', 'Failed', { code: 'NotFound', outputs: { statusCode: 404, body: { status: 404, message: 'Item Not Found' } } })] }),
      entry('Catch', 'Succeeded', { children: [entry('Report', 'Succeeded', { outputs: 'NotFound' })] }),
    ];
    const { triggerOutputs, pins } = cloudRunToPins(trace, flow);
    // Unpin the second iteration's Get: it runs live.
    pins.find((p) => p.name === 'Get' && p.iterationPath[0].itemIndex === 1)!.pinned = false;
    const sharepoint = new SpyConnector();
    const r = await run(flow, { input: triggerOutputs, connectors: { sharepoint }, mocks: pinsToMockResolver(pins) });

    assert.equal(r.status, 'Succeeded');
    assert.deepEqual(r.trace[0].outputs, { headers: {}, body: { x: 1 } }, 'the trigger outputs are used whole');
    const each = r.trace.find((t) => t.name === 'Each')!;
    assert.deepEqual(each.iterations!.map((it) => [it.actions[0].mocked ?? false, it.actions[0].outputs.body.value[0]]), [
      [true, 'cloud-0'],
      [false, 'live'],
      [false, 'live'],
    ], 'a third iteration the cloud never ran has no pin and runs live');
    assert.equal(sharepoint.seen.length, 2);
    const flat = flattenTrace(r.trace);
    assert.equal(flat.find((t) => t.name === 'Missing')!.status, 'Failed');
    assert.equal(flat.find((t) => t.name === 'Missing')!.mocked, true);
    assert.equal(flat.find((t) => t.name === 'Report')!.outputs, 'NotFound');
  });
});

describe('isExternalCall', () => {
  it('is true for connector, HTTP and child-flow actions only', () => {
    assert.equal(isExternalCall(getItems('G') as any), true);
    assert.equal(isExternalCall(http('H') as any), true);
    assert.equal(isExternalCall({ id: 'a', type: 'action', name: 'W', kind: 'workflow', inputs: {} } as any), true);
    assert.equal(isExternalCall(compose('C') as any), false);
    assert.equal(isExternalCall({ id: 's', type: 'scope', name: 'S', actions: [] } as any), false);
  });
});
