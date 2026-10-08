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

  // conformance/flows/binary.ff.ts
  it('decodeDataUri reads the URI as content: text as a string, JSON parsed, others as binary', () => {
    assert.equal(evalExpression(`@decodeDataUri('data:text/csv;base64,YSxi')`, ctx), 'a,b');
    assert.equal(evalExpression(`@decodeDataUri('data:,a%20b')`, ctx), 'a b');
    assert.deepEqual(evalExpression(`@decodeDataUri('data:application/json;base64,eyJhIjoxfQ==')`, ctx), { a: 1 });
    assert.deepEqual(evalExpression(`@decodeDataUri('data:image/png;base64,iVBORw0KGgo=')`, ctx), {
      '$content-type': 'image/png;charset=us-ascii',
      '$content': 'iVBORw0KGgo=',
    });
  });

  it('dataUriToBinary keeps the media type as written (text/plain when there is none)', () => {
    assert.deepEqual(evalExpression(`@dataUriToBinary('data:,hello%20world')`, ctx), {
      '$content-type': 'text/plain',
      '$content': 'aGVsbG8gd29ybGQ=',
    });
    assert.equal(evalExpression(`@dataUri(dataUriToBinary('data:image/png;base64,iVBORw0KGgo='))`, ctx), 'data:image/png;base64,iVBORw0KGgo=');
  });

  it('base64, dataUri, json and xml read binary content; base64ToString rejects it', () => {
    assert.equal(evalExpression(`@base64(binary('hi'))`, ctx), 'aGk=');
    assert.equal(evalExpression(`@dataUri(base64ToBinary('aGk='))`, ctx), 'data:application/octet-stream;base64,aGk=');
    assert.deepEqual(evalExpression(`@json(binary('{"a":1}'))`, ctx), { a: 1 });
    assert.equal(evalExpression(`@string(xml(binary('<r>1</r>')))`, ctx), '<r>1</r>');
    assert.throws(
      () => evalExpression(`@base64ToString(base64ToBinary('aGk='))`, ctx),
      /'base64ToString' expects its parameter to be a string\. The provided value is of type 'Object'/,
    );
  });

  it('rejects invalid base64, binary(null) and an invalid data URI', () => {
    assert.throws(() => evalExpression(`@base64ToBinary('not base64!')`, ctx), /cannot be decoded from base64 representation/);
    assert.equal(evalExpression(`@string(base64ToBinary('aG k='))`, ctx), 'hi');
    assert.throws(() => evalExpression(`@binary(null)`, ctx), /cannot be converted to the target type/);
    assert.equal(evalExpression(`@string(binary(true))`, ctx), 'True');
    assert.throws(() => evalExpression(`@dataUriToBinary('nope')`, ctx), /The provided value 'nope' was not formatted correctly/);
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
