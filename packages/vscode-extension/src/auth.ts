/**
 * VS Code Extension Auth Module
 *
 * Acquires tokens via MSAL for debug sessions.
 * Uses a simple file-based token cache (no native modules).
 * Reuses the same auth config format as the CLI's flowforger.config.json.
 */

import type { FlowIR, Node } from '@flowforger/ir';
import type { ICachePlugin, TokenCacheContext } from '@azure/msal-node';
import { PublicClientApplication } from '@azure/msal-node';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { sharepointScopes } from '@flowforger/connectors-sharepoint';
import { dataverseScopes } from '@flowforger/connectors-dataverse';
import { office365Scopes } from '@flowforger/connectors-office365';
import { office365usersScopes } from '@flowforger/connectors-office365users';

export interface AuthConfig {
  clientId: string;
  tenantId: string;
  resources?: {
    sharepoint?: string;
    dataverse?: string;
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
}

export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  message: string;
}

// Connector name → Azure resource key
const CONNECTOR_RESOURCE_MAP: Record<string, string> = {
  office365: 'graph',
  office365users: 'graph',
  wordonlinebusiness: 'graph',
  wordonline: 'graph',
  excelonlinebusiness: 'graph',
  excelonline: 'graph',
  teams: 'graph',
  sharepoint: 'sharepoint',
  dataverse: 'dataverse',
};

// Scope subsumption rules: if both exist, keep only the broader one
const SUBSUMPTION_RULES: Array<[string, string]> = [
  ['Mail.Read', 'Mail.ReadWrite'],
  ['Calendars.Read', 'Calendars.ReadWrite'],
  ['Contacts.Read', 'Contacts.ReadWrite'],
  ['Files.Read', 'Files.ReadWrite'],
];

const CACHE_DIR = join(homedir(), '.flowforger');
const CACHE_PATH = join(CACHE_DIR, 'vscode-token-cache.json');

/**
 * Recursively collect all connector nodes from the IR.
 */
