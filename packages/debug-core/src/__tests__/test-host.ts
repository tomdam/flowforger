import type { DebugFlowSource, DebugHost } from '../host.js';

/** In-memory DebugHost: children resolved from a name-keyed record. */
export function createInMemoryHost(children: Record<string, DebugFlowSource> = {}): DebugHost {
  return {
    async resolveChildFlow(ref: string): Promise<DebugFlowSource | null> {
      return children[ref] ?? null;
    },
    normalizeKey: (k: string) => k,
    displayName: (k: string) => k,
  };
}
