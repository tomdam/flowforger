import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

/**
 * Parameter overrides (e.g. environment variables resolved to their current
 * values by the host) must reach child workflows too: in the cloud a child
 * flow resolves the SAME environment's env vars, so a local run that only
 * overrides the parent would give parent and child different values for the
 * same variable.
 */
describe('parameterOverrides propagation to child workflows', () => {
  const childFlow: FlowIR = {
    name: 'Child',
    parameters: {
      'Site (cr_site)': {
        type: 'String',
        defaultValue: 'child-design-time-default',
        metadata: { schemaName: 'cr_site' },
      },
    },
    nodes: [
      { id: 'trg_1', name: 'manual', type: 'trigger', kind: 'http' } as any,
      {
        id: 'act_1',
        name: 'Echo',
        type: 'action',
        kind: 'compose',
        inputs: { value: "@parameters('Site (cr_site)')" },
      } as any,
    ],
  };

  const parentFlow: FlowIR = {
    name: 'Parent',
    nodes: [
      { id: 'trg_1', name: 'manual', type: 'trigger', kind: 'http' } as any,
      {
        id: 'act_1',
        name: 'Call_child',
        type: 'action',
        kind: 'workflow',
        inputs: { workflowReferenceName: 'child-guid', body: {} },
      } as any,
    ],
  };

  it('applies the parent run overrides to a child flow parameter of the same name', async () => {
    const result = await run(parentFlow, {
      parameterOverrides: { 'Site (cr_site)': 'https://actual' },
      loadChildFlow: async () => childFlow,
    });

    assert.equal(result.status, 'Succeeded');
    const call = result.trace.find((t) => t.name === 'Call_child');
    assert.equal((call?.outputs as any)?.body, 'https://actual');
  });
});
