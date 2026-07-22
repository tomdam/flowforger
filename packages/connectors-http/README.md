# @flowforger/connectors-http

**HTTP connector** for [FlowForger](https://flowforger.net) — executes HTTP actions (plain `fetch`) when running Power Automate / Logic Apps flows locally with the [engine](https://www.npmjs.com/package/@flowforger/engine).

## Installation

```bash
npm install @flowforger/connectors-http
```

## Usage

Used automatically by the [CLI](https://www.npmjs.com/package/flowforger) whenever a flow contains HTTP actions:

```bash
flowforger run flow.ir.json --in payload.json
```

## Related packages

FlowForger is a toolset for building, running, and shipping Microsoft Power Automate / Azure Logic Apps flows as TypeScript.

- [`flowforger`](https://www.npmjs.com/package/flowforger) — command-line interface (compile, validate, run, deploy)
- [`@flowforger/dsl-native`](https://www.npmjs.com/package/@flowforger/dsl-native) — the TypeScript DSL
- [`@flowforger/engine`](https://www.npmjs.com/package/@flowforger/engine) — local execution engine
- [`@flowforger/emitter-logicapps`](https://www.npmjs.com/package/@flowforger/emitter-logicapps) — IR → Logic Apps JSON

Website: [flowforger.net](https://flowforger.net) · Source: [github.com/tomdam/flowforger](https://github.com/tomdam/flowforger) · Issues: [bug tracker](https://github.com/tomdam/flowforger/issues)

## License

Apache-2.0 © Damjan Tomic
