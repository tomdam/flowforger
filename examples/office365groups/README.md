# Office 365 Groups Example

Lists Office 365 groups and iterates each one to list its members, using the `office365groups` connector.

## Files

- [flow.ff.ts](flow.ff.ts) — Daily recurrence → `ListGroups` (top 10) → foreach group → `ListGroupMembers` → Compose log

## What It Shows

- The `ctx.connectors.office365groups` connector (`ListGroups`, `ListGroupMembers`)
- A foreach over connector results using `ctx.items('ForEachGroup')` to access the current group
- A `@RecurrenceTrigger` scheduled flow

## Running

See [examples/README.md](../README.md) for CLI install/setup. The connector needs a Microsoft Graph token, easiest via `--auth`:

```bash
npx flowforger run examples/office365groups/flow.ff.ts --auth

# Compile to Logic Apps JSON without credentials
npx flowforger compile examples/office365groups/flow.ff.ts --out clientdata.json
```
