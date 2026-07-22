/**
 * Connector Metadata Schema
 *
 * Defines the structure for connector metadata used by:
 * - Language service (completions, hover docs)
 * - Type generation
 * - Documentation generation
 *
 * Each connector package exports its own metadata following this schema.
 */

/**
 * Parameter metadata for an operation
 */
export interface ParameterMetadata {
  /** Parameter name as used in code */
  name: string;
  /** TypeScript type (e.g., 'string', 'number', 'CreateItemParams') */
  type: string;
  /** Human-readable description */
  description: string;
  /** Whether the parameter is required */
  required: boolean;
  /** Default value if optional */
  defaultValue?: unknown;
}

/**
 * Operation metadata for a connector method
 */
export interface OperationMetadata {
  /** Operation name (e.g., 'CreateItem', 'GetItems', 'ListRows') */
  name: string;
  /** Human-readable description */
  description: string;
  /** Parameters for this operation */
  parameters: ParameterMetadata[];
  /** Return type (e.g., 'void', 'Promise<any>') */
  returnType: string;
  /** Example code snippets */
  examples?: string[];
  /** Category for grouping (e.g., 'Items', 'Files', 'Users') */
  category?: string;
  /** Whether this operation is deprecated */
  deprecated?: boolean;
  /** Deprecation message if deprecated */
  deprecationMessage?: string;
}

/**
 * Complete metadata for a connector
 */
export interface ConnectorMetadata {
  /** Internal name used in code (e.g., 'sharepoint', 'dataverse') */
  name: string;
  /** Display name for UI (e.g., 'SharePoint', 'Dataverse') */
  displayName: string;
  /** Description of the connector */
  description: string;
  /** Icon name or path (optional) */
  icon?: string;
  /** Documentation URL (optional) */
  docsUrl?: string;
  /** All operations provided by this connector */
  operations: OperationMetadata[];
}

/**
 * Registry of all available connectors
 */
export interface ConnectorRegistry {
  connectors: ConnectorMetadata[];
}

/**
 * Helper function to create a parameter metadata object
 */
export function param(
  name: string,
  type: string,
  description: string,
  required = true,
  defaultValue?: unknown
): ParameterMetadata {
  return { name, type, description, required, defaultValue };
}

/**
 * Helper function to create an operation metadata object
 */
export function operation(
  name: string,
  description: string,
  parameters: ParameterMetadata[],
  options?: {
    returnType?: string;
    examples?: string[];
    category?: string;
    deprecated?: boolean;
    deprecationMessage?: string;
  }
): OperationMetadata {
  return {
    name,
    description,
    parameters,
    returnType: options?.returnType ?? 'void',
    examples: options?.examples,
    category: options?.category,
    deprecated: options?.deprecated,
    deprecationMessage: options?.deprecationMessage,
  };
}

/**
 * Helper function to create connector metadata
 */
export function connector(
  name: string,
  displayName: string,
  description: string,
  operations: OperationMetadata[],
  options?: {
    icon?: string;
    docsUrl?: string;
  }
): ConnectorMetadata {
  return {
    name,
    displayName,
    description,
    operations,
    icon: options?.icon,
    docsUrl: options?.docsUrl,
  };
}
