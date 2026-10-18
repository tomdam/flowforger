/**
 * CLI argument parsing helpers.
 *
 * Kept out of index.ts so the value-bearing-flag guards (`requireBooleanFlag`,
 * `requireStringFlag`) can be unit-tested without importing index.ts, which
 * runs `main()` as a side effect of module load.
 */

/** Thrown for a malformed CLI invocation; callers print `.message` and exit 2. */
export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

export function parseArgs(argv: string[]): Record<string, any> {
  const args: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? (argv[++i] as string) : true;
      if (args[key] === undefined) args[key] = val;
      else if (Array.isArray(args[key])) (args[key] as any[]).push(val);
      else args[key] = [args[key], val];
    } else if (!args['_']) {
      args['_'] = a;
    }
  }
  return args;
}

/**
 * Read a boolean safety flag (e.g. `--no-create`, `--create`).
 *
 * The generic parser above swallows a following bare token as the flag's
 * value (`--no-create true` -> `args['no-create'] === 'true'`, a string, not
 * the boolean `true`). For a flag whose entire job is "is it present or not",
 * that swallowed value would otherwise silently flip its meaning — e.g.
 * `--no-create` (safety on) vs. an accidentally value-bearing invocation that
 * evaluates as falsy-but-truthy-string and gets misread. Reject any
 * value-bearing form outright rather than guess what the caller meant.
 */
export function requireBooleanFlag(args: Record<string, any>, key: string): boolean {
  const val = args[key];
  if (val === undefined) return false;
  if (val === true) return true;
  const found = Array.isArray(val) ? val.join(', ') : String(val);
  throw new ArgError(`--${key} does not take a value; pass it as a bare flag (found '${found}')`);
}

/**
 * Read a flag that requires a string value (e.g. `--name`).
 *
 * Guards the opposite failure mode: `--name --url ...` has no token for
 * `--name` to consume, so the generic parser hands back `true` instead of a
 * name — which would otherwise flow into an OData filter as the literal
 * string "true".
 */
export function requireStringFlag(args: Record<string, any>, key: string): string | undefined {
  const val = args[key];
  if (val === undefined) return undefined;
  if (val === true) {
    throw new ArgError(`--${key} requires a value`);
  }
  if (Array.isArray(val)) {
    throw new ArgError(`--${key} may only be specified once`);
  }
  return val as string;
}

/**
 * Every `--flag` some command reads (as a property of the parsed args, or via
 * requireBooleanFlag/requireStringFlag, anywhere in packages/cli/src). `cli-args.test.ts` rescans the source and fails
 * when a flag is read that is missing here, so this set cannot drift silently.
 * The set is global, not per command: a flag of another command is accepted
 * (and ignored, as before); only misspellings and single-dash flags are rejected.
 */
export const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  'all', 'artifacts-dir', 'auth', 'budget', 'bundled', 'cache-workflows', 'client-id', 'config',
  'config-env', 'create', 'description-comment', 'description-jsdoc', 'dir', 'dv-token', 'dv-url', 'emit',
  'environment-id', 'excel-token', 'expect-clean', 'expressions-relaxed', 'expressions-strict', 'file', 'flow-id',
  'flow-token', 'graph-token', 'help', 'id', 'ignore-metadata', 'ignore-runafter', 'ignore-whitespace',
  'in', 'in-content-type', 'js', 'json', 'list', 'live', 'mock', 'mocks', 'multiline-flatten', 'multiline-preserve', 'name',
  'no-append-to-select', 'no-children', 'no-create', 'no-loop-variable-to-compose',
  'no-parallelism-warnings', 'no-variable-to-compose', 'onedrive-token', 'out', 'param', 'path',
  'pretty', 'ref', 'repo', 'replay-run', 'report', 'require-active', 'run', 'site', 'skip-action-names-for-kinds',
  'skip-default-constructor', 'skip-discovery', 'skip-metadata-fields', 'solution', 'sp-token', 'sp-url',
  'state', 'status', 'stop-before', 'strict-workflows', 'tenant-id', 'token', 'top', 'trigger-name', 'url', 'var', 'vars',
  'verbose', 'whitespace-compact', 'whitespace-spaced', 'word-token', 'workflows-config', 'workflows-dir',
]);

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** The known flag closest to `key`, when it is close enough to be a likely typo. */
export function suggestFlag(key: string, known: ReadonlySet<string> = KNOWN_FLAGS): string | undefined {
  const lower = key.toLowerCase();
  let best: { flag: string; d: number } | undefined;
  for (const flag of known) {
    if (flag === 'help') continue;
    // A single letter is a short option: suggest the shortest known flag starting with it.
    const d = lower.length === 1
      ? (flag.startsWith(lower) ? flag.length : Infinity)
      : editDistance(lower, flag);
    if (!best || d < best.d) best = { flag, d };
  }
  if (!best) return undefined;
  if (lower.length === 1) return best.d === Infinity ? undefined : best.flag;
  const limit = lower.length <= 4 ? 1 : lower.length <= 8 ? 2 : 3;
  return best.d <= limit ? best.flag : undefined;
}

/**
 * Walk argv the way parseArgs does and name every option it would ignore or
 * misread: a `--flag` that no command reads, and any single-dash token
 * (`-o`), which parseArgs takes for a positional and silently drops. Returns
 * one message per offending token; empty when all is well.
 */
export function findUnknownFlags(argv: string[], known: ReadonlySet<string> = KNOWN_FLAGS): string[] {
  const problems: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      // Mirror parseArgs: a following non-`--` token is this flag's value.
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i++;
      if (key === '' || known.has(key)) continue;
      const hint = suggestFlag(key, known);
      problems.push(`Unknown option '--${key}'${hint ? ` (did you mean '--${hint}'?)` : ''}`);
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const hint = suggestFlag(a.slice(1), known);
      problems.push(
        `Unknown option '${a}'${hint ? ` (did you mean '--${hint}'?)` : ''} — options take two dashes`,
      );
    }
  }
  return problems;
}
