import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loopItemLabel } from '../index.js';

/**
 * A loop item's label: the title-like field of a connector record (so a SharePoint item or
 * Dataverse row is named, not shown as its metadata), otherwise its JSON, truncated.
 */
describe('loopItemLabel', () => {
  it('prefers Title over Name', () => {
    assert.equal(loopItemLabel({ Name: 'n', Title: 'Invoice 4711' }), 'Invoice 4711');
  });

  it('uses DisplayName when there is no Title', () => {
    assert.equal(loopItemLabel({ '@odata.type': '#x', DisplayName: 'Ada', Email: 'a@x' }), 'Ada');
  });

  it('accepts a numeric label field', () => {
    assert.equal(loopItemLabel({ name: 42 }), '42');
  });

  it('shows a scalar as itself', () => {
    assert.equal(loopItemLabel(7), '7');
    assert.equal(loopItemLabel('abc'), '"abc"');
  });

  it('falls back to truncated JSON ending with an ellipsis', () => {
    const label = loopItemLabel({ a: 'x'.repeat(100) }, 20);
    assert.equal(label.length, 20);
    assert.ok(label.endsWith('…'));
    assert.ok(label.startsWith('{"a":"xxx'));
  });

  it('is empty for nothing', () => {
    assert.equal(loopItemLabel(undefined), '');
    assert.equal(loopItemLabel(null), '');
    assert.equal(loopItemLabel({}), '');
    assert.equal(loopItemLabel([]), '');
  });
});
