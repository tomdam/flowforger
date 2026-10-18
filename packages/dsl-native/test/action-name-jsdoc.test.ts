/**
 * `@action <name>`: the name is the rest of that line. A note on the following lines must not
 * become part of the name — the cloud rejects a name with a newline ("invalid characters '\n'",
 * conformance/save-rules/descriptions.mjs `name-newline`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transformCode } from '../src/transformer/index.js';
import { resetIdCounter } from '../src/utils/id-generator.js';

function names(body: string[]): string[] {
  resetIdCounter();
  const code = [
    `@Flow({ name: 'T' })`,
    `class T {`,
    `  @ManualTrigger()`,
    `  trigger(ctx: FlowContext) {}`,
    ``,
    `  @Action()`,
    `  async run(ctx: FlowContext) {`,
    ...body.map((l) => `    ${l}`),
    `  }`,
    ``,
    `  constructor() {}`,
    `}`,
  ].join('\n');
  const ir: any = transformCode(code);
  return ir.nodes.slice(1).map((n: any) => n.name);
}

describe('@action JSDoc name', () => {
  it('a note on the next line is not part of the name', () => {
    assert.deepEqual(names([
      `/**`,
      ` * @action Send_mail`,
      ` * Sends the summary mail`,
      ` */`,
      `let total: number = 0;`,
    ]), ['Send_mail']);
  });

  it('a name with spaces on one line is kept whole', () => {
    assert.deepEqual(names([`/** @action Init total count */`, `let total: number = 0;`]), ['Init total count']);
  });

  it('the name stops at the next tag on the same line', () => {
    assert.deepEqual(names([`/** @action Init_total @runAfter Nothing: Succeeded */`, `let total: number = 0;`]).slice(0, 1), ['Init_total']);
  });

  it('a name on its own line in a multi-line JSDoc', () => {
    assert.deepEqual(names([
      `/**`,
      ` * @action Init_total`,
      ` */`,
      `let total: number = 0;`,
    ]), ['Init_total']);
  });
});
