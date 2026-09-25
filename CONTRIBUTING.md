# Contributing to FlowForger

Thanks for your interest in FlowForger! Bug reports, feature ideas, docs fixes, and pull requests are all welcome.

## Before you start

- **Bugs and small fixes:** open a pull request directly, or an issue if you're not sure it's a bug.
- **Larger changes** (new connectors, new DSL syntax, changes to the IR or emitter output): please open an issue first so we can agree on the design before you invest the time.
- **Security problems:** do **not** open a public issue — see [SECURITY.md](./SECURITY.md).

## How this repository works

This repository is a published mirror of the open-source parts of FlowForger, synced from the maintainer's development tree. Pull requests are reviewed here as usual; an accepted change is applied upstream and appears in the next sync, with your authorship credited in the commit (`Co-authored-by`). The code, history of discussion, and your credit all stay public — it just means the merge button isn't the final step.

## Development setup

Requirements: **Node.js 22+** and npm 10+.

```bash
git clone https://github.com/tomdam/flowforger.git
cd flowforger
npm install
npm run build     # tsc -b across all packages (TypeScript project references)
npm test          # runs every workspace's test suite
```

Run the CLI from your build:

```bash
node packages/cli/dist/index.js --help
node packages/cli/dist/index.js run examples/hello-flow/flow.ff.ts
```

Build the VS Code extension with `npm --prefix packages/vscode-extension run build`, then either launch it from VS Code in an Extension Development Host (Run → "Run Extension" with `packages/vscode-extension` as the extension folder) or package and install it:

```bash
cd packages/vscode-extension
npm run package                                  # → flowforger-vscode-<version>.vsix
code --install-extension flowforger-vscode-*.vsix
```

## Repository layout

| Path | What lives there |
| --- | --- |
| `packages/ir` | The intermediate representation (`FlowIR`) every other package builds on |
| `packages/dsl-native` | TypeScript DSL → IR transformer, Logic Apps JSON → IR parser, IR → DSL generator |
| `packages/engine` | Local execution engine and expression evaluator |
| `packages/emitter-logicapps` | IR → Logic Apps / Power Automate `clientdata.json` |
| `packages/validator` | Validation of IR and Logic Apps JSON (placement rules, limits, references) |
| `packages/connectors-*` | Connector implementations used by the local engine |
| `packages/dsl-language-service`, `packages/lsp-server` | Diagnostics, completions, hovers for `.ff.ts` files |
| `packages/debug-core`, `packages/debug-node`, `packages/mcp-server` | Debugger core, Node debug host, MCP debug server |
| `packages/cli` | The `flowforger` command-line tool (bundles everything above) |
| `packages/vscode-extension` | The VS Code extension |
| `examples/` | Example flows — also a good regression corpus |
| `skills/` | AI agent skills (installed via `flowforger skills install`) |
| `docs/grammar/` | Formal DSL grammar and conformance rules |

## Guidelines

- **Tests:** add or update tests for behaviour changes. Engine and expression changes especially — `packages/engine` has the largest suite for a reason.
- **Parity with the cloud:** FlowForger's value is that a flow behaves the same locally as in Power Automate. If your change touches expression evaluation, connector output shapes, or emitted JSON, say in the PR how you verified it against the real service.
- **DSL types live in two places:** `packages/dsl-native/src/context.ts` and `packages/dsl-native/src/monaco-types.ts` must stay in sync.
- **Formatting:** run `npm run format` (Prettier) before committing.
- **ES modules:** all packages are `"type": "module"`.
- **No secrets in examples or tests:** use `contoso`-style tenant names and placeholder GUIDs. Never commit tokens, `flowforger.config.json`, or recorded cassettes from a real tenant.

## Reporting bugs

The most useful bug report includes:

- `flowforger --version` and/or the VS Code extension version
- the smallest `.ff.ts` (or IR / `clientdata.json`) that reproduces it — with tenant URLs, emails and IDs redacted
- what you expected and what happened (full error output, or `flowforger run --json` output)
- for "works locally but not in Power Automate" (or vice versa): the run result from both sides

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](./LICENSE), the same license as the project (Apache-2.0 section 5).
