import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NodeDebugHost } from '../node-debug-host.js';
import type { DebugFlowSource } from '@flowforger/debug-core';

const CHILD_DSL = `
@Flow('ChildFlow')
class ChildFlow {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.compose('Echo', ctx.triggerBody());
  }
}
`;

describe('NodeDebugHost child flow resolution', () => {
  let dir: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-nodehost-'));
    fs.writeFileSync(path.join(dir, 'ChildFlow.ff.ts'), CHILD_DSL, 'utf-8');
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves by convention ({ref}.ff.ts next to parent) and compiles IR + source map + dsl', async () => {
    const host = new NodeDebugHost(() => {});
    const parent: DebugFlowSource = {
      key: path.join(dir, 'parent.ff.ts'),
      ir: { name: 'parent', nodes: [] },
      sourceMap: null,
      dslCode: null,
    };
    const child = await host.resolveChildFlow('ChildFlow', parent);
    assert.ok(child, 'child not resolved');
    assert.equal(child!.ir.name, 'ChildFlow');
    assert.ok(child!.sourceMap && child!.sourceMap.breakpointableLines.size > 0);
    assert.equal(child!.dslCode, CHILD_DSL);
    assert.equal(host.normalizeKey(child!.key), host.normalizeKey(path.join(dir, 'ChildFlow.ff.ts')));
  });

  it('resolves via ir.childFlows dslPath', async () => {
    const host = new NodeDebugHost(() => {});
    const parent: DebugFlowSource = {
      key: path.join(dir, 'parent.ff.ts'),
      ir: { name: 'parent', nodes: [], childFlows: { other: { dslPath: './ChildFlow.ff.ts' } } } as any,
      sourceMap: null,
      dslCode: null,
    };
    const child = await host.resolveChildFlow('other', parent);
    assert.ok(child, 'child not resolved via dslPath');
    assert.equal(child!.ir.name, 'ChildFlow');
  });

  it('returns null for unresolvable refs', async () => {
    const host = new NodeDebugHost(() => {});
    const parent: DebugFlowSource = {
      key: path.join(dir, 'parent.ff.ts'),
      ir: { name: 'parent', nodes: [] },
      sourceMap: null,
      dslCode: null,
    };
    assert.equal(await host.resolveChildFlow('NoSuchFlow', parent), null);
  });
});
