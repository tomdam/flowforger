/**
 * `const x = <expression>` is an alias: reads of `x` inline the expression. Before this a const
 * bound to anything but an action compiled to a bare `@x`, which the cloud rejects at run time
 * ("The template language expression 'x' is not valid") while `flowforger validate` said nothing.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { transformCode } from '../src/transformer/index.js';
import { resetIdCounter } from '../src/utils/id-generator.js';

const flow = (body: string) => `
  @Flow('Aliases')
  class Aliases {
    @HttpTrigger({ method: 'POST' })
    trigger() {}
    @Action()
    async run(ctx: FlowContext) {
      ${body}
    }
    constructor(ctx: FlowContext) { ctx.flow.parameters = {}; }
  }
`;

const byName = (ir: any, name: string): any => {
  const walk = (nodes: any[]): any => {
    for (const n of nodes ?? []) {
      if (n.name === name) return n;
      const hit = walk(n.actions) ?? walk(n.elseActions);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(ir.nodes);
};

describe('const expression aliases', () => {
  beforeEach(() => resetIdCounter());

  it('inlines a const bound to a trigger read', () => {
    const ir = transformCode(flow(`
      const name = ctx.triggerBody()?.['name'];
      await ctx.compose('Out', name);
    `));
    assert.equal(byName(ir, 'Out').inputs.value, "@triggerBody()?['name']");
  });

  it('inlines through nested consts, conditions and template strings', () => {
    const ir = transformCode(flow(`
      const name = ctx.triggerBody()?.['name'];
      const greeting = ctx.concat('Hi ', name);
      /** @action Check */
      if (!ctx.empty(greeting)) {
        await ctx.compose('Out', \`\${greeting}!\`);
      }
    `));
    assert.equal(byName(ir, 'Check').condition, "@not(empty(concat('Hi ', triggerBody()?['name'])))");
    assert.equal(byName(ir, 'Out').inputs.value, "@{concat('Hi ', triggerBody()?['name'])}!");
  });

  it('inlines a const bound to a loop item inside the loop', () => {
    const ir = transformCode(flow(`
      /** @action Each */
      for (const row of ctx.triggerBody()?.['rows']) {
        const title = row?.['Title'];
        await ctx.compose('T', title);
      }
    `));
    assert.equal(byName(ir, 'T').inputs.value, "@items('Each')?['Title']");
  });

  it('leaves let variables and action-result consts alone', () => {
    const ir = transformCode(flow(`
      let count: number = 1;
      await ctx.compose('A', count);
    `));
    assert.equal(byName(ir, 'A').inputs.value, "@variables('count')");
  });
});
