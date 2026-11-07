# Expression Functions Example

How a flow reads data produced earlier: the reference functions, property paths, and the two ways of writing an expression in the DSL.

## Files

- [flow.ff.ts](flow.ff.ts) — Compose, HTTP, trigger and parameter reads, with a typed helper and a raw expression side by side

## The reference functions

| Function | Returns | Read it with |
|---|---|---|
| `outputs('X')` | The action's outputs. For a Compose that is the value itself; for an HTTP, connector or child-flow call it is `{ statusCode, headers, body }` | `ctx.outputs('X')` |
| `body('X')` | `outputs('X')?['body']` — the response of an HTTP, connector or child-flow call | `ctx.body('X')` |
| `actions('X')` | The run record: `name`, `status`, `code`, `startTime`, `endTime`, `inputs`, `outputs`, `error` | `ctx.eval("@actions('X')?['status']")` |
| `triggerBody()` | The trigger payload | `ctx.triggerBody()` |
| `triggerOutputs()` | `{ headers, body }` of the trigger | `ctx.eval("@triggerOutputs()?['headers']")` |
| `trigger()` | The trigger's run record (it has no `body` of its own; the payload is under `outputs.body`) | `ctx.eval("@trigger()?['startTime']")` |
| `parameters('Name')` | A flow parameter, by the exact key used in `ctx.flow.parameters` | `ctx.parameters('Name')` |
| `variables('name')` | A variable | `ctx.variables('name')` |

`outputs()` and `body()` are not aliases: `body()` only exists for actions whose outputs have a `body`. Use `ctx.outputs()` for Compose results and `ctx.body()` for HTTP, connector and child-flow results.

## Property paths

Use the null-safe form, `?['key']`, in expressions and `?.['key']` in the DSL: a missing property then reads as null instead of failing the action.

```typescript
ctx.outputs('GetUserData')?.['user']?.['name']            // @outputs('GetUserData')?['user']?['name']
ctx.eval(`@body('CallHttpBin')?['args']?['demo']`)
ctx.eval(`@first(body('GetItems')?['value'])?['Title']`)
```

## Typed helpers or `ctx.eval()`

`ctx.concat(...)`, `ctx.greater(...)`, `ctx.length(...)` and the other helpers compile to the matching Power Automate function, with the arguments transformed the same way. `ctx.eval("@...")` passes an expression through verbatim. Both appear in the flow for the same reads; they produce identical Logic Apps JSON. Write `@expr` to keep the value's type and `@{expr}` only when you want text.

The engine evaluates expressions the way the cloud does (integer division, `True`/`False` in text, case-insensitive `indexOf`, dates with seven fraction digits), so a value you see in the local trace is the value the deployed flow computes. Functions the cloud does not have, such as `round()`, fail locally too.

## Running

See [examples/README.md](../README.md) for CLI install/setup.

```bash
npx flowforger run examples/expression-functions/flow.ff.ts

# Pass a trigger payload to see it under GetTriggerData
npx flowforger run examples/expression-functions/flow.ff.ts --in payload.json
```

Expected outputs in the trace:

- `ExtractUserName` and `ExtractUserEmail`: `John Doe`, `john@example.com`
- `CheckStatus`: `Succeeded`
- `ExtractQueryArg`: `1` (httpbin echoes the query string); `ExtractStatusCode`: `200`
- `GetParameter`: `default value`
- `AgeMessage`: `User is older than 25: John Doe`
- `SuccessMessage`: `GetUserData action succeeded!`
