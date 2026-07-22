# @flowforger/ir

The **intermediate representation (IR)** at the core of [FlowForger](https://flowforger.net): TypeScript types describing Power Automate / Azure Logic Apps flow definitions in a tool-friendly form.

Every other FlowForger package speaks this format:

- the [DSL](https://www.npmjs.com/package/@flowforger/dsl-native) transforms TypeScript flows **into** IR,
- the [engine](https://www.npmjs.com/package/@flowforger/engine) **runs** IR locally,
- the [emitter](https://www.npmjs.com/package/@flowforger/emitter-logicapps) compiles IR **to** Logic Apps JSON,
- the [validator](https://www.npmjs.com/package/@flowforger/validator) checks IR for structural problems.

## Installation

```bash
npm install @flowforger/ir
```

## What's inside

- Core types: `FlowIR`, `Node`, `TriggerNode`, `RecurrenceTriggerNode`, `ActionNode`, `ScopeNode`, `IfNode`, `ForeachNode`, `ConnectorActionNode`
- Type guards for narrowing node types
- A JSON Schema for the IR format (in `schema/`)

A flow is a `name` plus an array of `nodes` — the first node is typically a trigger, control nodes (scope/if/foreach) contain nested `actions` arrays.

This package has **zero dependencies**.

## Related packages

FlowForger is a toolset for building, running, and shipping Microsoft Power Automate / Azure Logic Apps flows as TypeScript.

- [`flowforger`](https://www.npmjs.com/package/flowforger) — command-line interface (compile, validate, run, deploy)
- [`@flowforger/dsl-native`](https://www.npmjs.com/package/@flowforger/dsl-native) — the TypeScript DSL
- [`@flowforger/engine`](https://www.npmjs.com/package/@flowforger/engine) — local execution engine
- [`@flowforger/emitter-logicapps`](https://www.npmjs.com/package/@flowforger/emitter-logicapps) — IR → Logic Apps JSON

Website: [flowforger.net](https://flowforger.net) · Source: [github.com/tomdam/flowforger](https://github.com/tomdam/flowforger) · Issues: [bug tracker](https://github.com/tomdam/flowforger/issues)

## License

Apache-2.0 © Damjan Tomic
