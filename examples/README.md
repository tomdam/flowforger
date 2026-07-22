# FlowForger Examples

Each example folder contains one or more `.ff.ts` files — the TypeScript DSL source for a flow. IR and Logic Apps JSON files are generated on demand by the CLI.

## Running an example

The CLI accepts a `.ff.ts` file directly (it compiles DSL → IR on the fly), or a `.ir.json` you've generated yourself. Pick whichever invocation matches your setup:

```bash
# Option A — published CLI via npx (no install)
npx flowforger run examples/hello-flow/flow.ff.ts

# Option B — global install
npm i -g flowforger
flowforger run examples/hello-flow/flow.ff.ts

# Option C — contributor / local source (from this repo, after `npm run build`)
node packages/cli/dist/index.js run examples/hello-flow/flow.ff.ts
```

All three accept the same flags. Substitute your flow path and add connector flags as needed (e.g. `--auth`, `--sp-token`, `--dv-url`, `--dv-token`, `--in payload.json`, `--var name=value`).

### Common commands

| Task | Command |
|---|---|
| Run locally | `flowforger run <flow>.ff.ts` |
| Compile to Logic Apps JSON | `flowforger compile <flow>.ff.ts --out clientdata.json --config flowforger.config.json` |
| Validate | `flowforger validate <flow>.ff.ts` |
| Reverse-engineer JSON → DSL | `flowforger generate-dsl --in clientdata.json --out flow.ff.ts --name MyFlow` |
| Push to Dataverse | `flowforger push --id <workflowid> --file clientdata.json --url <env-url> --token <AAD_TOKEN>` |

For brevity the per-folder READMEs show only the `npx` form; substitute `flowforger` or `node packages/cli/dist/index.js` as you prefer.

## Example index

### Getting started
- **[hello-flow](hello-flow/)** — The "hello world": manual trigger, Compose, HTTP call, echo.
- **[control-flow](control-flow/)** — Scope, if/else, and foreach in a single small flow.
- **[builtin-actions](builtin-actions/)** — Variables, data ops, table generation, delay, conditional response.
- **[expression-functions](expression-functions/)** — Action/output/trigger/parameter references and property paths.
- **[recurrence-trigger](recurrence-trigger/)** — Scheduled execution with frequency, schedule, and time zone.

### Advanced patterns
- **[advanced-actions](advanced-actions/)** — Nested loops, array ops, JSON parsing, complex control flow.
- **[workflow-action](workflow-action/)** — Parent/child workflow orchestration via `ctx.callWorkflow()`.
- **[unreplied-emails](unreplied-emails/)** — Inbox vs sent comparison via conversation IDs.
- **[optimizer](optimizer/)** — DSL optimizer before/after: variable-to-compose and append-to-array → Select.
- **[odata-tagged-template](odata-tagged-template/)** — OData filter builder via tagged templates.

### Connectors
- **[sharepoint](sharepoint/)** — 33 SharePoint operations (items, files, folders, sharing, approval, version control).
- **[dataverse](dataverse/)** — CRUD, upsert, relationships, batch, search, file ops, custom actions.
- **[office365groups](office365groups/)** — List groups and members.

## Authentication

For connector-backed flows, prefer `--auth` with `flowforger.config.json` over manual tokens — see the [root README](../README.md#connectors-and-authentication) for setup.
