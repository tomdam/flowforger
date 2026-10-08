import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Node } from '@flowforger/ir';
import { failureReason } from '../debug-session.js';

const action = { id: 'act_1', name: 'Call_child', type: 'action', kind: 'workflow' } as unknown as Node;
const block = { id: 'sw_1', name: 'Switch', type: 'switch', cases: [] } as unknown as Node;

describe('failureReason', () => {
  it('uses the error message, with its code when there is one', () => {
    assert.equal(failureReason(action, { error: 'boom' }), 'boom');
    assert.equal(
      failureReason(action, { error: { code: 'InvalidTemplate', message: 'Unable to process template' } }),
      'InvalidTemplate: Unable to process template',
    );
  });

  it('reports the status code of a failed call that has no error (the cloud gives none)', () => {
    assert.equal(failureReason(action, { outputs: { statusCode: 502, body: { error: {} } } }), 'status code 502');
  });

  it('says a block failed because of a child, never "undefined"', () => {
    assert.equal(failureReason(block, {}), 'an action inside it failed');
    assert.equal(failureReason(action, {}), 'no error details');
  });
});
