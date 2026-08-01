import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, type BaseConnector, type RunContext } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

/**
 * Connector that fails for the operations named in `failOn` and succeeds
 * otherwise. Lets a single flow exercise both the failure and success path of
 * a try/catch without swapping connectors between runs.
 */
class SelectiveConnector implements BaseConnector {
  readonly seen: string[] = [];
  constructor(private readonly failOn: Set<string> = new Set()) {}
  async invoke(operation: string, _inputs: any, _ctx: RunContext): Promise<any> {
    this.seen.push(operation);
    if (this.failOn.has(operation)) throw new Error(`${operation} exploded`);
    return { ok: true };
  }
}

const TRIGGER = { id: 'trg_1', name: 'manual', type: 'trigger', inputs: {} } as any;

const compose = (id: string, name: string, value: unknown, runAfter?: Record<string, string[]>) =>
  ({ id, name, type: 'action', kind: 'compose', inputs: { value }, ...(runAfter ? { runAfter } : {}) }) as any;

const statusOf = (trace: any[], name: string) => trace.find(t => t.name === name)?.status;

describe('runAfter with multiple dependencies', () => {
  it('skips the action when only some dependencies match their accepted statuses', async () => {
    // Gate is Skipped (its own runAfter is unmet), so After — which requires
    // BOTH First and Gate to have Succeeded — must not run.
    const flow: FlowIR = {
      name: 'partial-match',
      nodes: [
        TRIGGER,
        compose('act_1', 'First', 'one'),
        compose('act_2', 'Gate', 'two', { First: ['Failed'] }),
        compose('act_3', 'After', 'three', { First: ['Succeeded'], Gate: ['Succeeded'] }),
      ],
    };

    const result = await run(flow);

    assert.equal(statusOf(result.trace, 'First'), 'Succeeded');
    assert.equal(statusOf(result.trace, 'Gate'), 'Skipped');
    assert.equal(statusOf(result.trace, 'After'), 'Skipped');
  });

  it('runs the action when every dependency matches an accepted status', async () => {
    const flow: FlowIR = {
      name: 'full-match',
      nodes: [
        TRIGGER,
        compose('act_1', 'First', 'one'),
        compose('act_2', 'Second', 'two'),
        compose('act_3', 'After', 'three', { First: ['Succeeded'], Second: ['Succeeded'] }),
      ],
    };

    const result = await run(flow);

    assert.equal(statusOf(result.trace, 'After'), 'Succeeded');
  });

  it('applies the same all-must-match rule inside a parallel foreach iteration', async () => {
    const flow: FlowIR = {
      name: 'parallel-foreach-partial-match',
      nodes: [
        TRIGGER,
        {
          id: 'fe_1',
          name: 'Loop',
          type: 'foreach',
          parallel: true,
          runtimeConfiguration: { concurrency: { repetitions: 2 } },
          itemsExpression: '@createArray(1)',
          actions: [
            compose('act_1', 'First', 'one'),
            compose('act_2', 'Gate', 'two', { First: ['Failed'] }),
            compose('act_3', 'After', 'three', { First: ['Succeeded'], Gate: ['Succeeded'] }),
          ],
        } as any,
      ],
    };

    const result = await run(flow);

    const iteration = result.trace.find(t => t.name === 'Loop')?.iterations?.[0];
    assert.ok(iteration, 'expected one recorded iteration');
    assert.equal(iteration.actions.find((a: any) => a.name === 'Gate')?.status, 'Skipped');
    assert.equal(iteration.actions.find((a: any) => a.name === 'After')?.status, 'Skipped');
  });

  it('applies the same all-must-match rule to actions nested in a scope', async () => {
    const flow: FlowIR = {
      name: 'nested-partial-match',
      nodes: [
        TRIGGER,
        {
          id: 'scp_1',
          name: 'Outer',
          type: 'scope',
          actions: [
            compose('act_1', 'First', 'one'),
            compose('act_2', 'Gate', 'two', { First: ['Failed'] }),
            compose('act_3', 'After', 'three', { First: ['Succeeded'], Gate: ['Succeeded'] }),
          ],
        } as any,
      ],
    };

    const result = await run(flow);

    assert.equal(statusOf(result.trace, 'Gate'), 'Skipped');
    assert.equal(statusOf(result.trace, 'After'), 'Skipped');
  });
});

