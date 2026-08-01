import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transformCode } from '../src/transformer/index.js';
import { buildSourceMapFromDsl } from '../src/source-map-builder.js';
import {
  buildExpressionScope,
  dslExpressionToPA,
  evaluateDebugInput,
  dslStatementToNodes,
} from '../src/expression-scope.js';

const DSL = `
@Flow('ScopeTest')
class ScopeTest {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    /** @action Initialize_counter */
    let counter: number = 0;

    /** @action Initialize_highPriority */
    let highPriority: any[] = [];

    await ctx.compose('AllItems', ctx.triggerBody()?.['items']);

    /** @action ItemLoop @type foreach */
    for (const entry of ctx.outputs('AllItems') ?? []) {
      await ctx.compose('Current', entry?.['id']);
    }
  }
}
`;

describe('buildExpressionScope', () => {
  const ir = transformCode(DSL);
  const sourceMap = buildSourceMapFromDsl(DSL, ir);
  const scope = buildExpressionScope(DSL, ir, sourceMap);

  it('maps flow variable identifiers to their PA variable names', () => {
    assert.equal(scope.variables.get('counter'), 'counter');
    assert.equal(scope.variables.get('highPriority'), 'highPriority');
    assert.equal(scope.variables.size, 2);
  });

  it('maps loop variable identifiers to their foreach action names', () => {
    assert.equal(scope.loopVariables.get('entry'), 'ItemLoop');
  });
});

describe('dslExpressionToPA', () => {
  const ir = transformCode(DSL);
  const sourceMap = buildSourceMapFromDsl(DSL, ir);
  const scope = buildExpressionScope(DSL, ir, sourceMap);

  it('resolves flow variable identifiers', () => {
    assert.equal(dslExpressionToPA('counter', scope), "@variables('counter')");
  });

  it('resolves loop variable identifiers with property access', () => {
    assert.equal(dslExpressionToPA("entry?.['id']", scope), "@items('ItemLoop')?['id']");
  });

  it('passes ctx.* calls through the compiler transform', () => {
    assert.equal(dslExpressionToPA("ctx.outputs('AllItems')", scope), "@outputs('AllItems')");
  });

  it('transforms comparison operators', () => {
    assert.equal(
      dslExpressionToPA("entry?.['priority'] === 'high'", scope),
      "@equals(items('ItemLoop')?['priority'], 'high')",
    );
  });

  it('throws on unparseable input', () => {
    assert.throws(() => dslExpressionToPA('for (', scope));
  });

  it('throws on garbage the TS parser error-recovers', () => {
    assert.throws(() => dslExpressionToPA('%%%', scope));
  });
});

describe('evaluateDebugInput', () => {
  const ir = transformCode(DSL);
  const sourceMap = buildSourceMapFromDsl(DSL, ir);
  const scope = buildExpressionScope(DSL, ir, sourceMap);

  function makeCtx() {
    return {
      actions: new Map<string, { status: string; outputs?: any }>([
        ['AllItems', { status: 'Succeeded', outputs: [{ id: 7 }] }],
        ['Skipped_One', { status: 'Skipped' }],
      ]),
      variables: { counter: 41 } as Record<string, any>,
    };
  }
  // Fake engine: resolves variables('x') from ctx.variables, echoes anything else
  const evalFn = (expr: string, ctx: any) => {
    const m = expr.match(/^@variables\('([^']+)'\)$/);
    if (m) return ctx.variables[m[1]];
    return expr;
  };

  it('resolves bare identifiers through the DSL path', () => {
    const out = evaluateDebugInput('counter', scope, makeCtx() as any, evalFn);
    assert.equal(out.value, 41);
  });

  it('resolves quoted variable names directly', () => {
    assert.equal(evaluateDebugInput("'counter'", scope, makeCtx() as any, evalFn).value, 41);
    assert.equal(evaluateDebugInput("'counter", scope, makeCtx() as any, evalFn).value, 41);
  });

  it('resolves action names, quoted or bare', () => {
    assert.deepEqual(evaluateDebugInput('AllItems', scope, makeCtx() as any, evalFn).value, [{ id: 7 }]);
    assert.deepEqual(evaluateDebugInput("'AllItems'", scope, makeCtx() as any, evalFn).value, [{ id: 7 }]);
  });

  it('reports status for actions without outputs', () => {
    assert.match(evaluateDebugInput('Skipped_One', scope, makeCtx() as any, evalFn).result, /Skipped/);
  });

  it('sets error when the legacy path throws', () => {
    const out = evaluateDebugInput('counter === legacy', scope, makeCtx() as any, () => {
      throw new Error('bad expr');
    });
    assert.equal(out.error, 'bad expr');
    assert.match(out.result, /Error/);
  });

  it('passes @-prefixed input straight to the legacy path', () => {
    assert.equal(evaluateDebugInput("@variables('counter')", scope, makeCtx() as any, evalFn).value, 41);
  });
});

