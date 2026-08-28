/**
 * Schema-aware DSL completions for VS Code: Dataverse tables/columns and
 * SharePoint sites/lists/fields inside ctx.connectors.* calls.
 *
 * Detection lives in @flowforger/dsl-language-service (shared with the web
 * app's Monaco editor); this module reconstructs the statement around the
 * cursor, resolves sibling parameter refs via the symbol index, awaits the
 * lazy metadata caches (schema-cache.ts), and maps results to
 * vscode.CompletionItem. The whole path is silent-only: token acquisition
 * never prompts, and every failure degrades to "no schema completions" so the
 * LSP server's regular DSL completions still show.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  analyzeSchemaCompletionContext,
  buildSymbolIndex,
  type SchemaValueRef,
  type SymbolIndex,
} from '@flowforger/dsl-language-service';
import { sharepointScopes } from '@flowforger/connectors-sharepoint';
import { dataverseScopes } from '@flowforger/connectors-dataverse';
import { acquireTokenSilentOnly, type AuthConfig } from './auth.js';
import { DataverseSchemaCache, SharePointSchemaCache } from './schema-cache.js';

const FORWARD_LINE_CAP = 40;

// ---------------------------------------------------------------------------
// Config discovery + cache ownership
// ---------------------------------------------------------------------------

/**
 * Owns the metadata caches and resolves flowforger.config.json's auth section
 * (workspace root first, then the flow file's directory — same order as the
 * debug config provider). Config reads are mtime-cached because this runs on
 * the completion path.
 */
export class SchemaContextManager {
  private configCache: { path: string; mtimeMs: number; auth: AuthConfig | null } | null = null;
  private dvCaches = new Map<string, DataverseSchemaCache>();
  private spCache: SharePointSchemaCache | null = null;
  /** Latest resolved auth config — read by the SharePoint token closure. */
  private lastAuth: AuthConfig | null = null;

  getAuthConfig(documentPath: string): AuthConfig | null {
    const candidates = [
      ...(vscode.workspace.workspaceFolders ?? []).map((f) =>
        path.join(f.uri.fsPath, 'flowforger.config.json')
      ),
      path.join(path.dirname(documentPath), 'flowforger.config.json'),
    ];
    const configPath = candidates.find((p) => fs.existsSync(p));
    if (!configPath) return null;

    try {
      const mtimeMs = fs.statSync(configPath).mtimeMs;
      if (
        this.configCache &&
        this.configCache.path === configPath &&
        this.configCache.mtimeMs === mtimeMs
      ) {
        return this.configCache.auth;
      }
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const auth: AuthConfig | null =
        raw.auth?.clientId && raw.auth?.tenantId ? raw.auth : null;
      this.configCache = { path: configPath, mtimeMs, auth };
      if (auth) this.lastAuth = auth;
      return auth;
    } catch {
      return null;
    }
  }

  dataverseFor(documentPath: string): DataverseSchemaCache | null {
    const auth = this.getAuthConfig(documentPath);
    const url = auth?.resources?.dataverse?.replace(/\/+$/, '');
    if (!auth || !url) return null;
    let cache = this.dvCaches.get(url);
    if (!cache) {
      cache = new DataverseSchemaCache(url, () =>
        acquireTokenSilentOnly(
          auth,
          dataverseScopes.default.map((s: string) => `${url}/${s}`)
        )
      );
      this.dvCaches.set(url, cache);
    }
    return cache;
  }

  sharepoint(documentPath: string): SharePointSchemaCache | null {
    const auth = this.getAuthConfig(documentPath);
    if (!auth) return null;
    if (!this.spCache) {
      // Token resource is the site's origin (https://tenant.sharepoint.com),
      // so one cache serves every site; the closure re-reads lastAuth so a
      // config edit doesn't strand it with stale credentials.
      this.spCache = new SharePointSchemaCache(async (siteUrl) => {
        const currentAuth = this.lastAuth;
        if (!currentAuth) return null;
        let origin: string;
        try {
          origin = new URL(siteUrl).origin;
        } catch {
          return null;
        }
        return acquireTokenSilentOnly(
          currentAuth,
          sharepointScopes.default.map((s: string) => `${origin}/${s}`)
        );
      });
    }
    return this.spCache;
  }

  /**
   * Retry entries whose emptiness came from a failed fetch. Call only from
   * explicit user actions that just warmed the token cache (the "Connect data
   * sources" command, a finished debug session) — never from the completion
   * path, which must stay retry-free.
   */
  invalidateFailed(): void {
    for (const cache of this.dvCaches.values()) cache.invalidateFailed();
    this.spCache?.invalidateFailed();
  }
}

// ---------------------------------------------------------------------------
// Statement reconstruction (mirror of the web app's schema-completions.ts)
// ---------------------------------------------------------------------------

