import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDiagnostics } from '../src/index.js';

/** Wrap a ctx.eval line into a minimal flow so other checks stay quiet-ish;
 *  tests filter by code anyway. */
function flowWith(evalLine: string): string {
  return [
    `import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';`,
    ``,
    `@Flow({ name: 'T' })`,
    `export class T {`,
    `  @HttpTrigger()`,
    `  async onRequest(ctx: FlowContext) {}`,
    ``,
    `  @Action()`,
    `  async run(ctx: FlowContext) {`,
    `    ${evalLine}`,
    `  }`,
    `}`,
    ``,
  ].join('\n');
}

const EVAL_LINE = 9; // 0-indexed line of the injected statement in flowWith()

function exprDiags(evalLine: string) {
  return getDiagnostics(flowWith(evalLine)).filter(
    d => d.code === 'DSL033' || d.code === 'DSL034',
  );
}

describe('ctx.eval expression diagnostics', () => {
  it('valid expression → clean', () => {
    assert.deepEqual(exprDiags('await ctx.compose(ctx.eval(`@concat(\'a\', variables(\'x\'))`));'), []);
  });

  it('unknown function → DSL034 warning with in-literal range', () => {
    const d = exprDiags('await ctx.compose(ctx.eval(`@varaibles(\'x\')`));');
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL034');
    assert.equal(d[0].severity, 'warning');
    assert.match(d[0].message, /varaibles/);
    assert.equal(d[0].range.start.line, EVAL_LINE);
    // squiggle starts inside the template literal, after "ctx.eval(`"
    assert.ok(d[0].range.start.character > 'await ctx.compose(ctx.eval(`'.length - 1);
  });

  it('syntax error → DSL033 error', () => {
    const d = exprDiags('await ctx.compose(ctx.eval(`@concat(\'a\'`));');
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL033');
    assert.equal(d[0].severity, 'error');
    assert.equal(d[0].range.start.line, EVAL_LINE);
  });

  it('valid template → clean; broken template segment → DSL033', () => {
    assert.deepEqual(exprDiags('await ctx.compose(ctx.eval(`x eq \'@{variables(\'x\')}\'`));'), []);
    const d = exprDiags('await ctx.compose(ctx.eval(`x @{concat(\'a\'} y`));');
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL033');
  });

  it('unknown function inside a template segment → DSL034', () => {
    const d = exprDiags('await ctx.compose(ctx.eval(`x @{bogusFn(1)} y`));');
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL034');
    assert.match(d[0].message, /bogusFn/);
  });

  it('@@ escape and plain strings → clean', () => {
    assert.deepEqual(exprDiags('await ctx.compose(ctx.eval(`@@literal`));'), []);
    assert.deepEqual(exprDiags("await ctx.compose(ctx.eval('plain text'));"), []);
  });

  it('substitution templates are skipped (dynamic content)', () => {
    assert.deepEqual(
      exprDiags('const n = 1; await ctx.compose(ctx.eval(`@bogus(${n})`));'),
      [],
    );
  });

  it('string literal arg is validated too', () => {
    const d = exprDiags('await ctx.compose(ctx.eval("@varaibles(\'x\')"));');
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL034');
  });

  it('escaped content falls back to whole-literal range but still reports', () => {
    // \` inside the template literal → cooked text differs from raw source
    const d = exprDiags('await ctx.compose(ctx.eval(`@concat(\'a\\`b\'`));');
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL033');
    assert.equal(d[0].range.start.line, EVAL_LINE);
  });
});
