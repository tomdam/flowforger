import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evalExpression } from '../expressions.js';
import { registry } from '../expr/functions/index.js';
import { KNOWN_FUNCTIONS } from '@flowforger/expressions';
import { makeExprContext } from './expr-fixtures.js';

// One+ row per registered function, evaluated through the PUBLIC evalExpression.
// This file is the standalone regression net that survives legacy-chain deletion.
// The fixture pins ctx.now() to 2026-01-15T10:30:00Z.

const ctx = makeExprContext();
(ctx as any).currentAction = { name: 'HttpCall', inputs: { u: 1 }, startTime: 't0' };
(ctx as any).scopeResults.set('Scope1', [{ name: 'a' }]);
(ctx as any).iterationStack = [{ loopName: 'L1', index: 3 }];
(ctx as any).callbackUrl = 'http://cb';
(ctx as any).actions.set('Form', {
  status: 'Succeeded',
  outputs: { body: { single: 'v1', multi: ['a', 'b'], $multipart: [{ body: 'p0' }] } },
});
(ctx as any).triggerData = {
  body: { id: 'trg-1', nested: { deep: 'yes' }, k: 'v', m: ['1', '2'], $multipart: [{ body: 'tp0' }] },
  headers: { h1: 'v1' },
};

const T = '2026-01-15T10:30:00Z';

