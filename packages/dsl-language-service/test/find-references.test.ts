/**
 * Tests for find-all-references over DSL string references.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { findReferences } from '../src/providers/find-references.js';
import type { ReferenceLocation } from '../src/providers/find-references.js';

const CODE = [
  `import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';`,
  ``,
  `@Flow('Demo')`,
  `export class Demo {`,
  `  @HttpTrigger({ method: 'POST' })`,
  `  trigger() {}`,
  ``,
  `  @Action()`,
  `  async actions(ctx: FlowContext) {`,
  `    let counter = 0;`,
  `    await ctx.http('FetchData', { method: 'GET', uri: 'https://example.com' });`,
  `    const rows = ctx.body('FetchData');`,
  `    counter = counter + 1;`,
  `    ctx.setVariable('counter', 5);`,
  `    await ctx.compose('Report', {`,
  `      total: ctx.variables('counter'),`,
  `      raw: ctx.outputs('FetchData'),`,
  `      rows,`,
  `    });`,
  `  }`,
  `}`,
].join('\n');

/** Line index (0-based) of the first line containing `needle`. */
function lineOf(needle: string): number {
  const lines = CODE.split('\n');
  const idx = lines.findIndex((l) => l.includes(needle));
  assert.ok(idx >= 0, `fixture has no line containing ${needle}`);
  return idx;
}

/** 0-indexed position of `needle` inside the line containing `lineNeedle`. */
function positionOf(lineNeedle: string, needle: string) {
  const line = lineOf(lineNeedle);
  const character = CODE.split('\n')[line].indexOf(needle);
  assert.ok(character >= 0, `line ${line} has no ${needle}`);
  return { line, character };
}

function lines(locations: ReferenceLocation[]): number[] {
  return locations.map((l) => l.range.start.line).sort((a, b) => a - b);
}

