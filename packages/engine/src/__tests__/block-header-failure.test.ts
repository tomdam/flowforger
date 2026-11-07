import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../index.js';
import type { FlowIR, Node } from '@flowforger/ir';

// When a foreach's items expression or an If's condition fails, the cloud records the block's
// children as Skipped with ActionDependencyFailed ("dependant action 'X' completed with status
// 'Failed' and code 'BadRequest'"). Measured by conformance/flows/coalesce-empty.ff.ts
// (Each_missing / Missing_item). The engine used to leave them out of the trace.

const TRIGGER = { id: 'trg_1', name: 'manual', type: 'trigger', kind: 'manual', inputs: {} } as any;
const flow = (nodes: Node[]): FlowIR => ({ name: 'block-header-failure', nodes: [TRIGGER, ...nodes] });
const compose = (name: string, value: any, extra: object = {}): Node =>
  ({ id: `act_${name}`, name, type: 'action', kind: 'compose', inputs: { value }, ...extra }) as any;

describe('block header failure skips the children', () => {
  it('foreach: a failing items expression fails the loop and skips its body', async () => {
    const result = await run(
      flow([
        { id: 'fe_1', name: 'Each_missing', type: 'foreach', itemsExpression: '@coalesce(null, createArray())', actions: [compose('Missing_item', '@item()')] } as any,
        compose('Probe', "@actions('Missing_item')", { runAfter: { Each_missing: ['Succeeded', 'Failed'] } }),
      ]),
      { input: {} },
    );
    const loop = result.trace.find((t) => t.name === 'Each_missing')!;
    assert.equal(loop.status, 'Failed');
    const child = (loop.children ?? []).find((t) => t.name === 'Missing_item');
    assert.ok(child, 'the loop body appears in the trace');
    assert.equal(child!.status, 'Skipped');
    const record = result.trace.find((t) => t.name === 'Probe')!.outputs;
    assert.equal(record.status, 'Skipped');
    assert.equal(record.code, 'ActionSkipped');
    assert.equal(record.error.code, 'ActionDependencyFailed');
    assert.match(record.error.message, /dependant action 'Each_missing' completed with status 'Failed' and code 'BadRequest'/);
  });

  it('if: a failing condition fails the block and skips both branches', async () => {
    const result = await run(
      flow([
        { id: 'if_1', name: 'Bad_if', type: 'if', condition: "@greater(createArray(), 1)", actions: [compose('Then_x', 1)], elseActions: [compose('Else_x', 2)] } as any,
        compose('Probe', "@actions('Else_x')", { runAfter: { Bad_if: ['Succeeded', 'Failed'] } }),
      ]),
      { input: {} },
    );
    const block = result.trace.find((t) => t.name === 'Bad_if')!;
    assert.equal(block.status, 'Failed');
    assert.deepEqual((block.children ?? []).map((c) => [c.name, c.status]), [['Then_x', 'Skipped'], ['Else_x', 'Skipped']]);
    const record = result.trace.find((t) => t.name === 'Probe')!.outputs;
    assert.equal(record.status, 'Skipped');
    assert.equal(record.error.code, 'ActionDependencyFailed');
  });
});

describe('empty loop', () => {
  it('records the body of a loop with no items as Skipped: there are no items to repeat', async () => {
    const result = await run(
      flow([
        { id: 'fe_1', name: 'Each_none', type: 'foreach', itemsExpression: "@json('[]')", actions: [compose('Never', 1)] } as any,
        compose('Probe', "@actions('Never')", { runAfter: { Each_none: ['Succeeded', 'Failed'] } }),
      ]),
      { input: {} },
    );
    const loop = result.trace.find((t) => t.name === 'Each_none')!;
    assert.equal(loop.status, 'Succeeded');
    assert.deepEqual((loop.children ?? []).map((c) => [c.name, c.status]), [['Never', 'Skipped']]);
    const record = result.trace.find((t) => t.name === 'Probe')!.outputs;
    assert.equal(record.status, 'Skipped');
    assert.equal(record.code, 'ActionSkipped');
    assert.equal(record.error.code, 'ActionConditionFailed');
    assert.equal(record.error.message, "The execution of template action 'Never' is skipped: there are no items to repeat.");
  });
});
