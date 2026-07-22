# @flowforger/lsp-server

A **Language Server Protocol (LSP) server** for the FlowForger TypeScript DSL, built on [`@flowforger/dsl-language-service`](https://www.npmjs.com/package/@flowforger/dsl-language-service).

Provides diagnostics, completions, and hovers for `.ff.ts` flow files to any LSP-capable editor. The [FlowForger VS Code extension](https://github.com/tomdam/flowforger/tree/main/packages/vscode-extension) bundles this server; other editors (Neovim, Helix, ...) can launch it directly.

## Installation

```bash
npm install @flowforger/lsp-server
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
