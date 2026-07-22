/**
 * Example: Dataverse — List Rows
 *
 * Lists 5 accounts, selecting only name and account number.
 */

@Flow('dv-list-rows')
class DvListRows {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.dataverse.ListRows('ListAccounts', {
      entityName: 'accounts',
      '$select': 'name,accountnumber',
      '$top': 5,
    });
    await ctx.compose('Output', ctx.body('ListAccounts'));
  }

  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
      contentVersion: '1.0.0.0',
      schemaVersion: '1.0.0.0',
    };
    ctx.flow.connectionReferences = {
      shared_commondataserviceforapps: { runtimeUrl: '' },
    };
    ctx.flow.parameters = {
      $connections: { defaultValue: {}, type: 'Object' },
      $authentication: { defaultValue: {}, type: 'SecureObject' },
    };
  }
}
