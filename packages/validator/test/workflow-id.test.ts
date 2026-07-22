import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateFlowIR } from '../src/index.js';
import type { FlowIR } from '@flowforger/ir';

function makeMinimalIR(overrides: Partial<FlowIR> = {}): FlowIR {
  return {
    name: 'TestFlow',
    nodes: [
      { type: 'trigger', kind: 'http', id: 'trg_1', name: 'manual', inputs: { method: 'POST' } } as any,
      { type: 'action', kind: 'compose', id: 'act_1', name: 'Result', inputs: { value: 'x' } } as any,
    ],
    ...overrides,
  };
}

describe('validateFlowIR — workflowId', () => {
  it('passes when workflowId is a valid GUID', () => {
    const ir = makeMinimalIR({ workflowId: '11111111-2222-3333-4444-555555555555' });
    const result = validateFlowIR(ir);
    const workflowIdIssues = result.issues.filter((i) => i.code === 'IR_WORKFLOW_ID');
    assert.strictEqual(workflowIdIssues.length, 0);
  });

  it('passes when workflowId is absent', () => {
    const ir = makeMinimalIR();
    const result = validateFlowIR(ir);
    const workflowIdIssues = result.issues.filter((i) => i.code === 'IR_WORKFLOW_ID');
    assert.strictEqual(workflowIdIssues.length, 0);
  });

  it('fails when workflowId is not a valid GUID', () => {
    const ir = makeMinimalIR({ workflowId: 'not-a-guid' });
    const result = validateFlowIR(ir);
    const workflowIdIssues = result.issues.filter((i) => i.code === 'IR_WORKFLOW_ID');
    assert.strictEqual(workflowIdIssues.length, 1);
    assert.strictEqual(workflowIdIssues[0].level, 'error');
    assert.strictEqual(result.ok, false);
  });
});
