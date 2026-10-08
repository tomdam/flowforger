import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDiagnostics } from '../src/index.js';

/** Minimal flow with the given lines injected into the @Action method body (first line is line 9). */
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

const dsl048 = (lines: string[]) => getDiagnostics(flowWith(lines)).filter(d => d.code === 'DSL048');

// The cloud's verdicts for these shapes: conformance/save-rules/runafter-path.cloud.json
describe('DSL048 — reads an action that is not on its runAfter path', () => {
  it('statements run after the previous one, so later statements read earlier ones', () => {
    assert.deepEqual(dsl048([
      `await ctx.compose("A", 1);`,
      `await ctx.compose("B", 2);`,
      `await ctx.compose("C", ctx.outputs('A'));`,
    ]), []);
  });

  it('a parallel branch (@runAfter trigger) cannot read the other branch → error at the reference', () => {
    const d = dsl048([
      `await ctx.compose("A", 1);`,
      `/** @runAfter trigger */`,
      `await ctx.compose("B", ctx.outputs('A'));`,
    ]);
    assert.equal(d.length, 1);
    assert.equal(d[0].severity, 'error');
    assert.equal(d[0].range.start.line, 11);
    assert.match(d[0].message, /^'B' reads 'A', but 'A' is not a runAfter predecessor: it runs in parallel or later/);
    assert.match(d[0].message, /Add '@runAfter A: Succeeded' to this action/);
  });

  it('a join may read the branches it lists, not the others', () => {
    const lines = (runAfter: string) => [
      `await ctx.compose("A", 1);`,
      `/** @runAfter trigger */`,
      `await ctx.compose("B", 2);`,
      `/** ${runAfter} */`,
      `await ctx.compose("C", ctx.eval(\`@concat(string(outputs('A')), string(body('B')))\`));`,
    ];
    assert.deepEqual(dsl048(lines('@runAfter A: Succeeded @runAfter B: Succeeded')), []);
    const d = dsl048(lines('@runAfter A: Succeeded'));
    assert.equal(d.length, 1);
    assert.match(d[0].message, /'C' reads 'B'/);
  });

  it('reads through a const bound to an action', () => {
    const d = dsl048([
      `const a = await ctx.compose("A", 1);`,
      `/** @runAfter trigger */`,
      `await ctx.compose("B", a);`,
    ]);
    assert.equal(d.length, 1);
    assert.match(d[0].message, /'B' reads 'A'/);
  });

  it('a const shadowed in one branch does not leak into the other', () => {
    assert.deepEqual(dsl048([
      `const r = await ctx.compose("Outer", 1);`,
      `/** @action I */`,
      `if (ctx.eval('@true')) {`,
      `  const r = await ctx.compose("Inner", 2);`,
      `  await ctx.compose("UseInner", r);`,
      `} else {`,
      `  await ctx.compose("UseOuter", r);`,
      `}`,
    ]), []);
  });

  it('actions after a scope read inside it; a parallel sibling of the scope cannot', () => {
    assert.deepEqual(dsl048([
      `/** @action S @type scope */`,
      `{`,
      `  await ctx.compose("Inner", 1);`,
      `}`,
      `await ctx.compose("After", ctx.outputs('Inner'));`,
    ]), []);
    const d = dsl048([
      `/** @action S @type scope */`,
      `{`,
      `  await ctx.compose("Inner", 1);`,
      `}`,
      `/** @runAfter trigger */`,
      `await ctx.compose("Beside", ctx.outputs('Inner'));`,
    ]);
    assert.equal(d.length, 1);
    assert.match(d[0].message, /'S' \(which contains 'Inner'\) is not a runAfter predecessor/);
    assert.match(d[0].message, /Add '@runAfter S: Succeeded'/);
  });

  it('an action inside a scope cannot read the scope', () => {
    const d = dsl048([
      `/** @action S @type scope */`,
      `{`,
      `  await ctx.compose("Inner", ctx.result('S'));`,
      `}`,
    ]);
    assert.equal(d.length, 1);
    assert.match(d[0].message, /it is inside 'S'/);
  });

  it('the else branch cannot read the then branch', () => {
    const d = dsl048([
      `/** @action I */`,
      `if (ctx.eval('@true')) {`,
      `  await ctx.compose("T", 1);`,
      `} else {`,
      `  await ctx.compose("E", ctx.outputs('T'));`,
      `}`,
    ]);
    assert.equal(d.length, 1);
    assert.match(d[0].message, /'T' is in another branch of 'I'/);
  });

  it("an Until's condition reads its body; a foreach's items cannot", () => {
    assert.deepEqual(dsl048([
      `/** @action U */`,
      `do {`,
      `  await ctx.compose("Step", 1);`,
      `} while (ctx.outputs('Step') !== 1);`,
    ]), []);
    const d = dsl048([
      `/** @action L */`,
      `for (const x of ctx.eval(\`@createArray(outputs('Inner'))\`)) {`,
      `  await ctx.compose("Inner", 1);`,
      `}`,
    ]);
    assert.equal(d.length, 1);
    assert.match(d[0].message, /'Inner' is inside this block/);
  });

  it('an action reading itself', () => {
    const d = dsl048([`await ctx.compose("A", ctx.outputs('A'));`]);
    assert.equal(d.length, 1);
    assert.match(d[0].message, /^'A' reads its own outputs/);
  });

  it('plain { } blocks are flattened into the surrounding statements', () => {
    assert.deepEqual(dsl048([
      `{`,
      `  await ctx.compose("A", 1);`,
      `}`,
      `await ctx.compose("B", ctx.outputs('A'));`,
    ]), []);
  });

  it('stays silent when a @runAfter target cannot be resolved', () => {
    assert.deepEqual(dsl048([
      `let n = 0;`,
      `n = 1;`,
      `await ctx.compose("A", 1);`,
      `/** @runAfter Set_n: Succeeded */`,
      `await ctx.compose("B", ctx.outputs('A'));`,
    ]), []);
  });

  it('ignores references in comments', () => {
    assert.deepEqual(dsl048([
      `await ctx.compose("A", 1);`,
      `// outputs('B') is read later`,
      `/** @runAfter trigger */`,
      `await ctx.compose("B", 2);`,
    ]), []);
  });
});
