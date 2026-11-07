/**
 * Child flow: Calculate Shipping
 *
 * Answers a shipping cost for a known region. For an unknown region it answers a plain
 * HTTP response with status 400: the parent's call then fails with code BadRequest and
 * keeps this response as its outputs, so a catch scope can read the error. A child that
 * ended without any Response would instead fail the parent's call with 502 BadGateway.
 */

@Flow('Calculate Shipping')
class CalculateShipping {
  @ManualTrigger({
    schema: {
      type: 'object',
      properties: {
        region: { title: 'region', type: 'string', 'x-ms-dynamically-added': true, description: 'Please enter your input', 'x-ms-content-hint': 'TEXT' },
        lineCount: { title: 'lineCount', type: 'number', 'x-ms-dynamically-added': true, description: 'Please enter a number', 'x-ms-content-hint': 'NUMBER' },
      },
      required: ['region', 'lineCount'],
    },
  })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    /** @action Rate_by_region */
    switch (ctx.triggerBody()?.['region']) {
      /** @action Case_EU @type case */
      case 'EU':
        await ctx.compose('Rate_EU', 8.5);
      /** @action Case_US @type case */
      case 'US':
        await ctx.compose('Rate_US', 12);
      default:
        await ctx.compose('Rate_unknown', 'no rate for this region');
    }

    // The cases that did not run read as null, so coalesce gives the one rate that did
    await ctx.compose('Rate', ctx.coalesce(ctx.outputs('Rate_EU'), ctx.outputs('Rate_US')));

    /** @action Region_is_known */
    if (ctx.outputs('Rate') !== null) {
      await ctx.response('Respond_cost', 200, {
        cost: ctx.add(ctx.outputs('Rate'), ctx.mul(ctx.triggerBody()?.['lineCount'], 1.5)),
        region: ctx.triggerBody()?.['region'],
        carrier: 'Contoso Logistics',
      }, undefined, {
        type: 'object',
        properties: {
          cost: { title: 'cost', 'x-ms-dynamically-added': true, type: 'number' },
          region: { title: 'region', 'x-ms-dynamically-added': true, type: 'string' },
          carrier: { title: 'carrier', 'x-ms-dynamically-added': true, type: 'string' },
        },
      }, 'PowerApp');
    } else {
      await ctx.response('Respond_unknown_region', 400, {
        error: ctx.concat('No shipping rate for region ', ctx.triggerBody()?.['region']),
      });
    }
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
