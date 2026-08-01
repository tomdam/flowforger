import { test } from 'node:test';
import assert from 'node:assert';
import { analyzeSchemaCompletionContext } from '../src/schema-completion.js';
import { buildSymbolIndex } from '../src/index.js';

/** Helper: text with a `|` marking the cursor. */
function analyze(textWithCursor: string) {
  const cursorOffset = textWithCursor.indexOf('|');
  const text = textWithCursor.replace('|', '');
  return analyzeSchemaCompletionContext(text, cursorOffset);
}

test('entityName value in dataverse call', () => {
  const ctx = analyze(`await ctx.connectors.dataverse.ListRecords('Get', { entityName: 'acc|' })`);
  assert.equal(ctx?.type, 'dataverse-entity');
  assert.equal(ctx?.position, 'value');
});

test('dataset value in sharepoint call', () => {
  const ctx = analyze(`await ctx.connectors.sharepoint.GetItems('Get', { dataset: '|' })`);
  assert.equal(ctx?.type, 'sharepoint-site');
});

test('table value in sharepoint call', () => {
  const ctx = analyze(`await ctx.connectors.sharepoint.GetItems('Get', { dataset: 'https://x.sharepoint.com/sites/a', table: '|' })`);
  assert.equal(ctx?.type, 'sharepoint-list');
  assert.deepEqual(ctx?.siteUrl, { kind: 'literal', value: 'https://x.sharepoint.com/sites/a' });
});

test('$select token in dataverse call resolves sibling entityName', () => {
  const ctx = analyze(`await ctx.connectors.dataverse.ListRecords('Get', { entityName: 'accounts', $select: 'name,acc|' })`);
  assert.equal(ctx?.type, 'dataverse-column');
  assert.equal(ctx?.position, 'odataToken');
  assert.deepEqual(ctx?.entityName, { kind: 'literal', value: 'accounts' });
});

test('$filter and $orderby are column contexts too', () => {
  for (const key of ['$filter', '$orderby']) {
    const ctx = analyze(`await ctx.connectors.dataverse.ListRecords('G', { entityName: 'accounts', ${key}: '|' })`);
    assert.equal(ctx?.type, 'dataverse-column', key);
  }
});

test('item object key position in dataverse CreateRecord', () => {
  const ctx = analyze(`await ctx.connectors.dataverse.CreateRecord('C', { entityName: 'contacts', item: { |, } })`);
  assert.equal(ctx?.type, 'dataverse-column');
  assert.equal(ctx?.position, 'objectKey');
  assert.deepEqual(ctx?.entityName, { kind: 'literal', value: 'contacts' });
});

test('sibling AFTER the cursor is still resolved', () => {
  const ctx = analyze(`await ctx.connectors.dataverse.CreateRecord('C', { item: { na| }, entityName: 'contacts' })`);
  assert.equal(ctx?.type, 'dataverse-column');
  assert.deepEqual(ctx?.entityName, { kind: 'literal', value: 'contacts' });
});

test('sibling via ctx.parameters()', () => {
  const ctx = analyze(`await ctx.connectors.sharepoint.GetItems('G', { dataset: ctx.parameters('spSite'), table: '|' })`);
  assert.equal(ctx?.type, 'sharepoint-list');
  assert.deepEqual(ctx?.siteUrl, { kind: 'parameter', name: 'spSite' });
});

test('computed sibling stays undefined', () => {
  const ctx = analyze(`await ctx.connectors.dataverse.ListRecords('G', { entityName: myVar, $select: '|' })`);
  assert.equal(ctx?.type, 'dataverse-column');
  assert.equal(ctx?.entityName, undefined);
});

test('sharepoint item keys need site AND list', () => {
  const ctx = analyze(`await ctx.connectors.sharepoint.CreateItem('C', { dataset: 'https://x.sharepoint.com', table: 'abc', item: { |} })`);
  assert.equal(ctx?.type, 'sharepoint-column');
  assert.deepEqual(ctx?.siteUrl, { kind: 'literal', value: 'https://x.sharepoint.com' });
  assert.deepEqual(ctx?.list, { kind: 'literal', value: 'abc' });
});

test('null outside connector calls', () => {
  assert.equal(analyze(`const x = { entityName: 'acc|' }`), null);
  assert.equal(analyze(`await ctx.http('Get', { url: 'http|' })`), null);
});

test('null when the call closed before the cursor', () => {
  assert.equal(analyze(`await ctx.connectors.dataverse.ListRecords('G', { entityName: 'a' }); const y = '|'`), null);
});

test('nested object inside item does not complete columns', () => {
  // Inside a nested object literal, keys are not top-level columns.
  const ctx = analyze(`await ctx.connectors.dataverse.CreateRecord('C', { entityName: 'contacts', item: { address: { |} } })`);
  assert.equal(ctx, null);
});

test('action-name string (first arg) is not a schema context', () => {
  assert.equal(analyze(`await ctx.connectors.dataverse.ListRecords('|')`), null);
});

test('generator-shaped call: multi-line, double-quoted, quoted "$select" key', () => {
  // Every other detection test here is single-line and single-quoted, which is
  // NOT what the editor actually holds: generateNativeDslFromIR emits
  // double-quoted strings, quotes any key that is not a plain identifier (so
  // `"$select":`), and breaks the params object across lines once it exceeds
  // ~60 chars. See packages/dsl-native/src/generator.ts (formatValue).
  const text = [
    `    await ctx.connectors.sharepoint.GetItems("Get_items", {`,
    `      dataset: "https://contoso.sharepoint.com/sites/s1",`,
    `      table: "{11111111-1111-1111-1111-111111111111}",`,
    `      "$select": "Title,Sta|",`,
    `      "$top": 100`,
    `    });`,
  ].join('\n');
  const cursorOffset = text.indexOf('|');
  const ctx = analyzeSchemaCompletionContext(text.replace('|', ''), cursorOffset);
  assert.equal(ctx?.type, 'sharepoint-column');
  assert.equal(ctx?.position, 'odataToken');
  assert.deepEqual(ctx?.siteUrl, {
    kind: 'literal',
    value: 'https://contoso.sharepoint.com/sites/s1',
  });
  assert.deepEqual(ctx?.list, {
    kind: 'literal',
    value: '{11111111-1111-1111-1111-111111111111}',
  });
});

test('symbol index captures string parameter defaultValue', () => {
  const code = `
import { Flow, HttpTrigger, Action, type FlowContext } from '@flowforger/dsl-native';

@Flow({ name: 'Test' })
class TestFlow {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {}

  constructor(ctx: FlowContext) {
    ctx.flow.parameters = {
      spSite: { type: 'String', defaultValue: 'https://x.sharepoint.com/sites/a' },
      maxRows: { type: 'Int', defaultValue: 50 },
    };
  }
}
`;
  const index = buildSymbolIndex(code);
  const spSite = index.parameters.find((p) => p.name === 'spSite');
  assert.equal(spSite?.defaultValue, 'https://x.sharepoint.com/sites/a');
  const maxRows = index.parameters.find((p) => p.name === 'maxRows');
  assert.equal(maxRows?.defaultValue, undefined); // only string literals captured
});
