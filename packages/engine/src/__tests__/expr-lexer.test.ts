import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '@flowforger/expressions';

const types = (s: string) => tokenize(s).map(tk => tk.t);
// Strip the position field — these tests assert token content, not offsets.
const bare = (s: string) => tokenize(s).map(({ pos: _pos, ...t }) => t);

describe('lexer', () => {
  it('tokenizes a call with string arg and path', () => {
    assert.deepEqual(bare(`@body('GetRows')?['value']`), [
      { t: '@' }, { t: 'ident', v: 'body' }, { t: '(' }, { t: 'str', v: 'GetRows', quote: "'" },
      { t: ')' }, { t: '?' }, { t: '[' }, { t: 'str', v: 'value', quote: "'" }, { t: ']' }, { t: 'eof' },
    ]);
  });
  it('doubled-quote escape inside strings', () => {
    assert.deepEqual(bare(`'it''s'`), [{ t: 'str', v: "it's", quote: "'" }, { t: 'eof' }]);
    assert.deepEqual(bare(`"a""b"`), [{ t: 'str', v: 'a"b', quote: '"' }, { t: 'eof' }]);
  });
  it('parens/commas/brackets inside strings are literal', () => {
    assert.deepEqual(bare(`'a)b,c[d]'`), [{ t: 'str', v: 'a)b,c[d]', quote: "'" }, { t: 'eof' }]);
  });
  it('backslash is an ordinary character', () => {
    assert.deepEqual(bare(`'C:\\x'`), [{ t: 'str', v: 'C:\\x', quote: "'" }, { t: 'eof' }]);
  });
  it('numbers: int, decimal, negative, exponent — raw text preserved', () => {
    assert.deepEqual(bare('42'), [{ t: 'num', v: 42, raw: '42' }, { t: 'eof' }]);
    assert.deepEqual(bare('-1.5'), [{ t: 'num', v: -1.5, raw: '-1.5' }, { t: 'eof' }]);
    assert.deepEqual(bare('1e3'), [{ t: 'num', v: 1000, raw: '1e3' }, { t: 'eof' }]);
    assert.deepEqual(bare('1.50'), [{ t: 'num', v: 1.5, raw: '1.50' }, { t: 'eof' }]);
  });
  it('whitespace incl. newlines between tokens is skipped', () => {
    assert.deepEqual(types("concat( 'a' ,\n 'b' )"), ['ident', '(', 'str', ',', 'str', ')', 'eof']);
  });
  it('dots in paths and idents kept separate', () => {
    assert.deepEqual(types(`item().name`), ['ident', '(', ')', '.', 'ident', 'eof']);
  });
  it('negative number in arg position vs after value', () => {
    assert.deepEqual(bare('add(1, -2)'), [
      { t: 'ident', v: 'add' }, { t: '(' }, { t: 'num', v: 1, raw: '1' }, { t: ',' },
      { t: 'num', v: -2, raw: '-2' }, { t: ')' }, { t: 'eof' },
    ]);
  });
  it('throws LexError with position on unterminated string', () => {
    assert.throws(() => tokenize(`'abc`), /Unterminated string/);
  });
  it('throws LexError on unexpected character', () => {
    assert.throws(() => tokenize('a # b'), /Unexpected character/);
  });
});

