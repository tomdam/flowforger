# Hello Flow

The "hello world" of FlowForger: the smallest complete flow showing the anatomy of a `.ff.ts` file.

## Files

- [flow.ff.ts](flow.ff.ts) — Manual trigger → Compose → HTTP POST → Compose

## What It Shows

- The `@Flow` / `@ManualTrigger` / `@Action` decorator structure
- `ctx.compose()` to create data and `ctx.http()` to call an API
- Reading a **Compose** result with `ctx.outputs()` and an **HTTP** response with `ctx.body()` — the two access patterns you'll use constantly
- The constructor (at the bottom by convention) holding flow metadata and the standard `$connections` / `$authentication` parameters

## Running

See [examples/README.md](../README.md) for CLI install/setup.

```bash
# Run locally — calls httpbin.org, which echoes the posted body back
npx flowforger run examples/hello-flow/flow.ff.ts

# Compile to Logic Apps JSON
npx flowforger compile examples/hello-flow/flow.ff.ts --out hello-clientdata.json
```

Expected trace: `Greeting` composes the message, `CallHttpBin` posts it, and `Echo` contains `{ "message": "Hello from FlowForger" }` extracted from the echoed response.
