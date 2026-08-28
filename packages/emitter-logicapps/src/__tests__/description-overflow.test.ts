import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emitLogicAppsJson } from '../index.js';
import type { FlowIR } from '@flowforger/ir';
import { MAX_ACTION_DESCRIPTION_LENGTH, DESCRIPTION_OVERFLOW_METADATA_KEY, toDescriptionExcerpt } from '@flowforger/ir';

const LONG_DESCRIPTION = [
  'Commented-out actions kept for reference:',
  "// await ctx.connectors.sharepoint.getItems({ dataset: 'https://contoso.sharepoint.com/sites/hr', table: '11111111-2222-3333-4444-555555555555', $filter: \"Status eq 'Open'\" });",
  "// await ctx.http('NotifyOwner', { method: 'POST', url: 'https://api.example.com/notify', body: { id: 1 } });",
].join('\n');

function baseFlow(nodes: any[]): FlowIR {
  return { name: 'DescOverflowFlow', nodes } as unknown as FlowIR;
}

describe('description overflow emission', () => {
  it('emits a short description verbatim with no overflow metadata', () => {
    const flow = baseFlow([
      { id: 'trg_1', type: 'trigger', kind: 'http', name: 'manual', inputs: { method: 'POST' } },
      {
        id: 'act_1', type: 'action', kind: 'http', name: 'CallApi',
        inputs: { method: 'GET', url: 'https://api.example.com/data' },
        description: 'Short note',
      },
    ]);

    const json: any = emitLogicAppsJson(flow);
    const def = json.properties.definition.actions.CallApi;
    assert.equal(def.description, 'Short note');
    assert.equal(def.metadata?.[DESCRIPTION_OVERFLOW_METADATA_KEY], undefined);
  });

  it('emits a >255-char description as a 255-char excerpt with full text in metadata', () => {
    assert.ok(LONG_DESCRIPTION.length > MAX_ACTION_DESCRIPTION_LENGTH);
    const flow = baseFlow([
      { id: 'trg_1', type: 'trigger', kind: 'http', name: 'manual', inputs: { method: 'POST' } },
      {
        id: 'act_1', type: 'action', kind: 'http', name: 'CallApi',
        inputs: { method: 'GET', url: 'https://api.example.com/data' },
        description: LONG_DESCRIPTION,
      },
    ]);

    const json: any = emitLogicAppsJson(flow);
    const def = json.properties.definition.actions.CallApi;
    assert.equal(def.description, toDescriptionExcerpt(LONG_DESCRIPTION));
    assert.ok(def.description.length <= MAX_ACTION_DESCRIPTION_LENGTH);
    assert.ok(def.description.endsWith('…'));
    assert.equal(def.metadata[DESCRIPTION_OVERFLOW_METADATA_KEY], LONG_DESCRIPTION);
    // The auto-generated operationMetadataId must still be present
    assert.ok(def.metadata.operationMetadataId);
  });

  it('preserves existing node metadata alongside the overflow key', () => {
    const flow = baseFlow([
      { id: 'trg_1', type: 'trigger', kind: 'http', name: 'manual', inputs: { method: 'POST' } },
      {
        id: 'act_1', type: 'action', kind: 'http', name: 'CallApi',
        inputs: { method: 'GET', url: 'https://api.example.com/data' },
        description: LONG_DESCRIPTION,
        metadata: { operationMetadataId: 'fixed-id-123' },
      },
    ]);

    const json: any = emitLogicAppsJson(flow);
    const def = json.properties.definition.actions.CallApi;
    assert.equal(def.metadata.operationMetadataId, 'fixed-id-123');
    assert.equal(def.metadata[DESCRIPTION_OVERFLOW_METADATA_KEY], LONG_DESCRIPTION);
  });

  it('applies the same overflow handling to trigger descriptions', () => {
    const flow = baseFlow([
      {
        id: 'trg_1', type: 'trigger', kind: 'http', name: 'manual',
        inputs: { method: 'POST' },
        description: LONG_DESCRIPTION,
      },
      {
        id: 'act_1', type: 'action', kind: 'http', name: 'CallApi',
        inputs: { method: 'GET', url: 'https://api.example.com/data' },
      },
    ]);

    const json: any = emitLogicAppsJson(flow);
    const trig = json.properties.definition.triggers.manual;
    assert.equal(trig.description, toDescriptionExcerpt(LONG_DESCRIPTION));
    assert.ok(trig.description.length <= MAX_ACTION_DESCRIPTION_LENGTH);
    assert.equal(trig.metadata[DESCRIPTION_OVERFLOW_METADATA_KEY], LONG_DESCRIPTION);
  });
});
