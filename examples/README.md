# FlowForger Examples

Each example folder contains one or more `.ff.ts` files, the TypeScript DSL source for a flow, and a README that says what the flow shows and how to run it. IR and Logic Apps JSON are generated on demand by the CLI and are not committed.

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
| Run locally | `flowforger run <flow>.ff.ts [--in payload.json]` |
| Run without letting a write happen | `flowforger run <flow>.ff.ts --stop-before <Action>`, `--mock <Action>=<outputs.json>`, `--live <Action>` (see [local-testing](local-testing/)) |
| Validate | `flowforger validate <flow>.ff.ts` |
| Compile to Logic Apps JSON | `flowforger compile <flow>.ff.ts --emit logicapps --out clientdata.json --config flowforger.config.json` |
| Push to an environment | `flowforger push --file <flow>.ff.ts --solution <name> --url <env-url> --auth` |
| Diff against the live flow | `flowforger diff --file <flow>.ff.ts --auth` |
| Reverse-engineer JSON → DSL | `flowforger generate-dsl --in clientdata.json --out flow.ff.ts --name MyFlow` |

For brevity the per-folder READMEs show only the `npx` form; substitute `flowforger` or `node packages/cli/dist/index.js` as you prefer.

## Example index

### Start here (no credentials needed)
- **[hello-flow](hello-flow/)** — The "hello world": manual trigger, Compose, HTTP call, echo.
- **[control-flow](control-flow/)** — Scope, if/else and foreach in one small offline flow.
- **[builtin-actions](builtin-actions/)** — Variables, data operations, CSV/HTML tables, delay, a Response per branch.
- **[expression-functions](expression-functions/)** — `outputs()` vs `body()` vs `actions()`, trigger and parameter reads, property paths, typed helpers next to raw expressions.
- **[recurrence-trigger](recurrence-trigger/)** — A scheduled flow: frequency, schedule and time zone.

### What FlowForger adds
- **[child-flows](child-flows/)** — A parent and three child flows written in the DSL, run offline with one command; what the parent gets back from a child, try/catch/finally around a failing child, mocks and the deploy order.
- **[local-testing](local-testing/)** — `--stop-before`, `--mock`, `--mocks`, `--live` and `--replay-run` walked through against one flow: inspect a write without sending it.
- **[advanced-actions](advanced-actions/)** — Nested loops, array variables, JSON parsing, switch, try/catch/finally inside a loop, do-until.
- **[optimizer](optimizer/)** — `flowforger optimize` before/after: variable-to-Compose and loop-append-to-Select rewrites.
- **[odata-tagged-template](odata-tagged-template/)** — OData `$filter` as a builder API or a tagged template with TypeScript operators.

### Connectors (need a tenant)
- **[sharepoint](sharepoint/)** — 33 SharePoint operations (items, files, folders, attachments, sharing, approval, version control).
- **[dataverse](dataverse/)** — CRUD, upsert, relationships, batch, search, file columns, custom actions.
- **[unreplied-emails](unreplied-emails/)** — Office 365: inbox vs sent-items comparison by conversation id, HTML summary mail, flow parameters.
- **[office365groups](office365groups/)** — List groups and their members.

## Configuring the examples

Examples that touch a real tenant open their `run()` method with a configuration block:

```typescript
// Configuration for this example - edit to point at your own tenant.
// In a production flow, prefer a flow parameter bound to an environment
// variable (ctx.parameters("...")), or values passed in via the trigger payload.
let siteUrl = "https://contoso.sharepoint.com/sites/MySite";
let listId = "aaaaaaaa-1111-2222-3333-444444444444";
```

Edit those values and the example is ready to run. Where to find them:

| Value | Where to find it |
|---|---|
| `siteUrl` | The site's address in the browser, up to and including the site name |
| `listId` / `libraryId` | List settings — the `List` parameter in the settings URL — or run `examples/sharepoint/get-lists.ff.ts` |
| `fileId` | `examples/sharepoint/get-files-properties-only.ff.ts` returns each file's `UniqueId` |
| `recordId` (Dataverse) | The `id` parameter in the record's URL in the model-driven app |

### Choosing a mechanism for your own flows

A config variable is right for trying an example out. For a flow you intend to keep, prefer one of these:

**Flow parameter bound to an environment variable** — for values fixed per environment (dev/test/prod) rather than per run. This is the usual production choice, because a solution can carry different values per environment without editing the flow:

```typescript
await ctx.connectors.sharepoint.CreateFile('SaveFile', {
  dataset: ctx.parameters('SharePoint site URL (cr_SiteUrl)'),
  folderPath: ctx.parameters('Library folder path (cr_FolderPath)'),
  // ...
}, 'shared_sharepointonline');

// and in the constructor:
ctx.flow.parameters = {
  "$connections": { defaultValue: {}, type: "Object" },
  "$authentication": { defaultValue: {}, type: "SecureObject" },
  "SharePoint site URL (cr_SiteUrl)": {
    type: 'String',
    defaultValue: 'https://contoso.sharepoint.com/sites/MySite',
    metadata: { schemaName: 'cr_SiteUrl', description: 'Target SharePoint site' },
  },
};
```

The name passed to `ctx.parameters()` must match the key in `ctx.flow.parameters` exactly — there is no normalization. With `--auth`, a local run resolves such parameters to the environment's current values; `--param "<key>=<value>"` overrides one. See [unreplied-emails](unreplied-emails/) for a flow driven by parameters.

**Trigger payload** — for values the caller knows and that differ per run, such as the specific item being processed:

```typescript
let siteUrl: string = ctx.triggerBody().siteUrl;
```

See [sharepoint/advanced-workflow.ff.ts](sharepoint/advanced-workflow.ff.ts).

## Authentication

For connector-backed flows, prefer `--auth` with a `flowforger.config.json` over manual tokens: the CLI scans the flow for the connectors it uses, requests only those scopes, and caches the refresh token. `flowforger scopes <flow>.ff.ts` lists the permissions one flow needs; `flowforger scopes --all` lists every permission any connector can ask for, for the app registration. See the [root README](../README.md) for the app registration setup.