function collectConnectorNodes(nodes: Node[]): Array<{ connector: string; operation: string }> {
  const results: Array<{ connector: string; operation: string }> = [];

  for (const node of nodes) {
    if (node.type === 'connector' || node.type === 'connectorwebhook') {
      results.push({ connector: node.connector, operation: node.operation });
    }
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
 * Apply scope subsumption: if both Read and ReadWrite exist, keep only ReadWrite.
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
 * Scan a flow IR for connector operations and resolve required scopes per resource.
 */
export function resolveRequiredScopes(
  ir: FlowIR,
  authConfig: AuthConfig
): Map<string, string[]> {
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
    if (!resourceKey) continue;

    let resourceUrl: string;
    if (resourceKey === 'graph') {
      resourceUrl = 'https://graph.microsoft.com';
    } else if (resourceKey === 'sharepoint') {
      if (!authConfig.resources?.sharepoint) {
        throw new Error(
          `Flow uses ${connectorName} connector but auth.resources.sharepoint is not configured`
        );
      }
      resourceUrl = authConfig.resources.sharepoint;
    } else if (resourceKey === 'dataverse') {
      if (!authConfig.resources?.dataverse) {
        throw new Error(
          `Flow uses ${connectorName} connector but auth.resources.dataverse is not configured`
        );
      }
      resourceUrl = authConfig.resources.dataverse;
    } else {
      continue;
    }

    // Resolve scopes from connector metadata
    if (connectorName === 'office365') {
      for (const op of operations) {
        const scopes = (office365Scopes as any)[op];
        if (scopes) addScopes(resourceUrl, scopes);
        else addScopes(resourceUrl, ['User.Read']);
      }
    } else if (connectorName === 'office365users') {
      for (const op of operations) {
        const scopes = (office365usersScopes as any)[op];
        if (scopes) addScopes(resourceUrl, scopes);
        else addScopes(resourceUrl, ['User.Read.All']);
      }
    } else if (connectorName === 'sharepoint') {
      addScopes(resourceUrl, (sharepointScopes as any).default.map((s: string) => `${resourceUrl}/${s}`));
    } else if (connectorName === 'dataverse') {
      addScopes(resourceUrl, (dataverseScopes as any).default.map((s: string) => `${resourceUrl}/${s}`));
    } else if (resourceKey === 'graph') {
      // For graph-based connectors without specific scope maps, use default
      addScopes(resourceUrl, ['User.Read']);
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

  // Apply subsumption
  const result = new Map<string, string[]>();
  for (const [url, scopeSet] of scopesByResource) {
    result.set(url, applySubsumption([...scopeSet]));
  }

  return result;
}

/**
 * Simple file-based cache plugin for MSAL.
 * No native module dependencies — just reads/writes JSON.
 */
function createFileCachePlugin(): ICachePlugin {
  mkdirSync(CACHE_DIR, { recursive: true });

  return {
    beforeCacheAccess: async (cacheContext: TokenCacheContext) => {
      if (existsSync(CACHE_PATH)) {
        cacheContext.tokenCache.deserialize(readFileSync(CACHE_PATH, 'utf-8'));
      }
    },
    afterCacheAccess: async (cacheContext: TokenCacheContext) => {
      if (cacheContext.cacheHasChanged) {
        writeFileSync(CACHE_PATH, cacheContext.tokenCache.serialize());
      }
    },
  };
}

/**
 * Acquire tokens for all required resources.
 * Tries silent acquisition first, falls back to device code flow.
 */
export async function acquireTokens(
  authConfig: AuthConfig,
  scopesByResource: Map<string, string[]>,
  callbacks: {
    onLog: (msg: string) => void;
    onDeviceCode: (info: DeviceCodeInfo) => void;
  }
): Promise<ResolvedTokens> {
  if (scopesByResource.size === 0) return {};

  callbacks.onLog(`Acquiring tokens for ${scopesByResource.size} resource(s)...`);

  const pca = new PublicClientApplication({
    auth: {
      clientId: authConfig.clientId,
      authority: `https://login.microsoftonline.com/${authConfig.tenantId}`,
    },
    cache: { cachePlugin: createFileCachePlugin() },
  });

  const tokens: ResolvedTokens = {};

  for (const [resourceUrl, scopes] of scopesByResource) {
    const shortResource = resourceUrl.replace('https://', '');
    const accounts = await pca.getTokenCache().getAllAccounts();

    // Try silent acquisition
    if (accounts.length > 0) {
      try {
        const result = await pca.acquireTokenSilent({ scopes, account: accounts[0] });
        callbacks.onLog(`  ✓ ${shortResource} (cached)`);
        assignToken(tokens, resourceUrl, authConfig, result.accessToken);
        continue;
      } catch {
        // Silent failed — fall through to device code
      }
    }

    // Device code flow
    callbacks.onLog(`  → ${shortResource} — device code login required`);
    const result = await pca.acquireTokenByDeviceCode({
      scopes,
      deviceCodeCallback: (response) => {
        callbacks.onDeviceCode({
          userCode: response.userCode,
          verificationUri: response.verificationUri,
          message: response.message,
        });
      },
    });

    if (!result) {
      throw new Error(`Authentication failed for ${shortResource}`);
    }

    callbacks.onLog(`  ✓ ${shortResource} (authenticated)`);
    assignToken(tokens, resourceUrl, authConfig, result.accessToken);
  }

  return tokens;
}

function assignToken(
  tokens: ResolvedTokens,
  resourceUrl: string,
  authConfig: AuthConfig,
  accessToken: string
): void {
  if (resourceUrl === 'https://graph.microsoft.com') {
    tokens.graph = accessToken;
  } else if (resourceUrl === authConfig.resources?.sharepoint) {
    tokens.sharepoint = accessToken;
  } else if (resourceUrl === authConfig.resources?.dataverse) {
    tokens.dataverse = accessToken;
    tokens.dataverseUrl = resourceUrl;
  }
}
