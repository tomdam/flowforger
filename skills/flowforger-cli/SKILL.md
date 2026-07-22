---
name: flowforger-cli
description: Use when installing, configuring, or operating the flowforger CLI — pulling or pushing Power Automate flows from Dataverse, converting Logic Apps clientdata.json to TypeScript DSL, compiling DSL, validating, or running flows locally. Also use when hitting "--auth requires a config file", 401 errors with SharePoint tokens, DATAVERSE_TOKEN questions, operationMetadataId noise in generated .ff.ts, or flowforger.config.json schema questions.
---

# FlowForger CLI Operations

## Overview

`flowforger` is a self-contained CLI for Power Automate / Logic Apps workflows: pull flows from Dataverse as TypeScript DSL (`.ff.ts`), edit, compile, run locally, and push back. **No npm packages are needed in the consuming project** — `.ff.ts` files are transformed by the CLI itself, never by `tsc`, and imports in them are dead weight (omit them).

Run `flowforger --help` for full flag reference. This skill covers what `--help` does not.

## Command Quick Reference

| Task | Command |
|------|---------|
| First-time project setup | `flowforger init --url <envUrl> --client-id <appId>` |
| Pull one flow | `flowforger pull --name "My Flow" --auth` |
| Pull a whole solution | `flowforger pull --solution <UniqueName> --auth --out ./flows` |
| Push a flow back | `flowforger push --file flow.ff.ts --auth` |
| Activate / deactivate | `flowforger activate --id <guid> --url <envUrl> --token <t> --state 1 --status 2` |
| Logic Apps JSON → DSL | `flowforger generate-dsl --in clientdata.json --out flow.ff.ts --name MyFlow` |
| DSL → Logic Apps JSON | `flowforger compile flow.ff.ts --out clientdata.json --emit logicapps` |
| Validate (either format) | `flowforger validate <file.json\|file.ff.ts>` |
| Run locally | `flowforger run flow.ff.ts --in payload.json [--auth\|--sp-token …]` |
| Install/refresh these skills in a project | `flowforger skills install` (fetches latest from GitHub; `--bundled` for offline) |

## First-Time Setup (per project)

1. You need an **Azure AD app registration client ID** (delegated permissions; Dynamics CRM `user_impersonation` for Dataverse; SharePoint `AllSites.*` if flows use SharePoint). Ask the user for it — it is not discoverable.
2. In the project root: `flowforger init --url https://<org>.crm4.dynamics.com --client-id <appId>`. This auto-discovers the tenant ID, prompts a **device-code login**, discovers the environment's connection references, and writes `flowforger.config.json` to the cwd. Offline/no-credentials: add `--skip-discovery` (leaves connection reference names empty — fill before push of new flows).
3. Tokens are cached in `~/.flowforger/token-cache.json` (~90-day refresh); subsequent `--auth` runs are silent.

**Never hand-write `flowforger.config.json`** — generate it with `init`. Structure: `auth` (clientId, tenantId, `resources.dataverse`/`resources.sharepoint`), `global.connections` (connector → connection reference), `global.parser` / `global.generator` (codegen tuning), `environments.<name>` (overrides selected via `--config-env`).

**Config auto-loading:** `pull`, `push`, and every `--auth` path read `flowforger.config.json` from the **cwd** automatically. `generate-dsl`, `parity`, `compile`, and `optimize` use the config **only with an explicit `--config` flag**. CLI flags always override config values.

## Auth & Token Matrix

| Purpose | Flag / env | Token audience (resource) | Quick recipe |
|---------|-----------|---------------------------|--------------|
| Dataverse (pull/push/activate) | `--token` or `DATAVERSE_TOKEN` | the environment URL, e.g. `https://org.crm4.dynamics.com` | `az account get-access-token --resource <envUrl> --query accessToken -o tsv` |
| Anything, hands-free | `--auth` | (acquired per connector automatically) | needs `auth` section in config; device-code on first run |
| SharePoint connector (run) | `--sp-token` | `https://<tenant>.sharepoint.com` — **NOT Graph** | `az account get-access-token --resource https://<tenant>.sharepoint.com ...` |
| Office365/Excel/Word/OneDrive (run) | `--graph-token` etc. | `https://graph.microsoft.com` | `az account get-access-token --resource https://graph.microsoft.com ...` |

