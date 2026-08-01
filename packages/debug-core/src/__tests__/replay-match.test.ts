import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorCallLog, wrapConnectorsForReplay, stableStringify } from '../replay.js';
import type { BaseConnector } from '@flowforger/engine';

class FakeConnector implements BaseConnector {
  invocations: Array<{ operation: string; inputs: any }> = [];
  constructor(private respond: (operation: string, inputs: any) => any) {}
  async invoke(operation: string, inputs: any): Promise<any> {
    this.invocations.push({ operation, inputs });
    return this.respond(operation, inputs);
  }
}

function logWith(...calls: Array<[string, string, any, any]>): ConnectorCallLog {
  const log = new ConnectorCallLog();
  for (const [c, op, inputs, response] of calls) log.record(c, op, inputs, response);
  return log;
}

describe('wrapConnectorsForReplay', () => {
  it('replays a matching call without invoking the connector', async () => {
    const fake = new FakeConnector(() => ({ live: true }));
    const prev = logWith(['sp', 'GetItems', { list: 'A' }, { items: [1, 2] }]);
    const newLog = new ConnectorCallLog();
    const replayed: string[] = [];
    const wrapped = wrapConnectorsForReplay({ sp: fake }, prev, newLog, {
      onReplayed: (call) => replayed.push(call.operation),
    });

    const result = await wrapped['sp'].invoke('GetItems', { list: 'A' }, {} as any);

    assert.deepEqual(result, { items: [1, 2] });
    assert.equal(fake.invocations.length, 0, 'live connector must not be called on a hit');
    assert.deepEqual(replayed, ['GetItems']);
    assert.equal(newLog.calls.length, 1, 'replayed call must be re-recorded for the next apply');
  });

  it('matches key-order-insensitively on inputs', async () => {
    const fake = new FakeConnector(() => ({ live: true }));
    const prev = logWith(['sp', 'GetItems', { a: 1, b: 2 }, { hit: true }]);
    const wrapped = wrapConnectorsForReplay({ sp: fake }, prev, new ConnectorCallLog());
    const result = await wrapped['sp'].invoke('GetItems', { b: 2, a: 1 }, {} as any);
    assert.deepEqual(result, { hit: true });
    assert.equal(fake.invocations.length, 0);
  });

  it('consumes entries in order: identical repeated calls replay sequential responses, then go live', async () => {
    const fake = new FakeConnector(() => ({ n: 'live' }));
    const prev = logWith(
      ['sp', 'GetItem', { id: 1 }, { n: 'first' }],
      ['sp', 'GetItem', { id: 1 }, { n: 'second' }],
    );
    const wrapped = wrapConnectorsForReplay({ sp: fake }, prev, new ConnectorCallLog());

    assert.deepEqual(await wrapped['sp'].invoke('GetItem', { id: 1 }, {} as any), { n: 'first' });
    assert.deepEqual(await wrapped['sp'].invoke('GetItem', { id: 1 }, {} as any), { n: 'second' });
    assert.deepEqual(await wrapped['sp'].invoke('GetItem', { id: 1 }, {} as any), { n: 'live' });
    assert.equal(fake.invocations.length, 1);
  });

  it('misses on changed inputs: fires onDivergence, calls live, and re-records', async () => {
    const fake = new FakeConnector((_, inputs) => ({ echoed: inputs.list }));
    const prev = logWith(['sp', 'GetItems', { list: 'A' }, { items: [] }]);
    const newLog = new ConnectorCallLog();
    const divergences: string[] = [];
    const wrapped = wrapConnectorsForReplay({ sp: fake }, prev, newLog, {
      onDivergence: (connector, operation) => divergences.push(`${connector}.${operation}`),
    });

    const result = await wrapped['sp'].invoke('GetItems', { list: 'B' }, {} as any);

    assert.deepEqual(result, { echoed: 'B' });
    assert.deepEqual(divergences, ['sp.GetItems']);
    assert.equal(fake.invocations.length, 1);
    assert.equal(newLog.calls.length, 1);
    assert.deepEqual(newLog.calls[0].inputs, { list: 'B' });
  });

  it('misses for a connector with no recorded calls at all', async () => {
    const fake = new FakeConnector(() => 'live');
    const wrapped = wrapConnectorsForReplay({ dv: fake }, new ConnectorCallLog(), new ConnectorCallLog());
    assert.equal(await wrapped['dv'].invoke('ListRows', {}, {} as any), 'live');
    assert.equal(fake.invocations.length, 1);
  });

  it('returns a fresh clone per replay so callers cannot corrupt the log', async () => {
    const prev = logWith(['sp', 'GetItem', { id: 1 }, { deep: { v: 1 } }]);
    const newLog = new ConnectorCallLog();
    const wrapped = wrapConnectorsForReplay({ sp: new FakeConnector(() => null) }, prev, newLog);
    const result = await wrapped['sp'].invoke('GetItem', { id: 1 }, {} as any);
    (result as any).deep.v = 999;
    assert.equal(prev.calls[0].response.deep.v, 1);
    assert.equal(newLog.calls[0].response.deep.v, 1);
  });
});

