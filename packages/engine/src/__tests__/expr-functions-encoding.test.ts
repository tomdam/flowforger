import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tryEvaluate } from '../expr/evaluator.js';
import '../expr/functions/index.js';
import { makeExprContext } from './expr-fixtures.js';

const ctx = makeExprContext();
const ok = (e: string) => {
  const r = tryEvaluate(e, ctx);
  assert.equal(r.ok, true, `expected ok for ${e}: ${(r as any).reason ?? ''}`);
  return (r as { ok: true; value: any }).value;
};

describe('encoding / URI / binary / XML functions', () => {
  it('base64 round trips', () => {
    assert.equal(ok(`@base64('hi')`), 'aGk=');
    assert.equal(ok(`@base64ToString('aGk=')`), 'hi');
    assert.equal(ok(`@decodeBase64('aGk=')`), 'hi');
  });
  it('uriComponent family', () => {
    assert.equal(ok(`@uriComponent('a b')`), 'a%20b');
    assert.equal(ok(`@encodeUriComponent('a b')`), 'a%20b');
    assert.equal(ok(`@uriComponentToString('a%20b')`), 'a b');
    assert.equal(ok(`@decodeUriComponent('a%20b')`), 'a b');
  });
  it('dataUri family', () => {
    assert.equal(ok(`@dataUri('hi')`), 'data:text/plain;charset=utf-8;base64,aGk=');
    assert.equal(ok(`@dataUriToString('data:text/plain;charset=utf-8;base64,aGk=')`), 'hi');
    assert.equal(ok(`@dataUriToString('data:,plain%20text')`), 'plain text');
  });
  it('binary shapes', () => {
    assert.deepEqual(ok(`@binary('hi')`), { '$content-type': 'application/octet-stream', '$content': 'aGk=' });
    assert.deepEqual(ok(`@base64ToBinary('aGk=')`), { '$content-type': 'application/octet-stream', '$content': 'aGk=' });
    assert.deepEqual(ok(`@dataUriToBinary('data:text/plain;base64,aGk=')`), { '$content-type': 'text/plain', '$content': 'aGk=' });
    assert.deepEqual(ok(`@decodeDataUri('data:text/plain;base64,aGk=')`), { '$content-type': 'text/plain', '$content': 'aGk=' });
    assert.deepEqual(ok(`@uriComponentToBinary('a%20b')`), { '$content-type': 'application/octet-stream', '$content': 'YSBi' });
  });
  it('xml canonicalizes; non-string input stringified', () => {
    assert.equal(ok(`@xml('<r><a>1</a></r>')`), '<r><a>1</a></r>');
    assert.equal(ok(`@xml(json('{"a":1}'))`), '{"a":1}');
  });
  it('xpath node sets and primitives', () => {
    assert.deepEqual(ok(`@xpath(xml('<r><a>1</a><a>2</a></r>'), '//a/text()')`), ['1', '2']);
    assert.equal(ok(`@xpath(xml('<r><a>1</a></r>'), 'count(//a)')`), 1);
    assert.deepEqual(ok(`@xpath('', '//a')`), []);
  });
  it('uri part extractors', () => {
    const u = `'https://user@x.com:8080/p/q?k=1#frag'`;
    assert.equal(ok(`@uriHost(${u})`), 'x.com');
    assert.equal(ok(`@uriPath(${u})`), '/p/q');
    assert.equal(ok(`@uriPathAndQuery(${u})`), '/p/q?k=1');
    assert.equal(ok(`@uriPort(${u})`), 8080);
    assert.equal(ok(`@uriPort('https://x.com/p')`), 443); // default from scheme
    assert.equal(ok(`@uriQuery(${u})`), '?k=1');
    assert.equal(ok(`@uriScheme(${u})`), 'https');
    assert.equal(ok(`@uriHost('notaurl')`), '');
    assert.equal(ok(`@uriPort('notaurl')`), 0);
  });
});
