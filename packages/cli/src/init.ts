/**
 * CLI Init Module
 *
 * Auto-discovers configuration values from a Dataverse environment:
 * - Tenant ID from unauthenticated 401 WWW-Authenticate header
 * - Connection reference logical names from Dataverse API
 * - SharePoint resource URL from tenant name
 */

import { DataverseClient, type ConnectionReferenceRecord } from '@flowforger/dataverse-sdk';
import { PublicClientApplication } from '@azure/msal-node';
import {
  PersistenceCreator,
  PersistenceCachePlugin,
  DataProtectionScope,
} from '@azure/msal-node-extensions';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CACHE_DIR = join(homedir(), '.flowforger');
const CACHE_PATH = join(CACHE_DIR, 'token-cache.json');

/**
 * Mapping from FlowForger connector short names to Dataverse connectorid suffixes.
 * The connectorid in Dataverse is the full path like:
 *   /providers/Microsoft.PowerApps/apis/shared_sharepointonline
 * We match on the last segment.
 */
const CONNECTOR_API_MAP: Record<string, string> = {
  sharepoint: 'shared_sharepointonline',
  dataverse: 'shared_commondataserviceforapps',
  office365: 'shared_office365',
  office365users: 'shared_office365users',
  office365groups: 'shared_office365groups',
  approvals: 'shared_approvals',
  excelonline: 'shared_excelonlinebusiness',
  wordonline: 'shared_wordonlinebusiness',
  teams: 'shared_teams',
};

/**
 * Discover tenant ID from a Dataverse URL by making an unauthenticated request.
 * The 401 response includes a WWW-Authenticate header with the authorization URI
 * containing the tenant ID.
 *
 * Example header:
 *   Bearer authorization_uri=https://login.microsoftonline.com/2a122ff6-.../oauth2/authorize, ...
 */
export async function discoverTenantId(dataverseUrl: string): Promise<string> {
  try {
    new URL(dataverseUrl);
  } catch {
    throw new Error(`Invalid Dataverse URL: ${dataverseUrl}`);
  }
  const url = `${dataverseUrl.replace(/\/$/, '')}/api/data/v9.2/`;
  const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000) });

  const wwwAuth = res.headers.get('www-authenticate') || '';
  // Match: authorization_uri=https://login.microsoftonline.com/{tenantId}/oauth2/authorize
  const match = wwwAuth.match(/authorization_uri=https:\/\/login\.microsoftonline\.com\/([a-f0-9-]+)\//i);
  if (!match) {
    throw new Error(
      `Could not discover tenant ID from ${dataverseUrl}. ` +
      `Expected WWW-Authenticate header with authorization_uri. ` +
      `Got: ${wwwAuth || '(empty)'}`
    );
  }
  return match[1];
}

/**
 * Acquire a Dataverse token using MSAL device code flow.
 * Uses the same persistent encrypted cache as the main auth module.
 */
export async function acquireInitToken(
  clientId: string,
  tenantId: string,
  dataverseUrl: string,
  log: (msg: string) => void
): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });

  const persistence = await PersistenceCreator.createPersistence({
    cachePath: CACHE_PATH,
    dataProtectionScope: DataProtectionScope.CurrentUser,
    serviceName: 'FlowForger',
    accountName: 'TokenCache',
  });

  const cachePlugin = new PersistenceCachePlugin(persistence);

  const pca = new PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
    cache: { cachePlugin },
  });

  const scopes = [`${dataverseUrl.replace(/\/$/, '')}/user_impersonation`];

  // Try silent first
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    try {
      const result = await pca.acquireTokenSilent({ scopes, account: accounts[0] });
      log('  Authenticated (cached token)');
      return result.accessToken;
    } catch {
      // Fall through to interactive
    }
  }

  // Interactive: device code flow
  const result = await pca.acquireTokenByDeviceCode({
    scopes,
    deviceCodeCallback: (response) => {
      log(`  ${response.message}`);
    },
  });

  if (!result) {
    throw new Error('Device code authentication failed');
  }

  log('  Authenticated successfully');
  return result.accessToken;
}

