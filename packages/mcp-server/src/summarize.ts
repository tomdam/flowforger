/**
 * Value previewing and path drill-down for MCP tool results.
 *
 * Pure — no I/O, no session state. Every tool that returns a runtime value
 * goes through here, so "never dump a full context into a tool result" is a
 * structural guarantee rather than a convention. Mirrors the web app's
 * ValueTree rules with agent-tuned limits (a tool result pays for every
 * character, but an agent can use more context than a UI row).
 */

/** Hard ceiling on any single tool result payload. */
export const MAX_RESULT_BYTES = 16384;

const DEFAULT_STRING_CAP = 200;
const DEFAULT_CHILD_CAP = 50;
/** Keys are attacker-ish data too — cap them so a one-liner stays bounded. */
const KEY_CAP = 40;

export interface PreviewOptions {
  stringCap?: number;
  childCap?: number;
}

function capString(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)} (+${s.length - cap} chars)`;
}

const encoder = new TextEncoder();
/** UTF-8 byte length — MAX_RESULT_BYTES is a byte ceiling, not a character count. */
function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/** One-line rendering used at depth 0 and for children beyond the depth limit. */
function oneLine(value: unknown, cap: number): unknown {
  if (value === undefined) return 'undefined';
  if (value === null) return null;
  if (typeof value === 'string') return capString(value, cap);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) return `{Map(${value.size})}`;
  if (value instanceof Set) return `{Set(${value.size})}`;
  if (ArrayBuffer.isView(value)) return `[${(value as ArrayBufferView).byteLength} bytes]`;
  if (Array.isArray(value)) return `[${value.length} items]`;
  const allKeys = Object.keys(value as object);
  const shown = allKeys.slice(0, 3).map((k) => capString(k, KEY_CAP));
  return `{${shown.join(', ')}${allKeys.length > 3 ? ', …' : ''}}`;
}

/** Normalize container-ish values into a plain array/object, or null if not a container. */
function asContainer(value: unknown): { kind: 'array'; items: unknown[] } | { kind: 'object'; entries: [string, unknown][] } | null {
  if (value === null || typeof value !== 'object') return null;
  if (value instanceof Date || ArrayBuffer.isView(value)) return null;
  if (Array.isArray(value)) return { kind: 'array', items: value };
  if (value instanceof Map) return { kind: 'object', entries: [...value.entries()].map(([k, v]) => [String(k), v]) };
  if (value instanceof Set) return { kind: 'array', items: [...value.values()] };
  return { kind: 'object', entries: Object.entries(value as Record<string, unknown>) };
}

/**
 * Render `value` to `depth` levels. Depth 0 yields a one-liner; depth >= 1
 * yields real arrays/objects whose children are rendered at depth - 1.
 * Truncation is marked inline: a trailing `"…N more"` element for arrays, a
 * `"…"` key for objects.
 */
export function preview(value: unknown, depth = 0, opts?: PreviewOptions): unknown {
  const stringCap = opts?.stringCap ?? DEFAULT_STRING_CAP;
  const childCap = opts?.childCap ?? DEFAULT_CHILD_CAP;

  if (depth <= 0) return oneLine(value, stringCap);
  const container = asContainer(value);
  if (!container) return oneLine(value, stringCap);

  if (container.kind === 'array') {
    const shown = container.items.slice(0, childCap).map((item) => preview(item, depth - 1, opts));
    const hidden = container.items.length - shown.length;
    if (hidden > 0) shown.push(`…${hidden} more`);
    return shown;
  }

  const out: Record<string, unknown> = {};
  const shown = container.entries.slice(0, childCap);
  for (const [key, child] of shown) out[key] = preview(child, depth - 1, opts);
  const hidden = container.entries.length - shown.length;
  if (hidden > 0) out['…'] = `${hidden} more keys`;
  return out;
}

/** One path segment: an object key or an array index, both as strings. */
function tokenizePath(path: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  let current = '';
  const pushCurrent = () => {
    if (current !== '') {
      tokens.push(current);
      current = '';
    }
  };
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      pushCurrent();
      i++;
    } else if (ch === '[') {
      pushCurrent();
      const close = path.indexOf(']', i);
      if (close < 0) throw new Error(`unterminated '[' at position ${i}`);
      let inner = path.slice(i + 1, close).trim();
      if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
        inner = inner.slice(1, -1);
      }
      tokens.push(inner);
      i = close + 1;
    } else {
      current += ch;
      i++;
    }
  }
  pushCurrent();
  return tokens;
}

export type PathResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; resolved: string; available: string[] };

/** Keys reachable on `value`, for the "you guessed wrong, here's what exists" hint. */
function availableKeys(value: unknown): string[] {
  const container = asContainer(value);
  if (!container) return [];
  if (container.kind === 'array') {
    return container.items.slice(0, DEFAULT_CHILD_CAP).map((_, i) => String(i));
  }
  return container.entries.map(([k]) => k).slice(0, DEFAULT_CHILD_CAP);
}

/**
 * Navigate `root` by a `body.value[0].Title` style path. On a miss, returns the
 * deepest prefix that did resolve plus the keys available there, so a wrong
 * guess costs one round-trip instead of blind retries.
 */
export function resolvePath(root: unknown, path: string): PathResult {
  let tokens: string[];
  try {
    tokens = tokenizePath(path);
  } catch (err: any) {
    return { ok: false, error: `Invalid path: ${err.message}`, resolved: '', available: availableKeys(root) };
  }

  let current: unknown = root;
  const walked: string[] = [];
  for (const token of tokens) {
    const container = asContainer(current);
    let next: unknown;
    let found = false;
    if (container?.kind === 'array') {
      const idx = Number(token);
      if (Number.isInteger(idx) && idx >= 0 && idx < container.items.length) {
        next = container.items[idx];
        found = true;
      }
    } else if (container?.kind === 'object') {
      const entry = container.entries.find(([k]) => k === token);
      if (entry) {
        next = entry[1];
        found = true;
      }
    }
    if (!found) {
      return {
        ok: false,
        error: `No '${token}' at '${walked.join('.') || '<root>'}'`,
        resolved: walked.join('.'),
        available: availableKeys(current),
      };
    }
    current = next;
    walked.push(token);
  }
  return { ok: true, value: current };
}

/**
 * Render at the requested depth, stepping down one level at a time until the
 * serialized result fits MAX_RESULT_BYTES. If even depth 0 is too large
 * (pathological keys, a huge Map), the payload is hard-truncated — this
 * function never returns something over the ceiling.
 */
export function fitToBudget(
  value: unknown,
  depth: number,
  opts?: PreviewOptions,
): { preview: unknown; depthUsed: number; note?: string } {
  const overflowNote = (d: number) =>
    `Result too large at depth ${depth}; rendered at depth ${d}. Use debug_get_value with a path to drill in.`;

  for (let d = depth; d > 0; d--) {
    const rendered = preview(value, d, opts);
    if (byteLength(JSON.stringify(rendered) ?? '') <= MAX_RESULT_BYTES) {
      return d === depth
        ? { preview: rendered, depthUsed: d }
        : { preview: rendered, depthUsed: d, note: overflowNote(d) };
    }
  }

  const shallow = preview(value, 0, opts);
  const json = JSON.stringify(shallow) ?? '';
  if (byteLength(json) <= MAX_RESULT_BYTES) {
    return { preview: shallow, depthUsed: 0, note: depth > 0 ? overflowNote(0) : undefined };
  }
  // Last resort: even the one-liner is over budget.
  return {
    preview: `${json.slice(0, 1000)}… (truncated to fit the ${MAX_RESULT_BYTES}-byte ceiling)`,
    depthUsed: 0,
    note: `Result exceeded ${MAX_RESULT_BYTES} bytes even at depth 0 and was hard-truncated.`,
  };
}
