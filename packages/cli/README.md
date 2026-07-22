# flowforger

A TypeScript DSL for authoring, compiling, validating, and deploying **Microsoft Power Automate** and **Azure Logic Apps** workflows — all from code.

Write flows as TypeScript classes, compile to Logic Apps JSON, run locally, and push to Dataverse.

## Install

```bash
npm install -g flowforger
```

Or run directly with npx:

```bash
npx flowforger <command>
```

## Quick Start

### 1. Write a flow in TypeScript

Create `hello-flow.ff.ts`:

```typescript
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
> recognized by the FlowForger compiler and the [VS Code extension](https://marketplace.visualstudio.com/).
> Reference a **Compose** action's output with `ctx.outputs('Name')` and an **HTTP** action's response
> body with `ctx.body('Name')`.

Run it locally to see it work:

```bash
flowforger run hello-flow.ff.ts
```

### 2. Compile to Logic Apps JSON

```bash
flowforger compile hello-flow.ff.ts --emit logicapps --out clientdata.json
```

### 3. Deploy to Dataverse

```bash
flowforger push --id <workflow-id> --file clientdata.json \
  --url https://org.crm.dynamics.com --token <AAD_TOKEN>
```

## Commands

### `compile`

Compile a TypeScript DSL (`.ff.ts`) or IR JSON (`.ir.json`) to Logic Apps JSON.

```bash
# DSL to Logic Apps JSON
flowforger compile flow.ff.ts --emit logicapps --out clientdata.json

# DSL to IR (intermediate representation)
flowforger compile flow.ff.ts --out flow.ir.json

# IR to Logic Apps JSON
flowforger compile flow.ir.json --out clientdata.json

# With connection config
flowforger compile flow.ff.ts --emit logicapps --out clientdata.json \
  --config flowforger.config.json --config-env dev
```

### `validate`

Validate any flow file — DSL, IR, or Logic Apps JSON (auto-detects format).

```bash
# Validate a TypeScript DSL file (same checks as Monaco editor / VS Code extension)
flowforger validate hello-flow.ff.ts

# Validate IR or Logic Apps JSON
flowforger validate clientdata.json
```

For `.ff.ts` / `.ts` files, the validator runs the full DSL language service diagnostics:

| Code | Severity | Description |
|------|----------|-------------|
| DSL001 | Error | Missing `@Flow` decorator |
| DSL002 | Error | Missing trigger method |
| DSL003 | Error | Missing `@Action` decorator |
| DSL004 | Error | Invalid action reference |
| DSL005 | Error | Invalid variable reference |
| DSL007 | Warning | Unused variable |
| DSL008 | Error | Duplicate action name |
| DSL014 | Error | Variable initialization inside control structure |
| DSL015 | Error | Undefined parameter reference |
| DSL016 | Error | Undefined connection reference |

Output format: `file:line:col SEVERITY [CODE] message`

Exit code: `1` if errors found, `0` otherwise.

### `run`

Run a flow locally. Accepts `.ff.ts` (compiled on-the-fly) or `.ir.json` files.

On a terminal you get a readable execution trace; when piped or redirected the
full JSON run result is printed instead (so scripts and CI keep working
unchanged). Force either mode with `--pretty` / `--json`.

```
▶ welcome-flow

  ⚡ manual (trigger)
  ✓ Team → {"name":"FlowForger","members":["Alice","Bob","Charlie"]}
  ✓ Compare_Values condition → true (then branch)
  ✓ ForEach_member — 3 iterations
    [1/3] "Alice"
      ✓ Greet → "Welcome, Alice!"
    ...

✓ Flow succeeded — 7 actions executed
```

```bash
# Run a DSL file directly
flowforger run flow.ff.ts

# Force the JSON run result on a terminal (or --pretty for the opposite)
flowforger run flow.ff.ts --json

# Run compiled IR
flowforger run flow.ir.json

# With trigger input payload
flowforger run flow.ff.ts --in payload.json

# With variable and parameter overrides
flowforger run flow.ff.ts --var name=value --param "My Param=value"

# With connector tokens (manual)
flowforger run flow.ff.ts --graph-token <TOKEN>
flowforger run flow.ff.ts --sp-token <TOKEN>
flowforger run flow.ff.ts --dv-url https://org.crm.dynamics.com --dv-token <TOKEN>

