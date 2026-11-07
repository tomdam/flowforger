/**
 * An empty array literal inside an expression compiles to json('[]'), never createArray():
 * createArray() takes at least one argument, and the cloud checks the argument count before
 * anything is evaluated, so `x ?? []` as `coalesce(x, createArray())` failed at run time
 * (measured by conformance/flows/coalesce-empty.ff.ts). A non-empty literal stays createArray(...).
 * The generator writes json('[]') back as `[]`, so `x ?? []` round-trips.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { transformCode } from '../src/transformer/index.js';
import { resetIdCounter } from '../src/utils/id-generator.js';
import { generateNativeDslFromIR } from '../src/generator.js';

const flow = (body: string) => `
@Flow('EmptyArray')
class EmptyArray {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
${body}
  }
}`;

function find(ir: any, name: string): any {
  const walk = (nodes: any[]): any => {
    for (const n of nodes) {
      if (n.name === name) return n;
      for (const key of ['actions', 'elseActions']) {
        if (Array.isArray(n[key])) {
          const hit = walk(n[key]);
          if (hit) return hit;
        }
      }
    }
    return undefined;
  };
  return walk(ir.nodes);
}

describe('empty array literal in expressions', () => {
  beforeEach(() => resetIdCounter());

  it("lowers `x ?? []` to coalesce(x, json('[]'))", async () => {
    const ir = await transformCode(flow(`
      /** @action Each */
      for (const item of ctx.triggerBody()?.['rows'] ?? []) {
        await ctx.compose('Item', item);
      }`));
    assert.equal(find(ir, 'Each').itemsExpression, "@coalesce(triggerBody()?['rows'], json('[]'))");
  });

  it("lowers [] inside a function argument to json('[]')", async () => {
    const ir = await transformCode(flow(`await ctx.compose('Merged', ctx.union(ctx.triggerBody()?.['rows'], []));`));
    assert.equal(find(ir, 'Merged').inputs.value, "@union(triggerBody()?['rows'], json('[]'))");
  });

  it('keeps createArray(...) for a non-empty literal', async () => {
    const ir = await transformCode(flow(`await ctx.compose('Pair', ctx.union(ctx.triggerBody()?.['rows'], [1, 'a']));`));
    assert.equal(find(ir, 'Pair').inputs.value, "@union(triggerBody()?['rows'], createArray(1, 'a'))");
  });

  it("generates `x ?? []` back from coalesce(x, json('[]'))", async () => {
    const ir = await transformCode(flow(`
      /** @action Each */
      for (const item of ctx.triggerBody()?.['rows'] ?? []) {
        await ctx.compose('Item', item);
      }`));
    const dsl = generateNativeDslFromIR(ir);
    assert.match(dsl, /\?\? \[\]\)?\s*\)\s*\{/, dsl);
    assert.doesNotMatch(dsl, /json\('\[\]'\)/);
  });
});
