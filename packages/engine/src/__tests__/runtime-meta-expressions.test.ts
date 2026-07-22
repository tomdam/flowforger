import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evalExpression } from '../expressions.js';
import { run, type RunContext, type CurrentActionInfo, type IterationFrame, type ScopedActionResult } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

function makeContext(opts: {
  actions?: Record<string, any>;
  currentAction?: CurrentActionInfo;
  iterationStack?: IterationFrame[];
  scopeResults?: Record<string, ScopedActionResult[]>;
} = {}): RunContext {
  const actions = new Map<string, any>();
  for (const [k, v] of Object.entries(opts.actions ?? {})) {
    actions.set(k, { status: 'Succeeded', outputs: v });
  }
  return {
    variables: {},
    actions,
    triggerData: {},
    workflowName: 'test',
    parameters: {},
    iterationStack: opts.iterationStack ?? [],
    iterationInfo: opts.iterationStack?.[opts.iterationStack.length - 1],
    currentAction: opts.currentAction,
    scopeResults: new Map(Object.entries(opts.scopeResults ?? {})),
    now: () => new Date('2026-01-01T00:00:00Z'),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: () => {},
    secrets: () => undefined,
    connector: () => { throw new Error('no connector'); },
  };
}

describe('listCallbackUrl', () => {
  it('returns the configured callbackUrl', () => {
    const ctx = makeContext({});
    ctx.callbackUrl = 'https://example.flow.microsoft.com/triggers/manual/run?sig=abc';
    assert.equal(
      evalExpression(`@listCallbackUrl()`, ctx),
      'https://example.flow.microsoft.com/triggers/manual/run?sig=abc',
    );
  });

  it('returns empty string when callbackUrl is unset', () => {
    const ctx = makeContext({});
    assert.equal(evalExpression(`@listCallbackUrl()`, ctx), '');
  });

  it('passes through RunOptions.callbackUrl into ctx via run()', async () => {
    const flow: FlowIR = {
      name: 'callback-test',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'POST' } } as any,
        {
          id: 'act_1',
          name: 'EmitUrl',
          type: 'action',
          kind: 'compose',
          inputs: { value: '@listCallbackUrl()' },
        } as any,
      ],
    };
    const result = await run(flow, { callbackUrl: 'https://x.example/cb' });
    assert.equal(result.status, 'Succeeded');
    const step = result.trace.find(t => t.name === 'EmitUrl');
    assert.equal(step?.outputs, 'https://x.example/cb');
  });
});

describe('actionBody — alias for body()', () => {
  it('reads outputs.body when present', () => {
    const ctx = makeContext({ actions: { Fetch: { body: { name: 'alice' } } } });
    assert.deepEqual(evalExpression(`@actionBody('Fetch')`, ctx), { name: 'alice' });
  });

  it('navigates into the body via dot path', () => {
    const ctx = makeContext({ actions: { Fetch: { body: { user: { id: 42 } } } } });
    assert.equal(evalExpression(`@actionBody('Fetch').user.id`, ctx), 42);
  });

  it('returns outputs directly when no body wrapper (Compose)', () => {
    const ctx = makeContext({ actions: { Compose: { foo: 'bar' } } });
    assert.equal(evalExpression(`@actionBody('Compose').foo`, ctx), 'bar');
  });
});

describe('action() — current action metadata', () => {
  it('returns the entire record as object', () => {
    const ctx = makeContext({
      currentAction: { name: 'Foo', inputs: { a: 1 }, startTime: '2026-01-01T00:00:00Z' },
      actions: { Foo: { result: 'ok' } },
    });
    const r = evalExpression(`@action()`, ctx);
    assert.equal(r.name, 'Foo');
    assert.deepEqual(r.inputs, { a: 1 });
    assert.equal(r.status, 'Succeeded');
    assert.deepEqual(r.outputs, { result: 'ok' });
  });

  it('navigates into outputs', () => {
    const ctx = makeContext({
      currentAction: { name: 'Foo' },
      actions: { Foo: { body: { user: 'bob' } } },
    });
    assert.equal(evalExpression(`@action().outputs.body.user`, ctx), 'bob');
  });

  it('returns undefined when no current action is set', () => {
    const ctx = makeContext({});
    assert.equal(evalExpression(`@action()`, ctx), undefined);
  });

  it('reflects status from ctx.actions even after currentAction was set without it', () => {
    // currentAction is set at action start; status comes from ctx.actions after completion.
    const ctx = makeContext({
      currentAction: { name: 'Risky' },
      actions: {},
    });
    ctx.actions.set('Risky', { status: 'Failed', error: new Error('boom') });
    const r = evalExpression(`@action()`, ctx);
    assert.equal(r.status, 'Failed');
  });
});

describe('iterationIndexes — direct context manipulation', () => {
  it('returns the index of a named loop on the stack', () => {
    const ctx = makeContext({
      iterationStack: [{ loopName: 'OuterLoop', index: 2 }, { loopName: 'InnerLoop', index: 5, item: 'x' }],
    });
    assert.equal(evalExpression(`@iterationIndexes('OuterLoop')`, ctx), 2);
    assert.equal(evalExpression(`@iterationIndexes('InnerLoop')`, ctx), 5);
  });

  it('returns undefined when no matching loop is on the stack', () => {
    const ctx = makeContext({ iterationStack: [{ loopName: 'A', index: 0 }] });
    assert.equal(evalExpression(`@iterationIndexes('B')`, ctx), undefined);
  });

  it('returns undefined when stack is empty', () => {
    const ctx = makeContext({});
    assert.equal(evalExpression(`@iterationIndexes('Anything')`, ctx), undefined);
  });
});

