/**
 * Golden + invariant tests for the generator direction (OData $filter string
 * → ctx.odata.* builder code) — parseODataFilter in
 * src/generator/odata-parser.ts.
 *
 * Two layers:
 *  1. Curated golden corpus — one row per parser production, per raw-fallback
 *     guard, and per real-world pattern class found in tmp/** flows.
 *  2. The round-trip invariant over the curated corpus PLUS a live harvest of
 *     every "$filter" string in tmp/** and examples/** (skipped silently when
 *     absent): whatever parseODataFilter emits must reproduce the source
 *     filter byte-for-byte when fed through the production transformer. This
 *     is the exact operation the DSL→IR transform performs later, so passing
 *     here guarantees JSON round-trip parity.
 *
 * History: born as a differential test against the legacy regex/string-split
 * implementation (odata-parser-legacy.ts, since deleted). All rows were
 * byte-identical to legacy output except these, where legacy emitted
 * structured code that demonstrably did NOT round-trip (verified against the
 * transformer at migration time):
 *  - "msdyn_id eq @{triggerBody()?.['x']}" — old-emitter '?.[' templates were
 *    silently rewritten to '?[' on round-trip → now raw
 *  - "a eq 1 or b eq 2 and c eq 3" — legacy flattened mixed and/or under ONE
 *    operator, dropping precedence semantics → now raw
 *  - "a eq 1 and (b eq 2)" — legacy dropped redundant parens → now raw
 *  - "status eq Active" — legacy re-quoted unquoted barewords → now raw
 *  - "a eq 1 and not (b eq 2)" — legacy silently DROPPED mid-filter not →
 *    now structured ctx.odata.not
 *  - "price gt 1.50" — legacy printed 1.5 (parseFloat) → now structured with
 *    the source numeral preserved
 *  - "a eq 1  and b eq 2" — legacy collapsed interior double spaces → now raw
 *
 * Note: filters starting with '@' never reach parseODataFilter — the single
 * call site (generator.ts formatValue) routes them to the expression parser
 * instead. The harvest mirrors that precondition.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';
import { parseODataFilter } from '../src/generator/odata-parser.js';
import { isODataCall, transformODataCall } from '../src/transformer/odata-transformer.js';

// ---------------------------------------------------------------------------
// Round-trip oracle: emitted code → (production transformer) → OData string
// ---------------------------------------------------------------------------

const project = new Project({ useInMemoryFileSystem: true });

function renderBack(code: string): string | null {
  try {
    const sf = project.createSourceFile('__verify__.ts', `const f = ${code};`, { overwrite: true });
    const init = sf.getVariableDeclarationOrThrow('f').getInitializerOrThrow();
    if (!isODataCall(init)) return null;
    return transformODataCall(init.asKindOrThrow(SyntaxKind.CallExpression));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Curated golden corpus: filter → expected ctx.odata.* code
// ---------------------------------------------------------------------------

const GOLDEN: Record<string, string> = {
  // comparisons, every operator and value kind
  'statecode eq 0': 'ctx.odata.eq("statecode", 0)',
  'statecode ne 1': 'ctx.odata.ne("statecode", 1)',
  'revenue gt 1000': 'ctx.odata.gt("revenue", 1000)',
  'revenue ge 100': 'ctx.odata.ge("revenue", 100)',
  'revenue lt -26': 'ctx.odata.lt("revenue", -26)',
  'revenue le 99': 'ctx.odata.le("revenue", 99)',
  "name eq 'Contoso'": 'ctx.odata.eq("name", "Contoso")',
  'active eq true': 'ctx.odata.eq("active", true)',
  'active eq false': 'ctx.odata.eq("active", false)',
  'parent eq null': 'ctx.odata.eq("parent", null)',
  'msdyn_opportunityresearchtopic eq 100000003':
    'ctx.odata.eq("msdyn_opportunityresearchtopic", 100000003)',
  "_low_value eq 'abc'": 'ctx.odata.eq("_low_value", "abc")',
  // decimal numerals keep their source text (legacy printed 1.5)
  'price gt 1.50': 'ctx.odata.gt("price", 1.50)',
  // and/or chains
  'a eq 1 and b eq 2':
    'ctx.odata.and(\n        ctx.odata.eq("a", 1),\n        ctx.odata.eq("b", 2)\n      )',
  'a eq 1 and b eq 2 and c eq 3':
    'ctx.odata.and(\n        ctx.odata.eq("a", 1),\n        ctx.odata.eq("b", 2),\n        ctx.odata.eq("c", 3)\n      )',
  'a eq 1 or b eq 2':
    'ctx.odata.or(\n        ctx.odata.eq("a", 1),\n        ctx.odata.eq("b", 2)\n      )',
  // mid-filter not (legacy silently dropped the operator)
  'a eq 1 and not (b eq 2)':
    'ctx.odata.and(\n        ctx.odata.eq("a", 1),\n        ctx.odata.not(ctx.odata.eq("b", 2))\n      )',
  // string functions
  "contains(name, 'x')": 'ctx.odata.contains("name", "x")',
  "startswith(name, 'x')": 'ctx.odata.startsWith("name", "x")',
  "endswith(name, 'x')": 'ctx.odata.endsWith("name", "x")',
  // unquoted PA template values (real corpus pattern, canonical spacing)
  'createdon ge @{addHours(utcNow(), -26)} and createdon le @{addHours(utcNow(), -2)}':
    'ctx.odata.and(\n        ctx.odata.ge("createdon", ctx.braced(ctx.addHours(ctx.utcNow(), -26))),\n        ctx.odata.le("createdon", ctx.braced(ctx.addHours(ctx.utcNow(), -2)))\n      )',
  "statuscode eq @{parameters('Status')}":
    "ctx.odata.eq(\"statuscode\", ctx.braced(ctx.parameters('Status')))",
  // quoted template with suffix → template-literal emission
  "FileLeafRef eq '@{variables('ExportId')}.zip'":
    'ctx.odata.eq("FileLeafRef", `${ctx.variables(\'ExportId\')}.zip`)',
  // Microsoft.Dynamics.CRM.* raw calls (real corpus pattern)
  "Microsoft.Dynamics.CRM.In(PropertyName='activityid',PropertyValues=@{string(variables('activityIds'))})":
    'ctx.odata.raw("Microsoft.Dynamics.CRM.In(PropertyName=\'activityid\',PropertyValues=@{string(variables(\'activityIds\'))})")',

  // guard-triggered raw fallbacks
  "(Status eq 'Rejected') and (Time lt '@{utcNow()}')":
    'ctx.odata.raw("(Status eq \'Rejected\') and (Time lt \'@{utcNow()}\')")', // hasParenthesizedConditions
  "Person/EMail eq '@{triggerOutputs()?['body/Person/Email']}'":
    "ctx.odata.raw(\"Person/EMail eq '@{triggerOutputs()?['body/Person/Email']}'\")", // hasQuotedExpressions
  "_brk_buchung_value eq '@{items('ForEach_X')?['_brk_buchung_value']}'":
    "ctx.odata.raw(\"_brk_buchung_value eq '@{items('ForEach_X')?['_brk_buchung_value']}'\")",
  'statecode eq 0 ': 'ctx.odata.raw("statecode eq 0 ")', // hasSignificantWhitespace
  "substringof('x', name)": 'ctx.odata.raw("substringof(\'x\', name)")', // hasUnsupportedFunction
  'not (a eq 1)': 'ctx.odata.raw("not (a eq 1)")', // hasUnsupportedFunction (leading not)
  "a eq 1 and @{variables('extra')}":
    'ctx.odata.raw("a eq 1 and @{variables(\'extra\')}")', // hasTemplateAfterAndOr
  "doc eq 'CMDS_@{variables('id')}'":
    'ctx.odata.raw("doc eq \'CMDS_@{variables(\'id\')}\'")', // hasTemplateInsideStringWithPrefix
  "@{variables('X')}AH_ID eq '1'":
    'ctx.odata.raw("@{variables(\'X\')}AH_ID eq \'1\'")', // hasTemplateFollowedByLetter
  "name eq @{concat('a', 'b')}":
    'ctx.odata.raw("name eq @{concat(\'a\', \'b\')}")', // hasTranslatableTemplate
  'createdon ge 2023-08-30T00:00:00Z':
    'ctx.odata.raw("createdon ge 2023-08-30T00:00:00Z")', // hasUnquotedDate
  "startswith(name,'x')": 'ctx.odata.raw("startswith(name,\'x\')")', // hasNoSpaceCommaInFunc
  "name eq 'O'Brien'": 'ctx.odata.raw("name eq \'O\'Brien\'")', // hasUnbalancedSingleQuotes
  '( a eq 1 )': 'ctx.odata.raw("( a eq 1 )")', // hasNonCanonicalParenWhitespace

  // verifier-triggered raw fallbacks (no guard fires; the round-trip check does)
  "msdyn_id eq @{triggerBody()?.['macroagentorchestrationid']}":
    "ctx.odata.raw(\"msdyn_id eq @{triggerBody()?.['macroagentorchestrationid']}\")", // '?.[' old-emitter form
  'a eq 1 or b eq 2 and c eq 3': 'ctx.odata.raw("a eq 1 or b eq 2 and c eq 3")', // mixed and/or, no parens
  'a eq 1 and (b eq 2)': 'ctx.odata.raw("a eq 1 and (b eq 2)")', // redundant parens
  'status eq Active': 'ctx.odata.raw("status eq Active")', // unquoted bareword value
  'a eq 1  and b eq 2': 'ctx.odata.raw("a eq 1  and b eq 2")', // interior double space

  // malformed / exotic → parse errors → raw
  'a eq': 'ctx.odata.raw("a eq")',
  'and and and': 'ctx.odata.raw("and and and")',
  "name eq 'unterminated": 'ctx.odata.raw("name eq \'unterminated")',
};

describe('odata generator golden (OData string → ctx.odata.* code)', () => {
  for (const [filter, expected] of Object.entries(GOLDEN)) {
    it(filter.length > 70 ? filter.slice(0, 67) + '...' : filter, () => {
      assert.equal(parseODataFilter(filter), expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Round-trip invariant over curated + live corpus
// ---------------------------------------------------------------------------

function collectFilters(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectFilters(v, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === '$filter' && typeof v === 'string') out.add(v);
      collectFilters(v, out);
    }
  }
}

function harvest(root: string, out: Set<string>): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      harvest(p, out);
    } else if (entry.name.endsWith('.json')) {
      try {
        collectFilters(JSON.parse(readFileSync(p, 'utf8')), out);
      } catch {
        // unparseable JSON — skip
      }
    }
  }
}

describe('odata generator round-trip invariant (curated + live corpus)', () => {
  const filters = new Set<string>(Object.keys(GOLDEN));
  const repoRoot = resolve(import.meta.dirname, '../../..');
  harvest(join(repoRoot, 'tmp'), filters);
  harvest(join(repoRoot, 'examples'), filters);
  // Mirror the generator.ts call-site precondition: '@'-prefixed filters are
  // routed to the expression parser, never to parseODataFilter.
  const inDomain = [...filters].filter(f => !f.startsWith('@'));

  it(`every emission round-trips byte-exactly (${inDomain.length} filters)`, () => {
    const failures: string[] = [];
    for (const filter of inDomain) {
      const code = parseODataFilter(filter);
      if (code === '""') continue; // empty-filter emission
      const back = renderBack(code);
      if (back !== filter) {
        failures.push(`filter:   ${filter}\nemitted:  ${code}\nrendered: ${back}`);
      }
    }
    assert.equal(failures.length, 0, `\n${failures.join('\n---\n')}`);
  });
});
