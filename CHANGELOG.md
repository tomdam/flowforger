# Changelog

FlowForger ships two artifacts at the same version: the [`flowforger` CLI on npm](https://www.npmjs.com/package/flowforger) and the [FlowForger VS Code extension](https://marketplace.visualstudio.com/items?itemName=FlowForger.flowforger-vscode). Library packages (`@flowforger/*`) are bundled into both and not published separately.

## Unreleased

- **Fixed: appending to an array variable mutated the flow definition itself.** The engine stored the initializer's `[]` literal from the flow as the variable and pushed into it in place, which had three effects:
  - Running the same in-memory flow a second time started from the previous run's items. This affected debugger restarts, Edit & Continue and re-runs in the web app.
  - A variable initialized from another action's outputs (e.g. `outputs('Team')?['members']`) also grew that action's outputs.
  - Every trace step showed the array's final value instead of its value at that step.

  Variables are now copied when stored, and each step records a snapshot. Affects both the CLI and the VS Code extension's debugger.

## 0.3.1 — 2026-09-25 (CLI only; the VS Code extension stays at 0.3.0, it was not affected)

- **Fixed: the CLI crashed on startup on Linux machines without libsecret.** This included slim Docker images and GitHub-hosted Ubuntu runners, and affected every command, even `--version`. The encrypted token cache is now loaded only when `--auth` or `init` needs it, and a missing libsecret produces install instructions instead of a stack trace.

## 0.3.0 — 2026-09-25

**Power Automate's save/activate rules are now checked locally**, so errors the portal only reports when you save show up in your editor and in `flowforger validate`.

- **Action placement rules** (the `InvalidWorkflowRunAction` family): `Response`/`Terminate` nested inside a loop, `Response` without a Request trigger or inside a parallel branch, nesting deeper than 8 levels, `InitializeVariable` outside the root.
- **Definition limits and reference checks:** duplicate action names across scopes (case-insensitive), 80-character names, 500 actions, 25 switch cases, 250 variables, foreach/trigger concurrency, until limits, terminate status, retry policy and recurrence ranges, `runAfter` targets/statuses/cycles, and expression references (`outputs()`/`body()`/`actions()`/`items()`/`parameters()`/`variables()` must point at something that exists). Rules that Microsoft doesn't document but that seem to apply are warnings, not errors.
- **New editor diagnostics DSL035–DSL046**, the editor versions of the rules above, plus a warning for `@{...}` inside comments (it silently becomes a live expression in the emitted description).
- **`flowforger validate` accepts `.ff.ts` files**: it runs the DSL diagnostics first and then, if those pass, the IR-level checks as well.
- **New command `flowforger scopes`**: lists the delegated permissions a flow will request under `--auth`, or every permission any connector can request (`--all`), grouped by API with App IDs, which is useful when setting up an app registration.
- **SharePoint:** listing a folder in a library with more than 5,000 items now works (`GetFilesPropertiesOnly` with `folderPath` uses a threshold-safe CAML query). Content-type fix for file retrieval.
- OData parser/emitter fixes, language-server improvements, rewritten QUICKSTART and README.

## 0.2.0 — 2026-08-29

- **New expression engine**: Power Automate expressions are parsed into an AST with a proper grammar instead of regular expressions (new `@flowforger/expressions` package). OData `$filter` is parsed the same way.
- **Environment variables in `flowforger run`**: when a Dataverse connection is available, env-var-backed parameters resolve to their current environment values instead of the design-time defaults baked into the flow. `--param key=value` overrides per key.
- Dataverse trigger enums, longer action descriptions kept in action metadata (Power Automate caps descriptions at 255 characters), updated AI agent skills.
- **VS Code extension:** schema-aware autocomplete for Dataverse tables and columns and SharePoint sites, lists and fields (plus the *FlowForger: Connect Data Sources* command), a fix for signing in with the wrong account, a fix for stopping the debugger in parallel loops, file download from a debug session, and expression diagnostics as you type.
- Fixed a bundling issue where expression functions could be dropped from the CLI bundle.

## 0.1.x — July–August 2026

First public releases: the TypeScript DSL, local engine with SharePoint, Dataverse and Microsoft Graph connectors, Logic Apps emitter, `generate-dsl` for turning existing flows back into TypeScript, `push` to Dataverse, the VS Code extension with debugger (breakpoints, Edit & Continue, Set Next Statement), and the MCP debug server.

| Date | npm CLI | VS Code extension |
| --- | --- | --- |
| 2026-08-01 | 0.1.5 | 0.1.8 |
| 2026-07-24 | — | 0.1.7 |
| 2026-07-23 | — | 0.1.5 |
| 2026-07-22 | 0.1.4 | 0.1.4 |
| 2026-07-21 | 0.1.2, 0.1.3 | — |
| 2026-07-18 | 0.1.1 (first release) | 0.1.2, 0.1.3 |
