/**
 * Example: Invoice Reminders (a flow to test locally)
 *
 * One external read, some local data shaping, one external write, a response. The
 * README walks through running it with --stop-before, --mock, --mocks and --live, so
 * the write can be inspected without ever being sent.
 *
 * The external calls go to httpbin.org, which echoes what it receives: the "rate
 * service" is a GET whose query string comes back under args, and the "reminder
 * service" is a POST whose body comes back under json.
 */

@Flow('Invoice Reminders')
class InvoiceReminders {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    // The read: an exchange rate (httpbin echoes ?rate=1.08 as body.args.rate)
    await ctx.http('Get_exchange_rate', {
      method: 'GET',
      url: 'https://httpbin.org/get?base=EUR&quote=USD&rate=1.08',
    });

    await ctx.compose('Rate', ctx.float(ctx.body('Get_exchange_rate')?.['args']?.['rate']));

    // Local shaping: the overdue invoices, priced in USD
    await ctx.filterArray('Overdue_invoices', ctx.triggerBody()?.['invoices'], ctx.item()?.['status'] === 'overdue');

    await ctx.select('Reminders', ctx.body('Overdue_invoices'), {
      number: ctx.item()?.['number'],
      customer: ctx.item()?.['customer'],
      amountEur: ctx.item()?.['amount'],
      amountUsd: ctx.mul(ctx.item()?.['amount'], ctx.outputs('Rate')),
      daysOverdue: ctx.item()?.['daysOverdue'],
    });

    // The write: send the reminders (httpbin echoes the posted body as body.json)
    await ctx.http('Send_reminders', {
      method: 'POST',
      url: 'https://httpbin.org/post',
      headers: { 'Content-Type': 'application/json' },
      body: {
        reminders: ctx.body('Reminders'),
        sentAt: ctx.utcNow(),
      },
    });

    await ctx.response('Respond', 200, {
      overdue: ctx.length(ctx.body('Overdue_invoices')),
      rate: ctx.outputs('Rate'),
      sent: ctx.body('Send_reminders')?.['json']?.['reminders'],
    });
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
