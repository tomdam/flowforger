import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDiagnostics } from '../src/index.js';

/** Minimal flow with the given lines injected into the @Action method body. */
function flowWith(bodyLines: string[], trigger = `@HttpTrigger()`): string {
  return [
    `import { Flow, HttpTrigger, ManualTrigger, RecurrenceTrigger, ConnectorTrigger, Action, FlowContext } from '@flowforger/dsl-native';`,
    ``,
    `@Flow({ name: 'T' })`,
    `export class T {`,
    `  ${trigger}`,
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

const placement = (code: string) =>
  getDiagnostics(code).filter(d => d.code === 'DSL037' || d.code === 'DSL038');

describe('DSL037 — Response / Terminate inside a loop', () => {
  it('response and terminate at the root → no diagnostics', () => {
    const d = placement(flowWith([
      `await ctx.compose('A', { a: 1 });`,
      `await ctx.response('Respond', 200, { ok: true });`,
      `await ctx.terminate('End', 'Succeeded');`,
    ]));
    assert.deepEqual(d, []);
  });

  it('ctx.response inside for...of → DSL037 error at the call', () => {
    const d = placement(flowWith([
      `for (const file of ctx.body('GetFiles')) {`,
      `  await ctx.response('Respond_FileNotFound', 404, { error: 'not found' });`,
      `}`,
    ]));
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL037');
    assert.equal(d[0].severity, 'error');
    assert.match(d[0].message, /ctx\.response\(\) cannot be inside a for\.\.\.of loop/);
    assert.match(d[0].message, /could not be nested under an action of type 'foreach'/);
    assert.match(d[0].message, /once after the loop/);
    assert.equal(d[0].range.start.line, 10);
    assert.equal(d[0].range.start.character, `      await `.length);
  });

  it('ctx.terminate inside for...of → DSL037 with the terminate hint', () => {
    const d = placement(flowWith([
      `for (const item of ctx.body('GetItems')) {`,
      `  if (ctx.equals(item.status, 'bad')) {`,
      `    await ctx.terminate('Stop', 'Failed', { code: 'BAD', message: 'bad item' });`,
      `  }`,
      `}`,
    ]));
    assert.equal(d.length, 1);
    assert.match(d[0].message, /ctx\.terminate\(\) cannot be inside a for\.\.\.of loop/);
    assert.match(d[0].message, /flag variable/);
  });

  it('inside do...while and while (until loops) → DSL037 naming the until loop', () => {
    const d = placement(flowWith([
      `let done = false;`,
      `do {`,
      `  await ctx.response('R1', 200, {});`,
      `} while (!done);`,
      `while (!done) {`,
      `  await ctx.terminate('T1', 'Cancelled');`,
      `}`,
    ]));
    assert.equal(d.length, 2);
    for (const diag of d) assert.match(diag.message, /while \/ do\.\.\.while loop \(until\)/);
  });

  it('nested deeper (for...of → if → scope block → switch) → still DSL037', () => {
    const d = placement(flowWith([
      `for (const item of ctx.body('GetItems')) {`,
      `  if (ctx.equals(item.kind, 'x')) {`,
      `    {`,
      `      switch (item.type) {`,
      `        case 'a':`,
      `          await ctx.response('Respond', 200, {});`,
      `          break;`,
      `      }`,
      `    }`,
      `  }`,
      `}`,
    ]));
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL037');
  });

  it('inside if / switch / scope without a loop → no DSL037', () => {
    const d = placement(flowWith([
      `if (ctx.equals(1, 1)) {`,
      `  await ctx.response('R1', 200, {});`,
      `} else {`,
      `  await ctx.terminate('T1', 'Failed');`,
      `}`,
      `{`,
      `  await ctx.response('R2', 200, {});`,
      `}`,
    ]));
    assert.deepEqual(d, []);
  });

  it('a response after the loop (not inside it) → no DSL037', () => {
    const d = placement(flowWith([
      `let found = false;`,
      `for (const item of ctx.body('GetItems')) {`,
      `  found = true;`,
      `}`,
      `await ctx.response('Respond', 200, { found });`,
    ]));
    assert.deepEqual(d, []);
  });
});

describe('DSL038 — Response needs a request trigger', () => {
  it('@HttpTrigger and @ManualTrigger allow ctx.response', () => {
    assert.deepEqual(placement(flowWith([`await ctx.response('R', 200, {});`], `@HttpTrigger()`)), []);
    assert.deepEqual(placement(flowWith([`await ctx.response('R', 200, {});`], `@ManualTrigger()`)), []);
  });

  it('@RecurrenceTrigger → DSL038 error', () => {
    const d = placement(flowWith([`await ctx.response('R', 200, {});`], `@RecurrenceTrigger({ frequency: 'Day', interval: 1 })`));
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL038');
    assert.equal(d[0].severity, 'error');
    assert.match(d[0].message, /@RecurrenceTrigger/);
  });

  it('@ConnectorTrigger → DSL038 error', () => {
    const d = placement(flowWith([`await ctx.response('R', 200, {});`], `@ConnectorTrigger({ connector: 'sharepoint', operation: 'GetOnNewItems', params: {} })`));
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'DSL038');
    assert.match(d[0].message, /@ConnectorTrigger/);
  });

  it('terminate with a recurrence trigger is fine (only response needs a caller)', () => {
    assert.deepEqual(placement(flowWith([`await ctx.terminate('T', 'Succeeded');`], `@RecurrenceTrigger({ frequency: 'Day', interval: 1 })`)), []);
  });

  it('response inside a loop of a recurrence flow → both DSL037 and DSL038', () => {
    const d = placement(flowWith([
      `for (const x of ctx.body('A')) {`,
      `  await ctx.response('R', 200, {});`,
      `}`,
    ], `@RecurrenceTrigger({ frequency: 'Day', interval: 1 })`));
    assert.deepEqual(d.map(x => x.code).sort(), ['DSL037', 'DSL038']);
  });
});
