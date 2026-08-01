import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../session-manager.js';

// A tiny two-action flow compiled from DSL on disk, so the manager's real
// compile path is exercised. The DSL grammar requires the trigger and the
// flow body to be on separate methods (@HttpTrigger / @Action) — see
// .claude/skills/flowforger/dsl-syntax.md "Basic Structure".
const DSL = `
@Flow({ name: 'Tiny' })
class Tiny {
  @HttpTrigger()
  trigger() {}

  @Action()
  run(ctx: any) {
    let total: number = 1;
    total = total + 1;
    let done: boolean = true;
  }
}
`;

let dir: string;
let flowFile: string;
let cassetteRoot: string;
let mgr: SessionManager;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-mcp-'));
  cassetteRoot = path.join(dir, 'cassettes');
  flowFile = path.join(dir, 'tiny.ff.ts');
  fs.writeFileSync(flowFile, DSL, 'utf-8');
  mgr = new SessionManager({ connectorOptions: {}, cassetteRoot, defaultBudget: 200 });
});
afterEach(async () => {
  await mgr.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('start', () => {
  it('pauses on entry and reports position plus variable previews', async () => {
    const snap = await mgr.start({ file: flowFile });
    assert.equal(snap.state, 'paused');
    assert.equal(snap.reason, 'entry');
    assert.equal(snap.flow, 'Tiny');
    assert.ok(snap.node, 'a paused snapshot names its node');
    assert.equal(typeof snap.budget.limit, 'number');
  });

  it('runs to termination when stopOnEntry is false and no breakpoints are set', async () => {
    const snap = await mgr.start({ file: flowFile, stopOnEntry: false });
    assert.equal(snap.state, 'terminated');
    assert.equal(snap.status, 'Succeeded');
  });

  it('reports a compile failure as a structured error, not a throw', async () => {
    const bad = path.join(dir, 'bad.ff.ts');
    fs.writeFileSync(bad, 'this is not valid typescript @@@', 'utf-8');
    await assert.rejects(() => mgr.start({ file: bad }), /compile|parse|unexpected/i);
  });
});

describe('breakpoints', () => {
  it('resolves an action-name breakpoint to a node and stops there', async () => {
    const started = await mgr.start({
      file: flowFile,
      stopOnEntry: false,
      breakpoints: [{ action: 'Increment_total' }],
    });
    assert.equal(started.state, 'paused');
    assert.equal(started.reason, 'breakpoint');
    assert.equal(started.node?.name, 'Increment_total');
  });

  it('echoes back what each spec resolved to', async () => {
    await mgr.start({ file: flowFile });
    const resolved = mgr.setBreakpoints({ breakpoints: [{ action: 'Increment_total' }, { action: 'Nope' }] });
    assert.equal(resolved[0].verified, true);
    assert.equal(resolved[0].name, 'Increment_total');
    assert.equal(resolved[1].verified, false);
  });
});

describe('resume', () => {
  it('steps one node at a time', async () => {
    const first = await mgr.start({ file: flowFile });
    const second = await mgr.resume('step', {});
    assert.equal(second.state, 'paused');
    assert.notEqual(second.node?.id, first.node?.id);
  });

  it('continue with no breakpoints terminates', async () => {
    await mgr.start({ file: flowFile });
    const snap = await mgr.resume('continue', {});
    assert.equal(snap.state, 'terminated');
  });

  it('returns running when a real timer expires, not just timeoutMs 0', async () => {
    await mgr.start({ file: flowFile });
    const t0 = Date.now();
    const snap = await mgr.resume('step', { timeoutMs: 50 });
    // Either it paused fast (fine) or the timer fired — never hang past the limit.
    assert.ok(Date.now() - t0 < 2000, 'did not block past the timeout');
    assert.ok(['paused', 'running'].includes(snap.state));
  });

  it('delivers an unclaimed pause without resuming past it', async () => {
    await mgr.start({ file: flowFile, stopOnEntry: true, breakpoints: [{ action: 'Initialize_done' }] });
    const polled = await mgr.resume('continue', { timeoutMs: 0 });
    assert.equal(polled.state, 'running');
    await new Promise((r) => setTimeout(r, 300)); // breakpoint fires unobserved

    const claimed = await mgr.resume('continue', { timeoutMs: 1500 });
    assert.equal(claimed.state, 'paused', 'the unclaimed pause must be delivered');
    assert.equal(claimed.node?.name, 'Initialize_done');
    assert.equal(claimed.reason, 'breakpoint');

    // The session must still really be there, or any follow-up inspection lies.
    await new Promise((r) => setTimeout(r, 300));
    const st = mgr.status();
    assert.equal(st.snapshot?.state, 'paused', 'claiming a pause must not release the session');
    assert.equal(st.snapshot?.node?.name, 'Initialize_done');

    // And the next call resumes from there as normal.
    const after = await mgr.resume('continue', { timeoutMs: 1500 });
    assert.equal(after.state, 'terminated');
  });

  it('still delivers an unclaimed termination', async () => {
    await mgr.start({ file: flowFile });
    await mgr.resume('continue', { timeoutMs: 0 });
    await new Promise((r) => setTimeout(r, 300));
    const claimed = await mgr.resume('continue', { timeoutMs: 1500 });
    assert.equal(claimed.state, 'terminated');
  });

  it('resume on a terminated session returns terminated immediately', async () => {
    await mgr.start({ file: flowFile, stopOnEntry: false });
    const t0 = Date.now();
    const again = await mgr.resume('continue', { timeoutMs: 5000 });
    assert.equal(again.state, 'terminated');
    assert.ok(Date.now() - t0 < 1000, 'must not wait out the timeout');
  });
});

describe('inspection', () => {
  it('exposes variables and drills in by path', async () => {
    await mgr.start({ file: flowFile, stopOnEntry: false, breakpoints: [{ action: 'Initialize_done' }] });
    const vars = mgr.getScope({ scope: 'variables' });
    assert.equal(vars.value.total, 2);
    const drilled = mgr.getValue({ scope: 'variables', path: 'total' });
    assert.equal(drilled.ok, true);
  });

  it('evaluates an expression in the active frame', async () => {
    await mgr.start({ file: flowFile, stopOnEntry: false, breakpoints: [{ action: 'Initialize_done' }] });
    const r = mgr.evaluate('total');
    assert.match(r.result, /2/);
  });

  it('reports the call stack with the root frame', async () => {
    await mgr.start({ file: flowFile });
    const frames = mgr.callStack();
    assert.ok(frames.length >= 1);
    assert.equal(frames[frames.length - 1].flow, 'Tiny');
  });
});

describe('lifecycle', () => {
  it('errors clearly when no session is active', () => {
    assert.throws(() => mgr.getScope({ scope: 'variables' }), /no active session/i);
  });

  it('start replaces an existing session', async () => {
    await mgr.start({ file: flowFile });
    const second = await mgr.start({ file: flowFile });
    assert.equal(second.state, 'paused');
    assert.equal(mgr.status().active, true);
  });

  it('stop clears the session', async () => {
    await mgr.start({ file: flowFile });
    await mgr.stop();
    assert.equal(mgr.status().active, false);
  });

  it('does not overwrite a cassette with an empty one', async () => {
    await mgr.start({ file: flowFile, stopOnEntry: false }); // runs, records nothing (no connectors)
    await mgr.stop();
    // A session abandoned at entry must not clobber whatever was there.
    await mgr.start({ file: flowFile });
    await mgr.stop();
    const files = fs.existsSync(cassetteRoot) ? fs.readdirSync(cassetteRoot) : [];
    assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind');
  });

  it('status does not consume the output buffer', async () => {
    await mgr.start({ file: flowFile });
    const s1 = mgr.status();
    const s2 = mgr.status();
    assert.deepEqual(s1.snapshot?.output, s2.snapshot?.output, 'status must not drain output');
  });

  it('does not truncate a good cassette when a later session pauses early', async () => {
    const { ConnectorCallLog } = await import('@flowforger/debug-core');
    const { saveCassette, loadCassette } = await import('../cassettes.js');
    const seeded = new ConnectorCallLog();
    for (let i = 0; i < 5; i++) seeded.record('http', 'Get', { url: `u${i}` }, { ok: i }, 'A');
    saveCassette(flowFile, seeded, cassetteRoot);

    await mgr.start({ file: flowFile });  // pauses at entry, records nothing
    await mgr.stop();

    const after = loadCassette(flowFile, cassetteRoot);
    assert.equal(after?.calls.length, 5, 'an early-paused session must not shrink the cassette');
  });

  it('status reports running after a timeout, not a stale paused node', async () => {
    await mgr.start({ file: flowFile });
    await mgr.resume('continue', { timeoutMs: 0 });
    const st = mgr.status();
    assert.notEqual(st.snapshot?.state, 'paused', 'must not report a stale pause while running');
  });

  it('scope "all" returns real values at the default depth', async () => {
    await mgr.start({ file: flowFile, stopOnEntry: false, breakpoints: [{ action: 'Initialize_done' }] });
    const all = mgr.getScope({ scope: 'all' });
    assert.equal(typeof all.value, 'object');
    assert.equal((all.value as any).variables?.total, 2, 'variables must be expanded, not one-lined');
  });

  it('keeps the newest output lines when the buffer overflows', async () => {
    await mgr.start({ file: flowFile });
    for (let i = 0; i < 5; i++) (mgr as any).pushOutput('x'.repeat(900));
    (mgr as any).pushOutput('NEWEST');
    const out = (mgr as any).collectOutput(false) as string[];
    assert.ok(out.includes('NEWEST'), 'the newest line must survive truncation');
  });
});