# With automatic authentication (recommended)
flowforger run flow.ff.ts --auth
flowforger run flow.ff.ts --auth --config flowforger.config.json
```

### `generate-dsl`

Reverse engineer Logic Apps JSON back to TypeScript DSL.

```bash
flowforger generate-dsl --in clientdata.json --out flow.ff.ts --name MyFlow
```

### `parity`

Round-trip test: Logic Apps JSON → IR → DSL → IR → Logic Apps JSON.

```bash
flowforger parity --in clientdata.json --name MyFlow
```

### `pull`

Pull flows from Dataverse and decompile them to TypeScript DSL (or raw Logic Apps JSON).

```bash
# Single flow by name (--out is a file path, default: <flowName>.ff.ts)
flowforger pull --name "My Flow" --url https://org.crm.dynamics.com --auth

# Single flow by workflow ID
flowforger pull --id <workflow-id> --url https://org.crm.dynamics.com --auth

# All flows in the environment (--out is a directory, default: cwd)
flowforger pull --all --url https://org.crm.dynamics.com --auth --out ./flows

# All flows in a solution
flowforger pull --solution <uniqueName> --url https://org.crm.dynamics.com --auth --out ./flows

# Output raw clientdata JSON instead of DSL
flowforger pull --name "My Flow" --url https://org.crm.dynamics.com --auth --json
```

Child workflows referenced via `Workflow` actions are resolved recursively by default (each pulled to its own `.ff.ts` with a `childFlows` mapping); use `--no-children` to skip resolution.

### `push`

Deploy a workflow to Dataverse. Accepts `.ff.ts` (auto-compiled) or pre-compiled Logic Apps JSON.

```bash
# Push a DSL file directly (compiles to Logic Apps JSON automatically)
flowforger push --id <workflow-id> --file flow.ff.ts \
  --url https://org.crm.dynamics.com --auth

# Push pre-compiled JSON
flowforger push --id <workflow-id> --file clientdata.json \
  --url https://org.crm.dynamics.com --auth

# With explicit token instead of --auth
flowforger push --id <workflow-id> --file clientdata.json \
  --url https://org.crm.dynamics.com --token <AAD_TOKEN>

# With connection config for compilation
flowforger push --id <workflow-id> --file flow.ff.ts \
  --url https://org.crm.dynamics.com --auth --config flowforger.config.json
```

### `activate`

Change flow state in Dataverse.

```bash
flowforger activate --id <workflow-id> \
  --url https://org.crm.dynamics.com --token <AAD_TOKEN> \
  --state 1 --status 2
```

### `optimize`

Analyze and optimize a DSL flow file.

```bash
flowforger optimize flow.ff.ts --out flow.optimized.ff.ts --report report.json
```

### `init`

Generate a `flowforger.config.json` with auto-discovered values from your Dataverse environment.

```bash
# Full auto-discovery (tenant ID + connection references)
flowforger init --url https://org.crm.dynamics.com --client-id <AZURE_AD_CLIENT_ID>

# With SharePoint URL
flowforger init --url https://org.crm.dynamics.com --client-id <CLIENT_ID> \
  --sp-url https://tenant.sharepoint.com

# Fully offline (no network calls)
flowforger init --url https://org.crm.dynamics.com --client-id <CLIENT_ID> \
  --tenant-id <TENANT_ID> --skip-discovery

# Custom output path
flowforger init --url https://org.crm.dynamics.com --client-id <CLIENT_ID> \
  --out my-config.json
```

The command performs three discovery phases:

1. **Tenant ID** — discovered from an unauthenticated request to the Dataverse URL (parsed from the `WWW-Authenticate` header). Skip with `--tenant-id`.
2. **Authentication** — device code flow via MSAL (uses the same token cache as `--auth`). Skip with `--skip-discovery`.
3. **Connection references** — queries Dataverse for active connection references and maps them to known connectors (SharePoint, Dataverse, Office 365, Approvals, Excel Online, Word Online, Teams). Skip with `--skip-discovery`.

The generated config includes sensible defaults for parser, generator, emitter, and parity settings.

If `flowforger.config.json` already exists, the output is written to `flowforger.config.json.new` to prevent accidental overwrites.

| Option | Description |
|--------|-------------|
| `--url` | Dataverse environment URL (required) |
| `--client-id` | Azure AD app registration client ID (required) |
| `--tenant-id` | Azure AD tenant ID (auto-discovered if omitted) |
| `--sp-url` | SharePoint root URL, e.g. `https://tenant.sharepoint.com` |
| `--out` | Output file path (default: `flowforger.config.json`) |
| `--skip-discovery` | Skip authentication and connection reference discovery |

