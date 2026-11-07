# Unreplied Emails from Colleagues

A scheduled Office 365 flow that finds the colleague threads nobody has answered and mails a daily summary.

## Files

- [unreplied-colleagues.ff.ts](unreplied-colleagues.ff.ts) — Daily recurrence → two `GetEmailsV2` reads → Filter array / Select → HTML table → `SendEmailV2`

## How It Works

1. **Recurrence trigger**: runs daily at 08:00 UTC
2. **Get inbox emails**: `GetEmailsV2` with an OData `filter` on `receivedDateTime` for the lookback window
3. **Filter colleagues**: `ctx.filterArray()` keeps the mails whose sender contains the colleague domain
4. **Get sent emails**: the same read on `SentItems`
5. **Find unreplied**: a text-mode `ctx.select()` gives the sent conversation ids as a plain array, and a second Filter array keeps the colleague mails whose `conversationId` is not in it (`contains()` on an array is a membership test)
6. **Send summary**: `ctx.createHtmlTable()` with explicit columns, then `SendEmailV2` with the designer's `emailMessage/...` parameter names

A thread counts as answered when a sent mail shares its `conversationId`.

## What It Shows

- Connector reads and writes with `ctx.connectors.office365`, each call naming its connection reference
- Data operations instead of loops: Filter array and Select over connector results, read with `ctx.body()`
- Flow parameters with defaults and descriptions, read with `ctx.parameters()` by their exact key
- A named condition (`HasUnrepliedEmails`) so the trace and the designer show what was decided

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| ColleagueDomain | String | @contoso.com | Text the sender address must contain |
| SummaryRecipient | String | me@contoso.com | Where to send the summary |
| DaysToCheck | Int | 7 | How many days to look back |

Override one for a local run with `--param DaysToCheck=30`.

## Running

See [examples/README.md](../README.md) for CLI install/setup.

```bash
# Run locally (requires --auth or --graph-token for Office 365); the summary mail is really sent
npx flowforger run examples/unreplied-emails/unreplied-colleagues.ff.ts --auth

# Stop before the mail is sent and see exactly what would go out
npx flowforger run examples/unreplied-emails/unreplied-colleagues.ff.ts --auth --stop-before SendSummaryEmail

# Compile to Logic Apps JSON for deployment
npx flowforger compile examples/unreplied-emails/unreplied-colleagues.ff.ts --emit logicapps --out clientdata.json --config flowforger.config.json
```

## Customization Ideas

- Change the trigger to `@HttpTrigger` or `@ManualTrigger` for on-demand runs
- Filter on `importance` or exclude senders in the first Filter array
- Post the table to a Teams channel instead of mailing it