/**
 * Discover connection references from a Dataverse environment.
 * Returns a map from FlowForger connector short name to the connection reference details.
 */
export async function discoverConnectionReferences(
  dataverseUrl: string,
  token: string,
  log: (msg: string) => void
): Promise<Map<string, { logicalName: string; displayName: string }>> {
  const client = new DataverseClient({ baseUrl: dataverseUrl, token });
  const refs = await client.listConnectionReferences();

  const result = new Map<string, { logicalName: string; displayName: string }>();

  for (const ref of refs) {
    // Extract the connector short name from the full connectorid path
    // e.g., "/providers/Microsoft.PowerApps/apis/shared_sharepointonline" → "shared_sharepointonline"
    const connectorSuffix = ref.connectorid.split('/').pop() || '';

    // Map to our short name
    for (const [shortName, apiSuffix] of Object.entries(CONNECTOR_API_MAP)) {
      if (connectorSuffix === apiSuffix && !result.has(shortName)) {
        result.set(shortName, {
          logicalName: ref.connectionreferencelogicalname,
          displayName: ref.connectionreferencedisplayname || connectorSuffix,
        });
      }
    }
  }

  // Log discovered references
  if (result.size > 0) {
    log(`  Found ${result.size} connection reference(s):`);
    for (const [name, info] of result) {
      log(`    ${name}: ${info.logicalName} (${info.displayName})`);
    }
  } else {
    log('  No matching connection references found in this environment.');
  }

  // Also log any unrecognized connectors for visibility
  const unmapped = refs.filter(r => {
    const suffix = r.connectorid.split('/').pop() || '';
    return !Object.values(CONNECTOR_API_MAP).includes(suffix);
  });
  if (unmapped.length > 0) {
    log(`  ${unmapped.length} additional connector(s) not auto-mapped:`);
    for (const ref of unmapped) {
      const suffix = ref.connectorid.split('/').pop() || '';
      log(`    ${suffix}: ${ref.connectionreferencelogicalname}`);
    }
  }

  return result;
}

export interface InitOptions {
  clientId: string;
  tenantId: string;
  dataverseUrl: string;
  sharepointUrl?: string;
  connectionRefs: Map<string, { logicalName: string; displayName: string }>;
}

/**
 * Generate a complete flowforger.config.json object from discovered values.
 */
export function generateConfig(opts: InitOptions): Record<string, any> {
  const connections: Record<string, any> = {};

  // Build connection entries for all known connectors
  for (const [shortName, apiSuffix] of Object.entries(CONNECTOR_API_MAP)) {
    const ref = opts.connectionRefs.get(shortName);
    connections[shortName] = {
      referenceName: apiSuffix,
      apiId: `/providers/Microsoft.PowerApps/apis/${apiSuffix}`,
      connectionReferenceLogicalName: ref?.logicalName || '',
      runtimeSource: 'embedded',
    };
  }

  return {
    auth: {
      clientId: opts.clientId,
      tenantId: opts.tenantId,
      resources: {
        dataverse: opts.dataverseUrl,
        ...(opts.sharepointUrl ? { sharepoint: opts.sharepointUrl } : { sharepoint: '' }),
      },
    },
    global: {
      parser: {
        skipMetadataFields: ['operationMetadataId'],
        skipActionNamesForKinds: ['initializevariable', 'setvariable'],
      },
      generator: {
        argumentWhitespace: 'spaced',
        multilineExpressions: 'preserve',
      },
      emitter: {
        includeMetadata: false,
        keyOrdering: 'logical',
        emptyRunAfter: 'preserve',
      },
      parity: {
        ignoreMetadata: true,
        normalizeFunctionCase: true,
        normalizeNumbers: true,
        normalizeSpaces: true,
      },
      connections,
    },
    environments: {
      dev: {},
      prod: {},
    },
  };
}
