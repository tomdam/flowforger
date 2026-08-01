# @flowforger/mcp-server

Drive a FlowForger debug session from an AI agent over MCP (stdio).

## Setup

```bash
npm install -g flowforger
claude mcp add flowforger -- flowforger mcp --auth
```

`--auth` reuses the MSAL token cache at `~/.flowforger/token-cache.json`. The cache must
already be warm — run `flowforger run <flow> --auth` once in a terminal to sign in. The
server never starts an interactive device-code flow (there is no terminal to prompt on),
and reports a clear error instead.

## Tools

| Tool | Purpose |
|---|---|
| `debug_start` | Compile a `.ff.ts` flow and start a session (replaces any existing one) |
| `debug_continue` / `debug_step` | Resume; `debug_step` takes `into` for child flows |
| `debug_set_breakpoints` | Full-list per file; accepts `{line}`, `{nodeId}` or `{action}` |
| `debug_get_variables` / `debug_get_value` | Depth-limited previews and path drill-down |
| `debug_evaluate` | DSL, `@`-Power-Automate, or bare name, in the active frame |
| `debug_call_stack` / `debug_status` / `debug_stop` | Session introspection and teardown |

There is no `debug_step_out` — `DebugSession` has no true step-out, so `debug_continue`
is the honest equivalent.

Every handler returns one JSON text block, and every failure returns a structured
`{ error, hint }` payload instead of throwing — a stuck agent always gets something
actionable rather than a raw stack trace.

## Polling and lost pauses

`debug_continue` and `debug_step` accept `timeoutMs`. If the flow hasn't stopped by the
deadline (including `timeoutMs: 0`, a pure poll), the call returns `state: "running"`
immediately and the session keeps going in the background. If a breakpoint then fires
before the agent calls back in, the pause is held rather than dropped — the *next*
`debug_continue`/`debug_step`/`debug_status` call delivers that exact paused position,
so a slow agent can never run a session past a breakpoint it never got to see.

Loop iteration context reports `loop` and a 0-based `index`. `total` is omitted — the
engine does not expose a loop's length, so the field is left out rather than reported as
a misleading `0`.

## Connector safety

Connector responses are recorded to `~/.flowforger/cassettes/<hash>.json` and replayed on
the next `debug_start` for the same flow. Replay misses execute live and are re-recorded,
so the cassette self-warms. Pass `mode: "live"` to bypass and re-record from scratch.

A per-session budget (default 200) caps calls that actually reach the network; replayed
calls are free. Raise it with `--budget N` or the `budget` argument on `debug_start`.

## Limits

Any tool result is capped at 16 KB. Values are rendered as depth-limited previews
(strings capped at 200 chars, 50 children per container); use `debug_get_value` with a
`path` to page into exactly what you need.
