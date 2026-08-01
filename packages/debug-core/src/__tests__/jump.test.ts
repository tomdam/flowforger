import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR, Node } from '@flowforger/ir';
import { computeContinuationSet, collectInlinedDescendantIds } from '../jump.js';
import type { DslSourceMap } from '@flowforger/dsl-native';
import type { DebugFlowSource } from '../host.js';
import { DebugSession } from '../debug-session.js';
import { createInMemoryHost } from './test-host.js';

/**
 * Frame shape used across the unit tests:
 *   trg_1 (trigger)
 *   act_a
 *   if_1: actions [act_t1, if_2: actions [act_u1] / elseActions [act_u2], act_t2]
 *         elseActions [act_e1]
 *   act_b
 */
const nestedNodes: Node[] = [
  { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
  { id: 'act_a', name: 'Compose_a', type: 'action', kind: 'compose', inputs: { value: 'a' } } as any,
  {
    id: 'if_1', name: 'Condition', type: 'if', condition: '@true',
    actions: [
      { id: 'act_t1', name: 'Compose_t1', type: 'action', kind: 'compose', inputs: { value: 't1' } } as any,
      {
        id: 'if_2', name: 'Condition_inner', type: 'if', condition: '@true',
        actions: [{ id: 'act_u1', name: 'Compose_u1', type: 'action', kind: 'compose', inputs: { value: 'u1' } } as any],
        elseActions: [{ id: 'act_u2', name: 'Compose_u2', type: 'action', kind: 'compose', inputs: { value: 'u2' } } as any],
      } as any,
      { id: 'act_t2', name: 'Compose_t2', type: 'action', kind: 'compose', inputs: { value: 't2' } } as any,
    ],
    elseActions: [{ id: 'act_e1', name: 'Compose_e1', type: 'action', kind: 'compose', inputs: { value: 'e1' } } as any],
  } as any,
  { id: 'act_b', name: 'Compose_b', type: 'action', kind: 'compose', inputs: { value: 'b' } } as any,
];

const loopNodes: Node[] = [
  { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
  {
    id: 'fe_1', name: 'ForEach_item', type: 'foreach', itemsExpression: "@createArray('x','y')",
    actions: [{ id: 'act_in', name: 'Compose_in', type: 'action', kind: 'compose', inputs: { value: '@item()' } } as any],
  } as any,
  { id: 'act_after', name: 'Compose_after', type: 'action', kind: 'compose', inputs: { value: 'z' } } as any,
];

/**
 * Switch frame shape:
 *   trg_1 (trigger)
 *   sw_1: cases [ c1: [act_c1a, act_c1b], c2: [act_c2a] ], defaultActions [act_d1]
 *   act_after
 */
const switchNodes: Node[] = [
  { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
  {
    id: 'sw_1', name: 'Switch', type: 'switch', on: "@variables('v')",
    cases: [
      {
        name: 'Case_1', value: 'one',
        actions: [
          { id: 'act_c1a', name: 'Compose_c1a', type: 'action', kind: 'compose', inputs: { value: 'c1a' } } as any,
          { id: 'act_c1b', name: 'Compose_c1b', type: 'action', kind: 'compose', inputs: { value: 'c1b' } } as any,
        ],
      },
      {
        name: 'Case_2', value: 'two',
        actions: [
          { id: 'act_c2a', name: 'Compose_c2a', type: 'action', kind: 'compose', inputs: { value: 'c2a' } } as any,
        ],
      },
    ],
    defaultActions: [
      { id: 'act_d1', name: 'Compose_d1', type: 'action', kind: 'compose', inputs: { value: 'd1' } } as any,
    ],
  } as any,
  { id: 'act_after', name: 'Compose_after', type: 'action', kind: 'compose', inputs: { value: 'z' } } as any,
];

describe('collectInlinedDescendantIds', () => {
  it('collects if/scope/switch descendants at all depths but not loop bodies', () => {
    const out = new Set<string>();
    collectInlinedDescendantIds(nestedNodes[2], out); // if_1
    assert.deepEqual([...out].sort(), ['act_e1', 'act_t1', 'act_t2', 'act_u1', 'act_u2', 'if_2']);
    const loopOut = new Set<string>();
    collectInlinedDescendantIds(loopNodes[1], loopOut); // fe_1 — body is engine-owned
    assert.equal(loopOut.size, 0);
  });
});

describe('computeContinuationSet', () => {
  it('deep target: target + following siblings per level; other branches excluded', () => {
    const set = computeContinuationSet(nestedNodes, 'act_u1');
    // act_u1 (target), act_t2 (sibling after if_2 in the then-branch), act_b (after if_1)
    assert.deepEqual([...set!].sort(), ['act_b', 'act_t2', 'act_u1']);
    // Regression pins: neither the other branches nor the ancestors themselves
    for (const excluded of ['act_u2', 'act_e1', 'act_t1', 'if_1', 'if_2', 'act_a', 'trg_1']) {
      assert.equal(set!.has(excluded), false, `${excluded} must not be in the continuation set`);
    }
  });

  it('control-node target: included with all of its descendants', () => {
    const set = computeContinuationSet(nestedNodes, 'if_2');
    assert.deepEqual([...set!].sort(), ['act_b', 'act_t2', 'act_u1', 'act_u2', 'if_2']);
  });

  it('top-level target: everything from the target onward, descendants included', () => {
    const set = computeContinuationSet(nestedNodes, 'act_a');
    assert.deepEqual(
      [...set!].sort(),
      ['act_a', 'act_b', 'act_e1', 'act_t1', 'act_t2', 'act_u1', 'act_u2', 'if_1', 'if_2'],
    );
  });

  it('foreach node is a valid target; its body children are not', () => {
    const set = computeContinuationSet(loopNodes, 'fe_1');
    // Loop bodies are engine-owned: fe_1 re-runs as a whole, act_in is not listed
    assert.deepEqual([...set!].sort(), ['act_after', 'fe_1']);
    assert.equal(computeContinuationSet(loopNodes, 'act_in'), null);
  });

  it('switch case target: own case continues, other case and default excluded', () => {
    const set = computeContinuationSet(switchNodes, 'act_c1a');
    // target + following sibling in the SAME case + the switch's following sibling
    assert.deepEqual([...set!].sort(), ['act_after', 'act_c1a', 'act_c1b']);
    for (const excluded of ['act_c2a', 'act_d1', 'sw_1', 'trg_1']) {
      assert.equal(set!.has(excluded), false, `${excluded} must not be in the continuation set`);
    }
    // Last action of a case: nothing follows it inside the case
    assert.deepEqual([...computeContinuationSet(switchNodes, 'act_c1b')!].sort(), ['act_after', 'act_c1b']);
  });

  it('switch node target: the switch and ALL of its descendants re-run', () => {
    const set = computeContinuationSet(switchNodes, 'sw_1');
    assert.deepEqual(
      [...set!].sort(),
      ['act_after', 'act_c1a', 'act_c1b', 'act_c2a', 'act_d1', 'sw_1'],
    );
  });

  it('unknown target returns null', () => {
    assert.equal(computeContinuationSet(nestedNodes, 'nope'), null);
  });
});

const emptySourceMap: DslSourceMap = {
  lineToNodeId: new Map(),
  nodeIdToLines: new Map() as DslSourceMap['nodeIdToLines'],
  breakpointableLines: new Set(),
};

interface JumpRun {
  session: DebugSession;
  pauses: Array<{ nodeId: string; reason: string }>;
  executed: string[];
  done: Promise<void>;
}

function launchSession(opts: {
  ir: FlowIR;
  children?: Record<string, DebugFlowSource>;
  breakpoints?: Array<{ key: string; nodeIds: string[] }>;
  initialVariables?: Record<string, any>;
  onPaused: (run: JumpRun, nodeId: string, reason: string) => void;
}): JumpRun {
  const run = {} as JumpRun;
  run.pauses = [];
  run.executed = [];
  run.done = new Promise<void>((resolve) => {
    run.session = new DebugSession(
      { key: opts.ir.name, ir: opts.ir, sourceMap: emptySourceMap, dslCode: null },
      createInMemoryHost(opts.children ?? {}),
      {},
      {},
      opts.initialVariables ?? {},
      false,
      {
        // Deferred via queueMicrotask: onStopped fires synchronously BEFORE
        // waitForResume() installs the resolver — a same-tick resume()/jumpTo()
        // would be dropped/rejected. See session-options.test.ts.
        onStopped: (reason, nodeId) => queueMicrotask(() => {
          run.pauses.push({ nodeId, reason });
          opts.onPaused(run, nodeId, reason);
        }),
        onOutput: () => {},
        onTerminated: () => resolve(),
        onNodeExecuted: (node) => run.executed.push(node.name),
      },
    );
    for (const bp of opts.breakpoints ?? []) {
      run.session.setBreakpointsForSource(bp.key, bp.nodeIds.map((nodeId) => ({ nodeId, line: 1 })));
    }
    queueMicrotask(() => void run.session.start());
  });
  return run;
}

const count = (run: JumpRun, name: string) => run.executed.filter((n) => n === name).length;

describe('DebugSession.jumpTo', () => {
  it('backward jump re-executes an action against the mutated live context', async () => {
    const ir: FlowIR = {
      name: 'jump-back',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        { id: 'act_x', name: 'Compose_x', type: 'action', kind: 'compose', inputs: { value: "@variables('x')" } } as any,
        { id: 'act_b', name: 'Compose_b', type: 'action', kind: 'compose', inputs: { value: 'b' } } as any,
      ],
    };
    let jumped = false;
    let rerunOutput: any;
    const run = launchSession({
      ir,
      initialVariables: { x: 1 },
      breakpoints: [{ key: 'jump-back', nodeIds: ['act_b'] }],
      onPaused: (run, nodeId) => {
        if (nodeId === 'act_b' && !jumped) {
          jumped = true;
          assert.equal(run.session.getContext().actions.get('Compose_x')?.outputs, 1);
          // Immediate-window-style mutation, then jump back over Compose_x
          run.session.getContext().variables['x'] = 42;
          const res = run.session.jumpTo('act_x');
          assert.equal(res.ok, true);
          if (res.ok) assert.deepEqual([...res.resetNodeIds].sort(), ['act_b', 'act_x']);
          // Jump-then-pause: nothing executed yet; next onStopped is at act_x
        } else {
          if (nodeId === 'act_b') {
            rerunOutput = run.session.getContext().actions.get('Compose_x')?.outputs;
          }
          run.session.resume('continue');
        }
      },
    });
    await run.done;

    assert.deepEqual(run.pauses.map((p) => p.nodeId), ['act_b', 'act_x', 'act_b']);
    assert.equal(run.pauses[1].reason, 'step', 'jump re-pause reports reason step');
    assert.equal(count(run, 'Compose_x'), 2, 'Compose_x ran twice');
    assert.equal(rerunOutput, 42, 'second run saw the mutated variable');
  });

  it('forward jump skips: skipped action never runs and has no ctx.actions entry', async () => {
    const ir: FlowIR = {
      name: 'jump-fwd',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        { id: 'act_a', name: 'Compose_a', type: 'action', kind: 'compose', inputs: { value: 'a' } } as any,
        { id: 'act_b', name: 'Compose_b', type: 'action', kind: 'compose', inputs: { value: 'b' } } as any,
        { id: 'act_c', name: 'Compose_c', type: 'action', kind: 'compose', inputs: { value: 'c' } } as any,
      ],
    };
    let jumped = false;
    let skippedEntry: any = 'sentinel';
    const run = launchSession({
      ir,
      breakpoints: [{ key: 'jump-fwd', nodeIds: ['act_b'] }],
      onPaused: (run, nodeId) => {
        if (nodeId === 'act_b' && !jumped) {
          jumped = true;
          const res = run.session.jumpTo('act_c');
          assert.equal(res.ok, true);
          if (res.ok) assert.deepEqual(res.resetNodeIds, ['act_c'], 'forward jump resets only from the target onward');
        } else {
          skippedEntry = run.session.getContext().actions.get('Compose_b');
          run.session.resume('continue');
        }
      },
    });
    await run.done;

    assert.deepEqual(run.executed, ['Compose_a', 'Compose_c']);
    assert.equal(skippedEntry, undefined, "skipped action's ctx.actions entry is unchanged (never ran)");
    assert.deepEqual(run.pauses.map((p) => p.nodeId), ['act_b', 'act_c']);
  });

  it('jump into a non-taken if branch runs that branch to its end, skips the other, continues after the if', async () => {
    const ir: FlowIR = {
      name: 'jump-branch',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        {
          id: 'if_1', name: 'Condition', type: 'if', condition: '@equals(1, 2)',
          actions: [
            { id: 'act_t1', name: 'Compose_then1', type: 'action', kind: 'compose', inputs: { value: 't1' } } as any,
            { id: 'act_t2', name: 'Compose_then2', type: 'action', kind: 'compose', inputs: { value: 't2' } } as any,
          ],
          elseActions: [
            { id: 'act_e1', name: 'Compose_else', type: 'action', kind: 'compose', inputs: { value: 'e1' } } as any,
          ],
        } as any,
        { id: 'act_after', name: 'Compose_after', type: 'action', kind: 'compose', inputs: { value: 'z' } } as any,
      ],
    };
    let jumped = false;
    const run = launchSession({
      ir,
      breakpoints: [{ key: 'jump-branch', nodeIds: ['if_1'] }],
      onPaused: (run, nodeId) => {
        if (nodeId === 'if_1' && !jumped) {
          jumped = true;
          const res = run.session.jumpTo('act_t1');
          assert.equal(res.ok, true);
          if (res.ok) {
            const ids = [...res.resetNodeIds].sort();
            assert.deepEqual(ids, ['act_after', 'act_t1', 'act_t2']);
          }
        } else {
          run.session.resume('continue');
        }
      },
    });
    await run.done;

    // The condition is never evaluated (the if node itself is skipped past),
    // the then-branch runs to its end, the else-branch does NOT execute.
    assert.deepEqual(run.executed, ['Compose_then1', 'Compose_then2', 'Compose_after']);
    assert.deepEqual(run.pauses.map((p) => p.nodeId), ['if_1', 'act_t1']);
  });

  it('backward jump into a scope body re-executes from there without re-running earlier scope children', async () => {
    const ir: FlowIR = {
      name: 'jump-scope',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        {
          id: 'scp_1', name: 'Scope_1', type: 'scope',
          actions: [
            { id: 'act_s1', name: 'Compose_s1', type: 'action', kind: 'compose', inputs: { value: 's1' } } as any,
            { id: 'act_s2', name: 'Compose_s2', type: 'action', kind: 'compose', inputs: { value: 's2' } } as any,
          ],
        } as any,
        { id: 'act_after', name: 'Compose_after', type: 'action', kind: 'compose', inputs: { value: 'z' } } as any,
      ],
    };
    let jumped = false;
    const run = launchSession({
      ir,
      breakpoints: [{ key: 'jump-scope', nodeIds: ['act_after'] }],
      onPaused: (run, nodeId) => {
        if (nodeId === 'act_after' && !jumped) {
          jumped = true;
          assert.equal(run.session.jumpTo('act_s2').ok, true);
        } else {
          run.session.resume('continue');
        }
      },
    });
    await run.done;

    assert.equal(count(run, 'Compose_s1'), 1, 'earlier scope child not re-run');
    assert.equal(count(run, 'Compose_s2'), 2, 'jump target re-ran');
    assert.equal(count(run, 'Compose_after'), 1);
    // act_after's breakpoint fires again after the re-run
    assert.deepEqual(run.pauses.map((p) => p.nodeId), ['act_after', 'act_s2', 'act_after']);
  });

  it('foreach node is a valid target: backward jump re-runs the whole loop', async () => {
    const ir: FlowIR = {
      name: 'jump-loop-node',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        {
          id: 'fe_1', name: 'ForEach_item', type: 'foreach', itemsExpression: "@createArray('x','y')",
          actions: [{ id: 'act_in', name: 'Compose_in', type: 'action', kind: 'compose', inputs: { value: '@item()' } } as any],
        } as any,
        { id: 'act_after', name: 'Compose_after', type: 'action', kind: 'compose', inputs: { value: 'z' } } as any,
      ],
    };
    let jumped = false;
    const run = launchSession({
      ir,
      breakpoints: [{ key: 'jump-loop-node', nodeIds: ['act_after'] }],
      onPaused: (run, nodeId) => {
        if (nodeId === 'act_after' && !jumped) {
          jumped = true;
          assert.equal(run.session.jumpTo('fe_1').ok, true);
        } else {
          run.session.resume('continue');
        }
      },
    });
    await run.done;

    assert.equal(count(run, 'Compose_in'), 4, 'both iterations ran twice (initial + re-run)');
    assert.equal(count(run, 'ForEach_item'), 2);
    assert.deepEqual(run.pauses.map((p) => p.nodeId), ['act_after', 'fe_1', 'act_after']);
  });

  it('jump works inside a child-flow frame (stays within the active frame)', async () => {
    const childIr: FlowIR = {
      name: 'child',
      nodes: [
        { id: 'trg_c', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        { id: 'act_c1', name: 'Compose_c1', type: 'action', kind: 'compose', inputs: { value: 'c1' } } as any,
        { id: 'act_c2', name: 'Compose_c2', type: 'action', kind: 'compose', inputs: { value: 'c2' } } as any,
      ],
    };
    const parentIr: FlowIR = {
      name: 'parent',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        { id: 'act_call', name: 'Call_child', type: 'action', kind: 'workflow', inputs: { workflowReferenceName: 'childRef', body: {} } } as any,
        { id: 'act_p', name: 'Compose_p', type: 'action', kind: 'compose', inputs: { value: 'p' } } as any,
      ],
    };
    let jumped = false;
    const run = launchSession({
      ir: parentIr,
      children: { childRef: { key: 'childRef', ir: childIr, sourceMap: null, dslCode: null } },
      // A breakpoint in the child source makes the session debug INTO the child.
      breakpoints: [{ key: 'childRef', nodeIds: ['act_c2'] }],
      onPaused: (run, nodeId) => {
        if (nodeId === 'act_c2' && !jumped) {
          jumped = true;
          assert.equal(run.session.getCallStackDepth(), 1, 'paused in the child frame');
          assert.equal(run.session.jumpTo('act_c1').ok, true);
        } else {
          run.session.resume('continue');
        }
      },
    });
    await run.done;

    assert.equal(count(run, 'Compose_c1'), 2, 'child-frame target re-ran');
    assert.equal(count(run, 'Compose_p'), 1);
    // act_c2's breakpoint fires again after the re-run
    assert.deepEqual(run.pauses.map((p) => p.nodeId), ['act_c2', 'act_c1', 'act_c2']);
  });

  it('rejects: iteration pause, trigger target, loop-body target, unknown node', async () => {
    const ir: FlowIR = {
      name: 'jump-rejects',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        { id: 'act_a', name: 'Compose_a', type: 'action', kind: 'compose', inputs: { value: 'a' } } as any,
        {
          id: 'fe_1', name: 'ForEach_item', type: 'foreach', itemsExpression: "@createArray('x','y')",
          actions: [{ id: 'act_in', name: 'Compose_in', type: 'action', kind: 'compose', inputs: { value: '@item()' } } as any],
        } as any,
      ],
    };
    let checkedStepLoop = false;
    let checkedIteration = false;
    const run = launchSession({
      ir,
      breakpoints: [{ key: 'jump-rejects', nodeIds: ['act_a', 'act_in'] }],
      onPaused: (run, nodeId) => {
        if (nodeId === 'act_a' && !checkedStepLoop) {
          checkedStepLoop = true;
          const trig = run.session.jumpTo('trg_1');
          assert.equal(trig.ok, false);
          if (!trig.ok) assert.match(trig.error, /trigger/i);
          const loopBody = run.session.jumpTo('act_in');
          assert.equal(loopBody.ok, false, 'loop-body nodes are not jumpable from the step loop');
          const unknown = run.session.jumpTo('nope');
          assert.equal(unknown.ok, false);
        } else if (nodeId === 'act_in' && !checkedIteration) {
          checkedIteration = true;
          const res = run.session.jumpTo('act_a');
          assert.equal(res.ok, false);
          if (!res.ok) assert.match(res.error, /iteration/i);
        }
        run.session.resume('continue');
      },
    });
    await run.done;

    assert.equal(checkedStepLoop, true);
    assert.equal(checkedIteration, true);
    // The rejected jumps changed nothing: normal execution completed
    assert.equal(count(run, 'Compose_a'), 1);
    assert.equal(count(run, 'Compose_in'), 2);
  });

  it('rejects on an if-branch child pause (engine-driven, not the step loop)', async () => {
    const ir: FlowIR = {
      name: 'jump-branch-pause',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        {
          id: 'if_1', name: 'Condition', type: 'if', condition: '@equals(1, 1)',
          actions: [
            { id: 'act_t1', name: 'Compose_t1', type: 'action', kind: 'compose', inputs: { value: 't1' } } as any,
          ],
        } as any,
        { id: 'act_after', name: 'Compose_after', type: 'action', kind: 'compose', inputs: { value: 'z' } } as any,
      ],
    };
    let checkedBranch = false;
    let checkedStepLoop = false;
    const run = launchSession({
      ir,
      breakpoints: [{ key: 'jump-branch-pause', nodeIds: ['act_t1', 'act_after'] }],
      onPaused: (run, nodeId) => {
        if (nodeId === 'act_t1' && !checkedBranch) {
          checkedBranch = true;
          // The pause was raised by the engine via onBeforeChildExecute while
          // the parent if executes — NOT the frame's own step loop.
          assert.equal(run.session.isPausedAtStepLoop(), false);
          const res = run.session.jumpTo('act_after');
          assert.equal(res.ok, false, 'jump is rejected inside an if-branch child pause');
          if (!res.ok) assert.match(res.error, /control-flow block/i);
        } else if (nodeId === 'act_after' && !checkedStepLoop) {
          checkedStepLoop = true;
          assert.equal(run.session.isPausedAtStepLoop(), true, 'top-level pause IS the step loop');
        }
        run.session.resume('continue');
      },
    });
    await run.done;

    assert.equal(checkedBranch, true);
    assert.equal(checkedStepLoop, true);
    // The rejected jump changed nothing: normal execution completed
    assert.deepEqual(run.pauses.map((p) => p.nodeId), ['act_t1', 'act_after']);
    assert.equal(count(run, 'Compose_t1'), 1);
    assert.equal(count(run, 'Compose_after'), 1);
  });

  it('rejects when not paused', () => {
    const ir: FlowIR = {
      name: 'jump-idle',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        { id: 'act_a', name: 'Compose_a', type: 'action', kind: 'compose', inputs: { value: 'a' } } as any,
      ],
    };
    const session = new DebugSession(
      { key: 'jump-idle', ir, sourceMap: emptySourceMap, dslCode: null },
      createInMemoryHost(),
      {},
      {},
      {},
      false,
      { onStopped: () => {}, onOutput: () => {}, onTerminated: () => {} },
    );
    const res = session.jumpTo('act_a'); // never started — no pause pending
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /not paused/i);
  });
});
