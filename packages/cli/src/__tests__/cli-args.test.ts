import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, requireBooleanFlag, requireStringFlag, findUnknownFlags, KNOWN_FLAGS, ArgError } from '../cli-args.js';

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

describe('findUnknownFlags', () => {
  it('accepts known flags with and without values', () => {
    assert.deepEqual(findUnknownFlags(['--out', 'x.json', '--emit', 'logicapps', '--auth']), []);
  });

  it('rejects a single-dash option, which parseArgs would otherwise drop', () => {
    const msgs = findUnknownFlags(['flow.ff.ts', '--emit', 'logicapps', '-o', 'Json/']);
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /Unknown option '-o'/);
    assert.match(msgs[0], /did you mean '--out'/);
  });

  it('suggests the closest flag for a typo', () => {
    const msgs = findUnknownFlags(['--emmit', 'logicapps']);
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /'--emmit'.*did you mean '--emit'/);
  });

  it('does not suggest anything for a far-off name', () => {
    const msgs = findUnknownFlags(['--completely-made-up-thing']);
    assert.equal(msgs.length, 1);
    assert.doesNotMatch(msgs[0], /did you mean/);
  });

  it('treats a flag value that looks like a single-dash token as a value', () => {
    assert.deepEqual(findUnknownFlags(['--var', 'x=-1', '--param', '-5']), []);
  });

  it('every flag the CLI source reads is in KNOWN_FLAGS (drift guard)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const read = new Set<string>();
    for (const f of readdirSync(srcDir)) {
      if (!f.endsWith('.ts')) continue;
      const text = readFileSync(join(srcDir, f), 'utf-8');
      for (const m of text.matchAll(/(?<![\w-])args(?:\.([A-Za-z_][\w-]*)|\['([\w-]+)'\])/g)) read.add(m[1] ?? m[2]);
      for (const m of text.matchAll(/require(?:Boolean|String)Flag\(args, '([\w-]+)'\)/g)) read.add(m[1]);
    }
    read.delete('_');
    // camelCase twins read next to their kebab-case flag are not CLI options.
    const missing = [...read].filter((k) => !KNOWN_FLAGS.has(k) && !/[A-Z]/.test(k));
    assert.deepEqual(missing, [], `flags read in source but missing from KNOWN_FLAGS: ${missing.join(', ')}`);
  });
});