describe('try/catch via runAfter', () => {
  it('marks the scope Failed and runs the catch scope when a child action throws', async () => {
    const connector = new SelectiveConnector(new Set(['Risky']));
    const flow: FlowIR = {
      name: 'catch-fires',
      nodes: [
        TRIGGER,
        {
          id: 'scp_1',
          name: 'TryBlock',
          type: 'scope',
          actions: [
            { id: 'con_1', name: 'RiskyCall', type: 'connector', connector: 'spy', operation: 'Risky', params: {} } as any,
          ],
        } as any,
        {
          id: 'scp_2',
          name: 'CatchBlock',
          type: 'scope',
          runAfter: { TryBlock: ['Failed'] },
          actions: [compose('act_1', 'LogError', 'handled')],
        } as any,
        compose('act_2', 'AfterCatch', 'done', { CatchBlock: ['Succeeded', 'Skipped'] }),
      ],
    };

    const result = await run(flow, { connectors: { spy: connector } });

    assert.equal(statusOf(result.trace, 'RiskyCall'), 'Failed');
    assert.equal(statusOf(result.trace, 'TryBlock'), 'Failed');
    assert.equal(statusOf(result.trace, 'LogError'), 'Succeeded');
    assert.equal(statusOf(result.trace, 'CatchBlock'), 'Succeeded');
    assert.equal(statusOf(result.trace, 'AfterCatch'), 'Succeeded');
  });

  it('reports the run as Succeeded when the failure was handled by a catch scope', async () => {
    const connector = new SelectiveConnector(new Set(['Risky']));
    const flow: FlowIR = {
      name: 'handled-run-status',
      nodes: [
        TRIGGER,
        {
          id: 'scp_1',
          name: 'TryBlock',
          type: 'scope',
          actions: [
            { id: 'con_1', name: 'RiskyCall', type: 'connector', connector: 'spy', operation: 'Risky', params: {} } as any,
          ],
        } as any,
        {
          id: 'scp_2',
          name: 'CatchBlock',
          type: 'scope',
          runAfter: { TryBlock: ['Failed'] },
          actions: [compose('act_1', 'LogError', 'handled')],
        } as any,
      ],
    };

    const result = await run(flow, { connectors: { spy: connector } });

    assert.equal(result.status, 'Succeeded');
  });

  it('skips the catch scope but still runs the follow-up when the try scope succeeds', async () => {
    const connector = new SelectiveConnector();
    const flow: FlowIR = {
      name: 'catch-skipped',
      nodes: [
        TRIGGER,
        {
          id: 'scp_1',
          name: 'TryBlock',
          type: 'scope',
          actions: [
            { id: 'con_1', name: 'SafeCall', type: 'connector', connector: 'spy', operation: 'Safe', params: {} } as any,
          ],
        } as any,
        {
          id: 'scp_2',
          name: 'CatchBlock',
          type: 'scope',
          runAfter: { TryBlock: ['Failed'] },
          actions: [compose('act_1', 'LogError', 'handled')],
        } as any,
        compose('act_2', 'AfterCatch', 'done', { CatchBlock: ['Succeeded', 'Skipped'] }),
      ],
    };

    const result = await run(flow, { connectors: { spy: connector } });

    assert.equal(statusOf(result.trace, 'TryBlock'), 'Succeeded');
    assert.equal(statusOf(result.trace, 'CatchBlock'), 'Skipped');
    assert.equal(statusOf(result.trace, 'AfterCatch'), 'Succeeded');
    assert.equal(result.status, 'Succeeded');
  });

  it('stops the run and reports Failed when nothing handles the failure', async () => {
    const connector = new SelectiveConnector(new Set(['Risky']));
    const flow: FlowIR = {
      name: 'unhandled',
      nodes: [
        TRIGGER,
        {
          id: 'scp_1',
          name: 'TryBlock',
          type: 'scope',
          actions: [
            { id: 'con_1', name: 'RiskyCall', type: 'connector', connector: 'spy', operation: 'Risky', params: {} } as any,
          ],
        } as any,
        compose('act_1', 'NeverRuns', 'nope', { TryBlock: ['Succeeded'] }),
      ],
    };

    const result = await run(flow, { connectors: { spy: connector } });

    assert.equal(result.status, 'Failed');
    assert.equal(statusOf(result.trace, 'NeverRuns'), 'Skipped');
  });
});
