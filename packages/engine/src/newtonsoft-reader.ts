/**
 * JSON text read the way the cloud's Parse JSON reads it: Newtonsoft.Json's JsonTextReader with
 * its leniency and its error messages (measured by conformance/flows/parse-json.ff.ts).
 *
 * Leniency: single-quoted strings, unquoted property names, comments, trailing commas, a comma
 * in value position as `null` (`[,1]`), `NaN` / `Infinity` / `-Infinity` / `undefined`, hex and
 * octal numbers (`0x1A`, `010`), `.5` and `1.`, duplicate keys (the last wins), text after the
 * first complete value ignored, and end of input right after a value closing every open container.
 *
 * Errors carry Newtonsoft's message, JSON path and 1-based line / 0-based position, e.g.
 * "Error parsing boolean value. Path '[0]', line 1, position 6.".
 */
import { numberText } from './expr/values.js';

/** A parsed value that remembers what the plain JS value forgets: integer vs float. */
export type JNode =
  | { t: 'object'; props: Array<[string, JNode]> }
  | { t: 'array'; items: JNode[] }
  | { t: 'string'; v: string }
  | { t: 'integer'; v: number }
  | { t: 'float'; v: number }
  | { t: 'boolean'; v: boolean }
  | { t: 'null' };

export class JsonReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonReaderError';
  }
}

