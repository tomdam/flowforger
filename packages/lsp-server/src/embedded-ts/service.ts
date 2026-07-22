/**
 * Embedded TypeScript Language Service
 *
 * Runs a TypeScript LanguageService over a virtual file system so we can pull
 * the same semantic diagnostics Monaco shows in the web app (TS2451 redeclare,
 * TS2322 type-mismatch, TS2554 wrong-arg-count, etc.) directly inside the
 * VS Code extension — where the file's language ID is `flowforger`, not
 * `typescript`, so the built-in TS service never attaches.
 *
 * The virtual FS holds:
 *   - `/__lib__/lib.*.d.ts` — bundled TypeScript default libs (from generator)
 *   - `/__flowforger__/globals.d.ts` — ambient FlowForger types (monaco-types.ts)
 *   - one entry per open user document, keyed by its URI
 */

import ts from 'typescript';
import { monacoTypeDefinitions } from '@flowforger/dsl-native';
import { libFiles } from './lib-files.generated.js';

const LIB_DIR = '/__lib__/';
const FLOWFORGER_GLOBALS_PATH = '/__flowforger__/globals.d.ts';
const DEFAULT_LIB = 'lib.es2020.d.ts';

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  // Standard lib set used by the web app's Monaco (minus DOM, which the DSL doesn't touch).
  lib: ['lib.es2020.d.ts', 'lib.es2015.iterable.d.ts'],
  experimentalDecorators: true,
  emitDecoratorMetadata: false,
  allowNonTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
  // Permissive on purpose — same posture as the web app Monaco config — so partial /
  // in-progress code doesn't flood the Problems panel with noise.
  strict: false,
  noImplicitAny: false,
  strictNullChecks: false,
  // Side-step "cannot find module" for the dead `import { Flow, ... } from '@flowforger/dsl-native'`
  // line that .ff.ts files sometimes still carry. Globals shadow the import either way.
  allowSyntheticDefaultImports: true,
};

interface VirtualFile {
  content: string;
  version: number;
}

const files = new Map<string, VirtualFile>();

// Seed the virtual FS with lib files + the FlowForger globals
for (const [name, content] of libFiles) {
  files.set(LIB_DIR + name, { content, version: 1 });
}
files.set(FLOWFORGER_GLOBALS_PATH, { content: monacoTypeDefinitions, version: 1 });

const userDocumentUris = new Set<string>();

/**
 * Translate an LSP document URI to a deterministic virtual path the TS service
 * can stomach. URIs like `file:///c:/Projects/foo.ff.ts` contain a `file://`
 * scheme and Windows drive-letter colons that TS treats as malformed paths.
 *
 * The mapping is one-way (we never need to go back) — we already know the
 * caller's URI when wiring diagnostics back to LSP.
 */
function uriToVirtualPath(uri: string): string {
  let p = uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
  try {
    p = decodeURIComponent(p);
  } catch {
    // Leave as-is on bad encoding
  }
  // Strip leading slash from `/c:/...` then replace drive colon with underscore.
  p = p.replace(/^\/?([a-zA-Z]):/, '$1_');
  if (!p.startsWith('/')) p = '/' + p;
  return '/__doc__' + p;
}

const host: ts.LanguageServiceHost = {
  getScriptFileNames: () => [
    FLOWFORGER_GLOBALS_PATH,
    ...Array.from(userDocumentUris, uriToVirtualPath),
  ],
  getScriptVersion: (fileName) => {
    const f = files.get(fileName);
    return f ? String(f.version) : '0';
  },
  getScriptSnapshot: (fileName) => {
    const f = files.get(fileName);
    if (f) return ts.ScriptSnapshot.fromString(f.content);
    return undefined;
  },
  getCurrentDirectory: () => '/',
  getCompilationSettings: () => compilerOptions,
  getDefaultLibFileName: () => LIB_DIR + DEFAULT_LIB,
  fileExists: (fileName) => files.has(fileName),
  readFile: (fileName) => files.get(fileName)?.content,
  readDirectory: () => [],
  directoryExists: (dir) => {
    // Only the two virtual dirs exist
    return dir === '/' || dir === LIB_DIR || dir === '/__flowforger__/' || dir === '/__flowforger__';
  },
  getDirectories: () => [],
};

const languageService = ts.createLanguageService(host, ts.createDocumentRegistry());

/**
 * Diagnostic codes to silently drop. Mirrors the web app's Monaco filter
 * (apps/web/src/components/editor/DslEditor.tsx) so the VS Code experience
 * matches what users already see in the browser editor.
 */
const IGNORED_CODES = new Set<number>([
  2307, // Cannot find module
  2304, // Cannot find name — covered by DSL005/DSL022 in our own diagnostics
  2339, // Property does not exist on type — false positive with @{} expressions
  2488, // Type must have a '[Symbol.iterator]()' method
  1375, // 'await' expressions are only allowed at the top level
  1378, // Top-level 'await' expressions
  6133, // Variable is declared but its value is never read (we have DSL007)
  6196, // Class is declared but never used (DSL flows are never instantiated)
  7006, // Parameter implicitly has 'any' type
  7005, // Variable implicitly has 'any' type
  // Decorator-related noise — .ff.ts uses bare decorators on classes/methods, and
  // the parser already accepts them via `experimentalDecorators`.
  1219, // Experimental support for decorators is a feature subject to change
  1240, // Unable to resolve signature of property decorator
  1241, // Unable to resolve signature of method decorator
  1270, // Decorator function return type is X but expected Y
]);

/**
 * Add or refresh a user document in the virtual FS.
 * Idempotent — calling with the same content is a no-op.
 */
function updateDocument(uri: string, content: string): string {
  const virtualPath = uriToVirtualPath(uri);
  const existing = files.get(virtualPath);
  if (existing && existing.content === content) {
    userDocumentUris.add(uri);
    return virtualPath;
  }
  const version = (existing?.version ?? 0) + 1;
  files.set(virtualPath, { content, version });
  userDocumentUris.add(uri);
  return virtualPath;
}

/**
 * Drop a user document from the virtual FS (call on document close).
 */
export function removeDocument(uri: string): void {
  files.delete(uriToVirtualPath(uri));
  userDocumentUris.delete(uri);
}

/**
 * Get semantic + syntactic TypeScript diagnostics for a document.
 * Returns an empty array on errors (the embedded service should never break
 * the user's LSP session).
 */
export function getTypeScriptDiagnostics(uri: string, content: string): ts.Diagnostic[] {
  try {
    const virtualPath = updateDocument(uri, content);
    const semantic = languageService.getSemanticDiagnostics(virtualPath);
    const syntactic = languageService.getSyntacticDiagnostics(virtualPath);
    return [...syntactic, ...semantic].filter((d) => !IGNORED_CODES.has(d.code));
  } catch (err) {
    // Swallow — embedded TS diagnostics are a quality-of-life feature, not load-bearing.
    return [];
  }
}
