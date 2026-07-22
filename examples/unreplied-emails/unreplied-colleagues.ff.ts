/**
 * Example: Unreplied Emails from Colleagues
 *
 * This flow finds emails received from colleagues that haven't been replied to
 * and sends a summary email listing them.
 *
 * Strategy: Get inbox emails, get sent emails, compare to find unreplied threads.
 */

@Flow('UnrepliedColleagueEmails')
class UnrepliedColleagueEmails {
  constructor(ctx: FlowContext) {
    // Define connection references for Office 365 Outlook
    ctx.flow.connectionReferences = {
      shared_office365: {
        apiId: '/providers/Microsoft.PowerApps/apis/shared_office365',
        connectionReferenceLogicalName: 'cr_office365',
      },
    };

    // Define flow parameters
    ctx.flow.parameters = {
      ColleagueDomain: {
        type: 'String',
        defaultValue: '@contoso.com',
        metadata: {
          description: 'Email domain to identify colleagues (e.g., @contoso.com)',
        },
      },
      SummaryRecipient: {
        type: 'String',
        defaultValue: 'me@contoso.com',
        metadata: {
          description: 'Email address to receive the summary',
        },
      },
      DaysToCheck: {
        type: 'Int',
        defaultValue: 7,
        metadata: {
          description: 'Number of days to look back for emails',
        },
      },
    };
  }

  @RecurrenceTrigger({
    frequency: 'Day',
    interval: 1,
    startTime: '2024-01-01T08:00:00Z',
    timeZone: 'UTC',
  })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    // Calculate the date range for filtering
    let lookbackDate = ctx.getPastTime(ctx.parameters('DaysToCheck'), 'Day'); 

    await ctx.compose('LookbackDate', lookbackDate);

    // Get emails from inbox received in the past N days from colleagues
    // Filter by sender domain to get only colleague emails
    await ctx.connectors.office365.GetEmailsV2('GetInboxEmails', {
      folderPath: 'Inbox',
      fetchOnlyUnread: false,
      top: 100,
      includeAttachments: false,
    });

    // Filter to only emails from colleagues (matching domain)
    await ctx.filterArray(
      'ColleagueEmails',
      ctx.body('GetInboxEmails').value,
      `@contains(item()?['from'], parameters('ColleagueDomain'))`
    );

    // Get sent emails to check which conversations have replies
    await ctx.connectors.office365.GetEmailsV2('GetSentEmails', {
      folderPath: 'SentItems',
      fetchOnlyUnread: false,
      top: 200,
      includeAttachments: false,
    });

    // Extract conversation IDs from sent emails (these are replied threads)
    await ctx.select('RepliedConversationIds', ctx.body('GetSentEmails').value, {
      conversationId: '@item()?[\'conversationId\']',
    });

    // Join the replied conversation IDs into a searchable string
    await ctx.compose(
      'RepliedConversationsString',
      ctx.eval(`concat(',', join(body('RepliedConversationIds')?['conversationId'], ','), ',')`)
    );

    // Filter colleague emails to find unreplied ones
    // An email is unreplied if its conversationId is NOT in the sent emails
    await ctx.filterArray(
      'UnrepliedEmails',
      ctx.body('ColleagueEmails'),
      `@not(contains(outputs('RepliedConversationsString'), concat(',', item()?['conversationId'], ',')))`
    );

    // Check if there are any unreplied emails
    if (ctx.eval(`@greater(length(body('UnrepliedEmails')), 0)`)) {
      // Build an HTML table of unreplied emails
      await ctx.createHtmlTable('EmailTable', ctx.body('UnrepliedEmails'), [
        { header: 'From', value: '@item()?[\'from\']' },
        { header: 'Subject', value: '@item()?[\'subject\']' },
        { header: 'Received', value: '@item()?[\'receivedDateTime\']' },
        { header: 'Preview', value: '@item()?[\'bodyPreview\']' },
      ]);

      // Compose the email body with summary
      await ctx.compose('EmailBody', {
        html: ctx.eval(
          `concat('<h2>Unreplied Emails from Colleagues</h2>',
                  '<p>You have ', string(length(body('UnrepliedEmails'))), ' unreplied email(s) from colleagues in the past ', string(parameters('DaysToCheck')), ' days.</p>',
                  body('EmailTable'))`
        ),
      });

      // Send the summary email
      await ctx.connectors.office365.SendEmailV2('SendSummaryEmail', {
        To: ctx.parameters('SummaryRecipient'),
        Subject: ctx.eval(
          `concat('Unreplied Emails Summary - ', string(length(body('UnrepliedEmails'))), ' emails need attention')`
        ),
        Body: ctx.body('EmailBody').html,
        Importance: 'Normal',
        IsHtml: true,
      });

      await ctx.compose('Result', {
        status: 'sent',
        unrepliedCount: ctx.eval(`length(body('UnrepliedEmails'))`),
      });
    } else {
      // No unreplied emails - optionally notify or just complete
      await ctx.compose('Result2', {
        status: 'no_unreplied_emails',
        unrepliedCount: 0,
      });
    }
  }
}
