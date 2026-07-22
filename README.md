# FlowForger

**Build, run, and emit Microsoft Power Automate and Azure Logic Apps workflows in TypeScript.**

FlowForger lets you author Power Automate / Logic Apps flows as TypeScript code, run them locally with a built-in engine, and compile them to the same `clientdata.json` format the Power Automate portal produces — so you can deploy them straight to Dataverse. It also works in reverse: pull an existing flow from your environment and get readable TypeScript back.

```ts
@Flow('hello-flow')
class HelloFlow {
  @ManualTrigger()
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    // Build a message with a Compose action
    await ctx.compose('Greeting', { message: 'Hello from FlowForger' });

    // POST it to httpbin, which echoes the body back
    await ctx.http('CallHttpBin', {
      method: 'POST',
      url: 'https://httpbin.org/post',
      body: ctx.outputs('Greeting'),
    });

    // Pull the echoed message out of the response
    await ctx.compose('Echo', ctx.body('CallHttpBin')?.['json']);
  }
}
```

> **No imports needed.** `@Flow`, `@ManualTrigger`, `@Action`, and `FlowContext` are ambient globals
> recognized by the FlowForger compiler. Reference a **Compose** action's output with `ctx.outputs('Name')`
> and an **HTTP** action's response body with `ctx.body('Name')`.

## Why?

Authoring flows in the Power Automate UI is fine for small things — but version control, code review, refactoring, and reuse fall apart fast. FlowForger gives you:

- **A typed TypeScript DSL** instead of clicking through a designer
- **A local execution engine** so you can run and debug flows without a Power Platform environment
- **A Logic Apps emitter** that produces real `clientdata.json` — same format the portal uses, deploy via Dataverse Web API
- **A reverse-engineering path** — pull an existing flow and get readable TypeScript back
- **A round trip** — `pull` a flow from Dataverse, edit it as code, `push` it back

## Quick start

```bash
git clone https://github.com/tomdam/flowforger.git
cd flowforger
npm install
npm run build
```

Run the hello example locally:

```bash
node packages/cli/dist/index.js run examples/hello-flow/flow.ff.ts
```

Compile it to Logic Apps JSON:

```bash
node packages/cli/dist/index.js compile examples/hello-flow/flow.ff.ts --emit logicapps --out clientdata.json
```

Turn an existing flow's JSON back into TypeScript:

```bash
node packages/cli/dist/index.js generate-dsl --in clientdata.json --out flow.ff.ts --name HelloFlow
```

## CLI at a glance

| Command | What it does |
| --- | --- |
| `run` | Execute a flow locally with the built-in engine (`--in`, `--vars`, connector tokens, `--auth`) |
| `compile` | DSL / IR → Logic Apps `clientdata.json` |
| `validate` | Schema-check a `.ff.ts`, IR, or Logic Apps JSON file |
| `generate-dsl` | Reverse-engineer Logic Apps JSON → TypeScript DSL |
| `pull` / `push` | Fetch flows from / deploy flows to a Dataverse environment |
| `activate` | Set a deployed flow's state/status |
| `parity` | Round-trip check: JSON → DSL → JSON, diff the result |
| `optimize` | Rewrite inefficient patterns (loop+append → Select, single-set variables → Compose) |
| `init` | Scaffold a `flowforger.config.json` for your environment |
| `skills install` | Install the AI agent skills into a project (fetches latest from GitHub; `--bundled` for offline) |

Run `node packages/cli/dist/index.js --help` for all flags.

## Examples

The [examples/](examples/) directory has a runnable flow for every major feature — from a minimal hello flow through control flow, expressions, child-workflow orchestration, the optimizer, and the SharePoint / Dataverse / Office 365 connectors.

See [examples/README.md](examples/README.md) for the full index and per-example instructions.

## Architecture

A flow is an `IR` document: a `name` and an array of typed nodes (one trigger followed by actions, with nested `actions` arrays inside control nodes like scope/if/foreach).

```
TypeScript DSL ──transform──▶  IR  ──emit──▶ Logic Apps JSON
      ▲                        │ ▲                │
      └────────generate────────┘ └─────parse──────┘
                               │
                               ▼
                        Run via engine
```

The same IR is the source of truth for local execution, emitting, and reverse engineering.

## Connectors and authentication

FlowForger ships connectors for the most common Power Automate APIs: SharePoint, Dataverse, Office 365 Outlook, Office 365 Users, Office 365 Groups, Excel Online, Word Online, Teams, OneDrive, and plain HTTP. When running locally, provide tokens for whichever connectors your flow uses:

```bash
# SharePoint (note: SharePoint REST API — NOT a Graph token)
node packages/cli/dist/index.js run flow.ff.ts --sp-token $SP_TOKEN

# Dataverse
node packages/cli/dist/index.js run flow.ff.ts \
  --dv-url https://org.crm.dynamics.com --dv-token $DV_TOKEN

# Or use --auth for automatic MSAL device-code login with cached refresh tokens
node packages/cli/dist/index.js run flow.ff.ts --auth
```

See individual package READMEs under [packages/](packages/) for connector-specific setup.

## Editor and AI tooling

- **[docs/grammar/](docs/grammar/)** — Formal EBNF grammar for the DSL, the conformance rules, and a fully annotated [canonical example](docs/grammar/canonical-example.ff.ts).
- **[skills/](skills/)** — Agent-agnostic skill documents (DSL syntax, connectors, examples, CLI operations) that teach AI coding agents to write correct FlowForger flows. Install them into any project with `flowforger skills install` — it fetches the latest versions from this repo (re-run any time to refresh; `--bundled` uses the copies shipped with the CLI).
- **Language tooling** — `@flowforger/dsl-language-service` (diagnostics, completions, hovers for `.ff.ts`), `@flowforger/lsp-server`, and a VS Code extension under [packages/vscode-extension/](packages/vscode-extension/).

## Packages

| Package | What it does |
| --- | --- |
| `@flowforger/ir` | The intermediate representation — typed nodes for triggers, actions, control flow |
| `@flowforger/dsl-native` | TypeScript DSL with decorators (`@Flow`, `@HttpTrigger`, `@Action`); transforms TS ↔ IR; includes the optimizer |
| `@flowforger/engine` | Local execution runtime with full Logic Apps expression support |
| `@flowforger/emitter-logicapps` | Compiles IR to Power Automate / Logic Apps `clientdata.json` |
| `@flowforger/validator` | Schema validation for IR and Logic Apps JSON (auto-detects format) |
| `flowforger` | Command-line interface (see [CLI at a glance](#cli-at-a-glance)) |
| `@flowforger/connectors-*` | Connector implementations: SharePoint, Dataverse, Office 365 Outlook/Users/Groups, Excel Online, Word Online, Teams, OneDrive, HTTP |
| `@flowforger/dataverse-sdk` | Thin Dataverse Web API client |
| `@flowforger/dsl-language-service` | Language service powering diagnostics, completions, and hovers |
| `@flowforger/lsp-server` | Language Server Protocol wrapper around the language service |
| `flowforger-vscode` | VS Code extension for `.ff.ts` language support |

## Status

FlowForger is under active development. The IR, DSL, engine, and Logic Apps emitter are stable and used in production. Connector coverage continues to grow.

## Contributing

Issues and pull requests are welcome. Please open an issue first for significant changes so we can discuss the design.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
