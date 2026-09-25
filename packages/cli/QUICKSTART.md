# FlowForger CLI — Quickstart

Get from zero to pulling, running, and pushing Power Automate flows from your terminal in about 10 minutes.

The one thing every command that talks to Microsoft 365 (`--auth`, `init`, `pull`, `push`) needs is an **app registration in your own Microsoft Entra ID tenant**. FlowForger is open source and does not ship a built-in client ID, so you register one, once, and point the CLI at it. Steps 1 to 3 cover that.

## Prerequisites

- Node.js 18+
- Access to a Power Platform / Dataverse environment
- Permission to create an app registration in your tenant. Any user can, unless your tenant restricts it. Granting **admin consent** (Step 3) needs a Global Administrator, Privileged Role Administrator, or Cloud Application Administrator, so if that is not you, have the permission list from Step 3 ready to hand to an admin.

## Step 1: Create an app registration

1. Go to the [Azure Portal](https://portal.azure.com) > **Microsoft Entra ID** > **App registrations** > **New registration**
2. Name: `FlowForger CLI` (or anything you like)
3. Supported account types: **Accounts in this organizational directory only** (single tenant)
4. Redirect URI: leave blank
5. Click **Register**
6. Copy the **Application (client) ID**. You will pass it as `--client-id` in Step 5.

## Step 2: Enable public client flows

1. In your app registration, go to **Authentication**
2. Under **Advanced settings**, set **Allow public client flows** to **Yes**
3. Click **Save**

This enables the device code login the CLI uses. There is no client secret; the CLI is a public client, and your identity comes from the browser sign-in.

## Step 3: Add API permissions

Go to **API permissions** > **Add a permission**. Everything is a **Delegated** permission. Microsoft Graph is in the first tab; the other APIs are under **APIs my organization uses**, where you can search by name or by the App ID shown below.

The CLI requests only the permissions a given flow actually uses, so you can add just the rows for the connectors you need. Add the full set if you want the registration to cover every flow.

To see exactly what one flow needs, once the CLI is installed:

```bash
flowforger scopes my-flow.ff.ts      # permissions for one flow
flowforger scopes --all              # every permission any connector can request
```

### Always add

| API | Permission | Why |
|-----|------------|-----|
| Microsoft Graph | `User.Read` | Baseline sign-in; several connectors request it |
| Dynamics CRM (App ID `00000007-0000-0000-c000-000000000000`) | `user_impersonation` | Dataverse access for `init`, `pull`, `push`, the Dataverse connector, and resolving environment variables at run time |

### Per connector

| Connector | API | Permissions |
|-----------|-----|-------------|
| SharePoint | SharePoint (App ID `00000003-0000-0ff1-ce00-000000000000`) | `AllSites.Write` |
| Office 365 Outlook | Microsoft Graph | `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.Read`, `Calendars.ReadWrite`, `Contacts.Read`, `Contacts.ReadWrite` |
| Office 365 Users | Microsoft Graph | `User.Read.All`, `User.ReadWrite`, `People.Read`, `Sites.Read.All` |
| Office 365 Groups | Microsoft Graph | `Group.Read.All`, `Group.ReadWrite.All`, `GroupMember.Read.All`, `GroupMember.ReadWrite.All` |
| Microsoft Teams | Microsoft Graph | `Team.ReadBasic.All`, `Team.Create`, `TeamMember.ReadWrite.All`, `Channel.ReadBasic.All`, `Channel.Create`, `ChannelMessage.Read.All`, `ChannelMessage.Send`, `Chat.Create`, `Chat.Read`, `Chat.ReadWrite`, `ChatMember.Read`, `TeamsActivity.Send`, `TeamworkTag.ReadWrite`, `OnlineMeetings.ReadWrite`, `Calendars.ReadWrite`, `User.Read.All` |
| Word Online, Excel Online, OneDrive for Business | Microsoft Graph | `Files.ReadWrite` |
| `listCallbackUrl()` in a flow | Microsoft Flow Service (App ID `7df0a125-d3be-4c96-aa54-591f83ff541c`) | `User` |

Add both the `Read` and the `ReadWrite` variant where both are listed. Entra ID consent is per permission, and a read-only flow requests the narrower one.

`HttpRequest` actions that call Graph directly are not scanned. Add whatever they need here and list it under `auth.additionalScopes.graph` in the config (Step 5).

After adding permissions, click **Grant admin consent for &lt;tenant&gt;**. Without it, the first `--auth` login fails with `AADSTS65001`.

The SharePoint entry is the one people most often get wrong: it must be the **SharePoint** API's `AllSites.Write`, not Microsoft Graph's `Sites.*`. The connector calls the SharePoint REST API, which rejects Graph tokens.

## Step 4: Install the CLI

```bash
npm install -g flowforger
flowforger --help
```

## Step 5: Initialize configuration

Run `init` with your Dataverse URL and the client ID from Step 1:

```bash
flowforger init \
  --url https://yourorg.crm.dynamics.com \
  --client-id <your-client-id> \
  --sp-url https://yourtenant.sharepoint.com
```

This will:
1. Discover your **tenant ID** from the Dataverse URL
2. Prompt you to sign in with a **device code** (one-time; later runs are silent)
3. Query the environment for **connection references** and map them to connectors
4. Write `flowforger.config.json` with everything pre-filled

Drop `--sp-url` if your flows do not use SharePoint. Add `--skip-discovery` to write the config without signing in.

> **Don't know your Dataverse URL?** [Power Platform Admin Center](https://admin.powerplatform.microsoft.com) > **Environments** > your environment > **Environment URL**.

> **Don't know your SharePoint URL?** It is normally `https://yourtenant.sharepoint.com`. The tenant name is on the **Overview** page of Microsoft Entra ID in the Azure Portal.

The relevant part of the generated file looks like this. `clientId` and `tenantId` are what `--auth` uses; edit them here if you ever switch registrations:

```json
{
  "auth": {
    "clientId": "<your-client-id>",
    "tenantId": "<your-tenant-id>",
    "resources": {
      "dataverse": "https://yourorg.crm.dynamics.com",
      "sharepoint": "https://yourtenant.sharepoint.com"
    }
  }
}
```

## Step 6: Pull a flow

```bash
# By name
flowforger pull --name "My Flow Name" --url https://yourorg.crm.dynamics.com --auth

# By workflow ID
flowforger pull --id <workflow-guid> --url https://yourorg.crm.dynamics.com --auth
```

This downloads the flow as a `.ff.ts` TypeScript DSL file. `--auth` reads the client ID and tenant from `flowforger.config.json` in the current directory (or `--config <path>`), so you never pass tokens by hand.

## Step 7: Run a flow locally

```bash
# Run directly
flowforger run my-flow.ff.ts --auth

# With trigger input
flowforger run my-flow.ff.ts --auth --in payload.json

# With variable overrides
flowforger run my-flow.ff.ts --auth --var "myVar=hello"
```

On a terminal you get a readable execution trace (one ✓ per action with its outputs, condition branches, loop iterations). Pipe the output or pass `--json` for the full JSON run result.

If a run fails with a consent error, `flowforger scopes my-flow.ff.ts` tells you which permission is missing from Step 3.

## Step 8: Edit and push

```bash
# Edit the .ff.ts file in your editor...

# Push directly — compiles to Logic Apps JSON automatically.
# A pulled file already carries its workflowId, so no --id is needed.
flowforger push --file my-flow.ff.ts \
  --url https://yourorg.crm.dynamics.com --auth

# Or compile and push separately if you want to inspect the JSON first.
# JSON carries no workflowId, so identify the target with --id (or --name).
flowforger compile my-flow.ff.ts --emit logicapps --out clientdata.json --config flowforger.config.json
flowforger push --id <workflow-id> --file clientdata.json \
  --url https://yourorg.crm.dynamics.com --auth
```

### Pushing a flow you wrote from scratch

A `.ff.ts` you authored yourself has no `workflowId`, because there is no flow in Dataverse yet. Push it anyway and it gets created:

```bash
flowforger push --file my-new-flow.ff.ts --solution MySolution \
  --url https://yourorg.crm.dynamics.com --auth
```

The flow is created as **Draft** (run `flowforger activate` to turn it on), and its new GUID is written back into your file's `@Flow({...})` decorator, so every later push updates that same flow instead of creating another one. Drop `--solution` to let it land in the environment's default solution.

In CI, add `--no-create` to any push that should fail rather than quietly create a flow.

## Summary of files

| File | Purpose |
|------|---------|
| `flowforger.config.json` | Auth settings (client ID, tenant, resources), connection references, parser/emitter defaults |
| `*.ff.ts` | Flow source code in TypeScript DSL |
| `*.ir.json` | Intermediate representation (optional, for debugging) |
| `clientdata.json` | Compiled Logic Apps JSON (what Dataverse expects) |
| `~/.flowforger/token-cache.json` | Cached refresh tokens, encrypted for the current OS user (DPAPI on Windows, Keychain on macOS, libsecret on Linux) |

The token cache is readable by anything running as your user account, which is the same protection level as the Azure CLI or your browser's sign-in. Copied to another machine or user it is unreadable. To revoke it, delete the file, or revoke the user's sessions in Entra ID.

## Common issues

**Linux: "The encrypted token cache used by --auth could not be loaded: libsecret-1.so.0 ..."**
- `--auth` stores tokens through libsecret on Linux. Install it (`sudo apt-get install libsecret-1-0` on Debian/Ubuntu, `sudo dnf install libsecret` on Fedora), or skip `--auth` and pass tokens explicitly (`--graph-token`, `--sp-token`, `--dv-token`). Every other command works without it.

**"AADSTS65001: The user or administrator has not consented to use the application"**
- Go back to Step 3 and click **Grant admin consent**, or a permission the flow needs is missing. Run `flowforger scopes <flow>` to see the list.

**"AADSTS7000218: The request body must contain ... client_secret"**
- Go back to Step 2 and enable **Allow public client flows**

**"AADSTS700016: Application with identifier ... was not found in the directory"**
- The `clientId` in `flowforger.config.json` does not match a registration in the `tenantId` tenant. Re-check both values.

**"401 Unauthorized" from SharePoint although the sign-in succeeded**
- The registration has Graph `Sites.*` permissions instead of the SharePoint API's `AllSites.Write`. See the note under Step 3.

**"Dataverse 403: ..."**
- Your user account needs a security role in the Dataverse environment (for example System Customizer)

**"Could not discover tenant ID"**
- Verify the Dataverse URL is correct and reachable
- Try opening `https://yourorg.crm.dynamics.com` in a browser to confirm it loads

**"--auth requires a config file"**
- Run the command from the directory containing `flowforger.config.json`, or pass `--config <path>`

**Token expired after ~90 days of inactivity**
- Run any `--auth` command again. It prompts for a device code login and refreshes the cache.
