/**
 * Tokenizer for the Logic Apps expression language.
 *
 * String literals use ' or " with a doubled quote as the only escape
 * (Power Automate convention: 'it''s' → it's). Backslash is an ordinary
 * character. Whitespace between tokens (incl. newlines) is skipped —
 * inside string literals it is preserved.
 *
 * Tokens carry source-fidelity data: strings record their quote style,
 * numbers their raw matched text (so `1.50` can be re-emitted verbatim).
 * Every token records `pos` — its start offset in the input — so parse
 * errors and diagnostics can point at the exact location.
 */

type TokenBase =
  | { t: 'ident'; v: string }
  | { t: 'str'; v: string; quote: "'" | '"' }
  | { t: 'num'; v: number; raw: string }
  | { t: '(' } | { t: ')' } | { t: ',' } | { t: '[' } | { t: ']' }
  | { t: '.' } | { t: '?' } | { t: '@' } | { t: 'eof' };

export type Token = TokenBase & { pos: number };

export class LexError extends Error {
  constructor(message: string, public pos: number) {
    super(message);
    this.name = 'LexError';
  }
}

const IDENT_RE = /[A-Za-z_$][\w$]*/y;
const NUM_RE = /-?\d+(\.\d+)?([eE][+-]?\d+)?/y;
const SINGLE_CHARS = new Set(['(', ')', ',', '[', ']', '.', '?', '@']);

/** Token types after which a `-` cannot start a negative literal (no infix
 *  minus exists in this grammar, but be conservative anyway). */
const VALUE_END = new Set([')', ']', 'str', 'num', 'ident']);

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (/\s/.test(ch)) { i++; continue; }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      let value = '';
      i++;
      for (;;) {
        if (i >= input.length) throw new LexError('Unterminated string literal', start);
        const c = input[i];
        if (c === quote) {
          if (input[i + 1] === quote) { value += quote; i += 2; continue; }
          i++;
          break;
        }
        value += c;
        i++;
      }
      tokens.push({ t: 'str', v: value, quote, pos: start });
      continue;
    }

    const prev = tokens[tokens.length - 1]?.t;
    if (/\d/.test(ch) || (ch === '-' && /\d/.test(input[i + 1] ?? '') && !VALUE_END.has(prev as string))) {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(input);
      if (m) {
        tokens.push({ t: 'num', v: Number(m[0]), raw: m[0], pos: i });
        i = NUM_RE.lastIndex;
        continue;
      }
    }

    IDENT_RE.lastIndex = i;
    const im = IDENT_RE.exec(input);
    if (im) {
      tokens.push({ t: 'ident', v: im[0], pos: i });
      i = IDENT_RE.lastIndex;
      continue;
    }

    if (SINGLE_CHARS.has(ch)) {
      tokens.push({ t: ch, pos: i } as Token);
      i++;
      continue;
    }

    throw new LexError(`Unexpected character '${ch}'`, i);
  }

  tokens.push({ t: 'eof', pos: input.length });
  return tokens;
}
