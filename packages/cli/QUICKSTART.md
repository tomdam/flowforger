# FlowForger CLI — Quickstart

Get from zero to pulling and running Power Automate flows locally in ~10 minutes.

## Prerequisites

- Node.js 18+
- An Azure AD tenant with access to a Power Platform / Dataverse environment
- Global Admin or Application Administrator role (for app registration)

## Step 1: Create an Azure AD App Registration

1. Go to [Azure Portal](https://portal.azure.com) > **Azure Active Directory** > **App registrations** > **New registration**
2. Name: `FlowForger CLI` (or anything you like)
3. Supported account types: **Single tenant**
4. Redirect URI: leave blank
5. Click **Register**
6. Copy the **Application (client) ID** — you'll need this as `--client-id`

## Step 2: Enable Public Client Flow

1. In your app registration, go to **Authentication**
2. Under **Advanced settings**, set **Allow public client flows** to **Yes**
3. Click **Save**

This enables the device code login flow used by the CLI.

## Step 3: Add API Permissions

Go to **API permissions** > **Add a permission** and add these:

### Microsoft Graph (delegated)

- `User.Read` — required for all flows

### Dynamics CRM (delegated)

> Search under **APIs my organization uses** for "Dynamics CRM" (App ID: `00000007-0000-0000-c000-000000000000`)

- `user_impersonation` — required for Dataverse access (pull, push, init discovery)

### SharePoint (delegated) — if your flows use SharePoint

> Search under **APIs my organization uses** for "SharePoint" (App ID: `00000003-0000-0ff1-ce00-000000000000`)

- `AllSites.Write` — for SharePoint connector operations

### Power Apps Service (delegated) — optional, for environment discovery in the web app

> Search under **APIs my organization uses** for App ID: `475226c6-020e-4fb2-8a90-7a972cbfc1d4`

- `User` — for environment listing

After adding all permissions, click **Grant admin consent** for your tenant.

## Step 4: Install FlowForger CLI

```bash
npm install -g flowforger
```

Verify:

```bash
flowforger --help
```

## Step 5: Initialize Configuration

Run `init` with your Dataverse URL and client ID:

```bash
flowforger init \
  --url https://yourorg.crm.dynamics.com \
  --client-id <your-client-id> \
  --sp-url https://yourtenant.sharepoint.com
```

This will:
1. Auto-discover your **tenant ID** from the Dataverse URL
2. Prompt you to authenticate via **device code** (one-time login)
3. Query your environment for **connection references** and map them automatically
4. Write a `flowforger.config.json` with everything pre-filled

> **Don't know your Dataverse URL?** Go to [Power Platform Admin Center](https://admin.powerplatform.microsoft.com) > **Environments** > click your environment > copy the **Environment URL**.

> **Don't know your SharePoint URL?** It's typically `https://yourtenant.sharepoint.com`. Check your tenant name at [Azure Portal](https://portal.azure.com) > **Azure Active Directory** > **Overview**.

## Step 6: Pull a Flow

```bash
# By name
flowforger pull --name "My Flow Name" --url https://yourorg.crm.dynamics.com --auth

# By workflow ID
flowforger pull --id <workflow-guid> --url https://yourorg.crm.dynamics.com --auth
```

This downloads the flow as a `.ff.ts` TypeScript DSL file. The `--auth` flag uses the credentials from your config file — no need to pass tokens manually.

## Step 7: Run a Flow Locally

```bash
# Run directly
flowforger run my-flow.ff.ts --auth

# With trigger input
flowforger run my-flow.ff.ts --auth --in payload.json

# With variable overrides
flowforger run my-flow.ff.ts --auth --var "myVar=hello"
```

On a terminal you'll see a readable execution trace (✓ per action with its
outputs, condition branches, loop iterations). Pipe the output or pass
`--json` to get the full JSON run result instead.

## Step 8: Edit and Push

```bash
# Edit the .ff.ts file in your editor...

# Push directly — compiles to Logic Apps JSON automatically
flowforger push --id <workflow-id> --file my-flow.ff.ts \
  --url https://yourorg.crm.dynamics.com --auth

# Or compile and push separately if you want to inspect the JSON first
flowforger compile my-flow.ff.ts --emit logicapps --out clientdata.json --config flowforger.config.json
flowforger push --id <workflow-id> --file clientdata.json \
  --url https://yourorg.crm.dynamics.com --auth
```

## Summary of Files

| File | Purpose |
|------|---------|
| `flowforger.config.json` | Connection references, auth settings, parser/emitter defaults |
| `*.ff.ts` | Flow source code in TypeScript DSL |
| `*.ir.json` | Intermediate representation (optional, for debugging) |
| `clientdata.json` | Compiled Logic Apps JSON (what Dataverse expects) |
| `~/.flowforger/token-cache.json` | Cached auth tokens (encrypted, auto-managed) |

## Common Issues

**"AADSTS65001: The user or administrator has not consented to use the application"**
- Go back to Step 3 and click **Grant admin consent**

**"AADSTS7000218: The request body must contain ... client_secret"**
- Go back to Step 2 and enable **Allow public client flows**

**"Dataverse 403: ..."**
- Your user account needs a security role in the Dataverse environment (e.g., System Customizer)

**"Could not discover tenant ID"**
- Verify the Dataverse URL is correct and reachable
- Try opening `https://yourorg.crm.dynamics.com` in a browser to confirm it loads

**Token expired after ~90 days of inactivity**
- Just run any `--auth` command again — it will prompt for device code login and refresh the cache
