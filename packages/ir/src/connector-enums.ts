/**
 * Named enums for connector trigger/action parameters that Power Automate
 * expresses as magic numbers (e.g. Dataverse `subscriptionRequest/message` = 4).
 *
 * This is the single source of truth for the values. Consumers:
 *   - `@flowforger/dsl-native` exposes them to `.ff.ts` files as ambient globals
 *     (no import needed) and resolves `DataverseMessage.AddedOrModified` → 4
 *     statically in the transformer; the generator maps numbers back to names.
 *   - `@flowforger/connectors-shared`'s trigger catalog surfaces them as
 *     `allowedValues` for UI pickers.
 */

/** Dataverse "When a row is added, modified or deleted" — `subscriptionRequest/message`. */
export const DataverseMessage = {
  Added: 1,
  Deleted: 2,
  Modified: 3,
  AddedOrModified: 4,
  AddedOrDeleted: 5,
  ModifiedOrDeleted: 6,
  AddedModifiedOrDeleted: 7,
} as const;

/** Dataverse "When a row is added, modified or deleted" — `subscriptionRequest/scope`. */
export const DataverseScope = {
  User: 1,
  BusinessUnit: 2,
  ParentChildBusinessUnit: 3,
  Organization: 4,
} as const;

/** Dataverse "When a row is added, modified or deleted" — `subscriptionRequest/runas`. */
export const DataverseRunAs = {
  ModifyingUser: 1,
  RowOwner: 2,
  FlowOwner: 3,
} as const;

export type ConnectorEnumName = 'DataverseMessage' | 'DataverseScope' | 'DataverseRunAs';

export interface ConnectorEnumDefinition {
  /** Global identifier used in DSL source (e.g. `DataverseMessage`). */
  name: ConnectorEnumName;
  /** Member name → numeric value. */
  members: Readonly<Record<string, number>>;
  /** Short doc shown in IntelliSense / catalog. */
  description: string;
}

/** Every enum the DSL recognises as an ambient global, keyed by identifier. */
export const CONNECTOR_ENUMS: Readonly<Record<ConnectorEnumName, ConnectorEnumDefinition>> = {
  DataverseMessage: {
    name: 'DataverseMessage',
    members: DataverseMessage,
    description: 'Dataverse row event to subscribe to (subscriptionRequest/message)',
  },
  DataverseScope: {
    name: 'DataverseScope',
    members: DataverseScope,
    description: 'Dataverse subscription scope (subscriptionRequest/scope)',
  },
  DataverseRunAs: {
    name: 'DataverseRunAs',
    members: DataverseRunAs,
    description: 'User context the flow runs as (subscriptionRequest/runas)',
  },
};

export interface ConnectorParamEnumBinding {
  /** Normalised connector name (see `normalizeConnectorName`). */
  connector: string;
  operation: string;
  param: string;
  enumName: ConnectorEnumName;
}

/** Which (connector, operation, param) triples take which enum. */
export const CONNECTOR_PARAM_ENUMS: readonly ConnectorParamEnumBinding[] = [
  { connector: 'dataverse', operation: 'SubscribeWebhookTrigger', param: 'subscriptionRequest/message', enumName: 'DataverseMessage' },
  { connector: 'dataverse', operation: 'SubscribeWebhookTrigger', param: 'subscriptionRequest/scope', enumName: 'DataverseScope' },
  { connector: 'dataverse', operation: 'SubscribeWebhookTrigger', param: 'subscriptionRequest/runas', enumName: 'DataverseRunAs' },
];

/** `allowedValues` entry shape used by connector metadata. */
export interface ConnectorEnumAllowedValue {
  label: string;
  value: number;
}

/** Members as `{ label, value }` pairs, in declaration order. */
export function connectorEnumAllowedValues(def: ConnectorEnumDefinition): ConnectorEnumAllowedValue[] {
  return Object.entries(def.members).map(([label, value]) => ({ label, value }));
}

export function isConnectorEnumName(name: string): name is ConnectorEnumName {
  return Object.prototype.hasOwnProperty.call(CONNECTOR_ENUMS, name);
}

/** `resolveConnectorEnumMember('DataverseMessage', 'AddedOrModified')` → 4; unknown → undefined. */
export function resolveConnectorEnumMember(enumName: string, member: string): number | undefined {
  if (!isConnectorEnumName(enumName)) return undefined;
  const members = CONNECTOR_ENUMS[enumName].members;
  return Object.prototype.hasOwnProperty.call(members, member) ? members[member] : undefined;
}

/**
 * DSL authors write `connector: 'dataverse'` or the raw API name
 * `'commondataserviceforapps'`; both bind to the same enums.
 */
function normalizeConnectorName(connector: string | undefined): string | undefined {
  if (!connector) return undefined;
  const c = connector.toLowerCase();
  if (c.includes('commondataservice') || c.includes('dataverse')) return 'dataverse';
  return c;
}

/** The enum bound to a connector parameter, if any. */
export function findConnectorEnumForParam(
  connector: string | undefined,
  operation: string | undefined,
  param: string,
): ConnectorEnumDefinition | undefined {
  const normalized = normalizeConnectorName(connector);
  const binding = CONNECTOR_PARAM_ENUMS.find(
    b => b.connector === normalized && b.operation === operation && b.param === param,
  );
  return binding ? CONNECTOR_ENUMS[binding.enumName] : undefined;
}

/** `formatConnectorEnumValue(def, 4)` → "DataverseMessage.AddedOrModified"; unknown value → undefined. */
export function formatConnectorEnumValue(def: ConnectorEnumDefinition, value: unknown): string | undefined {
  if (typeof value !== 'number') return undefined;
  const member = Object.entries(def.members).find(([, v]) => v === value)?.[0];
  return member ? `${def.name}.${member}` : undefined;
}
