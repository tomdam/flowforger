/**
 * Connector Registry
 *
 * Aggregates connector metadata from all connector packages.
 * Provides a unified interface for accessing connector operations.
 *
 * The registry tries to import metadata from connector packages.
 * If packages are not available (e.g., in browser without bundled connectors),
 * it falls back to the legacy connector-operations.ts definitions.
 */

import type { ConnectorMetadata, OperationMetadata } from '@flowforger/connectors-shared';

// Storage for loaded connector metadata
const connectorRegistry: Map<string, ConnectorMetadata> = new Map();
let registryInitialized = false;

/**
 * Initialize the registry by loading connector metadata.
 * Called lazily on first access.
 */
async function initializeRegistry(): Promise<void> {
  if (registryInitialized) return;

  // Try to load each connector's metadata
  const loaders = [
    loadConnector('@flowforger/connectors-sharepoint', 'sharePointMetadata'),
    loadConnector('@flowforger/connectors-dataverse', 'dataverseMetadata'),
    loadConnector('@flowforger/connectors-office365', 'office365Metadata'),
    loadConnector('@flowforger/connectors-wordonline', 'wordOnlineMetadata'),
    loadConnector('@flowforger/connectors-excelonline', 'excelOnlineMetadata'),
  ];

  await Promise.allSettled(loaders);
  registryInitialized = true;
}

/**
 * Try to load a connector's metadata.
 */
async function loadConnector(packageName: string, exportName: string): Promise<void> {
  try {
    const module = await import(/* @vite-ignore */ packageName);
    const metadata = module[exportName] as ConnectorMetadata;
    if (metadata?.name) {
      connectorRegistry.set(metadata.name, metadata);
    }
  } catch {
    // Connector package not available - this is fine
  }
}

/**
 * Register a connector manually (for testing or custom connectors).
 */
export function registerConnector(metadata: ConnectorMetadata): void {
  connectorRegistry.set(metadata.name, metadata);
}

/**
 * Get all registered connectors.
 * Note: This is async because the registry may need initialization.
 */
export async function getConnectorRegistryAsync(): Promise<ConnectorMetadata[]> {
  await initializeRegistry();
  return Array.from(connectorRegistry.values());
}

/**
 * Get all registered connectors (sync version, returns what's currently loaded).
 */
export function getConnectorRegistry(): ConnectorMetadata[] {
  return Array.from(connectorRegistry.values());
}

/**
 * Get all connector names.
 */
export function getRegisteredConnectorNames(): string[] {
  return Array.from(connectorRegistry.keys());
}

/**
 * Get metadata for a specific connector.
 */
export function getConnectorMetadata(name: string): ConnectorMetadata | undefined {
  return connectorRegistry.get(name);
}

/**
 * Get operations for a specific connector.
 */
export function getConnectorOperationsFromRegistry(name: string): OperationMetadata[] {
  const connector = connectorRegistry.get(name);
  return connector?.operations ?? [];
}

/**
 * Get a specific operation from a connector.
 */
export function getOperationMetadata(
  connectorName: string,
  operationName: string
): OperationMetadata | undefined {
  const operations = getConnectorOperationsFromRegistry(connectorName);
  return operations.find(op => op.name === operationName);
}

/**
 * Search for operations across all connectors.
 */
export function searchOperations(query: string): Array<{
  connector: ConnectorMetadata;
  operation: OperationMetadata;
}> {
  const results: Array<{ connector: ConnectorMetadata; operation: OperationMetadata }> = [];
  const lowerQuery = query.toLowerCase();

  for (const connector of connectorRegistry.values()) {
    for (const operation of connector.operations) {
      if (
        operation.name.toLowerCase().includes(lowerQuery) ||
        operation.description.toLowerCase().includes(lowerQuery)
      ) {
        results.push({ connector, operation });
      }
    }
  }

  return results;
}

/**
 * Force re-initialization of the registry.
 */
export async function refreshRegistry(): Promise<void> {
  registryInitialized = false;
  connectorRegistry.clear();
  await initializeRegistry();
}

// Re-export types
export type { ConnectorMetadata, OperationMetadata };