/** JsonPosition.SpecialCharacters: a property name with one of these is written `['name']`. */
const SPECIAL_PATH_CHARS = /[. '\/"\[\]()\t\n\r\f\b\\\u0085\u2028\u2029]/;

export type PathSegment = string | number;

/** A JSON path as Newtonsoft writes it: `rows[1].name`, `['a b']['x.y'][0]`. */
export function jsonPath(segments: PathSegment[]): string {
  let out = '';
  for (const s of segments) {
    if (typeof s === 'number') out += `[${s}]`;
    else if (SPECIAL_PATH_CHARS.test(s)) out += `['${escapePathName(s)}']`;
    else out += out ? `.${s}` : s;
  }
  return out;
}

function escapePathName(s: string): string {
  return s.replace(/[\\'\n\r\t\f\b]/g, (c) =>
    c === '\\' ? '\\\\' : c === "'" ? "\\'" : c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : c === '\f' ? '\\f' : '\\b',
  );
}

type Container = { kind: 'object'; name?: string; node: JNode & { t: 'object' } } | { kind: 'array'; index: number; node: JNode & { t: 'array' } };

const LITERAL_NAMES: Record<string, string> = {
  true: 'boolean',
  false: 'boolean',
  null: 'null',
  undefined: 'undefined',
  NaN: 'NaN',
  Infinity: 'Infinity',
  '-Infinity': '-Infinity',
};

class Reader {
  private pos = 0;
  private line = 1;
  private lineStart = 0;
  /** Whether any token (or comment) has been read: before that, Newtonsoft reports line 0 at position 0. */
  private started = false;
  private readonly stack: Container[] = [];

  constructor(private readonly text: string) {}

  read(): JNode | undefined {
    this.skipBlank();
    if (this.pos >= this.text.length) return undefined;
    // An explicit stack instead of recursion: deep documents must not overflow the JS stack.
    let step: JNode | undefined | typeof CLOSED = this.readValue();
    for (;;) {
      const value: JNode | undefined = step === CLOSED ? this.stack.pop()!.node : step;
      if (value !== undefined) {
        // The first complete value is the document; anything after it is not read.
        if (this.stack.length === 0) return value;
        this.attach(value);
      }
      const top = this.stack[this.stack.length - 1];
      step = top.kind === 'array' ? this.afterArrayItem(top) : this.afterObjectMember(top);
    }
  }

  // ---- positions and paths ----

  private fail(message: string, at = this.pos): never {
    const position = at - this.lineStart;
    const line = !this.started && position === 0 ? 0 : this.line;
    throw new JsonReaderError(`${message} Path '${this.path()}', line ${line}, position ${position}.`);
  }

  /** End of input where a token is still expected: the path of the innermost open container, no line info. */
  private failEnd(): never {
    const segments: PathSegment[] = [];
    for (const c of this.stack.slice(0, -1)) segments.push(c.kind === 'object' ? c.name! : c.index);
    throw new JsonReaderError(`Unexpected end when reading token. Path '${jsonPath(segments)}'.`);
  }

  private path(): string {
    const segments: PathSegment[] = [];
    for (const c of this.stack) {
      if (c.kind === 'object') {
        if (c.name !== undefined) segments.push(c.name);
      } else if (c.index >= 0) segments.push(c.index);
    }
    return jsonPath(segments);
  }

  /** The array index moves when a value is complete, when a nested container starts, and before a number is converted. */
  private advanceIndex(): void {
    const top = this.stack[this.stack.length - 1];
    if (top?.kind === 'array') top.index++;
  }

  private attach(value: JNode): void {
    const top = this.stack[this.stack.length - 1];
    if (top.kind === 'array') {
      top.node.items.push(value);
    } else {
      const props = top.node.props;
      const existing = props.findIndex(([k]) => k === top.name);
      if (existing >= 0) props[existing] = [top.name!, value];
      else props.push([top.name!, value]);
    }
  }

  // ---- whitespace and comments ----

  private skipBlank(): void {
    const s = this.text;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === '\n') {
        this.pos++;
        this.newLine();
      } else if (c === '\r') {
        this.pos++;
        if (s[this.pos] === '\n') this.pos++;
        this.newLine();
      } else if (c === ' ' || c === '\t' || /\s/.test(c)) {
        this.pos++;
      } else if (c === '/') {
        this.readComment();
      } else {
        return;
      }
    }
  }

  private newLine(): void {
    this.line++;
    this.lineStart = this.pos;
  }

  private readComment(): void {
    const s = this.text;
    this.started = true;
    const next = s[this.pos + 1];
    if (next === '*') {
      this.pos += 2;
      for (;;) {
        if (this.pos >= s.length) this.fail('Unexpected end while parsing comment.');
        if (s[this.pos] === '*' && s[this.pos + 1] === '/') {
          this.pos += 2;
          return;
        }
        if (s[this.pos] === '\n') {
          this.pos++;
          this.newLine();
        } else {
          this.pos++;
        }
      }
    }
    if (next === '/') {
      this.pos += 2;
      while (this.pos < s.length && s[this.pos] !== '\r' && s[this.pos] !== '\n') this.pos++;
      return;
    }
    this.pos++;
    if (this.pos >= s.length) this.fail('Unexpected end while parsing comment.');
    this.fail(`Error parsing comment. Expected: *, got ${s[this.pos]}.`);
  }

  // ---- values ----

  /** A value; `undefined` when a container was opened (its members follow). */
  private readValue(): JNode | undefined {
    this.skipBlank();
    const s = this.text;
    if (this.pos >= s.length) this.failEnd();
    const c = s[this.pos];
    switch (c) {
      case '{':
      case '[': {
        this.advanceIndex();
        this.pos++;
        this.started = true;
        this.stack.push(
          c === '{' ? { kind: 'object', node: { t: 'object', props: [] } } : { kind: 'array', index: -1, node: { t: 'array', items: [] } },
        );
        return undefined;
      }
      case '"':
      case "'": {
        const v = this.readString(c);
        this.advanceIndex();
        return { t: 'string', v };
      }
      case ',':
        // `[,1]`: a comma where a value belongs is an undefined value, which reads as null.
        this.started = true;
        this.advanceIndex();
        return { t: 'null' };
      case ']': {
        this.pos++;
        this.started = true;
        const top = this.stack[this.stack.length - 1];
        this.fail(`JsonToken EndArray is not valid for closing JsonType ${top ? 'Object' : 'None'}.`);
      }
    }
    if (c === 't') return this.readLiteral('true', { t: 'boolean', v: true });
    if (c === 'f') return this.readLiteral('false', { t: 'boolean', v: false });
    if (c === 'n' && s[this.pos + 1] === 'u') return this.readLiteral('null', { t: 'null' });
    if (c === 'u') return this.readLiteral('undefined', { t: 'null' });
    if (c === 'N') return this.readLiteral('NaN', { t: 'float', v: NaN });
    if (c === 'I') return this.readLiteral('Infinity', { t: 'float', v: Infinity });
    if (c === '-' && s[this.pos + 1] === 'I') return this.readLiteral('-Infinity', { t: 'float', v: -Infinity });
    if (c === '-' || c === '.' || (c >= '0' && c <= '9')) return this.readNumber();
    this.fail(`Unexpected character encountered while parsing value: ${c}.`);
  }

  private readLiteral(word: string, node: JNode): JNode {
    const s = this.text;
    this.started = true;
    if (this.pos + word.length > s.length) {
      this.pos = s.length;
      this.fail('Unexpected end when reading JSON.');
    }
    const kind = LITERAL_NAMES[word];
    for (let i = 0; i < word.length; i++) {
      if (s[this.pos + i] !== word[i]) this.fail(`Error parsing ${kind} value.`, this.pos + i);
    }
    const end = this.pos + word.length;
    if (end < s.length && !isSeparator(s[end])) this.fail(`Error parsing ${kind} value.`, end);
    this.pos = end;
    this.advanceIndex();
    return node;
  }

  private readNumber(): JNode {
    const s = this.text;
    this.started = true;
    const start = this.pos;
    let end = start;
    while (end < s.length && /[-.0-9a-fA-FxX+]/.test(s[end])) end++;
    if (end < s.length && !/\s/.test(s[end]) && !',}])/'.includes(s[end])) {
      this.pos = end;
      this.fail(`Unexpected character encountered while parsing number: ${s[end]}.`);
    }
    this.pos = end;
    const text = s.slice(start, end);
    // Newtonsoft moves to the post-value state before converting, so a bad number's path already has its index.
    this.advanceIndex();
    const node = convertNumber(text);
    if (!node) this.fail(`Input string '${text}' is not a valid number.`);
    return node;
  }

  private readString(quote: string): string {
    const s = this.text;
    this.started = true;
    this.pos++;
    let out = '';
    for (;;) {
      if (this.pos >= s.length) this.fail(`Unterminated string. Expected delimiter: ${quote}.`);
      const c = s[this.pos];
      if (c === quote) {
        this.pos++;
        return out;
      }
      if (c === '\\') {
        this.pos++;
        if (this.pos >= s.length) this.fail(`Unterminated string. Expected delimiter: ${quote}.`);
        const e = s[this.pos++];
        switch (e) {
          case 'b': out += '\b'; break;
          case 't': out += '\t'; break;
          case 'n': out += '\n'; break;
          case 'f': out += '\f'; break;
          case 'r': out += '\r'; break;
          case '\\': out += '\\'; break;
          case '"': out += '"'; break;
          case "'": out += "'"; break;
          case '/': out += '/'; break;
          case 'u': {
            const hex = s.slice(this.pos, this.pos + 4);
            if (hex.length < 4) {
              this.pos = s.length;
              this.fail('Unexpected end while parsing Unicode escape sequence.');
            }
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail(`Invalid Unicode escape sequence: \\u${hex}.`);
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          default:
            this.fail(`Bad JSON escape sequence: \\${e}.`);
        }
        continue;
      }
      if (c === '\n') {
        out += c;
        this.pos++;
        this.newLine();
        continue;
      }
      out += c;
      this.pos++;
    }
  }

  // ---- inside containers ----

  /** After an array's `[` or one of its items: the next item, or CLOSED at `]` / end of input after an item. */
  private afterArrayItem(top: Container & { kind: 'array' }): JNode | undefined | typeof CLOSED {
    const s = this.text;
    this.skipBlank();
    if (top.node.items.length === 0 && top.index === -1) {
      // Right after `[`: a value, or `]`.
      if (this.pos >= s.length) this.failEnd();
      if (s[this.pos] === ']') {
        this.pos++;
        return CLOSED;
      }
      return this.readValue();
    }
    if (this.pos >= s.length) return CLOSED;
    const c = s[this.pos];
    if (c === ']') {
      this.pos++;
      return CLOSED;
    }
    if (c === ',') {
      this.pos++;
      this.skipBlank();
      if (this.pos >= s.length) this.failEnd();
      if (s[this.pos] === ']') {
        this.pos++;
        return CLOSED;
      }
      return this.readValue();
    }
    if (c === '}') {
      this.pos++;
      this.fail('JsonToken EndObject is not valid for closing JsonType Array.');
    }
    this.fail(`After parsing a value an unexpected character was encountered: ${c}.`);
  }

  /** After an object's `{` or one of its values: the next member's value, or CLOSED at `}` / end of input after a value. */
  private afterObjectMember(top: Container & { kind: 'object' }): JNode | undefined | typeof CLOSED {
    const s = this.text;
    this.skipBlank();
    if (top.name !== undefined) {
      if (this.pos >= s.length) return CLOSED;
      const c = s[this.pos];
      if (c === '}') {
        this.pos++;
        return CLOSED;
      }
      if (c === ']') {
        this.pos++;
        this.fail('JsonToken EndArray is not valid for closing JsonType Object.');
      }
      if (c !== ',') this.fail(`After parsing a value an unexpected character was encountered: ${c}.`);
      this.pos++;
      this.skipBlank();
    }
    if (this.pos >= s.length) this.failEnd();
    if (s[this.pos] === '}') {
      this.pos++;
      return CLOSED;
    }
    top.name = this.readPropertyName();
    return this.readValue();
  }

  private readPropertyName(): string {
    const s = this.text;
    const c = s[this.pos];
    let name: string;
    if (c === '"' || c === "'") {
      name = this.readString(c);
    } else if (isIdentifierChar(c)) {
      const start = this.pos;
      while (this.pos < s.length && isIdentifierChar(s[this.pos])) this.pos++;
      if (this.pos < s.length && !/\s/.test(s[this.pos]) && s[this.pos] !== ':') {
        this.fail(`Invalid JavaScript property identifier character: ${s[this.pos]}.`);
      }
      name = s.slice(start, this.pos);
    } else {
      this.fail(`Invalid property identifier character: ${c}.`);
    }
    this.skipBlank();
    if (this.pos >= s.length) this.failEnd();
    if (s[this.pos] !== ':') this.fail(`Invalid character after parsing property name. Expected ':' but got: ${s[this.pos]}.`);
    this.pos++;
    return name;
  }
}

const CLOSED = Symbol('closed');

function isSeparator(c: string): boolean {
  return /\s/.test(c) || ',}])/'.includes(c);
}

function isIdentifierChar(c: string): boolean {
  return /[\p{L}\p{Nd}_$]/u.test(c);
}

/**
 * A number token's value, as Newtonsoft converts it: a leading `0` followed by more digits is
 * octal (`0x` hex), integers are Int64 (BigInteger beyond, which JS rounds), anything with a `.`
 * or exponent is a double (overflow gives Infinity, as .NET Core's double.Parse does).
 */
function convertNumber(text: string): JNode | undefined {
  const first = text[0];
  if (first === '0' && text.length > 1 && text[1] !== '.' && text[1] !== 'e' && text[1] !== 'E') {
    if (text[1] === 'x' || text[1] === 'X') {
      return /^0[xX][0-9a-fA-F]+$/.test(text) ? { t: 'integer', v: parseInt(text.slice(2), 16) } : undefined;
    }
    return /^0[0-7]+$/.test(text) ? { t: 'integer', v: parseInt(text, 8) } : undefined;
  }
  if (/^-?[0-9]+$/.test(text)) return { t: 'integer', v: Number(text) };
  if (/^-?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?$/.test(text)) return { t: 'float', v: Number(text) };
  return undefined;
}

/** Reads JSON text; `undefined` when it holds nothing but whitespace and comments. */
export function readNewtonsoftJson(text: string): JNode | undefined {
  return new Reader(text).read();
}

/** A plain JS value as a node (content that is already an object): whole numbers are integers. */
export function nodeFromValue(v: unknown): JNode {
  if (v === null || v === undefined) return { t: 'null' };
  if (typeof v === 'string') return { t: 'string', v };
  if (typeof v === 'boolean') return { t: 'boolean', v };
  if (typeof v === 'number') return Number.isInteger(v) ? { t: 'integer', v } : { t: 'float', v };
  if (Array.isArray(v)) return { t: 'array', items: v.map(nodeFromValue) };
  return { t: 'object', props: Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, nodeFromValue(x)]) };
}

/** A node as the plain value the action outputs; NaN and the infinities are written as strings, as Newtonsoft serializes them. */
export function nodeToValue(n: JNode): unknown {
  switch (n.t) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of n.props) Object.defineProperty(out, k, { value: nodeToValue(v), enumerable: true, writable: true, configurable: true });
      return out;
    }
    case 'array':
      return n.items.map(nodeToValue);
    case 'float':
      return Number.isFinite(n.v) ? (Object.is(n.v, -0) ? 0 : n.v) : numberText(n.v);
    case 'integer':
      return Object.is(n.v, -0) ? 0 : n.v;
    case 'null':
      return null;
    default:
      return n.v;
  }
}
