# Advanced Actions Examples

Example flows demonstrating nested loops, array operations, JSON parsing, and complex control flow.

## Flows

### 1. nested-loops.ff.ts
Nested `foreach` loops processing a matrix of departments and employees. Builds a flat summary array from nested data.

### 2. array-operations.ff.ts
Array variable manipulation: init, append in loops, `union`/`intersection`, `length`, and conditional categorization.

### 3. json-parsing.ff.ts
Parse JSON strings with `json()`, extract nested fields, validate required fields, and conditionally build result sets with error tracking.

### 4. complex-control-flow.ff.ts
Everything combined: nested foreach inside foreach, switch by region, if/else validation, try/catch/finally scopes with `@runAfter`, nested line-item inspection loop, and a do-until retry loop.

## Running

See [examples/README.md](../README.md) for CLI install/setup. Use `npx flowforger`, `flowforger` (global install), or `node packages/cli/dist/index.js` interchangeably — examples below use `npx` for brevity.

```bash
# Run any example with its input payload
npx flowforger run examples/advanced-actions/nested-loops.ff.ts         --in examples/advanced-actions/nested-loops-input.json
npx flowforger run examples/advanced-actions/array-operations.ff.ts     --in examples/advanced-actions/array-operations-input.json
npx flowforger run examples/advanced-actions/json-parsing.ff.ts         --in examples/advanced-actions/json-parsing-input.json
npx flowforger run examples/advanced-actions/complex-control-flow.ff.ts --in examples/advanced-actions/complex-control-flow-input.json
```

## Compiling to Logic Apps JSON

```bash
# DSL → Logic Apps JSON (one step; IR is generated internally)
npx flowforger compile examples/advanced-actions/nested-loops.ff.ts --out nested-loops-clientdata.json
```
