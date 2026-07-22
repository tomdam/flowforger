/**
 * Tests for the ctx.saveFile() DSL helper (compiles to a sentinel Compose).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { transformCode } from '../src/transformer/index.js';
import { resetIdCounter } from '../src/utils/id-generator.js';

describe('ctx.saveFile', () => {
  beforeEach(() => {
    resetIdCounter();
  });

  it('compiles to a compose node carrying the sentinel', () => {
    const code = `
      import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      @Flow('SaveFileFlow')
      class SaveFileFlow {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          await ctx.saveFile('Dump', { contentType: 'text/xml', content: '<x/>', fileName: 'r.xml' });
        }
      }
    `;

    const ir = transformCode(code);
    const node = ir.nodes.find((n: any) => n.name === 'Dump') as any;
    assert.ok(node, 'expected a node named Dump');
    assert.strictEqual(node.kind, 'compose');
    assert.strictEqual(node.inputs.value['@@ff:saveFile'], true);
    assert.strictEqual(node.inputs.value.contentType, 'text/xml');
    assert.strictEqual(node.inputs.value.content, '<x/>');
    assert.strictEqual(node.inputs.value.fileName, 'r.xml');
  });

  it('omits optional fields when not provided', () => {
    const code = `
      import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      @Flow('SaveFileFlow2')
      class SaveFileFlow2 {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          await ctx.saveFile('Dump2', { contentType: 'text/plain', content: 'hi' });
        }
      }
    `;

    const ir = transformCode(code);
    const node = ir.nodes.find((n: any) => n.name === 'Dump2') as any;
    assert.strictEqual(node.kind, 'compose');
    assert.strictEqual(node.inputs.value['@@ff:saveFile'], true);
    assert.strictEqual('fileName' in node.inputs.value, false);
    assert.strictEqual('encoding' in node.inputs.value, false);
  });
});
