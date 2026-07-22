# @flowforger/emitter-logicapps

The **FlowForger emitter**: compile [FlowForger IR](https://www.npmjs.com/package/@flowforger/ir) into Power Automate / Azure Logic Apps `clientdata.json` — the format the Power Platform actually stores and runs.

## Installation

```bash
npm install @flowforger/emitter-logicapps
```

## Usage

```ts
import { emitLogicAppsJson } from '@flowforger/emitter-logicapps';

const clientdata = emitLogicAppsJson(flowIR, emitterConfig);
```

The optional `EmitterConfig` maps connector names to Logic Apps connection references (typically loaded from `flowforger.config.json`, with per-environment overrides):

```json
{
  "global": {
    "connections": {
      "sharepoint": {
        "referenceName": "shared_sharepointonline",
        "apiId": "/providers/Microsoft.PowerApps/apis/shared_sharepointonline"
      }
    }
  },
  "environments": { "dev": {} }
}
```

The [CLI](https://www.npmjs.com/package/flowforger) wraps this as `flowforger compile`.

## Related packages

FlowForger is a toolset for building, running, and shipping Microsoft Power Automate / Azure Logic Apps flows as TypeScript.

- [`flowforger`](https://www.npmjs.com/package/flowforger) — command-line interface (compile, validate, run, deploy)
- [`@flowforger/dsl-native`](https://www.npmjs.com/package/@flowforger/dsl-native) — the TypeScript DSL
- [`@flowforger/engine`](https://www.npmjs.com/package/@flowforger/engine) — local execution engine
- [`@flowforger/emitter-logicapps`](https://www.npmjs.com/package/@flowforger/emitter-logicapps) — IR → Logic Apps JSON

Website: [flowforger.net](https://flowforger.net) · Source: [github.com/tomdam/flowforger](https://github.com/tomdam/flowforger) · Issues: [bug tracker](https://github.com/tomdam/flowforger/issues)

## License

Apache-2.0 © Damjan Tomic
