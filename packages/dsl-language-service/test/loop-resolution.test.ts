/**
 * Tests for resolving loop references (ctx.items('...')) to their for-of loop.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildSymbolIndex, findLoop } from '../src/analyzer/symbol-index.js';

const CODE = [
  `@Flow('Demo')`,
  `export class Demo {`,
  `  @Action()`,
  `  async actions(ctx: FlowContext) {`,
  `    /** @action CategorizeLoop @type foreach */`,
  `    for (const task of ctx.outputs('AllTasks') ?? []) {`,
  `      await ctx.compose('Take', ctx.items('CategorizeLoop'));`,
  `    }`,
  ``,
  `    for (const row of ctx.outputs('Rows') ?? []) {`,
  `      await ctx.compose('Row', ctx.items('Loop_2'));`,
  `    }`,
  `  }`,
  `}`,
].join('\n');

describe('findLoop', () => {
  const index = buildSymbolIndex(CODE);

  it('resolves generated Loop_N names', () => {
    const loop = findLoop(index, 'Loop_1');
    assert.ok(loop);
    assert.strictEqual(loop.variableName, 'task');

    const second = findLoop(index, 'Loop_2');
    assert.ok(second);
    assert.strictEqual(second.variableName, 'row');
  });

  it('resolves JSDoc-named loops back to their for-of statement', () => {
    const loop = findLoop(index, 'CategorizeLoop');
    assert.ok(loop, 'a @action-named foreach must resolve to its loop');
    assert.strictEqual(loop.variableName, 'task');
    assert.strictEqual(loop.line, CODE.split('\n').indexOf(`    for (const task of ctx.outputs('AllTasks') ?? []) {`));
  });

  it('matches JSDoc loop names case-insensitively', () => {
    assert.ok(findLoop(index, 'categorizeloop'));
  });

  it('returns undefined for unknown loop names', () => {
    assert.strictEqual(findLoop(index, 'NoSuchLoop'), undefined);
    assert.strictEqual(findLoop(index, 'Loop_9'), undefined);
  });
});
