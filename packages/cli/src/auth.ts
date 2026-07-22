/**
 * CLI Auth Module
 *
 * Handles automatic token acquisition for the --auth flag.
 * Scans flow IR for connector operations, derives minimum required scopes,
 * and acquires tokens via MSAL with persistent cache.
 */

import type { FlowIR, Node } from '@flowforger/ir';
import type { ICachePlugin } from '@azure/msal-node';
import { PublicClientApplication } from '@azure/msal-node';
import {
  PersistenceCreator,
  PersistenceCachePlugin,
  DataProtectionScope,
} from '@azure/msal-node-extensions';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface AuthConfig {
  clientId: string;
  tenantId: string;
  resources?: {
    sharepoint?: string;
    dataverse?: string;
    /**
     * Power Platform Flow Service resource. Defaults to
     * `https://service.flow.microsoft.com`. Used to resolve `listCallbackUrl()`
     * and other Flow Service API calls. Override only if tenant-specific.
     */
    flowservice?: string;
  };
  additionalScopes?: {
    graph?: string[];
    sharepoint?: string[];
    dataverse?: string[];
  };
}

export interface ResolvedTokens {
  graph?: string;
  sharepoint?: string;
  dataverse?: string;
  dataverseUrl?: string;
  flowservice?: string;
}

const FLOW_SERVICE_RESOURCE = 'https://service.flow.microsoft.com';
const FLOW_SERVICE_SCOPES = [`${FLOW_SERVICE_RESOURCE}/User`];

// Connector name → Azure resource key
// DSL property names (excelonline, wordonline) are aliases for the full names
const CONNECTOR_RESOURCE_MAP: Record<string, string> = {
  office365: 'graph',
  office365users: 'graph',
  wordonlinebusiness: 'graph',
  wordonline: 'graph',
  excelonlinebusiness: 'graph',
  excelonline: 'graph',
  teams: 'graph',
  office365groups: 'graph',
  onedriveforbusiness: 'graph',
  onedrive: 'graph',
  sharepoint: 'sharepoint',
  dataverse: 'dataverse',
};

// Scope subsumption rules: if both exist, keep only the broader one
const SUBSUMPTION_RULES: Array<[string, string]> = [
  ['Mail.Read', 'Mail.ReadWrite'],
  ['Calendars.Read', 'Calendars.ReadWrite'],
  ['Contacts.Read', 'Contacts.ReadWrite'],
  ['Files.Read', 'Files.ReadWrite'],
  ['Team.ReadBasic.All', 'TeamMember.ReadWrite.All'],
  ['Channel.ReadBasic.All', 'Channel.Create'],
  ['Chat.Read', 'Chat.ReadWrite'],
  ['Group.Read.All', 'Group.ReadWrite.All'],
  ['GroupMember.Read.All', 'GroupMember.ReadWrite.All'],
];

const CACHE_DIR = join(homedir(), '.flowforger');
const CACHE_PATH = join(CACHE_DIR, 'token-cache.json');

/**
 * Recursively collect all connector nodes from the IR, including nested nodes
 * inside scope/if/foreach/switch/dountil.
 */
function collectConnectorNodes(nodes: Node[]): Array<{ connector: string; operation: string }> {
  const results: Array<{ connector: string; operation: string }> = [];

  for (const node of nodes) {
    if (node.type === 'connector' || node.type === 'connectorwebhook') {
      results.push({ connector: node.connector, operation: node.operation });
    }
    // Recurse into nested actions
    if ('actions' in node && Array.isArray((node as any).actions)) {
      results.push(...collectConnectorNodes((node as any).actions));
    }
    if ('elseActions' in node && Array.isArray((node as any).elseActions)) {
      results.push(...collectConnectorNodes((node as any).elseActions));
    }
    if ('defaultActions' in node && Array.isArray((node as any).defaultActions)) {
      results.push(...collectConnectorNodes((node as any).defaultActions));
    }
    if ('cases' in node && Array.isArray((node as any).cases)) {
      for (const c of (node as any).cases) {
        if (Array.isArray(c.actions)) {
          results.push(...collectConnectorNodes(c.actions));
        }
      }
    }
  }

  return results;
}

/**
 * Apply subsumption: if both Read and ReadWrite exist, keep only ReadWrite.
 */
