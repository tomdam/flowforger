/**
 * Connector parameters round-trip between the designer's flat paths ("item/Title") and the
 * DSL's nested objects: whatever unflattenParams nests, flattenParams must flatten back.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { flattenParams, unflattenParams } from '../src/utils/params-transform.js';

describe('params flatten/unflatten round trip', () => {
  it('nests plain paths and flattens them back', () => {
    const flat = { entityName: 'accounts', 'item/name': 'x', 'item/Status/Value': 'Open' };
    const nested = unflattenParams(flat);
    assert.deepStrictEqual(nested, { entityName: 'accounts', item: { name: 'x', Status: { Value: 'Open' } } });
    assert.deepStrictEqual(flattenParams(nested), flat);
  });

  it("keeps a path flat when a segment would not flatten again ('item/@odata.id', dashed keys)", () => {
    const flat = { 'item/@odata.id': 'https://org/api/data/v9.1/accounts(1)', 'item/Some-Field': 'v', 'item/name': 'x' };
    const nested = unflattenParams(flat);
    assert.deepStrictEqual(nested, { 'item/@odata.id': flat['item/@odata.id'], 'item/Some-Field': 'v', item: { name: 'x' } });
    assert.deepStrictEqual(flattenParams(nested), flat);
  });
});
