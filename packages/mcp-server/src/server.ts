/**
 * MCP server construction and stdio transport.
 *
 * stdout carries the JSON-RPC stream, so nothing here may write to it —
 * startMcpServer redirects console.log to stderr as a guard against a stray
 * log inside any connector corrupting the protocol.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SessionManager, type SessionManagerDeps } from './session-manager.js';
import { registerTools } from './tools.js';

export const SERVER_NAME = 'flowforger';
export const SERVER_VERSION = '0.1.0';

/** Build a server bound to a manager. Exported for in-memory transport tests. */
export function createServer(manager: SessionManager): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, manager);
  return server;
}

export interface StartMcpServerOptions extends SessionManagerDeps {}

export async function startMcpServer(opts: StartMcpServerOptions): Promise<void> {
  // Belt and braces: any stray console.log would corrupt the JSON-RPC stream.
  console.log = console.error;

  const manager = new SessionManager(opts);
  const server = createServer(manager);

  const shutdown = () => {
    void manager.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);

  await server.connect(new StdioServerTransport());
}
