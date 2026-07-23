import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transformCode } from '../src/transformer/index.js';
import { buildSourceMapFromDsl } from '../src/source-map-builder.js';
import { buildExpressionScope, dslExpressionToPA, evaluateDebugInput } from '../src/expression-scope.js';

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
