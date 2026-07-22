/**
 * ID generator for IR nodes.
 * Uses prefixes to identify node types.
 */

let nextId = 1;

export function resetIdCounter(): void {
  nextId = 1;
}

export function genId(prefix: string): string {
  return `${prefix}_${nextId++}`;
}

// Convenience functions for specific node types
export const genTriggerId = () => genId('trg');
export const genActionId = () => genId('act');
export const genScopeId = () => genId('scp');
export const genIfId = () => genId('if');
export const genForeachId = () => genId('fe');
export const genSwitchId = () => genId('sw');
export const genDoUntilId = () => genId('du');
export const genConnectorId = () => genId('con');
