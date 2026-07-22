/**
 * Example: Complex Control Flow
 *
 * Demonstrates deeply nested control structures: foreach inside if inside foreach,
 * switch statements, scopes with try/catch/finally, and do-until loops.
 * Simulates an order processing pipeline with validation, categorization, and retry logic.
 */

@Flow('ComplexControlFlow')
class ComplexControlFlow {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    /** @action Initialize_processedOrders */
    let processedOrders: any[] = [];

    /** @action Initialize_failedOrders */
    let failedOrders: any[] = [];

    /** @action Initialize_retryCount */
    let retryCount: number = 0;

    // Get order batches from trigger
    await ctx.compose('OrderBatches', ctx.triggerBody()?.['batches']);

    // ===== Outer loop: iterate over batches =====
    /** @action ProcessBatches @type foreach */
    for (const batch of ctx.outputs('OrderBatches') ?? []) {
      await ctx.compose('BatchInfo', {
        batchId: batch?.['batchId'],
        region: batch?.['region']
      });

      // ===== Switch on region to apply different rules =====
      /** @action RouteByRegion @type switch */
      switch (batch?.['region']) {
        /** @action CaseUS @type case */
        case 'US':
          await ctx.compose('TaxRate_US', 0.08);
          break;
        /** @action CaseEU @type case */
        case 'EU':
          await ctx.compose('TaxRate_EU', 0.20);
          break;
        /** @action CaseDefault @type case */
        default:
          await ctx.compose('TaxRate_Other', 0.10);
      }

      // ===== Inner loop: process each order in the batch =====
      /** @action ProcessOrders @type foreach */
      for (const order of batch?.['orders'] ?? []) {
        // Try/catch scope around order processing
        /** @action TryProcessOrder @type scope */
        {
          // Validate order has required fields
          /** @action ValidateOrder @type if */
          if (ctx.not(ctx.empty(order?.['productId'])) && ctx.greater(order?.['quantity'], 0)) {
            // Calculate order total
            await ctx.compose('OrderTotal', {
              productId: order?.['productId'],
              quantity: order?.['quantity'],
              unitPrice: order?.['unitPrice'],
              subtotal: ctx.mul(order?.['quantity'], order?.['unitPrice'])
            });

            // Check if order exceeds threshold for approval
            /** @action CheckThreshold @type if */
            if (ctx.greater(ctx.mul(order?.['quantity'], order?.['unitPrice']), 1000)) {
              await ctx.compose('NeedsApproval', true);

              // Nested loop: check each line item for restricted products
              /** @action CheckLineItems @type foreach */
              for (const lineItem of order?.['lineItems'] ?? []) {
                /** @action IsRestricted @type if */
                if (lineItem?.['restricted'] === true) {
                  await ctx.compose('RestrictedFlag', {
                    productId: lineItem?.['productId'],
                    reason: lineItem?.['reason']
                  });
                }
              }
            } else {
              await ctx.compose('AutoApproved', true);
            }

            // Append to processed
            /** @action AppendProcessed */
            processedOrders = ctx.eval(`@union(variables('processedOrders'), createArray(outputs('OrderTotal')))`);
          } else {
            // Invalid order
            await ctx.compose('InvalidOrder', {
              orderId: order?.['orderId'],
              reason: 'Missing productId or invalid quantity'
            });

            /** @action AppendFailed */
            failedOrders = ctx.eval(`@union(variables('failedOrders'), createArray(outputs('InvalidOrder')))`);
          }
        }

        /** @action CatchOrderError @type scope @runAfter TryProcessOrder: Failed */
        {
          await ctx.compose('OrderError', {
            orderId: order?.['orderId'],
            error: 'Unexpected error during processing'
          });

          /** @action AppendErrorOrder */
          failedOrders = ctx.eval(`@union(variables('failedOrders'), createArray(outputs('OrderError')))`);
        }

        /** @action FinallyOrder @type scope @runAfter TryProcessOrder: Succeeded, Failed, Skipped */
        {
          await ctx.compose('OrderProcessed', true);
        }
      }
    }

    // ===== Do-Until: retry loop runs up to 3 times =====
    /** @action RetryFailedOrders @type until */
    do {
      /** @action IncrementRetry */
      retryCount = retryCount + 1;

      // Re-check failed orders count
      await ctx.compose('FailedCount', ctx.length(ctx.variables('failedOrders')));

      /** @action CheckRetryNeeded @type if */
      if (ctx.equals(ctx.outputs('FailedCount'), 0)) {
        await ctx.compose('AllCleared', 'No more failed orders');
      } else {
        await ctx.compose('StillFailing', {
          remaining: ctx.outputs('FailedCount'),
          attempt: ctx.variables('retryCount')
        });
      }
    } while (ctx.less(ctx.variables('retryCount'), 3));

    // Build final report
    await ctx.compose('FinalReport', {
      processedCount: ctx.length(ctx.variables('processedOrders')),
      failedCount: ctx.length(ctx.variables('failedOrders')),
      retryAttempts: ctx.variables('retryCount'),
      processed: ctx.variables('processedOrders'),
      failed: ctx.variables('failedOrders')
    });

    await ctx.response('Response', 200, ctx.outputs('FinalReport'));
  }

  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
      contentVersion: "1.0.0.0",
      schemaVersion: "1.0.0.0",
    };
    ctx.flow.connectionReferences = {};
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}
