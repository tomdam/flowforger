/**
 * The ten debug tools. Every handler returns a single JSON text block, and
 * every failure returns a structured { error, hint } payload rather than
 * throwing — an agent gets something actionable, never a stack trace.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from './session-manager.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

function json(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Structured failure — never let an exception escape a tool handler. */
function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const hint = /no active session/i.test(message)
    ? 'Call debug_start with a .ff.ts file path first.'
    : /not signed in/i.test(message)
      ? "Run 'flowforger run <flow> --auth' once in a terminal to sign in, then retry."
      : 'Check the arguments and retry; use debug_status to inspect session state.';
  return json({ error: message, hint });
}

async function guard(fn: () => unknown | Promise<unknown>): Promise<ToolResult> {
  try {
    return json(await fn());
  } catch (err) {
    return fail(err);
  }
}

/** A breakpoint entry accepts a line, a node id, or an action name. */
const breakpointSchema = z.union([
  z.object({ line: z.number().int().positive() }),
  z.object({ nodeId: z.string().min(1) }),
  z.object({ action: z.string().min(1) }),
]);

const scopeSchema = z.enum(['variables', 'actions', 'trigger', 'parameters']);

export function registerTools(server: McpServer, manager: SessionManager): void {
  server.registerTool(
    'debug_start',
    {
      title: 'Start a flow debug session',
      description:
        'Compile a FlowForger .ff.ts flow and start a debug session, replacing any existing one. ' +
        'Pauses on entry by default. Connector responses replay from the flow\'s cassette when available ' +
        '(pass mode:"live" to force fresh calls and re-record). Returns a snapshot of where execution stopped.',
      inputSchema: {
        file: z.string().describe('Path to the .ff.ts flow file (absolute, or relative to the server cwd)'),
        triggerPayload: z.unknown().optional().describe('Trigger input body'),
        variables: z.record(z.unknown()).optional().describe('Initial variable values'),
        parameters: z.record(z.unknown()).optional().describe('Flow parameter overrides'),
        breakpoints: z.array(breakpointSchema).optional().describe('Breakpoints to set before running'),
        stopOnEntry: z.boolean().optional().describe('Pause before the first node (default true)'),
        mode: z.enum(['replay', 'live']).optional().describe('replay (default) reuses the cassette; live re-records'),
        budget: z.number().int().nonnegative().optional().describe(
          'Max live connector calls for this session. 0 means replay-only — every live call is blocked.',
        ),
        timeoutMs: z.number().int().nonnegative().optional().describe('Max ms to wait for the first stop'),
      },
    },
    async (args) => guard(() => manager.start(args as any)),
  );

  server.registerTool(
    'debug_continue',
    {
      title: 'Continue execution',
      description:
        'Resume until the next breakpoint or termination. Returns state:"running" if timeoutMs elapses first — ' +
        'the session keeps running and the next call picks up where it stopped.',
      inputSchema: { timeoutMs: z.number().int().nonnegative().optional() },
    },
    async (args) => guard(() => manager.resume('continue', { timeoutMs: args.timeoutMs })),
  );

  server.registerTool(
    'debug_step',
    {
      title: 'Step one node',
      description:
        'Execute a single node and pause again. Set into:true to step into a child flow on a workflow action. ' +
        'There is no step-out — use debug_continue.',
      inputSchema: {
        into: z.boolean().optional().describe('Step into child flows (default false = step over)'),
        timeoutMs: z.number().int().nonnegative().optional(),
      },
    },
    async (args) => guard(() => manager.resume('step', { into: args.into, timeoutMs: args.timeoutMs })),
  );

  server.registerTool(
    'debug_set_breakpoints',
    {
      title: 'Set breakpoints',
      description:
        'Replace the breakpoint set for one source file. Entries may be {line}, {nodeId} or {action}. ' +
        'The response echoes what each entry resolved to, including the snapped line.',
      inputSchema: {
        file: z.string().optional().describe('Defaults to the root flow file'),
        breakpoints: z.array(breakpointSchema),
      },
    },
    async (args) => guard(() => manager.setBreakpoints(args as any)),
  );

  server.registerTool(
    'debug_get_variables',
    {
      title: 'Inspect a scope',
      description:
        'Read variables, action outputs, trigger data or parameters at the current pause. Values are ' +
        'depth-limited previews; use debug_get_value to drill into a specific path.',
      inputSchema: {
        scope: z.union([scopeSchema, z.literal('all')]),
        frameIndex: z.number().int().nonnegative().optional().describe('0 = innermost frame (default)'),
        depth: z.number().int().min(0).max(6).optional().describe('Preview depth (default 1)'),
      },
    },
    async (args) => guard(() => manager.getScope(args as any)),
  );

  server.registerTool(
    'debug_get_value',
    {
      title: 'Drill into a value by path',
      description:
        'Navigate a scope by path, e.g. body.value[0].Title. In the actions scope the first segment is the ' +
        'action name. A bad path returns the deepest valid prefix and the keys available there.',
      inputSchema: {
        scope: scopeSchema,
        path: z.string().describe('Dotted/indexed path; use ["key.with.dots"] for awkward keys'),
        frameIndex: z.number().int().nonnegative().optional(),
        depth: z.number().int().min(0).max(6).optional().describe('Preview depth (default 2)'),
      },
    },
    async (args) => guard(() => manager.getValue(args as any)),
  );

  server.registerTool(
    'debug_evaluate',
    {
      title: 'Evaluate an expression',
      description:
        'Evaluate a DSL expression, an @-prefixed Power Automate expression, or a bare variable/action name ' +
        'in the active frame.',
      inputSchema: { expression: z.string().min(1) },
    },
    async (args) => guard(() => manager.evaluate(args.expression)),
  );

  server.registerTool(
    'debug_call_stack',
    {
      title: 'Get the call stack',
      description: 'List frames innermost-first, including loop iteration context at the active frame.',
      inputSchema: {},
    },
    async () => guard(() => manager.callStack()),
  );

  server.registerTool(
    'debug_status',
    {
      title: 'Session status',
      description: 'Report whether a session is active, where it is paused, and the connector budget used.',
      inputSchema: {},
    },
    async () => guard(() => manager.status()),
  );

  server.registerTool(
    'debug_stop',
    {
      title: 'Stop the session',
      description: 'Terminate the active session and flush its cassette to disk.',
      inputSchema: {},
    },
    async () => guard(async () => {
      await manager.stop();
      return { stopped: true };
    }),
  );
}
