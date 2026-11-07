/**
 * Example: Unreplied Emails from Colleagues
 *
 * Runs every morning, lists the inbox and the sent folder, and mails a summary of
 * the colleague threads nobody has answered yet. A thread counts as answered when a
 * sent mail shares its conversationId.
 */

@Flow('UnrepliedColleagueEmails')
class UnrepliedColleagueEmails {
  @RecurrenceTrigger({
    frequency: 'Day',
    interval: 1,
    timeZone: 'UTC',
    schedule: { hours: [8], minutes: [0] },
  })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.compose('LookbackDate', ctx.getPastTime(ctx.parameters('DaysToCheck'), 'Day'));

    // Inbox mails received since the lookback date (OData filter on receivedDateTime)
    await ctx.connectors.office365.GetEmailsV2('GetInboxEmails', {
      folderPath: 'Inbox',
      fetchOnlyUnread: false,
      top: 100,
      includeAttachments: false,
      filter: ctx.concat('receivedDateTime ge ', ctx.outputs('LookbackDate')),
    }, 'shared_office365');

    // Keep the mails whose sender address contains the colleague domain
    await ctx.filterArray('ColleagueEmails', ctx.body('GetInboxEmails')?.['value'],
      ctx.contains(ctx.item()?.['from'], ctx.parameters('ColleagueDomain')));

    // Sent mails: a thread with a sent mail has been answered
    await ctx.connectors.office365.GetEmailsV2('GetSentEmails', {
      folderPath: 'SentItems',
      fetchOnlyUnread: false,
      top: 200,
      includeAttachments: false,
      filter: ctx.concat('receivedDateTime ge ', ctx.outputs('LookbackDate')),
    }, 'shared_office365');

    // A text-mode Select with one expression gives a plain array of conversation ids
    await ctx.select('RepliedConversationIds', ctx.body('GetSentEmails')?.['value'], ctx.item()?.['conversationId']);

    // contains() on an array checks membership, so no string tricks are needed
    await ctx.filterArray('UnrepliedEmails', ctx.body('ColleagueEmails'),
      ctx.not(ctx.contains(ctx.body('RepliedConversationIds'), ctx.item()?.['conversationId'])));

    /** @action HasUnrepliedEmails */
    if (ctx.greater(ctx.length(ctx.body('UnrepliedEmails')), 0)) {
      await ctx.createHtmlTable('EmailTable', ctx.body('UnrepliedEmails'), [
        { header: 'From', value: ctx.item()?.['from'] },
        { header: 'Subject', value: ctx.item()?.['subject'] },
        { header: 'Received', value: ctx.item()?.['receivedDateTime'] },
      ]);

      await ctx.connectors.office365.SendEmailV2('SendSummaryEmail', {
        'emailMessage/To': ctx.parameters('SummaryRecipient'),
        'emailMessage/Subject': ctx.concat('Unreplied emails: ', ctx.string(ctx.length(ctx.body('UnrepliedEmails'))), ' need attention'),
        'emailMessage/Body': ctx.concat(
          '<h2>Unreplied emails from colleagues</h2><p>',
          ctx.string(ctx.length(ctx.body('UnrepliedEmails'))), ' unreplied email(s) in the past ',
          ctx.string(ctx.parameters('DaysToCheck')), ' days.</p>',
          ctx.body('EmailTable')),
        'emailMessage/Importance': 'Normal',
        'emailMessage/IsHtml': true,
      }, 'shared_office365');

      await ctx.compose('Result', {
        status: 'sent',
        unrepliedCount: ctx.length(ctx.body('UnrepliedEmails')),
      });
    } else {
      await ctx.compose('NothingToReport', {
        status: 'no_unreplied_emails',
        unrepliedCount: 0,
      });
    }
  }

  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
      contentVersion: '1.0.0.0',
      schemaVersion: '1.0.0.0',
    };
    ctx.flow.connectionReferences = {
      shared_office365: {
        apiId: '/providers/Microsoft.PowerApps/apis/shared_office365',
        connectionReferenceLogicalName: 'cr_office365',
      },
    };
    ctx.flow.parameters = {
      $connections: { defaultValue: {}, type: 'Object' },
      $authentication: { defaultValue: {}, type: 'SecureObject' },
      ColleagueDomain: {
        type: 'String',
        defaultValue: '@contoso.com',
        metadata: { description: 'Text the sender address must contain to count as a colleague, e.g. @contoso.com' },
      },
      SummaryRecipient: {
        type: 'String',
        defaultValue: 'me@contoso.com',
        metadata: { description: 'Email address to receive the summary' },
      },
      DaysToCheck: {
        type: 'Int',
        defaultValue: 7,
        metadata: { description: 'Number of days to look back for emails' },
      },
    };
  }
}