describe('dslStatementToNodes', () => {
  // Scope constructed by hand: dslStatementToNodes only reads the maps.
  // 'allItems' sanitized ↔ 'All Items' original exercises the rewrite path.
  const scope = {
    variables: new Map([
      ['counter', 'counter'],
      ['allItems', 'All Items'],
    ]),
    loopVariables: new Map<string, string>(),
  };

  it('transforms a connector call into a single connector node', () => {
    const res = dslStatementToNodes(
      "await ctx.connectors.sharepoint.GetItems('Peek', { siteId: 's', listId: 'l', top: 3 })",
      scope,
      new Set(),
    );
    assert.ok(res);
    assert.equal(res.nodes.length, 1);
    const node = res.nodes[0] as any;
    assert.equal(node.type, 'connector');
    assert.equal(node.connector, 'sharepoint');
    assert.equal(node.operation, 'GetItems');
    assert.equal(node.name, 'Peek');
    assert.equal(node.params.top, 3);
  });

  it('transforms an HTTP action', () => {
    const res = dslStatementToNodes(
      "await ctx.http('Ping', { url: 'https://example.com', method: 'GET' })",
      scope,
      new Set(),
    );
    assert.ok(res);
    const node = res.nodes[0] as any;
    assert.equal(node.type, 'action');
    assert.equal(node.kind, 'http');
    assert.equal(node.name, 'Ping');
  });

  it('transforms a compose statement', () => {
    const res = dslStatementToNodes("await ctx.compose('Note', { a: 1 })", scope, new Set());
    assert.ok(res);
    const node = res.nodes[0] as any;
    assert.equal(node.kind, 'compose');
    assert.equal(node.name, 'Note');
  });

  it('assignment to a known variable becomes setvariable with the original PA name', () => {
    const res = dslStatementToNodes('allItems = []', scope, new Set());
    assert.ok(res);
    const node = res.nodes[0] as any;
    assert.equal(node.kind, 'setvariable');
    assert.equal(node.inputs.name, 'All Items');
  });

  it('rewrites variable references inside params to the original PA name', () => {
    const res = dslStatementToNodes("await ctx.compose('N', allItems)", scope, new Set());
    assert.ok(res);
    assert.ok(JSON.stringify(res.nodes[0]).includes("variables('All Items')"));
  });

  it('assignment to an unknown variable becomes initializevariable', () => {
    const res = dslStatementToNodes('scratch = 5', scope, new Set());
    assert.ok(res);
    const node = res.nodes[0] as any;
    assert.equal(node.kind, 'initializevariable');
    assert.equal(node.inputs.variableName, 'scratch');
  });

  it('returns null for pure expressions', () => {
    assert.equal(dslStatementToNodes('counter', scope, new Set()), null);
    assert.equal(dslStatementToNodes('counter > 3', scope, new Set()), null);
    assert.equal(dslStatementToNodes("ctx.outputs('AllItems')", scope, new Set()), null);
  });

  it('dedupes action names against taken names', () => {
    const res = dslStatementToNodes(
      "await ctx.connectors.sharepoint.GetItems('Peek', { siteId: 's', listId: 'l' })",
      scope,
      new Set(['Peek']),
    );
    assert.ok(res);
    assert.equal(res.nodes[0].name, 'Peek_2');
  });

  it('works with a null scope (no session variables)', () => {
    const res = dslStatementToNodes("await ctx.compose('X', 1)", null, new Set());
    assert.ok(res);
    assert.equal(res.nodes[0].name, 'X');
  });

  it('throws on garbage input', () => {
    assert.throws(() => dslStatementToNodes('%%%', scope, new Set()));
  });

  it('surfaces the compiler error for statement-intent input that fails to transform', () => {
    // A malformed ctx.odata tagged template inside a connector param makes
    // the real transformCode throw (js-to-odata-parser tokenizer failure),
    // exercising the try/catch path rather than the empty-nodes path.
    assert.throws(
      () =>
        dslStatementToNodes(
          "await ctx.connectors.sharepoint.GetItems('Peek', { siteId: 's', listId: 'l', filter: ctx.odata`%%%` })",
          scope,
          new Set(),
        ),
      /Could not transform statement/,
    );
  });

  it('throws (not null) for statement-intent input that transforms to zero nodes', () => {
    // An awaited call to a method the transformer doesn't recognize compiles
    // cleanly but yields no action node — statement-intent input must still
    // surface as an error here, not be treated as a pure expression.
    assert.throws(
      () => dslStatementToNodes("await ctx.nonExistentMethod('X', {})", scope, new Set()),
      /Could not transform statement/,
    );
  });
});

