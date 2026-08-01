/**
 * The canonical connector-building implementation, shared by the VS Code
 * extension debug adapter, the CLI's `run` command, and the MCP server.
 * Superset of the three previous copies: all seven Graph connectors,
 * per-connector token overrides, and WebContents.
 */

import type { BaseConnector } from '@flowforger/engine';
import { HttpConnector, WebContentsConnector } from '@flowforger/connectors-http';
import { SharePointConnector } from '@flowforger/connectors-sharepoint';
import { DataverseConnector } from '@flowforger/connectors-dataverse';
import { Office365Connector } from '@flowforger/connectors-office365';
import { Office365UsersConnector } from '@flowforger/connectors-office365users';
import { Office365GroupsConnector } from '@flowforger/connectors-office365groups';
import { WordOnlineConnector } from '@flowforger/connectors-wordonline';
import { ExcelOnlineConnector } from '@flowforger/connectors-excelonline';
import { TeamsConnector } from '@flowforger/connectors-teams';
import { OneDriveConnector } from '@flowforger/connectors-onedrive';

export interface ConnectorOptions {
  spToken?: string;
  dvUrl?: string;
  dvToken?: string;
  /** Shared Microsoft Graph token; per-connector fields below override it. */
  graphToken?: string;
  wordToken?: string;
  excelToken?: string;
  onedriveToken?: string;
}

/**
 * Graph-backed connectors. `keys[0]` is canonical; any remaining keys are
 * aliases bound to the same instance. `tokenField` names a per-connector
 * override that takes precedence over `graphToken`.
 */
const GRAPH_CONNECTORS: Array<{
  ctor: new (opts: { token: string }) => unknown;
  keys: string[];
  tokenField?: keyof ConnectorOptions;
}> = [
  { ctor: Office365Connector as any, keys: ['office365'] },
  { ctor: Office365UsersConnector as any, keys: ['office365users'] },
  { ctor: Office365GroupsConnector as any, keys: ['office365groups'] },
  { ctor: TeamsConnector as any, keys: ['teams'] },
  { ctor: WordOnlineConnector as any, keys: ['wordonlinebusiness', 'wordonline'], tokenField: 'wordToken' },
  { ctor: ExcelOnlineConnector as any, keys: ['excelonlinebusiness', 'excelonline'], tokenField: 'excelToken' },
  { ctor: OneDriveConnector as any, keys: ['onedriveforbusiness', 'onedrive'], tokenField: 'onedriveToken' },
];

export function buildConnectors(options: ConnectorOptions): Record<string, BaseConnector> {
  const connectors: Record<string, BaseConnector> = { http: new HttpConnector() as any };

  if (options.spToken) {
    connectors['sharepoint'] = new SharePointConnector({ token: options.spToken }) as any;
  }
  if (options.dvUrl && options.dvToken) {
    connectors['dataverse'] = new DataverseConnector({
      baseUrl: options.dvUrl,
      token: options.dvToken,
    }) as any;
  }

  for (const entry of GRAPH_CONNECTORS) {
    const token = (entry.tokenField ? (options[entry.tokenField] as string | undefined) : undefined)
      ?? options.graphToken;
    if (!token) continue;
    const instance = new entry.ctor({ token }) as BaseConnector;
    for (const key of entry.keys) connectors[key] = instance;
  }

  // WebContents resolves $content references behind SharePoint/Dataverse URLs.
  // Gate on any token it can actually consume, not graphToken alone — a
  // SharePoint- or Dataverse-only run has everything WebContents needs.
  if (options.spToken || options.dvToken || options.graphToken) {
    connectors['webcontents'] = new WebContentsConnector({
      dataverseToken: options.dvToken,
      sharepointToken: options.spToken || options.graphToken,
    }) as any;
  }

  return connectors;
}
