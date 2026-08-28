/**
 * HTTP action `limit` (timeout) round-trip support.
 *
 * Logic Apps allows `"limit": { "timeout": "PT..." }` on Http actions (the
 * designer's "Timeout" setting). It must survive JSON → IR → DSL → IR.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { transformCode } from '../src/transformer/index.js';
import { resetIdCounter } from '../src/utils/id-generator.js';
import { generateNativeDslFromIR } from '../src/generator.js';
import { parseLogicAppsToIR } from '../src/parser-logicapps.js';
import type { FlowIR } from '@flowforger/ir';

describe('HTTP action limit (timeout)', () => {
  beforeEach(() => {
    resetIdCounter();
  });

  it('parseLogicAppsToIR captures limit on an Http action', () => {
    const laJson = {
      definition: {
        $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
        contentVersion: '1.0.0.0',
        triggers: {
          manual: {
            type: 'Request',
            kind: 'Http',
            inputs: { schema: {} },
          },
        },
        actions: {
          CallApi: {
            type: 'Http',
            inputs: {
              method: 'GET',
              uri: 'https://api.example.com/data',
            },
            limit: { timeout: 'PT30S' },
            runAfter: {},
          },
        },
      },
    };

    const ir = parseLogicAppsToIR(laJson);
    const httpNode = ir.nodes.find((n: any) => n.type === 'action' && n.kind === 'http') as any;
    assert.ok(httpNode, 'expected an http action node');
    assert.deepEqual(httpNode.limit, { timeout: 'PT30S' });
  });

  it('transformCode applies @limit to a ctx.http() action', () => {
    const code = `
      @Flow('HttpLimitFlow')
      class HttpLimitFlow {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          /** @limit {"timeout":"PT30S"} */
          await ctx.http('CallApi', { method: 'GET', url: 'https://api.example.com/data' });
        }
      }
    `;

    const ir = transformCode(code);
    const httpNode = ir.nodes.find((n: any) => n.type === 'action' && n.kind === 'http') as any;
    assert.ok(httpNode, 'expected an http action node');
    assert.deepEqual(httpNode.limit, { timeout: 'PT30S' });
  });

  it('generateNativeDslFromIR emits @limit for an http node with limit', () => {
    const ir: FlowIR = {
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

    const dsl = generateNativeDslFromIR(ir);
    assert.match(dsl, /@limit \{"timeout":"PT30S"\}/);
  });
});
