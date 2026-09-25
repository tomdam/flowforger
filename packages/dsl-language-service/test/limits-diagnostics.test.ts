import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDiagnostics } from '../src/index.js';

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

const only = (code: string, ...codes: string[]) => (src: string) =>
  getDiagnostics(src).filter(d => d.code === code || codes.includes(d.code));

describe('DSL039-DSL042 — definition limits', () => {
  it('action name longer than 80 characters → DSL039 at the name', () => {
    const long = 'A'.repeat(81);
    const d = only('DSL039')(flowWith([`await ctx.compose('${long}', { a: 1 });`]));
    assert.equal(d.length, 1);
    assert.equal(d[0].severity, 'error');
    assert.match(d[0].message, /81 characters/);
    assert.equal(d[0].range.start.line, 9);
    assert.deepEqual(only('DSL039')(flowWith([`await ctx.compose('${'A'.repeat(80)}', { a: 1 });`])), []);
  });

  it('more than 500 actions → DSL040 warning', () => {
    const lines = Array.from({ length: 501 }, (_, i) => `await ctx.compose('A${i}', { a: ${i} });`);
    const d = only('DSL040')(flowWith(lines));
    assert.equal(d.length, 1);
    assert.equal(d[0].severity, 'warning');
    assert.match(d[0].message, /501 actions/);
  });

  it('switch with 26 cases → DSL041; 25 cases → nothing', () => {
    const mk = (n: number) => [
      `/** @action Route @type switch */`,
      `switch (ctx.triggerBody()?.['kind']) {`,
      ...Array.from({ length: n }, (_, i) => [`  case '${i}':`, `    await ctx.compose('C${i}', { i: ${i} });`, `    break;`]).flat(),
      `  default:`,
      `    await ctx.compose('Other', { i: -1 });`,
      `}`,
    ];
    const d = only('DSL041')(flowWith(mk(26)));
    assert.equal(d.length, 1);
    assert.match(d[0].message, /26 cases/);
    assert.deepEqual(only('DSL041')(flowWith(mk(25))), []);
  });

  it('more than 250 variables → DSL042', () => {
    const lines = Array.from({ length: 251 }, (_, i) => `let v${i} = ${i};`);
    lines.push(`await ctx.compose('Use', { ${Array.from({ length: 251 }, (_, i) => `v${i}`).join(', ')} });`);
    const d = only('DSL042')(flowWith(lines));
    assert.equal(d.length, 1);
    assert.match(d[0].message, /251 variables/);
  });
});

describe('DSL043 — JSDoc annotation values', () => {
  it('@runtimeConfig repetitions outside 1-50 → DSL043', () => {
    const d = only('DSL043')(flowWith([
      `/** @action Each @type foreach @runtimeConfig {"concurrency":{"repetitions":51}} */`,
      `for (const x of ctx.body('A')) {`,
      `  await ctx.compose('C', x);`,
      `}`,
    ]));
    assert.equal(d.length, 1);
    assert.match(d[0].message, /Invalid @runtimeConfig value: concurrency\.repetitions is 51; allowed range is 1-50/);
    assert.deepEqual(only('DSL043')(flowWith([
      `/** @action Each @type foreach @runtimeConfig {"concurrency":{"repetitions":50}} */`,
      `for (const x of ctx.body('A')) {`,
      `  await ctx.compose('C', x);`,
      `}`,
    ])), []);
  });

  it('@retryPolicy with a bad type, count and interval → one DSL043 per problem', () => {
    const d = only('DSL043')(flowWith([
      `/** @retryPolicy {"type":"linear","count":91,"interval":"PT2S"} */`,
      `await ctx.http('Call', { method: 'GET', url: 'https://x' });`,
    ]));
    assert.equal(d.length, 3);
    assert.match(d[0].message, /type is "linear"/);
    assert.match(d[1].message, /count is 91/);
    assert.match(d[2].message, /interval is "PT2S"; allowed range is PT5S to P1D/);
  });

  it('valid @retryPolicy → nothing; type none skips count/interval', () => {
    assert.deepEqual(only('DSL043')(flowWith([
      `/** @retryPolicy {"type":"fixed","count":4,"interval":"PT20S"} */`,
      `await ctx.http('Call', { method: 'GET', url: 'https://x' });`,
      `/** @retryPolicy {"type":"none"} */`,
      `await ctx.http('Call2', { method: 'GET', url: 'https://x' });`,
    ])), []);
  });

  it('@limit count above 5000 or a non-ISO timeout → DSL043', () => {
    const d = only('DSL043')(flowWith([
      `let done = false;`,
      `/** @action Poll @type until @limit {"count":6000,"timeout":"1h"} */`,
      `do {`,
      `  await ctx.compose('Tick', { done });`,
      `} while (!done);`,
      `/** @action Poll2 @type until @limit 9000 */`,
      `do {`,
      `  await ctx.compose('Tick2', { done });`,
      `} while (!done);`,
    ]));
    assert.equal(d.length, 3);
    assert.match(d[0].message, /count is 6000/);
    assert.match(d[1].message, /timeout is "1h"/);
    assert.match(d[2].message, /count is 9000/);
  });
});