/**
 * Find the line (0-based) that starts the statement containing `currentLine`,
 * by walking backwards to the nearest `await`. `await ctx.` is recognised
 * anywhere on the line (`const items = await ctx.connectors...`), and this
 * check runs BEFORE the statement-keyword bail-out, which would otherwise
 * stop at the `const` and lose the call.
 */
export function findStatementStartLine(document: vscode.TextDocument, currentLine: number): number {
  for (let line = currentLine; line >= 0; line--) {
    const content = document.lineAt(line).text;
    if (/^\s*await\s/.test(content)) return line;
    if (/\bawait\s+ctx\./.test(content)) return line;
    if (/^\s*(const|let|var|if|for|while|return|throw)\s/.test(content)) return currentLine;
  }
  return Math.max(0, currentLine - 100);
}

/**
 * Text of the current statement including lines AFTER the cursor (bounded),
 * so sibling params written below the cursor still resolve.
 */
export function getStatementTextAround(
  document: vscode.TextDocument,
  position: vscode.Position
): { text: string; cursorOffset: number } {
  const startLine = findStatementStartLine(document, position.line);
  const before = document.getText(new vscode.Range(startLine, 0, position.line, position.character));
  const endLine = Math.min(document.lineCount - 1, position.line + FORWARD_LINE_CAP);
  const after = document.getText(
    new vscode.Range(position.line, position.character, endLine, document.lineAt(endLine).text.length)
  );
  return { text: before + after, cursorOffset: before.length };
}

/**
 * 0-based character index of the first character INSIDE the string literal
 * that is still open at the cursor, or null when no literal is open. Used to
 * replace the whole string value — the word range breaks on `/ . : -` so a
 * half-typed URL or list title would otherwise be mangled on accept.
 */
function openStringStartChar(lineTextBeforeCursor: string): number | null {
  let quote: string | null = null;
  let start = -1;
  for (let i = 0; i < lineTextBeforeCursor.length; i++) {
    const ch = lineTextBeforeCursor[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) { quote = null; start = -1; }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; start = i + 1; }
  }
  return quote ? start : null;
}

// ---------------------------------------------------------------------------
// Symbol-index-backed sibling resolution
// ---------------------------------------------------------------------------

/**
 * Lazily-built, per-request symbol index: buildSymbolIndex() is a full
 * TypeScript parse of the document and must run at most once per request.
 */
type SymbolIndexProvider = () => SymbolIndex | null;

function makeSymbolIndexProvider(dslCode: string): SymbolIndexProvider {
  let cached: SymbolIndex | null | undefined;
  return () => {
    if (cached === undefined) {
      try {
        cached = buildSymbolIndex(dslCode);
      } catch {
        cached = null;
      }
    }
    return cached;
  };
}

function resolveRef(ref: SchemaValueRef | undefined, getIndex: SymbolIndexProvider): string | null {
  if (!ref) return null;
  if (ref.kind === 'literal') return ref.value || null;
  const index = getIndex();
  if (!index) return null;
  return index.parameters.find((p) => p.name === ref.name)?.defaultValue ?? null;
}

// ---------------------------------------------------------------------------
// Completion provider
// ---------------------------------------------------------------------------

interface NamedSuggestion {
  name: string;
  displayName?: string;
  type?: string;
  required?: boolean;
}

function toItems(
  range: vscode.Range,
  items: NamedSuggestion[],
  opts: { kindLabel: string; objectKey?: boolean }
): vscode.CompletionItem[] {
  return items.map((s) => {
    const item = new vscode.CompletionItem(
      s.displayName ? `${s.name} — ${s.displayName}` : s.name,
      vscode.CompletionItemKind.Field
    );
    item.filterText = `${s.name} ${s.displayName ?? ''}`;
    item.detail = [s.type, s.required ? 'required' : undefined, opts.kindLabel]
      .filter(Boolean)
      .join(' · ');
    item.insertText = opts.objectKey ? `${s.name}: ` : s.name;
    item.range = range;
    item.sortText = `${s.required ? '0' : '1'}_${s.name}`;
    return item;
  });
}