function applySubsumption(scopes: string[]): string[] {
  const scopeSet = new Set(scopes);
  for (const [narrow, broad] of SUBSUMPTION_RULES) {
    if (scopeSet.has(narrow) && scopeSet.has(broad)) {
      scopeSet.delete(narrow);
    }
  }
  return [...scopeSet];
}

/**
 * Scan a flow IR for all connector operations and resolve the minimum required
 * scopes per Azure resource.
 *
 * Returns a Map where keys are resource URLs (e.g., 'https://graph.microsoft.com')
 * and values are deduplicated scope arrays.
 */
export async function resolveRequiredScopes(
  ir: FlowIR,
  authConfig: AuthConfig
): Promise<Map<string, string[]>> {
  const connectorOps = collectConnectorNodes(ir.nodes);

  // Group operations by connector name
  const opsByConnector = new Map<string, Set<string>>();
  for (const { connector, operation } of connectorOps) {
    if (!opsByConnector.has(connector)) opsByConnector.set(connector, new Set());
    opsByConnector.get(connector)!.add(operation);
  }

  // Collect scopes per resource URL
  const scopesByResource = new Map<string, Set<string>>();

  const addScopes = (resourceUrl: string, scopes: string[]) => {
    if (!scopesByResource.has(resourceUrl)) scopesByResource.set(resourceUrl, new Set());
    for (const s of scopes) scopesByResource.get(resourceUrl)!.add(s);
  };

  for (const [connectorName, operations] of opsByConnector) {
    const resourceKey = CONNECTOR_RESOURCE_MAP[connectorName];
    if (!resourceKey) continue; // Unknown connector, skip

    // Determine the resource URL
    let resourceUrl: string;
    if (resourceKey === 'graph') {
      resourceUrl = 'https://graph.microsoft.com';
    } else if (resourceKey === 'sharepoint') {
      if (!authConfig.resources?.sharepoint) {
        throw new Error(
          `Flow uses ${connectorName} connector but auth.resources.sharepoint is not configured in flowforger.config.json`
        );
      }
      resourceUrl = authConfig.resources.sharepoint;
    } else if (resourceKey === 'dataverse') {
      if (!authConfig.resources?.dataverse) {
        throw new Error(
          `Flow uses ${connectorName} connector but auth.resources.dataverse is not configured in flowforger.config.json`
        );
      }
      resourceUrl = authConfig.resources.dataverse;
    } else {
      continue;
    }

    // Load the connector's scope map and resolve scopes
    if (connectorName === 'office365') {
      const { office365Scopes } = await import('@flowforger/connectors-office365');
      for (const op of operations) {
        const scopes = office365Scopes[op];
        if (scopes) addScopes(resourceUrl, scopes);
        else addScopes(resourceUrl, ['User.Read']); // Fallback for unknown operations
      }
    } else if (connectorName === 'dataverse') {
      const { dataverseScopes } = await import('@flowforger/connectors-dataverse');
      addScopes(resourceUrl, dataverseScopes.default.map((s: string) => `${resourceUrl}/${s}`));
    } else if (connectorName === 'sharepoint') {
      const { sharepointScopes } = await import('@flowforger/connectors-sharepoint');
      addScopes(resourceUrl, sharepointScopes.default.map((s: string) => `${resourceUrl}/${s}`));
    } else if (connectorName === 'wordonlinebusiness' || connectorName === 'wordonline') {
      const { wordonlineScopes } = await import('@flowforger/connectors-wordonline');
      addScopes(resourceUrl, wordonlineScopes.default);
    } else if (connectorName === 'excelonlinebusiness' || connectorName === 'excelonline') {
      const { excelonlineScopes } = await import('@flowforger/connectors-excelonline');
      addScopes(resourceUrl, excelonlineScopes.default);
    } else if (connectorName === 'teams') {
      const { teamsScopes } = await import('@flowforger/connectors-teams');
      for (const op of operations) {
        const scopes = teamsScopes[op];
        if (scopes) addScopes(resourceUrl, scopes);
        else addScopes(resourceUrl, ['User.Read']);
      }
    } else if (connectorName === 'office365groups') {
      const { office365groupsScopes } = await import('@flowforger/connectors-office365groups');
      for (const op of operations) {
        const scopes = office365groupsScopes[op];
        if (scopes) addScopes(resourceUrl, scopes);
        else addScopes(resourceUrl, ['User.Read']);
      }
    } else if (connectorName === 'office365users') {
      const { office365usersScopes } = await import('@flowforger/connectors-office365users');
      for (const op of operations) {
        const scopes = office365usersScopes[op];
        if (scopes) addScopes(resourceUrl, scopes);
        else addScopes(resourceUrl, ['User.Read.All']);
      }
    } else if (connectorName === 'onedriveforbusiness' || connectorName === 'onedrive') {
      const { onedriveScopes } = await import('@flowforger/connectors-onedrive');
      addScopes(resourceUrl, onedriveScopes.default);
    }
  }

  // Add additional scopes from config
  if (authConfig.additionalScopes) {
    if (authConfig.additionalScopes.graph) {
      addScopes('https://graph.microsoft.com', authConfig.additionalScopes.graph);
    }
    if (authConfig.additionalScopes.sharepoint && authConfig.resources?.sharepoint) {
      addScopes(authConfig.resources.sharepoint, authConfig.additionalScopes.sharepoint);
    }
    if (authConfig.additionalScopes.dataverse && authConfig.resources?.dataverse) {
      addScopes(authConfig.resources.dataverse, authConfig.additionalScopes.dataverse);
    }
  }

  // Apply subsumption and convert to final map
  const result = new Map<string, string[]>();
  for (const [url, scopeSet] of scopesByResource) {
    result.set(url, applySubsumption([...scopeSet]));
  }

  return result;
}

