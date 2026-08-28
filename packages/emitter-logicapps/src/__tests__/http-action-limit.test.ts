import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emitLogicAppsJson } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

describe('HTTP action limit emission', () => {
  it('emits limit (timeout) on an Http action definition', () => {
    const flow: FlowIR = {
      name: 'HttpLimitFlow',
      nodes: [
        { id: 'trg_1', type: 'trigger', kind: 'http', name: 'manual', inputs: { method: 'POST' } },
        {
          id: 'act_1',
          type: 'action',
          kind: 'http',
          name: 'CallApi',
          inputs: { method: 'GET', url: 'https://api.example.com/data' },
          limit: { timeout: 'PT30S' },
        },
      ],
    } as unknown as FlowIR;

    const json: any = emitLogicAppsJson(flow);
    const def = json.properties.definition.actions.CallApi;
    assert.deepEqual(def.limit, { timeout: 'PT30S' });
  });
});
