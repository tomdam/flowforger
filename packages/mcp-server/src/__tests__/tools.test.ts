import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SessionManager } from '../session-manager.js';
import { createServer } from '../server.js';

const DSL = `
import { Flow, HttpTrigger, Action } from '@flowforger/dsl-native';

@Flow({ name: 'Tiny' })
class Tiny {
  @HttpTrigger()
  trigger(ctx: any) {}

  @Action()
  run(ctx: any) {
    let total = 1;
    total = total + 1;
  }
}
`;

let dir: string;
let flowFile: string;
let manager: SessionManager;
let client: Client;

/** Parse the single text block every FlowForger tool returns. */
function payload(result: any): any {
  return JSON.parse(result.content[0].text);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-tools-'));
  flowFile = path.join(dir, 'tiny.ff.ts');
  fs.writeFileSync(flowFile, DSL, 'utf-8');

  manager = new SessionManager({ connectorOptions: {}, cassetteRoot: path.join(dir, 'cassettes') });
  const server = createServer(manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await manager.stop();
  await client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('tool registration', () => {
  it('exposes exactly the ten debug tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'debug_call_stack',
      'debug_continue',
      'debug_evaluate',
      'debug_get_value',
      'debug_get_variables',
      'debug_set_breakpoints',
      'debug_start',
      'debug_status',
      'debug_step',
      'debug_stop',
    ]);
  });

  it('does not expose debug_step_out', async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.find((t) => t.name === 'debug_step_out'), undefined);
  });
});

describe('tool round-trips', () => {
  it('debug_start returns a paused snapshot', async () => {
    const snap = payload(await client.callTool({ name: 'debug_start', arguments: { file: flowFile } }));
    assert.equal(snap.state, 'paused');
    assert.equal(snap.flow, 'Tiny');
  });

  it('debug_step advances and debug_continue terminates', async () => {
    await client.callTool({ name: 'debug_start', arguments: { file: flowFile } });
    const stepped = payload(await client.callTool({ name: 'debug_step', arguments: {} }));
    assert.equal(stepped.state, 'paused');
    const done = payload(await client.callTool({ name: 'debug_continue', arguments: {} }));
    assert.equal(done.state, 'terminated');
  });

  it('debug_get_variables returns previews', async () => {
    await client.callTool({ name: 'debug_start', arguments: { file: flowFile } });
    await client.callTool({ name: 'debug_step', arguments: {} });
    const vars = payload(await client.callTool({ name: 'debug_get_variables', arguments: { scope: 'variables' } }));
    assert.ok(vars.value);
  });

  it('returns a structured error rather than throwing when no session is active', async () => {
    const result: any = await client.callTool({ name: 'debug_evaluate', arguments: { expression: 'x' } });
    const body = payload(result);
    assert.ok(body.error, 'error field present');
    assert.match(body.error, /no active session/i);
    assert.ok(body.hint, 'hint field present');
  });

  it('debug_status reports liveness', async () => {
    const before = payload(await client.callTool({ name: 'debug_status', arguments: {} }));
    assert.equal(before.active, false);
    await client.callTool({ name: 'debug_start', arguments: { file: flowFile } });
    const after = payload(await client.callTool({ name: 'debug_status', arguments: {} }));
    assert.equal(after.active, true);
  });
});
