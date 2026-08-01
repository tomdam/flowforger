import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR } from '@flowforger/ir';
import { computeVolatileInputPaths, maskInputs } from '../volatile-inputs.js';

const ir: FlowIR = {
  name: 'vol',
  nodes: [
    { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
    {
      id: 'con_1', name: 'Create_item', type: 'connector', connector: 'sp', operation: 'CreateItem',
      params: { list: 'A', body: { Title: 'fixed', Stamp: "@{utcNow()}", Ref: "@guid()" } },
    } as any,
    {
      id: 'if_1', name: 'Check', type: 'if', expression: '@true',
      actions: [
        { id: 'act_1', name: 'Post_status', type: 'action', kind: 'http',
          inputs: { url: 'https://x', body: { at: "@{formatDateTime(utcNow(), 'o')}" } } } as any,
      ],
      elseActions: [],
    } as any,
    {
      id: 'fe_1', name: 'ForEach_item', type: 'foreach', itemsExpression: '@createArray(1)',
      actions: [
        { id: 'con_2', name: 'Tag_item', type: 'connector', connector: 'sp', operation: 'UpdateItem',
          params: { id: '@item()', tag: '@rand(1,10)' } } as any,
      ],
    } as any,
  ],
};

describe('computeVolatileInputPaths', () => {
  it('collects dotted paths for utcNow/guid/rand across nesting (if branches, loop bodies)', () => {
    const masks = computeVolatileInputPaths(ir);
    assert.deepEqual(masks.get('Create_item')?.sort(), ['body.Ref', 'body.Stamp']);
    assert.deepEqual(masks.get('Post_status'), ['body.at']);
    assert.deepEqual(masks.get('Tag_item'), ['tag']);
    assert.equal(masks.has('Check'), false, 'condition expressions are not inputs');
    assert.equal(masks.has('manual'), false);
  });

  it('is case-insensitive and matches inside interpolations', () => {
    const one: FlowIR = {
      name: 'x',
      nodes: [{ id: 'c1', name: 'C', type: 'connector', connector: 'sp', operation: 'O',
        params: { a: "@{toUpper(GUID())}", b: 'plain' } } as any],
    };
    assert.deepEqual(computeVolatileInputPaths(one).get('C'), ['a']);
  });
});

describe('maskInputs', () => {
  it('deletes masked paths without touching the original', () => {
    const inputs = { list: 'A', body: { Title: 't', Stamp: '2026-07-26T00:00:00Z' } };
    const masked = maskInputs(inputs, ['body.Stamp']) as any;
    assert.deepEqual(masked, { list: 'A', body: { Title: 't' } });
    assert.equal(inputs.body.Stamp, '2026-07-26T00:00:00Z');
  });

  it('traverses array indices and ignores missing paths', () => {
    const masked = maskInputs({ rows: [{ v: 1 }, { v: 2 }] }, ['rows.1.v', 'no.such.path']) as any;
    assert.deepEqual(masked, { rows: [{ v: 1 }, {}] });
  });

  it('returns the input as-is for an empty mask', () => {
    const inputs = { a: 1 };
    assert.equal(maskInputs(inputs, undefined), inputs);
    assert.equal(maskInputs(inputs, []), inputs);
  });
});
