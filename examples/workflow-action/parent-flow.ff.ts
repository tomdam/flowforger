/**
 * Example: Parent Orchestrator
 *
 * HTTP-triggered orchestrator that calls two child workflows sequentially,
 * passing data between them, and returns a combined result.
 *
 * Child workflows are resolved via flowforger.workflows.json (GUID -> IR file).
 */

@Flow('ParentOrchestrator')
class ParentOrchestrator {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.compose('InitializeData', {
      programId: 'PROG-2025-001',
      userId: 'user@example.com',
    });

    await ctx.callWorkflow('Call_GetAbsoluteUrl', '11111111-1111-1111-1111-111111111111', {
      text: ctx.eval(`@outputs('InitializeData')['programId']`),
    });

    await ctx.callWorkflow('Call_ProcessDocument', '22222222-2222-2222-2222-222222222222', {
      text: ctx.eval(`@body('Call_GetAbsoluteUrl')?['absoluteurl']`),
      text_2: ctx.eval(`@outputs('InitializeData')['userId']`),
    });

    await ctx.compose('Response', {
      urlResult: ctx.eval(`@body('Call_GetAbsoluteUrl')`),
      processResult: ctx.eval(`@body('Call_ProcessDocument')`),
      status: 'completed',
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
