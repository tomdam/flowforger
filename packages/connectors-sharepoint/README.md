# @flowforger/connectors-sharepoint

This connector lets the [FlowForger engine](https://www.npmjs.com/package/@flowforger/engine) execute SharePoint connector actions when running Power Automate flows locally — the same operations and parameter shapes Power Automate uses in the cloud, so a flow tested locally behaves the same after deployment.

It talks to the **SharePoint REST API** (`_api/web/...`) using Power Automate's parameter format (`dataset` = site URL, `table` = list GUID) and supports OData query parameters (`$filter`, `$top`, `$orderby`, `$select`, `$expand`).

> **Authentication note:** SharePoint requires a **SharePoint-specific token** (audience `https://<tenant>.sharepoint.com`), *not* a Microsoft Graph token. With `flowforger run --auth` this is handled for you.

## Usage

The easiest way to use this connector is through the CLI, which wires all connectors into the engine automatically:

```bash
npm install -g flowforger

# Automatic token acquisition (MSAL device-code login, cached ~90 days)
flowforger run flow.ir.json --auth

# Or pass a token explicitly — see the CLI README for per-connector token flags
```

See the [FlowForger documentation](https://flowforger.net) for the full list of supported operations and authentication setup.

## Related packages

FlowForger is a toolset for building, running, and shipping Microsoft Power Automate / Azure Logic Apps flows as TypeScript.

- [`flowforger`](https://www.npmjs.com/package/flowforger) — command-line interface (compile, validate, run, deploy)
- [`@flowforger/dsl-native`](https://www.npmjs.com/package/@flowforger/dsl-native) — the TypeScript DSL
- [`@flowforger/engine`](https://www.npmjs.com/package/@flowforger/engine) — local execution engine
- [`@flowforger/emitter-logicapps`](https://www.npmjs.com/package/@flowforger/emitter-logicapps) — IR → Logic Apps JSON

Website: [flowforger.net](https://flowforger.net) · Source: [github.com/tomdam/flowforger](https://github.com/tomdam/flowforger) · Issues: [bug tracker](https://github.com/tomdam/flowforger/issues)

## License

Apache-2.0 © Damjan Tomic
