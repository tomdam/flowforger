# @flowforger/dataverse-sdk

A **thin Microsoft Dataverse Web API client** used by [FlowForger](https://flowforger.net) tooling — CRUD against Dataverse tables and workflow (Power Automate flow) records via the Web API v9.2, with nothing but `fetch` underneath.

## Installation

```bash
npm install @flowforger/dataverse-sdk
```

## Usage

```ts
import { DataverseClient } from '@flowforger/dataverse-sdk';

const client = new DataverseClient({
  baseUrl: 'https://yourorg.crm.dynamics.com',
  getToken: async () => aadAccessToken, // Azure AD token for the Dataverse resource
});
```

Used by the [CLI](https://www.npmjs.com/package/flowforger) (`flowforger push`) to deploy compiled flow definitions into Dataverse, and by the Dataverse connector for local flow runs.

## Related packages

FlowForger is a toolset for building, running, and shipping Microsoft Power Automate / Azure Logic Apps flows as TypeScript.

- [`flowforger`](https://www.npmjs.com/package/flowforger) — command-line interface (compile, validate, run, deploy)
- [`@flowforger/dsl-native`](https://www.npmjs.com/package/@flowforger/dsl-native) — the TypeScript DSL
- [`@flowforger/engine`](https://www.npmjs.com/package/@flowforger/engine) — local execution engine
- [`@flowforger/emitter-logicapps`](https://www.npmjs.com/package/@flowforger/emitter-logicapps) — IR → Logic Apps JSON

Website: [flowforger.net](https://flowforger.net) · Source: [github.com/tomdam/flowforger](https://github.com/tomdam/flowforger) · Issues: [bug tracker](https://github.com/tomdam/flowforger/issues)

## License

Apache-2.0 © Damjan Tomic
