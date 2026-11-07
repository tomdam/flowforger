# Built-in Actions Example

A single flow exercising FlowForger's built-in (connector-free) actions.

## Files

- [builtin-actions-demo.ff.ts](builtin-actions-demo.ff.ts) — The demo flow
- [input.json](input.json) — Sample trigger payload for local runs

## What It Shows

- **Variables**: initialize, set, `+=` / `-=` (increment/decrement), `.push()` (append to array), `+=` on a string (append to string)
- **Data operations**: `ctx.compose()`, `ctx.join()`, `ctx.select()`, `ctx.filterArray()`, `ctx.parseJson()`
- **Table generation**: `ctx.createHtmlTable()` with automatic columns from an array of objects, `ctx.createCsvTable()` with explicit columns for an array of strings (a string array without columns fails, locally as in the cloud)
- **Control flow**: if/else with an HTTP response per branch
- **Delay**: `ctx.delay()`
- **Reading results**: a Compose with `ctx.outputs()`, a data operation with `ctx.body()`

Variable statements carry no JSDoc here, so the transformer auto-names them (`Initialize_counter`, `Set_counter`, `Increment_counter`, `Append_to_items`, …). Add `/** @action MyName */` above a statement only when you want a different name — method-style actions like `ctx.compose()` take their name as the first argument instead.

## Running

See [examples/README.md](../README.md) for CLI install/setup.

```bash
npx flowforger run examples/builtin-actions/builtin-actions-demo.ff.ts --in examples/builtin-actions/input.json
```

No connectors or tokens required — everything runs locally. The run ends with `SuccessResponse`, since the counter is 12 after set, increment and decrement.
