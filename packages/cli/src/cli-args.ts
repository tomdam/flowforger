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
