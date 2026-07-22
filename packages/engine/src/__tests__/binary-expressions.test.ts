import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evalExpression } from '../expressions.js';
import type { RunContext } from '../index.js';

function makeContext(): RunContext {
  return {
    variables: {},
    actions: new Map(),
    triggerData: {},
    workflowName: 'test',
    parameters: {},
    now: () => new Date('2026-01-01T00:00:00Z'),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: () => {},
    secrets: () => undefined,
    connector: () => {
      throw new Error('no connector');
    },
  };
}

describe('binary and conversion expression functions', () => {
  const ctx = makeContext();

  it('decodeBase64 returns UTF-8 string', () => {
    assert.equal(evalExpression(`@decodeBase64('aGVsbG8=')`, ctx), 'hello');
  });

  it('decodeUriComponent decodes URI-encoded string', () => {
    assert.equal(evalExpression(`@decodeUriComponent('hello%20world')`, ctx), 'hello world');
  });

  it('encodeUriComponent encodes string', () => {
    assert.equal(evalExpression(`@encodeUriComponent('hello world')`, ctx), 'hello%20world');
  });

  it('xml passes string through (engine has no XML node type)', () => {
    assert.equal(evalExpression(`@xml('<root><a>1</a></root>')`, ctx), '<root><a>1</a></root>');
  });

  it('dataUri produces a base64 data URI', () => {
    assert.equal(evalExpression(`@dataUri('hello')`, ctx), 'data:text/plain;charset=utf-8;base64,aGVsbG8=');
  });

  it('dataUriToString round-trips dataUri', () => {
    assert.equal(evalExpression(`@dataUriToString('data:text/plain;charset=utf-8;base64,aGVsbG8=')`, ctx), 'hello');
  });

  it('dataUriToString handles non-base64 data URIs (URI-encoded)', () => {
    assert.equal(evalExpression(`@dataUriToString('data:text/plain;charset=utf-8,hello%20world')`, ctx), 'hello world');
  });

  it('base64ToBinary returns a binary object preserving the base64 content', () => {
    const r = evalExpression(`@base64ToBinary('aGVsbG8=')`, ctx);
    assert.deepEqual(r, { '$content-type': 'application/octet-stream', '$content': 'aGVsbG8=' });
  });

  it('binary returns a binary object encoding the input string', () => {
    const r = evalExpression(`@binary('hello')`, ctx);
    assert.deepEqual(r, { '$content-type': 'application/octet-stream', '$content': 'aGVsbG8=' });
  });

  it('dataUriToBinary preserves the content-type from the data URI', () => {
    const r = evalExpression(`@dataUriToBinary('data:text/plain;charset=utf-8;base64,aGVsbG8=')`, ctx);
    assert.deepEqual(r, { '$content-type': 'text/plain;charset=utf-8', '$content': 'aGVsbG8=' });
  });

  it('decodeDataUri behaves like dataUriToBinary', () => {
    const r = evalExpression(`@decodeDataUri('data:application/json;base64,eyJhIjoxfQ==')`, ctx);
    assert.deepEqual(r, { '$content-type': 'application/json', '$content': 'eyJhIjoxfQ==' });
  });

  it('uriComponentToBinary returns binary of decoded string', () => {
    const r = evalExpression(`@uriComponentToBinary('hello%20world')`, ctx);
    assert.deepEqual(r, { '$content-type': 'application/octet-stream', '$content': 'aGVsbG8gd29ybGQ=' });
  });

  it('round-trip: base64 → base64ToBinary preserves payload', () => {
    const encoded = evalExpression(`@base64('hello')`, ctx);
    const binary = evalExpression(`@base64ToBinary('${encoded}')`, ctx);
    assert.equal(binary['$content'], 'aGVsbG8=');
  });
});
