import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DslSourceMap } from '@flowforger/dsl-native';
import { chooseRestartMode, resolveNodeIdAtLine, isSourceDirty } from '../debug-adapter-helpers.js';

function sourceMapWith(lines: Array<[number, string]>): DslSourceMap {
  return {
    lineToNodeId: new Map(lines),
    nodeIdToLines: new Map(lines.map(([line, id]) => [id, { startLine: line, endLine: line }])) as DslSourceMap['nodeIdToLines'],
    breakpointableLines: new Set(lines.map(([line]) => line)),
  };
}

describe('chooseRestartMode', () => {
  it('is hot only while a running session is paused', () => {
    assert.equal(chooseRestartMode({ hasRunner: true, paused: true }), 'hot');
  });
  it('is clean while running but not paused', () => {
    assert.equal(chooseRestartMode({ hasRunner: true, paused: false }), 'clean');
  });
  it('is clean with no session at all', () => {
    assert.equal(chooseRestartMode({ hasRunner: false, paused: false }), 'clean');
    assert.equal(chooseRestartMode({ hasRunner: false, paused: true }), 'clean');
  });
});

describe('resolveNodeIdAtLine', () => {
  const sm = sourceMapWith([[10, 'act_1'], [14, 'act_2'], [20, 'act_3']]);

  it('resolves an exact mapped line', () => {
    assert.equal(resolveNodeIdAtLine(sm, 14), 'act_2');
  });
  it('falls forward to the nearest mapped line below (F9 semantics)', () => {
    assert.equal(resolveNodeIdAtLine(sm, 11), 'act_2');
    assert.equal(resolveNodeIdAtLine(sm, 1), 'act_1');
  });
  it('returns null past the last mapped line (never falls backward)', () => {
    assert.equal(resolveNodeIdAtLine(sm, 21), null);
  });
  it('returns null for an empty source map', () => {
    assert.equal(resolveNodeIdAtLine(sourceMapWith([]), 3), null);
  });
});

describe('isSourceDirty', () => {
  it('compares text exactly', () => {
    assert.equal(isSourceDirty('a\nb', 'a\nb'), false);
    assert.equal(isSourceDirty('a\nb ', 'a\nb'), true);
  });
});
