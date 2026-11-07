/**
 * Child flow: Validate Order Line
 *
 * Called once per order line by the parent. Checks the sku, quantity and unit price and
 * answers with ok, the priced line and a reason when it was rejected. Both responses
 * share one schema: the cloud refuses to save two Response actions with the same status
 * code and different schemas.
 */

@Flow('Validate Order Line')
class ValidateOrderLine {
  @ManualTrigger({
    schema: {
      type: 'object',
      properties: {
        sku: { title: 'sku', type: 'string', 'x-ms-dynamically-added': true, description: 'Please enter your input', 'x-ms-content-hint': 'TEXT' },
        quantity: { title: 'quantity', type: 'number', 'x-ms-dynamically-added': true, description: 'Please enter a number', 'x-ms-content-hint': 'NUMBER' },
        unitPrice: { title: 'unitPrice', type: 'number', 'x-ms-dynamically-added': true, description: 'Please enter a number', 'x-ms-content-hint': 'NUMBER' },
      },
      required: ['sku', 'quantity', 'unitPrice'],
    },
  })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    /** @action Initialize_reason */
    let reason: string = '';

    /** @action Check_sku */
    if (ctx.empty(ctx.triggerBody()?.['sku'])) {
      /** @action Set_reason_sku */
      reason = 'sku is required';
    }

    /** @action Check_quantity */
    if (ctx.lessOrEquals(ctx.triggerBody()?.['quantity'], 0)) {
      /** @action Set_reason_quantity */
      reason = 'quantity must be greater than 0';
    }

    /** @action Check_unit_price */
    if (ctx.less(ctx.triggerBody()?.['unitPrice'], 0)) {
      /** @action Set_reason_unit_price */
      reason = 'unitPrice must not be negative';
    }

    /** @action Line_is_valid */
    if (ctx.empty(ctx.variables('reason'))) {
      await ctx.response('Respond_accepted', 200, {
        ok: true,
        sku: ctx.triggerBody()?.['sku'],
        quantity: ctx.triggerBody()?.['quantity'],
        lineTotal: ctx.mul(ctx.triggerBody()?.['quantity'], ctx.triggerBody()?.['unitPrice']),
        reason: '',
      }, undefined, {
        type: 'object',
        properties: {
          ok: { title: 'ok', 'x-ms-dynamically-added': true, type: 'boolean' },
          sku: { title: 'sku', 'x-ms-dynamically-added': true, type: 'string' },
          quantity: { title: 'quantity', 'x-ms-dynamically-added': true, type: 'number' },
          lineTotal: { title: 'lineTotal', 'x-ms-dynamically-added': true, type: 'number' },
          reason: { title: 'reason', 'x-ms-dynamically-added': true, type: 'string' },
        },
      }, 'PowerApp');
    } else {
      await ctx.response('Respond_rejected', 200, {
        ok: false,
        sku: ctx.triggerBody()?.['sku'],
        quantity: ctx.triggerBody()?.['quantity'],
        lineTotal: 0,
        reason: ctx.variables('reason'),
      }, undefined, {
        type: 'object',
        properties: {
          ok: { title: 'ok', 'x-ms-dynamically-added': true, type: 'boolean' },
          sku: { title: 'sku', 'x-ms-dynamically-added': true, type: 'string' },
          quantity: { title: 'quantity', 'x-ms-dynamically-added': true, type: 'number' },
          lineTotal: { title: 'lineTotal', 'x-ms-dynamically-added': true, type: 'number' },
          reason: { title: 'reason', 'x-ms-dynamically-added': true, type: 'string' },
        },
      }, 'PowerApp');
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