const rows: Array<[string, unknown]> = [
  // references
  [`@variables('count')`, 5],
  [`@body('GetRows')?['value'][0].id`, 7],
  [`@actionBody('GetRows')['value'][0].name`, 'row7'],
  [`@outputs('HttpCall')['statusCode']`, 500],
  [`@actions('HttpCall').status`, 'Failed'],
  [`@action().inputs.u`, 1],
  [`@item().current`, true],
  [`@items('Rows')[0].id`, 1],
  [`@trigger().body.id`, 'trg-1'],
  [`@triggerBody().id`, 'trg-1'],
  [`@triggerOutputs()['body/nested/deep']`, 'yes'],
  [`@workflow().name`, 'TestFlow'],
  [`@parameters('WithDefault')`, 'dv'],
  [`@iterationIndexes('L1')`, 3],
  [`@listCallbackUrl()`, 'http://cb'],
  [`@result('Scope1')`, [{ name: 'a' }]],
  [`@formDataValue('Form', 'single')`, 'v1'],
  [`@formDataMultiValues('Form', 'multi')`, ['a', 'b']],
  [`@multipartBody('Form', 0)`, 'p0'],
  [`@triggerFormDataValue('k')`, 'v'],
  [`@triggerFormDataMultiValues('m')`, ['1', '2']],
  [`@triggerMultipartBody(0)`, 'tp0'],
  // logic
  [`@equals(101, '101')`, true],
  [`@greater('10', 9)`, true],
  [`@less(1, 2)`, true],
  [`@greaterOrEquals(2, 2)`, true],
  [`@ge(3, 2)`, true],
  [`@lessOrEquals(2, 2)`, true],
  [`@le(1, 2)`, true],
  [`@and(true, true, false)`, false],
  [`@or(false, true)`, true],
  [`@not(true)`, false],
  [`@not(@equals(1, 2))`, true], // redundant nested @ from older transformer output

  [`@if(equals(1, 1), 'y', 'n')`, 'y'],
  [`@coalesce(null, 'x')`, 'x'],
  [`@contains('hello', 'ell')`, true],
  [`@startsWith('hello', 'he')`, true],
  [`@endsWith('hello', 'lo')`, true],
  [`@empty('')`, true],
  [`@bool('TRUE')`, true],
  [`@isFloat('1.5')`, true],
  [`@isInt('15')`, true],
  // strings
  [`@concat('a', 'b', 1)`, 'ab1'],
  [`@substring('hello', 1, 3)`, 'ell'],
  [`@replace('a.b.c', '.', '-')`, 'a-b-c'],
  [`@toLower('ABC')`, 'abc'],
  [`@toUpper('abc')`, 'ABC'],
  [`@trim('  x  ')`, 'x'],
  [`@split('a,b', ',')`, ['a', 'b']],
  [`@join(createArray('a', 'b'), '-')`, 'a-b'],
  [`@indexOf('banana', 'an')`, 1],
  [`@lastIndexOf('banana', 'an')`, 3],
  [`@nthIndexOf('banana', 'an', 2)`, 3],
  [`@string(5)`, '5'],
  [`@length('abc')`, 3],
  [`@slice('hello', 1, 3)`, 'el'],
  [`@chunk(createArray(1, 2, 3), 2)`, [[1, 2], [3]]],
  [`@formatNumber(1234.5, 'N2', 'en-US')`, '1,234.50'],
  // collections
  [`@json('{"a":1}').a`, 1],
  [`@createArray('a', 1)`, ['a', 1]],
  [`@array('x')`, ['x']],
  [`@first(createArray(1, 2))`, 1],
  [`@last(createArray(1, 2))`, 2],
  [`@skip(createArray(1, 2, 3), 1)`, [2, 3]],
  [`@take(createArray(1, 2, 3), 2)`, [1, 2]],
  [`@union(createArray(1, 2), createArray(2, 3))`, [1, 2, 3]],
  [`@intersection(createArray(1, 2), createArray(2, 3))`, [2]],
  [`@range(2, 3)`, [2, 3, 4]],
  [`@sort(createArray(3, 1, 2))`, [1, 2, 3]],
  [`@reverse('abc')`, 'cba'],
  [`@addProperty(json('{"a":1}'), 'b', 2)`, { a: 1, b: 2 }],
  [`@setProperty(json('{"a":1}'), 'a', 9)`, { a: 9 }],
  [`@removeProperty(json('{"a":1,"b":2}'), 'b')`, { a: 1 }],
  // math
  [`@add(1, 2)`, 3],
  [`@sub(5, 3)`, 2],
  [`@mul(4, 3)`, 12],
  [`@div(10, 4)`, 2.5],
  [`@mod(10, 3)`, 1],
  [`@min(3, 5)`, 3],
  [`@max(3, 5)`, 5],
  [`@int('42')`, 42],
  [`@float('1.5')`, 1.5],
  [`@abs(-3)`, 3],
  [`@ceil(1.1)`, 2],
  [`@floor(1.9)`, 1],
  [`@round(1.5)`, 2],
  [`@decimal('1.5')`, 1.5],
  // datetime (ctx.now pinned)
  [`@utcNow()`, '2026-01-15T10:30:00.000Z'],
  [`@parseDateTime('15.01.2026', 'de-DE')`, '2026-01-15T00:00:00.000Z'],
  [`@formatDateTime('${T}', 'yyyy-MM-dd')`, '2026-01-15'],
  [`@addDays('${T}', 3)`, '2026-01-18T10:30:00.000Z'],
  [`@addHours('${T}', 2)`, '2026-01-15T12:30:00.000Z'],
  [`@addMinutes('${T}', 15)`, '2026-01-15T10:45:00.000Z'],
  [`@addSeconds('${T}', 30)`, '2026-01-15T10:30:30.000Z'],
  [`@addToTime('${T}', 1, 'Day')`, '2026-01-16T10:30:00.000Z'],
  [`@subtractFromTime('${T}', 2, 'Hours')`, '2026-01-15T08:30:00.000Z'],
  [`@getFutureTime(1, 'Day')`, '2026-01-16T10:30:00.000Z'],
  [`@getPastTime(30, 'Minutes')`, '2026-01-15T10:00:00.000Z'],
  [`@ticks('1970-01-01T00:00:00Z')`, 621355968000000000],
  [`@dayOfMonth('${T}')`, 15],
  [`@dayOfWeek('${T}')`, 4],
  [`@dayOfYear('${T}')`, 15],
  [`@startOfDay('${T}')`, '2026-01-15T00:00:00.000Z'],
  [`@startOfHour('${T}')`, '2026-01-15T10:00:00.000Z'],
  [`@startOfMonth('${T}')`, '2026-01-01T00:00:00.000Z'],
  [`@dateDifference('2026-01-15T10:00:00Z', '2026-01-15T11:30:05Z')`, '01:30:05'],
  [`@convertFromUtc('${T}', 'W. Europe Standard Time')`, '2026-01-15T11:30:00'],
  [`@convertToUtc('2026-01-15T11:30:00', 'W. Europe Standard Time')`, '2026-01-15T10:30:00.000Z'],
  [`@convertTimeZone('${T}', 'UTC', 'Tokyo Standard Time')`, '2026-01-15T19:30:00'],
  // encoding
  [`@base64('hi')`, 'aGk='],
  [`@base64ToString('aGk=')`, 'hi'],
  [`@decodeBase64('aGk=')`, 'hi'],
  [`@uriComponent('a b')`, 'a%20b'],
  [`@encodeUriComponent('a b')`, 'a%20b'],
  [`@uriComponentToString('a%20b')`, 'a b'],
  [`@decodeUriComponent('a%20b')`, 'a b'],
  [`@dataUri('hi')`, 'data:text/plain;charset=utf-8;base64,aGk='],
  [`@dataUriToString('data:text/plain;charset=utf-8;base64,aGk=')`, 'hi'],
  [`@base64ToBinary('aGk=')`, { '$content-type': 'application/octet-stream', '$content': 'aGk=' }],
  [`@binary('hi')`, { '$content-type': 'application/octet-stream', '$content': 'aGk=' }],
  [`@dataUriToBinary('data:text/plain;base64,aGk=')`, { '$content-type': 'text/plain', '$content': 'aGk=' }],
  [`@decodeDataUri('data:text/plain;base64,aGk=')`, { '$content-type': 'text/plain', '$content': 'aGk=' }],
  [`@uriComponentToBinary('a%20b')`, { '$content-type': 'application/octet-stream', '$content': 'YSBi' }],
  [`@xml('<r><a>1</a></r>')`, '<r><a>1</a></r>'],
  [`@xpath(xml('<r><a>1</a><a>2</a></r>'), '//a/text()')`, ['1', '2']],
  [`@uriHost('https://x.com:8080/p?q=1')`, 'x.com'],
  [`@uriPath('https://x.com:8080/p?q=1')`, '/p'],
  [`@uriPathAndQuery('https://x.com:8080/p?q=1')`, '/p?q=1'],
  [`@uriPort('https://x.com:8080/p')`, 8080],
  [`@uriQuery('https://x.com/p?q=1')`, '?q=1'],
  [`@uriScheme('https://x.com/p')`, 'https'],
  // templates and literals through the public API
  [`@{variables('count')}`, '5'],
  [`id eq '@{variables('count')}'`, `id eq '5'`],
  [`'quoted'`, 'quoted'],
  [`42`, 42],
];

