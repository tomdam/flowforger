/**
 * Child flow: Build Reference Number
 *
 * A reusable utility any parent can call: takes a prefix and a customer id and answers
 * with a reference such as ORD-20261107-ACME-4F2A.
 *
 * In Power Automate a child flow is a flow with the "Manually trigger a flow" trigger
 * and a "Respond to a PowerApp or flow" action. The trigger schema declares the inputs
 * the parent passes in the call's body; the response schema declares the outputs the
 * parent reads with ctx.body('<call>'). Every schema property carries
 * "x-ms-dynamically-added": true, or the designer hides it.
 */

@Flow('Build Reference Number')
class BuildReferenceNumber {
  @ManualTrigger({
    schema: {
      type: 'object',
      properties: {
        prefix: { title: 'prefix', type: 'string', 'x-ms-dynamically-added': true, description: 'Please enter your input', 'x-ms-content-hint': 'TEXT' },
        customer: { title: 'customer', type: 'string', 'x-ms-dynamically-added': true, description: 'Please enter your input', 'x-ms-content-hint': 'TEXT' },
      },
      required: ['prefix', 'customer'],
    },
  })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.compose('Date_part', ctx.formatDateTime(ctx.utcNow(), 'yyyyMMdd'));

    await ctx.compose('Random_part', ctx.toUpper(ctx.substring(ctx.guid(), 0, 4)));

    // The first Response is what the parent receives; a status below 400 succeeds the call
    await ctx.response('Respond_to_parent', 200, {
      reference: ctx.concat(
        ctx.triggerBody()?.['prefix'], '-',
        ctx.outputs('Date_part'), '-',
        ctx.toUpper(ctx.triggerBody()?.['customer']), '-',
        ctx.outputs('Random_part')),
      issuedAt: ctx.utcNow(),
    }, undefined, {
      type: 'object',
      properties: {
        reference: { title: 'reference', 'x-ms-dynamically-added': true, type: 'string' },
        issuedAt: { title: 'issuedAt', 'x-ms-dynamically-added': true, type: 'string' },
      },
    }, 'PowerApp');
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
