import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConnectorCallLog } from '@flowforger/debug-core';
import { cassettePath, loadCassette, saveCassette, CASSETTE_VERSION } from '../cassettes.js';

let root: string;
const FLOW = path.resolve('/tmp/flows/invoice.ff.ts');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-cassette-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('cassettePath', () => {
  it('is stable for the same flow and differs across flows', () => {
    assert.equal(cassettePath(FLOW, root), cassettePath(FLOW, root));
    assert.notEqual(cassettePath(FLOW, root), cassettePath(path.resolve('/tmp/flows/other.ff.ts'), root));
  });

  it('ends in .json under the given root', () => {
    const p = cassettePath(FLOW, root);
    assert.equal(path.dirname(p), root);
    assert.ok(p.endsWith('.json'));
  });
});

describe('save/load round-trip', () => {
  it('returns null when no cassette exists', () => {
    assert.equal(loadCassette(FLOW, root), null);
  });

  it('round-trips recorded calls', () => {
    const log = new ConnectorCallLog();
    log.record('sharepoint', 'GetItems', { table: 'L1' }, { value: [{ Id: 1 }] }, 'Get_items');
    const result = saveCassette(FLOW, log, root);
    assert.deepEqual(result, { saved: 1, skipped: 0, partial: false });

    const loaded = loadCassette(FLOW, root);
    assert.ok(loaded);
    assert.equal(loaded!.calls.length, 1);
    assert.equal(loaded!.calls[0].connector, 'sharepoint');
    assert.equal(loaded!.calls[0].nodeName, 'Get_items');
    assert.deepEqual(loaded!.calls[0].response, { value: [{ Id: 1 }] });
  });

  it('skips calls that cannot survive a JSON round-trip and marks the cassette partial', () => {
    const log = new ConnectorCallLog();
    log.record('http', 'Get', { url: 'a' }, { ok: true }, 'A');
    log.record('onedrive', 'GetFile', { path: 'f.bin' }, new Uint8Array([1, 2, 3]), 'B');
    const result = saveCassette(FLOW, log, root);
    assert.equal(result.saved, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.partial, true);

    const loaded = loadCassette(FLOW, root);
    assert.equal(loaded!.calls.length, 1);
    assert.equal(loaded!.calls[0].connector, 'http');
  });

  it('overwrites a previous cassette for the same flow', () => {
    const first = new ConnectorCallLog();
    first.record('http', 'Get', { url: 'a' }, { n: 1 }, 'A');
    saveCassette(FLOW, first, root);

    const second = new ConnectorCallLog();
    second.record('http', 'Get', { url: 'b' }, { n: 2 }, 'B');
    saveCassette(FLOW, second, root);

    const loaded = loadCassette(FLOW, root);
    assert.equal(loaded!.calls.length, 1);
    assert.deepEqual(loaded!.calls[0].inputs, { url: 'b' });
  });

  it('detects binary nested inside the payload, not just at the top level', () => {
    const log = new ConnectorCallLog();
    log.record('http', 'Get', { url: 'a' }, { ok: true }, 'A');
    // The realistic shape: OneDrive/Word/Excel return file bytes under body.$content.
    log.record('onedrive', 'GetContent', { path: 'f.docx' }, { body: { $content: new Uint8Array([1, 2, 3]) } }, 'B');
    const result = saveCassette(FLOW, log, root);
    assert.equal(result.saved, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.partial, true);
    assert.equal(loadCassette(FLOW, root)!.calls[0].connector, 'http');
  });

  it('detects typed arrays other than Uint8Array', () => {
    const log = new ConnectorCallLog();
    log.record('x', 'Op', {}, { data: new Float32Array([1.5, 2.5]) }, 'A');
    assert.equal(saveCassette(FLOW, log, root).saved, 0);
  });

  it('does not hang on a cyclic payload', () => {
    const cyclic: any = { name: 'loop' };
    cyclic.self = cyclic;
    const log = new ConnectorCallLog();
    log.record('x', 'Op', {}, cyclic, 'A');
    // JSON.stringify throws on a cycle, so the call is dropped — but the
    // binary walk must terminate first rather than recursing forever.
    assert.equal(saveCassette(FLOW, log, root).saved, 0);
  });
});

describe('load resilience', () => {
  it('returns null on a corrupt file rather than throwing', () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(cassettePath(FLOW, root), '{ not json');
    assert.equal(loadCassette(FLOW, root), null);
  });

  it('returns null on a version mismatch', () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      cassettePath(FLOW, root),
      JSON.stringify({ version: CASSETTE_VERSION + 1, flowPath: FLOW, recordedAt: '', partial: false, calls: [] }),
    );
    assert.equal(loadCassette(FLOW, root), null);
  });

  it('rejects a cassette whose flowPath is a different flow', () => {
    const log = new ConnectorCallLog();
    log.record('http', 'Get', { url: 'a' }, { ok: true }, 'A');
    saveCassette(FLOW, log, root);
    // Simulate a hash collision / stray file: same filename, other flow inside.
    const file = cassettePath(FLOW, root);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    parsed.flowPath = path.resolve('/tmp/flows/somebody-elses.ff.ts');
    fs.writeFileSync(file, JSON.stringify(parsed));
    assert.equal(loadCassette(FLOW, root), null);
  });

  it('leaves no temp files behind after a save', () => {
    const log = new ConnectorCallLog();
    log.record('http', 'Get', { url: 'a' }, { ok: true }, 'A');
    saveCassette(FLOW, log, root);
    const leftovers = fs.readdirSync(root).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'temp file should have been renamed away');
  });
});