// Power Automate variable names are case-insensitive: a console assignment or
// read typed with different casing must resolve to the existing variable, not
// silently create/read a duplicate (which the flow's own expressions never see).
describe('case-insensitive variable resolution (PA semantics)', () => {
  const scope = {
    variables: new Map([
      ['MyVar', 'MyVar'],
      ['Order_Count', 'Order Count'],
    ]),
    loopVariables: new Map<string, string>(),
  };

  it('case-variant assignment resolves to the existing variable as setvariable', () => {
    const res = dslStatementToNodes("myvar = 'NEW'", scope, new Set());
    assert.ok(res);
    const node = res.nodes[0] as any;
    assert.equal(node.kind, 'setvariable');
    assert.equal(node.inputs.name, 'MyVar');
  });

  it('case-variant assignment to a name-mismatched variable uses the original PA name', () => {
    const res = dslStatementToNodes('order_count = 1', scope, new Set());
    assert.ok(res);
    const node = res.nodes[0] as any;
    assert.equal(node.kind, 'setvariable');
    assert.equal(node.inputs.name, 'Order Count');
  });

  it('truly unknown assignment still initializes a new variable', () => {
    const res = dslStatementToNodes('brandNew = 1', scope, new Set());
    assert.ok(res);
    const node = res.nodes[0] as any;
    assert.equal(node.kind, 'initializevariable');
    assert.equal(node.inputs.variableName, 'brandNew');
  });

  it('exact-case assignment behavior is unchanged', () => {
    const res = dslStatementToNodes('MyVar = 2', scope, new Set());
    assert.ok(res);
    const node = res.nodes[0] as any;
    assert.equal(node.kind, 'setvariable');
    assert.equal(node.inputs.name, 'MyVar');
  });

  const fakeEvalFn = (variables: Record<string, unknown>) => (expr: string) => {
    const m = expr.match(/^@variables\('(.+)'\)$/);
    if (!m || !(m[1] in variables)) throw new Error(`no variable ${expr}`);
    return variables[m[1]];
  };

  it('bare case-variant name reads the canonical variable', () => {
    const ctx = { actions: new Map(), variables: { MyVar: 'X' } } as any;
    const out = evaluateDebugInput('myvar', scope, ctx, fakeEvalFn(ctx.variables));
    assert.equal(out.value, 'X');
  });

  it('bare sanitized identifier of a name-mismatched variable still reads its PA variable', () => {
    const ctx = { actions: new Map(), variables: { 'Order Count': 7 } } as any;
    const out = evaluateDebugInput('ORDER_COUNT', scope, ctx, fakeEvalFn(ctx.variables));
    assert.equal(out.value, 7);
  });
});
