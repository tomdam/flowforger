/**
 * Ambient connector enums for the DSL (DataverseMessage / DataverseScope / DataverseRunAs).
 *
 * The values live in `@flowforger/ir` (single source of truth, shared with the
 * connector trigger catalog). This module re-exports them and adds the ambient
 * `declare const` source that lets `.ff.ts` files use the names without imports.
 */
export {
  DataverseMessage,
  DataverseScope,
  DataverseRunAs,
  CONNECTOR_ENUMS,
  CONNECTOR_PARAM_ENUMS,
  isConnectorEnumName,
  resolveConnectorEnumMember,
  findConnectorEnumForParam,
  formatConnectorEnumValue,
} from '@flowforger/ir';
export type { ConnectorEnumName, ConnectorEnumDefinition, ConnectorParamEnumBinding } from '@flowforger/ir';

import { CONNECTOR_ENUMS } from '@flowforger/ir';

/**
 * Ambient `declare const` source for the enums, embedded in the Monaco/LSP type
 * definitions so `.ff.ts` files can use them without imports.
 */
export function buildConnectorEnumDeclarations(): string {
  return Object.values(CONNECTOR_ENUMS)
    .map(def => {
      const members = Object.entries(def.members)
        .map(([k, v]) => `  readonly ${k}: ${v};`)
        .join('\n');
      return `/** ${def.description} */\ndeclare const ${def.name}: {\n${members}\n};`;
    })
    .join('\n\n');
}
