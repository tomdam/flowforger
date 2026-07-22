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
    connector: () => { throw new Error('no connector'); },
  };
}

const sampleXml =
  `<orders><order id="1" status="pending"><total>100</total></order>` +
  `<order id="2" status="paid"><total>200</total></order>` +
  `<order id="3" status="paid"><total>50</total></order></orders>`;

describe('xml()', () => {
  const ctx = makeContext();

  it('parses and re-serializes valid XML', () => {
    const r = evalExpression(`@xml('<root><a>1</a></root>')`, ctx);
    assert.equal(r, '<root><a>1</a></root>');
  });

  it('returns input as-is on invalid XML (best-effort)', () => {
    const r = evalExpression(`@xml('not even xml')`, ctx);
    assert.equal(typeof r, 'string');
    // xmldom is lenient; we only require that it doesn't throw
  });
});

describe('xpath() — node-set queries', () => {
  const ctx = makeContext();

  it('returns an array of element nodes serialized as XML strings', () => {
    const r = evalExpression(`@xpath(xml('${sampleXml}'), '/orders/order')`, ctx);
    assert.ok(Array.isArray(r));
    assert.equal(r.length, 3);
    assert.match(r[0], /<order[^>]*id="1"/);
    assert.match(r[1], /<order[^>]*id="2"/);
    assert.match(r[2], /<order[^>]*id="3"/);
  });

  it('filters nodes via predicate', () => {
    const r = evalExpression(`@xpath(xml('${sampleXml}'), '/orders/order[@status="paid"]')`, ctx);
    assert.equal(r.length, 2);
  });

  it('returns text node content', () => {
    const r = evalExpression(`@xpath(xml('${sampleXml}'), '/orders/order[1]/total/text()')`, ctx);
    assert.deepEqual(r, ['100']);
  });

  it('returns attribute values', () => {
    const r = evalExpression(`@xpath(xml('${sampleXml}'), '/orders/order/@id')`, ctx);
    assert.deepEqual(r, ['1', '2', '3']);
  });

  it('returns empty array when no matches', () => {
    const r = evalExpression(`@xpath(xml('${sampleXml}'), '/orders/customer')`, ctx);
    assert.deepEqual(r, []);
  });
});

describe('xpath() — value-returning queries', () => {
  const ctx = makeContext();

  it('count() returns a number, not an array', () => {
    const r = evalExpression(`@xpath(xml('${sampleXml}'), 'count(/orders/order)')`, ctx);
    assert.equal(r, 3);
  });

  it('sum() returns a number', () => {
    const r = evalExpression(`@xpath(xml('${sampleXml}'), 'sum(/orders/order/total)')`, ctx);
    assert.equal(r, 350);
  });

  it('string() of a node returns its string value', () => {
    const r = evalExpression(`@xpath(xml('${sampleXml}'), 'string(/orders/order[1]/total)')`, ctx);
    assert.equal(r, '100');
  });

  it('boolean() returns a JS boolean', () => {
    assert.equal(evalExpression(`@xpath(xml('${sampleXml}'), 'boolean(/orders/order)')`, ctx), true);
    assert.equal(evalExpression(`@xpath(xml('${sampleXml}'), 'boolean(/orders/customer)')`, ctx), false);
  });
});

describe('xpath() — namespace handling via local-name()', () => {
  const ctx = makeContext();
  const namespacedXml = `<root xmlns="http://example.com"><item>foo</item><item>bar</item></root>`;

  it('uses local-name() to bypass default namespaces', () => {
    const r = evalExpression(
      `@xpath(xml('${namespacedXml}'), '//*[local-name()="item"]/text()')`,
      ctx,
    );
    assert.deepEqual(r, ['foo', 'bar']);
  });
});

describe('xpath() — error handling', () => {
  const ctx = makeContext();

  it('throws on malformed XPath', () => {
    assert.throws(
      () => evalExpression(`@xpath(xml('<r/>'), '///bad[[[')`, ctx),
      /invalid XPath/,
    );
  });

  it('returns [] for empty xml input', () => {
    assert.deepEqual(evalExpression(`@xpath('', '/x')`, ctx), []);
  });
});

describe('xpath() — works with non-xml() input', () => {
  const ctx = makeContext();

  it('accepts a raw XML string directly (no xml() wrapper)', () => {
    const r = evalExpression(`@xpath('<r><a>x</a></r>', '/r/a/text()')`, ctx);
    assert.deepEqual(r, ['x']);
  });
});