describe('iterationIndexes — via real foreach run()', () => {
  it('is correctly populated inside a foreach iteration', async () => {
    const flow: FlowIR = {
      name: 'iter-test',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        {
          id: 'fe_1',
          name: 'OuterLoop',
          type: 'foreach',
          itemsExpression: "@createArray('a', 'b', 'c')",
          actions: [
            {
              id: 'act_1',
              name: 'Capture',
              type: 'action',
              kind: 'compose',
              inputs: { value: "@iterationIndexes('OuterLoop')" },
            } as any,
          ],
        } as any,
      ],
    };

    const result = await run(flow);
    assert.equal(result.status, 'Succeeded');
    const iter = result.trace.find(t => t.name === 'OuterLoop');
    assert.ok(iter?.iterations);
    // Compose returns outputs = the evaluated `value` directly
    assert.equal(iter.iterations[0].actions[0].outputs, 0);
    assert.equal(iter.iterations[1].actions[0].outputs, 1);
    assert.equal(iter.iterations[2].actions[0].outputs, 2);
  });

  it('finds outer loop index from inside a nested foreach', async () => {
    const flow: FlowIR = {
      name: 'nested-iter',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        {
          id: 'fe_outer',
          name: 'Outer',
          type: 'foreach',
          itemsExpression: "@createArray('a', 'b')",
          actions: [
            {
              id: 'fe_inner',
              name: 'Inner',
              type: 'foreach',
              itemsExpression: "@createArray(1, 2)",
              actions: [
                {
                  id: 'act_1',
                  name: 'CaptureBoth',
                  type: 'action',
                  kind: 'compose',
                  inputs: {
                    value: {
                      outer: "@iterationIndexes('Outer')",
                      inner: "@iterationIndexes('Inner')",
                    },
                  },
                } as any,
              ],
            } as any,
          ],
        } as any,
      ],
    };

    const result = await run(flow);
    assert.equal(result.status, 'Succeeded');
    // Verify the nested compose at outer=1, inner=1 captured both indexes correctly
    const outer = result.trace.find(t => t.name === 'Outer');
    const innerIter1Of2 = outer?.iterations?.[1].actions[0]; // outer=1
    const innerActionRun1 = innerIter1Of2?.iterations?.[1].actions[0]; // inner=1
    assert.equal(innerActionRun1?.outputs.outer, 1);
    assert.equal(innerActionRun1?.outputs.inner, 1);
  });
});

describe('result — direct context manipulation', () => {
  it('returns the array of accumulated child results for a scope', () => {
    const ctx = makeContext({
      scopeResults: {
        MyScope: [
          { name: 'A', status: 'Succeeded', outputs: { x: 1 } },
          { name: 'B', status: 'Succeeded', outputs: { x: 2 } },
        ],
      },
    });
    const r = evalExpression(`@result('MyScope')`, ctx);
    assert.equal(r.length, 2);
    assert.deepEqual(r[0].outputs, { x: 1 });
    assert.equal(r[1].name, 'B');
  });

  it('returns empty array for unknown scope', () => {
    const ctx = makeContext({});
    assert.deepEqual(evalExpression(`@result('Unknown')`, ctx), []);
  });
});

describe('result — via real run() of a Scope', () => {
  it('collects child action results from a scope', async () => {
    const flow: FlowIR = {
      name: 'scope-result-test',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        {
          id: 'scp_1',
          name: 'WorkScope',
          type: 'scope',
          actions: [
            { id: 'act_1', name: 'StepOne', type: 'action', kind: 'compose', inputs: { value: 'first' } } as any,
            { id: 'act_2', name: 'StepTwo', type: 'action', kind: 'compose', inputs: { value: 'second' } } as any,
          ],
        } as any,
        {
          id: 'act_3',
          name: 'CountResults',
          type: 'action',
          kind: 'compose',
          inputs: { value: "@length(result('WorkScope'))" },
        } as any,
      ],
    };

    const result = await run(flow);
    assert.equal(result.status, 'Succeeded');
    const count = result.trace.find(t => t.name === 'CountResults');
    assert.equal(count?.outputs, 2);
  });

  it('accumulates child results across foreach iterations', async () => {
    const flow: FlowIR = {
      name: 'foreach-result-test',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        {
          id: 'fe_1',
          name: 'Loop',
          type: 'foreach',
          itemsExpression: "@createArray(10, 20, 30)",
          actions: [
            { id: 'act_1', name: 'Square', type: 'action', kind: 'compose', inputs: { value: "@items('Loop')" } } as any,
          ],
        } as any,
        {
          id: 'act_2',
          name: 'CountAll',
          type: 'action',
          kind: 'compose',
          inputs: { value: "@length(result('Loop'))" },
        } as any,
      ],
    };

    const result = await run(flow);
    assert.equal(result.status, 'Succeeded');
    const count = result.trace.find(t => t.name === 'CountAll');
    // 3 iterations * 1 child action = 3 accumulated results
    assert.equal(count?.outputs, 3);
  });
});
