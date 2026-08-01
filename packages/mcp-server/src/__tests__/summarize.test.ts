import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { preview, resolvePath, fitToBudget, MAX_RESULT_BYTES } from '../summarize.js';

describe('preview at depth 0', () => {
  it('passes primitives through unchanged', () => {
    assert.equal(preview(42), 42);
    assert.equal(preview(true), true);
    assert.equal(preview(null), null);
    assert.equal(preview('short'), 'short');
  });

  it('renders undefined as a marker string (JSON drops undefined)', () => {
    assert.equal(preview(undefined), 'undefined');
  });

  it('caps long strings and reports the overflow', () => {
    const out = preview('x'.repeat(250)) as string;
    assert.equal(out.length, 200 + ' (+50 chars)'.length);
    assert.ok(out.endsWith(' (+50 chars)'));
    assert.ok(out.startsWith('x'.repeat(200)));
  });

  it('renders arrays as a count one-liner', () => {
    assert.equal(preview([1, 2, 3]), '[3 items]');
    assert.equal(preview([]), '[0 items]');
  });

  it('renders objects as first-three-keys', () => {
    assert.equal(preview({ a: 1, b: 2 }), '{a, b}');
    assert.equal(preview({ a: 1, b: 2, c: 3, d: 4 }), '{a, b, c, …}');
  });

  it('renders Date as an ISO string', () => {
    assert.equal(preview(new Date('2026-07-27T00:00:00.000Z')), '2026-07-27T00:00:00.000Z');
  });
});

describe('preview at depth >= 1', () => {
  it('expands arrays into real arrays of one-liners', () => {
    assert.deepEqual(preview([{ a: 1 }, 5], 1), ['{a}', 5]);
  });

  it('expands objects into real objects of one-liners', () => {
    assert.deepEqual(preview({ x: [1, 2], y: 'hi' }, 1), { x: '[2 items]', y: 'hi' });
  });

  it('recurses to the requested depth and one-lines beyond it', () => {
    assert.deepEqual(preview({ a: { b: { c: 1 } } }, 2), { a: { b: '{c}' } });
  });

  it('caps array children and appends an overflow sentinel', () => {
    const out = preview(Array.from({ length: 60 }, (_, i) => i), 1) as unknown[];
    assert.equal(out.length, 51);
    assert.equal(out[50], '…10 more');
  });

  it('caps object children and adds an overflow key', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 60; i++) big[`k${i}`] = i;
    const out = preview(big, 1) as Record<string, unknown>;
    assert.equal(Object.keys(out).length, 51);
    assert.equal(out['…'], '10 more keys');
  });
});

describe('resolvePath', () => {
  const root = { body: { value: [{ Title: 'first' }, { Title: 'second' }] }, 'odd.key': 7 };

  it('resolves dotted and indexed paths', () => {
    assert.deepEqual(resolvePath(root, 'body.value[1].Title'), { ok: true, value: 'second' });
  });

  it('resolves bracket-quoted keys containing dots', () => {
    assert.deepEqual(resolvePath(root, '["odd.key"]'), { ok: true, value: 7 });
  });

  it('returns the whole root for an empty path', () => {
    assert.deepEqual(resolvePath(root, ''), { ok: true, value: root });
  });

  it('reports the deepest valid prefix and available keys on a miss', () => {
    const r = resolvePath(root, 'body.nope.deeper');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.resolved, 'body');
    assert.deepEqual(r.available, ['value']);
    assert.match(r.error, /nope/);
  });

  it('reports array indices as available keys', () => {
    const r = resolvePath(root, 'body.value[9]');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.resolved, 'body.value');
    assert.deepEqual(r.available, ['0', '1']);
  });
});

describe('fitToBudget', () => {
  it('keeps the requested depth when the result fits', () => {
    const r = fitToBudget({ a: 1 }, 2);
    assert.equal(r.depthUsed, 2);
    assert.equal(r.note, undefined);
  });

  it('drops depth until the result fits and explains why', () => {
    // Nested on purpose: with the default caps a FLAT object maxes out around
    // 11 KB at depth 2 and can never exceed the 16 KB ceiling. An object of
    // arrays renders ~312 KB at depth 2 and ~800 bytes at depth 1.
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      wide[`k${i}`] = Array.from({ length: 40 }, () => 'y'.repeat(190));
    }
    const r = fitToBudget(wide, 2);
    assert.ok(r.depthUsed < 2, 'depth was reduced');
    assert.ok(JSON.stringify(r.preview).length <= MAX_RESULT_BYTES);
    assert.match(r.note ?? '', /depth/);
  });

  it('hard-truncates when even the depth-0 one-liner is over budget', () => {
    // A huge bigint one-lines to an unbounded `${value}n` string — the only
    // input that reaches the last-resort truncation branch.
    const huge = 10n ** 40_000n;
    const r = fitToBudget(huge, 2);
    const size = new TextEncoder().encode(JSON.stringify(r.preview) ?? '').length;
    assert.ok(size <= MAX_RESULT_BYTES, `expected <= ${MAX_RESULT_BYTES}, got ${size}`);
    assert.equal(r.depthUsed, 0);
    assert.match(r.note ?? '', /hard-truncated/);
    assert.match(String(r.preview), /truncated to fit/);
  });

  it('caps pathological keys so they never reach the truncation path', () => {
    const hostile: Record<string, unknown> = {};
    hostile['k'.repeat(40_000)] = 1;
    hostile['j'.repeat(40_000)] = 2;
    hostile['i'.repeat(40_000)] = 3;
    const r = fitToBudget(hostile, 2);
    const size = new TextEncoder().encode(JSON.stringify(r.preview) ?? '').length;
    assert.ok(size <= MAX_RESULT_BYTES, `expected <= ${MAX_RESULT_BYTES}, got ${size}`);
    assert.ok(size < 1000, `KEY_CAP should keep this tiny, got ${size} bytes`);
  });

  it('measures the budget in UTF-8 bytes, not UTF-16 units', () => {
    // Each char is 3 UTF-8 bytes but 1 JS string unit; a naive .length check
    // would let roughly 3x the intended payload through.
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) wide[`k${i}`] = Array.from({ length: 40 }, () => '中'.repeat(190));
    const r = fitToBudget(wide, 2);
    const size = new TextEncoder().encode(JSON.stringify(r.preview) ?? '').length;
    assert.ok(size <= MAX_RESULT_BYTES, `expected <= ${MAX_RESULT_BYTES}, got ${size}`);
  });

  it('bounds the available-keys hint for a huge array', () => {
    const big = Array.from({ length: 100_000 }, (_, i) => i);
    const r = resolvePath({ items: big }, 'items[999999]');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.available.length <= 50, `expected <= 50 hint entries, got ${r.available.length}`);
  });
});
