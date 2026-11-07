/**
 * Example: Daily Notification Flow
 *
 * A Recurrence trigger that fires every day at 09:00 Eastern time, followed by a
 * counter variable, an array variable and two Compose actions. Everything after the
 * trigger is connector-free, so the flow runs locally without credentials (a local
 * run fires the trigger once instead of waiting for the schedule).
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
    /** @action Initialize_counter */
    let counter: number = 0;

    /** @action Initialize_messages */
    let messages: any[] = [];

    await ctx.compose('CreateMessage', {
      title: 'Daily Notification',
      timestamp: ctx.utcNow(),
      message: ctx.concat('This is your daily notification #', ctx.string(ctx.add(ctx.variables('counter'), 1))),
    });

    /** @action Increment_counter */
    counter += 1;

    /** @action Append_message */
    messages.push(ctx.outputs('CreateMessage'));

    await ctx.compose('LogNotification', ctx.concat('Sent notification at ', ctx.utcNow()));
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