/**
 * Create an OS-level encrypted cache plugin.
 * - Windows: DPAPI encryption (CurrentUser scope)
 * - macOS: Keychain
 * - Linux: libsecret (falls back to file-level encryption)
 */
async function createCachePlugin(log: (msg: string) => void): Promise<ICachePlugin> {
  mkdirSync(CACHE_DIR, { recursive: true });

  const persistence = await PersistenceCreator.createPersistence({
    cachePath: CACHE_PATH,
    dataProtectionScope: DataProtectionScope.CurrentUser,
    serviceName: 'FlowForger',
    accountName: 'TokenCache',
  });

  log('Auth: Using OS-level encrypted token cache');
  return new PersistenceCachePlugin(persistence);
}

/**
 * Acquire tokens for all required resources using MSAL with persistent cache.
 * Tries silent acquisition first (cached refresh tokens), falls back to device code flow.
 * Token cache is encrypted at rest using OS-level protection (DPAPI / Keychain / libsecret).
 */
export async function acquireTokens(
  authConfig: AuthConfig,
  scopesByResource: Map<string, string[]>,
  logger?: (msg: string) => void
): Promise<ResolvedTokens> {
  if (scopesByResource.size === 0) return {};

  const log = logger || (() => {});
  log(`Auth: Acquiring tokens for ${scopesByResource.size} resource(s)...`);

  const cachePlugin = await createCachePlugin(log);

  const pca = new PublicClientApplication({
    auth: {
      clientId: authConfig.clientId,
      authority: `https://login.microsoftonline.com/${authConfig.tenantId}`,
    },
    cache: { cachePlugin },
  });

  const tokens: ResolvedTokens = {};

  for (const [resourceUrl, scopes] of scopesByResource) {
    const scopeList = scopes.join(', ');
    const shortResource = resourceUrl.replace('https://', '');

    const token = await acquireTokenForResource(pca, scopes, shortResource, scopeList, log);

    // Map resource URL to token slot
    if (resourceUrl === 'https://graph.microsoft.com') {
      tokens.graph = token;
    } else if (resourceUrl === authConfig.resources?.sharepoint) {
      tokens.sharepoint = token;
    } else if (resourceUrl === authConfig.resources?.dataverse) {
      tokens.dataverse = token;
      tokens.dataverseUrl = resourceUrl;
    } else if (resourceUrl === (authConfig.resources?.flowservice ?? FLOW_SERVICE_RESOURCE)) {
      tokens.flowservice = token;
    }
  }

  return tokens;
}

/**
 * Acquire a Power Platform Flow Service token (resource
 * `https://service.flow.microsoft.com/User`). Used by `listCallbackUrl()`
 * pre-resolution. Reuses the same MSAL cache as `acquireTokens`.
 */
