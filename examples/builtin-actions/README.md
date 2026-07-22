# Built-in Actions Example

A single flow exercising FlowForger's built-in (connector-free) actions.

## Files

- [builtin-actions-demo.ff.ts](builtin-actions-demo.ff.ts) — The demo flow
- [input.json](input.json) — Sample trigger payload for local runs

## What It Shows

- **Variables**: initialize, set, `+=` / `-=` (increment/decrement), `.push()` (append to array), `ctx.appendToStringVariable()`
- **Data operations**: `ctx.compose()`, `ctx.join()`, `ctx.select()`, `ctx.filterArray()`, `ctx.parseJson()`
- **Table generation**: `ctx.createCsvTable()`, `ctx.createHtmlTable()`
- **Control flow**: if/else with an HTTP response per branch
- **Delay**: `ctx.delay()`

Also demonstrates the JSDoc `@action` annotation for naming variable and control-flow actions (method-style actions like `ctx.compose()` take their name as the first argument instead).

## Running

See [examples/README.md](../README.md) for CLI install/setup.

```bash
npx flowforger run examples/builtin-actions/builtin-actions-demo.ff.ts --in examples/builtin-actions/input.json
```

No connectors or tokens required — everything runs locally.
