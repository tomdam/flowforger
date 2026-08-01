import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SessionManager } from '../session-manager.js';
import { createServer } from '../server.js';

// The transformer requires the trigger and the flow body on separate
// decorated methods (@HttpTrigger / @Action) — a single combined method
// fails to compile with "No action method found". Untyped `let` declarations
// also break source-map line mapping, so every variable below is typed.
const DSL = `
import { Flow, HttpTrigger, Action } from '@flowforger/dsl-native';

@Flow({ name: 'Loopy' })
class Loopy {
  @HttpTrigger()
  trigger() {}

  @Action()
  run(ctx: any) {
    let items: number[] = [1, 2, 3];
    let sum: number = 0;
    for (const item of items) {
      sum += item;
    }
    let finished: boolean = true;
  }
}
`;

let dir: string;
let flowFile: string;
let manager: SessionManager;
let client: Client;

function payload(result: any): any {
  return JSON.parse(result.content[0].text);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-e2e-'));
  flowFile = path.join(dir, 'loopy.ff.ts');
  fs.writeFileSync(flowFile, DSL, 'utf-8');
  manager = new SessionManager({ connectorOptions: {}, cassetteRoot: path.join(dir, 'cassettes') });
  const server = createServer(manager);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'e2e', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
});

afterEach(async () => {
  await manager.stop();
  await client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('end-to-end agent loop', () => {
  it('breaks inside a loop, inspects iteration context, evaluates, and finishes', async () => {
    const started = payload(
      await client.callTool({
        name: 'debug_start',
        arguments: { file: flowFile, stopOnEntry: false, breakpoints: [{ action: 'Increment_sum' }] },
      }),
    );
    assert.equal(started.state, 'paused');
    assert.equal(started.node.name, 'Increment_sum');
    assert.ok(started.iteration, 'iteration context is reported inside a foreach');
    assert.equal(started.iteration.loop, 'ForEach_item');
    assert.equal(typeof started.iteration.index, 'number');
    // debug-core's updateIterationContext hard-codes totalIterations: 0 — the
    // engine does not expose the loop's total length. Rather than report a
    // misleading "of 0", the snapshot omits the field entirely (see
    // packages/mcp-server/src/session-manager.ts, iterationInfo()).
    assert.equal(started.iteration.total, undefined, 'total is omitted, not reported as a misleading 0');

    const stack = payload(await client.callTool({ name: 'debug_call_stack', arguments: {} }));
    assert.ok(Array.isArray(stack));
    assert.equal(stack[0].flow, 'Loopy');

    const evaluated = payload(await client.callTool({ name: 'debug_evaluate', arguments: { expression: 'sum' } }));
    assert.match(evaluated.result, /0/);

    const second = payload(await client.callTool({ name: 'debug_continue', arguments: {} }));
    assert.equal(second.state, 'paused');
    assert.equal(second.iteration.index, started.iteration.index + 1, 'iteration advanced');

    let snap = second;
    while (snap.state === 'paused') {
      snap = payload(await client.callTool({ name: 'debug_continue', arguments: {} }));
    }
    assert.equal(snap.state, 'terminated');
    assert.equal(snap.status, 'Succeeded');
  });

  it('never returns a tool result larger than the ceiling', async () => {
    await client.callTool({ name: 'debug_start', arguments: { file: flowFile } });
    const result: any = await client.callTool({
      name: 'debug_get_variables',
      arguments: { scope: 'all', depth: 6 },
    });
    assert.ok(result.content[0].text.length <= 16384 + 512, 'payload stays within the ceiling (plus JSON envelope)');
  });

  // Regression coverage for the hardest bug in this plan: a breakpoint pause
  // that fires while the agent is off polling (timeoutMs:0, or between calls)
  // must be held and delivered on the next call, never silently dropped so
  // the session runs on past it.
  it('delivers a breakpoint pause that fired while the agent was polling', async () => {
    await client.callTool({
      name: 'debug_start',
      arguments: { file: flowFile, stopOnEntry: true, breakpoints: [{ action: 'Increment_sum' }] },
    });
    const polled = payload(await client.callTool({ name: 'debug_continue', arguments: { timeoutMs: 0 } }));
    assert.equal(polled.state, 'running');
    await new Promise((r) => setTimeout(r, 300)); // breakpoint fires unobserved
    const claimed = payload(await client.callTool({ name: 'debug_continue', arguments: { timeoutMs: 1500 } }));
    assert.equal(claimed.state, 'paused', 'the unclaimed pause must not be dropped');
    assert.equal(claimed.node?.name, 'Increment_sum');
    // Inspection after claiming must reflect that position, not a session that ran on.
    const st = payload(await client.callTool({ name: 'debug_status', arguments: {} }));
    assert.equal(st.snapshot?.state, 'paused');
  });
});
