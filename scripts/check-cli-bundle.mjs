#!/usr/bin/env node
// Builds the CLI bundle and checks it still evaluates expressions. Run by CI and by `npm run ci:local`.
//
// A tree-shaken expression function registry fails neither the build nor the tests — every
// expression would silently evaluate to its own source text. Guard the shipped bundle directly.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'packages/cli/dist/bundle.cjs');

// A string only the registry carries: addProperty's error message (packages/engine/src/expr/functions/collections.ts).
// If that message changes, change this marker with it.
const MARKER = 'expects the property to not exist in the object';

function fail(message) {
  // `::error::` shows as an annotation in GitHub Actions and reads fine in a terminal.
  console.error(`::error::${message}`);
  process.exit(1);
}

execFileSync(process.execPath, [join(root, 'packages/cli/esbuild.config.mjs')], { stdio: 'inherit' });

const count = readFileSync(bundle, 'utf8').split(MARKER).length - 1;
if (count !== 1) {
  fail(`Expected 1 '${MARKER}' marker in the CLI bundle, found ${count} — the expression registry was tree-shaken.`);
}

const dir = mkdtempSync(join(tmpdir(), 'ff-ci-smoke-'));
try {
  writeFileSync(
    join(dir, 'ci-smoke.ff.ts'),
    `@Flow('ci-smoke')
class CiSmoke {
  @ManualTrigger()
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.compose('Joined', "@concat('a','b')");
  }
}
`,
  );
  const out = execFileSync(process.execPath, [bundle, 'run', 'ci-smoke.ff.ts', '--json'], { cwd: dir, encoding: 'utf8' });
  if (!out.includes('"ab"')) fail(`Expression smoke test failed:\n${out}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('CLI bundle OK: expression registry present, smoke flow evaluated.');
