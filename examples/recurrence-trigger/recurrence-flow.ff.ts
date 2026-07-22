/**
 * Example: Daily Notification Flow
 *
 * Demonstrates a Recurrence trigger that fires daily at a specific time,
 * with variable initialization, compose, increment, and append-to-array actions.
 */

@Flow('daily-notification-flow')
class DailyNotificationFlow {
  @RecurrenceTrigger({
    frequency: 'Day',
    interval: 1,
    timeZone: 'Eastern Standard Time',
    schedule: { hours: [9], minutes: [0] },
  })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    /** @action InitCounter */
    let counter: number = 0;

    /** @action InitMessages */
    let messages: any[] = [];

    await ctx.compose('CreateMessage', {
      title: 'Daily Notification',
      timestamp: ctx.eval(`@utcNow()`),
      message: ctx.eval(`@concat("This is your daily notification #", string(add(variables("counter"), 1)))`),
    });

    /** @action IncrementCounter */
    counter += 1;

    /** @action AddToMessages */
    messages.push(ctx.eval(`@outputs("CreateMessage")`));

    await ctx.compose('LogNotification', ctx.eval(`@concat("Sent notification at ", string(utcNow()))`));
  }

  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
      contentVersion: '1.0.0.0',
      schemaVersion: '1.0.0.0',
    };
    ctx.flow.connectionReferences = {};
    ctx.flow.parameters = {
      $connections: { defaultValue: {}, type: 'Object' },
      $authentication: { defaultValue: {}, type: 'SecureObject' },
    };
  }
}
