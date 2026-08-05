/**
 * Golden tests for the TS→OData direction: ctx.odata.* builder calls and
 * ctx.odata`...` tagged templates → OData filter strings, serialized through
 * the shared OData AST + printer (src/odata/).
 *
 * History: born as a differential test against the legacy string-building
 * implementation (odata-transformer-legacy.ts, since deleted). Every row was
 * byte-identical to legacy output except two documented fixes:
 *  - string values containing a quote now print with OData '' escaping
 *    (legacy emitted invalid OData: name eq 'O'Brien')
 *  - tagged-template numerals keep their source text (legacy printed 2.10 as
 *    2.1 via parseFloat)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Project, SyntaxKind } from 'ts-morph';
import {
  isODataCall,
  transformODataCall,
  isODataTaggedTemplate,
  transformODataTaggedTemplate,
} from '../src/transformer/odata-transformer.js';

const project = new Project({ useInMemoryFileSystem: true });
let fileCounter = 0;

function run(snippet: string): string {
  const sf = project.createSourceFile(`snippet_${fileCounter++}.ts`, `const f = ${snippet};`, {
    overwrite: true,
  });
  const init = sf.getVariableDeclarationOrThrow('f').getInitializerOrThrow();
  if (isODataTaggedTemplate(init)) {
    return transformODataTaggedTemplate(init.asKindOrThrow(SyntaxKind.TaggedTemplateExpression));
  }
  assert.ok(isODataCall(init), `not recognized as odata call: ${snippet}`);
  return transformODataCall(init.asKindOrThrow(SyntaxKind.CallExpression));
}

/** snippet → expected OData string. */
const GOLDEN: Record<string, string> = {
  // builder calls — every ctx.odata.* method and nesting shape
  [`ctx.odata.eq('statecode', 0)`]: 'statecode eq 0',
  [`ctx.odata.eq('name', 'Contoso')`]: "name eq 'Contoso'",
  [`ctx.odata.ne('status', null)`]: 'status ne null',
  [`ctx.odata.gt('revenue', ctx.parameters('MinAmount'))`]: "revenue gt @{parameters('MinAmount')}",
  [`ctx.odata.lt('a', -26)`]: 'a lt -26',
  [`ctx.odata.ge('price', 1.50)`]: 'price ge 1.50',
  [`ctx.odata.le('a', true)`]: 'a le true',
  [`ctx.odata.ge('a', false)`]: 'a ge false',
  [`ctx.odata.and(ctx.odata.eq('a', 1), ctx.odata.eq('b', 2), ctx.odata.eq('c', 3))`]:
    'a eq 1 and b eq 2 and c eq 3',
  // inner or under and → parens
  [`ctx.odata.and(ctx.odata.or(ctx.odata.eq('a', 1), ctx.odata.eq('b', 2)), ctx.odata.eq('c', 3))`]:
    '(a eq 1 or b eq 2) and c eq 3',
  // same-op nesting → NO parens
  [`ctx.odata.or(ctx.odata.or(ctx.odata.eq('a', 1), ctx.odata.eq('b', 2)), ctx.odata.eq('c', 3))`]:
    'a eq 1 or b eq 2 or c eq 3',
  [`ctx.odata.not(ctx.odata.eq('a', 1))`]: 'not (a eq 1)',
  [`ctx.odata.not(ctx.odata.and(ctx.odata.eq('a', 1), ctx.odata.eq('b', 2)))`]:
    'not (a eq 1 and b eq 2)',
  [`ctx.odata.contains('name', 'x')`]: "contains(name, 'x')",
  [`ctx.odata.startsWith('name', 'x')`]: "startswith(name, 'x')",
  [`ctx.odata.endsWith('name', 'x')`]: "endswith(name, 'x')",
  [`ctx.odata.contains('name', ctx.variables('v'))`]: "contains(name, @{variables('v')})",
  [`ctx.odata.isNull('f')`]: 'f eq null',
  [`ctx.odata.isNotNull('f')`]: 'f ne null',
  [`ctx.odata.raw("Person/EMail eq 'x'")`]: "Person/EMail eq 'x'",
  [`ctx.odata.eq('f', ctx.body('Get')?.['value']?.[0]?.['id'])`]:
    "f eq @{body('Get')?['value']?[0]?['id']}",
  ["ctx.odata.eq('f', `${ctx.outputs('A')?.['x']}_suffix`)"]: "f eq '@{outputs('A')?['x']}_suffix'",
  // non-odata argument → getText() passthrough
  [`ctx.odata.and(ctx.odata.eq('a', 1), someVar)`]: 'a eq 1 and someVar',
  // OData '' escaping (legacy emitted invalid OData here)
  [`ctx.odata.eq('name', "O'Brien")`]: "name eq 'O''Brien'",

  // tagged templates (drawn from examples/odata-tagged-template)
  ['ctx.odata`statecode == 0 && statuscode != null`']: 'statecode eq 0 and statuscode ne null',
  ["ctx.odata`statecode == 0 && name == '${ctx.parameters('AccountName')}' && revenue > ${ctx.parameters('MinAmount')}`"]:
    "(statecode eq 0 and name eq '@{parameters('AccountName')}') and revenue gt @{parameters('MinAmount')}",
  ["ctx.odata`(statecode == 0 || statecode == 1) && (revenue >= ${ctx.parameters('MinAmount')} || customertype == 3)`"]:
    "(statecode eq 0 or statecode eq 1) and (revenue ge @{parameters('MinAmount')} or customertype eq 3)",
  ['ctx.odata`statecode == 0 && !(statuscode == 2)`']: 'statecode eq 0 and not (statuscode eq 2)',
  ["ctx.odata`_parentcustomerid_value == ${ctx.body('GetActiveAccounts')?.['value']?.[0]?.['accountid']}`"]:
    "_parentcustomerid_value eq @{body('GetActiveAccounts')?['value']?[0]?['accountid']}",
  // the tagged-template builder parenthesizes EVERY nested logical, even same-op
  ['ctx.odata`a == 1 && b == 2 && c == 3`']: '(a eq 1 and b eq 2) and c eq 3',
  ['ctx.odata`statecode == 0`']: 'statecode eq 0',
  // numeral raw text preserved (legacy printed 2.1)
  ["ctx.odata`price >= ${'1.50'} && qty > 2.10`"]: "price ge '1.50' and qty gt 2.10",
};

describe('odata transformer golden (TS → OData string)', () => {
  for (const [snippet, expected] of Object.entries(GOLDEN)) {
    it(snippet.length > 70 ? snippet.slice(0, 67) + '...' : snippet, () => {
      assert.equal(run(snippet), expected);
    });
  }
});
