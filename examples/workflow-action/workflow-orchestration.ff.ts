/**
 * Example: Invoice Processing Orchestrator
 *
 * Daily recurrence that chains three child workflows for end-to-end invoice
 * processing: resolve folder path, fill a Word template, and create the
 * invoice record. Demonstrates passing data between workflow calls.
 *
 * The child workflows here are referenced by placeholder GUIDs and are not
 * included locally — this example shows the orchestration pattern and is
 * meant for compiling, not local execution. For a locally runnable example
 * with bundled child flows, see parent-flow.ff.ts.
 */

@Flow('invoice-processing-orchestrator')
class InvoiceProcessingOrchestrator {
  @RecurrenceTrigger({
    frequency: 'Day',
    interval: 1,
    schedule: { hours: [8], minutes: [0] },
  })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.compose('PrepareRequest', {
      programId: 'PROG-2025-001',
      customerId: 'CUST-0042',
      referenceNumber: 'INV-2025-0001',
      requestDate: ctx.eval(`@utcNow()`),
    });

    await ctx.callWorkflow('GetFolderPath', '44444444-4444-4444-4444-444444444444', {
      programId: ctx.eval(`@outputs('PrepareRequest')['programId']`),
    });

    await ctx.callWorkflow('FillWordTemplate', '55555555-5555-5555-5555-555555555555', {
      customerId: ctx.eval(`@outputs('PrepareRequest')['customerId']`),
      referenceNumber: ctx.eval(`@outputs('PrepareRequest')['referenceNumber']`),
      folderPath: ctx.eval(`@body('GetFolderPath')?['folderPath']`),
    });

    await ctx.callWorkflow('CreateInvoiceRecord', '66666666-6666-6666-6666-666666666666', {
      docxFileName: ctx.eval(`@concat(outputs('PrepareRequest')['referenceNumber'], '.docx')`),
      xmlFileName: ctx.eval(`@concat(outputs('PrepareRequest')['referenceNumber'], '.xml')`),
      folderPath: ctx.eval(`@body('GetFolderPath')?['folderPath']`),
    });

    await ctx.compose('LogCompletion', {
      message: 'Invoice processing completed',
      invoiceId: ctx.eval(`@body('CreateInvoiceRecord')?['invoiceId']`),
      completedAt: ctx.eval(`@utcNow()`),
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
