import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDiagnostics } from '../src/index.js';

// DSL035: an @action tag value the cloud refuses as an action name. Comments that become
// descriptions are not checked: the cloud saves "@{...}" and a leading "@" there as is
// (conformance/save-rules/descriptions.mjs).

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

function nameDiags(code: string) {
  return getDiagnostics(code).filter(d => d.code === 'DSL035' || d.code === 'DSL036');
}

describe('@action name diagnostics (DSL035)', () => {
  it('a note with "@{" after the name on the same line → DSL035 on the whole name', () => {
    const d = nameDiags(flowWith([
      `/** @action Init_total — uses @{outputs('A')} */`,
      `let total: number = 0;`,
    ]));
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL035');
    assert.equal(d[0].severity, 'error');
    assert.match(d[0].message, /'Init_total — uses @\{outputs\('A'\)\}' contains "@\{"/);
    assert.equal(d[0].range.start.line, 9);
    assert.equal(d[0].range.start.character, `    /** @action `.length);
    assert.equal(d[0].range.end.character, `    /** @action Init_total — uses @{outputs('A')}`.length);
  });

  it('each character the cloud refuses is reported', () => {
    for (const ch of ['<', '>', '%', '&', '\\', '?', '/']) {
      const d = nameDiags(flowWith([`/** @action A${ch}B */`, `let total: number = 0;`]));
      assert.equal(d.length, 1, ch);
      assert.ok(d[0].message.includes(JSON.stringify(ch)), d[0].message);
    }
  });

  it('the name stops at the next tag, the end of the line or "*/"', () => {
    assert.deepEqual(nameDiags(flowWith([
      `/** @action Case 2 @type case */`,
      `/**`,
      ` * @action Init_total`,
      ` * Note on the next line with @{outputs('A')} — not part of the name`,
      ` */`,
      `let total: number = 0;`,
    ])), []);
  });

  it('"@", braces, quotes, parentheses and dashes in a name are fine', () => {
    assert.deepEqual(nameDiags(flowWith([
      `/** @action B @x {y} 'z' (w) — note */`,
      `let total: number = 0;`,
    ])), []);
  });

  it('a Switch case name is not an action name: "/" and "&" are fine there (production flows have them)', () => {
    assert.deepEqual(nameDiags(flowWith([
      `switch (ctx.triggerBody()['text']) {`,
      `  /** @action Groß-/Kleinbuchstaben @type case */`,
      `  case "10_KWI":`,
      `    await ctx.compose('A', 1);`,
      `    break;`,
      `  /** @action Case_P&P */`,
      `  case "P&P":`,
      `    await ctx.compose('B', 1);`,
      `    break;`,
      `}`,
    ])), []);
  });

  it('descriptions are not checked: "@{...}" or a leading "@" in any comment → clean', () => {
    assert.deepEqual(nameDiags(flowWith([
      `// Build the payload using @{triggerBody()?['name']} for the name`,
      `await ctx.compose('A', { a: 1 });`,
      `// @todo handle retries`,
      `await ctx.compose('B', { a: 1 });`,
      `/**`,
      ` * @description Sends @{variables('x')} downstream`,
      ` * @runAfter A: Succeeded`,
      ` */`,
      `await ctx.compose('C', { c: 2 });`,
      `/** @trackedProperties {"batchGUID":"@{guid()}"} */`,
      `await ctx.compose('D', { d: 1 });`,
      `/* Block comment with @{guid()} */`,
      `await ctx.compose('E', { e: 1 });`,
    ], {
      classDoc: [`/**`, ` * Flow-level note mentioning @{triggerBody()} here`, ` */`],
      fileDoc: [`/** Header with @{x} */`],
    })), []);
  });

  it('"@action" inside a // comment or a string is not a tag', () => {
    assert.deepEqual(nameDiags(flowWith([
      `// @action A/B is not a JSDoc tag`,
      `await ctx.compose('A', { url: '/** @action X/Y */' });`,
    ])), []);
  });
});