### `sp-discover`

Discover SharePoint sites and lists via Microsoft Graph.

```bash
# List all sites
flowforger sp-discover --token <GRAPH_TOKEN>

# List all lists in a site
flowforger sp-discover --token <GRAPH_TOKEN> --site https://tenant.sharepoint.com/sites/MySite

# Search for a specific list
flowforger sp-discover --token <GRAPH_TOKEN> --site <site-url> --list "My List"
```

### `skills`

Install the bundled agent skills into the current project so AI coding agents (Claude Code and other tools supporting the Agent Skills format) know how to operate the CLI.

```bash
# Copy skills into .claude/skills/ (Claude Code layout)
flowforger skills install

# Copy into a top-level skills/ directory (agent-agnostic layout)
flowforger skills install --dir skills
```

The skill files ship inside the npm package, so they always match the installed CLI version. Re-run the command after upgrading the CLI to refresh them.

## DSL Features

- **Triggers**: `@HttpTrigger`, `@RecurrenceTrigger`, `@ConnectorTrigger`, `@ManualTrigger`
- **Actions**: HTTP calls, compose, variables, terminate
- **Control flow**: scope, if/else, forEach, switch/case, do-until
- **Connectors**: SharePoint, Dataverse, Office 365, Excel Online, Word Online, Approvals, Teams, OneDrive for Business
- **Expressions**: Full Logic Apps expression language support
- **Child workflows**: Call and orchestrate sub-flows

## Connection Configuration

The easiest way to create a config file is with the `init` command, which auto-discovers your tenant ID and connection references:

```bash
flowforger init --url https://org.crm.dynamics.com --client-id <CLIENT_ID>
```

This generates a `flowforger.config.json` with connection references, parser/emitter defaults, and auth settings pre-filled. You can also create one manually:

```json
{
  "global": {
    "connections": {
      "sharepoint": {
        "referenceName": "shared_sharepointonline",
        "apiId": "/providers/Microsoft.PowerApps/apis/shared_sharepointonline"
      }
    }
  },
  "environments": {
    "dev": { }
  }
}
```

## Auth Configuration

The `--auth` flag enables automatic token acquisition using [MSAL](https://github.com/AzureAD/microsoft-authentication-library-for-js) with persistent refresh tokens. Add an `auth` section to `flowforger.config.json`:

```json
{
  "auth": {
    "clientId": "your-azure-ad-client-id",
    "tenantId": "your-azure-ad-tenant-id",
    "resources": {
      "sharepoint": "https://tenant.sharepoint.com",
      "dataverse": "https://org.crm.dynamics.com"
    },
    "additionalScopes": {
      "graph": ["Sites.Read.All"]
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `clientId` | Azure AD app registration client ID |
| `tenantId` | Azure AD tenant ID |
| `resources.sharepoint` | SharePoint tenant URL (only if flow uses SharePoint connector) |
| `resources.dataverse` | Dataverse environment URL (only if flow uses Dataverse connector) |
| `additionalScopes` | Extra scopes beyond what operations require (e.g., for `HttpRequest`) |

The CLI scans the flow for connector operations and requests only the minimum Azure AD scopes needed. For example, a flow that only sends email will request `Mail.Send` — not broad `Mail.ReadWrite`.

- **First run**: prompts for device code login
- **Subsequent runs**: fully silent using cached refresh tokens (~90 day lifetime)
- **Cache location**: `~/.flowforger/token-cache.json` (encrypted at rest via OS-level protection — DPAPI on Windows, Keychain on macOS, libsecret on Linux)

Graph API scopes are implicit (no config needed). SharePoint and Dataverse require resource URLs because they're org-specific.

### Azure AD App Registration

The app registration needs:
- **"Allow public client flows"** enabled (for device code flow)
- Delegated permissions matching the connectors you use:
  - **Office 365**: `User.Read`, `Mail.Send`, `Mail.ReadWrite`, `Calendars.ReadWrite`, `Contacts.ReadWrite`
  - **SharePoint**: `AllSites.Write` (SharePoint API, not Graph)
  - **Dataverse**: `user_impersonation` (Dynamics CRM API)
  - **Excel/Word Online**: `Files.ReadWrite`

## Requirements

- Node.js >= 18

## License

[Apache License 2.0](./LICENSE).