export async function acquireFlowServiceToken(
  authConfig: AuthConfig,
  log: (msg: string) => void = () => {},
): Promise<string | undefined> {
  const cachePlugin = await createCachePlugin(log);
  const pca = new PublicClientApplication({
    auth: {
      clientId: authConfig.clientId,
      authority: `https://login.microsoftonline.com/${authConfig.tenantId}`,
    },
    cache: { cachePlugin },
  });
  try {
    return await acquireTokenForResource(pca, FLOW_SERVICE_SCOPES, 'service.flow.microsoft.com', FLOW_SERVICE_SCOPES.join(', '), log);
  } catch (err) {
    log(`  ✗ flow service token acquisition failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Fetch the invocation callback URL for a flow's first trigger.
 * Returns undefined when the API call fails or no URL is available
 * (non-HTTP triggers, deactivated flows, missing permissions, etc.).
 */
export async function fetchTriggerCallbackUrl(opts: {
  environmentId: string;
  flowId: string;
  triggerName?: string;
  flowServiceToken: string;
  flowServiceResource?: string;
  log?: (msg: string) => void;
}): Promise<string | undefined> {
  const log = opts.log ?? (() => {});
  const apiBase = (opts.flowServiceResource ?? 'https://api.flow.microsoft.com').replace(/\/$/, '');
  const apiVersion = '2016-11-01';
  let triggerName = opts.triggerName;

  try {
    if (!triggerName) {
      const triggersUrl =
        `${apiBase}/providers/Microsoft.ProcessSimple/environments/${opts.environmentId}` +
        `/flows/${opts.flowId}/triggers?api-version=${apiVersion}`;
      const triggersRes = await fetch(triggersUrl, {
        headers: { Authorization: `Bearer ${opts.flowServiceToken}`, Accept: 'application/json' },
      });
      if (!triggersRes.ok) {
        log(`  ✗ Flow Service triggers list failed: ${triggersRes.status} ${triggersRes.statusText}`);
        return undefined;
      }
      const data = await triggersRes.json() as { value?: Array<{ name: string }> };
      triggerName = data.value?.[0]?.name;
      if (!triggerName) {
        log('  ✗ Flow has no triggers');
        return undefined;
      }
    }

    const cbUrl =
      `${apiBase}/providers/Microsoft.ProcessSimple/environments/${opts.environmentId}` +
      `/flows/${opts.flowId}/triggers/${triggerName}/listCallbackUrl?api-version=${apiVersion}`;
    const cbRes = await fetch(cbUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.flowServiceToken}`, Accept: 'application/json' },
    });
    if (!cbRes.ok) {
      log(`  ✗ listCallbackUrl failed: ${cbRes.status} ${cbRes.statusText}`);
      return undefined;
    }
    const data = await cbRes.json() as { value?: string; response?: { value?: string } };
    return data.response?.value ?? data.value;
  } catch (err) {
    log(`  ✗ listCallbackUrl error: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Scan the flow IR for any `listCallbackUrl()` calls so the host can decide
 * whether to spend an API call pre-resolving the URL. Matches `@listCallbackUrl(`
 * with optional whitespace, case-insensitive, in any string-typed input value.
 */
export function flowUsesListCallbackUrl(ir: FlowIR): boolean {
  const re = /@listCallbackUrl\s*\(/i;
  function walk(value: any): boolean {
    if (typeof value === 'string') return re.test(value);
    if (Array.isArray(value)) return value.some(walk);
    if (value && typeof value === 'object') return Object.values(value).some(walk);
    return false;
  }
  return walk(ir.nodes);
}

async function acquireTokenForResource(
  pca: PublicClientApplication,
  scopes: string[],
  shortResource: string,
  scopeList: string,
  log: (msg: string) => void
): Promise<string> {
  const accounts = await pca.getTokenCache().getAllAccounts();

  // Try silent acquisition first
  if (accounts.length > 0) {
    try {
      const result = await pca.acquireTokenSilent({ scopes, account: accounts[0] });
      log(`  ✓ ${shortResource} [${scopeList}] (cached)`);
      return result.accessToken;
    } catch {
      // Silent failed — fall through to interactive
    }
  }

  // Interactive: device code flow
  log(`  → ${shortResource} [${scopeList}]`);
  const result = await pca.acquireTokenByDeviceCode({
    scopes,
    deviceCodeCallback: (response) => {
      log(`    ${response.message}`);
    },
  });

  if (!result) {
    throw new Error(`Device code authentication failed for ${shortResource}`);
  }

  log(`  ✓ ${shortResource} (authenticated)`);
  return result.accessToken;
}
