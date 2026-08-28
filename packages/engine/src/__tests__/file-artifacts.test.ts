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

  it('infers base64 for binary content types when content is base64-shaped', () => {
    const b64 = Buffer.from('%PDF-1.7 fake').toString('base64');
    const a = detectFileArtifact(
      { '@@ff:saveFile': true, contentType: 'application/octet-stream', content: b64 },
      'A',
    );
    assert.equal(a?.encoding, 'base64');
    const pdf = detectFileArtifact({ '@@ff:saveFile': true, contentType: 'application/pdf', content: b64 }, 'A');
    assert.equal(pdf?.encoding, 'base64');
  });

  it('keeps utf8 for textual content types even when content is base64-shaped', () => {
    // "abcd" is valid base64, but text/plain content is text.
    const a = detectFileArtifact({ '@@ff:saveFile': true, contentType: 'text/plain', content: 'abcd' }, 'A');
    assert.equal(a?.encoding, 'utf8');
  });

  it('keeps utf8 for binary content types when content is not base64-shaped', () => {
    const a = detectFileArtifact(
      { '@@ff:saveFile': true, contentType: 'application/octet-stream', content: 'not base64!!' },
      'A',
    );
    assert.equal(a?.encoding, 'utf8');
  });

  it('respects an explicit utf8 encoding on a binary content type', () => {
    const a = detectFileArtifact(
      { '@@ff:saveFile': true, contentType: 'application/octet-stream', content: 'AAAA', encoding: 'utf8' },
      'A',
    );
    assert.equal(a?.encoding, 'utf8');
  });

  it('unwraps a Power Automate file-content object ($content/$contentType)', () => {
    const a = detectFileArtifact(
      {
        '@@ff:saveFile': true,
        fileName: 'r.pdf',
        content: { $content: 'AAAA', $contentType: 'application/pdf' },
      },
      'A',
    );
    assert.deepEqual(a, { fileName: 'r.pdf', contentType: 'application/pdf', content: 'AAAA', encoding: 'base64' });
  });

  it('unwraps the hyphenated $content-type variant and falls back to octet-stream', () => {
    const hyphen = detectFileArtifact(
      { '@@ff:saveFile': true, content: { $content: 'AAAA', '$content-type': 'image/png' } },
      'Shot',
    );
    assert.equal(hyphen?.contentType, 'image/png');
    assert.equal(hyphen?.fileName, 'Shot.png');
    const bare = detectFileArtifact({ '@@ff:saveFile': true, content: { $content: 'AAAA' } }, 'A');
    assert.equal(bare?.contentType, 'application/octet-stream');
    assert.equal(bare?.encoding, 'base64');
  });

  it('prefers an explicit contentType over the object own $contentType', () => {
    const a = detectFileArtifact(
      {
        '@@ff:saveFile': true,
        contentType: 'application/pdf',
        content: { $content: 'AAAA', $contentType: 'application/octet-stream' },
      },
      'A',
    );
    assert.equal(a?.contentType, 'application/pdf');
  });

  it('returns null for an object content without a string $content', () => {
    assert.equal(detectFileArtifact({ '@@ff:saveFile': true, content: { foo: 'bar' } }, 'A'), null);
    assert.equal(detectFileArtifact({ '@@ff:saveFile': true, content: { $content: 42 } }, 'A'), null);
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

  it('funnels a child workflow saveFile artifact into the parent RunResult', async () => {
    const childFlow: FlowIR = {
      name: 'child',
      nodes: [
        { id: 'trg_c', type: 'trigger', name: 'When', kind: 'manual' } as any,
        {
          id: 'act_c',
          type: 'action',
          kind: 'compose',
          name: 'DumpChild',
          inputs: { value: { '@@ff:saveFile': true, contentType: 'text/plain', content: 'hi' } },
        } as any,
      ],
    };
    const parentFlow: FlowIR = {
      name: 'parent',
      nodes: [
        { id: 'trg_1', type: 'trigger', name: 'When', kind: 'manual' } as any,
        {
          id: 'act_1',
          type: 'action',
          kind: 'workflow',
          name: 'Call_child',
          inputs: { workflowReferenceName: 'childRef', body: {} },
        } as any,
      ],
    };
    const res = await run(parentFlow, {
      loadChildFlow: async (ref) => (ref === 'childRef' ? childFlow : null),
    });
    assert.equal(res.status, 'Succeeded');
    assert.equal(res.artifacts?.length, 1);
    assert.equal(res.artifacts?.[0].fileName, 'DumpChild.txt');
  });
});
