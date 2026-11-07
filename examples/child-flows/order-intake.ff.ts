/**
 * Example: Order Intake (parent flow)
 *
 * An HTTP-triggered parent that delegates to three child flows written in the DSL
 * next to it (see children/):
 *   - Build Reference Number: a pure utility, called once
 *   - Validate Order Line: called once per order line, inside a loop
 *   - Calculate Shipping: answers 400 for an unknown region, so the parent catches it
 *
 * The children are listed in ctx.flow.childFlows with a workflowId (what the deployed
 * flow calls) and a dslPath (what a local run compiles), so the whole graph runs with
 * one command and no credentials:
 *
 *   flowforger run examples/child-flows/order-intake.ff.ts --in examples/child-flows/payloads/order.json
 */

@Flow('Order Intake')
class OrderIntake {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    /** @action Initialize_lineResults */
    let lineResults: any[] = [];

    /** @action Initialize_rejectedLines */
    let rejectedLines: any[] = [];

    /** @action Initialize_subtotal */
    let subtotal: number = 0;

    // A child flow call: the second argument is the name from childFlows below, the third
    // the body the child's trigger receives. retryPolicy none on every call: under the
    // default policy the cloud retries a child that fails without responding for minutes.
    /** @retryPolicy {"type":"none"} */
    await ctx.callWorkflow('Build_reference', 'Build Reference Number', {
      prefix: 'ORD',
      customer: ctx.triggerBody()?.['customer']?.['id'],
    });

    // One call per line. The loop is sequential because its body changes variables.
    /** @action For_each_line @runtimeConfig {"concurrency":{"repetitions":1}} */
    for (const line of ctx.triggerBody()?.['lines'] ?? []) {
      /** @retryPolicy {"type":"none"} */
      await ctx.callWorkflow('Validate_line', 'Validate Order Line', {
        sku: line?.['sku'],
        quantity: line?.['quantity'],
        unitPrice: line?.['unitPrice'],
      });

      // The child's response body is read with ctx.body(), like an HTTP or connector result
      /** @action Line_is_valid */
      if (ctx.body('Validate_line')?.['ok'] === true) {
        /** @action Append_accepted_line */
        lineResults.push(ctx.body('Validate_line'));

        /** @action Add_line_total */
        subtotal += ctx.body('Validate_line')?.['lineTotal'];
      } else {
        /** @action Append_rejected_line */
        rejectedLines.push(ctx.body('Validate_line'));
      }
    }

    // Try: a child that answers a status >= 400 fails the call with that status name as
    // its code (BadRequest here), and the call's outputs keep the child's response.
    /** @action Try_shipping @type scope */
    {
      /** @retryPolicy {"type":"none"} */
      await ctx.callWorkflow('Calculate_shipping', 'Calculate Shipping', {
        region: ctx.triggerBody()?.['customer']?.['region'],
        lineCount: ctx.length(ctx.variables('lineResults')),
      });

      await ctx.compose('Shipping_cost', ctx.body('Calculate_shipping')?.['cost']);
    }

    // Catch: runs only when the try scope failed
    /** @action Catch_shipping @type scope @runAfter Try_shipping: Failed */
    {
      // result() lists the try scope's actions with status, code and outputs
      await ctx.filterArray('Failed_shipping_actions', ctx.result('Try_shipping'), ctx.item()?.['status'] === 'Failed');

      await ctx.compose('Shipping_error', {
        failedAction: ctx.eval(`@first(body('Failed_shipping_actions'))?['name']`),
        code: ctx.eval(`@first(body('Failed_shipping_actions'))?['code']`),
        statusCode: ctx.eval(`@outputs('Calculate_shipping')?['statusCode']`),
        reason: ctx.body('Calculate_shipping')?.['error'],
      });

      await ctx.compose('Fallback_shipping_cost', 25);
    }

    // Finally: depends on the catch scope with every status, so it runs on both paths
    // and both the try's and the catch's outputs are on its runAfter path.
    /** @action Finally_shipping @type scope @runAfter Catch_shipping: Succeeded, Failed, Skipped */
    {
      // A Skipped action reads as null, so coalesce picks whichever branch ran
      await ctx.compose('Effective_shipping_cost', ctx.coalesce(ctx.outputs('Shipping_cost'), ctx.outputs('Fallback_shipping_cost')));
    }

    await ctx.response('Order_accepted', 200, {
      reference: ctx.body('Build_reference')?.['reference'],
      acceptedLines: ctx.variables('lineResults'),
      rejectedLines: ctx.variables('rejectedLines'),
      subtotal: ctx.variables('subtotal'),
      shipping: ctx.outputs('Effective_shipping_cost'),
      shippingNote: ctx.coalesce(ctx.outputs('Shipping_error')?.['reason'], 'calculated'),
      total: ctx.add(ctx.variables('subtotal'), ctx.outputs('Effective_shipping_cost')),
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
    // The children by name. workflowId is what the deployed parent calls: `flowforger push`
    // prints the id of a child it created and writes it into the child's @Flow decorator;
    // copy it here. dslPath, relative to this file, is what a local run compiles instead.
    ctx.flow.childFlows = {
      'Build Reference Number': {
        workflowId: '00000000-0000-0000-0000-000000000001',
        dslPath: 'children/build-reference.ff.ts',
        description: 'Builds a reference such as ORD-20261107-ACME-4F2A',
        parameters: {
          prefix: { title: 'prefix', type: 'string', required: true },
          customer: { title: 'customer', type: 'string', required: true },
        },
      },
      'Validate Order Line': {
        workflowId: '00000000-0000-0000-0000-000000000002',
        dslPath: 'children/validate-order-line.ff.ts',
        description: 'Checks one order line and prices it',
        parameters: {
          sku: { title: 'sku', type: 'string', required: true },
          quantity: { title: 'quantity', type: 'number', required: true },
          unitPrice: { title: 'unitPrice', type: 'number', required: true },
        },
      },
      'Calculate Shipping': {
        workflowId: '00000000-0000-0000-0000-000000000003',
        dslPath: 'children/calculate-shipping.ff.ts',
        description: 'Shipping cost by region; 400 for an unknown region',
        parameters: {
          region: { title: 'region', type: 'string', required: true },
          lineCount: { title: 'lineCount', type: 'number', required: true },
        },
      },
    };
  }
}