const shapes: Array<[string, (v: any) => boolean]> = [
  ['@guid()', v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)],
  ['@rand(1, 5)', v => Number.isInteger(v) && v >= 1 && v <= 5],
];

describe('expression corpus', () => {
  for (const [expr, expected] of rows) {
    it(expr, () => assert.deepEqual(evalExpression(expr, ctx), expected));
  }
  for (const [expr, check] of shapes) {
    it(expr, () => assert.ok(check(evalExpression(expr, ctx)), `shape failed for ${expr}`));
  }
  it('every registered engine function is in the shared catalogue', () => {
    const missing = [...registry.keys()].filter(k => !KNOWN_FUNCTIONS.has(k));
    assert.deepEqual(missing, [], `registry functions missing from KNOWN_FUNCTIONS: ${missing.join(', ')}`);
  });
  it('corpus covers every registered function', () => {
    const covered = new Set(
      [...rows.map(r => r[0]), ...shapes.map(s => s[0])]
        .flatMap(e => [...e.matchAll(/([A-Za-z_][\w]*)\s*\(/g)].map(m => m[1].toLowerCase())),
    );
    const missing = [...registry.keys()].filter(k => !covered.has(k));
    assert.deepEqual(missing, [], `functions with no corpus row: ${missing.join(', ')}`);
  });
});
