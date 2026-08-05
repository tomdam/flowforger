/**
 * Tokenizer for OData $filter strings as they appear in Power Automate flow
 * definitions — i.e. plain OData 4 comparison/logical syntax with two
 * extensions:
 *  - Power Automate `@{...}` templates may appear as standalone operands or
 *    embedded inside quoted strings; quotes inside a template do not terminate
 *    the surrounding string.
 *  - Field "words" are permissive: `/` (navigation paths), `.` (CRM function
 *    names), `_`, `$`, `=` (CRM named parameters) are all word characters.
 *    A word is any maximal run up to whitespace, `(`, `)`, `,`, a quote, or
 *    the start of a template.
 */

export type ODataToken =
  | { t: 'word'; v: string; pos: number }
  | { t: 'string'; v: string; raw: string; hasTemplate: boolean; pos: number }
  | { t: 'number'; raw: string; pos: number }
  | { t: 'template'; raw: string; pos: number }
  | { t: 'lparen'; pos: number }
  | { t: 'rparen'; pos: number }
  | { t: 'comma'; pos: number };

export class ODataLexError extends Error {
  constructor(
    message: string,
    readonly pos: number
  ) {
    super(`${message} at position ${pos}`);
    this.name = 'ODataLexError';
  }
}

const WS = new Set([' ', '\t', '\n', '\r']);
const PUNCT: Record<string, 'lparen' | 'rparen' | 'comma'> = {
  '(': 'lparen',
  ')': 'rparen',
  ',': 'comma',
};

/** `i` points at the `@` of `@{`. Returns the index just past the closing `}`. */
function scanTemplate(input: string, i: number): number {
  let depth = 1;
  let j = i + 2;
  while (j < input.length) {
    const c = input[j];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  throw new ODataLexError('Unterminated @{...} template', i);
}

interface ScannedString {
  end: number;
  value: string;
  hasTemplate: boolean;
}

/** `i` points at the opening quote. */
function scanString(input: string, i: number): ScannedString {
  const quote = input[i];
  let value = '';
  let hasTemplate = false;
  let j = i + 1;
  while (j < input.length) {
    const c = input[j];
    if (c === '@' && input[j + 1] === '{') {
      const end = scanTemplate(input, j);
      value += input.slice(j, end);
      hasTemplate = true;
      j = end;
      continue;
    }
    if (c === quote) {
      // OData escapes a quote by doubling it (single-quote strings only in
      // practice, but the rule is harmless for double quotes too).
      if (input[j + 1] === quote) {
        value += quote;
        j += 2;
        continue;
      }
      return { end: j + 1, value, hasTemplate };
    }
    value += c;
    j++;
  }
  throw new ODataLexError('Unterminated string', i);
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/;

export function tokenizeOData(input: string): ODataToken[] {
  const tokens: ODataToken[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (WS.has(ch)) {
      i++;
      continue;
    }
    const punct = PUNCT[ch];
    if (punct) {
      tokens.push({ t: punct, pos: i });
      i++;
      continue;
    }
    if (ch === '@' && input[i + 1] === '{') {
      const end = scanTemplate(input, i);
      tokens.push({ t: 'template', raw: input.slice(i, end), pos: i });
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const s = scanString(input, i);
      tokens.push({
        t: 'string',
        v: s.value,
        raw: input.slice(i, s.end),
        hasTemplate: s.hasTemplate,
        pos: i,
      });
      i = s.end;
      continue;
    }
    // Word: maximal run up to a delimiter. A lone '@' (not starting a
    // template) stays part of the word, mirroring the legacy tokenizer.
    const start = i;
    while (i < input.length) {
      const c = input[i];
      if (WS.has(c) || PUNCT[c] || c === "'" || c === '"') break;
      if (c === '@' && input[i + 1] === '{') break;
      i++;
    }
    const w = input.slice(start, i);
    if (NUMBER_RE.test(w)) tokens.push({ t: 'number', raw: w, pos: start });
    else tokens.push({ t: 'word', v: w, pos: start });
  }
  return tokens;
}
