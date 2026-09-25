import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDiagnostics } from '../src/index.js';

/** Minimal flow with the given lines injected into the @Action method body. */
function flowWith(bodyLines: string[], opts: { classDoc?: string[]; fileDoc?: string[] } = {}): string {
  return [
    ...(opts.fileDoc ?? []),
    `import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';`,
    ``,
    ...(opts.classDoc ?? []),
    `@Flow({ name: 'T' })`,
    `export class T {`,
    `  @HttpTrigger()`,
    `  async onRequest(ctx: FlowContext) {}`,
    ``,
    `  @Action()`,
    `  async run(ctx: FlowContext) {`,
    ...bodyLines.map(l => `    ${l}`),
    `  }`,
    `}`,
    ``,
  ].join('\n');
}

function descDiags(code: string) {
  return getDiagnostics(code).filter(d => d.code === 'DSL035' || d.code === 'DSL036');
}

describe('comment / description diagnostics (DSL035, DSL036)', () => {
  it('plain comment without @ → clean', () => {
    assert.deepEqual(descDiags(flowWith([
      `// Build the payload from the trigger body`,
      `await ctx.compose('A', { a: 1 });`,
    ])), []);
  });

  it('@{...} in a // comment → DSL035 error on the interpolation', () => {
    const d = descDiags(flowWith([
      `// Build the payload using @{triggerBody()?['name']} for the name`,
      `await ctx.compose('A', { a: 1 });`,
    ]));
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL035');
    assert.equal(d[0].severity, 'error');
    assert.match(d[0].message, /@\{triggerBody\(\)\?\['name'\]\}/);
    assert.equal(d[0].range.start.line, 9);
    assert.equal(d[0].range.start.character, `    // Build the payload using `.length);
  });

  it('literal empty @{} → DSL035', () => {
    const d = descDiags(flowWith([`// see @{} syntax`, `await ctx.compose('A', { a: 1 });`]));
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL035');
    assert.match(d[0].message, /'@\{\}'/);
  });

  it('@{ inside a JSDoc @description → DSL035', () => {
    const d = descDiags(flowWith([
      `/**`,
      ` * @description Sends @{variables('x')} downstream`,
      ` * @runAfter A: Succeeded`,
      ` */`,
      `await ctx.compose('B', { b: 2 });`,
    ]));
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL035');
    assert.equal(d[0].range.start.line, 10);
  });

  it('@{ in a structural-only JSDoc is still flagged (hazard, even if dropped today)', () => {
    const d = descDiags(flowWith([
      `/** @action B — uses @{outputs('A')} */`,
      `await ctx.compose('B_', { b: 2 });`,
    ]));
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL035');
  });

  it('@{ inside a string or template literal is NOT a comment → clean', () => {
    assert.deepEqual(descDiags(flowWith([
      `await ctx.compose('A', { url: 'https://x.example/api/@{variables(\\'id\\')}' });`,
      'await ctx.compose(\'B\', { url: `https://x.example/api/${ctx.body(\'A\')}//@{x}` });',
    ])), []);
  });

  it('comment starting with @ → DSL036 warning', () => {
    const d = descDiags(flowWith([`// @todo handle retries`, `await ctx.compose('A', { a: 1 });`]));
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL036');
    assert.equal(d[0].severity, 'warning');
    assert.match(d[0].message, /'@todo'/);
    assert.equal(d[0].range.start.character, `    // `.length);
    assert.equal(d[0].range.end.character, `    // @todo`.length);
  });

  it('@@ escape at the start is accepted', () => {
    assert.deepEqual(descDiags(flowWith([`// @@literal at sign`, `await ctx.compose('A', { a: 1 });`])), []);
  });

  it('only the first line of a // run can "start" the description', () => {
    assert.deepEqual(descDiags(flowWith([
      `// First line of the note`,
      `// @second line continues the same description`,
      `await ctx.compose('A', { a: 1 });`,
    ])), []);
  });

  it('a trailing // comment after code is not a description', () => {
    assert.deepEqual(descDiags(flowWith([
      `await ctx.compose('A', { a: 1 }); // @see docs`,
    ])), []);
  });

  it('structural JSDoc tags never trigger DSL036', () => {
    assert.deepEqual(descDiags(flowWith([
      `/** @action MyScope @type scope */`,
      `{`,
      `  await ctx.compose('A', { a: 1 });`,
      `}`,
      `/**`,
      ` * @runAfter MyScope: Failed`,
      ` * @description recover`,
      ` */`,
      `await ctx.compose('B', { b: 2 });`,
    ])), []);
  });

  it('@description whose text starts with @ → DSL036', () => {
    const d = descDiags(flowWith([
      `/** @description @foo bar @runAfter A: Succeeded */`,
      `await ctx.compose('B', { b: 2 });`,
    ]));
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL036');
    assert.match(d[0].message, /'@foo'/);
  });

  it('class-level JSDoc (flow description) is checked', () => {
    const d = descDiags(flowWith([`await ctx.compose('A', { a: 1 });`], {
      classDoc: [`/**`, ` * Flow-level note mentioning @{triggerBody()} here`, ` */`],
    }));
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL035');
    assert.equal(d[0].range.start.line, 3);

    const w = descDiags(flowWith([`await ctx.compose('A', { a: 1 });`], {
      classDoc: [`/** @deprecated use the v2 flow */`],
    }));
    assert.equal(w.length, 1);
    assert.equal(w[0].code, 'DSL036');
  });

  it('file-level JSDoc above the imports is checked', () => {
    const d = descDiags(flowWith([`await ctx.compose('A', { a: 1 });`], {
      fileDoc: [`/** Header with @{x} */`],
    }));
    assert.equal(d.length, 1);
    assert.equal(d[0].range.start.line, 0);
  });

  it('plain block comment is checked like a // comment', () => {
    const d = descDiags(flowWith([
      `/* @internal note`,
      `   with @{variables('x')} */`,
      `await ctx.compose('A', { a: 1 });`,
    ]));
    assert.deepEqual(d.map(x => x.code).sort(), ['DSL035', 'DSL036']);
  });
});
