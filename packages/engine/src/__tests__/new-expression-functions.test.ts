import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evalExpression } from '../expressions.js';
import type { RunContext } from '../index.js';

function makeContext(now = '2026-01-15T12:30:45Z'): RunContext {
  return {
    variables: {},
    actions: new Map(),
    triggerData: {},
    workflowName: 'test',
    parameters: {},
    now: () => new Date(now),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: () => {},
    secrets: () => undefined,
    connector: () => { throw new Error('no connector'); },
  };
}

describe('Cat 1: type conversion / inspection', () => {
  const ctx = makeContext();

  it('array wraps a value in an array', () => {
    assert.deepEqual(evalExpression(`@array('hello')`, ctx), ['hello']);
  });

  it('bool converts string "true"/"false"', () => {
    assert.equal(evalExpression(`@bool('true')`, ctx), true);
    assert.equal(evalExpression(`@bool('false')`, ctx), false);
  });

  it('bool converts numbers (0 false, nonzero true)', () => {
    assert.equal(evalExpression(`@bool(0)`, ctx), false);
    assert.equal(evalExpression(`@bool(1)`, ctx), true);
  });

  it('decimal returns a number', () => {
    assert.equal(evalExpression(`@decimal('3.14')`, ctx), 3.14);
  });

  it('isFloat detects floats vs ints', () => {
    assert.equal(evalExpression(`@isFloat('3.14')`, ctx), true);
    assert.equal(evalExpression(`@isFloat('3')`, ctx), false);
    assert.equal(evalExpression(`@isFloat('foo')`, ctx), false);
  });

  it('isInt detects ints', () => {
    assert.equal(evalExpression(`@isInt('42')`, ctx), true);
    assert.equal(evalExpression(`@isInt('-7')`, ctx), true);
    assert.equal(evalExpression(`@isInt('3.14')`, ctx), false);
    assert.equal(evalExpression(`@isInt('foo')`, ctx), false);
  });

  it('nthIndexOf finds the n-th occurrence', () => {
    // "a-b-a-b-a" — 'a' appears at indexes 0, 4, 8
    assert.equal(evalExpression(`@nthIndexOf('a-b-a-b-a', 'a', 1)`, ctx), 0);
    assert.equal(evalExpression(`@nthIndexOf('a-b-a-b-a', 'a', 2)`, ctx), 4);
    assert.equal(evalExpression(`@nthIndexOf('a-b-a-b-a', 'a', 3)`, ctx), 8);
    assert.equal(evalExpression(`@nthIndexOf('a-b-a-b-a', 'a', 4)`, ctx), -1);
  });
});

describe('Cat 2: collection helpers', () => {
  const ctx = makeContext();

  it('chunk splits an array into N-sized pieces', () => {
    assert.deepEqual(
      evalExpression(`@chunk(createArray(1, 2, 3, 4, 5), 2)`, ctx),
      [[1, 2], [3, 4], [5]]
    );
  });

  it('slice on string', () => {
    assert.equal(evalExpression(`@slice('hello world', 6)`, ctx), 'world');
    assert.equal(evalExpression(`@slice('hello world', 0, 5)`, ctx), 'hello');
  });

  it('slice on array', () => {
    assert.deepEqual(
      evalExpression(`@slice(createArray('a', 'b', 'c', 'd'), 1, 3)`, ctx),
      ['b', 'c']
    );
  });

  it('sort sorts primitives ascending', () => {
    assert.deepEqual(evalExpression(`@sort(createArray(3, 1, 2))`, ctx), [1, 2, 3]);
  });

  it('reverse reverses an array', () => {
    assert.deepEqual(evalExpression(`@reverse(createArray(1, 2, 3))`, ctx), [3, 2, 1]);
  });

  it('reverse reverses a string', () => {
    assert.equal(evalExpression(`@reverse('hello')`, ctx), 'olleh');
  });
});

describe('Cat 3: object property functions', () => {
  const ctx = makeContext();

  it('addProperty adds a new property', () => {
    const obj = evalExpression(`@addProperty(json('{"a":1}'), 'b', 2)`, ctx);
    assert.deepEqual(obj, { a: 1, b: 2 });
  });

  it('addProperty throws if property already exists', () => {
    assert.throws(() => evalExpression(`@addProperty(json('{"a":1}'), 'a', 99)`, ctx), /already exists/);
  });

  it('setProperty updates an existing property', () => {
    const obj = evalExpression(`@setProperty(json('{"a":1}'), 'a', 99)`, ctx);
    assert.deepEqual(obj, { a: 99 });
  });

  it('setProperty creates a new property when missing', () => {
    const obj = evalExpression(`@setProperty(json('{"a":1}'), 'b', 2)`, ctx);
    assert.deepEqual(obj, { a: 1, b: 2 });
  });

  it('removeProperty removes a property', () => {
    const obj = evalExpression(`@removeProperty(json('{"a":1,"b":2}'), 'b')`, ctx);
    assert.deepEqual(obj, { a: 1 });
  });
});

