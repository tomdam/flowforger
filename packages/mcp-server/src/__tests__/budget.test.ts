import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { wrapConnectorsWithBudget, ConnectorBudgetExceeded } from '../budget.js';

function stubConnector(onInvoke: () => void) {
  return { invoke: async (_op: string, _inputs: any) => { onInvoke(); return { statusCode: 200, body: null }; } } as any;
}

describe('wrapConnectorsWithBudget', () => {
  it('counts each live invoke and passes results through', async () => {
    let hits = 0;
    const { connectors, used } = wrapConnectorsWithBudget({ http: stubConnector(() => hits++) }, 10);
    await connectors['http'].invoke('Get', {}, {} as any);
    await connectors['http'].invoke('Get', {}, {} as any);
    assert.equal(hits, 2);
    assert.equal(used(), 2);
  });

  it('throws ConnectorBudgetExceeded once the limit is passed, without invoking', async () => {
    let hits = 0;
    const { connectors, used } = wrapConnectorsWithBudget({ http: stubConnector(() => hits++) }, 1);
    await connectors['http'].invoke('Get', {}, {} as any);
    await assert.rejects(
      () => connectors['http'].invoke('Get', {}, {} as any),
      (err: unknown) => err instanceof ConnectorBudgetExceeded,
    );
    assert.equal(hits, 1, 'the over-budget call never reached the real connector');
    assert.equal(used(), 1);
  });

  it('passes non-invoke members through unchanged', () => {
    const raw = { invoke: async () => ({}), someField: 42 } as any;
    const { connectors } = wrapConnectorsWithBudget({ http: raw }, 5);
    assert.equal((connectors['http'] as any).someField, 42);
  });
});
