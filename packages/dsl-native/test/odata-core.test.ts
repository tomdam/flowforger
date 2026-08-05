/**
 * Unit tests for the shared OData $filter grammar: lexer, recursive-descent
 * parser, and canonical printer (packages/dsl-native/src/odata/).
 *
 * The printer round-trip block is the load-bearing part: for canonical inputs,
 * parse → print must reproduce the input byte-for-byte, because the generator
 * direction relies on print-equality (via the real transformer) to decide
 * whether a filter may be emitted structurally instead of as ctx.odata.raw.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tokenizeOData, ODataLexError } from '../src/odata/lexer.js';
import { parseODataFilterString, ODataParseError } from '../src/odata/parser.js';
import { printFilter } from '../src/odata/printer.js';

describe('odata lexer', () => {
  it('tokenizes words, operators and numbers', () => {
    assert.deepEqual(tokenizeOData('statecode eq 0'), [
      { t: 'word', v: 'statecode', pos: 0 },
      { t: 'word', v: 'eq', pos: 10 },
      { t: 'number', raw: '0', pos: 13 },
    ]);
  });

  it("decodes '' escapes inside single-quoted strings", () => {
    const tokens = tokenizeOData("name eq 'O''Brien'");
    assert.deepEqual(tokens[2], {
      t: 'string',
      v: "O'Brien",
      raw: "'O''Brien'",
      hasTemplate: false,
      pos: 8,
    });
  });

  it('keeps @{...} templates inside strings intact (quotes inside do not end the string)', () => {
    const tokens = tokenizeOData("f eq '@{outputs('X')}'");
    assert.equal(tokens.length, 3);
    assert.equal(tokens[2].t, 'string');
    assert.equal((tokens[2] as any).hasTemplate, true);
    assert.equal((tokens[2] as any).raw, "'@{outputs('X')}'");
  });

  it('lexes standalone @{...} templates verbatim, including nested parens/quotes', () => {
    const tokens = tokenizeOData('createdon ge @{addHours(utcNow(), -26)}');
    assert.deepEqual(tokens[2], {
      t: 'template',
      raw: '@{addHours(utcNow(), -26)}',
      pos: 13,
    });
  });

  it('treats / and . as word characters (field paths, CRM function names)', () => {
    assert.deepEqual(tokenizeOData('Person/EMail')[0], { t: 'word', v: 'Person/EMail', pos: 0 });
    assert.deepEqual(tokenizeOData('Microsoft.Dynamics.CRM.In')[0], {
      t: 'word',
      v: 'Microsoft.Dynamics.CRM.In',
      pos: 0,
    });
  });

  it("keeps '@' inside strings and words when not starting a template", () => {
    const tokens = tokenizeOData("Person/EMail eq 'x@y.de'");
    assert.equal(tokens.length, 3);
    assert.equal((tokens[2] as any).v, 'x@y.de');
  });

  it('splits PropertyValues=@{...} into word then template', () => {
    const tokens = tokenizeOData("PropertyValues=@{string(variables('ids'))}");
    assert.deepEqual(tokens, [
      { t: 'word', v: 'PropertyValues=', pos: 0 },
      { t: 'template', raw: "@{string(variables('ids'))}", pos: 15 },
    ]);
  });

  it('classifies negative and decimal numerals, keeping raw text', () => {
    assert.deepEqual(tokenizeOData('-26')[0], { t: 'number', raw: '-26', pos: 0 });
    assert.deepEqual(tokenizeOData('1.50')[0], { t: 'number', raw: '1.50', pos: 0 });
    // date-like words are NOT numbers
    assert.equal(tokenizeOData('2023-08-30T00:00:00Z')[0].t, 'word');
  });

  it('throws ODataLexError on unterminated string / template', () => {
    assert.throws(() => tokenizeOData("f eq 'unterminated"), ODataLexError);
    assert.throws(() => tokenizeOData('f eq @{utcNow()'), ODataLexError);
  });
});

describe('odata parser', () => {
  it('parses a flat and-chain into one n-ary logical node', () => {
    const ast = parseODataFilterString('a eq 1 and b eq 2 and c eq 3');
    assert.equal(ast.kind, 'logical');
    assert.equal((ast as any).op, 'and');
    assert.equal((ast as any).operands.length, 3);
  });

  it('gives and higher precedence than or', () => {
    const ast = parseODataFilterString('a eq 1 or b eq 2 and c eq 3') as any;
    assert.equal(ast.kind, 'logical');
    assert.equal(ast.op, 'or');
    assert.equal(ast.operands.length, 2);
    assert.equal(ast.operands[0].kind, 'compare');
    assert.equal(ast.operands[1].kind, 'logical');
    assert.equal(ast.operands[1].op, 'and');
  });

  it('records explicit parens as group nodes', () => {
    const ast = parseODataFilterString('(a eq 1 or b eq 2) and c eq 3') as any;
    assert.equal(ast.op, 'and');
    assert.equal(ast.operands[0].kind, 'group');
    assert.equal(ast.operands[0].inner.op, 'or');
  });

  it('parses not, collapsing the printer-implied parens', () => {
    const ast = parseODataFilterString('not (a eq 1)') as any;
    assert.equal(ast.kind, 'not');
    assert.equal(ast.operand.kind, 'compare');
  });

  it('parses string functions case-insensitively with canonical names', () => {
    const ast = parseODataFilterString("Contains(name, 'x')") as any;
    assert.equal(ast.kind, 'func');
    assert.equal(ast.name, 'contains');
    assert.equal(ast.field, 'name');
    assert.deepEqual(ast.value, { kind: 'string', value: 'x' });
  });

  it('captures Microsoft.Dynamics.CRM.* calls as verbatim raw slices', () => {
    const src =
      "Microsoft.Dynamics.CRM.In(PropertyName='activityid',PropertyValues=@{string(variables('ids'))})";
    const ast = parseODataFilterString(src) as any;
    assert.equal(ast.kind, 'raw');
    assert.equal(ast.text, src);
  });

  it('parses value kinds: string, number, bool, null, template, bareword', () => {
    const val = (s: string) => (parseODataFilterString(s) as any).value;
    assert.deepEqual(val("f eq 'x'"), { kind: 'string', value: 'x' });
    assert.deepEqual(val('f eq 1.50'), { kind: 'number', raw: '1.50' });
    assert.deepEqual(val('f eq true'), { kind: 'bool', value: true });
    assert.deepEqual(val('f eq null'), { kind: 'null' });
    assert.deepEqual(val('f eq @{utcNow()}'), { kind: 'template', raw: '@{utcNow()}' });
    assert.deepEqual(val('f eq Active'), { kind: 'verbatim', text: 'Active' });
  });

  it('accepts a template as the field side', () => {
    const ast = parseODataFilterString("@{variables('F')} eq 1") as any;
    assert.equal(ast.kind, 'compare');
    assert.equal(ast.field, "@{variables('F')}");
  });

  it('accepts uppercase keywords and operators', () => {
    const ast = parseODataFilterString('a Eq 1 AND b NE 2') as any;
    assert.equal(ast.op, 'and');
    assert.equal(ast.operands[0].op, 'eq');
    assert.equal(ast.operands[1].op, 'ne');
  });

  it('throws on unsupported functions instead of guessing', () => {
    assert.throws(() => parseODataFilterString("substringof('x', name)"), ODataParseError);
  });

  it('throws on incomplete or trailing input', () => {
    assert.throws(() => parseODataFilterString('a eq'), ODataParseError);
    assert.throws(() => parseODataFilterString('a eq 1 b eq 2'), ODataParseError);
    assert.throws(() => parseODataFilterString('(a eq 1'), ODataParseError);
    assert.throws(() => parseODataFilterString(''), ODataParseError);
  });
});

describe('odata printer', () => {
  it('round-trips canonical filters byte-exactly (parse → print === input)', () => {
    const CANONICAL = [
      'statecode eq 0',
      'a eq 1 and b eq 2',
      'a eq 1 and b eq 2 and c eq 3',
      'a eq 1 or b eq 2 and c eq 3',
      '(a eq 1 or b eq 2) and c eq 3',
      'not (a eq 1)',
      "contains(name, 'x')",
      "startswith(name, 'x')",
      "endswith(name, 'x')",
      "name eq 'O''Brien'",
      'price gt 1.50',
      'a lt -26',
      'f eq true',
      'f ne null',
      "Person/EMail eq 'x@y.de'",
      '_parentcustomerid_value eq @{triggerBody()?[\'accountid\']}',
      'createdon ge @{addHours(utcNow(), -26)} and createdon le @{addHours(utcNow(), -2)}',
      "Microsoft.Dynamics.CRM.In(PropertyName='a',PropertyValues=@{string(variables('i'))})",
      'msdyn_opportunityresearchtopic eq 100000003',
    ];
    for (const s of CANONICAL) {
      assert.equal(printFilter(parseODataFilterString(s)), s, `round-trip failed for: ${s}`);
    }
  });
});
