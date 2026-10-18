import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDiagnostics } from '../src/index.js';

/** Minimal flow with the given lines injected into the @Action method body. */
function flowWith(bodyLines: string[]): string {
  return [
    `import { Flow, ManualTrigger, Action, FlowContext } from '@flowforger/dsl-native';`,
    ``,
    `@Flow({ name: 'T' })`,
    `export class T {`,
    `  @ManualTrigger()`,
    `  async onTrigger(ctx: FlowContext) {}`,
    ``,
    `  @Action()`,
    `  async run(ctx: FlowContext) {`,
    ...bodyLines.map(l => `    ${l}`),
    `  }`,
    `}`,
    ``,
  ].join('\n');
}

const dsl022 = (lines: string[]) => getDiagnostics(flowWith(lines)).filter(d => d.code === 'DSL022');

describe('DSL022 — @runAfter may name the actions the transformer generates for variable mutations', () => {
  it('knows Append_to_x (push), Increment_x / Decrement_x (+=, -=, ++, --) and Append_x (string +=)', () => {
    assert.deepEqual(dsl022([
      `let arr: any[] = [];`,
      `let n: number = 0;`,
      `let s: string = '';`,
      `arr.push(1);`,
      `/** @runAfter Append_to_arr: Succeeded, Failed */`,
      `await ctx.compose("A", ctx.variables('arr'));`,
      `n += 1;`,
      `/** @runAfter Increment_n: Succeeded */`,
      `await ctx.compose("B", ctx.variables('n'));`,
      `n -= 1;`,
      `/** @runAfter Decrement_n: Succeeded */`,
      `await ctx.compose("C", ctx.variables('n'));`,
      `n++;`,
      `/** @runAfter Increment_n_2: Succeeded */`,
      `await ctx.compose("D", ctx.variables('n'));`,
      `s += 'x';`,
      `/** @runAfter Append_s: Succeeded */`,
      `await ctx.compose("E", ctx.variables('s'));`,
    ]), []);
  });

  it('still reports a name nothing generates', () => {
    const d = dsl022([
      `let arr: any[] = [];`,
      `arr.push(1);`,
      `/** @runAfter Append_to_other: Succeeded */`,
      `await ctx.compose("A", 1);`,
    ]);
    assert.equal(d.length, 1);
    assert.match(d[0].message, /Append_to_other/);
  });
});
