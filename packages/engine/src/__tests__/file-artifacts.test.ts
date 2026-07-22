import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, detectFileArtifact } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

describe('detectFileArtifact', () => {
  it('returns null for non-sentinel objects', () => {
    assert.equal(detectFileArtifact({ type: 'FFSaveFile', content: 'x' }, 'A'), null);
    assert.equal(detectFileArtifact('plain string', 'A'), null);
    assert.equal(detectFileArtifact(null, 'A'), null);
  });

  it('normalizes a text artifact and defaults encoding to utf8', () => {
    const a = detectFileArtifact({ '@@ff:saveFile': true, contentType: 'text/xml', content: '<x/>' }, 'MyAct');
    assert.deepEqual(a, { fileName: 'MyAct.xml', contentType: 'text/xml', content: '<x/>', encoding: 'utf8' });
  });

  it('keeps an explicit fileName and base64 encoding', () => {
    const a = detectFileArtifact(
      { '@@ff:saveFile': true, fileName: 'r.pdf', contentType: 'application/pdf', content: 'AAA=', encoding: 'base64' },
      'A',
    );
    assert.equal(a?.fileName, 'r.pdf');
    assert.equal(a?.encoding, 'base64');
  });

  it('falls back to .bin for unknown content types', () => {
    const a = detectFileArtifact({ '@@ff:saveFile': true, contentType: 'application/x-weird', content: 'x' }, 'A');
    assert.equal(a?.fileName, 'A.bin');
  });

  it('returns null when required fields are malformed', () => {
    assert.equal(detectFileArtifact({ '@@ff:saveFile': true, content: 'x' }, 'A'), null); // no contentType
    assert.equal(detectFileArtifact({ '@@ff:saveFile': true, contentType: 'text/plain', content: 123 }, 'A'), null); // content not string
  });
});

describe('run collects file artifacts', () => {
  it('collects compose sentinel into RunResult.artifacts while leaving outputs intact', async () => {
    const flow: FlowIR = {
      name: 'f',
      nodes: [
        { id: 'trg_1', type: 'trigger', name: 'When', kind: 'manual' } as any,
        {
          id: 'act_1',
          type: 'action',
          kind: 'compose',
          name: 'Dump',
          inputs: { value: { '@@ff:saveFile': true, contentType: 'text/xml', content: '<x/>' } },
        } as any,
      ],
    };
    const res = await run(flow);
    assert.equal(res.status, 'Succeeded');
    // outputs unchanged — production parity
    const step = res.trace.find((t) => t.name === 'Dump');
    assert.equal(step?.outputs['@@ff:saveFile'], true);
    // artifact collected
    assert.equal(res.artifacts?.length, 1);
    assert.equal(res.artifacts?.[0].fileName, 'Dump.xml');
  });
});
