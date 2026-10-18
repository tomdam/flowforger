import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDiagnostics } from '../src/index.js';

/** Minimal flow with the given lines injected into the @Action method body. */
function flowWith(bodyLines: string[]): string {
  return [
    `import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';`,
    ``,
    `@Flow({ name: 'T' })`,
    `export class T {`,
    `  @HttpTrigger()`,
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

const syntax = (code: string, opts?: Parameters<typeof getDiagnostics>[1]) =>
  getDiagnostics(code, opts).filter(d => d.code === 'DSL051');

// A finished string followed directly by another string, no comma between them:
// TypeScript's parser recovers from this, so without a syntax gate the recovered
// AST is analysed (and compiled) as if the line were valid.
const BROKEN_QUOTE = [
  `let varTargetRelative: string = '/sites/x/lib/folder';`,
  `await ctx.compose('PeriodeSubfolders', ['A', 'B']);`,
  `/** @action CreateSubfolders @type foreach */`,
  `for (const subfolder of ctx.outputs('PeriodeSubfolders')) {`,
  `  await ctx.compose('Uri', ctx.braced(ctx.concat('_api/web/folders/addUsingPath(DecodedUrl=@a1,Overwrite=false)?@a1='', ctx.encodeUriComponent(ctx.replace(ctx.concat(ctx.variables('varTargetRelative'), '/', ctx.items('CreateSubfolders')), ''', '''')), ''')));`,
  `}`,
];

describe('DSL051 — TypeScript syntax errors', () => {
  it('a syntactically valid flow → no diagnostics', () => {
    assert.deepEqual(syntax(flowWith([`await ctx.compose('A', { a: 1 });`])), []);
  });

  it('an unbalanced quote → DSL051 error at the first parse diagnostic', () => {
    const d = syntax(flowWith(BROKEN_QUOTE));
    assert.ok(d.length > 0, 'expected at least one DSL051');
    assert.equal(d[0].severity, 'error');
    assert.equal(d[0].range.start.line, 13);
    assert.match(d[0].message, /',' expected/);
    // Every parse diagnostic is reported, in source order
    assert.ok(d.some(x => /Unterminated string literal/.test(x.message)));
    for (let i = 1; i < d.length; i++) {
      assert.ok(d[i].range.start.line >= d[i - 1].range.start.line);
    }
  });

  it('a missing closing brace → DSL051', () => {
    const code = flowWith([`await ctx.compose('A', { a: 1 );`]);
    const d = syntax(code);
    assert.ok(d.length > 0);
    assert.equal(d[0].severity, 'error');
  });

  it('counts as an error for getDiagnosticCounts', async () => {
    const { getDiagnosticCounts } = await import('../src/index.js');
    const counts = getDiagnosticCounts(getDiagnostics(flowWith(BROKEN_QUOTE)));
    assert.ok(counts.error > 0);
  });

  it('checkSyntax: false → not reported (hosts with their own TypeScript service)', () => {
    assert.deepEqual(syntax(flowWith(BROKEN_QUOTE), { checkSyntax: false }), []);
  });
});
