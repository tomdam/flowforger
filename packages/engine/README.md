# @flowforger/engine

The **FlowForger local execution engine**: run Power Automate / Azure Logic Apps flows (as [FlowForger IR](https://www.npmjs.com/package/@flowforger/ir)) directly on your machine — no deployment, no cloud round-trip, instant feedback with a full execution trace.

## Installation

```bash
npm install @flowforger/engine
```

## Usage

```ts
import { run } from '@flowforger/engine';

const result = await run(flowIR, {
  input: { name: 'world' },       // trigger payload
  variables: { count: 5 },        // initial variables
  connectors: { /* optional connector instances (SharePoint, Dataverse, ...) */ },
});

console.log(result.trace);        // per-node execution trace
```

## Features

- Sequential execution of triggers, actions, and control flow (scope / if / foreach)
- HTTP actions and connector actions (via `@flowforger/connectors-*` packages)
- Comprehensive Logic Apps expression support: `body()`, `outputs()`, `triggerBody()`, `variables()`, string/math/collection/date functions, `if()`, `coalesce()`, and more — with property-path navigation (`body('GetData').user.name`)
- Detailed trace output for debugging every node

The [CLI](https://www.npmjs.com/package/flowforger) wraps this engine as `flowforger run`.

## Related packages

FlowForger is a toolset for building, running, and shipping Microsoft Power Automate / Azure Logic Apps flows as TypeScript.

- [`flowforger`](https://www.npmjs.com/package/flowforger) — command-line interface (compile, validate, run, deploy)
- [`@flowforger/dsl-native`](https://www.npmjs.com/package/@flowforger/dsl-native) — the TypeScript DSL
- [`@flowforger/engine`](https://www.npmjs.com/package/@flowforger/engine) — local execution engine
- [`@flowforger/emitter-logicapps`](https://www.npmjs.com/package/@flowforger/emitter-logicapps) — IR → Logic Apps JSON

Website: [flowforger.net](https://flowforger.net) · Source: [github.com/tomdam/flowforger](https://github.com/tomdam/flowforger) · Issues: [bug tracker](https://github.com/tomdam/flowforger/issues)

## License

Apache-2.0 © Damjan Tomic
