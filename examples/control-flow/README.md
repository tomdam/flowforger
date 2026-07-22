# Control Flow Example

Minimal demonstration of FlowForger's control-flow constructs and the JSDoc annotations that name them.

## Files

- [flow.ff.ts](flow.ff.ts) — The demo flow
- [vars.json](vars.json) — Variable values for local runs (`x`, `items`)

## What It Shows

| Construct | Annotation | DSL syntax |
|---|---|---|
| Scope (grouped actions) | `@action ScopeOne @type scope` | bare `{ ... }` block |
| If/Else | `@action CheckX @type if` | `if (...) { } else { }` |
| For Each | `@action LoopItems @type foreach` | `for (const item of ...) { }` |

Note: `@type` is only required for **scope** (a bare block is ambiguous); if/foreach are recognized structurally, but naming them with `@action` keeps action names unique and referenceable.

## Running

See [examples/README.md](../README.md) for CLI install/setup.

```bash
# vars.json provides the 'x' and 'items' variables the flow branches and loops on
npx flowforger run examples/control-flow/flow.ff.ts --vars examples/control-flow/vars.json
```

With `x = 1`, the if branch runs `ThenA`; the foreach fires `PerItem` once per entry in `items`.
