#!/usr/bin/env node
/**
 * Generates lib-files.generated.ts by reading TypeScript's bundled lib.*.d.ts
 * files and embedding their contents as string literals. The embedded TS service
 * serves these via a virtual host so semantic diagnostics work in the bundled
 * VS Code extension (vsce package --no-dependencies excludes node_modules).
 *
 * DOM and WebWorker libs are excluded — FlowForger DSL code never references them
 * and they account for ~80% of total lib size.
 *
 * Run: node scripts/generate-lib-files.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const tsLibDir = path.join(repoRoot, 'node_modules', 'typescript', 'lib');
const outFile = path.resolve(__dirname, '..', 'src', 'embedded-ts', 'lib-files.generated.ts');

if (!fs.existsSync(tsLibDir)) {
  console.error(`TypeScript lib dir not found at ${tsLibDir}`);
  process.exit(1);
}

const EXCLUDE = /(dom|webworker)/i;

const files = fs
  .readdirSync(tsLibDir)
  .filter((f) => f.startsWith('lib.') && f.endsWith('.d.ts'))
  .filter((f) => !EXCLUDE.test(f))
  .sort();

const escape = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const entries = files
  .map((f) => {
    const content = fs.readFileSync(path.join(tsLibDir, f), 'utf8');
    return `  ['${f}', \`${escape(content)}\`]`;
  })
  .join(',\n');

const banner = `// AUTO-GENERATED. Do not edit by hand.
// Run \`node packages/lsp-server/scripts/generate-lib-files.mjs\` to regenerate.
//
// Snapshot of TypeScript ${getTsVersion()} bundled lib files (excluding DOM/WebWorker).
// Used by the embedded TS language service to serve default lib types from memory
// instead of disk (the VS Code extension is bundled with vsce --no-dependencies).
`;

const out = `${banner}
export const libFiles: ReadonlyMap<string, string> = new Map([
${entries}
]);
`;

fs.writeFileSync(outFile, out);
console.log(`Wrote ${files.length} lib files (${(out.length / 1024).toFixed(0)} KB) to ${path.relative(repoRoot, outFile)}`);

function getTsVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'node_modules', 'typescript', 'package.json'), 'utf8'),
    );
    return pkg.version;
  } catch {
    return 'unknown';
  }
}