describe('DSL044 — response kind vs trigger', () => {
  it("'PowerApp' response with @HttpTrigger → DSL044 warning; with @ManualTrigger → nothing", () => {
    const line = `await ctx.response('Respond', 200, { ok: true }, undefined, { type: 'object', properties: {} }, 'PowerApp');`;
    const d = only('DSL044')(flowWith([line], `@HttpTrigger()`));
    assert.equal(d.length, 1);
    assert.equal(d[0].severity, 'warning');
    assert.match(d[0].message, /'PowerApp' pairs with @ManualTrigger/);
    assert.match(d[0].message, /uses @HttpTrigger/);
    assert.deepEqual(only('DSL044')(flowWith([line], `@ManualTrigger()`)), []);
  });

  it("'VirtualAgent' response needs @HttpTrigger({ triggerKind: 'VirtualAgent' })", () => {
    const line = `await ctx.response('Respond', 200, { ok: true }, undefined, { type: 'object', properties: {} }, 'VirtualAgent');`;
    assert.equal(only('DSL044')(flowWith([line], `@HttpTrigger()`)).length, 1);
    assert.equal(only('DSL044')(flowWith([line], `@ManualTrigger()`)).length, 1);
    assert.deepEqual(only('DSL044')(flowWith([line], `@HttpTrigger({ triggerKind: 'VirtualAgent' })`)), []);
  });

  it('a plain HTTP response never triggers DSL044', () => {
    assert.deepEqual(only('DSL044')(flowWith([`await ctx.response('R', 200, { ok: true });`], `@ManualTrigger()`)), []);
  });
});

describe('DSL045/DSL046 — @RecurrenceTrigger options', () => {
  const body = [`await ctx.compose('A', { a: 1 });`];

  it('bad frequency and out-of-range interval → DSL045', () => {
    const d = only('DSL045')(flowWith(body, `@RecurrenceTrigger({ frequency: 'Fortnight', interval: 1 })`));
    assert.equal(d.length, 1);
    assert.match(d[0].message, /frequency 'Fortnight'/);
    const d2 = only('DSL045')(flowWith(body, `@RecurrenceTrigger({ frequency: 'Day', interval: 501 })`));
    assert.match(d2[0].message, /interval 501 must be an integer from 1 to 500 for frequency 'Day'/);
    assert.equal(only('DSL045')(flowWith(body, `@RecurrenceTrigger({ frequency: 'Minute', interval: 0 })`)).length, 1);
  });

  it('valid options → nothing', () => {
    assert.deepEqual(only('DSL045', 'DSL046')(flowWith(body, `@RecurrenceTrigger({ frequency: 'Week', interval: 1, schedule: { hours: [8], minutes: [0], weekDays: ['Monday'] } })`)), []);
    assert.deepEqual(only('DSL045', 'DSL046')(flowWith(body, `@RecurrenceTrigger({ frequency: 'Hour', interval: 12000 })`)), []);
  });

  it('schedule fields that the frequency ignores → DSL046 warning', () => {
    const d = only('DSL046')(flowWith(body, `@RecurrenceTrigger({ frequency: 'Hour', interval: 1, schedule: { hours: [8], weekDays: ['Monday'] } })`));
    assert.equal(d.length, 2);
    assert.equal(d[0].severity, 'warning');
    assert.match(d[0].message, /hours\/minutes only apply to frequency Day or Week/);
    assert.match(d[1].message, /weekDays only applies to frequency Week/);
  });
});
