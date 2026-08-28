/**
 * Lazy Dataverse/SharePoint metadata caches backing DSL schema completions.
 *
 * Node-side counterpart of the web app's sql-metadata-cache.ts /
 * sharepoint-schema-cache.ts with the same contract: in-memory only, failures
 * cache an empty result so completions silently degrade and never re-fetch on
 * every keystroke ("no retry storm"), and failed entries are tracked
 * separately so an explicit user action — the "Connect data sources" command,
 * or a debug session that just warmed the token cache — can drop *only* those
 * and retry via invalidateFailed(). Nothing on the completion (keystroke)
 * path may call invalidateFailed().
 *
 * Token getters passed in here MUST be silent-only (acquireTokenSilentOnly):
 * these fetchers run under the completion provider, and a device-code prompt
 * mid-typing is never acceptable. A getter returning null is a failure.
 */
import type { TableSuggestion, ColumnSuggestion } from '@flowforger/dsl-language-service';

export interface DataverseEntitySuggestion {
  /** Singular logical name, e.g. `contact` — what the metadata API keys on. */
  logicalName: string;
  displayName?: string;
  /** Plural entity set name, e.g. `contacts` — what the DSL `entityName` param needs. */
  entitySetName?: string;
}

export type SilentTokenGetter = () => Promise<string | null>;
export type SiteTokenGetter = (siteUrl: string) => Promise<string | null>;