describe('stableStringify non-plain objects', () => {
  it('distinguishes Dates by value instead of collapsing to {}', () => {
    const a = stableStringify({ when: new Date('2026-01-01T00:00:00Z') });
    const b = stableStringify({ when: new Date('2026-06-06T00:00:00Z') });
    assert.notEqual(a, b);
    assert.match(a, /2026-01-01/);
  });

  it('distinguishes Maps and Sets by entries', () => {
    assert.notEqual(
      stableStringify(new Map([['a', 1]])),
      stableStringify(new Map([['a', 2]])),
    );
    assert.notEqual(stableStringify(new Set([1])), stableStringify(new Set([2])));
    assert.notEqual(stableStringify(new Map()), stableStringify(new Set()));
  });

  it('tags binary values by type and size', () => {
    const buf8 = stableStringify(new Uint8Array(8));
    const buf9 = stableStringify(new Uint8Array(9));
    assert.notEqual(buf8, buf9);
    assert.notEqual(buf8, stableStringify(new ArrayBuffer(8)));
    assert.notEqual(buf8, stableStringify({}));
  });

  it('distinguishes same-length binary content by hash', () => {
    assert.notEqual(
      stableStringify(new Uint8Array([1, 2, 3])),
      stableStringify(new Uint8Array([4, 5, 6])),
    );
    assert.equal(
      stableStringify(new Uint8Array([1, 2, 3])),
      stableStringify(new Uint8Array([1, 2, 3])),
    );
  });

  it('still sorts plain object keys recursively', () => {
    assert.equal(stableStringify({ b: 2, a: { d: 4, c: 3 } }), stableStringify({ a: { c: 3, d: 4 }, b: 2 }));
  });
});

describe('replay matching v2', () => {
  it('isolates identical operation+inputs across different connectors', async () => {
    const spFake = new FakeConnector(() => 'sp-live');
    const dvFake = new FakeConnector(() => 'dv-live');
    const prev = logWith(
      ['sp', 'GetItems', { q: 1 }, 'sp-recorded'],
      ['dv', 'GetItems', { q: 1 }, 'dv-recorded'],
    );
    const wrapped = wrapConnectorsForReplay({ sp: spFake, dv: dvFake }, prev, new ConnectorCallLog());
    assert.equal(await wrapped['dv'].invoke('GetItems', { q: 1 }, {} as any), 'dv-recorded');
    assert.equal(await wrapped['sp'].invoke('GetItems', { q: 1 }, {} as any), 'sp-recorded');
    assert.equal(spFake.invocations.length + dvFake.invocations.length, 0);
  });

  it('masked volatile paths match despite differing values, and misses still fire for real changes', async () => {
    const fake = new FakeConnector(() => 'live');
    const prev = new ConnectorCallLog();
    prev.record('sp', 'CreateItem', { list: 'A', body: { Title: 't', Stamp: '2026-01-01T00:00:00Z' } }, 'recorded', 'Create_item');
    const masks = new Map([['Create_item', ['body.Stamp']]]);
    const divergences: string[] = [];
    const wrapped = wrapConnectorsForReplay({ sp: fake }, prev, new ConnectorCallLog(), {
      onDivergence: (c, o) => divergences.push(`${c}.${o}`),
    }, { volatileMasks: masks, getNodeName: () => 'Create_item' });

    // Different Stamp (volatile) -> still a hit
    assert.equal(
      await wrapped['sp'].invoke('CreateItem', { list: 'A', body: { Title: 't', Stamp: '2026-07-26T12:00:00Z' } }, {} as any),
      'recorded',
    );
    assert.deepEqual(divergences, []);
    // Different Title (not masked) -> miss
    assert.equal(
      await wrapped['sp'].invoke('CreateItem', { list: 'A', body: { Title: 'CHANGED', Stamp: '2026-07-26T12:00:00Z' } }, {} as any),
      'live',
    );
    assert.deepEqual(divergences, ['sp.CreateItem']);
  });

  it('console-originated calls are neither replayed nor consumed nor flagged as divergence', async () => {
    const fake = new FakeConnector(() => 'live');
    const prev = new ConnectorCallLog();
    prev.record('sp', 'GetItem', { id: 1 }, 'flow-recorded', 'Get_item');   // flow call
    prev.record('sp', 'GetItem', { id: 1 }, 'console-recorded', null);      // console call in old run
    const divergences: string[] = [];
    let current: string | null = null;
    const wrapped = wrapConnectorsForReplay({ sp: fake }, prev, new ConnectorCallLog(), {
      onDivergence: (c, o) => divergences.push(`${c}.${o}`),
    }, { getNodeName: () => current });

    // Console call during fast-forward: runs live, consumes nothing, no divergence.
    assert.equal(await wrapped['sp'].invoke('GetItem', { id: 1 }, {} as any), 'live');
    assert.deepEqual(divergences, []);
    // The flow's own call still hits its recording (console did not shift it),
    // and the null-name entry was never indexed.
    current = 'Get_item';
    assert.equal(await wrapped['sp'].invoke('GetItem', { id: 1 }, {} as any), 'flow-recorded');
    assert.equal(fake.invocations.length, 1);
  });

  it('oversized entries never match — the call re-executes live', async () => {
    const fake = new FakeConnector(() => 'live-again');
    const prev = new ConnectorCallLog();
    prev.calls.push({ connector: 'word', operation: 'ConvertToPdf', inputs: { f: 1 }, response: undefined, nodeName: 'Conv', oversized: true });
    const wrapped = wrapConnectorsForReplay({ word: fake }, prev, new ConnectorCallLog());
    assert.equal(await wrapped['word'].invoke('ConvertToPdf', { f: 1 }, {} as any), 'live-again');
    assert.equal(fake.invocations.length, 1);
  });

  it('keeps consumption ordered under the index (large-log fast path)', async () => {
    const fake = new FakeConnector(() => 'live');
    const prev = new ConnectorCallLog();
    for (let i = 0; i < 200; i++) prev.record('sp', 'GetItem', { id: 1 }, `r${i}`);
    const wrapped = wrapConnectorsForReplay({ sp: fake }, prev, new ConnectorCallLog());
    assert.equal(await wrapped['sp'].invoke('GetItem', { id: 1 }, {} as any), 'r0');
    assert.equal(await wrapped['sp'].invoke('GetItem', { id: 1 }, {} as any), 'r1');
  });
});
