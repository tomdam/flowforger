# OData Filter Syntax Example

Demonstrates the two ways to write OData `$filter` expressions for Dataverse queries in FlowForger.

## Files

- [odata-filters.ff.ts](odata-filters.ff.ts) — Six `ListRecords` queries covering both syntaxes

## The Two Syntaxes

### Builder API

Compose filters from `ctx.odata.*` functions:

```typescript
'$filter': ctx.odata.and(
  ctx.odata.eq('statecode', 0),
  ctx.odata.gt('revenue', ctx.parameters('MinAmount'))
)
// → statecode eq 0 and revenue gt 100
```

### Tagged Template

Write familiar TypeScript-style operators inside `ctx.odata` backticks; they compile to OData:

```typescript
'$filter': ctx.odata`(statecode == 0 || statecode == 1) && revenue >= ${ctx.parameters('MinAmount')}`
// → (statecode eq 0 or statecode eq 1) and revenue ge 100
```

| TypeScript | OData |
|---|---|
| `==` / `!=` | `eq` / `ne` |
| `>` / `>=` | `gt` / `ge` |
| `<` / `<=` | `lt` / `le` |
| `&&` / `\|\|` | `and` / `or` |
| `!(...)` | `not (...)` |
| `${expr}` | interpolated value (parameters, action outputs, variables) |

## Running

See [examples/README.md](../README.md) for CLI install/setup. The flow queries Dataverse, so it needs a Dataverse token or `--auth`:

```bash
npx flowforger run examples/odata-tagged-template/odata-filters.ff.ts --auth

# Or compile to Logic Apps JSON without credentials
npx flowforger compile examples/odata-tagged-template/odata-filters.ff.ts --out odata-clientdata.json
```