async function fetchJson(url: string, token: string, accept: string): Promise<any> {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function requireToken(getToken: SilentTokenGetter | (() => Promise<string | null>)): Promise<string> {
  const token = await getToken();
  if (!token) throw new Error('no cached token (silent acquisition failed)');
  return token;
}

// ---------------------------------------------------------------------------
// Dataverse
// ---------------------------------------------------------------------------

export class DataverseSchemaCache {
  entities: DataverseEntitySuggestion[] | null = null;
  private entityLoad: Promise<void> | null = null;
  private attrs = new Map<string, ColumnSuggestion[]>();
  private attrLoads = new Map<string, Promise<void>>();
  private entitiesFailedFlag = false;
  private failedAttrs = new Set<string>();

  constructor(
    private baseUrl: string,
    private getToken: SilentTokenGetter
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  attributesFor(entityLogicalName: string): ColumnSuggestion[] | null {
    return this.attrs.get(entityLogicalName.toLowerCase()) ?? null;
  }

  loadEntities(): Promise<void> {
    if (this.entities) return Promise.resolve();
    if (!this.entityLoad) {
      this.entityLoad = this.fetchEntities()
        .then((list) => { this.entities = list; this.entitiesFailedFlag = false; })
        .catch(() => {
          this.entities = [];
          this.entitiesFailedFlag = true;
        });
    }
    return this.entityLoad;
  }

  loadAttributes(entityLogicalName: string): Promise<void> {
    const key = entityLogicalName.toLowerCase();
    if (this.attrs.has(key)) return Promise.resolve();
    let load = this.attrLoads.get(key);
    if (!load) {
      load = this.fetchAttributes(key)
        .then((list) => { this.attrs.set(key, list); this.failedAttrs.delete(key); })
        .catch(() => {
          this.attrs.set(key, []);
          this.failedAttrs.add(key);
        });
      this.attrLoads.set(key, load);
    }
    return load;
  }

  /** Drop only failed entries so the next load retries them. */
  invalidateFailed(): void {
    if (this.entitiesFailedFlag) {
      this.entities = null;
      this.entityLoad = null;
      this.entitiesFailedFlag = false;
    }
    for (const key of this.failedAttrs) {
      this.attrs.delete(key);
      this.attrLoads.delete(key);
    }
    this.failedAttrs.clear();
  }

  private async fetchEntities(): Promise<DataverseEntitySuggestion[]> {
    const token = await requireToken(this.getToken);
    const data = await fetchJson(
      `${this.baseUrl}/api/data/v9.2/EntityDefinitions?$select=LogicalName,DisplayName,EntitySetName,IsChildEntity,IsPrivate&api-version=9.1`,
      token,
      'application/json'
    );
    return (data.value || [])
      .filter((e: any) => !e.IsChildEntity && !e.IsPrivate)
      .map((e: any) => ({
        logicalName: e.LogicalName,
        displayName: e.DisplayName?.UserLocalizedLabel?.Label ?? undefined,
        entitySetName: e.EntitySetName ?? undefined,
      }));
  }

  private async fetchAttributes(entityLogicalName: string): Promise<ColumnSuggestion[]> {
    const token = await requireToken(this.getToken);
    const data = await fetchJson(
      `${this.baseUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${entityLogicalName}')/Attributes?$select=LogicalName,DisplayName,AttributeType,IsValidForRead&api-version=9.1`,
      token,
      'application/json'
    );
    return (data.value || [])
      .filter((a: any) => a.IsValidForRead !== false)
      .map((a: any) => ({
        name: a.LogicalName,
        displayName: a.DisplayName?.UserLocalizedLabel?.Label ?? undefined,
        type: a.AttributeType,
      }));
  }
}

// ---------------------------------------------------------------------------
// SharePoint
// ---------------------------------------------------------------------------

/** Canonical cache key for a site URL: trimmed, de-slashed, lowercased. */
export function normalizeSite(siteUrl: string): string {
  return siteUrl.trim().replace(/\/+$/, '').toLowerCase();
}

/** Strip GUID braces and lowercase. */
export function normalizeList(list: string): string {
  return list.replace(/[{}]/g, '').toLowerCase();
}

const GUID_RE = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;

export class SharePointSchemaCache {
  private lists = new Map<string, TableSuggestion[]>();
  private listLoads = new Map<string, Promise<void>>();
  private fields = new Map<string, ColumnSuggestion[]>();
  private fieldLoads = new Map<string, Promise<void>>();
  private failedLists = new Set<string>();
  private failedFields = new Set<string>();

  constructor(private getToken: SiteTokenGetter) {}

  listsFor(siteUrl: string): TableSuggestion[] | null {
    return this.lists.get(normalizeSite(siteUrl)) ?? null;
  }

  loadLists(siteUrl: string): Promise<void> {
    const key = normalizeSite(siteUrl);
    if (this.lists.has(key)) return Promise.resolve();
    let load = this.listLoads.get(key);
    if (!load) {
      load = this.fetchLists(siteUrl)
        .then((l) => { this.lists.set(key, l); this.failedLists.delete(key); })
        .catch(() => {
          this.lists.set(key, []);
          this.failedLists.add(key);
        });
      this.listLoads.set(key, load);
    }
    return load;
  }

  fieldsFor(siteUrl: string, list: string): ColumnSuggestion[] | null {
    return this.fields.get(`${normalizeSite(siteUrl)}|${normalizeList(list)}`) ?? null;
  }

  loadFields(siteUrl: string, list: string): Promise<void> {
    const key = `${normalizeSite(siteUrl)}|${normalizeList(list)}`;
    if (this.fields.has(key)) return Promise.resolve();
    let load = this.fieldLoads.get(key);
    if (!load) {
      load = this.fetchFields(siteUrl, list)
        .then((f) => { this.fields.set(key, f); this.failedFields.delete(key); })
        .catch(() => {
          this.fields.set(key, []);
          this.failedFields.add(key);
        });
      this.fieldLoads.set(key, load);
    }
    return load;
  }

  /** Drop only failed entries so the next load retries them. */
  invalidateFailed(): void {
    for (const key of [...this.failedLists]) {
      this.lists.delete(key);
      this.listLoads.delete(key);
      this.failedLists.delete(key);
    }
    for (const key of [...this.failedFields]) {
      this.fields.delete(key);
      this.fieldLoads.delete(key);
      this.failedFields.delete(key);
    }
  }

  private async fetchLists(siteUrl: string): Promise<TableSuggestion[]> {
    const token = await requireToken(() => this.getToken(siteUrl));
    const site = siteUrl.replace(/\/+$/, '');
    const data = await fetchJson(
      `${site}/_api/web/lists?$select=Id,Title&$filter=Hidden eq false`,
      token,
      'application/json;odata=nometadata'
    );
    return (data.value || []).map((l: any) => ({ name: l.Id, displayName: l.Title }));
  }

  private async fetchFields(siteUrl: string, listIdOrTitle: string): Promise<ColumnSuggestion[]> {
    const token = await requireToken(() => this.getToken(siteUrl));
    const site = siteUrl.replace(/\/+$/, '');
    const clean = listIdOrTitle.replace(/[{}]/g, '');
    const base = GUID_RE.test(listIdOrTitle)
      ? `${site}/_api/web/lists(guid'${clean}')`
      : `${site}/_api/web/lists/getbytitle('${encodeURIComponent(listIdOrTitle.replace(/'/g, "''"))}')`;
    const data = await fetchJson(
      `${base}/fields?$select=InternalName,Title,TypeAsString,Required&$filter=Hidden eq false and ReadOnlyField eq false`,
      token,
      'application/json;odata=nometadata'
    );
    return (data.value || []).map((f: any) => ({
      name: f.InternalName,
      displayName: f.Title,
      type: f.TypeAsString,
      required: f.Required === true,
    }));
  }
}
