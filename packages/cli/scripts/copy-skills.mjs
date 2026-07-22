// Copies the flowforger syntax skill from the monorepo's .claude/skills into
// this package's bundled skills/ folder so the published npm package ships the
// full skill set (flowforger + flowforger-cli). Runs from prepublishOnly.
// The copy is gitignored — .claude/skills/flowforger stays the source of truth.
import { cpSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(pkgRoot, '..', '..', '.claude', 'skills', 'flowforger');
const target = resolve(pkgRoot, 'skills', 'flowforger');

if (!existsSync(source)) {
  console.error(`copy-skills: source not found at ${source} — publish must run from the monorepo`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });

// Monorepo-relative docs links (../../../docs/...) resolve nowhere once the
// skill is copied into the npm package or a consumer project — rewrite them
// to absolute GitHub URLs. The source skill keeps the relative link.
const DOCS_URL_BASE = 'https://github.com/tomdam/flowforger/blob/main/docs/';
for (const entry of readdirSync(target, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
  const filePath = join(entry.parentPath ?? entry.path, entry.name);
  const content = readFileSync(filePath, 'utf-8');
  const rewritten = content.replaceAll('../../../docs/', DOCS_URL_BASE);
  if (rewritten !== content) {
    writeFileSync(filePath, rewritten);
    console.log(`copy-skills: rewrote docs links in ${entry.name}`);
  }
}

console.log(`copy-skills: copied ${source} -> ${target}`);