describe('Cat 4: date/time — components & boundaries', () => {
  const ctx = makeContext();

  it('ticks returns 100-ns intervals since 0001-01-01', () => {
    // ticks at Unix epoch
    assert.equal(evalExpression(`@ticks('1970-01-01T00:00:00Z')`, ctx), 621355968000000000);
  });

  it('dayOfMonth', () => {
    assert.equal(evalExpression(`@dayOfMonth('2026-04-22T10:00:00Z')`, ctx), 22);
  });

  it('dayOfWeek (0=Sunday)', () => {
    // 2026-04-22 is a Wednesday → 3
    assert.equal(evalExpression(`@dayOfWeek('2026-04-22T10:00:00Z')`, ctx), 3);
  });

  it('dayOfYear', () => {
    assert.equal(evalExpression(`@dayOfYear('2026-01-01T00:00:00Z')`, ctx), 1);
    assert.equal(evalExpression(`@dayOfYear('2026-12-31T00:00:00Z')`, ctx), 365);
  });

  it('startOfDay zeros out time-of-day', () => {
    assert.equal(evalExpression(`@startOfDay('2026-01-15T12:34:56Z')`, ctx), '2026-01-15T00:00:00.000Z');
  });

  it('startOfHour zeros out minutes/seconds', () => {
    assert.equal(evalExpression(`@startOfHour('2026-01-15T12:34:56Z')`, ctx), '2026-01-15T12:00:00.000Z');
  });

  it('startOfMonth zeros out the month', () => {
    assert.equal(evalExpression(`@startOfMonth('2026-01-15T12:34:56Z')`, ctx), '2026-01-01T00:00:00.000Z');
  });
});

describe('Cat 4: date/time — arithmetic', () => {
  const ctx = makeContext('2026-01-15T12:00:00Z');

  it('addToTime adds days/hours/minutes', () => {
    assert.equal(evalExpression(`@addToTime('2026-01-15T12:00:00Z', 3, 'Day')`, ctx), '2026-01-18T12:00:00.000Z');
    assert.equal(evalExpression(`@addToTime('2026-01-15T12:00:00Z', 5, 'Hour')`, ctx), '2026-01-15T17:00:00.000Z');
  });

  it('subtractFromTime subtracts intervals', () => {
    assert.equal(evalExpression(`@subtractFromTime('2026-01-15T12:00:00Z', 1, 'Day')`, ctx), '2026-01-14T12:00:00.000Z');
  });

  it('addToTime supports Month and Year', () => {
    assert.equal(evalExpression(`@addToTime('2026-01-15T12:00:00Z', 2, 'Month')`, ctx), '2026-03-15T12:00:00.000Z');
    assert.equal(evalExpression(`@addToTime('2026-01-15T12:00:00Z', 1, 'Year')`, ctx), '2027-01-15T12:00:00.000Z');
  });

  it('getFutureTime offsets ctx.now()', () => {
    // ctx.now() = 2026-01-15T12:00:00Z, +1 hour → 13:00
    assert.equal(evalExpression(`@getFutureTime(1, 'Hour')`, ctx), '2026-01-15T13:00:00.000Z');
  });

  it('getPastTime offsets ctx.now() backwards', () => {
    assert.equal(evalExpression(`@getPastTime(1, 'Day')`, ctx), '2026-01-14T12:00:00.000Z');
  });

  it('dateDifference under one day', () => {
    assert.equal(
      evalExpression(`@dateDifference('2026-01-15T12:00:00Z', '2026-01-15T13:30:45Z')`, ctx),
      '01:30:45'
    );
  });

  it('dateDifference over multiple days', () => {
    assert.equal(
      evalExpression(`@dateDifference('2026-01-15T12:00:00Z', '2026-01-18T13:00:00Z')`, ctx),
      '3.01:00:00'
    );
  });
});

describe('Cat 4: date/time — timezone conversion', () => {
  const ctx = makeContext();

  it('convertFromUtc with IANA name', () => {
    // 2026-06-15T12:00:00Z → New York DST = -4h → 08:00 local
    assert.equal(
      evalExpression(`@convertFromUtc('2026-06-15T12:00:00Z', 'America/New_York')`, ctx),
      '2026-06-15T08:00:00'
    );
  });

  it('convertFromUtc with Windows name', () => {
    assert.equal(
      evalExpression(`@convertFromUtc('2026-06-15T12:00:00Z', 'Eastern Standard Time')`, ctx),
      '2026-06-15T08:00:00'
    );
  });

  it('convertToUtc round-trips', () => {
    // Local 08:00 EDT → UTC 12:00
    assert.equal(
      evalExpression(`@convertToUtc('2026-06-15T08:00:00', 'America/New_York')`, ctx),
      '2026-06-15T12:00:00.000Z'
    );
  });

  it('convertTimeZone Berlin → Tokyo', () => {
    // 2026-06-15T12:00:00 in Berlin (CEST = UTC+2) → 10:00 UTC → 19:00 Tokyo (UTC+9)
    assert.equal(
      evalExpression(`@convertTimeZone('2026-06-15T12:00:00', 'W. Europe Standard Time', 'Tokyo Standard Time')`, ctx),
      '2026-06-15T19:00:00'
    );
  });
});

describe('Cat 5: URI parsing', () => {
  const ctx = makeContext();
  const url = `'https://example.com:8080/path/to/resource?query=value&other=1#frag'`;

  it('uriHost', () => {
    assert.equal(evalExpression(`@uriHost(${url})`, ctx), 'example.com');
  });

  it('uriPath', () => {
    assert.equal(evalExpression(`@uriPath(${url})`, ctx), '/path/to/resource');
  });

  it('uriPathAndQuery', () => {
    assert.equal(evalExpression(`@uriPathAndQuery(${url})`, ctx), '/path/to/resource?query=value&other=1');
  });

  it('uriPort returns explicit port', () => {
    assert.equal(evalExpression(`@uriPort(${url})`, ctx), 8080);
  });

  it('uriPort returns default https port when omitted', () => {
    assert.equal(evalExpression(`@uriPort('https://example.com/foo')`, ctx), 443);
  });

  it('uriQuery includes the leading ?', () => {
    assert.equal(evalExpression(`@uriQuery(${url})`, ctx), '?query=value&other=1');
  });

  it('uriScheme strips the trailing colon', () => {
    assert.equal(evalExpression(`@uriScheme(${url})`, ctx), 'https');
  });
});
