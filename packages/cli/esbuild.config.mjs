import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Inject the version at bundle time. The installed bin is a symlink on PATH, so
// resolving package.json at runtime from argv[1]/__dirname is unreliable across
// platforms — baking it in makes `flowforger --version` correct everywhere.
const pkgVersion = JSON.parse(
  readFileSync(join(__dirname, 'package.json'), 'utf-8')
).version;

await build({
  entryPoints: [join(__dirname, 'dist/index.js')],
  bundle: true,
  outfile: join(__dirname, 'dist/bundle.cjs'),
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  // The source file already contains a shebang — strip it via define wouldn't work,
  // so we handle it: esbuild preserves the shebang from the entry point automatically
  // ts-morph is too large to bundle (~40MB with TypeScript compiler)
  // It stays as a regular npm dependency
  external: ['ts-morph', 'typescript', '@azure/msal-node-extensions', '@azure/msal-node-runtime'],
  // Silence warnings about dynamic requires in node_modules
  logLevel: 'warning',
  // moduleDir() only reads import.meta.url in the ESM dev build; the CJS bundle
  // takes the __dirname branch, so esbuild emptying import.meta here is harmless.
  logOverride: { 'empty-import-meta': 'silent' },
  define: { __CLI_VERSION__: JSON.stringify(pkgVersion) },
});

console.log('Bundle created: dist/bundle.cjs');
