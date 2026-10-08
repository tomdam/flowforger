import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tryEvaluate } from '../expr/evaluator.js';
import '../expr/functions/index.js';
import { makeExprContext } from './expr-fixtures.js';

// Fixture pins ctx.now() to 2026-01-15T10:30:00Z for deterministic asserts.
const ctx = makeExprContext();
const ok = (e: string) => {
  const r = tryEvaluate(e, ctx);
  assert.equal(r.ok, true, `expected ok for ${e}: ${(r as any).reason ?? ''}`);
  return (r as { ok: true; value: any }).value;
};
const fails = (e: string, message?: RegExp) => {
  const r = tryEvaluate(e, ctx);
  assert.equal(r.ok, false, `expected failure for ${e}`);
  if (message) assert.match(String(((r as any).error as Error)?.message), message);
};

const T = '2026-01-15T10:30:00Z';

describe('date/time functions', () => {
  it('utcNow uses ctx.now()', () => {
    assert.equal(ok('@utcNow()'), '2026-01-15T10:30:00.0000000Z');
  });
  it('parseDateTime ISO and de-DE formats', () => {
    assert.equal(ok(`@parseDateTime('${T}')`), '2026-01-15T10:30:00.0000000Z');
    // No zone in the input → no suffix on the output.
    assert.equal(ok(`@parseDateTime('15.01.2026', 'de-DE')`), '2026-01-15T00:00:00.0000000');
    fails(`@parseDateTime('garbage')`, /date time string 'garbage' was not valid/);
    fails(`@parseDateTime(null)`);
  });
  it('formatDateTime tokens', () => {
    assert.equal(ok(`@formatDateTime('${T}', 'yyyy-MM-dd')`), '2026-01-15');
    assert.equal(ok(`@formatDateTime('${T}', 'HH:mm:ss')`), '10:30:00');
    assert.equal(ok(`@formatDateTime('${T}')`), '2026-01-15T10:30:00.0000000Z');
    // The input's kind is kept: no zone → no suffix, an offset → converted to UTC with '+00:00'.
    assert.equal(ok(`@formatDateTime('2026-01-15')`), '2026-01-15T00:00:00.0000000');
    assert.equal(ok(`@formatDateTime('2026-01-15T12:30:00+02:00')`), '2026-01-15T10:30:00.0000000+00:00');
    fails(`@formatDateTime('garbage', 'yyyy')`, /In function 'formatDateTime', the value provided for date time string 'garbage' was not valid/);
  });
  it('addDays / addHours / addMinutes / addSeconds', () => {
    assert.equal(ok(`@addDays('${T}', 3)`), '2026-01-18T10:30:00.0000000Z');
    assert.equal(ok(`@addDays('${T}', -1, 'yyyy-MM-dd')`), '2026-01-14');
    assert.equal(ok(`@addHours('${T}', 2)`), '2026-01-15T12:30:00.0000000Z');
    assert.equal(ok(`@addMinutes('${T}', 15)`), '2026-01-15T10:45:00.0000000Z');
    assert.equal(ok(`@addSeconds('${T}', 30)`), '2026-01-15T10:30:30.0000000Z');
    fails(`@addDays('garbage', 1)`);
  });
  it('addToTime / subtractFromTime', () => {
    assert.equal(ok(`@addToTime('${T}', 1, 'Day')`), '2026-01-16T10:30:00.0000000Z');
    assert.equal(ok(`@addToTime('${T}', 1, 'Month')`), '2026-02-15T10:30:00.0000000Z');
    assert.equal(ok(`@addToTime('2026-01-31T00:00:00Z', 1, 'Month')`), '2026-02-28T00:00:00.0000000Z'); // clamps to month end
    assert.equal(ok(`@subtractFromTime('${T}', 2, 'Hours')`), '2026-01-15T08:30:00.0000000Z');
  });
  it('getFutureTime / getPastTime relative to ctx.now()', () => {
    assert.equal(ok(`@getFutureTime(1, 'Day')`), '2026-01-16T10:30:00.0000000Z');
    assert.equal(ok(`@getPastTime(30, 'Minutes')`), '2026-01-15T10:00:00.0000000Z');
  });
  it('ticks', () => {
    assert.equal(ok(`@ticks('1970-01-01T00:00:00Z')`), 621355968000000000);
    fails(`@ticks('garbage')`);
  });
  it('dayOfMonth / dayOfWeek / dayOfYear', () => {
    assert.equal(ok(`@dayOfMonth('${T}')`), 15);
    assert.equal(ok(`@dayOfWeek('${T}')`), 4); // Thursday
    assert.equal(ok(`@dayOfYear('${T}')`), 15);
    fails(`@dayOfMonth('garbage')`);
  });
  it('startOfDay / startOfHour / startOfMonth', () => {
    assert.equal(ok(`@startOfDay('${T}')`), '2026-01-15T00:00:00.0000000Z');
    assert.equal(ok(`@startOfHour('${T}')`), '2026-01-15T10:00:00.0000000Z');
    assert.equal(ok(`@startOfMonth('${T}')`), '2026-01-01T00:00:00.0000000Z');
    assert.equal(ok(`@startOfDay('${T}', 'yyyy-MM-dd')`), '2026-01-15');
  });
  it('dateDifference d.HH:mm:ss shape', () => {
    assert.equal(ok(`@dateDifference('2026-01-15T10:00:00Z', '2026-01-15T11:30:05Z')`), '01:30:05');
    assert.equal(ok(`@dateDifference('2026-01-15T10:00:00Z', '2026-01-17T11:00:00Z')`), '2.01:00:00');
    assert.equal(ok(`@dateDifference('2026-01-15T11:00:00Z', '2026-01-15T10:00:00Z')`), '-01:00:00');
    fails(`@dateDifference('garbage', '${T}')`);
  });
  it('convertFromUtc / convertToUtc / convertTimeZone', () => {
    // Berlin is UTC+1 in January
    assert.equal(ok(`@convertFromUtc('${T}', 'W. Europe Standard Time')`), '2026-01-15T11:30:00.0000000');
    assert.equal(ok(`@convertFromUtc('${T}', 'UTC')`), '2026-01-15T10:30:00.0000000Z');
    assert.equal(ok(`@convertToUtc('2026-01-15T11:30:00', 'W. Europe Standard Time')`), '2026-01-15T10:30:00.0000000Z');
    assert.equal(ok(`@convertTimeZone('${T}', 'UTC', 'Tokyo Standard Time')`), '2026-01-15T19:30:00.0000000');
    // A Z-suffixed timestamp doesn't match a non-UTC source zone.
    fails(`@convertToUtc('${T}', 'W. Europe Standard Time')`, /convertToUtc' expects its second parameter to be a time zone matching/);
    assert.equal(ok(`@convertFromUtc('${T}', 'W. Europe Standard Time', 'HH:mm')`), '11:30');
    fails(`@convertFromUtc('garbage', 'UTC')`);
  });
});
