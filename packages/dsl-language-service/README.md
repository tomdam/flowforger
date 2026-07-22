# @flowforger/dsl-language-service

The **language service for the FlowForger TypeScript DSL**: diagnostics, completions, and hover information for `.ff.ts` flow files.

This package contains the editor-agnostic analysis logic. It powers:

- the [FlowForger VS Code extension](https://github.com/tomdam/flowforger/tree/main/packages/vscode-extension) (via [`@flowforger/lsp-server`](https://www.npmjs.com/package/@flowforger/lsp-server))
- DSL editing features in FlowForger's web tooling

## Installation

```bash
npm install @flowforger/dsl-language-service
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
