# @flowforger/validator

The **FlowForger validation layer**: structural validation for both [FlowForger IR](https://www.npmjs.com/package/@flowforger/ir) and Power Automate / Logic Apps JSON definitions.

## Installation

```bash
npm install @flowforger/validator
```

## Usage

```ts
import { validateFlowIR, validateLogicApps } from '@flowforger/validator';

const irResult = validateFlowIR(flowIR);
const laResult = validateLogicApps(clientdataJson);

if (!irResult.valid) console.log(irResult.issues);
```

The [CLI](https://www.npmjs.com/package/flowforger) wraps this as `flowforger validate`, auto-detecting which format the input file is.

## Related packages

FlowForger is a toolset for building, running, and shipping Microsoft Power Automate / Azure Logic Apps flows as TypeScript.

- [`flowforger`](https://www.npmjs.com/package/flowforger) — command-line interface (compile, validate, run, deploy)
- [`@flowforger/dsl-native`](https://www.npmjs.com/package/@flowforger/dsl-native) — the TypeScript DSL
- [`@flowforger/engine`](https://www.npmjs.com/package/@flowforger/engine) — local execution engine
- [`@flowforger/emitter-logicapps`](https://www.npmjs.com/package/@flowforger/emitter-logicapps) — IR → Logic Apps JSON

Website: [flowforger.net](https://flowforger.net) · Source: [github.com/tomdam/flowforger](https://github.com/tomdam/flowforger) · Issues: [bug tracker](https://github.com/tomdam/flowforger/issues)

## License

Apache-2.0 © Damjan Tomic
