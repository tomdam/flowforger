import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { transformCode, buildSourceMapFromDsl } from '@flowforger/dsl-native';
import { FlowForgerDebugRunner } from '../debug-runner.js';

const DSL = `
@Flow('EvalTest')
class EvalTest {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    /** @action Initialize_counter */
    let counter: number = 41;

    await ctx.compose('AllItems', ctx.triggerBody()?.['items']);

    await ctx.compose('Done', 'done');
  }
}
`;

// The runner reads the source file from disk to build the expression scope.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, 'fixtures', 'eval-test.ff.ts');

function createHarness() {
  const stops: Array<{ reason: string; nodeId: string }> = [];
  let stopWaiters: Array<(s: { reason: string; nodeId: string }) => void> = [];
  let terminatedWaiters: Array<() => void> = [];
  let terminated = false;
  return {
    stops,
    callbacks: {
      onStopped: (reason: string, nodeId: string) => {
        const evt = { reason, nodeId };
        stops.push(evt);
        const w = stopWaiters;
        stopWaiters = [];
        for (const r of w) r(evt);
      },
      onOutput: () => {},
      onTerminated: () => {
        terminated = true;
        const w = terminatedWaiters;
        terminatedWaiters = [];
        for (const r of w) r();
      },
    },
    nextStop: () =>
      new Promise<{ reason: string; nodeId: string }>((res) => stopWaiters.push(res)),
    untilTerminated: () =>
      new Promise<void>((res) => (terminated ? res() : terminatedWaiters.push(res))),
  };
}

describe('debug runner DSL expression evaluation', () => {
  before(() => {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, DSL, 'utf-8');
  });
  after(() => {
    fs.rmSync(path.dirname(FIXTURE), { recursive: true, force: true });
  });

  it('evaluates DSL identifiers, ctx calls, and falls back to PA syntax', async () => {
    const ir = transformCode(DSL);
    const sourceMap = buildSourceMapFromDsl(DSL, ir);
    const harness = createHarness();
    const runner = new FlowForgerDebugRunner(
      ir,
      sourceMap,
      FIXTURE,
      { items: [{ id: 7 }] },
      {},
      true /* stopOnEntry */,
      {},
      harness.callbacks,
    );

    const firstStop = harness.nextStop();
    void runner.start();
    await firstStop; // paused on Initialize_counter

    // Step until Done so counter and AllItems exist
    const stopAtCompose = harness.nextStop();
    runner.resume('step'); // executes Initialize_counter, pauses on AllItems compose
    await stopAtCompose;
    const stopAtDone = harness.nextStop();
    runner.resume('step'); // executes AllItems, pauses on Done
    await stopAtDone;

    // DSL: bare flow-variable identifier
    assert.equal(runner.evaluate('counter').value, 41);
    // DSL: ctx call
    assert.deepEqual(runner.evaluate("ctx.outputs('AllItems')").value, [{ id: 7 }]);
    // DSL: expression with operator
    assert.equal(runner.evaluate('counter === 41').value, true);
    // Legacy PA syntax still works, with and without @
    assert.equal(runner.evaluate("@variables('counter')").value, 41);
    assert.equal(runner.evaluate("variables('counter')").value, 41);
    // Nonsense must not crash; the engine echoes unparseable input verbatim
    // (pre-existing legacy behavior, preserved by the DSL-path fallback)
    assert.equal(runner.evaluate('%%%').result, '@%%%');

    // Action-name resolution: hovering an action name shows its output.
    // VS Code's hover word range includes quotes — sometimes unbalanced.
    assert.deepEqual(runner.evaluate("'AllItems'").value, [{ id: 7 }]);
    assert.deepEqual(runner.evaluate("'AllItems").value, [{ id: 7 }]);
    assert.deepEqual(runner.evaluate('AllItems').value, [{ id: 7 }]);
    // Flow variables keep precedence over any same-named action
    assert.equal(runner.evaluate('counter').value, 41);
    // Unknown quoted names still fall through to the legacy echo, not a crash
    assert.equal(runner.evaluate("'NoSuchAction'").result, "@'NoSuchAction'");

    // Quoted variable names resolve too — hover over the string inside
    // ctx.variables('counter') sends 'counter (often with unbalanced quote)
    assert.equal(runner.evaluate("'counter'").value, 41);
    assert.equal(runner.evaluate("'counter").value, 41);

    runner.resume('continue');
    await harness.untilTerminated();
  });
});
