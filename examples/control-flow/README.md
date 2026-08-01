# Control Flow Example

Minimal demonstration of FlowForger's control-flow constructs and the JSDoc annotations that name them.

## Files

- [flow.ff.ts](flow.ff.ts) — The demo flow
- [vars.json](vars.json) — Variable values for local runs (`x`, `items`)

## What It Shows

| Construct | Annotation | DSL syntax |
|---|---|---|
| Scope (grouped actions) | `@action ScopeOne @type scope` | bare `{ ... }` block |
| If/Else | `@action CheckX` | `if (...) { } else { }` |
| For Each | `@action LoopItems` | `for (const item of ...) { }` |

Note: `@type` is only required for **scope** (a bare block is ambiguous); if/foreach/switch/until are recognized structurally, so they carry `@action` alone. Naming them keeps action names unique and referenceable.

## Running

See [examples/README.md](../README.md) for CLI install/setup.

```bash
# vars.json provides the 'x' and 'items' variables the flow branches and loops on
npx flowforger run examples/control-flow/flow.ff.ts --vars examples/control-flow/vars.json
```

With `x = 1`, the if branch runs `ThenA`; the foreach fires `PerItem` once per entry in `items`.
