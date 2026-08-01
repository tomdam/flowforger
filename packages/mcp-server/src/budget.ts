/**
 * Runaway backstop: caps how many connector calls actually reach the network
 * in one session. Wraps the RAW connectors, so the record/replay proxies sit
 * OUTSIDE this — replayed calls never reach the counter and are never charged.
 */

import type { BaseConnector } from '@flowforger/engine';

export class ConnectorBudgetExceeded extends Error {
  constructor(limit: number) {
    super(
      `Connector call budget of ${limit} exceeded. Raise it with the 'budget' argument on debug_start, ` +
        `or start the server with --budget N.`,
    );
    this.name = 'ConnectorBudgetExceeded';
  }
}

export function wrapConnectorsWithBudget(
  connectors: Record<string, BaseConnector>,
  limit: number,
): { connectors: Record<string, BaseConnector>; used(): number } {
  let count = 0;
  const wrapped: Record<string, BaseConnector> = {};
  for (const [name, connector] of Object.entries(connectors)) {
    wrapped[name] = new Proxy(connector, {
      get(target, prop, receiver) {
        if (prop !== 'invoke') return Reflect.get(target, prop, receiver);
        return async (operation: string, inputs: unknown, ctx: unknown) => {
          if (count >= limit) throw new ConnectorBudgetExceeded(limit);
          count++;
          return (target as any).invoke(operation, inputs, ctx);
        };
      },
    });
  }
  return { connectors: wrapped, used: () => count };
}