- **The SharePoint trap:** a Graph token with `Sites.Read.All` gives 401 against the SharePoint REST API. The audience must be the tenant's SharePoint host. Verify at jwt.ms: `aud` should contain `00000003-0000-0ff1-ce00-000000000000`.
- `activate` does **not** support `--auth` — it needs `--token`/`DATAVERSE_TOKEN` explicitly. State values: activate = `--state 1 --status 2`; draft = `--state 0 --status 1`.
- Explicit `--xxx-token` flags override `--auth` per connector.

## Behavior Facts (verified, not guessable from --help)

- **`compile` emits Flow IR by default.** For Power Automate `clientdata.json` you MUST pass `--emit logicapps` (and `--config` if connection references matter).
- **`run` output & exit code:** 0 only when the flow run `Succeeded`, 1 for anything else (Failed, Cancelled). When stdout is piped (the normal case for agents/CI) the JSON trace prints to **stdout** (jq-safe) and the human `=== FLOW FAILED ===` banner goes to stderr. On an interactive terminal a human-readable trace prints instead — pass `--json` to force the JSON trace (`--pretty` forces the opposite). The most explicit CI gate is still `.status == "Succeeded"` from the JSON.
- **Un-awaited `ctx.*` action calls are SILENTLY OMITTED from the compiled flow** — no error at compile or run time, the action just doesn't exist. Always `await` action calls, and run `flowforger validate <file.ff.ts>` (diagnostic DSL017 catches this; exits 1 on DSL errors).
- **`pull --solution` matches the solution UNIQUE name**, not the display name. Find it in the maker portal (Solutions list, "Name" column) — there is no CLI command to list solutions.
- **Pulled `.ff.ts` embeds `workflowId`** in `@Flow({...})`, so `push --file <file> --auth` needs no `--id`. JSON pushes always need `--id`.
- **`push` only PATCHes the flow definition** (`clientdata`). It does not change activation state, publish, or touch solution membership — run `activate` afterwards if needed. `.ff.ts` inputs are compiled on the fly using the cwd config's connection references. With `--auth`, `--url` may be omitted — it comes from `auth.resources.dataverse` in the config (an explicit `--url` overrides it).
- **`operationMetadataId` stripping** comes from `global.parser.skipMetadataFields` (init writes `["operationMetadataId"]`). `pull` applies it automatically via the cwd config (CLI ≥ 0.1.1 — check with `flowforger --version`); one-off override: `--skip-metadata-fields operationMetadataId` (also valid on `pull`, despite being listed under generate-dsl/parity options).
- **`validate` is permissive** — it checks schema shape, not connection-reference correctness or referential integrity. `ok:true` does not guarantee an importable flow; use `parity` for round-trip confidence.
- **`pull` creates the `--out` directory** if missing; no need to pre-create.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Hand-writing `flowforger.config.json` from guessed field names | Always `flowforger init` (with `--skip-discovery` when offline) |
| `compile flow.ff.ts --out clientdata.json` without `--emit logicapps` | Output was IR; add the flag |
| Passing a Graph token as `--sp-token` | 401; acquire with SharePoint host as resource |
| Using the solution display name with `--solution` | Use the unique name |
| Forgetting `await` on a `ctx.*` call | Action silently vanishes from the flow; `flowforger validate` catches it |
| Expecting `push` to activate/publish | Follow with `flowforger activate` |
| Adding `import` lines or npm deps for `.ff.ts` types | Not needed; the CLI resolves everything itself |

For authoring `.ff.ts` content (DSL rules, connectors, expressions), see the `flowforger` skill if installed alongside this one.
