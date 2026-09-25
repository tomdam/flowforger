# Security Policy

FlowForger handles Microsoft Entra ID tokens and talks to Dataverse, SharePoint and Microsoft Graph on your behalf, so security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately, either way:

- GitHub's [private vulnerability reporting](https://github.com/tomdam/flowforger/security/advisories/new) for this repository, or
- email **contact@flowforger.net** with the subject line `SECURITY`.

Please include the affected component and version (`flowforger --version`, VS Code extension version), steps to reproduce, and the impact you see. You will get an acknowledgement within a few days. Please give us reasonable time to ship a fix before disclosing publicly; you will be credited in the release notes unless you prefer otherwise.

## Supported versions

Fixes are made on the latest release of the `flowforger` npm package and the FlowForger VS Code extension. Please reproduce on the latest version before reporting.

## Scope

In scope — the code in this repository, notably:

- token acquisition and caching (`--auth`, the MSAL cache under `~/.flowforger/`)
- anything that could send a token, flow definition or connector data somewhere other than the Microsoft endpoint it was meant for
- the VS Code extension, the language server, and the MCP debug server
- code execution through a crafted flow file, IR, or Logic Apps JSON beyond what running that flow is expected to do

Worth knowing (by design, not vulnerabilities):

- Running a flow locally performs its connector actions for real, with your permissions. Treat flow files from others like any other code you run.
- `~/.flowforger/token-cache.json` holds refresh tokens and `~/.flowforger/cassettes/` holds recorded connector responses; both are protected only by your OS user account.

The FlowForger web app at flowforger.net is a separate, closed-source service; reports about it are welcome at the same email address.
