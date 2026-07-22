/**
 * Example: Dataverse — Delete Row
 *
 * Deletes a single account record by GUID.
 */

@Flow('dv-delete-row')
class DvDeleteRow {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.dataverse.DeleteRecord('DeleteAccount', {
      entityName: 'accounts',
      recordId: '<GUID>',
    });
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
