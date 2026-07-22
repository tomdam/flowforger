# Unreplied Emails from Colleagues

This example demonstrates a Power Automate flow that identifies emails from colleagues that haven't been replied to and sends a daily summary.

## How It Works

1. **Recurrence Trigger**: Runs daily at 8 AM UTC
2. **Get Inbox Emails**: Fetches recent emails from the inbox
3. **Filter Colleagues**: Keeps only emails from your organization domain
4. **Get Sent Emails**: Fetches sent items to identify replied threads
5. **Find Unreplied**: Compares conversation IDs to find threads without replies
6. **Send Summary**: Creates an HTML table and emails the summary

## Strategy

The flow uses conversation IDs to detect replies:
- Each email thread has a unique `conversationId`
- If you've replied, your sent email shares the same `conversationId`
- Emails with `conversationId` not found in sent items are unreplied

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| ColleagueDomain | String | @contoso.com | Email domain to identify colleagues |
| SummaryRecipient | String | me@contoso.com | Where to send the summary |
| DaysToCheck | Int | 7 | How many days to look back |

## Connection References

Requires Office 365 Outlook connection:

```json
{
  "shared_office365": {
    "apiId": "/providers/Microsoft.PowerApps/apis/shared_office365",
    "connectionReferenceLogicalName": "cr_office365"
  }
}
```

## Usage

See [examples/README.md](../README.md) for CLI install/setup.

```bash
# Run locally (requires --auth or --graph-token for Office 365)
npx flowforger run examples/unreplied-emails/unreplied-colleagues.ff.ts --auth

# Compile to Logic Apps JSON for deployment
npx flowforger compile examples/unreplied-emails/unreplied-colleagues.ff.ts --out clientdata.json --config flowforger.config.json
```

## Customization Ideas

- Change trigger to HTTP for on-demand execution
- Add priority filtering (high importance emails only)
- Exclude certain senders or subjects
- Add Teams notification instead of email
- Include links to open emails directly in Outlook
