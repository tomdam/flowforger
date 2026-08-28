import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowIR } from '@flowforger/ir';
import type { DslSourceMap } from '@flowforger/dsl-native';
import { DebugSession } from '../debug-session.js';
import { createInMemoryHost } from './test-host.js';

const emptySourceMap: DslSourceMap = {
  lineToNodeId: new Map(),
  nodeIdToLines: new Map() as DslSourceMap['nodeIdToLines'],
  breakpointableLines: new Set(),
};

const saveFileValue = (fileName: string) => ({
  '@@ff:saveFile': true,
  fileName,
  contentType: 'text/plain',
  content: 'hello',
});

async function runToCompletion(ir: FlowIR, children: Record<string, any> = {}): Promise<DebugSession> {
  let terminated!: () => void;
  const done = new Promise<void>((res) => (terminated = res));
  const session = new DebugSession(
    { key: `${ir.name}.ff.ts`, ir, sourceMap: emptySourceMap, dslCode: null },
    createInMemoryHost(children),
    {},
    {},
    {},
    false,
    {
      onStopped: () => {},
      onOutput: () => {},
      onTerminated: () => terminated(),
    },
  );
  await session.start();
  await done;
  return session;
}

describe('file artifacts in debug sessions', () => {
  it('collects a saveFile compose artifact onto the root context', async () => {
    const ir: FlowIR = {
      name: 'artifacts-root',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        {
          id: 'act_save',
          name: 'Save_report',
          type: 'action',
          kind: 'compose',
          inputs: { value: saveFileValue('report.txt') },
        } as any,
      ],
    };

    const session = await runToCompletion(ir);
    const artifacts = session.getRootContext().artifacts ?? [];
    assert.equal(artifacts.length, 1, 'expected exactly one artifact');
    assert.equal(artifacts[0].fileName, 'report.txt');
    assert.equal(artifacts[0].contentType, 'text/plain');
    assert.equal(artifacts[0].content, 'hello');
  });

  it('funnels a child flow saveFile artifact into the root context', async () => {
    const childIr: FlowIR = {
      name: 'child',
      nodes: [
        { id: 'trg_c', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        {
          id: 'act_csave',
          name: 'Save_child_file',
          type: 'action',
          kind: 'compose',
          inputs: { value: saveFileValue('child.txt') },
        } as any,
      ],
    };
    const parentIr: FlowIR = {
      name: 'artifacts-parent',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: { method: 'GET' } } as any,
        {
          id: 'act_call',
          name: 'Call_child',
          type: 'action',
          kind: 'workflow',
          inputs: { workflowReferenceName: 'childRef', body: {} },
        } as any,
      ],
    };

    const session = await runToCompletion(parentIr, {
      childRef: { key: 'child.ff.ts', ir: childIr, sourceMap: emptySourceMap, dslCode: null },
    });
    const artifacts = session.getRootContext().artifacts ?? [];
    assert.equal(artifacts.length, 1, 'expected the child artifact on the root context');
    assert.equal(artifacts[0].fileName, 'child.txt');
  });
});
