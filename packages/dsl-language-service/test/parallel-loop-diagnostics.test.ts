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

const dsl047 = (code: string) => getDiagnostics(code).filter(d => d.code === 'DSL047');

describe('DSL047 — flow variable changed inside a parallel foreach', () => {
  it('push inside a loop without concurrency → warning at the push, naming the loop', () => {
    const d = dsl047(flowWith([
      `let names: string[] = [];`,
      `/** @action Each_row */`,
      `for (const row of ctx.createArray('a', 'b')) {`,
      `  names.push(row);`,
      `}`,
    ]));
    assert.equal(d.length, 1);
    assert.equal(d[0].severity, 'warning');
    assert.match(d[0].message, /'names' is appended to inside 'Each_row', which Power Automate runs in parallel/);
    assert.match(d[0].message, /@runtimeConfig \{"concurrency":\{"repetitions":1\}\}/);
    assert.equal(d[0].range.start.line, 12);
  });

  it('names an unnamed loop the way the transformer does', () => {
    const d = dsl047(flowWith([
      `let last: string = '';`,
      `for (const row of ctx.createArray('a', 'b')) {`,
      `  last = row;`,
      `}`,
    ]));
    assert.equal(d.length, 1);
    assert.match(d[0].message, /'last' is set inside 'ForEach_row'/);
  });

  it('string += is Append to string variable → warning', () => {
    const d = dsl047(flowWith([
      `let text: string = '';`,
      `for (const row of ctx.createArray('a', 'b')) {`,
      `  text += row;`,
      `}`,
    ]));
    assert.equal(d.length, 1);
    assert.match(d[0].message, /'text' is appended to/);
  });

  it('repetitions 1 runs the loop one item at a time → no warning', () => {
    const d = dsl047(flowWith([
      `let names: string[] = [];`,
      `/** @action Each_row @runtimeConfig {"concurrency":{"repetitions":1}} */`,
      `for (const row of ctx.createArray('a', 'b')) {`,
      `  names.push(row);`,
      `}`,
    ]));
    assert.deepEqual(d, []);
  });

  it('a higher concurrency is still parallel → warning', () => {
    const d = dsl047(flowWith([
      `let names: string[] = [];`,
      `/** @action Each_row @runtimeConfig {"concurrency":{"repetitions":5}} */`,
      `for (const row of ctx.createArray('a', 'b')) {`,
      `  names.push(row);`,
      `}`,
    ]));
    assert.equal(d.length, 1);
  });

  it('increments and decrements are atomic in the cloud → no warning', () => {
    const d = dsl047(flowWith([
      `let count: number = 0;`,
      `let left: number = 10;`,
      `for (const row of ctx.createArray('a', 'b')) {`,
      `  count++;`,
      `  count += 2;`,
      `  count = count + 1;`,
      `  left--;`,
      `  left = left - 1;`,
      `}`,
    ]));
    assert.deepEqual(d, []);
  });

  it('a change inside a sequential loop nested in a parallel one → warning naming the parallel loop', () => {
    const d = dsl047(flowWith([
      `let pairs: string[] = [];`,
      `/** @action Outer */`,
      `for (const x of ctx.createArray('a', 'b')) {`,
      `  /** @action Inner @runtimeConfig {"concurrency":{"repetitions":1}} */`,
      `  for (const y of ctx.createArray(1, 2)) {`,
      `    pairs.push(x);`,
      `  }`,
      `}`,
    ]));
    assert.equal(d.length, 1);
    assert.match(d[0].message, /inside 'Outer'/);
  });

  it('an Until (do...while) runs one iteration at a time → no warning', () => {
    const d = dsl047(flowWith([
      `let names: string[] = [];`,
      `let n: number = 0;`,
      `do {`,
      `  n++;`,
      `  names.push('x');`,
      `} while (ctx.variables('n') < 3);`,
    ]));
    assert.deepEqual(d, []);
  });

  it('reports each variable once per loop', () => {
    const d = dsl047(flowWith([
      `let names: string[] = [];`,
      `for (const row of ctx.createArray('a', 'b')) {`,
      `  names.push(row);`,
      `  names.push(row);`,
      `}`,
    ]));
    assert.equal(d.length, 1);
  });
});
