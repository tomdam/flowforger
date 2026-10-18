import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR, Node } from '@flowforger/ir';
import type { DslSourceMap } from '@flowforger/dsl-native';
import { transformCode, buildSourceMapFromDsl } from '@flowforger/dsl-native';
import type { ExecuteNodeResult } from '@flowforger/engine';
import { DebugSession, type BreakpointEntry } from '../debug-session.js';
import { createInMemoryHost } from './test-host.js';

/**
 * Breakpoints with an `iteration` path pause only inside that loop iteration; breakpoints with
 * a DSL-style `condition` pause only when it evaluates to true — and pause with a console line
 * when it does not evaluate to a boolean at all, so a mistyped condition can never silently
 * disarm a breakpoint.
 */

const KEY = 'cond-bp.ff.ts';
const emptySourceMap: DslSourceMap = { lineToNodeId: new Map(), nodeIdToLines: new Map(), breakpointableLines: new Set() };

/** trigger + Outer(a,b,c){ Note } + Done */
function loopFlow(): FlowIR {
  return {
    name: 'cond-bp',
    nodes: [
      { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
      {
        id: 'fe_outer', name: 'Outer', type: 'foreach', itemsExpression: "@createArray('a','b','c')", runtimeConfiguration: { concurrency: { repetitions: 1 } },
        actions: [{ id: 'act_note', name: 'Note', type: 'action', kind: 'compose', inputs: { value: "@items('Outer')" } } as any],
      } as any,
      { id: 'act_done', name: 'Done', type: 'action', kind: 'compose', inputs: { value: 'done' }, runAfter: { Outer: ['Succeeded'] } } as any,
    ],
  };
}

/** trigger + Outer(a,b,c){ Inner(1,2){ Deep } } */
function nestedFlow(): FlowIR {
  return {
    name: 'cond-bp-nested',
    nodes: [
      { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
      {
        id: 'fe_outer', name: 'Outer', type: 'foreach', itemsExpression: "@createArray('a','b','c')", runtimeConfiguration: { concurrency: { repetitions: 1 } },
        actions: [
          {
            id: 'fe_inner', name: 'Inner', type: 'foreach', itemsExpression: '@createArray(1,2)', runtimeConfiguration: { concurrency: { repetitions: 1 } },
            actions: [{ id: 'act_deep', name: 'Deep', type: 'action', kind: 'compose', inputs: { value: "@items('Inner')" } } as any],
          } as any,
        ],
      } as any,
    ],
  };
}

const DSL = `
@Flow('CondBp')
class CondBp {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    /** @action Initialize_counter */
    let counter: number = 1;

    /** @action Loop */
    for (const item of ctx.triggerBody().items) {
      await ctx.compose('Note', item.v);
    }

    await ctx.compose('Done', 'done');
  }
}
`;

function nodeId(ir: FlowIR, name: string): string {
  let found: string | undefined;
  const visit = (nodes: Node[] | undefined) => {
    for (const n of nodes ?? []) {
      if (n.name === name) found = n.id;
      visit((n as any).actions);
      visit((n as any).elseActions);
    }
  };
  visit(ir.nodes);
  if (!found) throw new Error(`no node ${name}`);
  return found;
}

interface Stop { reason: string; nodeId: string; executed: string[] }

/**
 * Run a session to the end, resuming 'continue' at every pause; collects the pauses (with the
 * names executed so far at each) and every console line.
 */
function runToEnd(
  source: { ir: FlowIR; sourceMap: DslSourceMap; dslCode: string | null },
  entries: BreakpointEntry[],
  input: unknown = {},
  onPause?: (session: DebugSession, stop: Stop) => void,
): Promise<{ stops: Stop[]; outputs: string[]; executed: string[]; session: DebugSession }> {
  return new Promise((resolve) => {
    const stops: Stop[] = [];
    const outputs: string[] = [];
    const executed: string[] = [];
    const session: DebugSession = new DebugSession(
      { key: KEY, ...source },
      createInMemoryHost(),
      {},
      input,
      {},
      false,
      {
        onStopped: (reason, id) => {
          const stop = { reason, nodeId: id, executed: [...executed] };
          stops.push(stop);
          queueMicrotask(() => {
            onPause?.(session, stop);
            session.resume('continue');
          });
        },
        onOutput: (text: string) => outputs.push(text),
        onTerminated: () => resolve({ stops, outputs, executed, session }),
        onNodeExecuted: (node: Node, _result: ExecuteNodeResult) => executed.push(node.name),
      },
    );
    session.setBreakpointsForSource(KEY, entries);
    void session.start();
  });
}

const count = (names: string[], name: string) => names.filter((n) => n === name).length;

describe('iteration breakpoints', () => {
  it('pause once, in that iteration only', async () => {
    const { stops } = await runToEnd({ ir: loopFlow(), sourceMap: emptySourceMap, dslCode: null }, [
      { nodeId: 'act_note', line: 0, iteration: [{ scopeName: 'Outer', itemIndex: 1 }] },
    ]);
    assert.deepEqual(stops.map((s) => [s.reason, s.nodeId]), [['breakpoint', 'act_note']]);
    assert.equal(count(stops[0].executed, 'Note'), 1, 'paused before the second Note, after the first');
  });

  it('match the outer path as a prefix, so an outer-iteration breakpoint fires in every inner iteration', async () => {
    const { stops } = await runToEnd({ ir: nestedFlow(), sourceMap: emptySourceMap, dslCode: null }, [
      { nodeId: 'act_deep', line: 0, iteration: [{ scopeName: 'Outer', itemIndex: 1 }] },
    ]);
    assert.deepEqual(stops.map((s) => [s.reason, count(s.executed, 'Deep')]), [['breakpoint', 2], ['breakpoint', 3]]);
  });

  it('a full nested path pauses exactly once', async () => {
    const { stops } = await runToEnd({ ir: nestedFlow(), sourceMap: emptySourceMap, dslCode: null }, [
      { nodeId: 'act_deep', line: 0, iteration: [{ scopeName: 'Outer', itemIndex: 2 }, { scopeName: 'Inner', itemIndex: 1 }] },
    ]);
    assert.deepEqual(stops.map((s) => count(s.executed, 'Deep')), [5]);
  });

  it('never fire on a node outside any loop', async () => {
    const { stops } = await runToEnd({ ir: loopFlow(), sourceMap: emptySourceMap, dslCode: null }, [
      { nodeId: 'act_done', line: 0, iteration: [{ scopeName: 'Outer', itemIndex: 0 }] },
    ]);
    assert.deepEqual(stops, []);
  });
});

describe('conditional breakpoints (DSL style)', () => {
  const ir = transformCode(DSL);
  const sourceMap = buildSourceMapFromDsl(DSL, ir);
  const source = { ir, sourceMap, dslCode: DSL };
  const input = { items: [{ v: 1 }, { v: 2 }, { v: 3 }] };
  const note = nodeId(ir, 'Note');
  const done = nodeId(ir, 'Done');

  it('pause only where the condition over the loop item is true', async () => {
    const { stops, outputs } = await runToEnd(source, [{ nodeId: note, line: 0, condition: 'item.v === 2' }], input);
    assert.deepEqual(stops.map((s) => [s.reason, s.nodeId, count(s.executed, 'Note')]), [['breakpoint', note, 1]]);
    assert.equal(outputs.filter((o) => o.startsWith('Breakpoint condition')).length, 0);
  });

  it('pause with a console line when the condition is not a boolean', async () => {
    const { stops, outputs } = await runToEnd(source, [{ nodeId: note, line: 0, condition: 'item.v' }], input);
    assert.equal(stops.length, 3);
    assert.ok(outputs.includes('Breakpoint condition on Note is not a boolean: 1'), JSON.stringify(outputs));
  });

  it('pause with a console line when the condition cannot be evaluated', async () => {
    const { stops, outputs } = await runToEnd(source, [{ nodeId: note, line: 0, condition: '@unknownFn(1)' }], input);
    assert.equal(stops.length, 3);
    assert.ok(outputs.some((o) => o.startsWith('Breakpoint condition on Note could not be evaluated: ')), JSON.stringify(outputs));
  });

  it('evaluate a top-level condition against the variables', async () => {
    const hit = await runToEnd(source, [{ nodeId: done, line: 0, condition: 'counter === 1' }], input);
    assert.deepEqual(hit.stops.map((s) => [s.reason, s.nodeId]), [['breakpoint', done]]);
    const miss = await runToEnd(source, [{ nodeId: done, line: 0, condition: 'counter === 2' }], input);
    assert.deepEqual(miss.stops, []);
  });

  it('take a condition changed while paused, through the same map', async () => {
    const { stops } = await runToEnd(source, [{ nodeId: note, line: 0, condition: 'item.v === 1' }], input, (session) => {
      session.setBreakpointsForSource(KEY, [{ nodeId: note, line: 0, condition: 'item.v === 3' }]);
    });
    assert.deepEqual(stops.map((s) => count(s.executed, 'Note')), [0, 2]);
  });
});
