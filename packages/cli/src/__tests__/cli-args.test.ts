import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, requireBooleanFlag, requireStringFlag, ArgError } from '../cli-args.js';

describe('parseArgs', () => {
  it('parses a bare flag as boolean true', () => {
    assert.equal(parseArgs(['--create'])['create'], true);
  });

  it('swallows a following non-flag token as the value', () => {
    assert.equal(parseArgs(['--name', 'My Flow'])['name'], 'My Flow');
  });

  it('does not swallow a following flag token — yields boolean true instead', () => {
    assert.equal(parseArgs(['--name', '--url', 'x'])['name'], true);
  });
});

describe('requireBooleanFlag', () => {
  it('returns false when the flag is absent', () => {
    assert.equal(requireBooleanFlag({}, 'no-create'), false);
  });

  it('returns true for a bare flag', () => {
    assert.equal(requireBooleanFlag({ 'no-create': true }, 'no-create'), true);
  });

  it('throws ArgError when a value was swallowed (--no-create true)', () => {
    assert.throws(
      () => requireBooleanFlag({ 'no-create': 'true' }, 'no-create'),
      (err: unknown) => err instanceof ArgError && /does not take a value/.test((err as Error).message),
    );
  });

  it('throws ArgError when the flag was repeated with a value', () => {
    assert.throws(
      () => requireBooleanFlag({ create: [true, 'oops'] }, 'create'),
      (err: unknown) => err instanceof ArgError,
    );
  });
});

describe('requireStringFlag', () => {
  it('returns undefined when the flag is absent', () => {
    assert.equal(requireStringFlag({}, 'name'), undefined);
  });

  it('returns the value when one was given', () => {
    assert.equal(requireStringFlag({ name: 'My Flow' }, 'name'), 'My Flow');
  });

  it('throws ArgError when the flag swallowed nothing (--name --url ...)', () => {
    assert.throws(
      () => requireStringFlag({ name: true }, 'name'),
      (err: unknown) => err instanceof ArgError && /requires a value/.test((err as Error).message),
    );
  });

  it('throws ArgError when the flag was passed more than once', () => {
    assert.throws(
      () => requireStringFlag({ name: ['A', 'B'] }, 'name'),
      (err: unknown) => err instanceof ArgError && /only be specified once/.test((err as Error).message),
    );
  });
});
