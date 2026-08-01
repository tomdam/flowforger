import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorCallLog, wrapConnectorsForRecording, stableStringify, MAX_RECORDED_CALLS, MAX_RECORDED_RESPONSE_BYTES } from '../replay.js';
import type { BaseConnector } from '@flowforger/engine';

class FakeConnector implements BaseConnector {
  invocations: Array<{ operation: string; inputs: any }> = [];
  constructor(private respond: (operation: string, inputs: any) => any) {}
  async invoke(operation: string, inputs: any): Promise<any> {
    this.invocations.push({ operation, inputs });
    const out = this.respond(operation, inputs);
    if (out instanceof Error) throw out;
    return out;
  }
}

describe('stableStringify', () => {
  it('is key-order independent and distinguishes values', () => {
    assert.equal(stableStringify({ a: 1, b: [2, { c: 3 }] }), stableStringify({ b: [2, { c: 3 }], a: 1 }));
    assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
    assert.equal(stableStringify(undefined), stableStringify(undefined));
  });
});

describe('wrapConnectorsForRecording', () => {
  it('records successful calls with cloned inputs/response and passes results through', async () => {
    const fake = new FakeConnector((op, inputs) => ({ echoed: inputs.value }));
    const log = new ConnectorCallLog();
    const wrapped = wrapConnectorsForRecording({ sharepoint: fake }, log);

    const inputs = { value: 42, nested: { x: 'y' } };
    const result = await wrapped['sharepoint'].invoke('GetItems', inputs, {} as any);

    assert.deepEqual(result, { echoed: 42 });
    assert.equal(log.calls.length, 1);
    assert.equal(log.calls[0].connector, 'sharepoint');
    assert.equal(log.calls[0].operation, 'GetItems');
    assert.deepEqual(log.calls[0].inputs, inputs);
    // Clones, not references: mutating originals must not affect the log
    inputs.nested.x = 'mutated';
    (result as any).echoed = 'mutated';
    assert.equal(log.calls[0].inputs.nested.x, 'y');
    assert.equal(log.calls[0].response.echoed, 42);
  });

  it('does not record failed calls and rethrows', async () => {
    const fake = new FakeConnector(() => new Error('boom'));
    const log = new ConnectorCallLog();
    const wrapped = wrapConnectorsForRecording({ http: fake }, log);
    await assert.rejects(() => wrapped['http'].invoke('request', { uri: 'x' }, {} as any), /boom/);
    assert.equal(log.calls.length, 0);
  });

  it('preserves other connector members through the proxy', async () => {
    const fake = new FakeConnector(() => 'ok');
    const wrapped = wrapConnectorsForRecording({ f: fake }, new ConnectorCallLog());
    await wrapped['f'].invoke('op', {}, {} as any);
    // The wrapper must expose the underlying instance's fields (Proxy passthrough)
    assert.equal((wrapped['f'] as any).invocations.length, 1);
  });
});

describe('node stamping and boundary markers', () => {
  it('records the executing node name via getNodeName, null when absent', async () => {
    const log = new ConnectorCallLog();
    let current: string | null = 'Get_items';
    const fake = { invoke: async () => ({ ok: 1 }) } as any;
    const wrapped = wrapConnectorsForRecording({ sp: fake }, log, () => current);
    await wrapped['sp'].invoke('GetItems', { a: 1 }, {} as any);
    current = null; // console call
    await wrapped['sp'].invoke('GetItems', { a: 2 }, {} as any);
    assert.equal(log.calls[0].nodeName, 'Get_items');
    assert.equal(log.calls[1].nodeName, null);
  });

  it('record() without getNodeName defaults nodeName to null (legacy callers)', () => {
    const log = new ConnectorCallLog();
    log.record('sp', 'Op', {}, {});
    assert.equal(log.calls[0].nodeName, null);
  });

  it('truncateBefore cuts calls made from the target hit onward', () => {
    const log = new ConnectorCallLog();
    log.record('sp', 'A', { n: 1 }, 'r1', 'Node_A');
    log.markBoundary('Node_A', 1);          // after Node_A's 1st execution: 1 call
    log.record('sp', 'B', { n: 2 }, 'r2', 'Node_B');
    log.record('sp', 'B', { n: 3 }, 'r3', 'Node_B');
    log.markBoundary('Node_B', 1);          // after Node_B's 1st execution: 3 calls
    log.record('sp', 'C', { n: 4 }, 'r4', 'Node_C');
    log.markBoundary('Node_C', 1);

    // Rewind to Node_B's 1st execution: keep only calls made BEFORE it began.
    assert.equal(log.truncateBefore('Node_B', 1), true);
    assert.equal(log.calls.length, 1);
    assert.equal(log.calls[0].operation, 'A');
  });

  it('truncateBefore to the very first executed node empties the log', () => {
    const log = new ConnectorCallLog();
    log.record('sp', 'A', {}, 'r', 'Node_A');
    log.markBoundary('Node_A', 1);
    assert.equal(log.truncateBefore('Node_A', 1), true);
    assert.equal(log.calls.length, 0);
  });

  it('truncateBefore returns false for an unknown boundary and leaves the log intact', () => {
    const log = new ConnectorCallLog();
    log.record('sp', 'A', {}, 'r', 'Node_A');
    log.markBoundary('Node_A', 1);
    assert.equal(log.truncateBefore('Node_A', 2), false);
    assert.equal(log.calls.length, 1);
  });

  it('markers after the cut are dropped so a second rewind stays consistent', () => {
    const log = new ConnectorCallLog();
    log.record('sp', 'A', {}, 'r1', 'Node_A');
    log.markBoundary('Node_A', 1);
    log.record('sp', 'B', {}, 'r2', 'Node_B');
    log.markBoundary('Node_B', 1);
    log.truncateBefore('Node_B', 1);
    // Node_B's marker is gone; Node_A's survives.
    assert.equal(log.truncateBefore('Node_B', 1), false);
    assert.equal(log.truncateBefore('Node_A', 1), true);
    assert.equal(log.calls.length, 0);
  });
});

describe('recording bounds', () => {
  it('stops recording at the entry cap and flags the log incomplete', () => {
    const log = new ConnectorCallLog();
    for (let i = 0; i < MAX_RECORDED_CALLS + 5; i++) log.record('sp', 'Op', { i }, { i });
    assert.equal(log.calls.length, MAX_RECORDED_CALLS);
    assert.equal(log.incomplete, true);
  });

  it('a small log is not incomplete', () => {
    const log = new ConnectorCallLog();
    log.record('sp', 'Op', {}, {});
    assert.equal(log.incomplete, false);
  });

  it('replaces oversized responses with an unmatched stub', () => {
    const log = new ConnectorCallLog();
    const huge = 'x'.repeat(MAX_RECORDED_RESPONSE_BYTES + 1);
    log.record('word', 'ConvertToPdf', { file: 'a.docx' }, { content: huge });
    assert.equal(log.calls[0].oversized, true);
    assert.equal(log.calls[0].response, undefined);
    // inputs are still retained for diagnostics
    assert.deepEqual(log.calls[0].inputs, { file: 'a.docx' });
  });
});