export class SchemaCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private manager: SchemaContextManager) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[] | undefined> {
    try {
      const { text, cursorOffset } = getStatementTextAround(document, position);
      const ctx = analyzeSchemaCompletionContext(text, cursorOffset);
      if (!ctx) return undefined;

      // Replacement range. For string values, replace the whole open literal;
      // otherwise the current word up to (never past) the cursor.
      let range: vscode.Range;
      if (ctx.position === 'value') {
        const before = document.getText(
          new vscode.Range(position.line, 0, position.line, position.character)
        );
        const start = openStringStartChar(before);
        range = new vscode.Range(position.line, start ?? position.character, position.line, position.character);
      } else {
        const wordRange = document.getWordRangeAtPosition(position);
        range = wordRange
          ? new vscode.Range(wordRange.start, position)
          : new vscode.Range(position, position);
      }

      const dslCode = document.getText();
      const getIndex = makeSymbolIndexProvider(dslCode);
      const documentPath = document.uri.fsPath;

      switch (ctx.type) {
        case 'dataverse-entity': {
          const cache = this.manager.dataverseFor(documentPath);
          if (!cache) return undefined;
          await cache.loadEntities();
          const entities = cache.entities ?? [];
          // Insert the PLURAL entity set name: the connector interpolates
          // `entityName` verbatim into the Web API path, so the singular
          // logical name would 404 at runtime.
          return entities.map((e) => {
            const setName = e.entitySetName ?? e.logicalName;
            const item = new vscode.CompletionItem(
              e.displayName ? `${setName} — ${e.displayName}` : setName,
              vscode.CompletionItemKind.Field
            );
            item.filterText = `${setName} ${e.logicalName} ${e.displayName ?? ''}`;
            item.detail = 'Dataverse table';
            item.insertText = setName;
            item.range = range;
            item.sortText = `1_${setName}`;
            return item;
          });
        }

        case 'dataverse-column': {
          const cache = this.manager.dataverseFor(documentPath);
          if (!cache) return undefined;
          const entityRef = resolveRef(ctx.entityName, getIndex);
          if (!entityRef) return undefined;
          // The sibling value is an entity SET name (plural) but the metadata
          // API keys on the singular logical name — translate off the cached
          // entity list first; no match means it's already a logical name.
          await cache.loadEntities();
          const match = (cache.entities ?? []).find(
            (e) => e.entitySetName?.toLowerCase() === entityRef.toLowerCase()
          );
          const entity = match?.logicalName ?? entityRef;
          await cache.loadAttributes(entity);
          const attrs = cache.attributesFor(entity) ?? [];
          return toItems(range, attrs, {
            kindLabel: `column of ${entity}`,
            objectKey: ctx.position === 'objectKey',
          });
        }

        case 'sharepoint-site': {
          // No tenant-wide site enumeration: suggest URLs already known to
          // the flow — parameter defaults and dataset literals in the file.
          const urls = new Set<string>();
          for (const p of getIndex()?.parameters ?? []) {
            if (p.defaultValue && p.defaultValue.includes('sharepoint.com')) urls.add(p.defaultValue);
          }
          const cursorDocOffset = document.offsetAt(position);
          const literalRe = /dataset\s*:\s*['"]([^'"]+)['"]/g;
          let m: RegExpExecArray | null;
          while ((m = literalRe.exec(dslCode)) !== null) {
            // Skip the literal being edited: it has no closing quote yet, so
            // the regex would pair the half-typed text with the NEXT quote.
            if (m.index <= cursorDocOffset && m.index + m[0].length > cursorDocOffset) continue;
            urls.add(m[1]);
          }
          return [...urls].map((url) => {
            const item = new vscode.CompletionItem(url, vscode.CompletionItemKind.Value);
            item.detail = 'SharePoint site (used in this flow)';
            item.insertText = url;
            item.range = range;
            item.sortText = `0_${url}`;
            return item;
          });
        }

        case 'sharepoint-list': {
          const cache = this.manager.sharepoint(documentPath);
          if (!cache) return undefined;
          const site = resolveRef(ctx.siteUrl, getIndex);
          if (!site) return undefined;
          await cache.loadLists(site);
          const lists = cache.listsFor(site) ?? [];
          // Label = list title, inserted text = GUID (the engine needs GUIDs).
          return lists.map((l) => {
            const item = new vscode.CompletionItem(
              l.displayName ?? l.name,
              vscode.CompletionItemKind.Field
            );
            item.filterText = `${l.displayName ?? ''} ${l.name}`;
            item.detail = `list ${l.name}`;
            item.insertText = l.name;
            item.range = range;
            item.sortText = `0_${l.displayName ?? l.name}`;
            return item;
          });
        }

        case 'sharepoint-column': {
          const cache = this.manager.sharepoint(documentPath);
          if (!cache) return undefined;
          const site = resolveRef(ctx.siteUrl, getIndex);
          const list = resolveRef(ctx.list, getIndex);
          if (!site || !list) return undefined;
          await cache.loadFields(site, list);
          const fields = cache.fieldsFor(site, list) ?? [];
          return toItems(range, fields, {
            kindLabel: 'SharePoint field',
            objectKey: ctx.position === 'objectKey',
          });
        }
      }
      return undefined;
    } catch (e) {
      // This path fires on keystrokes — degrade to "no schema completions"
      // (the LSP server's completions still apply) rather than surfacing.
      console.warn('FlowForger schema completions failed:', e);
      return undefined;
    }
  }
}
