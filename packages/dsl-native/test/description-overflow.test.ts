/**
 * Round-trip tests for long action descriptions (e.g. commented-out DSL code).
 *
 * The Logic Apps emitter stores a >255-char description as a 255-char excerpt in
 * `description` plus the full text in metadata.flowforgerDescription; the parser
 * must restore the full text — unless the cloud-side note was edited, in which
 * case the edited note wins and the stale overflow is dropped.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { parseLogicAppsToIR, resetParserIdCounter } from '../src/parser-logicapps.js';
import { generateNativeDslFromIR } from '../src/generator.js';
import { DESCRIPTION_OVERFLOW_METADATA_KEY, toDescriptionExcerpt } from '@flowforger/ir';

const LONG_DESCRIPTION = [
  'Commented-out actions kept for reference:',
  "// await ctx.connectors.sharepoint.getItems({ dataset: 'https://contoso.sharepoint.com/sites/hr', table: '11111111-2222-3333-4444-555555555555', $filter: \"Status eq 'Open'\" });",
  "// await ctx.http('NotifyOwner', { method: 'POST', url: 'https://api.example.com/notify', body: { id: 1 } });",
].join('\n');

function clientdataWith(action: any): any {
  return {
    properties: {
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
        actions: { CallApi: action },
      },
    },
  };
}

describe('description overflow parsing', () => {
  beforeEach(() => {
    resetParserIdCounter();
  });

  it('restores the full description from overflow metadata when the excerpt matches', () => {
    const ir = parseLogicAppsToIR(clientdataWith({
      type: 'Http',
      inputs: { method: 'GET', uri: 'https://api.example.com/data' },
      description: toDescriptionExcerpt(LONG_DESCRIPTION),
      metadata: {
        operationMetadataId: 'fixed-id-123',
        [DESCRIPTION_OVERFLOW_METADATA_KEY]: LONG_DESCRIPTION,
      },
      runAfter: {},
    }));

    const node: any = ir.nodes.find((n: any) => n.name === 'CallApi');
    assert.strictEqual(node.description, LONG_DESCRIPTION);
    // Overflow key must not leak into IR metadata (the emitter re-derives it)
    assert.deepStrictEqual(node.metadata, { operationMetadataId: 'fixed-id-123' });
  });

  it('prefers an edited cloud-side note over stale overflow metadata', () => {
    const ir = parseLogicAppsToIR(clientdataWith({
      type: 'Http',
      inputs: { method: 'GET', uri: 'https://api.example.com/data' },
      description: 'Edited in the Power Automate designer',
      metadata: {
        operationMetadataId: 'fixed-id-123',
        [DESCRIPTION_OVERFLOW_METADATA_KEY]: LONG_DESCRIPTION,
      },
      runAfter: {},
    }));

    const node: any = ir.nodes.find((n: any) => n.name === 'CallApi');
    assert.strictEqual(node.description, 'Edited in the Power Automate designer');
    assert.deepStrictEqual(node.metadata, { operationMetadataId: 'fixed-id-123' });
  });

  it('regenerates the full comment lines in DSL from a restored long description', () => {
    const ir = parseLogicAppsToIR(clientdataWith({
      type: 'Http',
      inputs: { method: 'GET', uri: 'https://api.example.com/data' },
      description: toDescriptionExcerpt(LONG_DESCRIPTION),
      metadata: {
        operationMetadataId: 'fixed-id-123',
        [DESCRIPTION_OVERFLOW_METADATA_KEY]: LONG_DESCRIPTION,
      },
      runAfter: {},
    }));

    const dsl = generateNativeDslFromIR(ir, 'DescFlow');
    // Every line of the long comment must appear in the generated DSL
    for (const line of LONG_DESCRIPTION.split('\n')) {
      assert.ok(dsl.includes(line), `generated DSL is missing comment line: ${line}`);
    }
    // The truncation marker must not appear — full text was restored
    assert.ok(!dsl.includes('…'), 'generated DSL contains the truncated excerpt');
  });
});