describe('findReferences', () => {
  describe('actions', () => {
    it('finds the declaration and every reference from a body() reference', () => {
      const result = findReferences(CODE, positionOf(`ctx.body('FetchData')`, 'FetchData'));
      assert.ok(result, 'expected a reference result');
      assert.deepStrictEqual(result.target, { type: 'action', name: 'FetchData' });
      assert.strictEqual(result.origin, 'string');

      // ctx.http declaration, ctx.body reference, ctx.outputs reference
      assert.deepStrictEqual(lines(result.locations), [
        lineOf(`ctx.http('FetchData'`),
        lineOf(`ctx.body('FetchData')`),
        lineOf(`ctx.outputs('FetchData')`),
      ]);
      assert.strictEqual(
        result.locations.filter((l) => l.kind === 'declaration').length,
        1
      );
    });

    it('finds references from the declaration site itself', () => {
      const result = findReferences(CODE, positionOf(`ctx.http('FetchData'`, 'FetchData'));
      assert.ok(result, 'expected a reference result');
      assert.deepStrictEqual(result.target, { type: 'action', name: 'FetchData' });
      assert.strictEqual(result.locations.length, 3);
    });

    it('matches action names case-insensitively (Logic Apps semantics)', () => {
      const code = CODE.replace(`ctx.outputs('FetchData')`, `ctx.outputs('fetchdata')`);
      const line = code.split('\n').findIndex((l) => l.includes(`ctx.outputs('fetchdata')`));
      const character = code.split('\n')[line].indexOf('fetchdata');
      const result = findReferences(code, { line, character });
      assert.ok(result);
      assert.strictEqual(result.locations.length, 3);
    });
  });

  describe('variables', () => {
    it('finds string references and identifier usages from a variables() reference', () => {
      const result = findReferences(CODE, positionOf(`ctx.variables('counter')`, 'counter'));
      assert.ok(result, 'expected a reference result');
      assert.deepStrictEqual(result.target, { type: 'variable', name: 'counter' });
      assert.strictEqual(result.origin, 'string');

      // let counter (declaration), counter = counter + 1 (x2 identifiers),
      // setVariable('counter'), variables('counter')
      assert.deepStrictEqual(lines(result.locations), [
        lineOf('let counter = 0;'),
        lineOf('counter = counter + 1;'),
        lineOf('counter = counter + 1;'),
        lineOf(`ctx.setVariable('counter', 5);`),
        lineOf(`ctx.variables('counter')`),
      ]);
      assert.strictEqual(
        result.locations.filter((l) => l.kind === 'declaration').length,
        1
      );
    });

    it('reports identifier origin when invoked on the let declaration', () => {
      const result = findReferences(CODE, positionOf('let counter = 0;', 'counter'));
      assert.ok(result, 'expected a reference result');
      assert.deepStrictEqual(result.target, { type: 'variable', name: 'counter' });
      assert.strictEqual(result.origin, 'identifier');
      // The string references are what Monaco's TypeScript worker cannot find.
      assert.deepStrictEqual(
        lines(result.locations.filter((l) => l.kind === 'stringReference')),
        [lineOf(`ctx.setVariable('counter', 5);`), lineOf(`ctx.variables('counter')`)]
      );
    });

    it('resolves the variable, not the JSDoc-named Initialize_ action, on the let line', () => {
      // The synthetic nameRange of `@action Initialize_counter` is anchored to
      // the `let` statement and overlaps the identifier.
      const code = CODE.replace(
        '    let counter = 0;',
        '    /** @action Initialize_counter */\n    let counter = 0;'
      );
      const codeLines = code.split('\n');
      const line = codeLines.findIndex((l) => l.includes('let counter = 0;'));
      const character = codeLines[line].indexOf('counter');
      const result = findReferences(code, { line, character });
      assert.ok(result);
      assert.deepStrictEqual(result.target, { type: 'variable', name: 'counter' });
      assert.strictEqual(result.origin, 'identifier');
      assert.strictEqual(
        result.locations.filter((l) => l.kind === 'stringReference').length,
        2
      );
    });

    it('does not treat unrelated property names as variable usages', () => {
      const code = CODE.replace('      rows,', '      counter: 1,');
      const line = code.split('\n').findIndex((l) => l.includes(`ctx.variables('counter')`));
      const character = code.split('\n')[line].indexOf('counter');
      const result = findReferences(code, { line, character });
      assert.ok(result);
      assert.strictEqual(
        result.locations.some((l) => l.range.start.line === code.split('\n').findIndex((x) => x.includes('counter: 1,'))),
        false,
        'object literal key named "counter" must not be reported'
      );
    });
  });

  describe('parameters', () => {
    it('finds parameter declaration and references', () => {
      const code = [
        `@Flow('Demo')`,
        `export class Demo {`,
        `  @Action()`,
        `  async actions(ctx: FlowContext) {`,
        `    await ctx.compose('Use', { v: ctx.parameters('siteUrl') });`,
        `  }`,
        ``,
        `  constructor(ctx: FlowContext) {`,
        `    ctx.flow.parameters = {`,
        `      siteUrl: { type: 'String', value: 'https://example.com' },`,
        `    };`,
        `  }`,
        `}`,
      ].join('\n');
      const line = code.split('\n').findIndex((l) => l.includes(`ctx.parameters('siteUrl')`));
      const character = code.split('\n')[line].indexOf('siteUrl');
      const result = findReferences(code, { line, character });
      assert.ok(result);
      assert.deepStrictEqual(result.target, { type: 'parameter', name: 'siteUrl' });
      assert.strictEqual(result.locations.length, 2);
      assert.strictEqual(result.locations.filter((l) => l.kind === 'declaration').length, 1);
    });
  });

  describe('loops', () => {
    it('finds the declaration of a JSDoc-named foreach from items()', () => {
      const code = [
        `@Flow('Demo')`,
        `export class Demo {`,
        `  @Action()`,
        `  async actions(ctx: FlowContext) {`,
        `    /** @action CategorizeLoop @type foreach */`,
        `    for (const task of ctx.outputs('AllTasks') ?? []) {`,
        `      await ctx.compose('Take', ctx.items('CategorizeLoop'));`,
        `      await ctx.compose('Id', ctx.items('CategorizeLoop')?.['id']);`,
        `    }`,
        `  }`,
        `}`,
      ].join('\n');
      const codeLines = code.split('\n');
      const line = codeLines.findIndex((l) => l.includes(`ctx.items('CategorizeLoop'))`));
      const character = codeLines[line].indexOf('CategorizeLoop');
      const result = findReferences(code, { line, character });
      assert.ok(result);
      assert.deepStrictEqual(result.target, { type: 'loop', name: 'CategorizeLoop' });
      assert.strictEqual(result.locations.filter((l) => l.kind === 'declaration').length, 1);
      assert.strictEqual(result.locations.filter((l) => l.kind === 'stringReference').length, 2);
    });
  });

  describe('no symbol at position', () => {
    it('returns null on unrelated code', () => {
      const result = findReferences(CODE, positionOf('export class Demo {', 'class'));
      assert.strictEqual(result, null);
    });

    it('returns null for an unknown symbol name', () => {
      const code = CODE.replace(`ctx.body('FetchData')`, `ctx.body('Missing')`);
      const line = code.split('\n').findIndex((l) => l.includes(`ctx.body('Missing')`));
      const character = code.split('\n')[line].indexOf('Missing');
      const result = findReferences(code, { line, character });
      // The reference itself still counts as a location even with no declaration.
      assert.ok(result);
      assert.strictEqual(result.locations.filter((l) => l.kind === 'declaration').length, 0);
      assert.strictEqual(result.locations.length, 1);
    });
  });
});
